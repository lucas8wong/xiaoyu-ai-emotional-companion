import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sessionsBetween } from '../src/calendar.js';
import { fetchBacktestBars, fetchBars, fetchValuation, parseOfficialValuation, parseYahooBars } from '../src/providers.js';
import type { Fetcher, Symbol } from '../src/types.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const html = readFileSync(new URL('../fixtures/ssga-index-synthetic.html', import.meta.url), 'utf8');
function payload(symbol: Symbol = 'SPYM', includeCurrent = false): any {
  const dates = sessionsBetween('2025-01-02', includeCurrent ? '2026-11-06' : '2026-11-05');
  return { chart: { error: null, result: [{ meta: { symbol, currency: 'USD', dataGranularity: '1d' },
    timestamp: dates.map(date => Date.parse(`${date}T15:00:00Z`) / 1000),
    indicators: { quote: [{ close: dates.map((_, i) => 90 + i / 100) }],
      adjclose: [{ adjclose: dates.map((_, i) => 88 + i / 100) }] },
  }] } };
}
function result(data: any): any { return data.chart.result[0]; }
function fake(handler: (url: string) => Promise<Response> | Response): Fetcher {
  return (async (url: any) => handler(String(url))) as Fetcher;
}

test('daily bars retain own pre-rename SPYM history and exclude current incomplete session', () => {
  const data = payload('SPYM', true);
  const bars = parseYahooBars(data, 'SPYM', NOW);
  assert.equal(bars[0].date, '2025-01-02');
  assert.equal(bars.at(-1)?.date, '2026-11-05');
  assert.notEqual(bars[0].close, bars[0].adjustedClose);
  assert.ok(bars.length >= 252);
  const beforeDelay = parseYahooBars(payload('QQQM'), 'QQQM', Date.parse('2026-11-05T21:20:00Z'));
  assert.equal(beforeDelay.at(-1)?.date, '2026-11-04');
});

test('reject symbol/currency/granularity mismatch and missing adjusted closes', () => {
  for (const change of [
    (r: any) => { r.meta.symbol = 'SPLG'; },
    (r: any) => { r.meta.currency = 'EUR'; },
    (r: any) => { r.meta.dataGranularity = '1wk'; },
    (r: any) => { delete r.indicators.adjclose; },
    (r: any) => { r.indicators.quote[0].close.pop(); },
    (r: any) => { r.indicators.adjclose[0].adjclose[20] = null; },
  ]) {
    const data = payload(); change(result(data));
    assert.throws(() => parseYahooBars(data, 'SPYM', NOW));
  }
  assert.throws(() => parseYahooBars({ chart: { error: { description: 'private body' }, result: null } }, 'SPYM', NOW), /unambiguous/);
});

test('reject missing sessions, duplicate dates, fake holiday bars and insufficient history', () => {
  const missing = payload();
  const r = result(missing);
  r.timestamp.splice(50, 1); r.indicators.quote[0].close.splice(50, 1); r.indicators.adjclose[0].adjclose.splice(50, 1);
  assert.throws(() => parseYahooBars(missing, 'SPYM', NOW), /missing trading/);
  const duplicate = payload(); result(duplicate).timestamp[20] = result(duplicate).timestamp[19];
  assert.throws(() => parseYahooBars(duplicate, 'SPYM', NOW), /duplicate/);
  const holiday = payload(); result(holiday).timestamp[0] = Date.parse('2025-01-09T15:00:00Z') / 1000;
  assert.throws(() => parseYahooBars(holiday, 'SPYM', NOW), /nontrading/);
  const tooShort = payload();
  const short = result(tooShort);
  short.timestamp = short.timestamp.slice(-200);
  short.indicators.quote[0].close = short.indicators.quote[0].close.slice(-200);
  short.indicators.adjclose[0].adjclose = short.indicators.adjclose[0].adjclose.slice(-200);
  assert.throws(() => parseYahooBars(tooShort, 'SPYM', NOW), /fewer than 252/);
});

test('fetch retries second Yahoo host without querying legacy SPLG', async () => {
  const calls: string[] = [];
  const bars = await fetchBars('SPYM', NOW, fake(url => {
    calls.push(url);
    return calls.length === 1 ? new Response('upstream body', { status: 503 }) : Response.json(payload());
  }));
  assert.ok(bars.length >= 252);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('query1.finance.yahoo.com'));
  assert.ok(calls[1].includes('query2.finance.yahoo.com'));
  assert.ok(calls.every(url => url.includes('/SPYM?') && !url.includes('SPLG')));
});

test('replay fetch uses actual inception or current benchmark date without changing cloud two-year query', async () => {
  for (const symbol of ['QQQM', 'SPYM'] as const) {
    const calls: URL[] = [];
    const data = payload(symbol);
    const bars = await fetchBacktestBars(symbol, NOW, fake(url => {
      calls.push(new URL(url));
      return calls.length === 1 ? new Response('unavailable', { status: 503 }) : Response.json(data);
    }));
    assert.ok(bars.length >= 252);
    assert.equal(calls.length, 2);
    const expectedStart = symbol === 'QQQM' ? '2020-10-13' : '2020-01-24';
    for (const url of calls) {
      assert.equal(url.pathname, `/v8/finance/chart/${symbol}`);
      assert.equal(url.searchParams.get('period1'), String(Date.parse(`${expectedStart}T00:00:00Z`) / 1000));
      assert.equal(url.searchParams.get('period2'), String(Math.floor(NOW / 1000)));
      assert.equal(url.searchParams.get('interval'), '1d');
      assert.equal(url.searchParams.has('range'), false);
    }
  }
  let cloudUrl = '';
  await fetchBars('QQQM', NOW, fake(url => { cloudUrl = url; return Response.json(payload('QQQM')); }));
  assert.equal(new URL(cloudUrl).searchParams.get('range'), '2y');
  assert.equal(new URL(cloudUrl).searchParams.has('period1'), false);
});

test('replay history refuses pre-benchmark fund observations and unsupported current dates', async () => {
  const data = payload();
  const r = result(data);
  r.timestamp.unshift(Date.parse('2020-01-23T15:00:00Z') / 1000);
  r.indicators.quote[0].close.unshift(50);
  r.indicators.adjclose[0].adjclose.unshift(49);
  await assert.rejects(() => fetchBacktestBars('SPYM', NOW, fake(() => Response.json(data))), /replay history unavailable/);
  let called = false;
  await assert.rejects(() => fetchBacktestBars('QQQM', Date.parse('2041-01-02T22:00:00Z'), fake(() => { called = true; return Response.json(payload('QQQM')); })), /supports/);
  assert.equal(called, false);
});

test('official valuation reads Index FY1 only and labels QQQM proxy explicitly', () => {
  const value = parseOfficialValuation(html, 'SPYM');
  assert.equal(value.pe, 20.23);
  assert.equal(value.date, '2026-11-04');
  assert.match(value.method, /FY1/);
  const proxy = parseOfficialValuation(html, 'QQQM');
  assert.match(proxy.proxy, /Nasdaq-100.*QNDX.*proxy/);
  assert.match(proxy.source, /qndx$/);
  assert.match(value.source, /spym$/);
});

test('official parser fails closed for moved/missing/duplicate FY1, invalid date and invalid P/E', () => {
  for (const bad of [
    html.replace('Index Characteristics', 'Fund Characteristics'),
    html.replace('>20.23<', '>N/A<'),
    html.replace('>20.23<', '>0<'),
    html.replaceAll('Nov 04 2026', 'Nov 07 2026'),
    html.replaceAll('Nov 04 2026', 'Feb 30 2026'),
    html + html,
    html.replace('<td class="data">20.23</td>', '<td class="data">20.23</td></tr><tr><th>Price/Earnings Ratio FY1</th><td>21.00</td>'),
  ]) assert.throws(() => parseOfficialValuation(bad, 'SPYM'));
});

test('fetch valuation rejects future official date and sanitizes network failures', async () => {
  const value = await fetchValuation('SPYM', NOW, fake(() => new Response(html)));
  assert.equal(value.pe, 20.23);
  await assert.rejects(() => fetchValuation('QQQM', Date.parse('2026-11-04T18:00:00Z'), fake(() => new Response(html))), /completed/);
  await assert.rejects(() => fetchValuation('SPYM', NOW, fake(() => { throw new Error('secret upstream message'); })), error => {
    assert.equal((error as Error).message, 'Provider network request failed'); return true;
  });
});

test('bounded fetch rejects excessive declared or streamed body size', async () => {
  await assert.rejects(() => fetchValuation('SPYM', NOW, fake(() => new Response('x', { headers: { 'content-length': '2000001' } }))), /too large/);
  await assert.rejects(() => fetchValuation('SPYM', NOW, fake(() => new Response('x'.repeat(2_000_001)))), /too large/);
});
