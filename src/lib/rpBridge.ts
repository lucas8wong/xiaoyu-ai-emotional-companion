/**
 * 剧情 → 聊一聊 · 跨模式桥（B 方案）
 * 设计稿：`剧情引流聊一聊-B方案设计稿.md`
 *
 * 本文件只做三件事，全部为纯逻辑（无 DOM、无请求、可单测）：
 *  1) 判定「卡壳」与「出戏元话语」，**高精度优先**：误判会让用户拿不到本该有的回复，
 *     代价比漏判高，所以宁可少判（与 api/services/chatRedirect.ts 同口径）。
 *  2) 频次预算：跨模式引导（含 chatRedirect 的正向卡）同一用户 72h 内最多 1 次，累计 2 次拒绝后永久静默。
 *  3) 构造交接草稿：上下文**放进用户自己的输入框**（可改可删），绝不自动发送
 *     红线 6：桥的文案绝不写进 messages / chatMessages。
 */

/**
 * 触发方式：
 * - `stuck` / `ooc` / `scene_end` / `ending` = **系统主动提示**（受 72h 冷却 + 单次会话 1 次 + 2 次拒绝永久静默约束）
 * - `pull` = **用户自己走进去**（剧情输入栏那个常显入口）。它不是「提醒」，因此**不消耗也不受**上述预算约束
 *   用户点了「以后不用提醒」只是不要被提醒，不代表这扇门要焊死。
 */
export type BridgeTrigger = 'stuck' | 'ooc' | 'scene_end' | 'ending' | 'pull';

/** 剧情 → 聊一聊 的交接载荷（**仅 UI 层**；绝不写进 messages / chatMessages） */
export interface BridgeSeed {
  /** 填进聊一聊输入框的草稿：用户可改可删，绝不自动发送 */
  draft: string;
  trigger: BridgeTrigger;
  scenarioId: string;
  scenarioTitle: string;
  aiName: string;
  /** 埋点用：剧情对局 rp / 文游 wenyou / 狼人杀 wolfcha */
  kind?: 'rp' | 'wenyou' | 'wolfcha';
}

/** 跨模式引导冷却：72h（保守起步，先保体验，看数据再放宽） */
export const BRIDGE_COOLDOWN_MS = 72 * 60 * 60 * 1000;
/** 卡壳救援的空闲阈值：输入框空着、没有流式输出、超过这个时长才提议 */
export const BRIDGE_IDLE_MS = 75_000;
/** 少于这么多轮不提议：用户还没进入状态，提议只会碍事 */
export const BRIDGE_MIN_TURNS = 2;
/** 连续拒绝达到这个次数 → 永久静默 */
export const BRIDGE_DISMISS_LIMIT = 2;

const STORAGE_KEY = 'cure_bridge_budget';
const STATS_KEY = 'cure_bridge_stats';

/**
 * 漏斗账本（本地计数）。
 * 为什么先做本地：服务端埋点需要新端点/新事件类型（属于后端 + 控制台的一批改动），
 * 在没定端点之前**不擅自改核心路由**。本账本已能回答「桥展示了多少次、点了多少次、落地后真的发了第一条消息吗」
 *。在任意设备打开 devtools 跑 `JSON.parse(localStorage.getItem('cure_bridge_stats'))` 即可读。
 */
export interface BridgeStats {
  shown: Partial<Record<BridgeTrigger, number>>;
  clicked: Partial<Record<BridgeTrigger, number>>;
  dismissed: number;
  /** 落地到聊一聊（草稿已预填）次数 */
  landed: number;
  /** 落地的草稿被真正**发出去**的次数，这才是我们要的转化 */
  firstMessage: number;
}

const EMPTY_STATS: BridgeStats = { shown: {}, clicked: {}, dismissed: 0, landed: 0, firstMessage: 0 };

export function readBridgeStats(): BridgeStats {
  if (!hasStorage()) return { ...EMPTY_STATS, shown: {}, clicked: {} };
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return { ...EMPTY_STATS, shown: {}, clicked: {} };
    const p = JSON.parse(raw) as Partial<BridgeStats>;
    return {
      shown: p.shown ?? {},
      clicked: p.clicked ?? {},
      dismissed: typeof p.dismissed === 'number' ? p.dismissed : 0,
      landed: typeof p.landed === 'number' ? p.landed : 0,
      firstMessage: typeof p.firstMessage === 'number' ? p.firstMessage : 0,
    };
  } catch {
    return { ...EMPTY_STATS, shown: {}, clicked: {} };
  }
}

export function recordBridgeEvent(
  event: 'shown' | 'clicked' | 'dismissed' | 'landed' | 'firstMessage',
  trigger?: BridgeTrigger,
): void {
  const cur = readBridgeStats();
  if (event === 'shown' || event === 'clicked') {
    if (!trigger) return;
    const bucket = event === 'shown' ? cur.shown : cur.clicked;
    bucket[trigger] = (bucket[trigger] ?? 0) + 1;
  } else {
    cur[event] = cur[event] + 1;
  }
  if (!hasStorage()) return;
  try { localStorage.setItem(STATS_KEY, JSON.stringify(cur)); } catch { /* 忽略 */ }
}

/**
 * 灰度开关：默认开；`localStorage.setItem('cure_bridge_enabled','0')` 可一键关停（不用发版）。
 * 读不到 localStorage（隐私模式/SSR）时按**关**处理，安全默认，宁可不展示。
 */
export function bridgeEnabled(): boolean {
  if (!hasStorage()) return false;
  try {
    return localStorage.getItem('cure_bridge_enabled') !== '0';
  } catch {
    return false;
  }
}

// 【归一化：去空白（含全角）、小写；繁简都在正则里显式列出，不引入依赖】
function norm(text: string): string {
  return (text || '').replace(/[\s\u3000]+/g, '').toLowerCase();
}

/** 误伤排除：这些是在戏里说话 / 评价，不是在求助 */
const STUCK_NEGATIVE = [
  /不知道你(在|是)/,
  /不(想|要)你(说|說)/,
];

/** 「我卡住了」：只认高精度的求助表达 */
const STUCK_PATTERNS = [
  /(不知道|不晓得|不曉得)(该|該|要)?(说|說|写|寫|回|怎么|怎麼|如何)/,
  /(想不(出|到))/, // 想不出（+来/來），「想不到你也在」由下面的排除项兜住
  /我(卡住|卡了|卡壳|卡殼|卡文)/,
  /^(卡住|卡了|卡壳|卡殼|卡文|卡死)(了|啦|啊)?[。.！!…~\s]*$/,
  /(接不下去|接不上|接下来呢|接下來呢|然后呢|然後呢)/,
  /(帮我想|幫我想|替我想|你来写|你來寫)/,
  /(词穷|詞窮|没想法|沒想法|毫无头绪|毫無頭緒)/,
];
const STUCK_NEGATIVE_EXTRA = [
  /想不到你/, // 「想不到你也在这里」是在戏里说话
];
const STUCK_RAW = [
  /\bi (don'?t|dont) know what to (say|do|write|reply)\b/,
  /\bi'?m (so )?(stuck|stuck here)\b/,
  /\bstuck (here|now)\b/,
  /\bno idea (what|how)\b/,
  /\bhelp me (think|continue|write|reply)\b/,
  /\bwriter'?s block\b/,
];

/**
 * 判定用户是否在求助「接不下去」。
 * 只用于决定要不要**多给一个选项**（不是拦截、不是短路），所以宁可漏判。
 */
export function detectStuck(text: string): boolean {
  const n = norm(text);
  if (!n) return false;
  if (STUCK_NEGATIVE.some(re => re.test(n)) || STUCK_NEGATIVE_EXTRA.some(re => re.test(n))) return false;
  if (STUCK_PATTERNS.some(re => re.test(n))) return true;
  return STUCK_RAW.some(re => re.test((text || '').toLowerCase()));
}

/**
 * 「出戏元话语」：用户明确表示不演了 / 要说自己的事。
 * 这是 100% 意图明确的信号，允许给卡片（不是弹窗）。
 */
const OOC_PATTERNS = [
  /不(想)?演了|不演啦|别演了|別演了/,
  /出戏|出戲/,
  /(说|說|聊|講|讲)(点|點)?(真的|现实|現實|自己)/,
  /(回到|聊聊)现实|現實/,
  /这(是|是我)现实/,
  /這(是|是我)現實/,
  /我(的)?(现实|現實)(里|裡)/,
];
/** 独立成句的暂停请求：「暂停一下」「先停一下」，避免误伤戏里的对白「停一下！」 */
const OOC_STANDALONE = [
  /^[（(]?(先)?(暂停|暫停|停)[一下]*[)）]?[。.！!…~\s]*$/,
];
const OOC_RAW = [
  /\b(stop (role-?playing|acting))\b/,
  /\bout of character\b/,
  /\booc\b/,
  /\bfor real now\b/,
  /\blet'?s talk for real\b/,
  /\boff script\b/,
  /\bpause (this|the) (story|scene)\b/,
];

/** 判定是否属于「出戏元话语」 */
export function detectOocMeta(text: string): boolean {
  const n = norm(text);
  if (!n) return false;
  if (OOC_STANDALONE.some(re => re.test(n))) return true;
  if (OOC_PATTERNS.some(re => re.test(n))) return true;
  return OOC_RAW.some(re => re.test((text || '').toLowerCase()));
}

/** 空闲是否足够久（卡壳救援的第二个条件；busy = 正在发送 / 流式输出） */
export function isIdleEnough(input: {
  lastActivityAt: number;
  now: number;
  inputEmpty: boolean;
  busy: boolean;
}): boolean {
  if (input.busy || !input.inputEmpty) return false;
  if (!Number.isFinite(input.lastActivityAt) || input.lastActivityAt <= 0) return false;
  return input.now - input.lastActivityAt >= BRIDGE_IDLE_MS;
}

// 【频次预算】

export interface BridgeBudget {
  lastShownAt: number | null;
  dismissCount: number;
  muted: boolean;
}

const EMPTY_BUDGET: BridgeBudget = { lastShownAt: null, dismissCount: 0, muted: false };

function hasStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

/** 读取预算（无 localStorage 环境，如 node 单测/SSR，返回空预算，不抛错） */
export function readBridgeBudget(): BridgeBudget {
  if (!hasStorage()) return { ...EMPTY_BUDGET };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_BUDGET };
    const parsed = JSON.parse(raw) as Partial<BridgeBudget>;
    return {
      lastShownAt: typeof parsed.lastShownAt === 'number' ? parsed.lastShownAt : null,
      dismissCount: typeof parsed.dismissCount === 'number' ? parsed.dismissCount : 0,
      muted: parsed.muted === true,
    };
  } catch {
    return { ...EMPTY_BUDGET };
  }
}

export function writeBridgeBudget(patch: Partial<BridgeBudget>): BridgeBudget {
  const next: BridgeBudget = { ...readBridgeBudget(), ...patch };
  if (hasStorage()) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* 忽略（隐私模式/配额满） */ }
  }
  return next;
}

/** 记录一次展示（写冷却时间戳） */
export function markBridgeShown(now: number = Date.now()): BridgeBudget {
  return writeBridgeBudget({ lastShownAt: now });
}

/** 记录一次拒绝；达到上限即永久静默 */
export function markBridgeDismissed(): BridgeBudget {
  const cur = readBridgeBudget();
  const dismissCount = cur.dismissCount + 1;
  recordBridgeEvent('dismissed');
  return writeBridgeBudget({ dismissCount, muted: dismissCount >= BRIDGE_DISMISS_LIMIT });
}

/**
 * 要不要展示桥。四个条件全过才展示：
 *  开关打开 → 未被永久静默 → 本次会话没展示过 → 距上次展示超过冷却
 */
export function canShowBridge(input: {
  enabled: boolean;
  now: number;
  shownThisSession: boolean;
  budget: BridgeBudget;
  cooldownMs?: number;
}): { show: boolean; reason: 'ok' | 'disabled' | 'muted' | 'session' | 'cooldown' } {
  if (!input.enabled) return { show: false, reason: 'disabled' };
  if (input.budget.muted) return { show: false, reason: 'muted' };
  if (input.shownThisSession) return { show: false, reason: 'session' };
  const cooldown = input.cooldownMs ?? BRIDGE_COOLDOWN_MS;
  if (input.budget.lastShownAt !== null && input.now - input.budget.lastShownAt < cooldown) {
    return { show: false, reason: 'cooldown' };
  }
  return { show: true, reason: 'ok' };
}

// 【交接草稿】

/**
 * 构造填进聊一聊输入框的草稿。
 *
 * **只放一句「我从哪来」的上下文，不带任何剧情正文**（2026-09-17 用户实测反馈后改）：
 * - 曾经把「最近一幕」原文摘要 + 「我想说的是我自己的事，」一起塞进来，两个后果都被用户抓到了：
 *   ① 剧情原文（含亲密/成人桥段）被复制进**另一个模式**的会话里，既是语境串味也是隐私复制；
 *   ② 尾句替用户立了个"我要聊自己的事"的意图，小愈于是回「剧情我先放一边，你说你自己的」，很怪。
 * - 现在只留一句中性的「我刚从一段剧情里出来（剧名/我的角色/对面是谁）」；
 *   用户想说什么由他自己写，小愈要接上下文就开口问。
 *
 * 注意：调用方**不得**自动发送，草稿是用户自己的话，这也是上下文能合法过去的原因。
 */
export function buildBridgeDraft(preface: string): string {
  return (preface || '').trim();
}
