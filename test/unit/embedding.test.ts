import { test } from 'node:test';
import assert from 'node:assert';
import { cosine } from '../../api/services/embedding.js';

test('cosine：同向/垂直/反向/长度不符/空', () => {
  assert.strictEqual(cosine([1, 0], [1, 0]), 1);
  assert.strictEqual(cosine([1, 0], [0, 1]), 0);
  assert.strictEqual(cosine([1, 0], [-1, 0]), -1);
  // 同等向量（非单位）点积 >1 时 clamp 到 1
  assert.strictEqual(cosine([1, 2, 3], [1, 2, 3]), 1);
  // 长度不一致 → 0
  assert.strictEqual(cosine([1, 2], [1, 2, 3]), 0);
  // 空 → 0
  assert.strictEqual(cosine([], []), 0);
  // 部分负点积被 clamp 到 -1
  assert.strictEqual(cosine([2, 2], [-2, -2]), -1);
});
