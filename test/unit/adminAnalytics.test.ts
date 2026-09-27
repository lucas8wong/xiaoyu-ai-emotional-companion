/**
 * 控制台 AI 商业分析：数据聚合与提示词测试
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { buildAdminAnalyticsBundle, AI_ANALYST_SYSTEM_PROMPT } = await import('../../api/services/adminAnalytics.js');
const { paymentStore } = await import('../../api/services/payment.js');

test('AI 分析聚合：空数据返回完整结构（全零）', () => {
  const b = buildAdminAnalyticsBundle();
  assert.strictEqual(typeof b.generatedAt, 'number');
  assert.strictEqual(b.users.totalAccounts, 0);
  assert.strictEqual(b.users.totalQuotaRecords, 0);
  assert.deepStrictEqual(b.users.planDistribution, {});
  assert.strictEqual(b.users.unlockedNow, 0);
  assert.strictEqual(b.users.registered7d, 0);
  assert.strictEqual(b.users.active7d, 0);
  assert.strictEqual(b.users.active7dRegistered, 0);
  assert.strictEqual(b.users.active7dGuest, 0);
  assert.deepStrictEqual(b.usage30d, { chat: 0, structure: 0, roleplay: 0 });
  assert.strictEqual(b.payments.totalOrders, 0);
  assert.strictEqual(b.payments.revenueCny, 0);
  assert.strictEqual(b.payments.unlockedPaid, 0);
  assert.strictEqual(b.payments.unlockedFree, 0);
  assert.strictEqual(b.payments.realPayingUsers, 0);
  assert.deepStrictEqual(b.payments.byPlan, {});
  assert.deepStrictEqual(b.payments.subscriptions, { active: 0, canceled: 0, pastDue: 0 });
  assert.deepStrictEqual(b.geo, { byCountry: [], unknown: 0 });
  assert.strictEqual(b.visits.totalVisitors, 0);
  assert.strictEqual(b.visits.avgDaily30, 0);
  assert.strictEqual(b.visits.peakHour, null);
  assert.strictEqual(b.feedback.total, 0);
  assert.deepStrictEqual(b.feedback.byType, {});
});

test('AI 分析提示词：品牌红线与防编造约束齐全', () => {
  assert.ok(AI_ANALYST_SYSTEM_PROMPT.includes('禁止编造任何数字'), '应禁止编造数字');
  assert.ok(AI_ANALYST_SYSTEM_PROMPT.includes('gentle healing'), '应包含品牌定位');
  assert.ok(AI_ANALYST_SYSTEM_PROMPT.includes('陪伴而非治疗'), '应明确陪伴非治疗红线');
  assert.ok(AI_ANALYST_SYSTEM_PROMPT.includes('P0'), '应有优先级框架');
});

test('AI 分析聚合：免费开通的已解锁订单不计入收入', () => {
  // 真实付费订单（source = paid）
  const paid = paymentStore.createOrder('a-paid', 'plus', 30);
  paymentStore.confirmPaid(paid.orderId, '');
  paymentStore.markUnlocked(paid.orderId, Date.now() + 86400000);

  // 管理员免费开通订单（source = free，试用/赠送，不计入收入）
  const free = paymentStore.createOrder('a-free', 'plus', 30);
  paymentStore.confirmPaid(free.orderId, '');
  paymentStore.markUnlocked(free.orderId, Date.now() + 86400000);
  paymentStore.markFree(free.orderId);

  const b = buildAdminAnalyticsBundle();
  assert.strictEqual(b.payments.unlocked, 2, '已解锁订单数应包含免费开通（这是事实状态）');
  assert.strictEqual(b.payments.unlockedPaid, 1, '回传精确的已解锁付费订单数');
  assert.strictEqual(b.payments.unlockedFree, 1, '回传精确的已解锁免费开通订单数');
  assert.strictEqual(b.payments.realPayingUsers, 1, '去重后的真实付费用户数应为 1');
  assert.strictEqual(b.payments.revenueCny, paid.price, '收入只应等于真实付费订单金额，免费开通不计入');
  assert.strictEqual(b.payments.byPlan.plus?.count, 1, 'byPlan 只统计付费订单数');
  assert.strictEqual(b.payments.byPlan.plus?.revenueCny, paid.price, 'byPlan 收入只等于付费订单金额');
});
