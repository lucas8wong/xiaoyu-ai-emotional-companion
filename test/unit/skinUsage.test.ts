/**
 * skinUsage 单元测试（用户当前皮肤统计）
 * - setSkin：记录/更新（last-write-wins）
 * - get / listAll / stats：聚合正确
 * - 持久化：写盘后新实例可重新加载
 * - 空 userId / 空 skin 忽略
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkinUsageStore } from '../../api/services/skinUsage.js';

function tmpFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skinusage-')), name);
}

test('setSkin：记录与更新（last-write-wins）', () => {
  const store = new SkinUsageStore(tmpFile('skin.json'));
  assert.strictEqual(store.get('u1'), undefined);

  const a = store.setSkin('u1', 'healing');
  assert.ok(a && a.skin === 'healing');

  const b = store.setSkin('u1', 'zen');
  assert.ok(b && b.skin === 'zen');
  assert.strictEqual(store.get('u1')?.skin, 'zen', '再上报同用户皮肤应覆盖为最新');
  // 记录数不因重复上报增长（同一身份只保留最近一次）
  assert.strictEqual(store.listAll().length, 1);
});

test('stats：按皮肤聚合', () => {
  const store = new SkinUsageStore(tmpFile('skin.json'));
  store.setSkin('u1', 'healing');
  store.setSkin('u2', 'healing');
  store.setSkin('u3', 'star');
  assert.deepStrictEqual(store.stats(), { healing: 2, star: 1 });
});

test('持久化：写盘后新实例可重新加载', () => {
  const file = tmpFile('skin.json');
  const store = new SkinUsageStore(file);
  store.setSkin('u1', 'candy');
  const reloaded = new SkinUsageStore(file);
  assert.strictEqual(reloaded.get('u1')?.skin, 'candy');
  assert.deepStrictEqual(reloaded.stats(), { candy: 1 });
});

test('空 userId / 空 skin 忽略', () => {
  const store = new SkinUsageStore(tmpFile('skin.json'));
  assert.strictEqual(store.setSkin('', 'healing'), null);
  assert.strictEqual(store.setSkin('u1', ''), null);
  assert.strictEqual(store.setSkin('  ', 'star'), null);
  assert.strictEqual(store.listAll().length, 0);
});
