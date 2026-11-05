import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionsBetween } from '../src/calendar.js';
import { advanceSignal, analyzeBars, assessValuation, defaultThresholds, priceCondition } from '../src/signals.js';
import type { Bar, Metrics, SignalState, ValuationSnapshot } from '../src/types.js';

const dates = sessionsBetween('2022-01-01', '2026-12-31');
const bars = (prices: number[]): Bar[] => prices.map((price, index) => ({ date: dates[index], close: price, adjustedClose: price }));
const metrics: Metrics = { date: dates[251], close: 100, changePct: 0, drawdownPct: 0, ma200: 100, gapPct: 0 };

test('daily calculations ignore split/dividend artifacts while retaining actual display price', () => {
  const series = bars(Array(252).fill(100));
  series.slice(0, 126).forEach((bar) => { bar.close = 200; });
  series[251].close = 99;
  const result = analyzeBars('SPYM', series);
  assert.equal(result.close, 99);
  assert.equal(result.changePct, 0);
  assert.equal(result.drawdownPct, 0);
  assert.equal(result.gapPct, 0);
  assert.equal(result.ma200, 100);
  assert.equal(priceCondition('SPYM', result), 'neutral');
});

test('252-session drawdown and 200-session mean use only their stated windows', () => {
  const series = bars([500, ...Array(251).fill(100), 80]);
  const result = analyzeBars('SPYM', series);
  assert.ok(Math.abs(result.drawdownPct - -20) < 1e-10);
  assert.equal(result.ma200, 99.9);
  assert.equal(priceCondition('SPYM', result), 'low');
});

test('threshold boundaries are inclusive and both low-price conditions are required', () => {
  assert.deepEqual(defaultThresholds.QQQM, { drawdownPct: -15, belowMaPct: -8, aboveMaPct: 15 });
  assert.equal(priceCondition('QQQM', { ...metrics, drawdownPct: -15, gapPct: -8 }), 'low');
  assert.equal(priceCondition('SPYM', { ...metrics, drawdownPct: -10, gapPct: -5 }), 'low');
  assert.equal(priceCondition('QQQM', { ...metrics, drawdownPct: -14.9, gapPct: -10 }), 'neutral');
  assert.equal(priceCondition('SPYM', { ...metrics, drawdownPct: -20, gapPct: 0 }), 'neutral');
  assert.equal(priceCondition('SPYM', { ...metrics, gapPct: 10 }), 'hot');
  assert.equal(priceCondition('QQQM', { ...metrics, gapPct: 15 }), 'hot');
  assert.equal(priceCondition('QQQM', { ...metrics, gapPct: 14.99 }), 'neutral');
});

test('invalid and insufficient histories fail closed', () => {
  assert.throws(() => analyzeBars('QQQM', bars(Array(251).fill(100))), /252/);
  const duplicate = bars(Array(252).fill(100)); duplicate[251].date = duplicate[250].date;
  assert.throws(() => analyzeBars('QQQM', duplicate), /unique/);
  const invalid = bars(Array(252).fill(100)); invalid[251].date = '2026-99-99';
  assert.throws(() => analyzeBars('QQQM', invalid), /Invalid/);
  invalid[251].date = dates[251]; invalid[251].adjustedClose = NaN;
  assert.throws(() => analyzeBars('QQQM', invalid), /Invalid/);
  assert.throws(() => priceCondition('QQQM', { ...metrics, gapPct: NaN }), /Invalid/);
});

test('two consecutive exchange closes confirm entry and same-date reruns are idempotent', () => {
  const first = advanceSignal(null, 'low', dates[0], dates);
  assert.equal(first.state.confirmed, 'neutral'); assert.equal(first.alert, false);
  const second = advanceSignal(first.state, 'low', dates[1], dates);
  assert.equal(second.state.confirmed, 'low'); assert.equal(second.changed, true); assert.equal(second.alert, true);
  const duplicate = advanceSignal(second.state, 'hot', dates[1], dates);
  assert.deepEqual(duplicate.state, second.state); assert.equal(duplicate.alert, false);
  assert.equal(first.state.candidateCount, 1, 'previous state is never mutated');
  assert.equal(advanceSignal(second.state, 'low', dates[0], dates).changed, false);
});

test('missing sessions break confirmation; calendar weekends do not', () => {
  const first = advanceSignal(null, 'low', dates[0], dates);
  const gap = advanceSignal(first.state, 'low', dates[2], dates);
  assert.equal(gap.state.candidateCount, 1); assert.equal(gap.alert, false);
  assert.equal(advanceSignal(gap.state, 'low', dates[3], dates).alert, true);
  const friday = dates.findIndex((date) => new Date(`${date}T00:00:00Z`).getUTCDay() === 5);
  const fridayState = advanceSignal(null, 'hot', dates[friday], dates);
  assert.equal(advanceSignal(fridayState.state, 'hot', dates[friday + 1], dates).alert, true);
});

test('neutral exits need confirmation, suppress early same-direction re-entry, and rearm after five sessions', () => {
  let state: SignalState | null = null;
  const observe = (direction: 'low' | 'neutral' | 'hot', index: number) => {
    const next = advanceSignal(state, direction, dates[index], dates); state = next.state; return next;
  };
  observe('low', 0); assert.equal(observe('low', 1).alert, true);
  assert.equal(observe('neutral', 2).state.confirmed, 'low');
  const exit = observe('neutral', 3); assert.equal(exit.changed, true); assert.equal(exit.alert, false);
  observe('low', 4); const early = observe('low', 5); assert.equal(early.changed, true); assert.equal(early.alert, false);
  observe('neutral', 6); observe('neutral', 7); observe('low', 8);
  assert.equal(observe('low', 9).alert, true);
  assert.equal(observe('low', 10).alert, false, 'persistent conditions do not periodically repeat');
});

test('opposite confirmed direction can alert inside the same-direction cooldown', () => {
  let state: SignalState | null = null;
  const alerts = ['low', 'low', 'hot', 'hot', 'low', 'low'].map((direction, index) => {
    const next = advanceSignal(state, direction as 'low' | 'hot', dates[index], dates); state = next.state; return next.alert;
  });
  assert.deepEqual(alerts, [false, true, false, true, false, true]);
});

const valuationDates = sessionsBetween('2020-01-01', '2026-11-30');
const asOf = '2026-11-05';
function valuationFixture(currentPe = 40): ValuationSnapshot[] {
  const row = (date: string, pe: number): ValuationSnapshot => ({ symbol: 'QQQM', date, pe, source: 'official-source', method: 'index FY1 weighted harmonic PE', proxy: 'Nasdaq-100' });
  const byMonth = new Map<string, string>();
  for (const date of valuationDates.filter((date) => date < '2026-11-01')) byMonth.set(date.slice(0, 7), date);
  const prior = [...byMonth.values()].slice(-60).map((date, index) => row(date, index + 10));
  return [...prior, row(asOf, currentPe)];
}

test('valuation requires 60 consecutive prior month-end samples; 252 daily rows are insufficient', () => {
  assert.equal(assessValuation('QQQM', valuationFixture().slice(1), asOf, valuationDates).status, 'unknown');
  const daily = valuationDates.filter((date) => date <= asOf).slice(-252).map((date) => ({ ...valuationFixture()[60], date }));
  assert.equal(assessValuation('QQQM', daily, asOf, valuationDates).status, 'unknown');
  const rows = valuationFixture(); rows.splice(30, 1); rows.unshift({ ...rows[0], date: '2021-10-29' });
  assert.equal(assessValuation('QQQM', rows, asOf, valuationDates).status, 'unknown', 'older observations cannot replace a missing month');
});

test('five-year valuation percentile yields cheap/fair/expensive inclusive boundaries', () => {
  assert.equal(assessValuation('QQQM', valuationFixture(21.5), asOf, valuationDates).percentile, 20);
  assert.equal(assessValuation('QQQM', valuationFixture(21.5), asOf, valuationDates).status, 'cheap');
  assert.equal(assessValuation('QQQM', valuationFixture(57.5), asOf, valuationDates).status, 'expensive');
  assert.equal(assessValuation('QQQM', valuationFixture(40), asOf, valuationDates).status, 'fair');
  const tied = valuationFixture(17).map((row) => ({ ...row, pe: 17 }));
  assert.equal(assessValuation('QQQM', tied, asOf, valuationDates).percentile, 50);
});

test('valuation forbids method/proxy/source mixing and retains current PE when history is unknown', () => {
  for (const key of ['source', 'method', 'proxy'] as const) {
    const rows = valuationFixture(); rows[20] = { ...rows[20], [key]: 'different' };
    const result = assessValuation('QQQM', rows, asOf, valuationDates);
    assert.equal(result.status, 'unknown'); assert.equal(result.pe, 40); assert.equal(result.percentile, null);
  }
  const nonFy1 = valuationFixture().map((row) => ({ ...row, method: 'trailing PE' }));
  assert.equal(assessValuation('QQQM', nonFy1, asOf, valuationDates).status, 'unknown');
});

test('valuation excludes future observations and stale current figures', () => {
  const rows = valuationFixture(); rows.push({ ...rows[60], date: '2026-11-06', pe: 500 });
  assert.equal(assessValuation('QQQM', rows, asOf, valuationDates).pe, 40);
  const staleAsOf = '2026-11-20';
  const complete = valuationDates.filter((date) => date <= staleAsOf);
  const five = valuationFixture(); five[60].date = complete[complete.length - 6];
  assert.notEqual(assessValuation('QQQM', five, staleAsOf, valuationDates).status, 'unknown');
  const six = valuationFixture(); six[60].date = complete[complete.length - 7];
  assert.equal(assessValuation('QQQM', six, staleAsOf, valuationDates).status, 'unknown');
  assert.equal(assessValuation('QQQM', [], 'bad-date', valuationDates).status, 'unknown');
});

test('month-end dates must match the calendar; ambiguous current valuation fails closed', () => {
  const rows = valuationFixture(); rows[59].date = '2026-10-31';
  assert.equal(assessValuation('QQQM', rows, asOf, valuationDates).status, 'unknown');
  const conflicting = valuationFixture(); conflicting.push({ ...conflicting[60], pe: 45 });
  assert.equal(assessValuation('QQQM', conflicting, asOf, valuationDates).status, 'unknown');
});
