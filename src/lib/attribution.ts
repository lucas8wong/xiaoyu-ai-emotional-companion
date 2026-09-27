/**
 * 来源归因 · 客户端采集（first-touch + 触点路径）
 *
 * 为什么需要它：我们一直在投内容（IG / 小红书 / Reddit / SEO 落地页），
 * 但站内只记「有人来了」，不记「从哪来的」——于是无法回答
 * 「哪个渠道真的带来了注册与付费」。这一层只做一件事：
 * **落地时把 UTM / referrer / 落地路径落到本地**，注册时随请求带给服务端，
 * 由服务端把匿名设备与账号 stitch 起来（就是归因技能里的 identity graph）。
 *
 * 设计要点（对齐 `.dsh/skills/attribution`）：
 *  - **first-touch 必须保住**：之后所有触点只追加到 path，绝不覆盖 first；
 *  - **referrer 分类要干净**：自家域、OAuth/结账跳转、localhost 一律算 direct
 *    （否则「first touch 被重定向污染」是这类实现最常见的脏数据来源）；
 *  - **direct 是垃圾桶**：真正的入口常被浏览器剥掉 referrer（DM/群聊/截图），
 *    所以 direct 的占比本身就是结论，而不是「没来源」；
 *  - **不存任何 PII**：只有渠道/媒介/落地路径，没有 IP、没有邮箱、没有用户输入。
 *
 * 边界：这是**无 cookie、纯 localStorage** 的轻量实现；不做跨设备合并、
 * 不做多触点权重模型（那些交给后续按需扩展，先把 first-touch 与路径存对）。
 */

/** 一个触点（页面级） */
export interface AttributionTouch {
  /** utm_source，缺省按 referrer 归类；无任何线索则 'direct' */
  source: string;
  /** utm_medium，缺省 '' */
  medium: string;
  /** utm_campaign，缺省 '' */
  campaign: string;
  content: string;
  term: string;
  /** referrer 主机名（已剔除自家域/OAuth/结账/本地），无则 '' */
  refHost: string;
  /** 落地路径（不含 query，避免把 token 之类的参数写进存储） */
  path: string;
  /** 采集时间戳 */
  at: number;
}

const FIRST_KEY = 'cure_attr_first';
const PATH_KEY = 'cure_attr_path';
/** 触点路径上限（首触 + 最近 N 条足够回答「他看过什么才注册」） */
export const TOUCH_PATH_CAP = 10;

/** 这些 referrer 不代表真实来源：OAuth 回跳、结账回跳、本地开发 */
const IGNORED_REFERRER_HOSTS = [
  'accounts.google.com',
  'checkout.stripe.com',
  'login.microsoftonline.com',
  'appleid.apple.com',
  'localhost',
  '127.0.0.1',
];

function safeHost(referrer: string, selfHost: string): string {
  if (!referrer) return '';
  try {
    const url = new URL(referrer);
    const host = url.hostname.toLowerCase();
    if (!host) return '';
    if (selfHost && (host === selfHost || host.endsWith(`.${selfHost}`))) return ''; // 站内跳转＝自引用
    if (IGNORED_REFERRER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return '';
    return host;
  } catch {
    return '';
  }
}

/**
 * referrer 归类：自家域/OAuth/结账/本地 → 'direct'（即「无可用来源线索」）。
 * 单独导出便于单测与后续按需扩表。
 */
export function classifyReferrer(referrer: string, selfHost = ''): string {
  return safeHost(referrer, selfHost);
}

/** 把 search/referrer 解析成一个触点（纯函数，便于单测） */
export function parseTouch(opts: {
  search: string;
  referrer: string;
  selfHost?: string;
  path?: string;
  now?: number;
}): AttributionTouch {
  const params = new URLSearchParams(opts.search || '');
  const refHost = classifyReferrer(opts.referrer || '', opts.selfHost || '');
  const utmSource = (params.get('utm_source') || '').trim().toLowerCase();
  return {
    source: utmSource || refHost || 'direct',
    medium: (params.get('utm_medium') || '').trim().toLowerCase(),
    campaign: (params.get('utm_campaign') || '').trim().toLowerCase(),
    content: (params.get('utm_content') || '').trim(),
    term: (params.get('utm_term') || '').trim(),
    refHost,
    path: opts.path || '/',
    at: opts.now ?? Date.now(),
  };
}

/** 同一触点判重键（避免刷新页面把同一来源刷成 10 条） */
export function touchKey(t: AttributionTouch): string {
  return [t.source, t.medium, t.campaign, t.path].join('|');
}

/** 追加触点：去重 + 保首触 + 截断到 cap（纯函数） */
export function mergeTouchPath(list: AttributionTouch[], touch: AttributionTouch, cap = TOUCH_PATH_CAP): AttributionTouch[] {
  const out = Array.isArray(list) ? list.filter((t) => t && typeof t.source === 'string') : [];
  const key = touchKey(touch);
  if (out.some((t) => touchKey(t) === key)) return out.slice(-cap);
  return [...out, touch].slice(-cap);
}

function readJsonLocal(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * 落地采集（幂等）：把本次落地触点写进 localStorage。
 * 首次调用确立 first-touch；之后只追加 path，并记录最后一次触点。
 */
export function captureAttribution(): AttributionTouch | null {
  try {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') return null;
    const touch = parseTouch({
      search: window.location?.search || '',
      referrer: document?.referrer || '',
      selfHost: window.location?.hostname || '',
      path: window.location?.pathname || '/',
    });
    const existingFirst = readJsonLocal(FIRST_KEY) as AttributionTouch | null;
    if (!existingFirst || typeof existingFirst.source !== 'string') {
      localStorage.setItem(FIRST_KEY, JSON.stringify(touch));
    }
    const path = readJsonLocal(PATH_KEY) as AttributionTouch[] | null;
    localStorage.setItem(PATH_KEY, JSON.stringify(mergeTouchPath(path || [], touch)));
    return touch;
  } catch {
    return null;
  }
}

/** 读取已存归因（注册时带上；无则返回 null） */
export function getAttribution(): { first: AttributionTouch | null; path: AttributionTouch[] } {
  try {
    if (typeof localStorage === 'undefined') return { first: null, path: [] };
    const first = readJsonLocal(FIRST_KEY) as AttributionTouch | null;
    const path = readJsonLocal(PATH_KEY) as AttributionTouch[] | null;
    return {
      first: first && typeof first.source === 'string' ? first : null,
      path: Array.isArray(path) ? path.filter((t) => t && typeof t.source === 'string') : [],
    };
  } catch {
    return { first: null, path: [] };
  }
}
