import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { accountStore } = await import('../../api/services/accounts.js');

const LEGACY_ITERATIONS = 12000;

test('注册：邮箱/密码/重复邮箱校验（昵称不唯一，允许重名）', () => {
  const ok = accountStore.register({ username: 'alice', email: 'alice@example.com', password: 'secret1' });
  assert.ok(ok.user, '首次注册应成功');
  assert.strictEqual(ok.user.email, 'alice@example.com');

  assert.ok(!accountStore.register({ username: 'alice2', email: 'alice@example.com', password: 'secret1' }).user, '重复邮箱应失败');
  assert.ok(!accountStore.register({ username: 'bob', email: 'bob@example.com', password: '123' }).user, '密码过短应失败');
  assert.ok(!accountStore.register({ username: 'c', email: 'not-an-email', password: 'secret1' }).user, '非法邮箱应失败');
  // 昵称仅作展示名，允许与已有用户重名（唯一标识是 userId）
  assert.ok(accountStore.register({ username: 'alice', email: 'other@example.com', password: 'secret1' }).user, '用户名重复应允许（昵称不唯一）');
});

test('密码校验：正确/错误', () => {
  const r = accountStore.register({ username: 'carol', email: 'carol@example.com', password: 'pw123456' });
  assert.ok(r.user);
  assert.strictEqual(accountStore.verifyPassword(r.user, 'pw123456'), true);
  assert.strictEqual(accountStore.verifyPassword(r.user, 'wrong-pass'), false);
});

test('PBKDF2 旧散列登录后自动升级到更高强度', () => {
  const r = accountStore.register({ username: 'legacy', email: 'legacy@example.com', password: 'legacyPW1' });
  const u = r.user;
  // 模拟旧账户：仅 12000 次迭代的散列
  u.iterations = LEGACY_ITERATIONS;
  u.passwordHash = crypto.pbkdf2Sync('legacyPW1', u.salt, LEGACY_ITERATIONS, 64, 'sha256').toString('hex');

  assert.strictEqual(accountStore.verifyPassword(u, 'legacyPW1'), true, '旧散列应能通过校验');
  assert.ok((u.iterations || 0) > LEGACY_ITERATIONS, '校验通过后应升级迭代次数');
  assert.strictEqual(accountStore.verifyPassword(u, 'legacyPW1'), true, '升级后仍能校验');
});

test('会话 token：创建/校验/注销', () => {
  const r = accountStore.register({ username: 'dave', email: 'dave@example.com', password: 'pw123456' });
  const token = accountStore.createToken(r.user.userId);
  assert.ok(token);
  const user = accountStore.getTokenUser(token);
  assert.ok(user);
  assert.strictEqual(user.userId, r.user.userId);
  accountStore.revokeToken(token);
  assert.strictEqual(accountStore.getTokenUser(token), null);
});

test('改名：空/超长校验（重名允许）', () => {
  const r1 = accountStore.register({ username: 'eve', email: 'eve@example.com', password: 'pw123456' });
  accountStore.register({ username: 'frank', email: 'frank@example.com', password: 'pw123456' });
  assert.strictEqual(accountStore.rename(r1.user.userId, 'eve2').ok, true);
  assert.strictEqual(accountStore.rename(r1.user.userId, '   ').ok, false, '空昵称应失败');
  assert.strictEqual(accountStore.rename(r1.user.userId, 'frank').ok, true, '重名应允许（昵称不唯一）');
  assert.strictEqual(accountStore.rename(r1.user.userId, 'a'.repeat(21)).ok, false, '超 20 字应失败');
});
