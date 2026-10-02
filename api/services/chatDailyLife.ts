/**
 * 聊一聊 · 小愈「今天自己这边的小事」（off-screen life，2026-09-19）
 *
 * ## 为什么要有这个（不是加设定，是补结构缺口）
 * 2026-09-19 的诊断结论：小愈的 system 里**所有素材都是"关于用户的"**：长期记忆、语义召回、关系记忆、
 * 日记反思、行为感知、时间锚，无一例外。唯一"关于她自己的"是背景故事（小芽精灵 / 怀里那罐金色的光），
 * 而实测里那段设定**被降级成了括号动作道具**（「（把罐子往你手边推了推）」出现两次，从没被当成"我的事"讲出来）。
 * 一个只会回应你、从不带来自己东西的人，在体感上不是朋友，这正是「像朋友打趣/吐槽/分享」缺失的根。
 *
 * ## 设计要点（每条都对应本仓库已有的一条教训）
 * 1. **按天缓存、不在对话里现生成**：生成一次（每个用户×角色每天 1 次小调用），之后每轮只是**同步读缓存**。
 *    对话链路里多一次 await 就是多几秒延迟，而"今天的小事"本来就不需要即时性。
 * 2. **同步 peek + 异步预热分工**：`peek()` 给 `buildChatPromptParts` 同步读；路由层在回复之后
 *    fire-and-forget 调 `ensure()`，所以是"下一条消息起可用"，不是"第一条就可用"（如实记录，见 CHANGELOG）。
 * 3. **模型失败必须优雅退化**：生成失败/解析失败/内容被过滤 → 用**静态兜底池**按日期轮换。
 *    兜底池是"能用但不是最好的"，绝不因为一次调用失败就让功能整块消失。
 * 4. **注入的是"可以提起"，不是"每轮必提"**：本仓库反复吃过「硬 cue」的亏（行为感知/记忆都写了"不要硬 cue"）。
 *    这里同样写死：不要每轮都提、不要硬拗到用户情绪上（用户难过时，你自己的小事不配抢戏）。
 * 5. **合规定位**：兜底池与模型输出都过一遍过滤（自伤词、医疗承诺词「治愈/疗愈/治疗」等），
 *    陪伴不是治疗这条红线不因为"生成的小事"而放松。
 *
 * 开关：`CHAT_DAILY_LIFE=0`（关掉注入与生成；消融与线上止血用）。
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { SELF_HARM_KEYWORDS } from './safety.js';
import { toZhTw, type OutputLang } from './zhConvert.js';

export interface DailyLifeItem {
  text: string;
  at: number;
}

export interface DailyLifeRecord {
  userId: string;
  characterId: string;
  /** 这份小事属于哪一天（用户时区的 YYYY-MM-DD）；跨天自然失效 */
  dateKey: string;
  items: DailyLifeItem[];
  /** 来源：model=模型生成；fallback=模型失败/被过滤后用的静态池 */
  source: 'model' | 'fallback';
  updatedAt: number;
}

const FILE = dataFile('chat-daily-life.json');

/** 每天生成几条 */
const ITEMS_PER_DAY = 2;
/** 单条长度上限（超长的一律丢弃：小事就该短） */
const MAX_ITEM_CHARS = 60;
/** 过滤：品牌红线里的医疗承诺词，陪伴不是治疗，小事也不例外 */
const MEDICAL_WORDS = /治愈|疗愈|治疗|疗程|康复/;
const SELF_HARM_RE = new RegExp(SELF_HARM_KEYWORDS);

/**
 * 静态兜底池（模型失败时按日期轮换取）。
 * ⚠️ 它本身也会重复，所以它**只是兜底**，不是常态；source 会如实记成 fallback，
 * 运营端可以据此看出"某个用户一直在吃兜底"，而不是把重复当成模型的错。
 */
const FALLBACK_ZH = [
  '窗台那盆东西今天又冒了一点新芽',
  '楼下那家早餐摊今天没开，白跑一趟',
  '泡茶的时候走神，水溢了一桌子',
  '路上有只猫蹲在别人的车座上，怎么说都不下来',
  '翻柜子翻出一个很久没用的杯子，擦干净又放回去了',
  '傍晚那块云像被人从边上扯了一下',
];
const FALLBACK_EN = [
  'The plant on my windowsill pushed out another tiny leaf today',
  'The breakfast place downstairs was shut, so I walked down for nothing',
  'I spaced out while pouring tea and flooded the table',
  'A cat was parked on someone else’s scooter and refused to move',
  'I dug out a mug I had not used in ages, wiped it clean and put it back',
  'The cloud this evening looked like someone had tugged at one edge',
];

class ChatDailyLifeStore {
  private items = new Map<string, DailyLifeRecord>();

  constructor() { this.loadFromDisk(); }

  private key(userId: string, characterId: string): string { return userId + '::' + characterId; }

  private loadFromDisk(): void {
    try {
      const parsed = readJson<DailyLifeRecord[]>(FILE, []);
      if (Array.isArray(parsed)) {
        parsed.forEach((r) => {
          if (r?.userId && r.characterId && r.dateKey) this.items.set(this.key(r.userId, r.characterId), r);
        });
      }
    } catch { /* 忽略 */ }
  }

  private saveToDisk(): void {
    try { writeJson(FILE, Array.from(this.items.values())); } catch { /* 忽略 */ }
  }

  /** 同步读：只返回**今天**那批（跨天的当作没有，不注入过期的小事） */
  peek(userId: string, characterId: string, dateKey: string): DailyLifeItem[] {
    const rec = this.items.get(this.key(userId, characterId));
    if (!rec || rec.dateKey !== dateKey || !Array.isArray(rec.items)) return [];
    return rec.items;
  }

  /** 用于测试与运营排查：不看日期，返回原始记录 */
  raw(userId: string, characterId: string): DailyLifeRecord | undefined {
    return this.items.get(this.key(userId, characterId));
  }

  put(userId: string, characterId: string, dateKey: string, texts: string[], source: 'model' | 'fallback'): DailyLifeItem[] {
    const now = Date.now();
    const items = texts.map((text) => ({ text, at: now }));
    const rec: DailyLifeRecord = { userId, characterId, dateKey, items, source, updatedAt: now };
    this.items.set(this.key(userId, characterId), rec);
    this.saveToDisk();
    return items;
  }
}

export const chatDailyLifeStore = new ChatDailyLifeStore();

/** 按日期从静态池里轮换取 n 条（同一天稳定，不同天不同） */
export function fallbackItems(dateKey: string, lang: 'zh' | 'en', n = ITEMS_PER_DAY): string[] {
  const pool = lang === 'en' ? FALLBACK_EN : FALLBACK_ZH;
  // 用日期串算一个稳定的起始下标（同一天永远同一批，免得同一天刷新就变）
  let h = 0;
  for (const ch of dateKey) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  const out: string[] = [];
  for (let i = 0; i < n && i < pool.length; i++) out.push(pool[(h + i) % pool.length]);
  return out;
}

/**
 * 过滤模型输出：**宁可少，不要脏**。
 * 丢掉：空串、超长、含自伤词、含医疗承诺词、重复项。
 * 全部被丢光时返回空数组（调用方据此退回静态池）。
 */
export function sanitizeDailyItems(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const text = String(item ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > MAX_ITEM_CHARS) continue;
    if (SELF_HARM_RE.test(text) || MEDICAL_WORDS.test(text)) continue;
    if (text.includes('用户')) continue; // 小事里不该出现"用户"这种第三人称（那是系统口吻漏出来了）
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= ITEMS_PER_DAY) break;
  }
  return out;
}

/** 是否启用（开关 + 是否有 userId） */
export function dailyLifeEnabled(): boolean {
  return process.env.CHAT_DAILY_LIFE !== '0';
}

/**
 * 组装注入块。没有条目时返回空串（**不注入空噪声**）。
 * 三语与其它块一致：zh 原文 / zh-TW 走 toZhTw / en 独立文案。
 */
export function buildDailyLifeBlock(items: DailyLifeItem[], lang: RepeatLikeLang = 'zh'): string {
  const texts = (items || []).map((i) => String(i?.text || '').trim()).filter(Boolean);
  if (!texts.length) return '';
  if (lang === 'en') {
    return '\n\n【A couple of small things from your own day】(this is YOUR life, nothing to do with them — it is what makes you a person with a day of your own instead of a machine that only answers)\n'
      + texts.map((t) => '- ' + t).join('\n')
      + '\nHow to use it: you MAY bring one up naturally when it fits (they ask what you have been up to, the topic touches food/weather/ordinary days, or it genuinely connects to what they just said). Do NOT mention it every turn, and never bend it onto their feelings — when they are hurting, your small things do not get to take the spotlight.';
  }
  const zh = '【你今天自己这边的小事】（这是**你自己的生活**，跟 TA 无关；用来让你像个有自己一天的人，而不是只会接话的机器）\n'
    + texts.map((t) => '- ' + t).join('\n')
    + '\n怎么用：**可以**在合适的时候自然带一句（TA 问你在干嘛、聊到吃的天气或普通的一天、或者正好接得上 TA 刚说的话）；**不要每轮都提**，也不要硬拗到 TA 的情绪上，TA 正难过的时候，你自己的小事不配抢戏。';
  return '\n\n' + (lang === 'zh-TW' ? toZhTw(zh) : zh);
}

type RepeatLikeLang = 'zh' | 'zh-TW' | 'en' | OutputLang;

/** 正在进行中的生成（防止同一用户并发触发多次调用） */
const inflight = new Map<string, Promise<DailyLifeItem[]>>();

/**
 * 取今天的小事；没有就生成一次并落盘（**每个用户×角色每天最多 1 次模型调用**）。
 *
 * 为什么要 in-flight 去重：用户连发两条消息时，两个请求会同时发现"今天还没有"，
 * 不去重就会生成两遍、覆盖两遍（白花钱且内容还会漂）。
 */
export async function ensureDailyLife(
  userId: string,
  characterId: string,
  characterName: string,
  opts: { dateKey: string; tz?: string; lang?: 'zh' | 'en' } = { dateKey: '' },
): Promise<DailyLifeItem[]> {
  const { dateKey } = opts;
  if (!dailyLifeEnabled() || !userId || !dateKey) return [];
  const cached = chatDailyLifeStore.peek(userId, characterId, dateKey);
  if (cached.length) return cached;
  const key = userId + '::' + characterId + '::' + dateKey;
  const running = inflight.get(key);
  if (running) return running;

  const lang: 'zh' | 'en' = opts.lang === 'en' ? 'en' : 'zh';
  const task = (async (): Promise<DailyLifeItem[]> => {
    let texts: string[] = [];
    try {
      const { createDeepSeekClient } = await import('./deepseek.js');
      const client = createDeepSeekClient();
      const prompt = lang === 'en'
        ? `You are "${characterName}" — a warm, everyday companion with a life of your own.
Write ${ITEMS_PER_DAY} small things that happened on YOUR side today, to be mentioned naturally in chat later.
Rules:
- concrete and trivial, with one visual detail (an object, a small action, a moment)
- nothing to do with the user, no advice, no comfort, no life lessons, no sentimentality
- each under 40 characters (English words count as characters here: keep them short), colloquial, a little dry humour is welcome
- never address "you", no questions, no emoji, no medical or healing language
- do not repeat: ${FALLBACK_EN.slice(0, 3).join(' / ')}
Output a JSON array of strings only, e.g. ["...", "..."]`
        : `你是"${characterName}"，一个有自己的日子的陪伴者。
请写 ${ITEMS_PER_DAY} 条**你今天自己这边发生的小事**，用于以后聊天时自然提起。
要求：
- 具体、琐碎、带一个画面细节（一个物件、一个小动作、一个瞬间）
- 跟用户无关；不要说教、不要安慰、不要金句、不要煽情
- 每条 ≤ 28 字，口语，可以有一点小幽默或小吐槽
- 不要提"你/用户"，不要问句，不要 emoji，不要出现治愈/疗愈这类词
- 不要和下面这些重复：${FALLBACK_ZH.slice(0, 3).join(' / ')}
只输出 JSON 字符串数组，如 ["……","……"]`;
      const result = await client.models.generateContent({
        model: 'gemini-2.5-flash', // 兼容占位符＝用默认模型（与记忆提取同口径）
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        userId,
        feature: 'dailyLife', // 成本归属：小愈的日常（后台，每用户每天 1 次）
      });
      const text = result.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const jsonText = (text.match(/\[[\s\S]*\]/) || [text])[0];
      texts = sanitizeDailyItems(JSON.parse(jsonText));
    } catch (e) {
      console.warn('⚠️ [DailyLife] 生成失败，改用静态兜底池：', (e as Error)?.message);
    }
    if (!texts.length) return chatDailyLifeStore.put(userId, characterId, dateKey, fallbackItems(dateKey, lang), 'fallback');
    return chatDailyLifeStore.put(userId, characterId, dateKey, texts, 'model');
  })().finally(() => { inflight.delete(key); });

  inflight.set(key, task);
  return task;
}
