import test from 'node:test';
import assert from 'node:assert/strict';
import { backtest, backtestCsv, backtestMarkdown } from '../scripts/backtest.js';
import { sessionsBetween } from '../src/calendar.js';
import type { Bar } from '../src/types.js';

const dates = sessionsBetween('2022-01-01', '2026-12-31');
function history(count: number): Bar[] {
  return dates.slice(0, count).map((date, index) => ({ date, close: index < 252 ? 100 : index === 254 ? 60 : index < 254 ? 80 : 82, adjustedClose: index < 252 ? 100 : index === 254 ? 60 : index < 254 ? 80 : 82 }));
}

test('backtest lists every confirmed entry with unfilled horizons null', () => {
  const result = backtest('SPYM', history(260));
  assert.equal(result.warmupSessions, 251);
  assert.equal(result.evaluableFrom, dates[251]);
  assert.equal(result.entries[0].date, dates[253]);
  assert.equal(result.entries[0].direction, 'low');
  assert.equal(result.entries[0].notified, true);
  assert.deepEqual(result.entries[0].forward, { '1m': null, '3m': null, '6m': null, '12m': null });
});

test('forward outcomes use adjusted prices and include maximum adverse move', () => {
  const series = history(600);
  series.slice(254).forEach((bar) => { bar.close /= 2; }); // A raw-price corporate action must not affect returns.
  const result = backtest('SPYM', series);
  const entry = result.entries[0];
  assert.ok(Math.abs(entry.forward['1m']!.returnPct - 2.5) < 1e-10);
  assert.ok(Math.abs(entry.forward['1m']!.maxAdverseExcursionPct - 25) < 1e-10);
  assert.ok(Math.abs(entry.forward['12m']!.returnPct - 2.5) < 1e-10);
});

test('adding extreme future prices cannot change earlier signal decisions', () => {
  const short = history(270);
  const longer = history(600);
  longer.slice(270).forEach((bar) => { bar.close = bar.adjustedClose = 1000; });
  const decisions = (series: Bar[]) => backtest('SPYM', series).entries.filter((entry) => entry.date <= dates[269])
    .map(({ date, direction, notified }) => ({ date, direction, notified }));
  assert.deepEqual(decisions(longer), decisions(short));
});

test('event study retains cooldown-suppressed entries and confirms opposite-direction entries', () => {
  const series = dates.slice(0, 280).map((date) => ({ date, close: 100, adjustedClose: 100 }));
  for (const index of [252, 253, 256, 257, 260, 261]) series[index].close = series[index].adjustedClose = 80;
  for (const index of [262, 263, 266, 267]) series[index].close = series[index].adjustedClose = 130;
  const entries = backtest('SPYM', series).entries.map(({ date, direction, notified }) => ({ date, direction, notified }));
  assert.deepEqual(entries, [
    { date: dates[253], direction: 'low', notified: true },
    { date: dates[257], direction: 'low', notified: false },
    { date: dates[261], direction: 'low', notified: true },
    { date: dates[263], direction: 'hot', notified: true },
    { date: dates[267], direction: 'hot', notified: false },
  ]);
});

test('hot-signal adverse excursion measures a further rise, not subsequent downside', () => {
  const series = dates.slice(0, 300).map((date, index) => ({ date, close: index < 252 ? 100 : index === 254 ? 150 : 130, adjustedClose: index < 252 ? 100 : index === 254 ? 150 : 130 }));
  const entry = backtest('SPYM', series).entries[0];
  assert.equal(entry.direction, 'hot');
  assert.equal(entry.forward['1m']!.returnPct, 0);
  assert.ok(Math.abs(entry.forward['1m']!.maxAdverseExcursionPct - (150 / 130 - 1) * 100) < 1e-10);
});

test('missing sessions and duplicated dates cannot generate a misleading backtest', () => {
  const missing = history(300); missing.splice(260, 1);
  assert.throws(() => backtest('SPYM', missing), /every exchange session/);
  const duplicate = history(300); duplicate[260].date = duplicate[259].date;
  assert.throws(() => backtest('SPYM', duplicate), /unique/);
});

test('portable exports retain all events and make incomplete horizons explicit', () => {
  const result = backtest('SPYM', history(260));
  const markdown = backtestMarkdown(result), csv = backtestCsv(result);
  assert.match(markdown, /样本未满/);
  assert.ok(markdown.includes(`首次可评估日期：${dates[251]}`));
  assert.match(markdown, /此前 251 个交易日仅作预热/);
  assert.match(markdown, /不能证明预测能力/);
  assert.equal(csv.trim().split('\n').length, 1 + result.entries.length * 4);
  assert.match(csv, /max_adverse_excursion_pct/);
});

test('minimum history is evaluable only on its final close and cannot yet confirm a new signal', () => {
  const series = history(252); series[251].close = series[251].adjustedClose = 70;
  const result = backtest('SPYM', series);
  assert.equal(result.evaluableFrom, series[251].date);
  assert.equal(result.entries.length, 0);
});
