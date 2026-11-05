import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { latestCompletedSession } from '../src/calendar.ts';
import { fetchBars, fetchValuation } from '../src/providers.ts';
import { analyzeBars, priceCondition } from '../src/signals.ts';
import { SYMBOLS } from '../src/types.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const now = Date.now();
const expected = latestCompletedSession(now).date;
await mkdir(resolve(root, 'output'), { recursive: true });
let allPassed = true;
const checks = [];
for (const symbol of SYMBOLS) {
  const [prices, valuation] = await Promise.allSettled([fetchBars(symbol, now), fetchValuation(symbol, now)]);
  if (prices.status !== 'fulfilled') {
    allPassed = false;
    checks.push({ symbol, priceOk: false, code: 'PRICE_FETCH_FAILED' });
    continue;
  }
  const bars = prices.value;
  const metrics = analyzeBars(symbol, bars);
  const priceOk = metrics.date === expected;
  allPassed &&= priceOk;
  await writeFile(resolve(root, 'output', `${symbol.toLowerCase()}-bars.json`), JSON.stringify(bars, null, 2));
  checks.push({ symbol, priceOk, bars: bars.length, latest: metrics.date, metrics, candidate: priceCondition(symbol, metrics),
    valuation: valuation.status === 'fulfilled' ? valuation.value : { status: 'unknown', code: 'VALUATION_FETCH_FAILED' },
    note: '一次本地试读；候选状态不是两日确认信号；本地成功不代表云端或微信已通过验收。',
  });
}
const result = { at: new Date(now).toISOString(), expected, allPassed, cloudVerified: false, wechatVerified: false, checks };
await writeFile(resolve(root, 'output', 'live-check.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (!allPassed) process.exitCode = 1;
