/**
 * 控制台「会员到期」口径（services/memberExpiry.ts）单测。
 *
 * 背景（2026-09-18 用户报「控制台要可以看到所有用户的会员到什么时候过期」）：
 * 线上 85 个注册用户里有 44 个只有 7 天 Pro 体验（trialProUntil）、没有 unlockUntil，
 * 旧口径只看 unlockUntil → 控制台显示成「Pro 会员 + 到期 —」，等于看不到任何到期时间。
 * 这里把新口径的每条分支钉住，防止以后再退回「只看 unlockUntil」。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { expiryFieldsOf } from '../../api/services/memberExpiry.js';

const DAY = 86400000;
/** 固定「现在」，避免测试随时钟漂移 */
const NOW = Date.UTC(2026, 8, 18, 4, 0, 0);

test('会员有效期内：membership + 剩余天数（向上取整）', () => {
  const f = expiryFieldsOf({ plan: 'plus', unlockUntil: NOW + 30 * DAY }, NOW);
  assert.deepStrictEqual(f, { expiryKind: 'membership', expiryAt: NOW + 30 * DAY, daysLeft: 30, expiryState: 'active' });
  // 不足一天也算 1 天（「还剩不到 1 天」不该显示成 0）
  const h = expiryFieldsOf({ plan: 'plus', unlockUntil: NOW + 3600 * 1000 }, NOW);
  assert.strictEqual(h.daysLeft, 1);
  assert.strictEqual(h.expiryKind, 'membership');
});

test('到期时刻已过（含「正好到期」）：expired，且给出过期日', () => {
  const at = expiryFieldsOf({ plan: 'plus', unlockUntil: NOW }, NOW);
  assert.strictEqual(at.expiryKind, 'expired', '正好到期不应算会员中');
  assert.strictEqual(at.expiryState, 'expired');
  assert.strictEqual(at.expiryAt, NOW, '过期也要给日期（运营判断断了多久）');
  assert.strictEqual(at.daysLeft, null);
});

test('只有 7 天 Pro 体验：trial —— 这就是此前显示「到期 —」的那批用户', () => {
  const f = expiryFieldsOf({ plan: 'free', unlockUntil: null, trialProUntil: NOW + 5 * DAY }, NOW);
  assert.strictEqual(f.expiryKind, 'trial', '体验期必须算作「会员到期」');
  assert.strictEqual(f.daysLeft, 5);
  assert.strictEqual(f.expiryState, 'active');
  assert.strictEqual(f.expiryAt, NOW + 5 * DAY);
});

test('会员与体验同时有效：按会员到期算（真实到期日优先）', () => {
  const f = expiryFieldsOf({ plan: 'pro', unlockUntil: NOW + 10 * DAY, trialProUntil: NOW + 3 * DAY }, NOW);
  assert.strictEqual(f.expiryKind, 'membership');
  assert.strictEqual(f.daysLeft, 10);
});

test('会员已过期但体验还在：算 trial（当下真正生效的是体验）', () => {
  const f = expiryFieldsOf({ plan: 'plus', unlockUntil: NOW - 2 * DAY, trialProUntil: NOW + 4 * DAY }, NOW);
  assert.strictEqual(f.expiryKind, 'trial');
  assert.strictEqual(f.daysLeft, 4);
});

test('体验也过期且从未开通过会员：none', () => {
  const f = expiryFieldsOf({ plan: 'free', trialProUntil: NOW - DAY }, NOW);
  assert.deepStrictEqual(f, { expiryKind: 'none', expiryAt: 0, daysLeft: null, expiryState: 'none' });
});

test('买断（lifetime）：永久，不看剩余天数', () => {
  const f = expiryFieldsOf({ plan: 'lifetime', unlockUntil: NOW + 3650 * DAY }, NOW);
  assert.strictEqual(f.expiryKind, 'lifetime');
  assert.strictEqual(f.expiryState, 'active');
  assert.strictEqual(f.daysLeft, null);
});

test('空记录 / 游客：none（expiryAt=0，控制台据此把无到期排最后）', () => {
  for (const q of [undefined, null, {}, { plan: 'free' }]) {
    const f = expiryFieldsOf(q as never, NOW);
    assert.deepStrictEqual(f, { expiryKind: 'none', expiryAt: 0, daysLeft: null, expiryState: 'none' });
  }
});
