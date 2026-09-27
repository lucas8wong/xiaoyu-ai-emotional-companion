import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { chatCharacterGrowthStore } = await import('../../api/services/chatCharacterGrowth.js');

const rec = (u: string, c: string) => chatCharacterGrowthStore.get(u, c);

test('get：无记录返回空档案', () => {
  const r = rec('uA', 'cEmpty');
  assert.deepStrictEqual(r.relationship, []);
  assert.deepStrictEqual(r.diary, []);
  assert.deepStrictEqual(r.reflections, []);
  assert.strictEqual(r.exchangeCount, 0);
});

test('addRelationship：去重、限长 120、裁剪到 40', () => {
  const u = 'uA', c = 'cRel';
  chatCharacterGrowthStore.addRelationship(u, c, ['她喜欢猫', '她喜欢猫', '她怕黑']);
  assert.strictEqual(rec(u, c).relationship.length, 2, '重复应去重');

  chatCharacterGrowthStore.addRelationship(u, c, ['x'.repeat(200)]);
  assert.strictEqual(rec(u, c).relationship.length, 2, '超 120 字的丢弃');

  for (let i = 1; i <= 45; i++) chatCharacterGrowthStore.addRelationship(u, c, ['rel' + i]);
  const r = rec(u, c);
  assert.strictEqual(r.relationship.length, 40);
  assert.strictEqual(r.relationship[0].text, 'rel6', '应丢弃最早的 5 条');
});

test('addDiary：非空追加、空忽略、裁剪到 30', () => {
  const u = 'uB', c = 'cDiary';
  chatCharacterGrowthStore.addDiary(u, c, '今天有点累');
  chatCharacterGrowthStore.addDiary(u, c, '   ');
  assert.strictEqual(rec(u, c).diary.length, 1);
  for (let i = 0; i < 35; i++) chatCharacterGrowthStore.addDiary(u, c, 'd' + i);
  assert.strictEqual(rec(u, c).diary.length, 30);
});

test('addReflection：追加 + 重置 exchangeCount + 记录 lastReflectAt', () => {
  const u = 'uC', c = 'cReflect';
  chatCharacterGrowthStore.bumpExchange(u, c);
  assert.strictEqual(rec(u, c).exchangeCount, 1);
  chatCharacterGrowthStore.addReflection(u, c, '反思A');
  const r = rec(u, c);
  assert.strictEqual(r.reflections.length, 1);
  assert.strictEqual(r.exchangeCount, 0, '反思后轮数清零');
  assert.ok(r.lastReflectAt > 0);
});

test('setSelfPortrait：设置自画像 + 成长历史，裁剪到 10', () => {
  const u = 'uD', c = 'cPortrait';
  chatCharacterGrowthStore.setSelfPortrait(u, c, '温柔的小愈');
  let r = rec(u, c);
  assert.strictEqual(r.selfPortrait!.text, '温柔的小愈');
  assert.strictEqual(r.portraitHistory!.length, 1);

  for (let i = 0; i < 12; i++) chatCharacterGrowthStore.setSelfPortrait(u, c, 'v' + i);
  r = rec(u, c);
  assert.strictEqual(r.portraitHistory!.length, 10, '自画像历史最多 10 条');
  assert.ok(r.lastPortraitAt > 0);
});

test('bumpExchange：firstChatAt/chatDays 记录', () => {
  const u = 'uE', c = 'cDay';
  assert.strictEqual(rec(u, c).firstChatAt, undefined);
  chatCharacterGrowthStore.bumpExchange(u, c);
  const after = rec(u, c);
  assert.ok(after.firstChatAt, '首次聊天时间被记录');
  assert.ok(after.chatDays!.length >= 1);
});

test('streakDays / milestone / reflectionDue / portraitDue / relationshipForPrompt', () => {
  const u = 'uF', c = 'cMisc';
  const before = rec(u, c);
  assert.strictEqual(chatCharacterGrowthStore.streakDays(before), 0);
  chatCharacterGrowthStore.bumpExchange(u, c);
  assert.strictEqual(chatCharacterGrowthStore.streakDays(rec(u, c)), 1);

  assert.strictEqual(chatCharacterGrowthStore.milestoneAtCount(30), 30);
  assert.strictEqual(chatCharacterGrowthStore.milestoneAtCount(29), null);
  assert.strictEqual(chatCharacterGrowthStore.milestoneClaimed(rec(u, c), 30), false);
  chatCharacterGrowthStore.claimMilestone(rec(u, c), 30);
  assert.strictEqual(chatCharacterGrowthStore.milestoneClaimed(rec(u, c), 30), true);

  // reflectionDue
  const r2 = rec(u, c);
  r2.exchangeCount = 5;
  assert.strictEqual(chatCharacterGrowthStore.reflectionDue(r2), false);
  r2.exchangeCount = 6;
  assert.strictEqual(chatCharacterGrowthStore.reflectionDue(r2), true);

  // portraitDue：3 条反思且无自画像
  for (let i = 0; i < 3; i++) chatCharacterGrowthStore.addReflection(u, c, 'r' + i);
  assert.strictEqual(chatCharacterGrowthStore.portraitDue(rec(u, c)), true);

  chatCharacterGrowthStore.addRelationship(u, c, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  assert.deepStrictEqual(chatCharacterGrowthStore.relationshipForPrompt(rec(u, c), 6), ['c', 'd', 'e', 'f', 'g', 'h']);
});

test('deleteByCharacter / deleteByUser', () => {
  const u = 'uG', c = 'cDel';
  chatCharacterGrowthStore.bumpExchange(u, c);
  assert.ok(rec(u, c).firstChatAt);
  chatCharacterGrowthStore.deleteByCharacter(u, c);
  assert.strictEqual(rec(u, c).firstChatAt, undefined, '删除后为默认空档案');

  chatCharacterGrowthStore.bumpExchange(u, c);
  chatCharacterGrowthStore.bumpExchange('uH', c);
  chatCharacterGrowthStore.deleteByUser('uH');
  assert.strictEqual(rec('uH', c).firstChatAt, undefined);
  assert.ok(rec(u, c).firstChatAt, '其它用户不受影响');
});
