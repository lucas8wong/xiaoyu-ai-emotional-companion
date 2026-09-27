/**
 * 时间锚 & 记忆时间渲染（temporal grounding · 2026-09-17）
 *
 * 为什么需要这个模块：
 *  - **读侧**：旧提示词里从来没有"今天是几号"（唯一的线索是「现在是深夜」），
 *    模型无法判断一条记忆是三个月前的还是今天的；
 *  - **写侧**：记忆里的「明天/上周/正在」被原样存了下来，时间参照丢了；
 *  - 两侧缺一不可 —— 只有日期没有记忆时间戳算不出新旧，只有时间戳不知道"现在"也算不出。
 *
 * 本模块只做**纯函数**（时间换算 + 记忆条目的时间标签渲染），不读任何存储、不引任何服务，
 * 因此可以被提示词构建（gemini.ts）、区域/偏好校验（preferences.ts）与单测安全复用。
 * 时区来源：用户在偏好里上报的 IANA 时区（浏览器 `Intl.DateTimeFormat().resolvedOptions().timeZone`，
 * 经 POST /api/reengage/timezone 落到 preferenceStore），缺失时回退默认时区。
 */

const DAY = 24 * 60 * 60 * 1000;

/** 兜底时区：用户没上报时区时用它算「今天」（产品主要面向港澳/海外，服务器在 +08 区） */
export const DEFAULT_TZ = process.env.APP_DEFAULT_TZ || 'Asia/Shanghai';

export type TimeLang = 'zh' | 'en';

/** 校验 IANA 时区串（非法返回 undefined，绝不把坏时区塞进 Intl） */
export function normalizeTimezone(tz?: string | null): string | undefined {
  if (!tz || typeof tz !== 'string') return undefined;
  const s = tz.trim();
  if (!s || s.length > 64 || !/^[A-Za-z_+\-/]+$/.test(s)) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s });
    return s;
  } catch {
    return undefined;
  }
}

export function resolveTimezone(tz?: string | null): string {
  return normalizeTimezone(tz) || DEFAULT_TZ;
}

/** 某时刻在指定时区的日历日期 YYYY-MM-DD（"今天"的口径） */
export function dateKeyIn(tz: string, at: number = Date.now()): string {
  try {
    return new Date(at).toLocaleDateString('en-CA', { timeZone: tz }).replace(/\//g, '-');
  } catch {
    return new Date(at).toLocaleDateString('en-CA').replace(/\//g, '-');
  }
}

/** 某时刻在指定时区的 HH:MM（分钟级；时间戳需要"具体到分钟"时用） */
export function clockIn(tz: string, at: number = Date.now()): string {
  try {
    return new Date(at).toLocaleTimeString('en-GB', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
  } catch {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

/**
 * 记忆条目的「时间点」文本：
 *  - 当天（按用户时区）→ 带**分钟**：`2026-09-19 07:12`
 *  - 更早 → 只到天：`2026-09-14`（几个月前的事给到分钟是噪音，不是信息）
 */
export function stampIn(tz: string, at: number, todayKey: string = todayKeyIn(tz)): string {
  const day = dateKeyIn(tz, at);
  return day === todayKey ? `${day} ${clockIn(tz, at)}` : day;
}

export function todayKeyIn(tz: string, now: number = Date.now()): string {
  return dateKeyIn(tz, now);
}

export interface NowParts {
  tz: string;
  dateKey: string;
  /** 星期三 / Wednesday */
  weekday: string;
  /** 15:42 */
  clock: string;
  /** 凌晨/早上/上午/中午/下午/傍晚/晚上（en: late night/…/night） */
  period: string;
  hour: number;
}

export function nowParts(tz: string = DEFAULT_TZ, now: number = Date.now()): NowParts {
  const zone = resolveTimezone(tz);
  const d = new Date(now);
  let hour = d.getHours();
  let weekday = '';
  let clock = '';
  try {
    clock = d.toLocaleTimeString('en-GB', { timeZone: zone, hour12: false, hour: '2-digit', minute: '2-digit' });
    const h = Number(clock.slice(0, 2));
    if (Number.isFinite(h)) hour = h % 24;
  } catch { /* 用服务器本地时间兜底 */ }
  try {
    const wd = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, weekday: 'short' }).format(d);
    weekday = wd;
  } catch { weekday = ''; }
  return { tz: zone, dateKey: dateKeyIn(zone, now), weekday, clock, period: periodOf(hour, 'zh'), hour };
}

export function periodOf(hour: number, lang: TimeLang): string {
  if (lang === 'en') {
    if (hour < 5) return 'late night';
    if (hour < 9) return 'early morning';
    if (hour < 12) return 'morning';
    if (hour < 14) return 'midday';
    if (hour < 18) return 'afternoon';
    if (hour < 21) return 'evening';
    return 'night';
  }
  if (hour < 5) return '凌晨';
  if (hour < 9) return '早上';
  if (hour < 12) return '上午';
  if (hour < 14) return '中午';
  if (hour < 18) return '下午';
  if (hour < 21) return '傍晚';
  return '晚上';
}

/** 相对时间标签（含绝对日期时另配 dateKeyOf；负数=未来） */
export function ageLabel(at: number, now: number = Date.now(), lang: TimeLang = 'zh'): string {
  const diff = now - at;
  const zh = lang !== 'en';
  if (diff < 0) {
    const d = Math.max(1, Math.ceil(-diff / DAY));
    return zh ? `还有 ${d} 天` : `in ${d} day${d > 1 ? 's' : ''}`;
  }
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return zh ? '刚刚' : 'just now';
  if (mins < 60) return zh ? `${mins} 分钟前` : `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return zh ? `${days} 天前` : `${days} d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return zh ? `${months} 个月前` : `${months} mo ago`;
  const years = Math.floor(days / 365);
  return zh ? `${years} 年前` : `${years} yr ago`;
}

/** 相差天数（a - b，按 YYYY-MM-DD 的日历天） */
export function dayDiff(aKey: string, bKey: string): number {
  const toUtc = (k: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k);
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  };
  const a = toUtc(aKey), b = toUtc(bKey);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((a - b) / DAY);
}

/** 记忆类型的中文/英文标签 */
export const KIND_LABEL: Record<string, { zh: string; en: string }> = {
  durable: { zh: '长期', en: 'long-term' },
  state: { zh: '状态', en: 'state' },
  event: { zh: '事件', en: 'event' },
  plan: { zh: '计划', en: 'plan' },
  diary: { zh: '日记', en: 'diary' },
  reflection: { zh: '反思', en: 'reflection' },
  relationship: { zh: '关系', en: 'bond' },
  portrait: { zh: '自画像', en: 'self-portrait' },
  // 剧情场面块（剧情角色按话题召回的"细节层"，见 storyArchive/storyBridge）
  story: { zh: '剧情', en: 'story' },
};

/** 记忆类型标签取用：kindLabel('state', 'zh') → '状态' */
export function kindLabel(kind: string, lang: TimeLang = 'zh'): string {
  return KIND_LABEL[kind]?.[lang] || (lang === 'en' ? 'memory' : '记忆');
}

export interface TimeTagInput {
  /** 时间锚（ms） */
  at: number;
  atApprox?: boolean;
  kind?: string;
  /** 绝对日期 YYYY-MM-DD（计划类必有） */
  dateKey?: string;
  /** 已过期/可能已变（由 longMemory.isMemoryStale 判定） */
  stale?: boolean;
}

/**
 * 记忆条目的时间标签，如：
 *  `[状态·3 天前（2026-09-14）]`、`[计划·原定 2026-09-15（2 天前，已过去）]`、
 *  `[长期·时间不详]`、`[状态·5 个月前（2026-04-02）·可能已变了]`
 */
export function timeTag(e: TimeTagInput, opts: { now?: number; todayKey?: string; tz?: string; lang?: TimeLang } = {}): string {
  const now = opts.now ?? Date.now();
  const tz = resolveTimezone(opts.tz);
  const lang: TimeLang = opts.lang || 'zh';
  const zh = lang !== 'en';
  const label = KIND_LABEL[e.kind || 'durable']?.[lang] || (zh ? '记忆' : 'memory');
  const today = opts.todayKey || todayKeyIn(tz, now);
  let when: string;
  if (e.dateKey) {
    const diff = dayDiff(e.dateKey, today);
    // 「原定」只属于计划；已经发生的事（事件）说「发生在」，否则读起来像"这场演唱会还没办"
    const isPlan = (e.kind || 'durable') === 'plan';
    if (diff > 0) {
      when = isPlan
        ? (zh ? `原定 ${e.dateKey}（还有 ${diff} 天）` : `set for ${e.dateKey} (in ${diff} days)`)
        : (zh ? `定在 ${e.dateKey}（还有 ${diff} 天）` : `scheduled ${e.dateKey} (in ${diff} days)`);
    } else if (diff === 0) {
      when = isPlan
        ? (zh ? `定在今天（${e.dateKey}）` : `set for today (${e.dateKey})`)
        : (zh ? `就在今天（${e.dateKey}）` : `today (${e.dateKey})`);
    } else {
      when = isPlan
        ? (zh ? `原定 ${e.dateKey}（${-diff} 天前，已过去）` : `was set for ${e.dateKey} (${-diff} days ago, past)`)
        : (zh ? `发生在 ${e.dateKey}（${-diff} 天前）` : `happened on ${e.dateKey} (${-diff} days ago)`);
    }
  } else if (e.atApprox) {
    when = zh ? '时间不详' : 'time unknown';
  } else {
    when = `${ageLabel(e.at, now, lang)}（${stampIn(tz, e.at, today)}）`;
  }
  const suffix = e.stale ? (zh ? '·可能已经变了' : '·may have changed') : '';
  return `[${label}·${when}${suffix}]`;
}

/** 一条记忆注入 prompt 的整行（`- [标签] 正文`） */
export function memoryLine(e: TimeTagInput & { text: string }, opts: { now?: number; todayKey?: string; tz?: string; lang?: TimeLang } = {}): string {
  return `- ${timeTag(e, opts)} ${e.text}`;
}

/** 关系记忆/日记/反思等的整行（这些条目本来就有 at，此前注入时被丢掉了） */
export function growthLine(text: string, at: number, kind: string, opts: { now?: number; tz?: string; lang?: TimeLang } = {}): string {
  const now = opts.now ?? Date.now();
  const tz = resolveTimezone(opts.tz);
  const lang: TimeLang = opts.lang || 'zh';
  const zh = lang !== 'en';
  const label = KIND_LABEL[kind]?.[lang] || (zh ? '记忆' : 'memory');
  return `- [${label}·${ageLabel(at, now, lang)}（${stampIn(tz, at)}）] ${text}`;
}
