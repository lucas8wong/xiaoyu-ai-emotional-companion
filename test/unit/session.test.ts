import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { accountStore } = await import('../../api/services/accounts.js');
const { quotaStore } = await import('../../api/services/quota.js');
const { getAuthUser, resolveUserId, isLoggedIn, isRecordOwner } = await import('../../api/services/session.js');

function makeReq(over: Record<string, unknown> = {}) {
  return {
    headers: {},
    ip: '127.0.0.1',
    ...over,
  } as any;
}

test('getAuthUser：Bearer token 解析登录用户；无/非法 -> null', () => {
  const r = accountStore.register({ username: 'sess', email: 'sess@example.com', password: 'pw123456' });
  const token = accountStore.createToken(r.user.userId);

  const req = makeReq({ headers: { authorization: 'Bearer ' + token } });
  const user = getAuthUser(req);
  assert.ok(user);
  assert.strictEqual(user!.userId, r.user.userId);

  // 无 token
  assert.strictEqual(getAuthUser(makeReq()), null);
  // 非 Bearer
  assert.strictEqual(getAuthUser(makeReq({ headers: { authorization: 'Basic abc' } })), null);
  // token 已失效
  accountStore.revokeToken(token);
  assert.strictEqual(getAuthUser(makeReq({ headers: { authorization: 'Bearer ' + token } })), null);
});

test('resolveUserId：登录走账号 userId，游客走设备指纹+IP 哈希', () => {
  const r = accountStore.register({ username: 'sess2', email: 'sess2@example.com', password: 'pw123456' });
  const token = accountStore.createToken(r.user.userId);
  const loggedReq = makeReq({ headers: { authorization: 'Bearer ' + token } });
  assert.strictEqual(resolveUserId(loggedReq), r.user.userId);

  const guestReq = makeReq({ headers: { 'x-device-id': 'dev1' }, ip: '9.9.9.9' });
  const gid = resolveUserId(guestReq);
  assert.strictEqual(gid, quotaStore.identify('dev1', '9.9.9.9'));
  assert.match(gid, /^[0-9a-f]{32}$/);
});

test('isLoggedIn：有有效 Bearer 才 true', () => {
  const r = accountStore.register({ username: 'sess3', email: 'sess3@example.com', password: 'pw123456' });
  const token = accountStore.createToken(r.user.userId);
  assert.strictEqual(isLoggedIn(makeReq({ headers: { authorization: 'Bearer ' + token } })), true);
  assert.strictEqual(isLoggedIn(makeReq()), false);
});

test('isRecordOwner：空 userId 允许认领；需与当前用户一致', () => {
  const r = accountStore.register({ username: 'sess4', email: 'sess4@example.com', password: 'pw123456' });
  const token = accountStore.createToken(r.user.userId);
  const req = makeReq({ headers: { authorization: 'Bearer ' + token } });

  assert.strictEqual(isRecordOwner(req, { userId: undefined }), true, '未归属记录允许认领');
  assert.strictEqual(isRecordOwner(req, { userId: r.user.userId }), true);
  assert.strictEqual(isRecordOwner(req, { userId: 'someone-else' }), false);

  // 游客归属校验
  const guestReq = makeReq({ headers: { 'x-device-id': 'dev2' }, ip: '8.8.8.8' });
  const gid = resolveUserId(guestReq);
  assert.strictEqual(isRecordOwner(guestReq, { userId: gid }), true);
  assert.strictEqual(isRecordOwner(guestReq, { userId: 'other' }), false);
});
