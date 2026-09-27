import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const paymentSvc = await import('../../api/services/payment.js');
const { paymentStore } = paymentSvc;

test('创建订单：复用未过期同档订单，不同档位不复用', () => {
  const uid = 'p-reuse';
  const o1 = paymentStore.createOrder(uid, 'plus', 30);
  const o2 = paymentStore.createOrder(uid, 'plus', 30);
  assert.strictEqual(o1.orderId, o2.orderId, '同用户同档同天数应复用');
  const o3 = paymentStore.createOrder(uid, 'pro', 30);
  assert.notStrictEqual(o1.orderId, o3.orderId, '不同档位不应复用');
});

test('订单状态流转：pending → paid → unlocked', () => {
  const uid = 'p-flow';
  const o = paymentStore.createOrder(uid, 'plus', 30);
  assert.strictEqual(o.status, 'pending');

  assert.ok(paymentStore.confirmPaid(o.orderId, '微信备注 123'));
  assert.strictEqual(paymentStore.getOrder(o.orderId).status, 'paid');

  assert.ok(paymentStore.markUnlocked(o.orderId, Date.now() + 30 * 86400000));
  assert.strictEqual(paymentStore.getOrder(o.orderId).status, 'unlocked');
});

test('收入统计：只计已解锁付费订单', () => {
  const before = paymentStore.revenueStats().ordersCount;
  const uid = 'p-rev';
  const o = paymentStore.createOrder(uid, 'plus', 30);
  paymentStore.confirmPaid(o.orderId, '');
  paymentStore.markUnlocked(o.orderId, Date.now() + 30 * 86400000);

  const s = paymentStore.revenueStats();
  assert.strictEqual(s.ordersCount, before + 1, '解锁一单后计数应 +1');
  assert.ok(s.total > 0);
});

test('收入统计：免费开通单不计入付费笔数，单独计数（订单页口径分家）', () => {
  const before = paymentStore.revenueStats();
  const uid = 'p-free';
  const o = paymentStore.createOrder(uid, 'plus', 30);
  paymentStore.markFree(o.orderId);
  paymentStore.markUnlocked(o.orderId, Date.now() + 30 * 86400000);

  const s = paymentStore.revenueStats();
  assert.strictEqual(s.ordersCount, before.ordersCount, '免费开通不应增加「付费订单」笔数');
  assert.strictEqual(s.freeOrdersCount, before.freeOrdersCount + 1, '免费开通应单独计入 freeOrdersCount');
  assert.strictEqual(s.total, before.total, '免费开通不应影响付费收入合计');
});

test('定价配置：三币种结构完整', () => {
  const cfg = paymentStore.getConfig();
  assert.deepStrictEqual(cfg.currencyOrder, ['USD', 'HKD', 'CNY']);
  assert.ok(cfg.plans.plus.usd > 0);
  assert.ok(cfg.plans.pro.usd > cfg.plans.plus.usd);
  assert.ok(cfg.plans.plus.cny > 0);
});

test('配置下发微信收款码 URL：站内相对路径 + 内容哈希版本号（2026-09-26 收款码作为人工兜底回到用户侧）', () => {
  const cfg = paymentStore.getConfig();
  assert.ok(typeof cfg.payQrUrl === 'string' && cfg.payQrUrl.length > 0, 'config 应带 payQrUrl，实际 keys: ' + Object.keys(cfg).join(','));
  assert.ok(cfg.payQrUrl.startsWith('/pay-qr.jpg'), '默认应为站内 /pay-qr.jpg，实际: ' + cfg.payQrUrl);
  // 仓库里有 public/pay-qr.jpg ⇒ 应带上内容哈希版本（换图即换 URL，击穿 7 天静态缓存）
  assert.match(cfg.payQrUrl, /^\/pay-qr\.jpg\?v=[0-9a-f]{12}$/, '应带 12 位内容哈希版本号，实际: ' + cfg.payQrUrl);
});

test('年付/买断订单：固定天数 + 固定价 + 不与月付复用', () => {
  const uid = 'p-term';
  const yearly = paymentStore.createOrder(uid, 'plus', undefined, 'yearly');
  assert.strictEqual(yearly.days, 365, '年付应为 365 天');
  assert.ok(yearly.price > 0, '年付应有人民币价');
  const lifetime = paymentStore.createOrder(uid, 'plus', undefined, 'lifetime');
  assert.strictEqual(lifetime.days, 3650, '买断应为 3650 天');
  assert.ok(lifetime.price > yearly.price, '买断价应高于年付价');
  assert.notStrictEqual(yearly.orderId, lifetime.orderId, '不同购买方式不应复用订单');
  const monthly = paymentStore.createOrder(uid, 'plus', 30);
  assert.notStrictEqual(monthly.orderId, yearly.orderId, '月付与年付不应复用');
});

test('定价配置：年付/买断三币种下发 + offerEndsAt 可空', () => {
  const cfg = paymentStore.getConfig();
  const plus = cfg.plans.plus;
  const pro = cfg.plans.pro;
  assert.ok((plus.yearlyUsd ?? 0) > 0, 'Plus 应有年付 USD 价');
  assert.ok(plus.yearlyCny > 0 && plus.yearlyHkd > 0, 'Plus 年付应有三币种');
  assert.ok((plus.lifetimeUsd ?? 0) > plus.usd, '买断 USD 应高于月付');
  assert.ok(plus.lifetimeCny > plus.yearlyCny, '买断 CNY 应高于年付');
  assert.ok((pro.yearlyUsd ?? 0) > (plus.yearlyUsd ?? 0), 'Pro 年付应高于 Plus 年付');
  assert.ok(cfg.offerEndsAt === null || typeof cfg.offerEndsAt === 'string', 'offerEndsAt 应为 string 或 null');
});

test('结算币种：港澳 HKD / 内地 CNY / 其他 USD', () => {
  const { currencyForCountry: f } = paymentSvc;
  assert.strictEqual(f('香港'), 'hkd');
  assert.strictEqual(f('澳门'), 'hkd');
  assert.strictEqual(f('中国大陆'), 'cny');
  assert.strictEqual(f('美国'), 'usd');
  assert.strictEqual(f('未知'), 'usd');   // 无法识别 → 通用币种
  assert.strictEqual(f('本地/内网'), 'usd');
  assert.strictEqual(f('台湾'), 'usd'); // 台湾暂按通用币种
});

test('结算币种：各币种单价与连续包月价（与 Stripe 实扣同源）', () => {
  const { getPriceIn, getSubPriceIn, getPriceFor } = paymentSvc;
  // 月付单价 = 三币种月价
  for (const plan of ['plus', 'pro'] as const) {
    const p = getPriceFor(plan, 'monthly');
    assert.strictEqual(getPriceIn(plan, 'monthly', 'usd'), p.usd);
    assert.strictEqual(getPriceIn(plan, 'monthly', 'hkd'), p.hkd);
    assert.strictEqual(getPriceIn(plan, 'monthly', 'cny'), p.cny);
    // 年付/买断取对应固定价
    assert.strictEqual(getPriceIn(plan, 'yearly', 'hkd'), getPriceFor(plan, 'yearly').hkd);
    assert.strictEqual(getPriceIn(plan, 'lifetime', 'cny'), getPriceFor(plan, 'lifetime').cny);
  }
  // 连续包月：USD 用独立订阅价；HKD 按汇率折算；CNY 同折扣比例取整
  const subUsd = getSubPriceIn('plus', 'usd');
  const subHkd = getSubPriceIn('plus', 'hkd');
  const subCny = getSubPriceIn('plus', 'cny');
  assert.ok(subUsd > 0 && subUsd < getPriceFor('plus', 'monthly').usd, 'USD 订阅价应低于原价');
  assert.ok(Math.abs(subHkd - subUsd * 7.8) < 0.02, 'HKD 订阅价应按汇率折算');
  assert.ok(Number.isInteger(subCny) && subCny > 0 && subCny < getPriceFor('plus', 'monthly').cny, 'CNY 订阅价应为整数且低于原价');
});

test('定价配置下发 subCny（连续包月人民币价）', () => {
  const cfg = paymentStore.getConfig();
  assert.ok((cfg.plans.plus.subCny ?? 0) > 0, 'Plus 应下发 subCny');
  assert.ok((cfg.plans.pro.subCny ?? 0) > (cfg.plans.plus.subCny ?? 0), 'Pro 订阅价应高于 Plus');
});
