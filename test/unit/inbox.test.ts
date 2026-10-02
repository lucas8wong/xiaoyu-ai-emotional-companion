import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { inboxStore } = await import('../../api/services/inbox.js');
const { quotaStore } = await import('../../api/services/quota.js');

test('信箱：按 userId 隔离，各自只看得到自己的信', () => {
  inboxStore.add('alice', { kind: 'reward', rewardCount: 10, reason: 'feedback', body: '谢谢你的建议' });
  inboxStore.add('bob', { kind: 'reward', rewardCount: 5, reason: 'feedback', body: '收到' });
  const a = inboxStore.list('alice');
  const b = inboxStore.list('bob');
  assert.strictEqual(a.length, 1);
  assert.strictEqual(b.length, 1);
  assert.strictEqual(a[0].body, '谢谢你的建议');
  assert.strictEqual(b[0].body, '收到');
});

test('信箱：新在前 + 未读数 + 标记已读（单封 / 全部）', () => {
  const uid = 'carol';
  const first = inboxStore.add(uid, { rewardCount: 10, body: '第一封' })!;
  const second = inboxStore.add(uid, { rewardCount: 20, body: '第二封' })!;
  assert.deepStrictEqual(inboxStore.list(uid).map((l) => l.id), [second.id, first.id], '新信应排在最前');
  assert.strictEqual(inboxStore.unreadCount(uid), 2);

  // 只标一封：另一封仍未读
  assert.strictEqual(inboxStore.markRead(uid, first.id), 1);
  assert.strictEqual(inboxStore.list(uid).find((l) => l.id === first.id)!.read, true);
  assert.strictEqual(inboxStore.list(uid).find((l) => l.id === second.id)!.read, false);

  // 不传 id = 全部已读
  assert.strictEqual(inboxStore.markRead(uid), 0);
  assert.strictEqual(inboxStore.unreadCount(uid), 0);
});

test('信箱：别人的 id 标不动我的信（跨用户越权防护）', () => {
  const mine = inboxStore.add('dave', { rewardCount: 10, body: 'x' })!;
  inboxStore.add('erin', { rewardCount: 10, body: 'y' });
  assert.strictEqual(inboxStore.markRead('erin', mine.id), 1, 'dave 的信不该被 erin 标成已读');
  assert.strictEqual(inboxStore.list('dave')[0].read, false);
});

test('信箱：空 userId 不写信；正文截断到 500 字；无附言也留档', () => {
  assert.strictEqual(inboxStore.add('', { body: 'x' }), null, '空 userId 应返回 null');
  const long = 'a'.repeat(800);
  const letter = inboxStore.add('frank', { rewardCount: 0, body: long })!;
  assert.strictEqual(letter.body.length, 500);
  assert.strictEqual(letter.rewardCount, undefined, 'rewardCount=0 不该落成字段（前端按 0 处理）');
});

test('信箱：单用户最多保留 50 封（超出丢最旧）', () => {
  const uid = 'grace';
  for (let i = 0; i < 55; i++) inboxStore.add(uid, { rewardCount: i + 1, body: '第' + i });
  const list = inboxStore.list(uid);
  assert.strictEqual(list.length, 50);
  assert.strictEqual(list[0].body, '第54', '最新的那封必须还在');
  assert.ok(!list.some((l) => l.body === '第0'), '最早的应被挤掉');
});

test('信箱：注销清空该用户全部信件', () => {
  const uid = 'henry';
  inboxStore.add(uid, { rewardCount: 10, body: 'a' });
  inboxStore.add(uid, { rewardCount: 10, body: 'b' });
  inboxStore.removeByUser(uid);
  assert.strictEqual(inboxStore.list(uid).length, 0);
});

test('奖励弹窗：note 进 pendingReward，ack 只清弹窗不影响信箱里的信', () => {
  const uid = 'ivy';
  quotaStore.addBonus(uid, 10, 'feedback', '你的反馈很具体，这条已经采纳啦');
  const q = quotaStore.getQuota(uid);
  assert.strictEqual(q.pendingReward?.count, 10);
  assert.strictEqual(q.pendingReward?.note, '你的反馈很具体，这条已经采纳啦');

  // 后到的无附言奖励不会把还没读的附言冲掉
  quotaStore.addBonus(uid, 5, 'invite');
  assert.strictEqual(quotaStore.getQuota(uid).pendingReward?.note, '你的反馈很具体，这条已经采纳啦');
  assert.strictEqual(quotaStore.getQuota(uid).pendingReward?.count, 15);

  // 信与弹窗是两条命：ack 清待通知标记，信仍在信箱
  inboxStore.add(uid, { kind: 'reward', rewardCount: 10, reason: 'feedback', body: '你的反馈很具体，这条已经采纳啦' });
  quotaStore.consumeReward(uid);
  assert.strictEqual(quotaStore.getQuota(uid).pendingReward, null);
  assert.strictEqual(inboxStore.list(uid).length, 1);
});
