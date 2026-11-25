import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTempCwd } from '../unit/setup.js';

setupTempCwd();
process.env.PERSISTENCE_PROVIDER = 'sqlite';
const { dataFile, persistence, writeJsonStrict } = await import('../../api/storage/persistence.js');
const { featureUsageEvents: store } = await import('../../api/services/featureUsageEvents.js');
const event = (id: string) => ({ id, at: 123, userId: 'guest', action: 'rp.memory', outcome: 'completed' as const, httpStatus: 200 });

test('bounded pages preserve legacy coverage, order, ownership and durable idempotence', () => {
  const legacy = dataFile('feature-usage-events.json');
  writeJsonStrict(legacy, { since: 100, events: [event('old')] });
  const baseline = persistence.read(legacy);
  for (let i = 0; i < 257; i++) assert.equal(store.record(event(String(i))), true);
  assert.equal(store.record(event('old')), true);
  assert.equal(store.record(event('0')), true);
  assert.equal(persistence.read(legacy), baseline);
  assert.equal(JSON.parse(persistence.read(dataFile('feature-usage-page-1.json'))!).length, 1);
  const ledger = store.read();
  assert.equal(ledger.since, 100);
  assert.deepEqual(ledger.events.map(e => e.id), ['old', ...Array.from({ length: 257 }, (_, i) => String(i))]);

  const write = persistence.write;
  try {
    persistence.write = (file, data) => {
      if (file === dataFile('feature-usage-pages.json')) throw Error('index unavailable');
      write(file, data);
    };
    assert.equal(store.record(event('retry')), false);
    assert.deepEqual(store.read(), ledger);
  } finally { persistence.write = write; }
  assert.equal(store.record(event('retry')), true);
  store.reassignUser('guest', 'owner');
  assert.ok(store.read().events.every(e => e.userId === 'owner'));
  store.deleteUser('owner');
  assert.deepEqual(store.read(), { since: 100, events: [] });
  assert.equal(store.record(event('0')), true);
  assert.deepEqual(store.read().events, [event('0')]);
});
