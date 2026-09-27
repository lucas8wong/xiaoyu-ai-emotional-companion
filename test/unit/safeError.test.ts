import { test } from 'node:test';
import assert from 'node:assert';
import { safeError } from '../../api/services/safeError.js';

test('safeError：按 kind 返回用户友好文案，不泄露内部详情', () => {
  assert.strictEqual(safeError('ai'), '生成失败，请稍后重试');
  assert.strictEqual(safeError('payment'), '支付操作失败，请稍后重试');
  assert.strictEqual(safeError('image'), '图片处理失败，请稍后重试');
  assert.strictEqual(safeError('server'), '服务暂时不可用，请稍后重试');
  assert.strictEqual(safeError('generic'), '操作失败，请稍后重试');
  // 未知 kind 回退 generic
  assert.strictEqual((safeError as any)('hotdog'), '操作失败，请稍后重试');
});
