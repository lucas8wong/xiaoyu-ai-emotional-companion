import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, beijingDate, type NotificationInput } from '../src/store.js';
import { FakeD1 } from './fake-d1.js';

const now = Date.parse('2026-11-06T00:00:00Z');
function fixture(t: test.TestContext): { db: FakeD1; store: Store } {
  const db = new FakeD1();
  t.after(() => db.close());
  return { db, store: new Store(db) };
}
function notification(id: string, kind: NotificationInput['kind'] = 'signal'): NotificationInput {
  return { id, kind, title: 'ETF monitor', body: 'Synthetic fixture', createdAt: now, expiresAt: now + 86_400_000 };
}

test('state and deduplicated outbox commit atomically', async t => {
  const { db, store } = fixture(t);
  await store.commit([{ key: 'signal', value: { confirmed: 'low' } }], [notification('one')]);
  await store.commit([{ key: 'signal', value: { confirmed: 'low' } }], [notification('one')]);
  assert.deepEqual(await store.get('signal'), { confirmed: 'low' });
  assert.equal(await store.pendingCount(now), 1);
  assert.equal(await store.get('missing'), null);

  const invalid = { ...notification('bad'), kind: 'invalid' } as unknown as NotificationInput;
  await assert.rejects(store.commit([{ key: 'signal', value: { confirmed: 'hot' } }], [invalid]));
  assert.deepEqual(await store.get('signal'), { confirmed: 'low' });
  assert.equal(await store.pendingCount(now), 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM notifications').get()?.count, 1);
});

test('bars update adjusted history and valuation series remain separate', async t => {
  const { store } = fixture(t);
  await store.saveBars('SPYM', [
    { date: '2026-11-05', close: 50, adjustedClose: 49 },
    { date: '2026-11-04', close: 100, adjustedClose: 49 },
  ]);
  await store.saveBars('SPYM', [{ date: '2026-11-04', close: 100, adjustedClose: 48.5 }]);
  assert.deepEqual(await store.loadBars('SPYM'), [
    { date: '2026-11-04', close: 100, adjustedClose: 48.5 },
    { date: '2026-11-05', close: 50, adjustedClose: 49 },
  ]);
  assert.deepEqual(await store.loadBars('QQQM'), []);
  await assert.rejects(store.saveBars('SPYM', [{ date: '2026-11-06', close: 0, adjustedClose: 1 }]));
  const snapshot = { symbol: 'SPYM' as const, date: '2026-11-05', pe: 20, source: 'issuer', method: 'FY1', proxy: 'S&P 500' };
  await store.saveValuation(snapshot);
  await store.saveValuation({ ...snapshot, pe: 21 });
  await store.saveValuation({ ...snapshot, pe: 25, method: 'trailing' });
  const values = await store.loadValuations('SPYM');
  assert.equal(values.length, 2);
  assert.equal(values.find(value => value.method === 'FY1')?.pe, 21);
});

test('task leases exclude concurrent owners and protect against stale finish', async t => {
  const { db, store } = fixture(t);
  const other = new Store(db);
  assert.deepEqual(await Promise.all([store.acquireTask('analysis', now, 100), other.acquireTask('analysis', now, 100)]), [true, false]);
  assert.equal(await other.acquireTask('analysis', now + 101, 100), true);
  await store.finishTask('analysis', now + 102);
  assert.deepEqual(await other.taskStatus('analysis'), { attempts: 2, completed: false, leaseUntil: now + 201 });
  await other.finishTask('analysis', now + 103);
  assert.equal(await store.acquireTask('analysis', now + 300), false);
  assert.deepEqual(await store.taskStatus('analysis'), { attempts: 2, completed: true, leaseUntil: 0 });
});

test('failed or crashed tasks are limited to three total attempts', async t => {
  const { store } = fixture(t);
  assert.equal(await store.acquireTask('retry', now, 100), true);
  await store.failTask('retry', now + 1);
  assert.equal(await store.acquireTask('retry', now + 900_000, 100), false);
  assert.equal(await store.acquireTask('retry', now + 900_001, 100), true);
  assert.equal(await store.acquireTask('retry', now + 900_102, 100), true);
  await store.failTask('retry', now + 900_103);
  assert.equal(await store.acquireTask('retry', now + 1_800_103, 100), false);
  assert.equal((await store.taskStatus('retry'))?.attempts, 3);
  assert.equal(await store.taskStatus('none'), null);
});

test('task-guarded commit excludes expired prior owners atomically for state and outbox', async t => {
  const { db, store } = fixture(t);
  const nextOwner = new Store(db);
  await store.put('signal', 'initial');
  assert.equal(await store.commitForTask('analysis', [{ key: 'signal', value: 'unowned' }], [notification('unowned')]), false);
  assert.equal(await store.acquireTask('analysis', now, 100), true);
  assert.equal(await store.commitForTask('analysis', [{ key: 'signal', value: 'first' }], [notification('first')]), true);
  assert.equal(await nextOwner.acquireTask('analysis', now + 101, 100), true);
  assert.equal(await store.commitForTask('analysis', [{ key: 'signal', value: 'stale' }, { key: 'stale-created', value: true }], [notification('stale')]), false);
  assert.equal(await store.get('signal'), 'first');
  assert.equal(await store.get('stale-created'), null);
  assert.equal(await store.pendingCount(now), 1);
  assert.equal(await nextOwner.commitForTask('analysis', [{ key: 'signal', value: 'second' }], [notification('second')]), true);
  await nextOwner.finishTask('analysis', now + 102);
  assert.equal(await nextOwner.commitForTask('analysis', [{ key: 'signal', value: 'finished' }], [notification('finished')]), false);
  assert.equal(await store.get('signal'), 'second');
  assert.equal(await store.pendingCount(now), 2);
});

test('reservation survives restart and crashed send becomes terminal ambiguous', async t => {
  const { db, store } = fixture(t);
  await store.commit([], [notification('crash')]);
  const reserved = await store.reserveNotification(now);
  assert.ok(reserved);
  const restarted = new Store(db);
  assert.equal(await restarted.reserveNotification(now + 1), null);
  assert.equal(await restarted.reserveNotification(now + 120_001), null);
  // A late success cannot overwrite a send whose lease became uncertain.
  await store.finishNotification(reserved.attemptId, 'accepted', now + 120_002, 0);
  assert.deepEqual(await restarted.health(now), { date: '2026-11-06', attemptsToday: 1, pending: 0, accepted: 0, failed: 0, ambiguous: 1 });
});

test('expired notifications are not sent and Beijing budget date rolls at local midnight', async t => {
  const { store } = fixture(t);
  await store.commit([], [{ ...notification('expired'), expiresAt: now + 1 }]);
  assert.equal(await store.reserveNotification(now + 2), null);
  assert.equal(await store.pendingCount(now + 2), 0);
  assert.equal(beijingDate(Date.parse('2026-11-06T15:59:59Z')), '2026-11-06');
  assert.equal(beijingDate(Date.parse('2026-11-06T16:00:00Z')), '2026-11-07');
});
