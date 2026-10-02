/**
 * Google 一键登录在账号层的单测：**无密码账号**的完整生命周期。
 *
 * 这些是真正的风险点，「没有密码的账号」是这个系统里第一次出现的形态，
 * 一旦 verifyPassword 对空散列返回 true，任何人都能用一个空密码登进 Google 账号。
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();

test('Google 建号：无密码账号不能被密码登录，且能按 googleSub / email 找回', async () => {
  const { accountStore } = await import('../../api/services/accounts.js');

  const created = accountStore.createOAuthAccount({
    email: 'OAuth-Tester@Gmail.com',
    googleSub: 'sub-aaa-111',
    username: '测试昵称',
  });
  assert.ok(created.user, '应能建号');
  const acc = created.user!;
  assert.strictEqual(acc.email, 'oauth-tester@gmail.com', '邮箱应统一小写');
  assert.strictEqual(acc.googleSub, 'sub-aaa-111');
  assert.deepStrictEqual(acc.providers, ['google']);
  assert.strictEqual(accountStore.hasPassword(acc), false, 'Google 账号不应有密码');

  // ★ 核心防线：空密码绝不能通过（否则 = 任何人可登入）
  assert.strictEqual(accountStore.verifyPassword(acc, ''), false, '空密码必须被拒');
  assert.strictEqual(accountStore.verifyPassword(acc, 'whatever'), false, '任意密码必须被拒');

  assert.strictEqual(accountStore.findByGoogleSub('sub-aaa-111')?.userId, acc.userId);
  assert.strictEqual(accountStore.findByEmail('OAUTH-TESTER@gmail.com')?.userId, acc.userId);
  assert.strictEqual(accountStore.findByGoogleSub('no-such-sub'), undefined);
});

test('Google 建号：邮箱已存在 / Google 账号已绑定时都要拒绝（不静默覆盖）', async () => {
  const { accountStore } = await import('../../api/services/accounts.js');
  assert.ok(accountStore.findByEmail('oauth-tester@gmail.com'), '前置：上一个用例已建号');

  const dupEmail = accountStore.createOAuthAccount({ email: 'oauth-tester@gmail.com', googleSub: 'sub-bbb-222' });
  assert.strictEqual(dupEmail.user, null, '同邮箱必须拒绝');
  assert.ok(dupEmail.error);

  const dupSub = accountStore.createOAuthAccount({ email: 'another@gmail.com', googleSub: 'sub-aaa-111' });
  assert.strictEqual(dupSub.user, null, '同 Google 子标识必须拒绝');
  assert.ok(dupSub.error);
});

test('绑定：邮箱注册的老账号可以绑 Google，密码登录不受影响', async () => {
  const { accountStore } = await import('../../api/services/accounts.js');

  const reg = accountStore.register({ username: '老用户', email: 'legacy@gmail.com', password: 'secret123' });
  assert.ok(reg.user, '前置：邮箱注册成功');
  const legacy = reg.user!;
  assert.strictEqual(accountStore.hasPassword(legacy), true);

  assert.strictEqual(accountStore.linkGoogle(legacy.userId, 'sub-legacy-999'), true);
  assert.strictEqual(accountStore.findByGoogleSub('sub-legacy-999')?.userId, legacy.userId);
  assert.deepStrictEqual(accountStore.getById(legacy.userId)?.providers, ['google']);
  // 绑 Google 不能动已有密码
  assert.strictEqual(accountStore.hasPassword(accountStore.getById(legacy.userId)!), true);
  assert.strictEqual(accountStore.verifyPassword(accountStore.getById(legacy.userId)!, 'secret123'), true);

  // 幂等：同一个 sub 再绑一次仍然成功
  assert.strictEqual(accountStore.linkGoogle(legacy.userId, 'sub-legacy-999'), true);
  // 该 sub 已被别人占用 → 拒绝
  const other = accountStore.register({ username: '另一人', email: 'other@gmail.com', password: 'secret123' });
  assert.ok(other.user);
  assert.strictEqual(accountStore.linkGoogle(other.user!.userId, 'sub-legacy-999'), false, '已被占用的 sub 不得改绑');
  // 已绑其它 sub 的账号不得被覆盖
  assert.strictEqual(accountStore.linkGoogle(legacy.userId, 'sub-different-000'), false, '不得静默改绑');
});

test('Google 账号可以在「找回密码」后获得密码（无密码账号的逃生口）', async () => {
  const { accountStore } = await import('../../api/services/accounts.js');
  const acc = accountStore.findByEmail('oauth-tester@gmail.com');
  assert.ok(acc);
  assert.strictEqual(accountStore.hasPassword(acc!), false);

  assert.strictEqual(accountStore.changePassword(acc!.userId, 'brand-new-pw'), true);
  const after = accountStore.getById(acc!.userId)!;
  assert.strictEqual(accountStore.hasPassword(after), true, '改密后应可密码登录');
  assert.strictEqual(accountStore.verifyPassword(after, 'brand-new-pw'), true);
  assert.strictEqual(accountStore.verifyPassword(after, 'wrong'), false);
});
