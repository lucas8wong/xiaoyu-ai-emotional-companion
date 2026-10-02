import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { setupTempCwd } from './setup.js';

// 必须在 import 存储层之前切到临时目录（store 用 process.cwd() 定位 data/）
const tmp = setupTempCwd();

// 模拟「磁盘上已持久化的旧会话」：chatUpdatedAt 是 ISO 字符串（修复前 DATE_KEYS 漏掉该字段导致读回仍为字符串）
const oldSession = {
  sessionId: 's1',
  userId: 'u1',
  questions: [],
  chatMessages: [{ role: 'user', content: 'hi', timestamp: '2026-08-24T12:00:00.000Z' }],
  chatTitle: 'hi',
  chatUpdatedAt: '2026-08-24T12:12:03.156Z',
  createdAt: '2026-08-24T12:00:00.000Z',
  // updatedAt 必须用当前时间：getSession 按留存期（分层：登录账号 30 天 / 游客 7 天）判过期，
  // 固定老日期会让这个“读回应恢复 Date”的用例在 fixture 变旧后永远过期失败
  updatedAt: new Date().toISOString(),
};
fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'data', 'sessions.json'), JSON.stringify([oldSession]), 'utf-8');

const { memoryStorage } = await import('../../api/storage/memory.js');

test('chatUpdatedAt 从磁盘读回应为 Date（修复 DATE_KEYS 遗漏）', () => {
  const s = memoryStorage.getSession('s1');
  assert.ok(s, '会话 s1 应能读到');
  assert.ok(s!.chatUpdatedAt instanceof Date, 'chatUpdatedAt 应被 revive 为 Date，而非字符串');
});

test('新开聊天窗口发消息不应因旧会话 chatUpdatedAt 字符串而崩溃', () => {
  memoryStorage.createSession('s2');
  // 同一用户 u1 新开一个聊天会话并更新（触发按 chatUpdatedAt 排序，旧代码对字符串调 .getTime() 会抛错）
  assert.doesNotThrow(() => {
    memoryStorage.updateSession('s2', {
      userId: 'u1',
      chatMessages: [{ role: 'user', content: 'hello', timestamp: new Date() }],
      chatTitle: 'hello',
      chatUpdatedAt: new Date(),
    });
  });
});

test('排序对残留的字符串 chatUpdatedAt 也应有防御（toTime 兜底）', () => {
  const s = memoryStorage.getSession('s1')!;
  (s as any).chatUpdatedAt = '2026-08-24T12:12:03.156Z'; // 模拟极端残留字符串
  assert.doesNotThrow(() => {
    memoryStorage.updateSession('s2', { chatUpdatedAt: new Date() });
  });
});

test('置顶会话不受每用户会话上限清理影响（只淘汰未置顶的最旧会话）', () => {
  // 建 51 个会话（超过 MAX_CHAT_SESSIONS=50），第 51 次更新时触发清理：最旧的 pin-50 先被删
  for (let i = 0; i < 51; i++) {
    memoryStorage.createSession('pin-' + i);
    memoryStorage.updateSession('pin-' + i, {
      userId: 'u-pin',
      chatMessages: [{ role: 'user', content: 'm' + i, timestamp: new Date() }],
      chatTitle: 't' + i,
      chatUpdatedAt: new Date(Date.now() - i * 60000), // pin-0 最新，pin-50 最旧
    });
  }
  assert.strictEqual(memoryStorage.getSession('pin-50'), undefined, '未置顶的最旧会话应被自动清理');

  // 把当前最旧的 pin-49 置顶
  memoryStorage.updateSession('pin-49', { chatPinned: true, chatUpdatedAt: new Date(Date.now() - 49 * 60000) });

  // 再新增一个会话触发清理：应只删未置顶的最旧（pin-48），保留置顶的 pin-49
  memoryStorage.createSession('pin-new');
  memoryStorage.updateSession('pin-new', {
    userId: 'u-pin',
    chatMessages: [{ role: 'user', content: 'new', timestamp: new Date() }],
    chatTitle: 'new',
    chatUpdatedAt: new Date(),
  });
  const pinned = memoryStorage.getSession('pin-49');
  assert.ok(pinned && pinned.chatPinned, '置顶会话应被保留');
  assert.strictEqual(memoryStorage.getSession('pin-48'), undefined, '未置顶的最旧会话应被清理');
  const mine = memoryStorage.getActiveSessions().filter(s => s.userId === 'u-pin');
  assert.ok(mine.length <= 50, '会话总数不超过上限');

  // 清理测试会话，避免影响其他用例
  for (const s of memoryStorage.getActiveSessions().filter(s => s.userId === 'u-pin')) {
    memoryStorage.deleteSession(s.sessionId);
  }
});

test('活跃会话不因「创建满 7 天」被误删（P1-05：按最后活跃过期）', () => {
  const sid = 'active-old';
  memoryStorage.createSession(sid);
  const s = memoryStorage.getSession(sid)!;
  // 模拟 8 天前创建、1 分钟前仍活跃（getSession 每次读取会刷新 updatedAt，这里手动改回模拟）
  s.createdAt = new Date(Date.now() - 8 * 86400000);
  s.updatedAt = new Date(Date.now() - 60000);
  const got = memoryStorage.getSession(sid);
  assert.ok(got, '最近活跃的会话不应被过期删除');
  assert.strictEqual(got!.sessionId, sid);
  memoryStorage.deleteSession(sid);
});

test('最后活跃超过 7 天仍过期清理（P1-05）', () => {
  const sid = 'stale-old';
  memoryStorage.createSession(sid);
  const s = memoryStorage.getSession(sid)!;
  s.createdAt = new Date(Date.now() - 8 * 86400000);
  s.updatedAt = new Date(Date.now() - 8 * 86400000); // 8 天未活跃
  assert.strictEqual(memoryStorage.getSession(sid), undefined, '过期会话应被删除');
});

// 【留存期分层（2026-09-11 起）：登录账号 30 天 / 游客（设备身份）7 天】
const { accountStore } = await import('../../api/services/accounts.js');

/** 造一个「最后活跃 N 天前」的会话（userId 由调用方指定） */
function makeStaleSession(sid: string, userId: string, daysAgo: number): string {
  memoryStorage.createSession(sid);
  const s = memoryStorage.getSession(sid)!;
  s.userId = userId;
  s.updatedAt = new Date(Date.now() - daysAgo * 86400000);
  return sid;
}

test('登录账号：最后活跃 10 天前的会话仍保留（30 天保留期）', () => {
  const uid = accountStore.register({ username: 'ret30', email: 'ret30@example.com', password: 'pw123456' }).user!.userId;
  const sid = makeStaleSession('acct-10d', uid, 10);
  assert.ok(memoryStorage.getSession(sid), 'getSession 不应清理登录账号 10 天未活跃的会话');
  // 另一条清理路径：getActiveSessions → cleanupExpiredSessions 同样按 30 天判
  makeStaleSession('acct-10d-b', uid, 10);
  const kept = memoryStorage.getActiveSessions().some(s => s.sessionId === 'acct-10d-b');
  assert.ok(kept, 'getActiveSessions 不应清理登录账号 10 天未活跃的会话');
});

test('游客（设备身份）：最后活跃 10 天前仍按 7 天过期清理', () => {
  const sid = makeStaleSession('guest-10d', 'guest_not_registered', 10);
  assert.strictEqual(memoryStorage.getSession(sid), undefined, '未登录身份 10 天未活跃应被清理');
});

test('登录账号：超过 30 天仍过期清理', () => {
  const uid = accountStore.register({ username: 'ret40', email: 'ret40@example.com', password: 'pw123456' }).user!.userId;
  const sid = makeStaleSession('acct-40d', uid, 40);
  assert.strictEqual(memoryStorage.getSession(sid), undefined, '登录账号超过 30 天应被清理');
});
