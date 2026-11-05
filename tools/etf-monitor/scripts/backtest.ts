import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sessionsBetween } from '../src/calendar.js';
import { fetchBacktestBars } from '../src/providers.js';
import { advanceSignal, analyzeBars, priceCondition } from '../src/signals.js';
import type { Bar, Direction, SignalState, Symbol } from '../src/types.js';

export const horizonSessions = { '1m': 21, '3m': 63, '6m': 126, '12m': 252 } as const;
export interface ForwardOutcome {
  sessions: number; returnPct: number; maxAdverseExcursionPct: number;
  minimumPathReturnPct: number; maximumPathReturnPct: number;
}
export interface BacktestEntry {
  date: string; direction: Exclude<Direction, 'neutral'>; notified: boolean;
  close: number; adjustedClose: number;
  forward: Record<keyof typeof horizonSessions, ForwardOutcome | null>;
}
export interface BacktestResult {
  symbol: Symbol; from: string; through: string; observations: number;
  warmupSessions: number; evaluableFrom: string;
  entries: BacktestEntry[]; methodology: string;
}

/** This is an event study, not a portfolio-return simulation or fitted trading system. */
export function backtest(symbol: Symbol, bars: Bar[]): BacktestResult {
  analyzeBars(symbol, bars); // Validate full input before any results can be emitted.
  const sessionDates = sessionsBetween(bars[0].date, bars[bars.length - 1].date);
  if (sessionDates.length !== bars.length || bars.some((bar, index) => bar.date !== sessionDates[index])) {
    throw new Error('Backtest input must contain every exchange session, without synthetic fills');
  }
  let state: SignalState | null = null;
  const entries: BacktestEntry[] = [];
  for (let index = 251; index < bars.length; index++) {
    // Future prices are used only for the outcome below, never the current condition/state.
    const metrics = analyzeBars(symbol, bars.slice(Math.max(0, index - 251), index + 1));
    const observed = priceCondition(symbol, metrics);
    const next = advanceSignal(state, observed, bars[index].date, sessionDates);
    state = next.state;
    if (!next.changed || observed === 'neutral') continue;
    const forward = {} as BacktestEntry['forward'];
    for (const [horizon, count] of Object.entries(horizonSessions)) {
      const key = horizon as keyof typeof horizonSessions;
      if (index + count >= bars.length) { forward[key] = null; continue; }
      const returns = bars.slice(index + 1, index + count + 1).map((bar) => (bar.adjustedClose / bars[index].adjustedClose - 1) * 100);
      const minimumPathReturnPct = Math.min(0, ...returns);
      const maximumPathReturnPct = Math.max(0, ...returns);
      forward[key] = {
        sessions: count, returnPct: returns[returns.length - 1], minimumPathReturnPct, maximumPathReturnPct,
        maxAdverseExcursionPct: observed === 'low' ? -minimumPathReturnPct : maximumPathReturnPct,
      };
    }
    entries.push({
      date: bars[index].date, direction: observed, notified: next.alert,
      close: bars[index].close, adjustedClose: bars[index].adjustedClose, forward,
    });
  }
  return {
    symbol, from: bars[0].date, through: bars[bars.length - 1].date, observations: bars.length,
    warmupSessions: 251, evaluableFrom: bars[251].date, entries,
    methodology: '固定初始门槛；指标首次需要252个交易日观察，首251个交易日仅预热，第252日开始判断，最早第253日确认；两次连续收盘确认；同向重入五交易日冷却；所有确认入场均列出（含未推送）。1/3/6/12月近似为21/63/126/252交易日。收益及路径均用复权价；不完整期限为null。最大不利变动为正幅度：低位信号后的最大下跌，偏热信号后的最大上涨。样本仅为所提供ETF的真实历史，不自动拼接指数或其他ETF。此为事件回看，未模拟组合、费用或税费，不能证明预测能力。',
  };
}

export function backtestMarkdown(result: BacktestResult): string {
  const lines = [`# ${result.symbol} 固定规则事件回看`, '', `${result.from} 至 ${result.through}；${result.observations} 个完整交易日；${result.entries.length} 次确认进入低位/偏热区间。`,
    `首次可评估日期：${result.evaluableFrom}；此前 ${result.warmupSessions} 个交易日仅作预热，不能计为“未出现信号”。`, '', result.methodology, '',
    '| 日期 | 信号 | 推送 | 1月收益/不利变动 | 3月收益/不利变动 | 6月收益/不利变动 | 12月收益/不利变动 |',
    '| --- | --- | --- | --- | --- | --- | --- |'];
  const cell = (outcome: ForwardOutcome | null) => outcome ? `${outcome.returnPct.toFixed(2)}% / ${outcome.maxAdverseExcursionPct.toFixed(2)}%` : '样本未满';
  for (const entry of result.entries) lines.push(`| ${entry.date} | ${entry.direction === 'low' ? '低位观察' : '偏热'} | ${entry.notified ? '是' : '冷却抑制'} | ${Object.values(entry.forward).map(cell).join(' | ')} |`);
  return `${lines.join('\n')}\n`;
}

export function backtestCsv(result: BacktestResult): string {
  const columns = ['symbol', 'date', 'direction', 'notified', 'close', 'adjusted_close', 'horizon', 'sessions', 'return_pct', 'max_adverse_excursion_pct', 'minimum_path_return_pct', 'maximum_path_return_pct'];
  const lines = [columns.join(',')];
  for (const entry of result.entries) {
    for (const [horizon, outcome] of Object.entries(entry.forward)) {
      lines.push([result.symbol, entry.date, entry.direction, entry.notified, entry.close, entry.adjustedClose, horizon,
        outcome?.sessions ?? '', outcome?.returnPct ?? '', outcome?.maxAdverseExcursionPct ?? '',
        outcome?.minimumPathReturnPct ?? '', outcome?.maximumPathReturnPct ?? ''].join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const allowed = new Set(['--symbol', '--input', '--live', '--out', '--help']);
  for (const arg of args.filter((value) => value.startsWith('--'))) if (!allowed.has(arg)) throw new Error('Unknown backtest argument');
  if (args.includes('--help')) {
    console.log('tsx scripts/backtest.ts --symbol QQQM|SPYM (--input bars.json | --live) [--out NAME]\nInput is an offline JSON Bar[] (date, close, adjustedClose). --out writes JSON/Markdown/CSV under ignored output/NAME.* only.');
    return;
  }
  const value = (flag: string) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
  const symbol = value('--symbol');
  if (symbol !== 'QQQM' && symbol !== 'SPYM') throw new Error('--symbol QQQM or SPYM is required');
  const input = value('--input');
  if (Boolean(input) === args.includes('--live')) throw new Error('Choose exactly one of --input FILE or --live');
  let bars: Bar[];
  if (input) {
    const payload: unknown = JSON.parse(await readFile(resolve(input), 'utf8'));
    if (!Array.isArray(payload)) throw new Error('Offline JSON must be a Bar[] array');
    bars = payload as Bar[];
  } else bars = await fetchBacktestBars(symbol, Date.now());
  const result = backtest(symbol, bars);
  const output = value('--out');
  if (args.includes('--out') && (!output || !/^[a-zA-Z0-9_-]+$/.test(output))) throw new Error('--out NAME must contain letters, numbers, underscores or hyphens only');
  if (output) {
    const outputDir = resolve(dirname(fileURLToPath(import.meta.url)), '../output');
    await mkdir(outputDir, { recursive: true });
    await writeFile(resolve(outputDir, `${output}.json`), `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(resolve(outputDir, `${output}.md`), backtestMarkdown(result));
    await writeFile(resolve(outputDir, `${output}.csv`), backtestCsv(result));
    console.log(`Saved output/${output}.{json,md,csv}`);
  } else console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : 'Backtest failed'); process.exitCode = 1; });
}
