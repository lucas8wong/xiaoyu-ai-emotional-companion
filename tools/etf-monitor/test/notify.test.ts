import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, type NotificationInput } from '../src/store.js';
import { dispatchNotifications, validSendKey } from '../src/notify.js';
import { FakeD1 } from './fake-d1.js';
import type { Fetcher } from '../src/types.js';

const now = Date.parse('2026-11-06T00:00:00Z');
const key = 'SCT0000000000SyntheticFixtureOnly';
const ok: Fetcher = async () => Response.json({ code: 0 });
function fixture(t: test.TestContext): { db: FakeD1; store: Store } {
  const db = new FakeD1();
  t.after(() => db.close());
  return { db, store: new Store(db) };
}
function notification(id: string, kind: NotificationInput['kind'] = 'signal'): NotificationInput {
  return { id, kind, title: `ETF ${id}`, body: 'Synthetic fixture', createdAt: now, expiresAt: now + 2 * 86_400_000 };
}

test('validates key before HTTP and posts securely without accepting redirects', async t => {
  const { store } = fixture(t);
  let calls = 0;
  await store.commit([], [notification('one')]);
  assert.equal(validSendKey(`${key}/../x`), false);
  assert.equal(validSendKey(`${key}\n`), false);
  await assert.rejects(dispatchNotifications(store, `${key}?token=bad`, now, async () => { calls++; return Response.json({ code: 0 }); }), /valid Turbo SCT key/);
  assert.equal(calls, 0);
  const result = await dispatchNotifications(store, key, now, async (input, init) => {
    calls++;
    assert.equal(input, `https://sctapi.ftqq.com/${key}.send`);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(new URLSearchParams(String(init?.body)).get('desp'), 'Synthetic fixture');
    assert.ok(init?.signal);
    assert.equal((await store.health(now)).attemptsToday, 1, 'quota must be reserved before HTTP');
    return Response.json({ code: 0, data: { pushid: 'fake' } });
  });
  assert.deepEqual(result, { sent: 1, failed: 0, ambiguous: 0, remaining: 0 });
  assert.equal((await store.health(now)).accepted, 1, 'API acceptance is stored, not asserted delivery');
  assert.equal(calls, 1);
});

test('parallel dispatchers share five-attempt budget with daily priority', async t => {
  const { db, store } = fixture(t);
  await store.commit([], [notification('daily', 'daily'), ...Array.from({ length: 12 }, (_, i) => notification(`signal-${i}`))]);
  const calls: string[] = [];
  const send: Fetcher = async (_input, init) => {
    calls.push(new URLSearchParams(String(init?.body)).get('title')!);
    await new Promise(resolve => setTimeout(resolve, 1));
    return Response.json({ code: 0 });
  };
  await Promise.all(Array.from({ length: 8 }, () => dispatchNotifications(new Store(db), key, now, send)));
  assert.equal(calls.length, 5);
  assert.equal(new Set(calls).size, 5);
  assert.equal(calls[0], 'ETF daily');
  assert.equal((await store.health(now)).attemptsToday, 5);
});

test('alerts cannot consume the fifth slot reserved for the daily report', async t => {
  const { store } = fixture(t);
  await store.commit([], Array.from({ length: 6 }, (_, i) => notification(`signal-${i}`)));
  assert.equal((await dispatchNotifications(store, key, now, ok)).sent, 4);
  await store.commit([], [notification('daily', 'daily')]);
  assert.equal((await dispatchNotifications(store, key, now, ok)).sent, 1);
  assert.equal((await store.health(now)).attemptsToday, 5);
  assert.equal((await dispatchNotifications(store, key, now + 86_400_000, ok)).sent, 2);
  assert.equal((await store.health(now + 86_400_000)).attemptsToday, 2);
});

test('definite rejections retry only after fifteen minutes, maximum three times', async t => {
  const { store } = fixture(t);
  await store.commit([], [notification('rejected')]);
  let calls = 0;
  const reject: Fetcher = async () => { calls++; return Response.json({ code: 123, message: 'temporarily busy' }); };
  assert.equal((await dispatchNotifications(store, key, now, reject)).failed, 1);
  assert.equal((await dispatchNotifications(store, key, now + 899_999, reject)).failed, 0);
  assert.equal((await dispatchNotifications(store, key, now + 900_000, reject)).failed, 1);
  assert.equal((await dispatchNotifications(store, key, now + 1_800_000, reject)).failed, 1);
  assert.equal((await dispatchNotifications(store, key, now + 2_700_000, reject)).failed, 0);
  assert.equal(calls, 3);
  assert.equal((await store.health(now)).attemptsToday, 3);
  assert.equal((await store.health(now)).failed, 1);
});

test('network/lost response and malformed response are terminal ambiguous, without secret storage', async t => {
  const { db, store } = fixture(t);
  await store.commit([], [notification('timeout'), notification('malformed')]);
  let calls = 0;
  const fail: Fetcher = async () => {
    calls++;
    if (calls === 1) throw new Error(`Network failure https://sctapi.ftqq.com/${key}.send`);
    return new Response('not-json', { status: 502 });
  };
  assert.equal((await dispatchNotifications(store, key, now, fail)).ambiguous, 2);
  assert.equal((await dispatchNotifications(store, key, now + 900_000, fail)).ambiguous, 0);
  assert.equal(calls, 2);
  const persisted = JSON.stringify(db.sqlite.prepare('SELECT * FROM send_attempts').all());
  assert.equal(persisted.includes(key), false);
  assert.equal(persisted.includes('Network failure'), false);
});

test('invalid key response is terminal and not retried', async t => {
  const { store } = fixture(t);
  await store.commit([], [notification('auth')]);
  let calls = 0;
  const invalid: Fetcher = async () => { calls++; return Response.json({ code: 40001, message: 'SendKey is invalid' }, { status: 400 }); };
  assert.equal((await dispatchNotifications(store, key, now, invalid)).failed, 1);
  assert.equal((await dispatchNotifications(store, key, now + 900_000, invalid)).failed, 0);
  assert.equal(calls, 1);
  assert.equal((await store.health(now)).failed, 1);
});

test('oversized provider response is cancelled and never stored or retried', async t => {
  const { db, store } = fixture(t);
  await store.commit([], [notification('oversized')]);
  let cancelled = false;
  let calls = 0;
  const huge: Fetcher = async () => {
    calls++;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(17 * 1024)); },
      cancel() { cancelled = true; },
    }));
  };
  assert.equal((await dispatchNotifications(store, key, now, huge)).ambiguous, 1);
  assert.equal(cancelled, true);
  assert.equal((await dispatchNotifications(store, key, now + 900_000, huge)).ambiguous, 0);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(db.sqlite.prepare('SELECT * FROM send_attempts').all()).length < 1024, true);
});

test('recreated store never repeats a reserved send after worker crash', async t => {
  const { db, store } = fixture(t);
  await store.commit([], [notification('crash')]);
  assert.ok(await store.reserveNotification(now));
  let calls = 0;
  const send: Fetcher = async () => { calls++; return Response.json({ code: 0 }); };
  const result = await dispatchNotifications(new Store(db), key, now + 120_001, send);
  assert.equal(result.sent, 0);
  assert.equal(calls, 0);
  assert.equal((await store.health(now)).ambiguous, 1);
  assert.equal((await store.health(now)).attemptsToday, 1);
});
