/**
 * 结算币种价格展示（展示侧，与后端 `currencyForCountry()` 同一口径）
 *
 * 后端按访客地区决定**结算币种**（港澳 HKD / 内地 CNY / 其他 USD，见 `api/services/payment.ts`），
 * 并把结果随 `/api/payment/config` 下发为 `payCurrency`；`/stripe/create-checkout` 用同一函数定价，
 * 所以前端**只展示该币种**就保证了「页面显示价 = Stripe 实扣价」。
 *
 * 约定（2026-09-24 用户口径）：主价 = 本币（大字号），另两币种只作折算小字；
 * 所有价格展示（付费弹窗 / 会员权益弹窗 / 对比卡）统一走这里，避免各处各写一套三币种串。
 */

import type { PayConfig } from '../services/api';

export type PayCurrency = 'USD' | 'HKD' | 'CNY';

/** 币种符号：USD 用 $（避免与 HK$ / ¥ 混淆） */
export const CUR_SYM: Record<PayCurrency, string> = { USD: '$', HKD: 'HK$', CNY: '¥' };

/** 本次结算币种（配置缺失/异常时回退 USD） */
export function payCurrencyOf(config?: PayConfig | null): PayCurrency {
  const c = config?.payCurrency;
  return c === 'HKD' || c === 'CNY' ? c : 'USD';
}

/** 本次结算币种符号 */
export function curSym(config?: PayConfig | null): string {
  return CUR_SYM[payCurrencyOf(config)];
}

/** 数字兜底（undefined/NaN → 0） */
export function num(v?: number): number {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

/** 价格数字格式化：整数不带小数，小数去掉末尾 0（4.99 / 38.92 / 35） */
export function fnum(v?: number): string {
  return v == null ? '' : (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, ''));
}

/** 取本币数值 */
export function pickCur(config: PayConfig | null | undefined, usd?: number, hkd?: number, cny?: number): number {
  const cur = payCurrencyOf(config);
  return cur === 'HKD' ? num(hkd) : cur === 'CNY' ? num(cny) : num(usd);
}

/** 本币主价串（如 `HK$38.92`）；无数值时返回空串（调用方可回退 i18n 兜底文案） */
export function mainPrice(config: PayConfig | null | undefined, usd?: number, hkd?: number, cny?: number): string {
  const v = pickCur(config, usd, hkd, cny);
  return v > 0 ? curSym(config) + fnum(v) : '';
}

/** 另两币种折算串（如 `$4.99 · ¥35`），用于主价下方的小字 */
export function otherPrices(config: PayConfig | null | undefined, usd?: number, hkd?: number, cny?: number): string {
  const cur = payCurrencyOf(config);
  const rows: Array<[PayCurrency, number | undefined]> = [['USD', usd], ['HKD', hkd], ['CNY', cny]];
  return rows
    .filter(([k, v]) => k !== cur && v != null)
    .map(([k, v]) => CUR_SYM[k] + fnum(v))
    .join(' · ');
}
