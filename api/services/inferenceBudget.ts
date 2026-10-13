import { AsyncLocalStorage } from 'node:async_hooks';
export interface InferenceBudget { limitYuan: number; spentYuan: number; calls: number; maxCalls?: number; inputAllowanceYuan?: number; }
const requestUsage = new AsyncLocalStorage<{ spentYuan: number; calls: number }>();
/** Each HTTP request owns its cost accumulator, including nested retries and parallel calls. */
export function withRequestUsage<T>(work: () => T): T { return requestUsage.run({ spentYuan: 0, calls: 0 }, work); }
export function requestUsageCost(): number | null {
  const usage = requestUsage.getStore();
  return usage && usage.calls > 0 ? usage.spentYuan : null;
}
const context = new AsyncLocalStorage<InferenceBudget>();
export function withInferenceBudget<T>(budget: InferenceBudget | null, work: () => Promise<T>): Promise<T> {
  return budget ? context.run(budget, work) : work();
}
export function recordInferenceCost(yuan: number): void {
  const budget = context.getStore();
  const usage = requestUsage.getStore();
  if (Number.isFinite(yuan) && yuan >= 0) {
    if (usage) { usage.spentYuan += yuan; usage.calls++; }
    if (budget) budget.spentYuan += yuan;
  }
}
/** Limit new-policy requests and retries before sending them; historical paid periods bypass this. */
export function budgetedMaxTokens(model: string, messages: unknown[], requested: number): number {
  const budget = context.getStore();
  if (!budget) return requested;
  if (++budget.calls > (budget.maxCalls ?? 4)) throw new Error('AI_BUDGET_EXHAUSTED');
  const fx = Number(process.env.FX_USD_CNY || 7.2);
  const grok = /^grok[-.]4[-.]20/i.test(model);
  const deepseek = /deepseek/i.test(model);
  if (!grok && !deepseek) throw new Error('AI_BUDGET_MODEL_UNPRICED');
  const text = messages.map(m => typeof (m as any)?.content === 'string' ? (m as any).content : JSON.stringify((m as any)?.content || '')).join('\n');
  const cjk = (text.match(/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const inputTokens = Math.ceil(cjk * 1.1 + (text.length - cjk) * 0.4 + messages.length * 16);
  // No cache discount is assumed for the request's budget. DeepSeek uses a peak-rate upper estimate.
  const inputRate = grok ? Number(process.env.GROK_INPUT_PRICE_PER_M || 1.25) * fx : Number(process.env.INPUT_PRICE_PER_M || 2) * Number(process.env.PRICE_PEAK_MULTIPLIER || 2);
  const outputRate = grok ? Number(process.env.GROK_OUTPUT_PRICE_PER_M || 2.5) * fx : Number(process.env.OUTPUT_PRICE_PER_M || 8) * Number(process.env.PRICE_PEAK_MULTIPLIER || 2);
  const inputCost = inputTokens * inputRate / 1e6;
  // The first prompt is mandatory story context, and a cold cache can cost more
  // than the user's entire reserved turn. Fund that input once on the server;
  // never assume a cache hit or renew the allowance for continuations/retries.
  // Actual usage still includes input, and settlement keeps the reserved cap.
  if (budget.calls === 1) budget.inputAllowanceYuan = inputCost;
  const room = budget.limitYuan + (budget.inputAllowanceYuan || 0) - budget.spentYuan - inputCost;
  const max = Math.floor(room * 1e6 / outputRate);
  if (max < 192) throw new Error('AI_BUDGET_EXHAUSTED');
  return Math.max(192, Math.min(requested, max));
}
