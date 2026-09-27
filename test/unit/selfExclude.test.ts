/**
 * selfExclude（运营自查 IP 自排除清单）单元测试
 * - normalizeIp：去首尾空白 / 去 ::ffff: 前缀
 * - add 幂等 / isExcluded / list 倒序 / remove
 * - addAndSave 落盘，重载后仍在清单
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeIp, SelfExcludeStore } from '../../api/services/selfExclude.js';

function tmpFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'selfexclude-')), name);
}

test('normalizeIp：去首尾空白 + 去 ::ffff: 前缀', () => {
  assert.strictEqual(normalizeIp('  203.0.113.5  '), '203.0.113.5');
  assert.strictEqual(normalizeIp('::ffff:203.0.113.5'), '203.0.113.5');
  assert.strictEqual(normalizeIp('::FFFF:9.9.9.9'), '9.9.9.9');
  assert.strictEqual(normalizeIp('2001:db8::1'), '2001:db8::1');
});

test('add 幂等 + isExcluded + list 倒序 + remove', () => {
  const store = new SelfExcludeStore(tmpFile('a.json'));
  assert.strictEqual(store.add('203.0.113.5'), true, '首次加入成功');
  assert.strictEqual(store.add('203.0.113.5'), false, '重复加入幂等');
  store.add('9.9.9.9');
  assert.strictEqual(store.isExcluded('::ffff:203.0.113.5'), true, '::ffff 前缀命中');
  assert.strictEqual(store.isExcluded('9.9.9.9'), true);
  assert.strictEqual(store.isExcluded('8.8.8.8'), false);
  const list = store.list();
  assert.strictEqual(list.length, 2);
  assert.ok(list[0].addedAt >= list[1].addedAt, '按加入时间倒序');
  assert.strictEqual(store.remove('203.0.113.5'), true);
  assert.strictEqual(store.isExcluded('203.0.113.5'), false);
  assert.strictEqual(store.remove('203.0.113.5'), false, '重复移除返回 false');
});

test('addAndSave 落盘：重载后仍在清单', () => {
  const file = tmpFile('b.json');
  const store = new SelfExcludeStore(file);
  store.addAndSave('12.34.56.78');
  const reloaded = new SelfExcludeStore(file);
  assert.strictEqual(reloaded.isExcluded('12.34.56.78'), true);
  assert.strictEqual(reloaded.list().length, 1);
});
