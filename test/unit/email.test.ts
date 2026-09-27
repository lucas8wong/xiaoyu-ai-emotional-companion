import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
// 预算护栏测试：把每日上限压到 3，验证达到上限后拒绝（从而把额度留给关键邮件）。
// 必须在 import 前设置（email.js 在模块加载时读取该常量）。
process.env.MAIL_NONCRITICAL_DAILY_LIMIT = '3';
const { emailCodeStore, tryConsumeNonCriticalMail } = await import('../../api/services/email.js');

test('generate：返回 6 位数字，邮箱规整为小写', () => {
  const code = emailCodeStore.generate('User@Example.com', 'register');
  assert.match(code, /^\d{6}$/);
  assert.strictEqual(emailCodeStore.verify('USER@example.COM', 'register', code), true, '邮箱大小写不敏感');
});

test('verify：验证码一次性（成功即消费）', () => {
  const code = emailCodeStore.generate('a@b.com', 'register');
  assert.strictEqual(emailCodeStore.verify('a@b.com', 'register', code), true);
  assert.strictEqual(emailCodeStore.verify('a@b.com', 'register', code), false, '同一验证码只能验证一次');
});

test('verify：错误码/错误用途返回 false', () => {
  const code = emailCodeStore.generate('c@d.com', 'register');
  assert.strictEqual(emailCodeStore.verify('c@d.com', 'register', '000000'), false);
  assert.strictEqual(emailCodeStore.verify('c@d.com', 'reset', code), false, '用途不匹配');
});

test('generate：同邮箱同用途覆盖旧的（旧码失效）', () => {
  const first = emailCodeStore.generate('e@f.com', 'register');
  const second = emailCodeStore.generate('e@f.com', 'register');
  assert.notStrictEqual(first, second);
  assert.strictEqual(emailCodeStore.verify('e@f.com', 'register', first), false, '旧码已失效');
});

test('removeByEmail：按邮箱清除待用验证码（忽略大小写）', () => {
  const reg = emailCodeStore.generate('g@h.com', 'register');
  const reset = emailCodeStore.generate('g@h.com', 'reset');
  emailCodeStore.removeByEmail('G@H.COM');
  assert.strictEqual(emailCodeStore.verify('g@h.com', 'register', reg), false, 'register 码已被清除');
  assert.strictEqual(emailCodeStore.verify('g@h.com', 'reset', reset), false, 'reset 码已被清除');
});

test('peek：校验但不消费（供注册成功后才消费，失败不烧码）', () => {
  const code = emailCodeStore.generate('peek@example.com', 'register');
  assert.strictEqual(emailCodeStore.peek('peek@example.com', 'register', code), true, 'peek 应通过');
  assert.strictEqual(emailCodeStore.verify('peek@example.com', 'register', code), true, 'peek 不应消费，verify 仍成功');
  assert.strictEqual(emailCodeStore.peek('peek@example.com', 'register', code), false, '消费后 peek 应为 false');
});

test('tryConsumeNonCriticalMail：达到每日非关键上限后拒绝（关键邮件额度留空）', () => {
  // 上限在 import 前设为 3（见文件顶部）
  assert.strictEqual(tryConsumeNonCriticalMail(), true, '第 1 封可发');
  assert.strictEqual(tryConsumeNonCriticalMail(), true, '第 2 封可发');
  assert.strictEqual(tryConsumeNonCriticalMail(), true, '第 3 封可发');
  assert.strictEqual(tryConsumeNonCriticalMail(), false, '达到上限后应拒绝非关键邮件');
});
