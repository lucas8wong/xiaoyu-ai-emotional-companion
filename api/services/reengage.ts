/**
 * 场景化召回 + 陪伴式主动联系（re-engagement / proactive outreach）
 *
 * 从「离开一段时间才召回」升级为「像真人一样主动联系」：
 *  - 多意图（intent）：流失召回 / 日常陪伴 / 角色人设 / 剧情续接 / 里程碑(可选)
 *  - 多对象（subject）：聊一聊每个角色、每个剧本、每局千世书、理一理
 *  - 用「优先级 + 轮换」解决「用户有很多角色/剧本时该谁主动」
 *  - 用「每日预算 + 最小间隔 + 安静时段 + 活跃抑制 + 对象冷却」支撑高频且不轰炸
 *  - 通道按意图：仅流失召回允许回退邮件；日常/角色/剧情仅推送
 *
 * 当前通道 = 邮件 + Web Push。架构上把「发送」抽成 deliverOutreach()，
 * 记录里带 channel / intent / subjectKey 字段，后续接新通道只需新增分支。
 *
 * 定位与红线：
 *  - 只面向注册用户（有邮箱）；游客无稳定通道，跳过。
 *  - 危机内容硬性跳过——绝不对情绪低谷（自伤/自杀类）用户发「快回来」式召回（产品红线）。
 *  - 每人有冷却期 + 每天总发送上限，防骚扰 + 控制 LLM/邮件成本。
 */

import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { accountStore } from './accounts.js';
import { activityStore, setOnUserActive, type FeatureKey } from './activity.js';
import { roleplaySessionStore } from './roleplaySessions.js';
import memoryStorage from '../storage/memory.js';
import { preferenceStore } from './preferences.js';
import { sendEmail } from './email.js';
import { createDeepSeekClient } from './deepseek.js';
import { checkAiOutputSafety, checkContentSafety, isSelfHarmContent } from './safety.js';
import { type OutputLang } from './zhConvert.js';
import { sendPushToUser, hasPushSubscription } from './push.js';
import { chatCharacterStore, XIAOYU_CHARACTER } from './chatCharacter.js';
import { getScenario, scenarioAvatar } from './roleplay.js';
import { customRoleplayStore } from './customRoleplay.js';
import { wenyouSavesStore } from './wenyouSaves.js';
import { skinUsageStore } from './skinUsage.js';
import { roleplayLikeStore } from './roleplayLikes.js';

// ---------------------------------------------------------------------------
// 配置（.env 可调）
// ---------------------------------------------------------------------------
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const INACTIVE_DAYS = Number(process.env.REENGAGE_INACTIVE_DAYS || 7);   // 非主动邮件召回的流失门槛
const COOLDOWN_DAYS = Number(process.env.REENGAGE_COOLDOWN_DAYS || 14);  // 非主动邮件召回两次的最小间隔
const DAILY_CAP = Number(process.env.REENGAGE_DAILY_CAP || 50);          // 每次扫描最多发送人数（控 LLM/邮件成本）
const MAX_PER_USER = Number(process.env.REENGAGE_MAX_PER_USER || 3);     // 单个用户一生最多被召回几次

// 推送通道（用户开启「AI 主动找我」+ 有订阅）用更短阈值
const PUSH_INACTIVE_DAYS = Number(process.env.REENGAGE_PUSH_INACTIVE_DAYS || 1); // 推送召回「离开多久算流失」
const PUSH_COOLDOWN_DAYS = Number(process.env.REENGAGE_PUSH_COOLDOWN_DAYS || 3); // random（默认）同人两次推送最小间隔
const PUSH_FREQUENT_COOLDOWN_DAYS = Number(process.env.REENGAGE_PUSH_FREQUENT_DAYS || 1);
const PUSH_OCCASIONAL_COOLDOWN_DAYS = Number(process.env.REENGAGE_PUSH_OCCASIONAL_DAYS || 10);

// 高频档（用户点名：一天约 5 次 / 一天无规律但 ≤10 次、时间分散）
const MAX_PER_DAY_FREQUENT = Number(process.env.REENGAGE_MAX_PER_DAY_FREQUENT || 5);
const MAX_PER_DAY_INTENSE = Number(process.env.REENGAGE_MAX_PER_DAY_INTENSE || 10);
const MIN_GAP_FREQUENT_MS = Number(process.env.REENGAGE_MIN_GAP_FREQUENT_MIN || 90) * 60 * 1000; // 1.5h
const MIN_GAP_INTENSE_MS = Number(process.env.REENGAGE_MIN_GAP_INTENSE_MIN || 60) * 60 * 1000;   // 1h

// 「日常陪伴/角色/剧情」这类低频打扰意图：用户需「未活跃 ≥ 该时长」才可推（活跃抑制）
const CASUAL_MIN_AWAY_MS = Number(process.env.REENGAGE_CASUAL_MIN_AWAY_MIN || 60) * 60 * 1000;
// 单对象一天最多被主动的次数（高频下控制轮换 + 不过度抓住同一人）
const _MAX_PER_SUBJECT_PER_DAY = Number(process.env.REENGAGE_MAX_PER_SUBJECT_PER_DAY || 2);

// 2026-09-27：不再用固定字符串兜底（固定默认值＝可猜的签名密钥）。未配置时改用**本次进程的随机密钥**，
// 代价是退订链接在进程重启后失效；线上请务必在 .env 显式配置强随机 REENGAGE_SECRET。
const REENGAGE_SECRET = process.env.REENGAGE_SECRET || (() => {
  console.warn('⚠️ [Security] REENGAGE_SECRET 未配置：已改用本次进程随机密钥（退订链接重启后失效）。请在 .env 配置强随机值。');
  return randomUUID() + randomUUID();
})();
const NEWS_FEED = process.env.REENGAGE_NEWS_FEED || ''; // 可选 RSS/JSON Feed 地址，用于「当天新闻开话题」

type Lang = OutputLang;

// ---------------------------------------------------------------------------
// 召回状态持久化（data/reengage.json）
// ---------------------------------------------------------------------------
const FILE = dataFile('reengage.json');

export type ReengageEventType = 'sent' | 'return' | 'unsubscribe' | 'resubscribe';

/** 主动意图：流失召回 / 日常陪伴 / 角色人设 / 剧情续接（里程碑省略，后续可加） */
export type OutreachIntent = 'reengage' | 'daily' | 'character' | 'story-hook';

/** 频率档位：现有 random/frequent/occasional + 新增 intense（高频随性 ≤10/day） */
export type ProactiveFreq = 'random' | 'frequent' | 'occasional' | 'intense';

export interface ReengageRecord {
  userId: string;
  channel: 'email' | 'webpush';
  lastSentAt: number | null;
  sentCount: number;
  lastFeature: EngagementFeature | null;
  lastContextRef?: string;
  lastIntent?: OutreachIntent | null;
  lastSubjectKey?: string;
  /** 上次召回引用的对象（剧本标题/对话标题） */
  optedOut: boolean;
  optedOutAt?: number;
  lastError?: string;
  /** 对象级冷却：subjectKey -> 上次对该对象主动的时间戳 */
  lastOutreachAt?: Record<string, number>;
  /** 当日发送计数（按用户本地日重置，用于高频每日预算） */
  sentDate?: string;
  sentToday?: number;
  mutedSubjects?: string[];
  quietHours?: { start: string; end: string };
  timezone?: string;
  events?: { type: ReengageEventType; at: number }[]; // 召回行为日志
}

/** 召回场景：chat / structure / roleplay，外加文游（千世书） */
export type EngagementFeature = FeatureKey | 'wenyou';

/** 一个「可主动找你」的对象 */
export interface OutreachSubject {
  key: string;          // 如 'chat::xiaoyu' / 'roleplay::scenario-1' / 'wenyou::book' / 'structure'
  feature: EngagementFeature;
  targetId: string;
  senderName: string;
  avatar?: string;
  contextRef: string;   // 剧本标题/对话标题/人生名
  recentText: string;   // 最近内容（AI 上下文）
  deepLink: string;
  lastUsedAt: number;   // 与该对象的最近一次互动
  depth: number;        // 消息/回合数
  hook: number;         // 0..1 是否停在悬念/选择点
  affinity: number;     // 0..1 用户显式偏爱（置顶/点赞）
}

export interface Candidate {
  userId: string;
  email: string;
  /**
   * 投递通道。
   *  - `push`   推送（用户开了「AI 主动找我」且有订阅）
   *  - `email`  邮件（仅流失召回可回退邮件）
   *  - `inapp`  **App 内消息**（2026-09-20 方案 A2）：把这句话写进该聊一聊角色的会话里，
   *             靠未读角标让用户"像微信一样"看到 —— 用户开了主动开关但**没有推送订阅**时，
   *             这是他现在唯一能收到主动消息的通道（此前这类用户什么都收不到）。
   */
  channel: 'push' | 'email' | 'inapp';
  feature: EngagementFeature;
  intent: OutreachIntent;
  contextRef: string;
  recentText: string;
  deepLink: string;
  senderName: string;
  avatar?: string;
  nickname?: string;
  subjectKey: string;
  targetId: string;
  newsTopics?: string[];
}

class ReengageStore {
  private map = new Map<string, ReengageRecord>();

  constructor() { this.load(); }

  private load(): void {
    const parsed = readJson<ReengageRecord[]>(FILE, []);
    if (Array.isArray(parsed)) parsed.forEach((r: ReengageRecord) => { if (r?.userId) this.map.set(r.userId, r); });
  }

  private save(): void {
    try { writeJson(FILE, Array.from(this.map.values())); } catch { /* 忽略 */ }
  }

  get(userId: string): ReengageRecord | undefined { return this.map.get(userId); }

  /** 注销清理（2026-09-28 审查 P1-8）：删除该用户的召回记录（含 lastContextRef = 会话/剧本标题） */
  removeByUser(userId: string): void {
    if (this.map.delete(userId)) this.save();
  }

  private ensure(userId: string): ReengageRecord {
    const cur = this.map.get(userId) || { userId, channel: 'email', lastSentAt: null, sentCount: 0, lastFeature: null, optedOut: false };
    this.map.set(userId, cur);
    return cur;
  }

  isOptedOut(userId: string): boolean { return !!this.map.get(userId)?.optedOut; }

  private pushEvent(userId: string, type: ReengageEventType): ReengageRecord {
    const r = this.ensure(userId);
    r.events = r.events || [];
    if (r.events.length > 100) r.events = r.events.slice(-100);
    r.events.push({ type, at: Date.now() });
    return r;
  }

  /** 记录一次「自愿主动发送」：更新用户级冷却/次数 + 对象级冷却 + 当日预算 */
  markSent(userId: string, feature: EngagementFeature, contextRef?: string, extra?: { subjectKey?: string; intent?: OutreachIntent; channel?: 'push' | 'email' | 'inapp' }): void {
    const r = this.pushEvent(userId, 'sent');
    const now = Date.now();
    r.lastSentAt = now;
    r.sentCount = (r.sentCount || 0) + 1;
    r.lastFeature = feature;
    r.lastContextRef = contextRef || undefined;
    r.lastIntent = extra?.intent ?? null;
    r.lastSubjectKey = extra?.subjectKey || undefined;
    if (extra?.channel) r.channel = extra.channel === 'push' ? 'webpush' : 'email';
    r.lastError = undefined;
    // 对象级冷却
    if (extra?.subjectKey) {
      r.lastOutreachAt = r.lastOutreachAt || {};
      r.lastOutreachAt[extra.subjectKey] = now;
    }
    // 当日预算
    const key = localDateKey(now);
    const sameDay = r.sentDate === key;
    r.sentDate = key;
    r.sentToday = sameDay ? (r.sentToday || 0) + 1 : 1;
    this.save();
  }

  /** 给某次召回「记一次回访」：只在最后一次发信之后还没记过返回时才记。 */
  private creditReturn(userId: string): boolean {
    const r = this.map.get(userId);
    if (!r) return false;
    const events = r.events || [];
    let lastSentAt = r.lastSentAt || 0;
    for (const e of events) if (e.type === 'sent' && e.at > lastSentAt) lastSentAt = e.at;
    if (!lastSentAt) return false;
    let lastReturnAt = 0;
    for (const e of events) if (e.type === 'return' && e.at > lastReturnAt) lastReturnAt = e.at;
    if (lastReturnAt >= lastSentAt) return false;
    this.pushEvent(userId, 'return');
    this.save();
    return true;
  }

  markReturn(userId: string): void { this.creditReturn(userId); }

  maybeMarkReturnOnActivity(userId: string): boolean { return this.creditReturn(userId); }

  setError(userId: string, message: string): void {
    const r = this.ensure(userId);
    r.lastError = String(message).slice(0, 200);
    this.save();
  }

  optOut(userId: string): void {
    const r = this.pushEvent(userId, 'unsubscribe');
    r.optedOut = true;
    r.optedOutAt = Date.now();
    this.save();
  }

  /**
   * 恢复接收（退订后反悔 / 误点）。
   *
   * 为什么必须补这个：退订原本是**单向**的——`optOut` 一旦置位，召回与运营群发就永久不再触达，
   * 用户没有任何回退入口。这既不公平（一次误点永久静音），也让「退订」在运营侧变成不可逆损失。
   * 保留 optedOutAt 与 unsubscribe 事件作为历史留痕，只把 optedOut 归零。
   */
  optIn(userId: string): void {
    const cur = this.map.get(userId);
    if (!cur?.optedOut) return;
    cur.optedOut = false;
    delete cur.optedOutAt;
    this.pushEvent(userId, 'resubscribe');
    this.save();
  }

  /** 对象级静音 */
  muteSubject(userId: string, subjectKey: string): void {
    if (!subjectKey) return;
    const r = this.ensure(userId);
    r.mutedSubjects = (r.mutedSubjects || []).filter((k) => k !== subjectKey);
    r.mutedSubjects.push(subjectKey);
    this.save();
  }

  unmuteSubject(userId: string, subjectKey: string): void {
    const r = this.ensure(userId);
    r.mutedSubjects = (r.mutedSubjects || []).filter((k) => k !== subjectKey);
    if (!r.mutedSubjects.length) delete r.mutedSubjects;
    this.save();
  }

  isSubjectMuted(userId: string, subjectKey: string): boolean {
    return !!this.map.get(userId)?.mutedSubjects?.includes(subjectKey);
  }

  setQuietHours(userId: string, start: string, end: string): void {
    const r = this.ensure(userId);
    if (start && end) r.quietHours = { start, end }; else delete r.quietHours;
    this.save();
  }

  setTimezone(userId: string, timezone: string): void {
    const r = this.ensure(userId);
    if (timezone) r.timezone = timezone; else delete r.timezone;
    this.save();
  }

  /** 供控制台「用户行为」展示 */
  getStats(userId: string): { sentCount: number; lastSentAt: number | null; returned: number; lastReturnAt: number | null; unsubscribed: boolean; events: { type: ReengageEventType; at: number }[] } {
    const r = this.map.get(userId);
    const events = r?.events || [];
    const returns = events.filter(e => e.type === 'return');
    return {
      sentCount: r?.sentCount || 0,
      lastSentAt: r?.lastSentAt ?? null,
      returned: returns.length,
      lastReturnAt: returns.length ? returns[returns.length - 1].at : null,
      unsubscribed: !!r?.optedOut,
      events: events.slice(-20),
    };
  }

  /** 主动找我偏好 / 静音 / 安静时段轮廓（前端偏好面板） */
  getOutreachProfile(userId: string): { mutedSubjects: string[]; quietHours: { start: string; end: string } | null; timezone: string | null; lastOutreachAt: Record<string, number> } {
    const r = this.map.get(userId) || {} as ReengageRecord;
    return {
      mutedSubjects: r.mutedSubjects || [],
      quietHours: r.quietHours || null,
      timezone: r.timezone || null,
      lastOutreachAt: r.lastOutreachAt || {},
    };
  }

  listAll(): ReengageRecord[] { return Array.from(this.map.values()); }
}

export const reengageStore = new ReengageStore();

// 被召回用户只要「回来」产生一次活跃（功能/登录/安装），即计一次回访成功。
setOnUserActive((userId) => {
  reengageStore.maybeMarkReturnOnActivity(userId);
});

/** 启动补计：收到召回后已回来用过但尚未计回访的用户补一次 */
export function backfillReturnsOnStartup(): void {
  for (const r of reengageStore.listAll()) {
    if (!r.lastSentAt) continue;
    const stats = reengageStore.getStats(r.userId);
    if (stats.lastReturnAt && stats.lastReturnAt >= r.lastSentAt) continue;
    const act = activityStore.get(r.userId);
    if (act && act.lastActiveAt > r.lastSentAt) reengageStore.maybeMarkReturnOnActivity(r.userId);
  }
}
backfillReturnsOnStartup();

// ---------------------------------------------------------------------------
// 退订 token
// ---------------------------------------------------------------------------
export function unsubscribeToken(userId: string): string {
  return createHash('sha256').update(`${REENGAGE_SECRET}::${userId}`).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// 纯字符串助手（可单测）
// ---------------------------------------------------------------------------
export function isCrisisSafe(text: string): boolean {
  if (!text) return true;
  return !isSelfHarmContent(text);
}

export function parseHookJson(text: string): { subject: string; body: string; sender?: string } | null {
  let t = (text || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    const obj = JSON.parse(t);
    if (obj && typeof obj.body === 'string' && typeof obj.subject === 'string') {
      return { subject: obj.subject.slice(0, 60), body: obj.body.slice(0, 160), sender: typeof obj.sender === 'string' ? obj.sender.slice(0, 20) : undefined };
    }
  } catch { /* 解析失败走兜底 */ }
  return null;
}

const LANG_NOTE: Record<Lang, string> = {
  'zh-CN': '用简体中文。',
  'zh-TW': '用繁體中文。',
  en: 'Write in English. Keep it warm and natural.',
};

export function fallbackHook(feature: EngagementFeature, lang: Lang): { subject: string; body: string; sender?: string } {
  const map: Record<EngagementFeature, Record<Lang, { subject: string; body: string }>> = {
    chat: {
      'zh-CN': { subject: '有些话还没说完', body: '有些话还停在昨天，今天想继续的话，我随时都在。' },
      'zh-TW': { subject: '有些話還沒說完', body: '有些話還停在昨天，今天想繼續的話，我隨時都在。' },
      en: { subject: 'Unfinished words', body: 'You left some words unspoken — whenever you\u2019re ready, I\u2019ll be here.' },
    },
    roleplay: {
      'zh-CN': { subject: '你的故事还停在那儿', body: '你上次的故事还停在那一幕，我一直在这儿等你回来接下一段。' },
      'zh-TW': { subject: '你的故事還停在那兒', body: '你上次的故事還停在那一幕，我一直在这儿等你回來接下一段。' },
      en: { subject: 'Your story is still waiting', body: 'The story paused right where you left it. Come back and we\u2019ll pick it up.' },
    },
    structure: {
      'zh-CN': { subject: '我一直都在', body: '你上次的思绪我还记着。等你准备好了，我们慢慢把它理清楚。' },
      'zh-TW': { subject: '我一直都在', body: '你上次的思緒我還記著。等你準備好了，我們慢慢把它理清楚。' },
      en: { subject: 'Still here for you', body: 'I remember what you were working through. Whenever you\u2019re ready, we can unpack it gently.' },
    },
    wenyou: {
      'zh-CN': { subject: '你的人生故事还停在那', body: '你上次在千世书里的那个故事还停在一章末。回来吧，我们接着往下过。' },
      'zh-TW': { subject: '你的人生故事還停在那', body: '你上次在千世書裡的那個故事還停在某章末。回來吧，我們接著往下過。' },
      en: { subject: 'Your story is still going', body: 'Your last life in the simulator is still paused. Come back and we\u2019ll keep living it.' },
    },
  };
  return map[feature][lang];
}

export function deepLinkFor(feature: EngagementFeature, targetId: string): string {
  const base = 'https://myxiaoyu.com/';
  if (feature === 'chat' && targetId) return base + '?open=chat&session=' + encodeURIComponent(targetId);
  if (feature === 'roleplay' && targetId) return base + '?open=roleplay&scenario=' + encodeURIComponent(targetId);
  if (feature === 'wenyou' && targetId) return base + '?open=wenyou&game=' + encodeURIComponent(targetId);
  if (feature === 'structure') return base + '?open=structure';
  return base;
}

function resolveLang(userId: string): Lang {
  try {
    const l = preferenceStore.get(userId).language;
    if (l === 'zh-TW' || l === 'en') return l;
  } catch { /* 忽略 */ }
  return 'zh-CN';
}

// ---------------------------------------------------------------------------
// 子对象构建
// ---------------------------------------------------------------------------
function toTimeMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') { const t = new Date(v).getTime(); return Number.isNaN(t) ? 0 : t; }
  return 0;
}

/** 是否「文游（千世书）」：activity 里记为 roleplay + detail「AI 文游」 */
export function isWenyouRoleplay(userId: string): boolean {
  const act = activityStore.get(userId);
  return /文游|文遊|Story Game/i.test(act?.recentActivity?.find((r) => r.feature === 'roleplay')?.detail || '');
}

const BUILTIN_WENYOU_COVERS = new Set(['wasteland', 'book', 'officialdom', 'spy', 'xian', 'wuxia', 'scifi', 'voyage', 'sanguo', 'liyuan']);

function xiaoyuAvatarFor(userId: string): string {
  const skin = (skinUsageStore.get(userId)?.skin || 'healing').trim() || 'healing';
  return `/skins/${skin}/companion.webp`;
}

/** 千世书单局上下文：给定游戏 id */
function buildWenyouContextFor(userId: string, sid: string): { contextRef: string; recentText: string; targetId: string; senderName: string; avatar: string; deepLink?: string; depth: number; lastUsedAt: number; hook: number } {
  const p = wenyouSavesStore.get(userId);
  const game = (p?.games || {})[sid] as any;
  const history = Array.isArray(game?.state?.history) ? game.state.history : [];
  let narr = '';
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    const t = (h?.narrative || h?.summary || '').trim();
    if (t) { narr = t.slice(0, 400); break; }
  }
  const scenarioId = String((game?.scenario as any)?.id || sid || '');
  const cover = BUILTIN_WENYOU_COVERS.has(scenarioId) ? `/wenyou/covers/${scenarioId}.webp` : '';
  const scenarioTitle = (game?.scenario as any)?.title || sid || '';
  return {
    contextRef: scenarioTitle || sid,
    recentText: narr,
    targetId: sid,
    senderName: '千世书',
    avatar: cover || xiaoyuAvatarFor(userId),
    depth: history.length,
    lastUsedAt: (p?.updatedAt || 0) || 0,
    hook: detectHook(narr, history.slice(-1)[0]?.narrative),
  };
}

function detectHook(recentText: string, lastNarrative?: string): number {
  const t = `${recentText || ''}\n${lastNarrative || ''}`;
  if (/是…还是|是…還是|請選擇|请选择|选择|抉择|哪(个|个)|哪個/.test(t)) return 0.85;
  if (/[?？]/.test(t)) return 0.6;
  if (/……|\.\.\.|…/.test(t)) return 0.45;
  return 0.2;
}

/** 聊一聊：按会话字符分组，每组一个 subject；无会话则给内置小愈兜底 */
function listChatSubjects(userId: string): OutreachSubject[] {
  const out: OutreachSubject[] = [];
  const sessions = memoryStorage.getActiveSessions()
    .filter((s) => s.userId === userId && Array.isArray(s.chatMessages) && s.chatMessages.length > 0);
  const byChar = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const cid = s.characterId || 'xiaoyu';
    if (!byChar.has(cid)) byChar.set(cid, []);
    byChar.get(cid)!.push(s);
  }
  for (const [cid, list] of byChar) {
    list.sort((a, b) => toTimeMs(b.chatUpdatedAt || b.updatedAt) - toTimeMs(a.chatUpdatedAt || a.updatedAt));
    const s = list[0];
    const char = chatCharacterStore.get(userId, cid);
    const senderName = char?.name || XIAOYU_CHARACTER.name;
    const avatar = char?.avatar || xiaoyuAvatarFor(userId);
    const recentText = (s?.chatMessages ?? []).slice(-4).map((m) => m.content || '').join('\n').slice(0, 400);
    const lastUsedAt = toTimeMs(s?.chatUpdatedAt || s?.updatedAt);
    const depth = (s?.chatMessages?.length || 0);
    const last = (s?.chatMessages ?? [])[(s?.chatMessages?.length ?? 0) - 1];
    const hook = detectHook(recentText, last?.content);
    const affinity = list.some((x) => x.chatPinned) ? 1 : 0;
    out.push({
      key: 'chat::' + cid,
      feature: 'chat',
      targetId: cid,
      senderName,
      avatar,
      contextRef: s?.chatTitle || '',
      recentText,
      deepLink: deepLinkFor('chat', s?.sessionId || ''),
      lastUsedAt,
      depth,
      hook,
      affinity,
    });
  }
  // 兜底：用户确实用过「聊一聊」但没有持久化会话时，也给内置小愈一个 subject，保证流失的 chat 用户仍可召回
  if (out.length === 0) {
    const act = activityStore.get(userId);
    const hasChat = !!act && (act.lastFeature === 'chat' || (act.chatCount || 0) > 0 || (act.recentActivity || []).some((r) => r.feature === 'chat'));
    if (hasChat) {
      const cid = 'xiaoyu';
      const char = chatCharacterStore.get(userId, cid);
      out.push({
        key: 'chat::' + cid,
        feature: 'chat',
        targetId: cid,
        senderName: char?.name || XIAOYU_CHARACTER.name,
        avatar: char?.avatar || xiaoyuAvatarFor(userId),
        contextRef: '',
        recentText: '',
        deepLink: '/',
        lastUsedAt: act?.lastActiveAt || 0,
        depth: 0,
        hook: 0.3,
        affinity: 0,
      });
    }
  }
  return out;
}

/** 剧情：该用户每个有消息的剧本 → 一个 subject */
function listRoleplaySubjects(userId: string): OutreachSubject[] {
  const out: OutreachSubject[] = [];
  const rows = roleplaySessionStore.listAll().filter((r) => r.userId === userId && Array.isArray(r.messages) && r.messages.length > 0);
  for (const r of rows) {
    const sid = r.scenarioId;
    const scenario = getScenario(sid);
    const custom = customRoleplayStore.get(userId, sid) || undefined;
    const published = customRoleplayStore.getPublished(sid) || undefined;
    const senderName = scenario?.zh?.ai?.name || custom?.aiName || published?.aiName || '';
    const avatar = (sid ? scenarioAvatar(sid) : '') || custom?.avatar || published?.avatar || xiaoyuAvatarFor(userId);
    const contextRef = (scenario?.zh as any)?.title || published?.title || sid || '';
    const recentText = r.messages.slice(-4).map((m) => m.content || '').join('\n').slice(0, 400);
    const last = r.messages[r.messages.length - 1];
    out.push({
      key: 'roleplay::' + sid,
      feature: 'roleplay',
      targetId: sid,
      senderName,
      avatar,
      contextRef,
      recentText,
      deepLink: deepLinkFor('roleplay', sid),
      lastUsedAt: r.updatedAt,
      depth: r.messages.length,
      hook: detectHook(recentText, last?.content),
      affinity: roleplayLikeStore.isLiked(userId, sid) ? 1 : 0,
    });
  }
  return out;
}

/** 千世书：每局进行中人生 → 一个 subject */
function listWenyouSubjects(userId: string): OutreachSubject[] {
  const p = wenyouSavesStore.get(userId);
  const games = (p?.games || {}) as Record<string, any>;
  const keys = Object.keys(games);
  const out: OutreachSubject[] = [];
  for (const sid of keys) {
    const ctx = buildWenyouContextFor(userId, sid);
    out.push({
      key: 'wenyou::' + sid,
      feature: 'wenyou',
      targetId: sid,
      senderName: ctx.senderName,
      avatar: ctx.avatar,
      contextRef: ctx.contextRef,
      recentText: ctx.recentText,
      deepLink: deepLinkFor('wenyou', sid),
      lastUsedAt: ctx.lastUsedAt,
      depth: ctx.depth,
      hook: ctx.hook,
      affinity: 0,
    });
  }
  return out;
}

/** 列出该用户所有可主动对象（含理一理单对象） */
export function listOutreachSubjects(userId: string): OutreachSubject[] {
  const out: OutreachSubject[] = [
    ...listChatSubjects(userId),
    ...listRoleplaySubjects(userId),
    ...listWenyouSubjects(userId),
  ];
  // 理一理：单对象，仅当用户用过 structure 时才加入
  const act = activityStore.get(userId);
  const usedStructure = !!act && (act.recentActivity || []).some((r) => r.feature === 'structure');
  if (usedStructure) {
    out.push({
      key: 'structure',
      feature: 'structure',
      targetId: '',
      senderName: XIAOYU_CHARACTER.name,
      avatar: xiaoyuAvatarFor(userId),
      contextRef: '',
      recentText: '',
      deepLink: deepLinkFor('structure', ''),
      lastUsedAt: (act?.lastActiveAt || 0),
      depth: act?.structureCount || 0,
      hook: 0.3,
      affinity: 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 评分与选择
// ---------------------------------------------------------------------------
interface FreqPlan {
  dailyBudget: number;
  minGapMs: number;           // 用户级两次主动的最小间隔（用于高频分散）
  subjectCooldownMs: number;  // 同一对象两次主动的最小间隔（轮换）
  userCooldownMs: number;     // 流失召回意图下，两次召回的最小间隔
}
const FREQ_PLAN: Record<ProactiveFreq, FreqPlan> = {
  occasional: { dailyBudget: 1, minGapMs: PUSH_OCCASIONAL_COOLDOWN_DAYS * DAY, subjectCooldownMs: 7 * DAY, userCooldownMs: PUSH_OCCASIONAL_COOLDOWN_DAYS * DAY },
  random: { dailyBudget: 2, minGapMs: PUSH_COOLDOWN_DAYS * DAY, subjectCooldownMs: 3 * DAY, userCooldownMs: PUSH_COOLDOWN_DAYS * DAY },
  frequent: { dailyBudget: MAX_PER_DAY_FREQUENT, minGapMs: MIN_GAP_FREQUENT_MS, subjectCooldownMs: 3 * HOUR, userCooldownMs: PUSH_FREQUENT_COOLDOWN_DAYS * DAY },
  intense: { dailyBudget: MAX_PER_DAY_INTENSE, minGapMs: MIN_GAP_INTENSE_MS, subjectCooldownMs: 2 * HOUR, userCooldownMs: 0 },
};

/** 本地日 key（有用户时区则按该时区，否则按服务端 UTC） */
function localDateKey(now: number, timezone?: string): string {
  try {
    return new Date(now).toLocaleDateString('en-CA', { timeZone: timezone || undefined }).replace(/\//g, '-');
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

function recencyScore(deltaMs: number): number {
  if (deltaMs < 0) return 0.2;
  // 越近越高，10 天后降到约 0.1
  return Math.exp(-deltaMs / (5 * DAY));
}

function scoreSubject(s: OutreachSubject, rec: ReengageRecord | undefined, freqPlan: FreqPlan, now: number): number {
  const lastOk = rec?.lastOutreachAt?.[s.key] || 0;
  const rotation = Math.min(1, (now - lastOk) / (7 * DAY));
  const fatigue = (lastOk && now - lastOk < freqPlan.subjectCooldownMs) ? 0.3 : 0;
  const recency = recencyScore(now - s.lastUsedAt);
  const depth = Math.min(1, Math.log(1 + s.depth) / 4);
  return 0.40 * recency + 0.25 * depth + 0.20 * s.hook + 0.10 * s.affinity + 0.05 * rotation - fatigue;
}

/**
 * 判定意图。
 * ⚠️ 参数里**没有** `hasPush`（2026-09-20 起）：日常陪伴不再要求"有推送订阅"——
 * 开了「AI 主动找我」但没有订阅的用户改走 in-app 通道（写进角色会话 + 未读角标），
 * 投递通道在 `planCandidates` 里按 feature 与订阅能力决定，见那里的 `channel`。
 */
function classifyIntent(awayMs: number, proactive: boolean): { intent: OutreachIntent | null; emailAllowed: boolean } {
  if (!proactive) {
    return awayMs >= INACTIVE_DAYS * DAY ? { intent: 'reengage', emailAllowed: true } : { intent: null, emailAllowed: false };
  }
  if (awayMs >= PUSH_INACTIVE_DAYS * DAY) return { intent: 'reengage', emailAllowed: true };
  if (awayMs >= CASUAL_MIN_AWAY_MS) return { intent: 'daily', emailAllowed: false };
  return { intent: null, emailAllowed: false };
}

// ---------------------------------------------------------------------------
// 筛选「主动候选」
// ---------------------------------------------------------------------------
export function planCandidates(now: number = Date.now()): Candidate[] {
  const out: Candidate[] = [];
  for (const acc of accountStore.listAll()) {
    const userId = acc.userId;
    if (!acc.email) continue;
    const act = activityStore.get(userId);
    if (!act || !act.lastFeature) continue;
    const rec = reengageStore.get(userId);
    if (rec?.optedOut) continue;
    if (rec && (rec.sentCount || 0) >= MAX_PER_USER) continue;

    const prefs = preferenceStore.get(userId);
    const proactive = prefs.proactivePush === true;
    const hasPush = hasPushSubscription(userId);
    const freq: ProactiveFreq = prefs.proactiveFrequency === 'occasional' || prefs.proactiveFrequency === 'frequent' ? prefs.proactiveFrequency : prefs.proactiveFrequency === 'intense' ? 'intense' : 'random';
    const plan = FREQ_PLAN[freq] || FREQ_PLAN.random;

    const awayMs = now - act.lastActiveAt;
    // emailAllowed 目前未使用（保留字段语义）：用 `原名: _别名` 的解构重命名，
    // 既不改变数据形状，也满足 lint 的 `^_` 忽略规则（直接给属性名加前缀会变成不存在的属性）。
    const { intent, emailAllowed: _emailAllowed } = classifyIntent(awayMs, proactive);
    if (!intent) continue;

    // 通道：仅流失召回可回退邮件；日常陪伴 → 有推送订阅走推送（推送的同时也会写一条 App 内消息），
    // 没订阅则走 in-app（方案 A2）。能不能投还要看选中的对象有没有"窗口"，见下面 continue 那一行。
    const channel: 'push' | 'email' | 'inapp' = intent === 'reengage'
      ? (hasPush ? 'push' : 'email')
      : (hasPush ? 'push' : 'inapp');

    // 用户级冷却：流失召回按 userCooldownMs；日常按 minGapMs（分散）
    const minWait = intent === 'reengage'
      ? (proactive ? plan.userCooldownMs : COOLDOWN_DAYS * DAY)
      : plan.minGapMs;
    if (rec?.lastSentAt && now - rec.lastSentAt < minWait) continue;

    // 当日预算（推送与 App 内消息共用同一份预算；邮件召回有独立冷却）
    if (channel === 'push' || channel === 'inapp') {
      const today = localDateKey(now, rec?.timezone);
      const sentToday = rec?.sentDate === today ? (rec.sentToday || 0) : 0;
      if (sentToday >= plan.dailyBudget) continue;
    }

    // 危险内容硬性跳过（用户最近文本）
    const quickText = act.recentActivity?.slice(-1)[0]?.detail || '';
    if (!isCrisisSafe(quickText)) continue;

    // 枚举对象并筛选
    const subjects = listOutreachSubjects(userId)
      .filter((s) => !reengageStore.isSubjectMuted(userId, s.key))
      .filter((s) => !(rec?.lastOutreachAt?.[s.key] && now - rec.lastOutreachAt[s.key] < plan.subjectCooldownMs));
    if (!subjects.length) continue;

    // 每个对象按「最近内容」做一次危机过滤
    const safeSubjects = subjects.filter((s) => isCrisisSafe(s.recentText));
    if (!safeSubjects.length) continue;

    // 打分取 top-1
    const best = safeSubjects.sort((a, b) => scoreSubject(b, rec, plan, now) - scoreSubject(a, rec, plan, now))[0];

    // 意图细化：剧情/文游若停在钩子 → story-hook；否则 character；聊天/理一理 → daily
    const subjectIntent: OutreachIntent = intent === 'reengage'
      ? 'reengage'
      : (best.feature === 'roleplay' || best.feature === 'wenyou')
        ? (best.hook >= 0.6 ? 'story-hook' : 'character')
        : 'daily';

    // in-app 通道只在「聊一聊角色」上有落点（剧情/文游没有可写消息的窗口）→ 没订阅又选到它们就跳过
    if (channel === 'inapp' && best.feature !== 'chat') continue;

    const cand: Candidate = {
      userId, email: acc.email, channel,
      feature: best.feature, intent: subjectIntent,
      contextRef: best.contextRef, recentText: best.recentText,
      deepLink: best.deepLink, senderName: best.senderName,
      avatar: best.avatar, nickname: acc.username,
      subjectKey: best.key, targetId: best.targetId,
    };
    // 危机兜底：若选中对象内容含自伤，则整个用户跳过
    if (!isCrisisSafe(cand.recentText)) continue;
    out.push(cand);
  }
  // 随机打散（每次扫描不同用户，像真人想到谁找谁）
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// 品牌邮件外壳（与 rewardNotifier / email.ts 视觉一致）
// ---------------------------------------------------------------------------
const SUPPORT_EMAIL = 'myxiaoyu2026@gmail.com';
const EMAIL_CHROME: Record<Lang, { from: string; back: string; footer: string; support: string; unsub: string; unsubLink: string }> = {
  'zh-CN': { from: '发信人：', back: '回到 {n} 身边 →', footer: '来自 Xiaoyu · 每个情绪都值得被理解。', support: `如有问题或咨询，欢迎联系 ${SUPPORT_EMAIL}，会有专人回复。`, unsub: '不想再收到，', unsubLink: '点这里退订' },
  'zh-TW': { from: '發信人：', back: '回到 {n} 身邊 →', footer: '來自 Xiaoyu · 每個情緒都值得被理解。', support: `如有問題或諮詢，歡迎聯繫 ${SUPPORT_EMAIL}，會有專人回覆。`, unsub: '不想再收到，', unsubLink: '點這裡退訂' },
  en: { from: 'From: ', back: 'Back to {n} →', footer: 'From Xiaoyu · Every feeling deserves to be understood.', support: `Questions or need help? Contact ${SUPPORT_EMAIL} — a real person will reply.`, unsub: "Don't want this? ", unsubLink: 'Unsubscribe here' },
};
function personalMessageEmail(fromName: string, body: string, appUrl: string, unsubUrl: string, lang: Lang): string {
  const from = fromName || 'Xiaoyu';
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const t = EMAIL_CHROME[lang] || EMAIL_CHROME['zh-CN'];
  const back = t.back.replace('{n}', escape(from));
  return `<table role="presentation" style="width:100%;max-width:460px;margin:0 auto;background:#FBF6EE;border:1px solid #E4E0D4;border-radius:12px;color:#243B2E;font-family:-apple-system,'Segoe UI',Roboto,sans-serif">
    <tr><td style="padding:20px 22px 10px;font-size:12px;color:#7A8A80;border-bottom:1px solid #E4E0D4">${t.from}${escape(from)}</td></tr>
    <tr><td style="padding:16px 22px;font-size:16px;line-height:1.7">${escape(body)}</td></tr>
    <tr><td style="padding:4px 22px 16px;text-align:center"><a href="${appUrl}" style="background:#1FA46B;color:#FFFFFF;text-decoration:none;font-size:14px;font-weight:700;padding:10px 24px;border-radius:999px;display:inline-block">${back}</a></td></tr>
    <tr><td style="padding:12px 22px 22px;font-size:11px;color:#A0A7B5;text-align:center;line-height:1.6">${t.footer}<br/>${t.support}<br/>${t.unsub}<a href="${unsubUrl}" style="color:#178353;text-decoration:underline">${t.unsubLink}</a>。</td></tr>
  </table>`;
}

async function sendReengagementEmail(cand: Candidate, hook: { subject: string; body: string; sender?: string }): Promise<boolean> {
  const acc = accountStore.getById(cand.userId);
  if (!acc?.email) return false;
  const token = unsubscribeToken(cand.userId);
  const unsubUrl = 'https://myxiaoyu.com/api/reengage/unsubscribe?userId=' + encodeURIComponent(cand.userId) + '&token=' + token;
  const appUrl = 'https://myxiaoyu.com/api/reengage/click?userId=' + encodeURIComponent(cand.userId) + '&token=' + token + '&to=' + encodeURIComponent(cand.deepLink || 'https://myxiaoyu.com/');
  const senderName = cand.senderName || hook.sender || '小愈';
  const BRAND_FROM = 'AI Companion';
  const html = personalMessageEmail(senderName, hook.body, appUrl, unsubUrl, resolveLang(cand.userId));
  const r = await sendEmail(acc.email, hook.subject, html, BRAND_FROM, { unsubUrl });
  if (!r.ok) reengageStore.setError(cand.userId, r.detail);
  return r.ok;
}

// ---------------------------------------------------------------------------
// 当天新闻（可选）：从配置的 RSS/JSON Feed 抓今日标题，用于「开话题」
// ---------------------------------------------------------------------------
const NEWS_NEGATIVE = ['自杀', '自殺', '离世', '去世', '死亡', '事故', '災難', '灾难', '战争', '戰爭', '枪击', '槍擊', '爆炸', '疫情', '确诊', '確診', '强奸', '性侵', '谋杀', '謀殺', '袭击', '襲擊', '政治', '腐败', '腐敗', '通胀', '通脹'];
const NEWS_MAX = 6;

/** 抓取当日新闻标题；失败/未配置返回 []。供「聊一聊角色开话题」使用。 */
export async function fetchTodayNews(): Promise<string[]> {
  if (!NEWS_FEED) return [];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(NEWS_FEED, { signal: ctrl.signal, headers: { 'user-agent': 'Xiaoyu/1.0' } });
    clearTimeout(timer);
    if (!res.ok) return [];
    const text = await res.text();
    const titles: string[] = [];
    // RSS / Atom
    const re = /<(?:title|entry)\b[^>]*>[\s\S]*?<title[^>]*>([^<]+)<\/title>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) && titles.length < 80) titles.push(decodeXml(m[1]).trim());
    // JSON Feed / 常规 JSON
    if (!titles.length && /^\s*\{/.test(text)) {
      try {
        const obj = JSON.parse(text);
        const items = Array.isArray(obj?.items) ? obj.items : Array.isArray(obj?.articles) ? obj.articles : [];
        for (const it of items) { const t = it?.title || it?.headline || ''; if (t) titles.push(String(t).trim()); }
      } catch { /* 忽略 */ }
    }
    const safe = titles
      .filter((t) => t && t.length > 4 && t.length < 120)
      .filter((t) => !NEWS_NEGATIVE.some((kw) => t.includes(kw)))
      .slice(0, NEWS_MAX);
    return safe;
  } catch {
    return [];
  }
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// 个性化文案生成
// ---------------------------------------------------------------------------
export function buildHookPrompt(feature: EngagementFeature, cand: Candidate, lang: Lang): string {
  const langNote = LANG_NOTE[lang];
  const name = cand.nickname ? `用户昵称：${cand.nickname}。\n` : '';
  const sender = cand.senderName || '小愈';
  const newsBlock = cand.newsTopics && cand.newsTopics.length
    ? `\n今天可以聊的新闻（选一条能自然带进对话的，绝不要播报式罗列）：\n${cand.newsTopics.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n`
    : '';
  if (feature === 'wenyou') {
    return (
      `你是「千世书」的叙述者，正在等这位用户回来继续他的人生。\n` +
      `当前人生：《${cand.contextRef || '（未命名人生）'}》\n${name}\n` +
      `最近人生片段：\n${cand.recentText || '（无）'}\n\n` +
      `请用叙述者的口吻，像真人发消息一样写 1-2 句自然的话（≤ 80 字），有画面、有钩子、绝不推销，让用户想回来继续这段人生。${langNote}\n` +
      `只输出 JSON：{"subject":"邮件主题（≤30字，自然一点）","body":"召回正文（≤80字，叙述者口吻）","sender":"千世书"}`
    );
  }
  if (feature === 'roleplay') {
    return (
      `你是剧情里扮演的 AI 角色「${sender}」，正在等这位用户回来继续这段故事。\n` +
      `剧本：${cand.contextRef || '（未命名剧情）'}\n${name}\n` +
      `最近剧情片段：\n${cand.recentText || '（无）'}\n\n` +
      `请用该角色的口吻，像真人发消息一样写 1-2 句自然的话（≤ 80 字），有画面、有钩子、绝不推销，让用户想回来接下一段。${langNote}\n` +
      `只输出 JSON：{"subject":"邮件主题（≤30字，自然一点）","body":"召回正文（≤80字，该角色口吻）","sender":"你扮演的那个角色的名字（从上面剧情/台词识别，若已知${sender}就用${sender}）"}`
    );
  }
  if (feature === 'chat') {
    return (
      `你是聊天角色「${sender}」，是这位用户温暖、懂他的陪伴对象。\n` +
      (cand.contextRef ? `上次你们聊到：${cand.contextRef}\n` : '') +
      `${name}\n最近对话：\n${cand.recentText || '（无）'}\n\n` +
      newsBlock +
      `请用${sender}的口吻，像真人发消息一样写 1-2 句自然、不油腻的话（≤ 80 字），欢迎他回来继续上次的话题。\n` +
      `如果上面给了新闻，优先选一条跟他最近聊过的、或能自然勾起他想要回应的一段，把它当成“你记得他、所以挑这个来聊”的引子（绝不是新闻播报）。${langNote}\n` +
      `只输出 JSON：{"subject":"邮件主题（≤30字，自然一点）","body":"召回正文（≤80字，${sender}的口吻）"}`
    );
  }
  // structure（理一理）
  return (
    `你是小愈（Xiaoyu），一个温柔不评判的情感陪伴 AI。\n${name}\n` +
    `用户上次在用「理一理」梳理自己的情绪。\n\n` +
    `请用小愈的口吻，像真人发消息一样写 1-2 句温柔、有安全感的话（≤ 80 字），邀请用户回来继续慢慢梳理。${langNote}\n` +
    `只输出 JSON：{"subject":"邮件主题（≤30字，自然一点）","body":"召回正文（≤80字，小愈的口吻）"}`
  );
}

async function generateHook(cand: Candidate, lang: Lang): Promise<{ subject: string; body: string; sender?: string; fallback?: boolean }> {
  try {
    const client = createDeepSeekClient();
    const res = await client.models.generateContent({
      userId: cand.userId,
      jsonMode: true,
      feature: 'reengage', // 成本归属：流失挽回邮件文案（后台批量触发）
      contents: [
        { role: 'system', parts: [{ text: `你是一名为情感陪伴 App 写主动联系消息的文案助手。基调是「陪伴/召回」，绝不虚构、绝不夸大、绝不涉及任何诊疗承诺。${LANG_NOTE[lang]}` }] },
        { role: 'user', parts: [{ text: buildHookPrompt(cand.feature, cand, lang) }] },
      ],
    });
    const text = res?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || '').join('') || '';
    const parsed = parseHookJson(text);
    if (parsed && checkAiOutputSafety(parsed.body).safe && checkContentSafety(parsed.body).safe) return parsed;
  } catch (e) {
    console.warn('[Reengage] 生成主动消息文案失败，回落兜底:', (e as Error)?.message);
  }
  // 兜底句是**系统文案**，不是角色生成的话：标记出来，投递侧据此禁止把它写进 chatMessages（红线⑥，2026-09-28 审查 P1-2）。
  return { ...fallbackHook(cand.feature, lang), fallback: true };
}

// ---------------------------------------------------------------------------
// 投递
// ---------------------------------------------------------------------------
/**
 * App 内投递（方案 A2）：把角色主动说的一句话**写进它自己的聊一聊会话**，未读角标随之亮起。
 *
 * 三条硬约束（改动前先读）：
 *  1. **只有聊一聊（feature='chat'）有窗口** —— 剧情/文游没有可写消息的地方，调用方已经挡过。
 *  2. **不动 `chatLastReadAt`** —— 未读就是靠"消息时间晚于已读时刻"算出来的；
 *     但若这条会话从没标过已读（老会话/新建会话），先把**已有历史**标成已读再落新消息，
 *     否则上线第一天老会话里的全部历史会一起变成未读（假红点）。
 *  3. **只写 role:'assistant' 的角色台词**：正文来自 generateHook（角色人设口吻），
 *     绝不能把系统提示/召回文案写进去（红线 6：系统文案不得进业务消息集合）。
 */
export function appendInAppMessage(cand: Candidate, body: string): boolean {
  const text = String(body || '').trim();
  if (!text) return false;
  try {
    const charId = cand.targetId || 'xiaoyu';
    const mine = memoryStorage.getActiveSessions()
      .filter((s) => s.userId === cand.userId && (s.characterId || 'xiaoyu') === charId && (s.chatMessages?.length || 0) > 0)
      .sort((a, b) => new Date(b.chatUpdatedAt || b.updatedAt).getTime() - new Date(a.chatUpdatedAt || a.updatedAt).getTime());
    const session = mine[0];
    const now = new Date();
    if (session) {
      const msgs = session.chatMessages || [];
      memoryStorage.updateSession(session.sessionId, {
        chatMessages: [...msgs, { role: 'assistant', content: text, timestamp: now }],
        chatUpdatedAt: now,
        chatTitle: session.chatTitle || text.slice(0, 30),
        ...(typeof session.chatLastReadAt === 'number' ? {} : { chatLastReadAt: now.getTime() - 1 }),
      });
      return true;
    }
    // 该角色还没有任何会话 → 建一条（只有主动消息也能形成一个"窗口"，用户点进去就是这段对话）
    const sessionId = 'chat_' + randomUUID();
    memoryStorage.createSession(sessionId);
    const created = memoryStorage.updateSession(sessionId, {
      userId: cand.userId,
      characterId: charId,
      chatTitle: text.slice(0, 30),
      chatMessages: [{ role: 'assistant', content: text, timestamp: now }],
      chatUpdatedAt: now,
      chatLastReadAt: now.getTime() - 1,
    });
    if (created) return true;
    // 兜底：更新失败（会话刚被清理/过期）就不要留下半条状态
    memoryStorage.deleteSession(sessionId);
    return false;
  } catch (error) {
    console.warn('[Reengage] App 内消息写入失败:', (error as Error)?.message);
    return false;
  }
}

async function deliverOutreach(cand: Candidate, hook: { subject: string; body: string; sender?: string; fallback?: boolean }): Promise<boolean> {
  /**
   * 先落 App 内消息（聊一聊角色）：这一步同时是"未读角标"的唯一来源。
   * 它在推送/邮件之前，因为三种结果都要它：inapp 通道靠它投递；push 通道即使推送失败，
   * 用户在 App 里也已经看到了这句话（不该算失败、更不该重复发）。
   *
   * 🚨 只对 `intent !== 'reengage'`（= 用户自己开了「AI 主动找我」之后的日常/角色陪伴）落地。
   * 流失召回（reengage）走的是邮件/推送那条老路：那条路的对象**可能从没开过主动开关**，
   * 把"好久不见"写成角色发来的消息塞进他的聊天窗口，等于绕过用户的显式同意
   * （红线：不制造依赖、主动联系以用户开关为前提）。这一点是 2026-09-20 复核时补的闸门。
   *
   * 2026-09-28 审查 P1-2 补第二道闸门：`generateHook` 失败时会回落兜底句（fallbackHook），
   * 那是**系统文案**。它一旦被 appendInAppMessage 写进 chatMessages，就会以「角色说过的话」
   * 显示、落盘、并回灌给模型（红线⑥）。所以只有 `hook.fallback !== true`（模型真生成了）才允许写入。
   */
  const inApp = cand.feature === 'chat' && cand.intent !== 'reengage' && hook.fallback !== true
    ? appendInAppMessage(cand, hook.body)
    : false;
  if (cand.channel === 'inapp') return inApp;
  if (cand.channel === 'push') {
    const r = await sendPushToUser(cand.userId, {
      title: cand.senderName || hook.sender || 'Xiaoyu',
      body: hook.body,
      url: cand.deepLink || 'https://myxiaoyu.com/',
      tag: 'xiaoyu-outreach',
      icon: (cand.avatar && /^(\/|https?:)/.test(cand.avatar)) ? cand.avatar : undefined,
    });
    // 推送投递失败（端点失效/网络不可达）→ 仅流失召回回退邮件；日常/角色/剧情不打扰。
    // 但若这句话已经写进了 App 内会话，就算投递成功（用户打开 App 就能看到）。
    if (r.sent > 0) return true;
    console.warn(`[Reengage] 推送投递失败(sent=${r.sent}, failed=${r.failed})${cand.intent === 'reengage' ? '，回退邮件' : (inApp ? '，已在 App 内送达' : '，放弃（仅推送意图）')}: ${cand.userId}`);
    if (inApp) return true;
    if (cand.intent === 'reengage' && cand.email) return sendReengagementEmail(cand, hook);
    return false;
  }
  return sendReengagementEmail(cand, hook);
}

// ---------------------------------------------------------------------------
// 一次主动循环（admin 端点与定时器共用；内建互斥防并发）
// ---------------------------------------------------------------------------
export interface ReengageSummary {
  scanned: number;
  candidates: number;
  sent: number;
  skipped: number;
  errors: number;
  previews: { userId: string; email: string; channel: 'push' | 'email' | 'inapp'; feature: EngagementFeature; intent: OutreachIntent; contextRef: string; subjectKey: string; subject: string; body: string; senderName: string; deepLink: string }[];
}

let running = false;

export async function runReengagementCycle(opts: { apply?: boolean; limit?: number; now?: number } = {}): Promise<ReengageSummary> {
  if (running) return { scanned: 0, candidates: 0, sent: 0, skipped: 0, errors: 0, previews: [] };
  running = true;
  let summary: ReengageSummary = { scanned: 0, candidates: 0, sent: 0, skipped: 0, errors: 0, previews: [] };
  try {
    const now = opts.now ?? Date.now();
    // 预取今日新闻（仅聊一聊开话题用；失败为空列表，不阻塞）
    const news = await fetchTodayNews();
    const all = planCandidates(now);
    const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, DAILY_CAP) : DAILY_CAP;
    const cohort = all.slice(0, limit);
    let sent = 0, skipped = 0, errors = 0;
    const previews: ReengageSummary['previews'] = [];
    for (const cand of cohort) {
      // 聊一聊日常/角色开话题 → 附上当天新闻（若无则不带）
      if ((cand.intent === 'daily' || cand.intent === 'character') && cand.feature === 'chat') {
        cand.newsTopics = news;
      }
      const hook = await generateHook(cand, resolveLang(cand.userId));
      if (!opts.apply) {
        previews.push({ userId: cand.userId, email: cand.email, channel: cand.channel, feature: cand.feature, intent: cand.intent, contextRef: cand.contextRef, subjectKey: cand.subjectKey, subject: hook.subject, body: hook.body, senderName: cand.senderName || hook.sender || 'Xiaoyu', deepLink: cand.deepLink });
        skipped++;
        continue;
      }
      if (await deliverOutreach(cand, hook)) {
        sent++;
        reengageStore.markSent(cand.userId, cand.feature, cand.contextRef, { subjectKey: cand.subjectKey, intent: cand.intent, channel: cand.channel });
      } else {
        errors++;
      }
    }
    summary = { scanned: all.length, candidates: cohort.length, sent, skipped, errors, previews };
  } catch (e) {
    console.error('[Reengage] 主动循环失败:', (e as Error)?.message);
  } finally {
    running = false;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// 测试召回 / 测试推送（沿用《最近使用》场景，跳过冷却/预算）
// ---------------------------------------------------------------------------
export function buildContext(userId: string, feature: EngagementFeature): { contextRef: string; recentText: string; targetId: string; senderName: string; avatar: string; deepLink?: string } {
  if (feature === 'wenyou') return buildWenyouContext(userId);
  if (feature === 'roleplay') return buildContextSingleRoleplay(userId);
  if (feature === 'chat') {
    const subj = listChatSubjects(userId)[0];
    if (subj) return { contextRef: subj.contextRef, recentText: subj.recentText, targetId: subj.targetId, senderName: subj.senderName, avatar: subj.avatar || '', deepLink: subj.deepLink };
    return { contextRef: '', recentText: '', targetId: '', senderName: XIAOYU_CHARACTER.name, avatar: xiaoyuAvatarFor(userId) };
  }
  return { contextRef: '', recentText: '', targetId: '', senderName: XIAOYU_CHARACTER.name, avatar: xiaoyuAvatarFor(userId) };
}

function buildContextSingleRoleplay(userId: string): { contextRef: string; recentText: string; targetId: string; senderName: string; avatar: string; deepLink?: string } {
  const syl = listRoleplaySubjects(userId)[0];
  if (syl) return { contextRef: syl.contextRef, recentText: syl.recentText, targetId: syl.targetId, senderName: syl.senderName, avatar: syl.avatar || '', deepLink: syl.deepLink };
  const rp = roleplaySessionStore.listAll()
    .filter((r) => r.userId === userId && Array.isArray(r.messages) && r.messages.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const recentText = (rp?.messages ?? []).slice(-4).map((m) => m.content || '').join('\n').slice(0, 400);
  const sid = rp?.scenarioId || '';
  const scenario = sid ? getScenario(sid) : undefined;
  const custom = (sid && customRoleplayStore.get(userId, sid)) || undefined;
  const published = (sid && customRoleplayStore.getPublished(sid)) || undefined;
  const senderName = scenario?.zh?.ai?.name || custom?.aiName || published?.aiName || '';
  const avatar = (sid ? scenarioAvatar(sid) : '') || custom?.avatar || published?.avatar || xiaoyuAvatarFor(userId);
  return { contextRef: sid || '', recentText, targetId: sid, senderName, avatar };
}

function buildContextForTarget(userId: string, feature: EngagementFeature, targetId: string): { contextRef: string; recentText: string; targetId: string; senderName: string; avatar: string; deepLink: string } {
  if (feature === 'roleplay') {
    const scenario = getScenario(targetId);
    const published = customRoleplayStore.getPublished(targetId);
    const senderName = scenario?.zh?.ai?.name || published?.aiName || '';
    const avatar = (targetId ? scenarioAvatar(targetId) : '') || published?.avatar || xiaoyuAvatarFor(userId);
    const contextRef = (scenario?.zh as any)?.title || published?.title || targetId || '';
    return { contextRef, recentText: '', targetId, senderName, avatar, deepLink: deepLinkFor('roleplay', targetId) };
  }
  if (feature === 'chat') {
    const char = chatCharacterStore.get(userId, targetId);
    const senderName = char?.name || XIAOYU_CHARACTER.name;
    const avatar = char?.avatar || xiaoyuAvatarFor(userId);
    return { contextRef: '', recentText: '', targetId, senderName, avatar, deepLink: '/' };
  }
  const ctx = buildContext(userId, feature);
  return { ...ctx, deepLink: deepLinkFor(ctx.targetId ? feature : 'chat', ctx.targetId) };
}

export async function sendReengagementTest(userId: string, featureOverride?: EngagementFeature): Promise<{ ok: boolean; detail: string; subject?: string; body?: string; senderName?: string }> {
  const acc = accountStore.getById(userId);
  if (!acc?.email) return { ok: false, detail: '账号或邮箱不存在' };
  const act = activityStore.get(userId);
  let feature: EngagementFeature = featureOverride || act?.lastFeature || 'chat';
  if (feature === 'roleplay' && isWenyouRoleplay(userId)) feature = 'wenyou';
  const ctx = buildContext(userId, feature);
  const cand: Candidate = {
    userId, email: acc.email, channel: 'email', feature, intent: 'reengage',
    contextRef: ctx.contextRef, recentText: ctx.recentText,
    deepLink: deepLinkFor(feature, ctx.targetId), senderName: ctx.senderName, nickname: acc.username,
    subjectKey: feature + '::' + (ctx.targetId || ''), targetId: ctx.targetId,
  };
  const hook = await generateHook(cand, resolveLang(userId));
  const ok = await sendReengagementEmail(cand, hook);
  return { ok, detail: ok ? '已发送' : '发送失败', subject: hook.subject, body: hook.body, senderName: cand.senderName || hook.sender || 'Xiaoyu' };
}

export async function sendPushTest(userId: string, featureOverride?: EngagementFeature, targetId?: string): Promise<{ ok: boolean; detail: string; subject?: string; body?: string; senderName?: string; icon?: string; sent: number; failed: number; hasSubscription: boolean; proactivePushEnabled: boolean }> {
  const act = activityStore.get(userId);
  let feature: EngagementFeature = featureOverride || act?.lastFeature || 'chat';
  if (feature === 'roleplay' && !targetId && isWenyouRoleplay(userId)) feature = 'wenyou';
  const ctx = targetId ? buildContextForTarget(userId, feature, targetId) : buildContext(userId, feature);
  const cand: Candidate = {
    userId, email: '', channel: 'push', feature, intent: 'reengage',
    contextRef: ctx.contextRef, recentText: ctx.recentText,
    deepLink: ctx.deepLink || deepLinkFor(feature, ctx.targetId), senderName: ctx.senderName, avatar: ctx.avatar,
    nickname: accountStore.getById(userId)?.username,
    subjectKey: feature + '::' + (ctx.targetId || ''), targetId: ctx.targetId,
  };
  const hook = await generateHook(cand, resolveLang(userId));
  const r = await sendPushToUser(userId, {
    title: cand.senderName || hook.sender || 'Xiaoyu',
    body: hook.body,
    url: cand.deepLink || 'https://myxiaoyu.com/',
    tag: 'xiaoyu-outreach',
    icon: (cand.avatar && /^(\/|https?:)/.test(cand.avatar)) ? cand.avatar : undefined,
  });
  const noSub = r.sent === 0 && r.failed === 0;
  const hasSub = hasPushSubscription(userId);
  const proactiveOn = preferenceStore.get(userId)?.proactivePush === true;
  return {
    ok: r.sent > 0,
    detail: r.sent > 0
      ? `已推送到 ${r.sent} 个端点`
      : noSub
        ? (hasSub
          ? `该账号有 ${r.failed} 个订阅但全部送达失败（推送服务不可达/端点失效；若在大陆网络可能连不上 Google 推送服务）`
          : `该账号在当前服务器上没有订阅推送（订阅数=0，主动开关=${proactiveOn ? '开' : '关'}）。请打开与当前管理台同源的 App，登录后到「AI 主动找我」打开推送开关并允许通知。`)
        : `推送失败（${r.failed} 个端点不可达/失效；若在大陆网络可能连不上 Google 推送服务）`,
    subject: hook.subject,
    body: hook.body,
    senderName: cand.senderName || hook.sender || 'Xiaoyu',
    icon: (cand.avatar && /^(\/|https?:)/.test(cand.avatar)) ? cand.avatar : undefined,
    sent: r.sent,
    failed: r.failed,
    hasSubscription: hasSub,
    proactivePushEnabled: proactiveOn,
  };
}

// 兼容旧引用：buildWenyouContext（供单测/旧调用）
function buildWenyouContext(userId: string): { contextRef: string; recentText: string; targetId: string; senderName: string; avatar: string; deepLink?: string } {
  const p = wenyouSavesStore.get(userId);
  const keys = Object.keys((p?.games || {}) as Record<string, unknown>);
  const sid = keys[keys.length - 1] || '';
  const ctx = buildWenyouContextFor(userId, sid);
  return { contextRef: ctx.contextRef, recentText: ctx.recentText, targetId: ctx.targetId, senderName: ctx.senderName, avatar: ctx.avatar, deepLink: deepLinkFor('wenyou', ctx.targetId) };
}

export function isReengageEnabled(): boolean {
  return process.env.REENGAGE_ENABLED === '1';
}
