/**
 * Stripe webhook 幂等性单元测试（P1-02）
 * 直接调用 processStripeEvent（绕过 constructEvent 签名验证），
 * 用临时目录隔离 data/（不触碰真实数据）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd(); // 必须先于 import 任何 store

const { processStripeEvent } = await import('../../api/routes/payment.js');
const { quotaStore } = await import('../../api/services/quota.js');
const { paymentStore } = await import('../../api/services/payment.js');
const { subscriptionStore } = await import('../../api/services/subscription.js');
const { stripeEventStore } = await import('../../api/services/stripeEvents.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function checkoutEvent(id: string, over: Record<string, any> = {}): any {
  return {
    id,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_' + id,
        client_reference_id: 'user-' + id,
        metadata: { plan: 'plus', mode: 'payment', days: '30' },
        payment_status: 'paid',
        mode: 'payment',
        ...over,
      },
    },
  };
}

test('checkout.session.completed：首次解锁，重复投递（同 event.id）不重复解锁/建单', async () => {
  const userId = 'user-cs1';
  const ev = checkoutEvent('cs1');
  assert.strictEqual(await processStripeEvent(ev), true, '首次应处理成功');
  assert.ok(quotaStore.getQuota(userId).unlocked, '应解锁');
  const unlock1 = quotaStore.getQuota(userId).unlockUntil!;
  const orders1 = paymentStore.listAll().filter((o) => o.userId === userId);
  assert.strictEqual(orders1.length, 1, '应建 1 笔订单');
  assert.strictEqual(orders1[0].source, 'paid', '单次购买订单应为 paid（计入收入）');
  assert.strictEqual(paymentStore.revenueStats().ordersCount, 1, '单次购买应计入收入统计');

  // 同一 event.id 重复投递 2 次 → 幂等跳过
  assert.strictEqual(await processStripeEvent(ev), true);
  assert.strictEqual(await processStripeEvent(ev), true);
  assert.strictEqual(quotaStore.getQuota(userId).unlockUntil, unlock1, '重复投递不应再延长解锁');
  assert.strictEqual(paymentStore.listAll().filter((o) => o.userId === userId).length, 1, '不应重复建单');
});

test('checkout.session.completed（订阅模式）：建订阅 + 解锁，重复投递幂等', async () => {
  const ev = {
    id: 'ev-cs-sub1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_sub1',
        client_reference_id: 'user-cssub1',
        metadata: { plan: 'pro', mode: 'subscription' },
        payment_status: 'paid',
        mode: 'subscription',
        subscription: 'sub_cssub1',
        customer: 'cus_cssub1',
      },
    },
  };
  assert.strictEqual(await processStripeEvent(ev), true);
  const sub = subscriptionStore.get('sub_cssub1')!;
  assert.ok(sub && sub.currentPeriodEnd > Date.now(), '应建订阅记录');
  assert.ok(quotaStore.getQuota('user-cssub1').unlocked, '应解锁');
  const subOrder = paymentStore.listAll().find((o) => o.userId === 'user-cssub1');
  assert.ok(subOrder, '应建订阅订单');
  assert.strictEqual(subOrder?.source, 'free', '订阅订单标 free（经 MRR 单独计费，避免重复）');
  const unlock1 = quotaStore.getQuota('user-cssub1').unlockUntil!;
  assert.strictEqual(await processStripeEvent(ev), true, '重复投递应幂等');
  assert.strictEqual(quotaStore.getQuota('user-cssub1').unlockUntil, unlock1, '重复投递不重复解锁');
});

test('payment_status 非 paid：不解锁、不建单', async () => {
  const userId = 'user-cs2';
  const ev = checkoutEvent('cs2', { payment_status: 'unpaid' });
  assert.strictEqual(await processStripeEvent(ev), true, '跳过也应返回成功（ACK）');
  assert.ok(!quotaStore.getQuota(userId).unlocked, '未 paid 不应解锁');
  assert.strictEqual(paymentStore.listAll().filter((o) => o.userId === userId).length, 0, '不应建单');
});

test('解锁失败：抛错（路由层将返回 500 让 Stripe 重试），且不标记已处理', async () => {
  const orig = quotaStore.unlock.bind(quotaStore);
  quotaStore.unlock = () => { throw new Error('模拟解锁失败'); };
  try {
    const ev = checkoutEvent('cs3');
    await assert.rejects(processStripeEvent(ev), /模拟解锁失败/);
    assert.strictEqual(stripeEventStore.has('cs3'), false, '失败不应标记已处理（可重试）');
  } finally {
    quotaStore.unlock = orig;
  }
});

test('invoice.paid：按 Stripe 周期末续期（非处理时刻+30天），重复投递幂等', async () => {
  const now = Date.now();
  const prevEnd = now + 5 * 86400000; // 当期还剩 5 天
  subscriptionStore.upsert({
    id: 'sub-renew1', userId: 'user-sub1', plan: 'plus',
    stripeCustomerId: 'cus_1', status: 'active',
    currentPeriodEnd: prevEnd, cancelAtPeriodEnd: false,
    createdAt: now - 30 * 86400000, updatedAt: now,
  });
  const stripeEndSec = Math.floor((prevEnd + 30 * 86400000) / 1000);
  // 模拟首期支付已解锁：quota 与订阅周期对齐（真实流程中首期 checkout 会同时设置两者）
  quotaStore.unlock('user-sub1', Math.ceil((prevEnd - Date.now()) / 86400000));
  const ev = { id: 'ev-inv1', type: 'invoice.paid', data: { object: { subscription: 'sub-renew1', period_end: stripeEndSec } } };
  assert.strictEqual(await processStripeEvent(ev), true);

  const sub = subscriptionStore.get('sub-renew1')!;
  assert.strictEqual(sub.currentPeriodEnd, stripeEndSec * 1000, '周期末应与 Stripe 一致（±0ms）');
  const unlock1 = quotaStore.getQuota('user-sub1').unlockUntil!;
  assert.ok(Math.abs(unlock1 - (prevEnd + 30 * 86400000)) < 5000, '应基于原周期末延长约 30 天，实际差值 ' + Math.abs(unlock1 - (prevEnd + 30 * 86400000)));

  // 重复投递
  assert.strictEqual(await processStripeEvent(ev), true);
  assert.strictEqual(subscriptionStore.get('sub-renew1')!.currentPeriodEnd, stripeEndSec * 1000, '重复投递不推进周期');
  assert.strictEqual(quotaStore.getQuota('user-sub1').unlockUntil, unlock1, '重复投递不重复延长');
});

test('invoice.paid：本地无订阅记录 → 返回 false（路由 500 触发重试），不标记已处理', async () => {
  const ev = { id: 'ev-inv2', type: 'invoice.paid', data: { object: { subscription: 'sub-unknown', period_end: 123 } } };
  assert.strictEqual(await processStripeEvent(ev), false);
  assert.strictEqual(stripeEventStore.has('ev-inv2'), false, '失败不标记已处理');
});
