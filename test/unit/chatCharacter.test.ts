import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { chatCharacterStore, XIAOYU_CHARACTER } = await import('../../api/services/chatCharacter.js');

test('内置小愈：不可删除、永远排第一', () => {
  const list = chatCharacterStore.listForUser('u1');
  assert.strictEqual(list[0].id, 'xiaoyu');
  assert.strictEqual(list[0].name, XIAOYU_CHARACTER.name);
  assert.strictEqual(list[0].isDefault, true);

  const xiaoyu = chatCharacterStore.get('u1', 'xiaoyu');
  assert.strictEqual(xiaoyu?.id, 'xiaoyu');
  // 任意用户都能看到内置小愈
  assert.strictEqual(chatCharacterStore.get('u2', 'xiaoyu')?.id, 'xiaoyu');
  // 不可删除
  assert.strictEqual(chatCharacterStore.delete('u1', 'xiaoyu'), false);
});

test('create：生成 id、裁剪字段、默认名字', () => {
  const u = chatCharacterStore.create('u1', { name: '阿岚', identity: '他是谁', boundaries: '不说教', voice: '温柔' });
  assert.match(u.id, /^cc_/);
  assert.strictEqual(u.userId, 'u1');
  assert.strictEqual(u.name, '阿岚');
  assert.strictEqual(u.isDefault, false);
  assert.ok(u.createdAt > 0 && u.updatedAt > 0);

  // 超长字段被裁剪（identity/voice 走人设档上限 4000：剧情角色的人设来自剧本，2000 装不下会被静默截断）
  const long = chatCharacterStore.create('u1', { name: 'x'.repeat(2500), identity: 'i'.repeat(5000), voice: 'v'.repeat(5000) });
  assert.strictEqual(long.name.length, 2000, '名字应被裁剪到 2000');
  assert.strictEqual(long.identity.length, 4000, 'identity 应被裁剪到 4000');
  assert.strictEqual(long.voice.length, 4000, 'voice 应被裁剪到 4000');

  // 空名字回退「新角色」
  const blank = chatCharacterStore.create('u1', { name: '   ' });
  assert.strictEqual(blank.name, '新角色');
});

test('nameExists：同用户内忽略大小写、排除自身', () => {
  chatCharacterStore.create('u1', { name: '阿岚' });
  assert.strictEqual(chatCharacterStore.nameExists('u1', '阿岚'), true);
  assert.strictEqual(chatCharacterStore.nameExists('u1', '阿岚'), true);
  assert.strictEqual(chatCharacterStore.nameExists('u1', '阿 岚'), false, '内部空格应视为不同（只 trim 首尾）');
  assert.strictEqual(chatCharacterStore.nameExists('u2', '阿岚'), false, '跨用户不冲突');
  const own = chatCharacterStore.create('u1', { name: '专属' });
  assert.strictEqual(chatCharacterStore.nameExists('u1', '专属', own.id), false, '排除自身后不算重复');
});

test('update：更新字段、裁剪、更新时间', () => {
  const c = chatCharacterStore.create('u1', { name: '初名', voice: 'A' });
  const before = c.updatedAt;
  const updated = chatCharacterStore.update('u1', c.id, { name: '改名', voice: 'B'.repeat(10) });
  assert.ok(updated);
  assert.strictEqual(updated!.name, '改名');
  assert.strictEqual(updated!.voice, 'B'.repeat(10));
  assert.ok((updated!.updatedAt) >= before, 'updatedAt 应更新');

  // 空名字不应覆盖（保留原值）
  const kept = chatCharacterStore.update('u1', c.id, { name: '' });
  assert.strictEqual(kept!.name, '改名');
  // 不存在 → undefined
  assert.strictEqual(chatCharacterStore.update('u1', 'nope', { name: 'x' }), undefined);
});

test('用户隔离 + listForUser 按最近更新倒序', async () => {
  const a = chatCharacterStore.create('uA', { name: '甲' });
  await new Promise((r) => setTimeout(r, 3));
  const b = chatCharacterStore.create('uA', { name: '乙' });
  chatCharacterStore.create('uB', { name: '丙' });

  const listA = chatCharacterStore.listForUser('uA');
  assert.strictEqual(listA.length, 3, '小愈 + 2 个自定义');
  assert.strictEqual(listA[0].id, 'xiaoyu');
  // 后创建的在前（近更新倒序）
  assert.strictEqual(listA[1].id, b.id);
  assert.strictEqual(listA[2].id, a.id);

  // 归属校验：uB 取不到 uA 的角色
  assert.strictEqual(chatCharacterStore.get('uB', a.id), undefined);
  assert.strictEqual(chatCharacterStore.get('uA', b.id)?.id, b.id);
});

test('delete / deleteByUser', () => {
  const c = chatCharacterStore.create('u1', { name: '要删的' });
  assert.strictEqual(chatCharacterStore.delete('u1', c.id), true);
  assert.strictEqual(chatCharacterStore.delete('u1', c.id), false, '重复删除应返回 false');

  const keep = chatCharacterStore.create('uDel', { name: 'K' });
  chatCharacterStore.create('uDel', { name: 'K2' });
  chatCharacterStore.deleteByUser('uDel');
  assert.strictEqual(chatCharacterStore.get('uDel', keep.id), undefined);
  assert.strictEqual(chatCharacterStore.listForUser('uDel').length, 1, '只剩小愈');
});
