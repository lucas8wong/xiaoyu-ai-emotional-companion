import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { feedbackStore } = await import('../../api/services/feedback.js');

test('add：默认类型/状态/奖励 + 字段裁剪', () => {
  const f = feedbackStore.add('u1', '建议', '这是一个很棒的功能建议', 'contact@x.com', '上下文');
  assert.match(f.id, /^fb/);
  assert.strictEqual(f.userId, 'u1');
  assert.strictEqual(f.status, 'pending');
  assert.strictEqual(f.reward, 0);
  assert.strictEqual(f.contact, 'contact@x.com');

  const blank = feedbackStore.add('u1', '', '内容');
  assert.strictEqual(blank.type, '其他', '空类型回退「其他」');

  const long = feedbackStore.add('u1', '建议', 'x'.repeat(2000));
  assert.strictEqual(long.content.length, 1000, 'content 裁剪到 1000');
});

test('setReward：采纳并发放奖励', () => {
  const f = feedbackStore.add('u1', '夸奖', '做得好');
  assert.strictEqual(feedbackStore.setReward(f.id, 10), true);
  const got = feedbackStore.get(f.id)!;
  assert.strictEqual(got.status, 'accepted');
  assert.strictEqual(got.reward, 10);

  assert.strictEqual(feedbackStore.setReward('no-such', 5), false, '不存在返回 false');
});

test('listAll 倒序 + removeByUser', () => {
  const before = feedbackStore.listAll().length;
  const a = feedbackStore.add('uSort', '建议', 'A');
  const b = feedbackStore.add('uSort2', '问题', 'B');

  const all = feedbackStore.listAll();
  assert.strictEqual(all.length, before + 2);
  assert.ok([a.id, b.id].includes(all[0].id), '最新两条应排在最前');

  feedbackStore.removeByUser('uSort');
  assert.strictEqual(feedbackStore.listAll().length, before + 1, '只移除 uSort 的反馈');
  assert.strictEqual(feedbackStore.listAll().some((x) => x.id === a.id), false);
  assert.strictEqual(feedbackStore.listAll().some((x) => x.id === b.id), true);
});
