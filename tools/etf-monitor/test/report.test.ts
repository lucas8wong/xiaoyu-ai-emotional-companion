import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/report.js';
import type { Analysis } from '../src/types.js';

const options = { kind: 'daily' as const, beijingDate: '2026-11-06', latestSession: '2026-11-05', holiday: false };
function analysis(): Analysis {
  return {
    symbol: 'QQQM', metrics: { date: '2026-11-05', close: 200, changePct: 0.5, drawdownPct: -20, ma200: 100, gapPct: -10 },
    price: 'low', confirmed: 'low', valuation: { status: 'unknown', pe: 29.3, date: '2026-11-05', percentile: null, reason: '缺少六十个月历史', source: 'https://official.example/index' }, errors: [],
  };
}

test('report separates actual close, adjusted indicators, unknown valuation and confirmed status', () => {
  const report = renderReport([analysis()], options);
  assert.match(report.title, /每日监测.*2026-11-06/);
  assert.match(report.body, /收盘 \$200\.00/);
  assert.match(report.body, /涨跌幅（复权）\+0\.50%/);
  assert.match(report.body, /复权口径/);
  assert.doesNotMatch(report.body, /\$100\.00/);
  assert.match(report.body, /已确认：回撤低位观察/);
  assert.match(report.body, /FY1 P\/E 29\.30/);
  assert.match(report.body, /待确认，不能称为便宜/);
  assert.match(report.body, /回撤≤-15%（满足）且距均线≤-8%（满足）/);
  assert.match(report.body, /距均线≥15%（未满足）/);
  assert.match(report.body, /不能预测底部或顶部/);
});

test('pending low conditions cannot be reported as a confirmed combined opportunity', () => {
  const pending = analysis(); pending.confirmed = 'neutral'; pending.valuation.status = 'cheap'; pending.valuation.percentile = 10;
  const report = renderReport([pending], { ...options, kind: 'signal' });
  assert.match(report.body, /待连续两个交易日确认/);
  assert.match(report.body, /已确认：中性/);
  assert.doesNotMatch(report.body, /组合信号：低位且/);
  assert.match(report.title, /信号提醒/);
});

test('confirmed composite labels require fundamental confirmation', () => {
  const cheap = analysis(); cheap.valuation.status = 'cheap'; cheap.valuation.percentile = 10; cheap.valuationConfirmed = 'cheap';
  assert.match(renderReport([cheap], options).body, /组合信号：低位且估值相对便宜/);
  const expensive = analysis(); expensive.price = expensive.confirmed = 'hot'; expensive.valuation.status = 'expensive'; expensive.valuationConfirmed = 'expensive';
  assert.match(renderReport([expensive], options).body, /价格偏热且估值相对昂贵/);
});

test('raw valuation cannot imply two-session confirmation before its tracker confirms', () => {
  const pending = analysis(); pending.valuation.status = 'cheap'; pending.valuation.percentile = 10;
  const report = renderReport([pending], options);
  assert.match(report.body, /估值：相对便宜（待连续两个交易日确认）/);
  assert.doesNotMatch(report.body, /组合信号：低位且估值相对便宜/);
  assert.match(report.body, /估值相对便宜尚待连续两个交易日确认/);
});

test('holiday, failures and stale prior confirmation remain explicit', () => {
  const failed = analysis(); failed.metrics = null; failed.price = null; failed.errors = ['价格来源暂不可用'];
  const report = renderReport([failed], { ...options, holiday: true, issues: ['重试中'] });
  assert.match(report.body, /休市不累计信号确认/);
  assert.match(report.body, /价格数据异常，暂停新信号/);
  assert.match(report.body, /上次已确认/);
  assert.match(report.body, /价格来源暂不可用/);
  assert.match(report.body, /运行提示：重试中/);
  assert.doesNotMatch(report.body, /组合信号/);
});
