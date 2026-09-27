/**
 * 分档额度文案的**数字来源 + 句式**（唯一实现，2026-09-27）。
 *
 * 口径（用户拍板）：**游客 5 条/天；注册账号 20 条/天 + 注册再一次性送 20 条**。
 *
 * 为什么单独成文件：
 *  ① 数字必须来自后端（`quota.guestDailyCredit` / `quota.freeDailyCredit` ÷ `quota.unitCredit`），
 *     前端任何页面都不许写死 5 / 20——否则改 `.env`（`GUEST_DAILY_TIAO` / `FREE_DAILY_CREDIT`）
 *     就会出现「后台改了、界面还印旧数字」的分叉（2026-09-17 的 «還能聊 Infinity 條» 是同类裂缝）。
 *  ② 「游客额度条」在首页会员条、聊一聊顶栏、理一理输入区三处都要出现，句式必须**逐字一致**，
 *     分散写就会出现"有的地方说注册送 20 条、有的地方不提"。
 *
 * 纯函数、无浏览器依赖（可在 node 测试里直接跑）。
 */

/** 额度条渲染只读这几个字段（与 `services/api.ts` 的 `QuotaInfo` 结构兼容，无需强转） */
export interface TierFields {
  creditEnabled?: boolean;
  unitCredit?: number;
  /** 游客档每日点数（未注册） */
  guestDailyCredit?: number;
  /** 注册免费档每日点数 */
  freeDailyCredit?: number;
  /** 该用户自己的每日点数上限（游客 = 游客档，注册免费 = 免费档） */
  creditDailyCap?: number | null;
  /** 注册赠送条数（已按「条」计，后端 `registerChatBonus`） */
  registerChatBonus?: number;
}

/** 支付配置里的同一批数字（`/api/payment/config` → `quota`）；quota 拿不到时作兜底 */
export interface TierFallbackConfig {
  quota?: { unitCredit?: number; guestDailyCredit?: number; freeDailyCredit?: number };
}

export interface TierTiao {
  /** 游客档：条/天 */
  g: number;
  /** 注册免费档：条/天 */
  d: number;
  /** 注册一次性赠送：条（0 = 活动未开启） */
  b: number;
  /** 该用户自己的日额度：条（无限档为 null） */
  own: number | null;
}

/**
 * 把点数换算成「条」的分档数字；**任何一个数字拿不到就返回 null**（调用方据此退回旧文案，
 * 绝不渲染出 `undefined 条`）。
 */
export function quotaTierTiao(q?: TierFields | null, cfg?: TierFallbackConfig | null): TierTiao | null {
  const unit = Number(q?.unitCredit || cfg?.quota?.unitCredit || 0);
  if (!Number.isFinite(unit) || unit <= 0) return null;
  const guestPts = q?.guestDailyCredit ?? cfg?.quota?.guestDailyCredit;
  const freePts = q?.freeDailyCredit ?? cfg?.quota?.freeDailyCredit;
  if (!Number.isFinite(guestPts as number) || !Number.isFinite(freePts as number)) return null;
  const cap = q?.creditDailyCap;
  return {
    g: Math.max(0, Math.round((guestPts as number) / unit)),
    d: Math.max(0, Math.round((freePts as number) / unit)),
    b: Math.max(0, Math.round(Number(q?.registerChatBonus) || 0)),
    own: typeof cap === 'number' && Number.isFinite(cap) ? Math.max(0, Math.round(cap / unit)) : null,
  };
}

/** i18n 函数的形状（避免本模块反向依赖 i18n/index.ts） */
type TFunc = (key: string, vars?: Record<string, string | number>) => string;

/**
 * 游客额度条（首页会员条 / 聊一聊顶栏 / 理一理输入区**共用**这一个句式）。
 *
 * @param remain 今天还剩多少条（调用方用 `quotaChatRemain(quota)` 算好）
 * @returns 文案；分档数字拿不到时返回 `null`，调用方退回旧 key
 */
export function guestQuotaLineText(
  t: TFunc,
  q: TierFields | null | undefined,
  cfg: TierFallbackConfig | null | undefined,
  remain: number,
): string | null {
  const tier = quotaTierTiao(q, cfg);
  if (!tier) return null;
  const params = { g: tier.g, d: tier.d, n: Math.max(0, Math.round(remain)) };
  return tier.b > 0
    ? t('guestQuotaLine', { ...params, b: tier.b })
    : t('guestQuotaLineNoBonus', params);
}
