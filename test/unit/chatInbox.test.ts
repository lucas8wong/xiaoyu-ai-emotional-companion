/**
 * 微信式消息列表（方案 A2）：未读口径 + App 内主动消息落库
 *
 * 两件事分开测：
 *  1) `countUnread` —— 未读**只算角色说过的话**、且**老会话（无 chatLastReadAt）视为已读**
 *     （否则上线当天所有历史回复都会变成红点）；
 *  2) `appendInAppMessage` —— 角色主动说的一句要落进**它自己的会话**、并且**变成未读**，
 *     同时不能把该会话的历史一起变成未读。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();

const { default: memoryStorage, countUnread } = await import('../../api/storage/memory.js');
const { appendInAppMessage } = await import('../../api/services/reengage.js');

function seedSession(sessionId: string, userId: string, characterId: string, opts: { withRead?: number | null } = {}) {
  memoryStorage.createSession(sessionId);
  const base = Date.now() - 60_000;
  memoryStorage.updateSession(sessionId, {
    userId,
    characterId,
    chatTitle: '测试会话',
    chatMessages: [
      { role: 'user', content: '在吗', timestamp: new Date(base) },
      { role: 'assistant', content: '我在', timestamp: new Date(base + 1000) },
    ],
    chatUpdatedAt: new Date(base + 1000),
    ...(opts.withRead === null ? {} : { chatLastReadAt: opts.withRead }),
  });
  return sessionId;
}

test('countUnread：老会话（无 chatLastReadAt）= 已读，不产生假红点', () => {
  const s = memoryStorage.getSession(seedSession('s_legacy', 'u_legacy', 'xiaoyu'))!;
  assert.strictEqual(countUnread(s), 0);
});

test('countUnread：只算 chatLastReadAt 之后角色说的话（用户消息不计）', () => {
  const sid = seedSession('s_read', 'u_read', 'xiaoyu', { withRead: null });
  const s = memoryStorage.getSession(sid)!;
  s.chatLastReadAt = Date.now() + 10_000; // 已读到未来 → 全读完
  assert.strictEqual(countUnread(s), 0);

  s.chatLastReadAt = Date.now() - 120_000; // 早于两条消息 → 只有 assistant 那条算未读
  assert.strictEqual(countUnread(s), 1);

  s.chatMessages!.push({ role: 'user', content: '我回来了', timestamp: new Date() });
  assert.strictEqual(countUnread(s), 1, '用户自己的消息不该制造未读');
});

test('appendInAppMessage：写进该角色的会话、变成未读、历史不会被一起算成未读', () => {
  const userId = 'u_inapp';
  const sid = seedSession('s_inapp', userId, 'cc_xiaoyu2', { withRead: null });
  const before = memoryStorage.getSession(sid)!.chatMessages!.length;

  const ok = appendInAppMessage({
    userId, email: 'u@x.com', channel: 'inapp', feature: 'chat', intent: 'daily',
    contextRef: 't', recentText: '', deepLink: '', senderName: '阿岚',
    subjectKey: 'chat::cc_xiaoyu2', targetId: 'cc_xiaoyu2',
  }, '刚路过一家店，想起你上次说喜欢那个味道。');

  assert.strictEqual(ok, true);
  const s = memoryStorage.getSession(sid)!;
  assert.strictEqual(s.chatMessages!.length, before + 1, '落一条角色消息');
  assert.strictEqual(s.chatMessages![s.chatMessages!.length - 1].role, 'assistant');
  assert.strictEqual(countUnread(s), 1, '这条新消息就是未读的那一条');
  assert.ok(typeof s.chatLastReadAt === 'number' && s.chatLastReadAt > 0, '要给老会话补上已读时刻');
});

test('appendInAppMessage：该角色还没有任何会话 → 新建一条（只有主动消息也能形成窗口）', () => {
  const userId = 'u_inapp_new';
  const ok = appendInAppMessage({
    userId, email: 'u@x.com', channel: 'inapp', feature: 'chat', intent: 'daily',
    contextRef: 't', recentText: '', deepLink: '', senderName: '新角色',
    subjectKey: 'chat::cc_newchar', targetId: 'cc_newchar',
  }, '好久没见你了。');
  assert.strictEqual(ok, true);
  const mine = memoryStorage.getActiveSessions().filter(s => s.userId === userId);
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].characterId, 'cc_newchar');
  assert.strictEqual(countUnread(mine[0]), 1);
});

test('appendInAppMessage：空文本不落库（不能写出一条空消息）', () => {
  const userId = 'u_inapp_empty';
  const ok = appendInAppMessage({
    userId, email: 'u@x.com', channel: 'inapp', feature: 'chat', intent: 'daily',
    contextRef: 't', recentText: '', deepLink: '', senderName: 'X',
    subjectKey: 'chat::xiaoyu', targetId: 'xiaoyu',
  }, '   ');
  assert.strictEqual(ok, false);
  assert.strictEqual(memoryStorage.getActiveSessions().filter(s => s.userId === userId).length, 0);
});
