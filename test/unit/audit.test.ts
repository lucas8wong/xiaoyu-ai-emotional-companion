import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { auditStore } = await import('../../api/services/audit.js');

test('log：记录 action/detail/ip 并裁剪字段', () => {
  auditStore.log('confirm_order', '这是超过两百字的一长串详情'.repeat(50), '1.2.3.4');
  const all = auditStore.listAll();
  assert.strictEqual(all.length, 1);
  const e = all[0];
  assert.match(e.id, /^au/);
  assert.strictEqual(e.action, 'confirm_order');
  assert.ok(e.detail.length <= 200, 'detail 应裁剪到 200');
  assert.ok(e.ip.length <= 50);
  assert.ok(e.createdAt > 0);
});

test('log：最多保留 200 条（丢弃最旧）', () => {
  for (let i = 0; i < 210; i++) auditStore.log('act' + i, 'd' + i, '');
  const all = auditStore.listAll();
  assert.strictEqual(all.length, 200);
  // 最新在前
  assert.strictEqual(all[0].action, 'act209');
});

test('listAll：按时间倒序', () => {
  const before = auditStore.listAll();
  auditStore.log('newer', 'x', '');
  const after = auditStore.listAll();
  assert.strictEqual(after[0].action, 'newer');
  assert.ok(after.length === before.length + 1 || after.length === 200);
});
