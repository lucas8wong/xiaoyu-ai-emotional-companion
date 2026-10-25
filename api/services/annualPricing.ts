/** New one-time annual quotes only. Stored orders and subscription prices are immutable inputs. */
export const ANNUAL_PRICING_VERSION = '2026-10-25-fixed-new-annual-v1';
const annualPlans = {
  plus: { env: 'PLUS_PRICE_CNY_YEARLY', fallback: 599 },
  pro: { env: 'PRO_PRICE_CNY_YEARLY', fallback: 1599 },
  max: { env: 'MAX_PRICE_CNY_YEARLY', fallback: 3199 },
} as const;

/** One configured CNY price, converted once for regional checkout; no campaign discount. */
export function annualPrice(plan: string, usdCny: number, usdHkd: number) {
  if (!Object.hasOwn(annualPlans, plan)) return { cny: 0, usd: 0, hkd: 0 };
  const rule = annualPlans[plan as keyof typeof annualPlans];
  const raw = process.env[rule.env];
  const cny = raw === undefined || raw.trim() === '' ? rule.fallback : Number(raw);
  if (![cny, usdCny, usdHkd].every(n => Number.isFinite(n) && n > 0)
    || !Number.isSafeInteger(Math.round(cny * 100)) || Math.abs(cny * 100 - Math.round(cny * 100)) > 1e-7) {
    throw new Error('INVALID_ANNUAL_PRICE_CONFIGURATION');
  }
  const ceilCent = (value: number) => Math.ceil(value * 100 - 1e-9) / 100;
  return { cny, usd: ceilCent(cny / usdCny), hkd: ceilCent(cny / usdCny * usdHkd) };
}
