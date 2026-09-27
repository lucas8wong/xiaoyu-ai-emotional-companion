/**
 * 付费解锁 API 路由（用户侧：下单 / 确认 / 状态 / 配额 / 支付配置 + Stripe）
 * 运营端管理接口见 paymentAdmin.ts。
 */

import 'dotenv/config';

import express, { Router, type Request, type Response } from 'express';
import Stripe from 'stripe';
import { quotaStore, UNLOCK_DAYS_COUNT, REGISTER_CHAT_BONUS_COUNT, INVITE_BONUS_COUNT, INVITE_MAX, REFERRAL_INVITER_MIN_DAYS_COUNT, REFERRAL_YEARLY_CAP_DAYS_COUNT, REFERRAL_MONTHLY_BONUS_DAYS_COUNT, REFERRAL_NEW_ACCOUNT_BOOST_COUNT, REFERRAL_NEW_ACCOUNT_BOOST_DAYS_COUNT } from '../services/quota.js';
import { paymentStore, isPlanKey, isPurchase, getDaysFor, getPriceIn, getSubPriceIn, currencyForCountry, PAY_CURRENCY_CODE, type PlanKey, type Purchase, type PayCurrency } from '../services/payment.js';
import { lookupIp, getClientCountry, getClientIp } from '../services/geo.js';
import { resolveUserId, isRecordOwner } from '../services/session.js';
import { safeError } from '../services/safeError.js';
import { stripeEventStore } from '../services/stripeEvents.js';
import { accountStore } from '../services/accounts.js';
import { notifyNewOrderConfirm } from '../services/adminNotifier.js';

const router = Router();

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

let stripeClient: Stripe | null = null;
function getStripe(): Stripe {
  if (!stripeClient) {
    if (!STRIPE_SECRET_KEY) throw new Error('Stripe 未配置：请在 .env 设置 STRIPE_SECRET_KEY');
    stripeClient = new Stripe(STRIPE_SECRET_KEY);
  }
  return stripeClient;
}

function getUserId(req: Request): string {
  return resolveUserId(req);
}

/**
 * 创建付费订单（按档位定价；供运营侧人工核对/开通流程使用，用户侧支付走 Stripe）
 * POST /api/payment/order  { plan?: 'plus' | 'pro' }
 */
router.post('/order', async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  const plan: PlanKey = isPlanKey(req.body?.plan) ? req.body.plan : 'plus';
  // 购买方式：monthly（默认，days 可自定义 30/60/90）/ yearly / lifetime
  const purchase: Purchase = isPurchase(req.body?.purchase) ? req.body.purchase : 'monthly';
  const days = purchase === 'monthly' ? Number(req.body?.days) || UNLOCK_DAYS_COUNT : undefined;
  const order = paymentStore.createOrder(userId, plan, days, purchase);
  const termLabel = purchase === 'yearly' ? '年付' : purchase === 'lifetime' ? '买断' : '会员';
  res.json({
    success: true,
    data: {
      orderId: order.orderId,
      plan: order.plan,
      purchase: order.purchase || 'monthly',
      days: order.days || UNLOCK_DAYS_COUNT,
      price: order.price,
      unlockDays: order.days || UNLOCK_DAYS_COUNT,
      tip: `${plan === 'pro' ? 'Pro' : 'Plus'} ${termLabel} ${order.days || UNLOCK_DAYS_COUNT} 天 · ¥${order.price} · 订单号 ${order.orderId}`,
    }
  });
});

/**
 * 用户标记已付款
 * POST /api/payment/confirm  { orderId, remark }
 */
router.post('/confirm', async (req: Request, res: Response): Promise<void> => {
  const { orderId, remark } = req.body || {};
  if (!orderId) {
    res.status(400).json({ success: false, error: '缺少订单号' });
    return;
  }
  // 归属校验（防 IDOR）：只能确认自己的订单
  const existing = paymentStore.getOrder(orderId);
  if (!existing || !isRecordOwner(req, existing)) {
    res.status(404).json({ success: false, error: '订单无效或已过期，请重新下单', code: 'ORDER_INVALID' });
    return;
  }
  const order = paymentStore.confirmPaid(orderId, remark);
  if (!order) {
    res.status(400).json({ success: false, error: '订单无效或已过期，请重新下单', code: 'ORDER_INVALID' });
    return;
  }
  // 用户标记已付款 → 后台新增一条「待确认」订单，通知运营去控制台确认到账并解锁
  const buyer = accountStore.getById(order.userId);
  void notifyNewOrderConfirm(order, buyer ? { username: buyer.username, email: buyer.email } : undefined);
  res.json({
    success: true,
    data: {
      orderId: order.orderId,
      status: order.status,
      message: '已记录，管理员确认到账后会自动解锁（一般几分钟内），请稍后刷新页面',
    }
  });
});

/**
 * 查询订单状态（轮询解锁结果）
 * GET /api/payment/status/:orderId
 */
router.get('/status/:orderId', async (req: Request, res: Response): Promise<void> => {
  const order = paymentStore.getOrder(req.params.orderId);
  if (!order || !isRecordOwner(req, order)) {
    res.status(404).json({ success: false, error: '订单不存在' });
    return;
  }
  res.json({
    success: true,
    data: {
      orderId: order.orderId,
      status: order.status,
      unlockUntil: order.unlockUntil || null,
    }
  });
});

/**
 * 查询当前用户配额
 * GET /api/payment/quota
 */
router.get('/quota', async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  // 记录本用户（登录账号或游客）最近一次设备/IP，供引荐「设备/IP 不同」反套利比较
  try {
    quotaStore.noteDevice(userId, String(req.headers['x-device-id'] || ''), req.ip || '');
  } catch { /* 忽略 */ }
  const quota = quotaStore.getQuota(userId);
  // 到期前 3 天提醒（站内标记 + 邮件，每人只提醒一次；lifetime/剩余>3 天不触发）
  if (quota.unlocked && quota.unlockUntil) {
    const daysLeft = Math.max(0, Math.ceil((quota.unlockUntil - Date.now()) / 86400000));
    if (quotaStore.shouldRemindExpiry(userId, daysLeft)) {
      quotaStore.markExpiryReminded(userId);
      const { notifyExpiryReminder } = await import('../services/rewardNotifier.js');
      void notifyExpiryReminder(userId, daysLeft);
    }
  }
  /**
   * 推荐器预填：**最近 7 天的分模式日均用量**（用户自己看得到"我实际怎么用的"）。
   * 数据源 = 行为按日台账（与运营端「用户行为」同源），没用量时返回全 0 → 前端保持默认值。
   * 口径换算：剧情扮演回合 = roleplay 合计 − 文游回合 − 狼人杀局数（roleplay 是三模式合计桶）。
   */
  let usage7d: { chat: number; textgame: number; structure: number; werewolf: number } | null = null;
  try {
    const { behaviorDailyStore } = await import('../services/behaviorDaily.js');
    const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const to = new Date();
    const from = new Date(to.getTime() - 6 * 86400000);
    const cell = behaviorDailyStore.getUserRange(userId, day(from), day(to));
    if (cell) {
      const wenyou = cell.wenyou || 0;
      const werewolf = cell.werewolf || 0;
      const roleplayAlone = Math.max(0, (cell.roleplay || 0) - wenyou - werewolf);
      const avg = (n: number) => Math.round((n / 7) * 10) / 10;
      usage7d = {
        chat: avg((cell.chat || 0) + roleplayAlone),
        textgame: avg(wenyou),
        structure: avg(cell.structure || 0),
        werewolf: avg(werewolf),
      };
    }
  } catch { /* 取不到就不预填，前端保持默认 */ }

  // 邀请码补填（2026-09）：登录账号是否已填过预设邀请码 → 前端据此决定「有邀请码？补填」入口显不显示。
  // 游客 / 未登录账号一律 null（不给游客一个「填了也不算」的入口）。
  let inviteCode: string | null = null;
  try {
    const account = accountStore.getById(userId);
    if (account) inviteCode = quotaStore.getRecord(account.userId)?.inviteCodeUsed || null;
  } catch { /* 忽略：拿不到就不显示补填入口 */ }

  // 返回解析后的 userId：前端据此生成稳定的邀请链接（游客也能正确归因奖励）
  res.json({ success: true, data: { ...quota, userId, usage7d, inviteCode } });
});

/**
 * 确认已查看奖励通知（前端展示恭喜提示后调用，避免重复弹出）
 * POST /api/payment/reward/ack
 */
router.post('/reward/ack', async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  quotaStore.consumeReward(userId);
  res.json({ success: true, data: { message: 'ok' } });
});

/**
 * 支付配置（前端获取三币种定价/结算币种/天数）
 * GET /api/payment/config
 * data.pricing = { currencyOrder: ['USD','HKD','CNY'], fxUsdHkd, plans: { plus: {usd,hkd,cny}, pro: {...} } }
 * data.payCurrency = 'HKD' | 'CNY' | 'USD'（按访客 IP 判定的**结算币种**；前端只展示，实扣同源）
 */
router.get('/config', async (req: Request, res: Response): Promise<void> => {
  res.json({
    success: true,
    data: {
      ...paymentStore.getConfig(),
      pricing: paymentStore.getConfig(),
      // 结算币种：港澳 HKD / 内地 CNY / 其他 USD（服务端判定，前端展示与实际扣款同一口径）
      payCurrency: PAY_CURRENCY_CODE[currencyForCountry(lookupIp(getClientIp(req), getClientCountry(req)).country)],
      // 对外只返回通用能力标识，不暴露内部模型名（避免泄露技术栈、便于日后更换供应商）
      model: 'AI',
      // 邀请/注册奖励配置：前端文案据此显示真实数值（避免写死漂移）
      bonuses: {
        register: REGISTER_CHAT_BONUS_COUNT,
        invite: INVITE_BONUS_COUNT,
        inviteMax: INVITE_MAX,
        // 引荐（referral）推广：朋友经链接注册立刻 +invite；邀请人的奖励等「朋友首次真实使用」才结算
        // （B 方案 2026-09-19：门槛装在被邀人侧）；inviterMinDays 默认 0 = 不设邀请人年龄门槛
        referralInviterMinDays: REFERRAL_INVITER_MIN_DAYS_COUNT,
        referralYearlyCapDays: REFERRAL_YEARLY_CAP_DAYS_COUNT,
        referralMonthlyBonusDays: REFERRAL_MONTHLY_BONUS_DAYS_COUNT,
        // 新账号加成：邀请人注册 ≤ referralNewAccountBoostDays 天时额度 ×referralNewAccountBoost
        referralNewAccountBoost: REFERRAL_NEW_ACCOUNT_BOOST_COUNT,
        referralNewAccountBoostDays: REFERRAL_NEW_ACCOUNT_BOOST_DAYS_COUNT,
      },
    }
  });
});
/**
 * Stripe 支付：创建 Checkout 结账会话
 * 支持两种模式：
 *  - mode=subscription（连续包月，默认）：订阅价 + 可选手月试用价，周期 30 天自动续费
 *  - mode=payment（单次购买）：按天计价，一次买断 N 天
 *
 * 结算币种（2026-09-24）：按访客 IP 判定 —— 港澳 HKD / 内地 CNY / 其他 USD（服务端定，前端不传）。
 * 支付方式（2026-09-24）：**故意不传 `payment_method_types`** —— 走 Stripe 动态支付方式，
 *   让结账页把该币种/该客户**所有可用方式**都摆出来（卡、Link、Apple Pay、Google Pay，
 *   HKD/CNY 下还会有微信支付、支付宝）。一旦显式指定就会把其它方式全部关掉，故永不指定。
 * 取消回跳（2026-09-25）：cancel_url 带 `pay/plan/term/days`，前端还原付费弹窗（回到「选连续包月」那一屏）。
 * POST /api/payment/stripe/create-checkout  { plan, days?, mode? }
 */
router.post('/stripe/create-checkout', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    const plan: PlanKey = isPlanKey(req.body?.plan) ? req.body.plan : 'plus';
    const mode: 'subscription' | 'payment' = req.body?.mode === 'payment' ? 'payment' : 'subscription';
    const purchase: Purchase = isPurchase(req.body?.purchase) ? req.body.purchase : 'monthly';
    // 结算币种：由服务端按访客地区决定（港澳 HKD / 内地 CNY / 其他 USD）
    const currency: PayCurrency = currencyForCountry(lookupIp(getClientIp(req), getClientCountry(req)).country);
    // 续费延长档位：days 默认 30，支持 60/90（仅月付单次购买按比例）；年付/买断固定天数
    const days = purchase === 'monthly'
      ? Math.max(1, Math.min(365, Number(req.body?.days) || UNLOCK_DAYS_COUNT))
      : getDaysFor(purchase);
    const stripe = getStripe();
    const host = req.get('host') || 'myxiaoyu.com';
    const proto = req.protocol === 'http' && host.includes('localhost') ? 'http' : 'https';
    /**
     * 取消回跳（2026-09-25）：用户在 Stripe 结账页点「← 返回」时，要落回**他刚在选的那一屏**
     * （付费弹窗：连续包月 / 单次购买 + 档位 + 天数），而不是被丢回首页重新找入口。
     * cancel_url 只能靠 query 携带状态，前端 Home 据 `stripe=cancel&pay&plan&term&days` 还原弹窗。
     */
    const cancelQuery = new URLSearchParams({ stripe: 'cancel', pay: mode, plan, term: purchase });
    if (purchase === 'monthly') cancelQuery.set('days', String(days));
    const cancelUrl = proto + '://' + host + '/?' + cancelQuery.toString();
    const subPrice = getSubPriceIn(plan, currency);
    // 首月试用价：Stripe Coupon 实现（需在 Dashboard 建「首月一次性折扣」后配 .env STRIPE_FIRST_MONTH_COUPON）
    const STRIPE_FIRST_MONTH_COUPON = process.env.STRIPE_FIRST_MONTH_COUPON || '';

    if (mode === 'subscription') {
      // —— 连续包月：Stripe 订阅，每月自动扣款续期 ——
      const productName = (plan === 'pro' ? 'Xiaoyu Pro' : 'Xiaoyu Plus') + ' · Monthly Subscription';
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        managed_payments: { enabled: false },
        line_items: [{
          price_data: {
            currency,
            product_data: { name: productName },
            unit_amount: Math.round(subPrice * 100),
            recurring: { interval: 'month' },
          },
          quantity: 1,
        }],
        discounts: STRIPE_FIRST_MONTH_COUPON ? [{ coupon: STRIPE_FIRST_MONTH_COUPON }] : undefined,
        success_url: proto + '://' + host + '/?stripe=success&mode=subscription',
        cancel_url: cancelUrl,
        client_reference_id: userId,
        metadata: { userId, plan, mode: 'subscription', currency },
        subscription_data: {
          metadata: { userId, plan },
        },
      });
      res.json({ success: true, data: { url: session.url, sessionId: session.id, plan, mode: 'subscription', currency: PAY_CURRENCY_CODE[currency] } });
      return;
    }

    // —— 单次购买（月付按天比例；年付/买断固定价）——
    const priceBase = getPriceIn(plan, purchase, currency);
    const price = purchase === 'monthly'
      ? Math.round(priceBase * (days / UNLOCK_DAYS_COUNT) * 100) / 100
      : priceBase;
    const termLabel = purchase === 'yearly' ? '年付' : purchase === 'lifetime' ? '买断' : days + ' 天';
    const productName = (plan === 'pro' ? '小愈 Pro' : '小愈 Plus') + ' · AI 情感陪伴 · ' + termLabel;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      managed_payments: { enabled: false },
      line_items: [{
        price_data: {
          currency,
          product_data: { name: productName },
          unit_amount: Math.round(price * 100),
        },
        quantity: 1,
      }],
      success_url: proto + '://' + host + '/?stripe=success',
      cancel_url: cancelUrl,
      client_reference_id: userId,
      metadata: { userId, days: String(days), plan, mode: 'payment', purchase, currency },
    });
    res.json({ success: true, data: { url: session.url, sessionId: session.id, plan, mode: 'payment', currency: PAY_CURRENCY_CODE[currency] } });
  } catch (error) {
    console.error('Stripe checkout error:', error);
    res.status(500).json({ success: false, error: safeError('payment', error) });
  }
});

/**
 * Stripe Webhook：付款成功自动解锁（无需人工确认）
 * POST /api/payment/stripe/webhook
 *
 * 幂等：按 event.id 持久化去重（data/stripe-events.json，重启不丢），
 *       重复投递直接 ACK 跳过；处理失败返回 500 让 Stripe 重试（不标记已处理）。
 */
router.post('/stripe/webhook', express.raw({ type: '*/*' }), async (req: Request, res: Response): Promise<void> => {
  if (!STRIPE_WEBHOOK_SECRET) {
    res.status(400).json({ success: false, error: 'Stripe Webhook 未配置' });
    return;
  }
  let event: Stripe.Event;
  try {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody || req.body;
    event = getStripe().webhooks.constructEvent(rawBody, req.headers['stripe-signature'] as string, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook 签名验证失败:', err);
    res.status(400).send('Webhook signature verification failed');
    return;
  }

  let ok = false;
  try {
    ok = await processStripeEvent(event);
  } catch (err) {
    console.error('Stripe webhook 处理异常:', err);
  }
  if (!ok) {
    // 处理失败：返回 5xx，让 Stripe 按官方重试机制重新投递
    res.status(500).send('Webhook processing failed');
    return;
  }
  res.json({ received: true });
});

/**
 * 处理单个 Stripe 事件（幂等）。返回 false = 处理失败，调用方应回 5xx 让 Stripe 重试。
 * - 按 event.id 去重：已处理过直接返回 true。
 * - checkout.session.completed：仅 payment_status === 'paid' 才解锁（异步付款未到账不解锁）。
 * - invoice.paid：按 Stripe 周期末续期（不早于原周期末，防延迟投递缩短权益）；
 *                 本地无订阅记录时返回 false（触发重试 + 告警，避免续费未解锁）。
 * - 抛出异常 = 处理失败（不标记已处理）。
 */
export async function processStripeEvent(event: Stripe.Event): Promise<boolean> {
  if (stripeEventStore.has(event.id)) {
    console.log('ℹ️ [Stripe] 重复事件已处理过，跳过:', event.id);
    return true;
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    // 异步付款（部分钱包/银行转账）completed 时可能未到账：非 paid 不解锁，由 async_payment_succeeded 另行处理
    if (session.payment_status !== 'paid') {
      console.warn('ℹ️ [Stripe] checkout.session.completed 但 payment_status=' + (session.payment_status || 'unknown') + '，跳过解锁:', event.id);
      stripeEventStore.mark(event.id);
      return true;
    }
    const userId = session.client_reference_id || (session.metadata && session.metadata.userId) || '';
    const plan: PlanKey = isPlanKey(session.metadata?.plan) ? session.metadata.plan : 'plus';
    const mode = session.metadata?.mode || (session.mode === 'subscription' ? 'subscription' : 'payment');
    if (userId) {
      if (mode === 'subscription' && session.subscription) {
        // —— 连续包月首次扣款成功：建订阅记录 + 解锁 30 天 ——
        const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
        const { subscriptionStore } = await import('../services/subscription.js');
        const now = Date.now();
        const periodEnd = now + 30 * 86400000;
        subscriptionStore.upsert({
          id: subId, userId, plan,
          stripeCustomerId: typeof session.customer === 'string' ? session.customer : session.customer?.id,
          status: 'active',
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: false,
          createdAt: now, updatedAt: now,
        });
        const unlockUntil = quotaStore.unlock(userId, UNLOCK_DAYS_COUNT, plan);
        const order = paymentStore.createOrder(userId, plan);
        if (order) {
          paymentStore.markFree(order.orderId);
          paymentStore.markUnlocked(order.orderId, unlockUntil);
        }
        const { auditStore } = await import('../services/audit.js');
        // 被邀人首购 → 邀请人同档会员（封顶年付）；订阅不加「月付送半月」（避免与订阅续期冲突）
        const reward = quotaStore.rewardInviterForPurchase(userId, plan, 'monthly', UNLOCK_DAYS_COUNT);
        if (reward.inviter) console.log(`🎁 [Stripe] 被邀人首购 → 邀请人 ${reward.inviter.slice(0, 8)} +${reward.inviterDays} 天`);
        if (reward.reason) console.log(`ℹ️ [Stripe] 引荐奖励跳过: reason=${reward.reason}`);
        auditStore.log('stripe_subscribed', `Stripe 订阅 ${plan} 首期扣款成功：` + userId.slice(0, 8), '');
        console.log('✅ [Stripe] 订阅', plan, '首期解锁:', userId.slice(0, 8));
      } else {
        // —— 单次购买 ——
        const days = Math.max(1, Number(session.metadata && session.metadata.days) || UNLOCK_DAYS_COUNT);
        // 单次购买是真实付费（Stripe 收款）：订单标 paid 计入收入统计；
        // 连续包月订单为避免与 MRR 重复计费仍标 free（见订阅分支）。
        const purchase: Purchase = isPurchase(session.metadata?.purchase) ? session.metadata.purchase : 'monthly';
        // 被邀人首购 → 邀请人同档会员（封顶年付）；月付且引荐有效 → 被邀人 +半月
        const reward = quotaStore.rewardInviterForPurchase(userId, plan, purchase, days);
        const grantDays = days + reward.friendBonusDays;
        const unlockUntil = quotaStore.unlock(userId, grantDays, plan);
        const order = paymentStore.createOrder(userId, plan, days, purchase);
        if (order) {
          paymentStore.markUnlocked(order.orderId, unlockUntil);
        }
        const { auditStore } = await import('../services/audit.js');
        if (reward.inviter) console.log(`🎁 [Stripe] 被邀人首购 → 邀请人 ${reward.inviter.slice(0, 8)} +${reward.inviterDays} 天`);
        if (reward.friendBonusDays > 0) console.log(`🎁 [Stripe] 被邀人月付送半月: +${reward.friendBonusDays} 天`);
        auditStore.log('stripe_paid', `Stripe ${plan} 支付成功自动解锁：` + userId.slice(0, 8) + ' +' + grantDays + '天' + (reward.friendBonusDays > 0 ? '（含引荐+'+reward.friendBonusDays+'）' : ''), '');
        console.log('✅ [Stripe]', plan, '支付成功已解锁:', userId.slice(0, 8), '+', grantDays, '天');
      }
    } else {
      // 可观测性（复查 F2）：缺少用户标识时静默跳过会丢解锁，必须告警
      console.warn('⚠️ [Stripe] checkout.session.completed 缺少 userId（client_reference_id/metadata.userId），跳过解锁:', event.id);
    }
  }

  // —— 连续包月续费扣款成功：按 Stripe 周期续期（无感续费）——
  if (event.type === 'invoice.paid') {
    const invoice = event.data.object as Stripe.Invoice & { subscription?: string | { id?: string } | null };
    const subRef = invoice.subscription;
    const subId = typeof subRef === 'string' ? subRef : subRef?.id;
    if (subId) {
      const { subscriptionStore } = await import('../services/subscription.js');
      const sub = subscriptionStore.get(subId);
      if (!sub) {
        // 本地无订阅记录（重启丢失/从未建单）：返回 false 触发 Stripe 重试 + 告警，避免用户续费未解锁
        console.warn('⚠️ [Stripe] invoice.paid 但本地无订阅记录，返回 500 触发重试:', subId, event.id);
        return false;
      }
      const now = Date.now();
      const rawPeriodEnd = (invoice as unknown as { period_end?: number }).period_end;
      const stripePeriodEnd = rawPeriodEnd ? rawPeriodEnd * 1000 : 0;
      const prevEnd = sub.currentPeriodEnd || now;
      // 周期末以 Stripe 为准；延迟投递时不得早于原周期末（避免缩短用户权益）
      const periodEnd = Math.max(stripePeriodEnd || (prevEnd + 30 * 86400000), prevEnd);
      // 解锁天数 = 新周期末 - 旧周期末（按天四舍五入），至少 1 天
      const extraDays = Math.max(1, Math.round((periodEnd - prevEnd) / 86400000));
      sub.currentPeriodEnd = periodEnd;
      sub.status = 'active';
      sub.updatedAt = now;
      subscriptionStore.upsert(sub);
      quotaStore.unlock(sub.userId, extraDays, sub.plan);
      const { auditStore } = await import('../services/audit.js');
      auditStore.log('stripe_sub_renew', `Stripe 订阅 ${sub.plan} 续费成功：` + sub.userId.slice(0, 8), '');
      console.log('✅ [Stripe] 订阅续费', sub.plan, ':', sub.userId.slice(0, 8), '→', new Date(periodEnd).toISOString());
    }
  }

  // —— 订阅状态变更：取消预告 / 档位变化 / 删除 ——
  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const sub = event.data.object as Stripe.Subscription;
    const { subscriptionStore } = await import('../services/subscription.js');
    const existing = subscriptionStore.get(sub.id);
    if (existing) {
      const raw = sub as unknown as { status?: string; cancel_at_period_end?: boolean; current_period_end?: number };
      const st = raw.status;
      existing.status = (st === 'active' || st === 'trialing') ? 'active' : (st === 'canceled' || st === 'unpaid' || st === 'past_due' || st === 'incomplete' ? st as 'active' | 'past_due' | 'canceled' | 'incomplete' : existing.status);
      existing.cancelAtPeriodEnd = !!raw.cancel_at_period_end;
      if (raw.current_period_end) existing.currentPeriodEnd = raw.current_period_end * 1000;
      if (event.type === 'customer.subscription.deleted') existing.status = 'canceled';
      existing.updatedAt = Date.now();
      subscriptionStore.upsert(existing);
      // 取消后当期仍有效：不立即降级，仅标记；周期结束由前端/管理端按 currentPeriodEnd 判断
      console.log(`✅ [Stripe] 订阅状态更新: ${sub.id} → ${existing.status} (cancelAtPeriodEnd=${existing.cancelAtPeriodEnd})`);
    }
  }

  stripeEventStore.mark(event.id);
  return true;
}

/**
 * 订阅状态查询（用户侧）
 * GET /api/payment/subscription-status
 */
router.get('/subscription-status', async (req: Request, res: Response): Promise<void> => {
  const userId = resolveUserId(req);
  const { subscriptionStore } = await import('../services/subscription.js');
  const sub = subscriptionStore.getByUser(userId);
  if (!sub) {
    res.json({ success: true, data: { subscribed: false } });
    return;
  }
  res.json({
    success: true,
    data: {
      subscribed: sub.status !== 'canceled',
      plan: sub.plan,
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      daysLeft: Math.max(0, Math.ceil((sub.currentPeriodEnd - Date.now()) / 86400000)),
    },
  });
});

/**
 * 订阅管理入口：生成 Stripe Customer Portal 链接（用户自助取消/改卡）
 * POST /api/payment/stripe/portal
 */
router.post('/stripe/portal', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    const { subscriptionStore } = await import('../services/subscription.js');
    const sub = subscriptionStore.getByUser(userId);
    if (!sub || !sub.stripeCustomerId) {
      res.status(400).json({ success: false, error: '当前无订阅可管理' });
      return;
    }
    const stripe = getStripe();
    const host = req.get('host') || 'myxiaoyu.com';
    const proto = req.protocol === 'http' && host.includes('localhost') ? 'http' : 'https';
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: proto + '://' + host + '/?portal=back',
    });
    res.json({ success: true, data: { url: session.url } });
  } catch (error) {
    console.error('Stripe portal error:', error);
    res.status(500).json({ success: false, error: safeError('payment', error) });
  }
});

export default router;
