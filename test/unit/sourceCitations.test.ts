import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCitations, createCitationFilter } from '../../api/services/chatSignal';

/**
 * 来源引用标记（2026-09-29 第四轮）：模型输出「[[n]]」声明「这句话引用的是速览第 n 条」。
 * 服务端必须①把它剥干净（用户看不到、绝不落盘，红线 6）②留着编号用于把出处挂到那条气泡。
 */

test('extractCitations：剥掉标记并给出编号 + 它在正文里的偏移', () => {
  // 中文正文里标记**连同它前面那个空格**一起剥掉（模型习惯写「…了 [[1]]，…」，只剥标记会留下空隙）
  const r = extractCitations('你好 [[3]] 再见');
  assert.equal(r.text, '你好 再见');
  assert.deepEqual(r.cites, [{ n: 3, at: 2 }]);
});

test('extractCitations：英文里不吞空格（只认中文标记前的空格）', () => {
  // 英文的「hello [[1]] world」两边空格都是正文，剥标记后是两个空格 —— 这是刻意的：
  // 中文规则照搬到英文会把「hello」和「world」粘起来，比多一个空格糟得多。
  const r = extractCitations('hello [[1]] world');
  assert.equal(r.text, 'hello  world');
});

test('extractCitations：没有标记时原样返回', () => {
  const r = extractCitations('普通回复，没有标记。');
  assert.equal(r.text, '普通回复，没有标记。');
  assert.deepEqual(r.cites, []);
  // 单层方括号不是标记（别把正文里的 [3] 吃掉）
  assert.equal(extractCitations('参考 [3] 的说法').text, '参考 [3] 的说法');
});

test('extractCitations：容忍空格写法、多个标记按出现顺序', () => {
  const r = extractCitations('第一句 [[ 2 ]]。\n\n第二句 [[11]]。');
  assert.equal(r.text, '第一句。\n\n第二句。');
  assert.deepEqual(r.cites.map((c) => c.n), [2, 11]);
  assert.equal(r.cites[0].at, 3);
  assert.equal(r.cites[1].at, r.text.length - 1, '第二句的标记在结尾');
});

test('createCitationFilter：标记被切成多个 delta 也剥得干净（流式不泄露）', () => {
  const f = createCitationFilter();
  assert.equal(f.feed('你好[['), '你好', '可能开头的尾巴先扣住');
  assert.equal(f.feed('3]]'), '', '完整标记到了就剥掉');
  assert.equal(f.feed(' 再见'), ' 再见');
  assert.equal(f.flush(), '');
});

test('createCitationFilter：标记被切成「[[1」+「]]」也不许泄露（2026-09-29 实测踩到的坑）', () => {
  const f = createCitationFilter();
  assert.equal(f.feed('周深过生日了[['), '周深过生日了');
  assert.equal(f.feed('1'), '', '半个标记（[[1）也必须继续扣住');
  assert.equal(f.feed(']]，粉丝很激动'), '，粉丝很激动');
  assert.equal(f.flush(), '');
});

test('createCitationFilter：切成「[[1]」+「]」也不许泄露（实测第二种切法）', () => {
  const f = createCitationFilter();
  assert.equal(f.feed('成都Tiffany道歉了[['), '成都Tiffany道歉了');
  assert.equal(f.feed('1]'), '', '少一个右括号也要继续扣住');
  assert.equal(f.feed(']，店里回应了'), '，店里回应了');
  assert.equal(f.flush(), '');
});

test('createCitationFilter：普通文本立刻放出；扣住的尾巴在 flush 时吐出', () => {
  const f = createCitationFilter();
  assert.equal(f.feed('普通文本'), '普通文本');
  const f2 = createCitationFilter();
  assert.equal(f2.feed('结尾有个 [['), '结尾有个 ');
  // 正文优先：扣住的那半个标记在流结束时**照原样吐出**（宁可留个半截 [[ ，也不吞掉可能的内容）
  assert.equal(f2.flush(), '[[');
});