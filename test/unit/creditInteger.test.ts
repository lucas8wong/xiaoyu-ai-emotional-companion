import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const {
  UNIT_CREDIT: T,
  ACTION_PRICE_POINTS,
  WEREWOLF_GAME_TIAO,
  actionPricePoints,
  featureCostTiao,
  roundCreditToTiao,
  ceilCreditToTiao,
  floorCreditToTiao,
  quotaStore,
} = await import('../../api/services/quota.js');

/**
 * 回归背景（2026-09-17 用户拍板）：
 *   聊一聊等动作早已是「固定 N 条」的整数价目表，但**狼人杀仍按真实 token 用量多退少补**，
 *   结算值不是整条 → 用户余量出现小数 → 前端只能 `floor` 并在文案里写「≈ 还能聊 N 条」
 *   （同一类显示层裂缝就是当天那次「還能聊 Infinity 條」）。
 *   现在的硬性规则：**任何进出账本的点数都必须是 UNIT_CREDIT 的整数倍**；
 *   狼人杀照旧多退少补，但结算金额四舍五入到整条。
 *
 * ⚠️ 断言一律用 `UNIT_CREDIT` 相对表达（测试环境没有 .env，`UNIT_CREDIT` 会落到默认值），
 *    否则测试会把生产的具体单价（10）写死。
 */

test('整数硬性规则：价目表 / 狼人杀一局价 / 分模式单价 全是整条', () => {
  assert.ok(Number.isInteger(T) && T > 0);
  for (const [action, points] of Object.entries(ACTION_PRICE_POINTS)) {
    assert.strictEqual(points % T, 0, `${action} 必须是整条（${points} 点不是 ${T} 的整数倍）`);
    assert.ok(points >= T, `${action} 至少 1 条`);
  }
  assert.strictEqual((WEREWOLF_GAME_TIAO * T) % T, 0);
  for (const [mode, tiao] of Object.entries(featureCostTiao())) {
    assert.ok(Number.isInteger(tiao), `${mode} 的分模式单价必须是整数条（现在 ${tiao}）`);
  }
});

test('四舍五入到整条：狼人杀实耗 2.87 条 → 3 条（不是 2.87 条）', () => {
  assert.strictEqual(roundCreditToTiao(2.87 * T), 3 * T);
  assert.strictEqual(roundCreditToTiao(2.4 * T), 2 * T);
  assert.strictEqual(roundCreditToTiao(2.5 * T), 3 * T); // .5 向上
  assert.strictEqual(roundCreditToTiao(0), 0);
  assert.strictEqual(roundCreditToTiao(0.4 * T), 0); // 不足半条 → 0
  assert.strictEqual(roundCreditToTiao(0.5 * T), T); // 半条 → 1 条
  assert.strictEqual(roundCreditToTiao(-3 * T), 0, '负数一律夹到 0（不能倒扣用户）');
  assert.strictEqual(roundCreditToTiao(Number.NaN), 0);
  assert.strictEqual(roundCreditToTiao(Number.POSITIVE_INFINITY), 0, '无限不能被当成金额写进账本');
});

test('进出账本的点数恒为整条：0..200×UNIT_CREDIT 全扫一遍', () => {
  for (let p = 0; p <= 200 * T; p++) {
    for (const fn of [roundCreditToTiao, ceilCreditToTiao, floorCreditToTiao]) {
      assert.strictEqual(fn(p) % T, 0, `${fn.name}(${p}) 不是整条`);
    }
  }
});

test('预扣用 ceil（宁可多扣别穿底）、封顶用 floor（绝不超扣）、结算用 round', () => {
  assert.strictEqual(ceilCreditToTiao(2.01 * T), 3 * T);
  assert.strictEqual(ceilCreditToTiao(2 * T), 2 * T);
  assert.strictEqual(ceilCreditToTiao(1), T);
  assert.strictEqual(floorCreditToTiao(2.99 * T), 2 * T);
  assert.strictEqual(floorCreditToTiao(2 * T), 2 * T);
  assert.strictEqual(floorCreditToTiao(0.9 * T), 0);
  // 封顶场景：余额带历史残差（2.85 条）时，扣费不得超过它，且取整后仍是整条
  const capped = Math.min(roundCreditToTiao(2.87 * T), floorCreditToTiao(2.85 * T));
  assert.strictEqual(capped, 2 * T);
  assert.strictEqual(capped % T, 0);
});

test('狼人杀结算：预扣一局价 → 实耗四舍五入 → 差额退回，全程整条', () => {
  const preCharge = WEREWOLF_GAME_TIAO * T; // 一局价（整条）
  const charge = Math.max(0, Math.min(roundCreditToTiao(2.87 * T), preCharge));
  const refund = preCharge - charge;
  assert.strictEqual(charge, 3 * T);
  assert.strictEqual(refund, (WEREWOLF_GAME_TIAO - 3) * T);
  assert.strictEqual(charge % T, 0);
  assert.strictEqual(refund % T, 0);
});

test('端到端：聊 3 条 + 一局狼人杀之后，用户可见条数仍是精确整数', () => {
  const uid = 'credit-int-e2e';
  quotaStore.addCreditBonus(uid, 200 * T, 'test'); // 给足点数，避免免费档额度不足
  const before = quotaStore.getCreditQuota(uid);
  assert.strictEqual(before.creditRemain! % T, 0, '起始余量必须是整条');

  for (let i = 0; i < 3; i++) {
    const r = quotaStore.reserveCredit(uid, 'chat', { credit: actionPricePoints('chat') });
    assert.ok(r.ok && r.token, '聊一聊预扣应成功');
    quotaStore.settleCredit(uid, r.token!, actionPricePoints('chat'));
  }

  const reserve = quotaStore.reserveCredit(uid, 'werewolf', { credit: ceilCreditToTiao(2.87 * T) });
  assert.ok(reserve.ok && reserve.token, '狼人杀预扣应成功');
  quotaStore.settleCredit(uid, reserve.token!, roundCreditToTiao(2.87 * T)); // 多退少补 + 四舍五入到整条

  const after = quotaStore.getCreditQuota(uid);
  assert.strictEqual(after.creditRemain! % T, 0, '扣完仍必须是整条');
  assert.ok(Number.isInteger((after.creditRemain as number) / T), '剩余条数必须是整数 → 文案不必再写「≈」');
  // 3 条聊天 + 3 条狼人杀 = 6 条
  assert.strictEqual(before.creditRemain! - after.creditRemain!, 6 * T);
});
