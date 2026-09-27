import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { wenyouSavesStore, migrateRecord } = await import('../../api/services/wenyouSaves.js');

test('set/get：保存进度（不含 userId），带 updatedAt', () => {
  const saved = wenyouSavesStore.set('u1', {
    games: { s1: { hp: 10 } },
    slots: [{ id: 1 }],
    endings: { s1: ['good'] },
    stats: { runs: 1 },
  });
  assert.strictEqual(saved.updatedAt > 0, true);
  assert.strictEqual('userId' in saved, false, '返回中不应含 userId');

  const got = wenyouSavesStore.get('u1')!;
  assert.deepStrictEqual(got.games, { s1: { hp: 10 } });
  assert.deepStrictEqual(got.endings, { s1: ['good'] });
  assert.ok(got.updatedAt > 0);
});

test('set：默认值 + slots 上限 50', () => {
  const def = wenyouSavesStore.set('u2', { games: {}, slots: [], endings: {}, stats: undefined });
  assert.deepStrictEqual(def.games, {});
  assert.deepStrictEqual(def.slots, []);
  assert.deepStrictEqual(def.endings, {});

  const many = Array.from({ length: 60 }, (_, i) => ({ id: i }));
  const capped = wenyouSavesStore.set('u2', { games: {}, slots: many, endings: {}, stats: {} });
  assert.strictEqual(capped.slots.length, 50);
});

test('set：进行中局（games）上限 50，且仅保留对象', () => {
  const many: Record<string, unknown> = {};
  for (let i = 0; i < 60; i++) many[`scenario_${i}`] = { hp: i };
  const capped = wenyouSavesStore.set('u2', { games: many, slots: [], endings: {}, stats: {} });
  assert.strictEqual(Object.keys(capped.games).length, 50);

  // 非对象/数组丢弃为 {}
  const bad = wenyouSavesStore.set('u2', { games: [1, 2], slots: [], endings: {}, stats: {} });
  assert.deepStrictEqual(bad.games, {});
});

test('migrateRecord：旧版单条 save → games 映射（games 已有则保留 games）', () => {
  // 只有旧 save
  const legacy = migrateRecord({ userId: 'uLegacy', save: { v: 2, scenario: { id: 's1' }, state: { history: [], attributes: {} } }, slots: [], endings: {}, stats: {} });
  assert.deepStrictEqual(legacy.games, { s1: { v: 2, scenario: { id: 's1' }, state: { history: [], attributes: {} } } });
  assert.strictEqual('save' in legacy, false);

  // games 已存在 → 不用旧 save
  const hasGames = migrateRecord({ userId: 'uHas', games: { s2: { hi: 1 } }, save: { oops: 1 }, slots: [], endings: {}, stats: {} });
  assert.deepStrictEqual(hasGames.games, { s2: { hi: 1 } });
});

test('get：无记录返回 null；deleteByUser', () => {
  assert.strictEqual(wenyouSavesStore.get('nobody'), null);
  wenyouSavesStore.set('uDel', { games: { s1: {} }, slots: [], endings: {}, stats: {} });
  wenyouSavesStore.deleteByUser('uDel');
  assert.strictEqual(wenyouSavesStore.get('uDel'), null);
});
