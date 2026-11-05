import assert from 'node:assert/strict';
import test from 'node:test';
import { latestCompletedSession, sessionsBetween } from '../src/calendar.js';
import { collect, controlFor, runTick, validateCloud, type Dependencies } from '../src/runtime.ts';
import { Store } from '../src/store.js';
import type { Bar, Fetcher, SignalState, Symbol } from '../src/types.js';
import { FakeD1 } from './fake-d1.js';

// Deliberately fake key and transport: every integration test stays in memory/offline.
const TEST_KEY = 'SCTUNITTEST00000000000';
function fixtureBars(nowMs: number, low = true): Bar[] {
  const dates = sessionsBetween('2024-01-02', latestCompletedSession(nowMs).date);
  return dates.map((date, index) => {
    const price = low && index >= dates.length - 2 ? 70 : 100;
    return { date, close: price, adjustedClose: price };
  });
}
function fixtures() {
  const pushed: Array<{ title: string; body: string }> = [];
  const prices: Symbol[] = [];
  let failedSymbol: Symbol | null = null;
  let staleSymbol: Symbol | null = null;
  const fetcher: Fetcher = async (url, init) => {
    assert.equal(String(url), `https://sctapi.ftqq.com/${TEST_KEY}.send`);
    const body = new URLSearchParams(String(init?.body));
    pushed.push({ title: body.get('title') ?? '', body: body.get('desp') ?? '' });
    return Response.json({ code: 0 });
  };
  const deps: Dependencies = {
    bars: async (symbol, nowMs) => {
      prices.push(symbol);
      if (symbol === failedSymbol) throw new Error('SYNTHETIC_PRICE_FAILURE');
      const bars = fixtureBars(nowMs);
      return symbol === staleSymbol ? bars.slice(0, -1) : bars;
    },
    valuation: async (symbol, nowMs) => ({
      symbol, date: latestCompletedSession(nowMs).date, pe: 20,
      source: `https://example.invalid/official/${symbol}`, method: 'synthetic FY1', proxy: `${symbol} synthetic index`,
    }), fetcher,
  };
  return { deps, prices, pushed, fail: (symbol: Symbol | null) => { failedSymbol = symbol; },
    stale: (symbol: Symbol | null) => { staleSymbol = symbol; } };
}
async function enabled(store: Store) {
  await store.put('control', { enabled: true, cloudValidatedAt: 1, deliveryConfirmedAt: 1 });
}
const firstLow: SignalState = {
  confirmed: 'neutral', candidate: 'low', candidateCount: 1, lastDate: '2026-11-04', lastAlerts: {},
};

test('default paused monitor makes no provider or push calls', async t => {
  const db = new FakeD1(); t.after(() => db.close());
  const store = new Store(db), fx = fixtures();
  assert.deepEqual(await runTick(store, TEST_KEY, Date.parse('2026-11-06T00:00:00Z'), fx.deps), { paused: true });
  assert.equal((await controlFor(store)).enabled, false);
  assert.deepEqual(fx.prices, []);
  assert.deepEqual(fx.pushed, []);
  assert.equal(await store.get('lastTick'), null);
});

test('cloud validation caches real-session fixtures without advancing signals or sending', async t => {
  const db = new FakeD1(); t.after(() => db.close());
  const store = new Store(db), fx = fixtures(), now = Date.parse('2026-11-06T00:00:00Z');
  const result = await validateCloud(store, now, fx.deps);
  assert.equal(result.valid, true);
  assert.equal(result.latestSession, '2026-11-05');
  for (const symbol of ['QQQM', 'SPYM'] as const) {
    assert.ok((await store.loadBars(symbol)).length >= 252);
    assert.equal(await store.get(`price:${symbol}`), null);
    assert.equal(await store.get(`valuation:${symbol}`), null);
  }
  assert.equal((await controlFor(store)).cloudValidatedAt, now);
  assert.equal((await controlFor(store)).enabled, false);
  assert.deepEqual(fx.pushed, []);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM notifications').get()?.n, 0);
});

test('collect exposes tentative updates but does not persist signal progress', async t => {
  const db = new FakeD1(); t.after(() => db.close());
  const store = new Store(db), fx = fixtures();
  const result = await collect(store, Date.parse('2026-11-06T00:00:00Z'), fx.deps);
  assert.equal(result.values.filter(item => item.key.startsWith('price:')).length, 2);
  assert.equal(await store.get('price:QQQM'), null);
  assert.equal(await store.get('price:SPYM'), null);
  assert.deepEqual(result.alerts, []);
});

test('08:00 Beijing daily report is sent once on a normal trading morning', async t => {
  const db = new FakeD1(); t.after(() => db.close());
  const store = new Store(db), fx = fixtures(); await enabled(store);
  await runTick(store, TEST_KEY, Date.parse('2026-11-05T23:55:00Z'), fx.deps);
  assert.equal(fx.pushed.length, 0);
  await runTick(store, TEST_KEY, Date.parse('2026-11-06T00:00:00Z'), fx.deps);
  assert.equal(fx.pushed.length, 1);
  assert.match(fx.pushed[0].title, /每日监测.*2026-11-06/);
  assert.match(fx.pushed[0].body, /最近完整美股交易日 2026-11-05/);
  assert.match(fx.pushed[0].body, /QQQM/);
  assert.match(fx.pushed[0].body, /SPYM/);
  assert.doesNotMatch(fx.pushed[0].body, /美股休市/);
  await runTick(store, TEST_KEY, Date.parse('2026-11-06T00:15:00Z'), fx.deps);
  await runTick(store, TEST_KEY, Date.parse('2026-11-06T04:00:00Z'), fx.deps);
  assert.equal(fx.pushed.length, 1);
});

test('08:00 Beijing holiday report uses previous session and does not count another confirmation', async t => {
  const db = new FakeD1(); t.after(() => db.close());
  const store = new Store(db), fx = fixtures(); await enabled(store);
  await runTick(store, TEST_KEY, Date.parse('2026-11-26T00:00:00Z'), fx.deps);
  const before = await store.get<SignalState>('price:QQQM');
  await runTick(store, TEST_KEY, Date.parse('2026-11-27T00:00:00Z'), fx.deps);
  assert.equal(fx.pushed.length, 2);
  assert.match(fx.pushed[1].body, /美股休市/);
  assert.match(fx.pushed[1].body, /最近完整美股交易日 2026-11-25/);
  assert.deepEqual(await store.get('price:QQQM'), before);
  await runTick(store, TEST_KEY, Date.parse('2026-11-27T00:30:00Z'), fx.deps);
  assert.equal(fx.pushed.length, 2);
});

test('two completed low sessions create one combined alert and duplicate ticks cannot resend', async t => {
  const db = new FakeD1(); t.after(() => db.close());
  const store = new Store(db), fx = fixtures(); await enabled(store);
  await runTick(store, TEST_KEY, Date.parse('2026-11-04T22:00:00Z'), fx.deps);
  assert.equal(fx.pushed.length, 0);
  await runTick(store, TEST_KEY, Date.parse('2026-11-05T22:00:00Z'), fx.deps);
  assert.equal(fx.pushed.length, 1);
  assert.match(fx.pushed[0].title, /信号提醒/);
  assert.match(fx.pushed[0].body, /QQQM/);
  assert.match(fx.pushed[0].body, /SPYM/);
  assert.match(fx.pushed[0].body, /价格低位，估值待确认，不能称为便宜/);
  for (const now of ['2026-11-05T22:15:00Z', '2026-11-05T22:30:00Z']) await runTick(store, TEST_KEY, Date.parse(now), fx.deps);
  assert.equal(fx.pushed.length, 1);
  assert.equal((await store.get<SignalState>('price:QQQM'))?.confirmed, 'low');
});

test('partial provider failure advances neither ETF and recovery retains both alerts', async t => {
  const db = new FakeD1(); t.after(() => db.close());
  const store = new Store(db), fx = fixtures(); await enabled(store);
  for (const symbol of ['QQQM', 'SPYM']) await store.put(`price:${symbol}`, firstLow);
  fx.fail('SPYM');
  await runTick(store, TEST_KEY, Date.parse('2026-11-05T22:00:00Z'), fx.deps);
  assert.deepEqual(await store.get('price:QQQM'), firstLow);
  assert.deepEqual(await store.get('price:SPYM'), firstLow);
  assert.equal(fx.pushed.length, 0);
  fx.fail(null);
  await runTick(store, TEST_KEY, Date.parse('2026-11-05T22:15:00Z'), fx.deps);
  assert.equal(fx.pushed.length, 1);
  assert.match(fx.pushed[0].body, /QQQM/);
  assert.match(fx.pushed[0].body, /SPYM/);
  assert.equal((await store.get<SignalState>('price:QQQM'))?.confirmed, 'low');
  assert.equal((await store.get<SignalState>('price:SPYM'))?.confirmed, 'low');
});

test('stale completed prices fail validation and prevent new confirmation', async t => {
  const db = new FakeD1(); t.after(() => db.close());
  const store = new Store(db), fx = fixtures(); await enabled(store);
  await store.put('price:QQQM', firstLow); await store.put('price:SPYM', firstLow);
  fx.stale('QQQM');
  const now = Date.parse('2026-11-05T22:00:00Z');
  assert.equal((await validateCloud(store, now, fx.deps)).valid, false);
  await runTick(store, TEST_KEY, now, fx.deps);
  assert.deepEqual(await store.get('price:QQQM'), firstLow);
  assert.deepEqual(await store.get('price:SPYM'), firstLow);
  assert.equal(fx.pushed.length, 0);
});

test('post-close analysis follows DST and early-close publication delay', async t => {
  const cases = [
    ['2026-10-30T20:29:00Z', '2026-10-29', '2026-10-30T20:30:00Z', '2026-10-30'],
    ['2026-11-02T21:29:00Z', '2026-10-30', '2026-11-02T21:30:00Z', '2026-11-02'],
    ['2026-11-27T18:29:00Z', '2026-11-25', '2026-11-27T18:30:00Z', '2026-11-27'],
  ];
  for (const [before, priorDate, after, completedDate] of cases) {
    const db = new FakeD1(); t.after(() => db.close());
    const store = new Store(db), fx = fixtures(); await enabled(store);
    await runTick(store, TEST_KEY, Date.parse(before), fx.deps);
    assert.equal((await store.get<{ session: string }>('lastAnalysis'))?.session, priorDate);
    await runTick(store, TEST_KEY, Date.parse(after), fx.deps);
    assert.equal((await store.get<{ session: string }>('lastAnalysis'))?.session, completedDate);
    assert.equal((await store.taskStatus(`analysis:${completedDate}`))?.completed, true);
  }
});
