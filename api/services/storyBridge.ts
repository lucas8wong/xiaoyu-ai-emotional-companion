/**
 * 剧情 → 聊一聊 · 记忆桥（把剧情角色物化成一个聊一聊角色，并把剧情经历灌进它的记忆维度）
 *
 * 设计稿：`剧情角色接入聊一聊-方案.md`（用户拍板 Q1=C 双态 / Q2=C 摘要+增量+原文召回 / Q4=A 不套陪伴方式）
 *
 * 本文件做四件事：
 *  1) **物化**：把「一个剧本 + 用户在里面的剧情会话」变成一条 `ChatCharacter`（origin='story'），
 *     幂等键 = `(userId, scenarioId)`，重复导入只更新，绝不产生第二个「沈重」。
 *  2) **摘要**：一次性提炼 `StoryDigest`（共同经历 / 未完成的线 / 口吻特征）→ 写进 longMemory（≤80 字/条、带日期）
 *     + growth.relationship（关系底色）。
 *  3) **细节**：把会话按每 12 条抽成 `StoryBlock`（≤400 字，保关键台词）写进 storyArchive，
 *     由 `memoryRecall` 按话题**按需召回**，原文**绝不**进聊一聊的常规上下文。
 *  4) **增量**：按 `story.syncedMsgCount` 游标只提炼新增段落。
 *
 * 红线（与本文件每个决定有关，改动前先读）：
 *  - 剧情原文不进聊一聊的 system prompt：剧情要"沉浸叙事、不描写对方、长篇"，聊一聊要"像朋友发消息、短句"，
 *    两套规则同进一个 system 会互相打架，成本也会暴涨。块只在话题碰得到时被召回的 top-2。
 *  - 所有剧情记忆**必须带时间 + 「（剧内）」标记**，否则会被当成现实里真的发生过（2026-09-19 记忆时间轴同类问题）。
 *  - 安全过滤不绕：事实入库走 longMemory.addFacts（内含 checkContentSafety + 指令特征过滤）；
 *    人设文本由路由再过一次 checkCustomScenario（红线 5）。
 */

import { roleplaySessionStore, type RoleplayMessage } from './roleplaySessions.js';
import { getScenario, scenarioAvatar, type RoleplayScenario } from './roleplay.js';
import { customRoleplayStore } from './customRoleplay.js';
import { chatCharacterStore, type ChatCharacter, type StoryBinding, type StoryDigest, type StoryMode } from './chatCharacter.js';
import { longMemoryStore, type MemoryInput } from './longMemory.js';
import { chatCharacterGrowthStore } from './chatCharacterGrowth.js';
import { storyArchiveStore } from './storyArchive.js';
import { createDeepSeekClient } from './deepseek.js';
import memoryStorage from '../storage/memory.js';
import { randomUUID } from 'node:crypto';
import { quotaStore } from './quota.js';
import { preferenceStore } from './preferences.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
/** 每多少条消息抽一个「场面」块（12 ≈ 3~5 个来回，够成一幕） */
const BLOCK_SIZE = 12;
/** 块内单行截断（块总长上限在 storyArchive 里再兜一层） */
const LINE_USER = 140;
const LINE_AI = 200;
/** 摘要事实单条上限（longMemory.addFacts 硬性 ≤80，含「（剧内）」前缀的余量） */
const FACT_MAX = 78;
const FACT_PREFIX = '（剧内）';
/** 一次增量同步至少要有的新消息数：太短不值得一次 AI 调用，留着下次一起提炼 */
const MIN_SYNC_MSGS = 4;
/** 人设字段上限（与 chatCharacter.MAX_PERSONA_FIELD 对齐） */
const PERSONA_MAX = 4000;

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
export class StoryBridgeError extends Error {
  code: 'NO_STORY' | 'SCENARIO_NOT_FOUND' | 'NOT_STORY_CHARACTER';
  constructor(code: StoryBridgeError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'StoryBridgeError';
  }
}

export interface ScenarioBrief {
  kind: 'official' | 'custom';
  scenarioId: string;
  title: string;
  aiName: string;
  aiGender: string;
  aiAge: string;
  aiLooks: string;
  aiPersonality: string;
  /** 语言习惯（官方剧本有；自建剧本没有，用空的） */
  aiSpeech: string;
  background: string;
  openingScene: string;
  avatar: string;
  /** 剧内"你"的默认名字（官方剧本有 user.name；自建剧本没有 → 空） */
  defaultUserName: string;
}

export interface ImportStoryOptions {
  userId: string;
  scenarioId: string;
  /** 前端传：剧情里用户给角色改过的名字（localStorage `cure_rp_names_<id>`） */
  aiName?: string;
  userName?: string;
  storyMode?: StoryMode;
}

export interface ImportStoryResult {
  character: ChatCharacter;
  created: boolean;
  msgCount: number;
  blockCount: number;
  /** 摘要是否由模型提炼（false = 降级为规则抽取，用户仍能拿到结构化记忆） */
  digestByModel: boolean;
}

// ---------------------------------------------------------------------------
// 纯函数：场景解析 / 块切分 / 事实构造（可单测，无 I/O）
// ---------------------------------------------------------------------------

/** 官方剧本 → 场景摘要（lang 只影响标题/人设取哪一版） */
export function briefFromOfficial(s: RoleplayScenario, lang: 'zh' | 'en' = 'zh'): ScenarioBrief {
  const L = lang === 'en' ? s.en : s.zh;
  return {
    kind: 'official',
    scenarioId: s.id,
    title: L.title,
    aiName: L.ai.name,
    aiGender: L.ai.gender,
    aiAge: L.ai.age,
    aiLooks: L.ai.looks,
    aiPersonality: L.ai.personality,
    aiSpeech: L.ai.speech,
    background: L.background,
    openingScene: L.openingScene,
    avatar: s.avatar || scenarioAvatar(s.id),
    defaultUserName: L.user?.name || '',
  };
}

/** 自建剧本 → 场景摘要（没有 user 角色设定，也没有单独的语言习惯字段） */
export function briefFromCustom(c: { id: string; title: string; aiName: string; aiPersona: string; background: string; opening: string; avatar?: string }): ScenarioBrief {
  return {
    kind: 'custom',
    scenarioId: c.id,
    title: c.title || c.aiName || '自定义剧情',
    aiName: c.aiName || 'TA',
    aiGender: '',
    aiAge: '',
    aiLooks: '',
    // 自建剧本把外貌/性格/语言习惯揉在一段 aiPersona 里 → 整段进 identity，口吻另从剧情提炼
    aiPersonality: c.aiPersona || '',
    aiSpeech: '',
    background: c.background || '',
    openingScene: c.opening || '',
    avatar: c.avatar || '',
    defaultUserName: '',
  };
}

/** 单行压平 + 截断（块里的一行） */
function oneLine(text: string, max: number): string {
  const t = String(text || '').replace(/\s*\n+\s*/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + '…';
}

/** 从一段里挑"最长的一句/段"（台词往往最长，最能代表这一幕） */
function longestOf(list: string[], max: number): string {
  if (!list.length) return '';
  const best = list.reduce((a, b) => (b.length > a.length ? b : a), '');
  return oneLine(best, max);
}

/**
 * 把剧情消息抽成「场面块」（**纯规则抽取，不调模型**）。
 *
 * 为什么块是抽取而不是让模型重写：块的作用是**细节/台词召回**（「你上次说那把伞」），
 * 原句比模型转述更准更省；模型只在"摘要"那一层用一次（见 extractDigest）。
 * 每块取「用户这一侧最长的一条 + 角色这一侧最长的一条」，两句就能代表一幕的走向与口吻。
 */
export function splitStoryBlocks(messages: RoleplayMessage[], aiName = 'TA', blockSize = BLOCK_SIZE): { at: number; from: number; to: number; text: string }[] {
  const out: { at: number; from: number; to: number; text: string }[] = [];
  const msgs = messages || [];
  for (let from = 0; from < msgs.length; from += blockSize) {
    const to = Math.min(from + blockSize, msgs.length) - 1;
    const chunk = msgs.slice(from, to + 1);
    const users = chunk.filter((m) => m.role === 'user' && m.content).map((m) => m.content);
    const ais = chunk.filter((m) => m.role === 'assistant' && m.content).map((m) => m.content);
    const u = longestOf(users, LINE_USER);
    const a = longestOf(ais, LINE_AI);
    if (!u && !a) continue;
    const parts: string[] = [];
    if (u) parts.push('你：' + u);
    if (a) parts.push(aiName + '：' + a);
    const at = chunk.find((m) => typeof m.timestamp === 'number')?.timestamp ?? Date.now();
    out.push({ at, from, to, text: parts.join(' · ') });
  }
  return out;
}

/** 规则降级摘要（模型不可用时用；保证"导入一定拿得到结构化记忆"） */
export function extractiveDigest(brief: ScenarioBrief, messages: RoleplayMessage[], name: string): StoryDigest {
  const users = (messages || []).filter((m) => m.role === 'user' && m.content).map((m) => m.content);
  const first = users[0] ? oneLine(users[0], 40) : '';
  const last = users.length > 1 ? oneLine(users[users.length - 1], 40) : '';
  const keyEvents: { text: string; date?: string }[] = [];
  if (first) keyEvents.push({ text: `你们的剧情从「${first}」开始` });
  if (last) keyEvents.push({ text: `剧情进行到「${last}」` });
  const summary = [brief.title, first ? `开场：${oneLine(first, 40)}` : '', last ? `目前停在：${oneLine(last, 40)}` : '']
    .filter(Boolean).join('；').slice(0, 600);
  return {
    summary: summary || `${name}与用户在《${brief.title}》里共有一段经历。`,
    keyEvents,
    openThreads: [],
    msgCount: (messages || []).length,
    at: Date.now(),
  };
}

/** 摘要 → longMemory 事实（带日期用 date 字段，无日期视为 event 由 store 标 atApprox） */
export function buildStoryFacts(digest: StoryDigest): MemoryInput[] {
  const out: MemoryInput[] = [];
  for (const e of digest.keyEvents || []) {
    const text = (FACT_PREFIX + String(e?.text || '').trim()).slice(0, FACT_MAX);
    if (text.length <= FACT_PREFIX.length) continue;
    out.push({ text, kind: 'event', ...(e.date ? { date: e.date } : {}) });
  }
  for (const t of digest.openThreads || []) {
    const text = (FACT_PREFIX + '还没说完的事：' + String(t || '').trim()).slice(0, FACT_MAX);
    if (text.length <= FACT_PREFIX.length + 6) continue;
    out.push({ text, kind: 'state' });
  }
  return out;
}

/** 摘要 → 关系记忆文本（growth.relationship 单条上限 120，这里再收紧到 100 以便留出余量） */
export function buildStoryRelationship(digest: StoryDigest, title: string): string[] {
  const out: string[] = [];
  const head = `我们在《${title}》里认识的：${digest.summary}`.slice(0, 100);
  if (digest.summary) out.push(head);
  for (const e of (digest.keyEvents || []).slice(0, 6)) {
    const t = `（剧里）${String(e?.text || '').trim()}`.slice(0, 100);
    if (t.length > 5) out.push(t);
  }
  return out;
}

/** 规则降级摘要里的两条「进度标记」（不是事件，而是"故事进行到哪了"） */
const PROGRESS_PREFIXES = ['开场：', '目前停在：'];

function progressKeyOf(text: string): string {
  return PROGRESS_PREFIXES.find((p) => text.startsWith(p)) || '';
}

/** 增量合并：保留旧摘要的要点，只把新段落补进来（避免每次同步都重写一遍历史） */
export function mergeDigest(prior: StoryDigest | undefined, incoming: Partial<StoryDigest>, msgCount: number): StoryDigest {
  const events = [...(prior?.keyEvents || [])];
  for (const e of incoming.keyEvents || []) {
    const text = String(e?.text || '').trim();
    if (!text) continue;
    if (events.some((x) => x.text === text || x.text.includes(text) || text.includes(x.text))) continue;
    /**
     * 「开场：…」「目前停在：…」是规则降级摘要里的**进度标记**：每次同步都会生成一对新的，
     * 内容只差后面的引文，不按前缀替换的话，同步两次就会在「TA 记得的事」里出现两对
     * 「你们的剧情从…开始 / 剧情进行到…」（端到端实测的截图里亲眼看到过）。
     */
    const pk = progressKeyOf(text);
    if (pk) {
      for (let i = events.length - 1; i >= 0; i--) {
        if (progressKeyOf(events[i].text) === pk) events.splice(i, 1);
      }
    }
    events.push({ text, ...(e.date ? { date: e.date } : {}) });
  }
  const threads = (incoming.openThreads && incoming.openThreads.length) ? incoming.openThreads : (prior?.openThreads || []);
  return {
    summary: String(incoming.summary || prior?.summary || '').slice(0, 600),
    keyEvents: events.slice(-60),
    openThreads: threads.slice(0, 12),
    voiceTraits: String(incoming.voiceTraits || prior?.voiceTraits || ''),
    msgCount,
    at: Date.now(),
  };
}

/** 人设：剧情角色是谁（外貌/性格/背景，长背景截断） */
export function composeStoryIdentity(brief: ScenarioBrief, name: string): string {
  const meta = [brief.aiGender, brief.aiAge].filter(Boolean).join('，');
  const lines = [
    `${name}${meta ? `（${meta}）` : ''}，来自剧情《${brief.title}》${brief.kind === 'custom' ? '（用户自建剧本）' : ''}。`,
    brief.aiLooks ? `外貌：${brief.aiLooks}` : '',
    brief.aiPersonality ? `性格：${brief.aiPersonality}` : '',
    brief.background ? `背景：${brief.background}` : '',
  ].filter(Boolean);
  return lines.join('\n').slice(0, PERSONA_MAX);
}

/**
 * 底线：**剧情设定照演，现实边界照守**。
 * 为什么必须显式写这一段：剧情里大量角色是"占有欲/控制欲/病娇"型设定，搬到「随时可以聊」的窗口后，
 * 风险与剧情模式不同（剧情里用户是主动入戏、有场景边界）。这段是红线 1（陪伴非治疗/不制造依赖）的落地。
 */
export function composeStoryBoundaries(name: string): string {
  return [
    `${name}会按剧情里的性格、立场与关系回应（包括强势、占有欲、嘴硬、别扭等设定），这份设定照演。`,
    '但那条线一直在：不鼓励、也不美化现实里的控制、跟踪、威胁或伤害行为；不评判、不贴标签、不说「你应该」；不制造依赖。',
    '剧情里的设定不等于现实里的建议，如果用户把戏里的关系当成现实的标准，温柔地把戏和现实分开说。',
  ].join('');
}

/** 口吻：官方剧本的语言习惯 + 从剧情里提炼的口吻特征 */
export function composeStoryVoice(brief: ScenarioBrief, digest: StoryDigest): string {
  const parts = [
    brief.aiSpeech ? `剧情里的语言习惯：${brief.aiSpeech}` : '',
    digest.voiceTraits ? `从你们的对话里看出来的说话方式：${digest.voiceTraits}` : '',
  ].filter(Boolean);
  return parts.join('\n').slice(0, PERSONA_MAX);
}

/** 开场：优先用"还没说完的线"（连续性最强），否则给一句中性的重逢白 */
export function composeStoryOpening(brief: ScenarioBrief, digest: StoryDigest, name: string): string {
  const thread = (digest.openThreads || [])[0];
  if (thread) return `（${name}还惦记着那件事：${String(thread).slice(0, 80)}）`;
  return `（${name}像从那出戏里直接走过来一样，站在这里。）`;
}

/**
 * 角色名的唯一化：剧情角色的名字可能和用户已有的自建角色同名。
 * 不做拒绝（导入被挡会让人不明所以），改成加剧名后缀，用户想改随时能在角色编辑里改。
 */
export function uniqueStoryName(userId: string, name: string, title: string, excludeId?: string): string {
  const base = (name || 'TA').trim() || 'TA';
  if (!chatCharacterStore.nameExists(userId, base, excludeId)) return base;
  const withTitle = `${base}·${title}`.slice(0, 24);
  if (!chatCharacterStore.nameExists(userId, withTitle, excludeId)) return withTitle;
  let i = 2;
  while (chatCharacterStore.nameExists(userId, `${withTitle}${i}`.slice(0, 26), excludeId) && i < 50) i++;
  return `${withTitle}${i}`.slice(0, 26);
}

/**
 * 注入 prompt 的「剧情出身」块（双态，互斥）。
 *
 * ⚠️ 只带**摘要 + 未完成的线**，不带剧情原文：原文由 `memoryRecall` 按话题召回（top-2 块）。
 * 另外这里刻意**不**注入陪伴方式（Q4=A），它是「小愈怎么陪你」的用户级偏好，
 * 套到剧本人设上会立刻把角色说成"小愈味"。
 */
export function storyPromptBlock(c: ChatCharacter): string {
  const st = c.story;
  if (!st) return '';
  const d = st.digest;
  const mode: StoryMode = c.storyMode === 'out' ? 'out' : 'in';
  const you = st.userName || '你';
  const head = mode === 'in'
    ? `【你们的来历 · 入戏】你和对方不是网友初识：你们在剧情《${st.scenarioTitle}》里有一段真实经历，你在剧里是「${you}」，你就是「${c.name}」。现在你们换到了聊天窗口：**这是聊天，不是叙事现场**：像平时发消息那样说短句，不写旁白、不描写对方的动作与心理、不推进剧情场景；但称呼、关系、说话的立场都按剧里来。`
    : `【你们的来历 · 出戏】你们在剧情《${st.scenarioTitle}》里一起演过一段故事（你在剧里是「${c.name}」，对方是「${you}」）。现在你清楚那是**一段你们一起演的故事**，坐在你对面的是现实里真实的人：可以自然提「我们那出戏里…」，但不要把剧情当成现实里真的发生过的事，也不要继续用戏里的身份要求对方。仍然是短消息、不写旁白。`;
  const parts = [head];
  if (d?.summary) parts.push(`【那段故事（摘要）】${d.summary}`);
  if (d?.keyEvents?.length) parts.push(`【你记得的事】\n- ${d.keyEvents.slice(-12).map((e) => e.text + (e.date ? `（${e.date}）` : '')).join('\n- ')}`);
  if (d?.openThreads?.length) parts.push(`【你们还没说完的事，对方主动提起时顺势接住，别一上来就追着问】\n- ${d.openThreads.join('\n- ')}`);
  parts.push('（这段来历是你的底色，不是话术：不要主动罗列"我记得我们…"，也不要每轮都提剧情。对方聊现实生活时，就好好陪现实里的这件事。）');
  return '\n\n' + parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// 模型提炼（唯一会用 AI 的一步；失败 → 规则降级，绝不阻塞导入）
// ---------------------------------------------------------------------------
let aiClient: any = null;
async function getClient(): Promise<any> {
  if (!aiClient) {
    try { aiClient = createDeepSeekClient(); } catch { aiClient = null; }
  }
  return aiClient;
}

function safeParseJson(text: string): unknown {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  try { return JSON.parse(raw); } catch { /* 继续尝试截取 */ }
  const s = raw.indexOf('{'); const e = raw.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(raw.slice(s, e + 1)); } catch { return null; } }
  return null;
}

/** 均匀取样：首 6 条 + 尾 40 条 + 中间等距取样，整体 ≤60 行（控制单次调用成本） */
export function sampleStoryLines(messages: RoleplayMessage[], name: string, max = 60): string[] {
  const lines = (messages || [])
    .filter((m) => m.content)
    .map((m) => (m.role === 'assistant' ? name + '：' : '你：') + oneLine(m.content, 160));
  if (lines.length <= max) return lines;
  const head = lines.slice(0, 6);
  const tail = lines.slice(-40);
  const middle = lines.slice(6, lines.length - 40);
  const step = Math.max(1, Math.floor(middle.length / Math.max(1, max - head.length - tail.length)));
  const picked = middle.filter((_, i) => i % step === 0);
  return [...head, ...picked, ...tail].slice(0, max + 14);
}

async function extractDigestByModel(userId: string, brief: ScenarioBrief, messages: RoleplayMessage[], name: string, prior?: StoryDigest): Promise<StoryDigest | null> {
  // 开关：`STORY_BRIDGE_NO_LLM=1` → 一律走规则抽取（单测用；也可在 AI 账单异常时作为运营 kill switch）
  if (process.env.STORY_BRIDGE_NO_LLM === '1') return null;
  const client = await getClient();
  if (!client) return null;
  const lines = sampleStoryLines(messages, name).join('\n');
  const prompt = `你是"${name}"的记忆整理助手。下面是一段**角色剧情扮演**的记录（用户与"${name}"在《${brief.title}》里演的戏）。
请把它整理成"${name}"自己能记住的东西，用于之后在普通聊天里延续这段关系。只输出 JSON，不要解释。

【剧本背景】${oneLine(brief.background, 600)}
${prior?.summary ? `【此前已整理的摘要（不要重复它，只补新的）】${prior.summary}\n` : ''}
【剧情记录（节选）】
${lines}

输出 JSON：
{
  "summary": "一段话概括你们的经历（≤150字，只写记录里明确发生过的，不要编）",
  "keyEvents": [{"text":"发生过的一件事（≤35字，写清谁对谁做了什么）","date":"YYYY-MM-DD 或空字符串"}],
  "openThreads": ["还没说完/没解决的事（≤30字/条，最多 4 条；没有就空数组）"],
  "voiceTraits": "从对话里看出来的说话方式（≤60字：用词、句长、称呼、口头禅、语气；没有明显特征就空字符串）"
}
要求：keyEvents 最多 12 条、按时间顺序；只写明确发生的；日期能从剧情里推出来才写（今天参考日期 ${new Date().toISOString().slice(0, 10)}），推不出来就空字符串。`;

  try {
    const result = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      userId, // 用量归属（成本账本按 feature='memory' 归到"后台记忆类"，与 extractMemoryFacts 同账）
      feature: 'memory', // 与长期记忆提炼同账（后台记忆类开销）
    });
    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = safeParseJson(text) as { summary?: unknown; keyEvents?: unknown; openThreads?: unknown; voiceTraits?: unknown } | null;
    if (!parsed || typeof parsed !== 'object') return null;
    const keyEvents = (Array.isArray(parsed.keyEvents) ? parsed.keyEvents : [])
      .map((e) => {
        const o = e as { text?: unknown; date?: unknown };
        const t = String(o?.text ?? '').trim().slice(0, 40);
        const d = String(o?.date ?? '').trim();
        return t ? { text: t, ...(/^\d{4}-\d{2}-\d{2}$/.test(d) ? { date: d } : {}) } : null;
      })
      .filter((x): x is { text: string; date?: string } => !!x)
      .slice(0, 12);
    const openThreads = (Array.isArray(parsed.openThreads) ? parsed.openThreads : [])
      .map((t) => String(t ?? '').trim().slice(0, 60)).filter(Boolean).slice(0, 4);
    const summary = String(parsed.summary ?? '').trim().slice(0, 600);
    if (!summary && !keyEvents.length) return null;
    return {
      summary,
      keyEvents,
      openThreads,
      ...(String(parsed.voiceTraits ?? '').trim() ? { voiceTraits: String(parsed.voiceTraits).trim().slice(0, 200) } : {}),
      msgCount: messages.length,
      at: Date.now(),
    };
  } catch (error) {
    console.warn('⚠️ [StoryBridge] 摘要提炼失败，降级为规则摘要:', (error as Error)?.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 场景解析（I/O）
// ---------------------------------------------------------------------------
export function resolveScenarioBrief(scenarioId: string, lang: 'zh' | 'en' = 'zh'): ScenarioBrief | null {
  const official = getScenario(scenarioId);
  if (official) return briefFromOfficial(official, lang);
  const custom = customRoleplayStore.findById(scenarioId);
  if (custom) return briefFromCustom(custom);
  return null;
}

function langOf(userId: string): 'zh' | 'en' {
  try { return preferenceStore.get(userId).language === 'en' ? 'en' : 'zh'; } catch { return 'zh'; }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 剧情角色「第一句」（2026-09-20 用户口径：刚导入的角色排在列表最后很奇怪）。
 *
 * 做法：导入成功后，如果这个角色**还没有任何聊一聊会话**，就替它开一条会话、把 TA 的开场白
 * 作为**第一条角色消息**落进去（并留成未读）。
 *
 * 为什么不是"把没有会话的角色排到列表最前"：那样只要用户建了几个角色没聊过，它们会永远压在
 * 真正有对话的角色上面；而"TA 先开口"是微信里最自然的排序理由（新消息在顶部），
 * 且天然复用未读体系（角标 1 → 点进去 → 看到 TA 的第一句）。
 *
 * 红线 6 自检：写进去的是**角色自己的开场白**（`opening` 由剧本人设/未完成的线生成，角色口吻），
 * 不是系统提示、不是兜底文案，与 reengage 的 App 内主动消息同一性质。
 */
function seedGreetingSession(userId: string, character: ChatCharacter): boolean {
  try {
    const mine = memoryStorage.getActiveSessions()
      .filter((s) => s.userId === userId && (s.characterId || 'xiaoyu') === character.id && (s.chatMessages?.length || 0) > 0);
    if (mine.length > 0) return false; // 已经有对话了 → 不要再"打招呼"（重复导入也不会刷屏）
    const text = String(character.opening || '').trim();
    if (!text) return false;
    const now = new Date();
    const sessionId = 'chat_' + randomUUID();
    memoryStorage.createSession(sessionId);
    const created = memoryStorage.updateSession(sessionId, {
      userId,
      characterId: character.id,
      chatTitle: text.slice(0, 30),
      chatMessages: [{ role: 'assistant', content: text, timestamp: now }],
      chatUpdatedAt: now,
      // 留成未读：用户回到消息列表就能看到"TA 开口了"（1 条未读）
      chatLastReadAt: now.getTime() - 1,
    });
    if (created) return true;
    memoryStorage.deleteSession(sessionId); // 兜底：没写成就不留半条状态
    return false;
  } catch (error) {
    console.warn('[StoryBridge] 开场消息写入失败（不影响导入本身）:', (error as Error)?.message);
    return false;
  }
}

/**
 * 把一段剧情导入成聊一聊角色（幂等）。
 * 失败只抛 StoryBridgeError（NO_STORY / SCENARIO_NOT_FOUND），其余一律降级继续，导入不该因为模型问题失败。
 */
export async function importStoryCharacter(opts: ImportStoryOptions): Promise<ImportStoryResult> {
  const { userId, scenarioId } = opts;
  const brief = resolveScenarioBrief(scenarioId, langOf(userId));
  if (!brief) throw new StoryBridgeError('SCENARIO_NOT_FOUND', '剧本不存在或已删除');
  const session = roleplaySessionStore.getRecord(userId, scenarioId);
  const messages = session.messages || [];
  if (!messages.length) throw new StoryBridgeError('NO_STORY', '这段剧情还没有内容，先聊几句再来');

  const name = (opts.aiName || '').trim() || brief.aiName;
  const userName = (opts.userName || '').trim() || brief.defaultUserName;
  const title = (session.scenarioTitle || '').trim() || brief.title;

  const existing = chatCharacterStore.findByScenario(userId, scenarioId);
  const digestByModel = await extractDigestByModel(userId, brief, messages, name, existing?.story?.digest);
  const digest = digestByModel
    ? mergeDigest(existing?.story?.digest, digestByModel, messages.length)
    : mergeDigest(existing?.story?.digest, extractiveDigest(brief, messages, name), messages.length);

  const generated = {
    avatar: brief.avatar,
    identity: composeStoryIdentity(brief, name),
    boundaries: composeStoryBoundaries(name),
    voice: composeStoryVoice(brief, digest),
    opening: composeStoryOpening(brief, digest, name),
  };
  /**
   * 重复导入时**不覆盖用户手改过的人设**（2026-09-20 复核补）。
   *
   * 判据：拿 `story.persona`（上次由系统写入的那份）逐字段比对，当前值 == 上次系统写的那份
   * ⇒ 用户没动过，可以随剧本刷新；当前值 ≠ 它（且不是空）⇒ 用户改过，**保留用户的**。
   * 没有快照的老数据（本修复之前导入的）按"系统写的"处理，照旧刷新。
   */
  const snap = existing?.story?.persona;
  const userEdited = (field: 'identity' | 'voice' | 'boundaries' | 'opening' | 'avatar'): boolean => {
    if (!snap) return false;
    const cur = String(existing?.[field] ?? '');
    if (!cur) return false;
    return cur !== String(snap[field] ?? '');
  };
  const persona = {
    avatar: userEdited('avatar') ? (existing!.avatar || '') : generated.avatar,
    identity: userEdited('identity') ? existing!.identity : generated.identity,
    boundaries: userEdited('boundaries') ? existing!.boundaries : generated.boundaries,
    voice: userEdited('voice') ? existing!.voice : generated.voice,
    opening: userEdited('opening') ? (existing!.opening || '') : generated.opening,
  };

  const binding: StoryBinding = {
    scenarioId,
    scenarioTitle: title,
    kind: brief.kind,
    aiName: name,
    userName,
    importedAt: existing?.story?.importedAt || Date.now(),
    syncedMsgCount: messages.length,
    syncedAt: Date.now(),
    // 快照记的是"这次系统写了什么"，供下次导入判断用户有没有改过
    persona: generated,
    digest,
  };

  let character: ChatCharacter;
  let created = false;
  if (existing) {
    // 幂等：已有该剧本的剧情角色 → 只更新人设与绑定，保留用户自己改过的名字/音色/双态
    character = chatCharacterStore.update(userId, existing.id, {
      ...persona,
      story: binding,
      storyMode: opts.storyMode || existing.storyMode || 'in',
    })!;
    character = chatCharacterStore.setStoryDigest(userId, character.id, digest, messages.length)!;
  } else {
    character = chatCharacterStore.create(userId, {
      name: uniqueStoryName(userId, name, title),
      ...persona,
      origin: 'story',
      story: binding,
      storyMode: opts.storyMode || 'in',
      useCompanionMode: false, // Q4=A：剧情角色不套陪伴方式
    });
    created = true;
  }

  const blockCount = seedStoryMemory(userId, character.id, scenarioId, brief, messages, digest, title, name);
  // 让它"先在聊一聊里开口"：新建会话 + 开场白（已有会话则不动）→ 列表里有位置、且是未读
  seedGreetingSession(userId, character);
  return { character, created, msgCount: messages.length, blockCount, digestByModel: !!digestByModel };
}

/**
 * 把摘要与场面块真正写进记忆（longMemory + growth + storyArchive）。
 * 幂等：块按 `(from,to)` 去重；longMemory.addFacts 自身按文本去重。
 */
export function seedStoryMemory(
  userId: string,
  characterId: string,
  scenarioId: string,
  brief: ScenarioBrief,
  messages: RoleplayMessage[],
  digest: StoryDigest,
  title: string,
  name: string,
): number {
  // 1) 场面块（细节层，供语义按需召回），覆盖式写：每次导入都用最新会话重算
  const blocks = splitStoryBlocks(messages, name).map((b, i) => ({ id: `sb_${b.at.toString(36)}_${i.toString(36)}`, ...b }));
  storyArchiveStore.replaceBlocks(userId, characterId, scenarioId, blocks);

  // 2) 摘要事实（≤80 字/条，带日期）→ 进"最近窗口"，随时在场
  const facts = buildStoryFacts(digest);
  if (facts.length) {
    let maxFacts = 60;
    try { maxFacts = quotaStore.getMaxMemoryFacts(userId); } catch { /* 用默认 */ }
    longMemoryStore.addFacts(userId, facts, maxFacts, characterId);
  }

  // 3) 关系底色（关系记忆块，每轮都在 prompt 里）
  const rel = buildStoryRelationship(digest, title);
  if (rel.length) chatCharacterGrowthStore.addRelationship(userId, characterId, rel, digest.at);

  return blocks.length;
}

/**
 * 增量同步：剧情又玩了 → 只提炼新增段落，追加块 + 合并摘要。
 * 返回新增块数（0 = 没有新内容/不值得同步）。
 */
export async function syncStoryCharacter(userId: string, characterId: string): Promise<{ added: number; syncedMsgCount: number; byModel: boolean }> {
  const rec = chatCharacterStore.get(userId, characterId);
  if (!rec || rec.origin !== 'story' || !rec.story) throw new StoryBridgeError('NOT_STORY_CHARACTER', '这不是剧情角色');
  const { scenarioId } = rec.story;
  const session = roleplaySessionStore.getRecord(userId, scenarioId);
  const messages = session.messages || [];
  const cursor = Math.max(0, rec.story.syncedMsgCount || 0);
  if (messages.length - cursor < MIN_SYNC_MSGS) {
    return { added: 0, syncedMsgCount: cursor, byModel: false };
  }
  const fresh = messages.slice(cursor);
  const brief = resolveScenarioBrief(scenarioId, langOf(userId));
  if (!brief) throw new StoryBridgeError('SCENARIO_NOT_FOUND', '剧本不存在或已删除');
  const name = rec.story.aiName || rec.name;

  const byModel = await extractDigestByModel(userId, brief, fresh, name, rec.story.digest);
  const digest = byModel
    ? mergeDigest(rec.story.digest, byModel, messages.length)
    : mergeDigest(rec.story.digest, extractiveDigest(brief, fresh, name), messages.length);

  // 只追加新增段的块（按 (from,to) 去重）；下标要按整段会话的坐标系偏移
  const offset = cursor;
  const blocks = splitStoryBlocks(fresh, name).map((b, i) => ({ id: `sb_${b.at.toString(36)}_${(offset + i).toString(36)}`, ...b, from: b.from + offset, to: b.to + offset }));
  const added = storyArchiveStore.appendBlocks(userId, characterId, scenarioId, blocks);

  if (digest.keyEvents?.length) {
    const facts = buildStoryFacts({ ...digest, keyEvents: digest.keyEvents.slice(-6), openThreads: [] });
    if (facts.length) {
      let maxFacts = 60;
      try { maxFacts = quotaStore.getMaxMemoryFacts(userId); } catch { /* 用默认 */ }
      longMemoryStore.addFacts(userId, facts, maxFacts, characterId);
    }
  }
  const rel = buildStoryRelationship({ ...digest, keyEvents: digest.keyEvents.slice(-3) }, rec.story.scenarioTitle || brief.title);
  if (rel.length) chatCharacterGrowthStore.addRelationship(userId, characterId, rel, digest.at);

  chatCharacterStore.setStoryDigest(userId, characterId, digest, messages.length);
  return { added: added.length, syncedMsgCount: messages.length, byModel: !!byModel };
}

/** 「TA 记得的这段剧情」（只读回看，供聊一聊侧的角色卡） */
export function getStoryView(userId: string, characterId: string) {
  const rec = chatCharacterStore.get(userId, characterId);
  if (!rec || rec.origin !== 'story' || !rec.story) return null;
  const session = roleplaySessionStore.getRecord(userId, rec.story.scenarioId);
  const liveCount = (session.messages || []).length;
  return {
    binding: rec.story,
    mode: rec.storyMode === 'out' ? 'out' : 'in',
    blocks: storyArchiveStore.listBlocks(userId, characterId),
    liveMsgCount: liveCount,
    /** 剧情那边又玩了几条（前端据此显示「同步这段剧情」） */
    pendingMsgCount: Math.max(0, liveCount - (rec.story.syncedMsgCount || 0)),
  };
}

/** 测试辅助：把 AI 客户端重置（避免用例之间互相污染） */
export function __resetStoryBridgeClient(): void { aiClient = null; }
