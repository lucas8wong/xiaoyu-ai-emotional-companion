import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quotaChatRemain, quotaIsUnlimited } from '../../src/lib/quotaDisplay';

/**
 * 回归背景（2026-09-17 线上）：生产 `CREDIT_QUOTA_ENABLED=1`，Pro / 终身 / 7 天体验档
 * 在 `getCreditQuota()` 返回 `unlimited: true`（数值字段为 null），前端换算成 `Infinity`，
 * 又被直接插进 i18n 模板 → 繁中界面出现「額度剩餘 ≈ 還能聊 Infinity 條」。
 * 这里钉住两件事：① 无限档必须能被 `quotaIsUnlimited()` 认出来；② 有限档绝不能是无限。
 */

test('额度换算：统一点数口径按 creditRemain / unitCredit 折算', () => {
  assert.equal(quotaChatRemain({ creditEnabled: true, creditRemain: 20, unitCredit: 2 }), 10);
  assert.equal(quotaChatRemain({ creditEnabled: true, creditRemain: 21, unitCredit: 2 }), 10); // 向下取整
  assert.equal(quotaChatRemain({ creditEnabled: true, creditRemain: 7, unitCredit: 4 }), 1);
  assert.equal(quotaChatRemain({ creditEnabled: true, creditRemain: 5 }), 2); // 缺 unitCredit → 兜底 2
  assert.equal(quotaChatRemain({ creditEnabled: true, creditRemain: 5, unitCredit: 0 }), 2); // 0 也要兜底，不能除出 Infinity
});

test('额度换算：无限档（Pro / 终身 / 7 天体验）→ Infinity，且 quotaIsUnlimited 必须为真', () => {
  // 统一口径下的 Pro：后端用 unlimited:true + 数值 null 表达无限
  const proCredit = { creditEnabled: true, creditUnlimited: true, creditRemain: null, unitCredit: 2 };
  assert.equal(quotaChatRemain(proCredit), Infinity);
  assert.equal(quotaIsUnlimited(proCredit), true);

  // 旧口径（开关关闭）：plan=pro / lifetime 仍是无限制
  assert.equal(quotaIsUnlimited({ creditEnabled: false, plan: 'pro' }), true);
  assert.equal(quotaIsUnlimited({ creditEnabled: false, plan: 'free', lifetime: true }), true);
});

test('额度换算：quota 为 null（还没拿到额度）→ 按无限保守处理，由调用方先判 !quota', () => {
  assert.equal(quotaChatRemain(null), Infinity);
  assert.equal(quotaIsUnlimited(null), true);
});

test('额度换算：有限档绝不能被判成无限（否则会印出 Infinity，或反过来藏掉真实余额）', () => {
  assert.equal(quotaIsUnlimited({ creditEnabled: true, creditRemain: 0, unitCredit: 2 }), false);
  assert.equal(quotaIsUnlimited({ creditEnabled: true, creditRemain: 1, unitCredit: 2 }), false);
  // 个别脏数据：开了点数计费但既没 unlimited 也没余额 → 算 0 条，不能算无限
  assert.equal(quotaChatRemain({ creditEnabled: true }), 0);
  assert.equal(quotaIsUnlimited({ creditEnabled: true }), false);
  assert.equal(quotaIsUnlimited({ creditEnabled: false, plan: 'plus', chatLimitPerDay: 30, chatUsedToday: 4 }), false);
  assert.equal(quotaChatRemain({ creditEnabled: false, plan: 'plus', chatLimitPerDay: 30, chatUsedToday: 4 }), 26);
  assert.equal(quotaIsUnlimited({ creditEnabled: false, plan: 'free', chatFreeRemain: 3 }), false);
  assert.equal(quotaChatRemain({ creditEnabled: false, plan: 'free', chatFreeRemain: 3 }), 3);
});

test('额度换算：Plus 用超了也不能出现负数（负数插进文案会显示「还能聊 -2 条」）', () => {
  assert.equal(quotaChatRemain({ creditEnabled: false, plan: 'plus', chatLimitPerDay: 30, chatUsedToday: 31 }), 0);
});

test('额度换算：只有无限档的字符串形式才是 "Infinity"——文案插值前必须先问 quotaIsUnlimited', () => {
  // 这条断言就是线上 bug 的守卫：任何有限档都不该把 Infinity 印给用户
  const finite = [
    { creditEnabled: true, creditRemain: 12, unitCredit: 2 },
    { creditEnabled: true, creditRemain: 0, unitCredit: 2 },
    { creditEnabled: false, plan: 'plus' as const, chatLimitPerDay: 30, chatUsedToday: 0 },
    { creditEnabled: false, plan: 'free' as const, chatFreeRemain: 3 },
  ];
  for (const q of finite) {
    assert.notEqual(String(quotaChatRemain(q)), 'Infinity');
  }
});
