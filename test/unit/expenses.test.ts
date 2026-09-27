import { test } from 'node:test';
import assert from 'node:assert';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { expenseStore } = await import('../../api/services/expenses.js');

test('add：uuid id、默认分类、金额取整、无效日期回退今天、note 裁剪', () => {
  const e = expenseStore.add('服务器', '一个月云服务器', 123.456, '2026-08-01');
  assert.ok(e.id);
  assert.strictEqual(e.category, '服务器');
  assert.strictEqual(e.amount, 123.46, '金额保留两位');
  assert.strictEqual(e.date, '2026-08-01');

  const badDate = expenseStore.add('其他', '无日期', 10, 'not-a-date');
  assert.match(badDate.date, /^\d{4}-\d{2}-\d{2}$/, '无效日期回退为今天');

  const blankCat = expenseStore.add('', '无分类', 5, '2026-08-01');
  assert.strictEqual(blankCat.category, '其他');

  const longNote = expenseStore.add('营销', 'x'.repeat(300), 1, '2026-08-01');
  assert.strictEqual(longNote.note.length, 200);
});

test('list：按日期倒序、同日期按 createdAt 倒序', () => {
  expenseStore.add('a', '早', 10, '2026-08-01');
  expenseStore.add('b', '晚', 20, '2026-08-03');
  expenseStore.add('c', '同早', 5, '2026-08-02');
  const list = expenseStore.list();
  const idx = (note: string) => list.findIndex((e) => e.note === note);
  assert.ok(idx('晚') < idx('同早'), '日期大的靠前');
  assert.ok(idx('同早') < idx('早'), '日期小的靠后');
});

test('total / remove', () => {
  const before = expenseStore.total();
  expenseStore.add('a', 'x', 10.555, '2026-08-01');
  expenseStore.add('b', 'y', 20, '2026-08-02');
  assert.ok(Math.abs(expenseStore.total() - before - 30.56) < 0.001, '新增 10.56+20 后总额应增加 30.56');

  const beforeCount = expenseStore.list().length;
  const e = expenseStore.add('c', 'z', 1, '2026-08-03');
  assert.strictEqual(expenseStore.remove(e.id), true);
  assert.strictEqual(expenseStore.remove(e.id), false);
  assert.strictEqual(expenseStore.list().length, beforeCount);
  assert.ok(Math.abs(expenseStore.total() - before - 30.56) < 0.001, '删除 1 元支出后总额回落');
});
