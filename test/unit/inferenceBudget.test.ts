import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withInferenceBudget, budgetedMaxTokens, recordInferenceCost, type InferenceBudget } from '../../api/services/inferenceBudget.js';

test('cold unrestricted story input cannot consume the entire first reply budget', async () => {
  const budget: InferenceBudget = { limitYuan: .1, spentYuan: 0, calls: 0 };
  const messages = [{ content: '故事上下文'.repeat(6000) }];
  await withInferenceBudget(budget, async () => {
    const tokens = budgetedMaxTokens('grok-4.20-0309-non-reasoning', messages, 4096);
    assert.equal(tokens, 4096);
    assert.ok(budget.inputAllowanceYuan! > budget.limitYuan);
    const firstAllowance = budget.inputAllowanceYuan;
    recordInferenceCost(firstAllowance! + .099);
    assert.throws(() => budgetedMaxTokens('grok-4.20', messages, 4096), /AI_BUDGET_EXHAUSTED/);
    assert.equal(budget.inputAllowanceYuan, firstAllowance);
    assert.ok(budget.spentYuan > budget.limitYuan, 'input cost stays in actual usage');
  });
});

test('low-balance first reply remains bounded and repeated prompts get no new allowance', async () => {
  const budget: InferenceBudget = { limitYuan: .02, spentYuan: 0, calls: 0, maxCalls: 2 };
  await withInferenceBudget(budget, async () => {
    const messages = [{ content: '剧情'.repeat(10000) }];
    const max = budgetedMaxTokens('grok-4.20', messages, 4096);
    assert.ok(max >= 192 && max < 4096);
    const allowance = budget.inputAllowanceYuan;
    recordInferenceCost(.001);
    budgetedMaxTokens('grok-4.20', [], 4096);
    assert.equal(budget.inputAllowanceYuan, allowance);
    assert.throws(() => budgetedMaxTokens('grok-4.20', [], 4096), /AI_BUDGET_EXHAUSTED/);
  });
  assert.equal(budgetedMaxTokens('grok-4.20', [], 4096), 4096);
});

test('concurrent turn allowances are isolated and unpriced models remain rejected', async () => {
  const a: InferenceBudget = { limitYuan: .02, spentYuan: 0, calls: 0 };
  const b: InferenceBudget = { limitYuan: .02, spentYuan: 0, calls: 0 };
  await Promise.all([
    withInferenceBudget(a, async () => { await Promise.resolve(); budgetedMaxTokens('grok-4.20', [{ content: '文'.repeat(10000) }], 4096); }),
    withInferenceBudget(b, async () => { budgetedMaxTokens('deepseek-v4-flash', [], 4096); }),
  ]);
  assert.ok(a.inputAllowanceYuan! > 0);
  assert.equal(b.inputAllowanceYuan, 0);
  await withInferenceBudget({ limitYuan: .1, spentYuan: 0, calls: 0 }, async () => {
    assert.throws(() => budgetedMaxTokens('unknown-model', [], 4096), /AI_BUDGET_MODEL_UNPRICED/);
  });
});
