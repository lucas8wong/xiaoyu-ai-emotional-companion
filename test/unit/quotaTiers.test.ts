/**
 * 分档额度文案（2026-09-27）：**游客 5 条/天；注册账号 20 条/天 + 注册再送 20 条**。
 *
 * 这里锁的是「数字从哪来、拿不到怎么办」两件事：
 *  - 数字只能由后端下发（`guestDailyCredit` / `freeDailyCredit` ÷ `unitCredit`），前端不写死；
 *  - 数字缺失时必须返回 `null`（调用方退回旧文案），**绝不能渲染出「undefined 条」**。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { quotaTierTiao, guestQuotaLineText } from '../../src/lib/quotaTiers';

/** 假 i18n：把 key 与参数拼成字符串，便于断言 key 选择与参数 */
const t = (key: string, vars?: Record<string, string | number>) => `${key}|${JSON.stringify(vars ?? {})}`;

test('quotaTierTiao：点数 → 条（游客 5 / 注册 20 / 赠送 20 / 自身上限 5）', () => {
  const tier = quotaTierTiao({
    unitCredit: 10,
    guestDailyCredit: 50,
    freeDailyCredit: 200,
    registerChatBonus: 20,
    creditDailyCap: 50,
  });
  assert.deepStrictEqual(tier, { g: 5, d: 20, b: 20, own: 5 });
});

test('quotaTierTiao：无限档（cap=null）→ own=null，但分档数字照给', () => {
  const tier = quotaTierTiao({ unitCredit: 10, guestDailyCredit: 50, freeDailyCredit: 200, creditDailyCap: null });
  assert.strictEqual(tier?.own, null);
  assert.strictEqual(tier?.g, 5);
  assert.strictEqual(tier?.d, 20);
});

test('quotaTierTiao：数字缺失 → null（调用方退回旧文案，绝不印 undefined 条）', () => {
  assert.strictEqual(quotaTierTiao(null), null, '整份 quota 都没有 → null');
  assert.strictEqual(quotaTierTiao({ unitCredit: 10, freeDailyCredit: 200 }), null, '缺游客档 → null');
  assert.strictEqual(quotaTierTiao({ unitCredit: 0, guestDailyCredit: 50, freeDailyCredit: 200 }), null, 'unitCredit 非法 → null');
});

test('quotaTierTiao：quota 缺数字时用支付配置兜底（两个来源同源）', () => {
  const tier = quotaTierTiao({ unitCredit: 10 }, { quota: { guestDailyCredit: 50, freeDailyCredit: 200 } });
  assert.strictEqual(tier?.g, 5);
  assert.strictEqual(tier?.d, 20);
});

test('guestQuotaLineText：有赠送走带 b 的句式，无赠送走简洁句式，数字缺失 → null', () => {
  const withBonus = guestQuotaLineText(
    t,
    { unitCredit: 10, guestDailyCredit: 50, freeDailyCredit: 200, registerChatBonus: 20 },
    null,
    3,
  );
  assert.match(withBonus!, /^guestQuotaLine\|/, '有赠送 → guestQuotaLine');
  assert.match(withBonus!, /"g":5/);
  assert.match(withBonus!, /"d":20/);
  assert.match(withBonus!, /"b":20/);
  assert.match(withBonus!, /"n":3/);

  const noBonus = guestQuotaLineText(
    t,
    { unitCredit: 10, guestDailyCredit: 50, freeDailyCredit: 200, registerChatBonus: 0 },
    null,
    0,
  );
  assert.match(noBonus!, /^guestQuotaLineNoBonus\|/, '无赠送 → 不带 b 的句式（不印「再送 0 条」）');
  assert.doesNotMatch(noBonus!, /"b":/);

  assert.strictEqual(guestQuotaLineText(t, { unitCredit: 10 }, null, 0), null, '拿不到数字 → null');
});
