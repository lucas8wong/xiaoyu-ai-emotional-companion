/**
 * roleplayLikes 单元测试（角色剧情剧本点赞）
 * - toggle：点赞/取消切换，计数与 getCounts 正确
 * - 持久化：写盘后新实例可重新加载
 * - deleteByUser：账户注销清理点赞
 * - reassignUser：游客点赞并入账号（同剧本去重，保留账号记录）
 */
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RoleplayLikeStore } from '../../api/services/roleplayLikes.js';

function tmpFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rplikes-')), name);
}

test('toggle：点赞/取消/计数', () => {
  const store = new RoleplayLikeStore(tmpFile('likes.json'));
  assert.strictEqual(store.getCount('s1'), 0);
  const a = store.toggle('u1', 's1');
  assert.deepStrictEqual(a, { liked: true, count: 1 });
  assert.strictEqual(store.isLiked('u1', 's1'), true);

  const b = store.toggle('u1', 's1');
  assert.deepStrictEqual(b, { liked: false, count: 0 });
  assert.strictEqual(store.isLiked('u1', 's1'), false);

  // 不同用户各一赞 → 计数 2，getCounts 汇总正确
  store.toggle('u1', 's1');
  store.toggle('u2', 's1');
  store.toggle('u2', 's2');
  assert.strictEqual(store.getCount('s1'), 2);
  assert.strictEqual(store.getCount('s2'), 1);
  assert.deepStrictEqual(store.getCounts(), { s1: 2, s2: 1 });
});

test('持久化：写盘后新实例可重新加载', () => {
  const file = tmpFile('likes.json');
  const store = new RoleplayLikeStore(file);
  store.toggle('u1', 's1');
  const reloaded = new RoleplayLikeStore(file);
  assert.strictEqual(reloaded.getCount('s1'), 1);
  assert.strictEqual(reloaded.isLiked('u1', 's1'), true);
});

test('deleteByUser：账户注销清理点赞', () => {
  const store = new RoleplayLikeStore(tmpFile('likes.json'));
  store.toggle('u1', 's1');
  store.toggle('u2', 's1');
  store.deleteByUser('u1');
  assert.strictEqual(store.getCount('s1'), 1);
  assert.strictEqual(store.isLiked('u1', 's1'), false);
  assert.strictEqual(store.isLiked('u2', 's1'), true);
});

test('reassignUser：游客点赞并入账号（去重）', () => {
  const store = new RoleplayLikeStore(tmpFile('likes.json'));
  store.toggle('guest', 's1');
  store.toggle('guest', 's2');
  store.toggle('account', 's1'); // 账号已赞过 s1 → 游客的 s1 记录丢弃
  store.reassignUser('guest', 'account');
  assert.strictEqual(store.getCount('s1'), 1, '同剧本点赞去重后计数不变');
  assert.strictEqual(store.getCount('s2'), 1, '游客独有的 s2 点赞并入账号');
  assert.strictEqual(store.isLiked('account', 's1'), true);
  assert.strictEqual(store.isLiked('account', 's2'), true);
  assert.strictEqual(store.isLiked('guest', 's1'), false, '游客旧记录已清空');
  assert.strictEqual(store.isLiked('guest', 's2'), false);
});
