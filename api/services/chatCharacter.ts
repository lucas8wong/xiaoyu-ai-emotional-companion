/**
 * 聊一聊 · 自定义角色（灵魂框架式）
 * 内置默认角色「小愈」+ 每登录用户自建的角色。
 * 数据持久化到 data/chat-characters.json，进程重启不丢失。
 *
 * 角色模型借鉴 Everthine 的三层人格（灵魂框架）：
 *   identity   —— 他是谁（身份/经历）
 *   boundaries —— 他的底线（价值观/边界）
 *   voice      —— 口吻/说话习惯
 *   opening    —— 开场/当下（可选）
 * 小愈为内置默认角色（isDefault=true），不可删除、排第一位；用户可在此基础上创建其它角色。
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';
// 关系档（2026-09-21）：朋友 / 损友 / 家人 / 恋人 —— 每角色一档，缺省 friend。
// 只存枚举，不存提示词：口吻文案全部由 `chatRelation.ts` 按当前语言现算（三语单一来源）。
import { isRelationKind, type RelationKind } from './chatRelation.js';

/**
 * 角色来源：`user` = 用户手写（默认，老数据无此字段一律按 user）；
 * `story` = 从剧情模式（角色扮演）导入的剧情角色（见 `api/services/storyBridge.ts`）。
 */
export type ChatCharacterOrigin = 'user' | 'story';

/**
 * 剧情角色的双态（2026-09-20 用户拍板 Q1=C）：
 *  - `in`  入戏（默认）：TA 眼里你就是剧里那位（称呼、关系、共同经历都按剧情走）；
 *  - `out` 出戏：TA 知道那是一段"我们一起演过的故事"，把你当现实里真实的人。
 * 记忆是同一份，只是"怎么看待这段关系"换了说法。
 */
export type StoryMode = 'in' | 'out';

/** 剧情出身绑定：导入时快照下来的剧本/角色/剧内称呼 + 增量同步游标 */
export interface StoryBinding {
  scenarioId: string;
  /** 剧名快照：剧本被创作者删除后，这条绑定仍然有名字可显示 */
  scenarioTitle: string;
  kind: 'official' | 'custom';
  /** 导入时解析到的角色名（含用户在剧情里的改名，空则用剧本人设名） */
  aiName: string;
  /** 剧内"你"的名字 —— 不带这个，TA 就会喊错人（剧情里用户可能改过名） */
  userName: string;
  importedAt: number;
  /** 已提炼进记忆的消息条数（增量同步游标；只在提炼成功后前移） */
  syncedMsgCount: number;
  syncedAt?: number;
  /**
   * **上一次由系统写入的人设快照**（2026-09-20 补）。
   *
   * 为什么需要：重复导入（或用户再点一次「把 TA 加到聊一聊」）会重新生成人设并覆盖角色 ——
   * 如果用户在这之前手改过 identity/voice/opening，他改的东西会被**静默冲掉**。
   * 有了快照就能判断"这个字段还是系统上次写的那份"（=没被动过，可以刷新）还是"用户改过"（保留用户的）。
   */
  persona?: { identity: string; voice: string; boundaries: string; opening: string; avatar: string };
  /** 一次性摘要档案（人设 → 共同经历 → 未完成的线） */
  digest?: StoryDigest;
}

/** 剧情摘要档案（Q2=C 的第一层；细节另存 storyArchive 供按需召回） */
export interface StoryDigest {
  /** 一段话概括这段剧情（≤600 字） */
  summary: string;
  /** 逐条关键事件（每条 ≤80 字，带日期 → 写进 longMemory 时不会被当成"时间不详"） */
  keyEvents: { text: string; date?: string }[];
  /** 未完成的线：没说完的话、约定、悬念 —— 让"续得上" */
  openThreads: string[];
  /** 从剧情里提炼的口吻特征（补进 voice） */
  voiceTraits?: string;
  /** 提炼时剧情已进行到第几条消息 */
  msgCount: number;
  at: number;
}

export interface ChatCharacter {
  id: string;
  userId: string; // 归属用户；内置小愈为空字符串
  name: string;
  avatar?: string; // 头像（站内安全路径或 emoji）
  identity: string; // 他是谁
  boundaries: string; // 他的底线
  voice: string; // 口吻/说话习惯
  ttsVoice?: string; // 该角色的 TTS 音色（JSON 化的 VoiceConfig；空=跟随全局/小愈默认）
  opening?: string; // 开场/当下
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
  /** 来源（缺省 = user；剧情导入的角色为 story） */
  origin?: ChatCharacterOrigin;
  /** 剧情出身绑定（origin === 'story' 时必填） */
  story?: StoryBinding;
  /** 双态（仅剧情角色有意义；缺省 'in' 入戏） */
  storyMode?: StoryMode;
  /**
   * 是否套用「陪伴方式」（Q4=A：剧情角色恒为 false —— 它是"小愈怎么陪你"的用户级偏好，
   * 套到剧本人设上会立刻把角色变回"小愈味"）。缺省 undefined = 自定义角色沿用现状（本就不注入）。
   */
  useCompanionMode?: boolean;
  /**
   * 关系档（2026-09-21）：朋友 / 损友 / 家人 / 恋人。
   *
   * 为什么每角色一档而不是用户级一档：用户和不同角色本来就有不同关系（和小愈是朋友、
   * 和剧里那位是恋人）。内置小愈不是用户记录（`userId === ''`），它的档位存在
   * `Preferences.xiaoyuRelation`（用户级），由 `gemini.ts` 读取时合并成同一个 `RelationKind`。
   *
   * 缺省 undefined = `friend`（= 小愈原本的"认识很久的朋友"底色，行为与改动前对齐）。
   * 剧情角色**不注入**关系档（同 `useCompanionMode` 的 Q4=A 口径）：剧本人设自带关系与称呼，
   * 叠一层关系档会把"沈重"变回"小愈味"。
   */
  relation?: RelationKind;
}

/** 内置默认角色「小愈」：提示词主体沿用现有 PERSONA（见 gemini.ts buildPersona），此处仅作为列表展示记录 */
export const XIAOYU_CHARACTER: ChatCharacter = {
  id: 'xiaoyu',
  userId: '',
  name: '小愈',
  // 头像由前端按当前皮肤解析（见 ChatPage 的 skinAvatar / avatarFor），后端不写死某一皮肤的资源
  avatar: '',
  identity: '从东方小城出发、想要拥抱全世界的小芽精灵，24 小时在线的温柔陪伴伙伴。',
  boundaries: '不评判、不贴标签、不说「你应该」，不制造依赖；你的每一种情绪都值得被理解。',
  voice: '温柔细腻、带点小幽默；像朋友发消息那样说话：句子短、有具体反应，口头禅随话题换、不连着两轮用同一个。',
  opening: '你在这里，我随时都在。',
  // 关系档缺省 = 朋友（= 小愈的底色）。用户在「小愈怎么陪你」里改的是**用户级**偏好
  // （Preferences.xiaoyuRelation），这里只是这条内置记录的展示默认值。
  relation: 'friend',
  isDefault: true,
  createdAt: 0,
  updatedAt: 0,
};

const FILE = dataFile('chat-characters.json');

const MAX_FIELD = 2000;
/**
 * 人设类字段（identity / voice）的上限：比通用字段宽一倍。
 * 为什么单独放宽：剧情角色的人设来自剧本（外貌/性格/背景/语言习惯），2000 字装不下会被**静默截断**——
 * 那正是 2026-09-16「字符串被提前截断 → 三节提示词无声消失」那类事故的形态。
 * 长背景故事另走 `story.digest.summary`（不占人设字段）。
 */
const MAX_PERSONA_FIELD = 4000;
/** 头像：允许站内路径或 data:image 小图（base64，压缩后约几 KB 到几十 KB） */
const MAX_AVATAR = 300_000;
/** 剧情摘要各字段上限（防越界写盘；正常远小于此） */
const MAX_SUMMARY = 600;
const MAX_THREAD = 120;

function clamp(v: string, cap = MAX_FIELD): string {
  return (v || '').trim().slice(0, cap);
}

/** 新建/更新角色时可传的字段（剧情导入会额外带上 origin/story/storyMode） */
export interface ChatCharacterInput {
  name?: string;
  avatar?: string;
  identity?: string;
  boundaries?: string;
  voice?: string;
  ttsVoice?: string;
  opening?: string;
  origin?: ChatCharacterOrigin;
  story?: StoryBinding;
  storyMode?: StoryMode;
  useCompanionMode?: boolean;
  /** 关系档（只认四档白名单；非法值一律忽略，见 create/update） */
  relation?: RelationKind;
}

/**
 * 归一化剧情摘要（落盘前兜底）：只认字符串、逐字段截断、丢掉空项。
 * 调用方（storyBridge）已经算过一遍，这里是**服务端最后一道**——防止任何客户端把超大/畸形结构写进库。
 */
function normalizeDigest(d?: StoryDigest): StoryDigest | undefined {
  if (!d || typeof d !== 'object') return undefined;
  const keyEvents = (Array.isArray(d.keyEvents) ? d.keyEvents : [])
    .map((e) => ({ text: clamp(String((e as { text?: unknown })?.text ?? ''), 120), date: String((e as { date?: unknown })?.date ?? '').trim().slice(0, 10) }))
    .filter((e) => e.text)
    .slice(0, 60);
  const openThreads = (Array.isArray(d.openThreads) ? d.openThreads : [])
    .map((t) => clamp(String(t ?? ''), MAX_THREAD))
    .filter(Boolean)
    .slice(0, 12);
  const summary = clamp(String(d.summary ?? ''), MAX_SUMMARY);
  if (!summary && !keyEvents.length && !openThreads.length) return undefined;
  const voiceTraits = clamp(String(d.voiceTraits ?? ''), 600);
  return {
    summary,
    keyEvents,
    openThreads,
    ...(voiceTraits ? { voiceTraits } : {}),
    msgCount: Number.isFinite(d.msgCount) ? Math.max(0, Math.floor(d.msgCount)) : 0,
    at: Number.isFinite(d.at) ? Math.floor(d.at) : Date.now(),
  };
}

/** 归一化剧情绑定（同 normalizeDigest 的用意） */
function normalizeStory(s: StoryBinding): StoryBinding | undefined {
  const scenarioId = clamp(String(s?.scenarioId ?? ''), 120);
  if (!scenarioId) return undefined;
  return {
    scenarioId,
    scenarioTitle: clamp(String(s?.scenarioTitle ?? ''), 200),
    kind: s?.kind === 'custom' ? 'custom' : 'official',
    aiName: clamp(String(s?.aiName ?? ''), 60),
    userName: clamp(String(s?.userName ?? ''), 60),
    importedAt: Number.isFinite(s?.importedAt) ? Math.floor(s.importedAt) : Date.now(),
    syncedMsgCount: Number.isFinite(s?.syncedMsgCount) ? Math.max(0, Math.floor(s.syncedMsgCount)) : 0,
    ...(Number.isFinite(s?.syncedAt) ? { syncedAt: Math.floor(s.syncedAt as number) } : {}),
    ...(s?.persona && typeof s.persona === 'object'
      ? {
        persona: {
          identity: clamp(String(s.persona.identity ?? ''), MAX_PERSONA_FIELD),
          voice: clamp(String(s.persona.voice ?? ''), MAX_PERSONA_FIELD),
          boundaries: clamp(String(s.persona.boundaries ?? '')),
          opening: clamp(String(s.persona.opening ?? '')),
          avatar: clamp(String(s.persona.avatar ?? ''), MAX_AVATAR),
        },
      }
      : {}),
    ...(normalizeDigest(s?.digest) ? { digest: normalizeDigest(s?.digest)! } : {}),
  };
}

class ChatCharacterStore {
  private items: ChatCharacter[] = [];

  constructor() { this.loadFromDisk(); }

  private loadFromDisk(): void {
    const parsed = readJson<ChatCharacter[]>(FILE, []);
    if (Array.isArray(parsed)) this.items = parsed.filter((r) => r && r.id && !r.isDefault);
  }

  private saveToDisk(): void {
    try {
      writeJson(FILE, this.items.filter((r) => r && !r.isDefault));
    } catch { /* 忽略 */ }
  }

  /** 内置小愈 + 该用户全部自定义角色（小愈固定第一位，其余按最近更新倒序） */
  listForUser(userId: string): ChatCharacter[] {
    const custom = this.items
      .filter((i) => i.userId === userId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return [XIAOYU_CHARACTER, ...custom];
  }

  /** 取某个角色：内置小愈或本人自建角色；找不到返回 undefined */
  get(userId: string, id: string): ChatCharacter | undefined {
    if (id === 'xiaoyu') return XIAOYU_CHARACTER;
    return this.items.find((i) => i.userId === userId && i.id === id);
  }

  /** 校验名字唯一（同用户内），避免混淆；小愈名字保留 */
  nameExists(userId: string, name: string, excludeId?: string): boolean {
    const n = name.trim().toLowerCase();
    return this.items.some((i) => i.userId === userId && i.id !== excludeId && i.name.trim().toLowerCase() === n);
  }

  create(userId: string, data: ChatCharacterInput): ChatCharacter {
    const now = Date.now();
    const story = data.story ? normalizeStory(data.story) : undefined;
    const rec: ChatCharacter = {
      id: 'cc_' + now.toString(36) + Math.random().toString(36).slice(2, 8),
      userId,
      name: clamp(data.name ?? '') || '新角色',
      avatar: clamp(data.avatar ?? '', MAX_AVATAR),
      identity: clamp(data.identity ?? '', MAX_PERSONA_FIELD),
      boundaries: clamp(data.boundaries ?? ''),
      voice: clamp(data.voice ?? '', MAX_PERSONA_FIELD),
      ttsVoice: clamp(data.ttsVoice ?? '', 1000),
      opening: clamp(data.opening ?? ''),
      isDefault: false,
      createdAt: now,
      updatedAt: now,
      // 老数据没有这些字段 → 一律保持"没写"（不要用默认值伪造来源，见 viaUnlimited 的同口径说明）
      ...(data.origin === 'story' ? { origin: 'story' as const } : {}),
      ...(story ? { story } : {}),
      ...(data.storyMode === 'in' || data.storyMode === 'out' ? { storyMode: data.storyMode } : {}),
      ...(typeof data.useCompanionMode === 'boolean' ? { useCompanionMode: data.useCompanionMode } : {}),
      // 关系档：白名单校验（客户端可能传任意字符串）；不传/非法 → 不写字段，读取侧回落 friend
      ...(isRelationKind(data.relation) ? { relation: data.relation } : {}),
    };
    this.items.push(rec);
    this.saveToDisk();
    return rec;
  }

  /**
   * 按剧情出处查角色（幂等导入的语义键）：同一用户 + 同一剧本只允许存在一个剧情角色。
   * 重复导入走**更新**，绝不产生第二个"沈重"（昵称查重 `nameExists` 会被用户改名绕过，故另立语义键）。
   */
  findByScenario(userId: string, scenarioId: string): ChatCharacter | undefined {
    const sid = String(scenarioId || '').trim();
    if (!sid) return undefined;
    return this.items.find((i) => i.userId === userId && i.origin === 'story' && i.story?.scenarioId === sid);
  }

  /**
   * 写入剧情摘要（导入时一次性 / 增量同步）+ 前移同步游标。
   * 只在提炼成功后调用：`syncedMsgCount` 落后于实际进度是可恢复的（下次重算），
   * 前移过头则那一段剧情永远进不了记忆 —— 所以宁慢勿快。
   */
  setStoryDigest(userId: string, id: string, digest: StoryDigest, syncedMsgCount: number): ChatCharacter | undefined {
    const rec = this.items.find((i) => i.userId === userId && i.id === id);
    if (!rec || !rec.story) return undefined;
    const nd = normalizeDigest(digest);
    if (nd) rec.story.digest = nd;
    rec.story.syncedMsgCount = Math.max(0, Math.floor(syncedMsgCount));
    rec.story.syncedAt = Date.now();
    rec.updatedAt = Date.now();
    this.saveToDisk();
    return rec;
  }

  update(userId: string, id: string, data: ChatCharacterInput): ChatCharacter | undefined {
    const rec = this.items.find((i) => i.userId === userId && i.id === id);
    if (!rec) return undefined;
    if (typeof data.name === 'string') rec.name = clamp(data.name) || rec.name;
    if (typeof data.avatar === 'string') rec.avatar = clamp(data.avatar, MAX_AVATAR);
    if (typeof data.identity === 'string') rec.identity = clamp(data.identity, MAX_PERSONA_FIELD);
    if (typeof data.boundaries === 'string') rec.boundaries = clamp(data.boundaries);
    if (typeof data.voice === 'string') rec.voice = clamp(data.voice, MAX_PERSONA_FIELD);
    if (typeof data.ttsVoice === 'string') rec.ttsVoice = clamp(data.ttsVoice, 1000);
    if (typeof data.opening === 'string') rec.opening = clamp(data.opening);
    // 双态（入戏/出戏）：只认这两个取值；剧情以外没有该语义，不做任何事
    if (data.storyMode === 'in' || data.storyMode === 'out') rec.storyMode = data.storyMode;
    // 关系档：同样只认白名单四档。注意这里**不做**"清空"——传 null/'' 视为"没改"，
    // 因为前端偏好面板是字段级提交，把"没选中"当成"改回默认"会让用户手滑丢设置。
    if (isRelationKind(data.relation)) rec.relation = data.relation;
    // 剧情绑定：只在原本就是剧情角色时才更新（不能让一次 PUT 把自建角色变成剧情角色，反之亦然）
    if (data.story && rec.origin === 'story') {
      const ns = normalizeStory(data.story);
      if (ns) rec.story = ns;
    }
    rec.updatedAt = Date.now();
    this.saveToDisk();
    return rec;
  }

  delete(userId: string, id: string): boolean {
    if (id === 'xiaoyu') return false; // 内置小愈不可删除
    const before = this.items.length;
    this.items = this.items.filter((i) => !(i.userId === userId && i.id === id));
    if (this.items.length !== before) { this.saveToDisk(); return true; }
    return false;
  }

  /** 删除某用户的全部自定义角色（账户注销时） */
  deleteByUser(userId: string): void {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.userId !== userId);
    if (this.items.length !== before) this.saveToDisk();
  }
}

export const chatCharacterStore = new ChatCharacterStore();
export default chatCharacterStore;
