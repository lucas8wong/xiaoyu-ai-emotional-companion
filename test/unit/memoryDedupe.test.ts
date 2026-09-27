import { test } from 'node:test';
import assert from 'node:assert';
import { normalizeForDedupe, isSimilar, dedupeAgainst, filterDuplicates } from '../../api/services/memoryDedupe.js';

test('normalizeForDedupe：小写、去空白/标点、保留中日韩字符与数字字母', () => {
  assert.strictEqual(normalizeForDedupe('Hello, World!'), 'helloworld');
  assert.strictEqual(normalizeForDedupe('  我 想 自 杀...  '), '我想自杀');
  assert.strictEqual(normalizeForDedupe('你好，世界！'), '你好世界');
  assert.strictEqual(normalizeForDedupe('123 abc'), '123abc');
  assert.strictEqual(normalizeForDedupe(''), '');
  assert.strictEqual(normalizeForDedupe('  '), '');
});

test('isSimilar：相似文本为 true，不相干为 false，阈值控制', () => {
  assert.strictEqual(isSimilar('我喜欢猫', '我喜欢猫啊'), true);
  assert.strictEqual(isSimilar('天气晴朗', '天气很晴朗'), true);
  assert.strictEqual(isSimilar('今天天气不错', '我要去上学'), false);
  assert.strictEqual(isSimilar('完全不同的内容', '今天天气不错'), false);
});

test('dedupeAgainst：精确/包含/近义/无关', () => {
  assert.strictEqual(dedupeAgainst(['用户有一只猫'], '用户有一只猫'), true, '精确重复');
  assert.strictEqual(dedupeAgainst(['用户有一只猫'], '用户养了一只猫'), true, '轻微措辞差异（长公共子串兜底）');
  assert.strictEqual(dedupeAgainst(['用户有一只猫'], '今天天气很好'), false);
  assert.strictEqual(dedupeAgainst([], '任何内容'), false, '空 existing 不重复');
});

test('filterDuplicates：剔除与 existing 重复的候选', () => {
  const out = filterDuplicates(['用户有一只猫'], ['用户有一只猫', '用户养了一只猫', '今天心情好']);
  assert.deepStrictEqual(out, ['今天心情好']);
});
