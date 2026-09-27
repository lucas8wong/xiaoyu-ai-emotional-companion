/**
 * 剧情「进入时用哪份消息」+ 历史形状校验的单测（2026-09-17）
 *
 * 钉住的是一条**真实造成线上缺陷**的规则：
 *   `setMessages(saved || [{ 开场白 }])` —— 因为 saved 实际是 `[]`（truthy），开场白被吞，
 *   第一次进没演过的剧情时剧情区一条消息都没有。
 * 所以这里必须覆盖「空数组 / null / 全脏数据」三种情况下**都要回落到开场白**。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { isUsableMessage, sanitizeMessages, pickInitialMessages, hasResumableSession, endsWithUnansweredTurn } from '../../src/lib/rpInitialMessages.js';

const OPENING = '凌晨的风带着点凉意。';
const good = (content: string, role: 'user' | 'assistant' = 'assistant') => ({ role, content });

test('pickInitialMessages：有非空存档 → 续演（原样返回，顺序不变）', () => {
  const saved = [good(OPENING), good('我想和你说说话。', 'user'), good('「我在。」')];
  const out = pickInitialMessages(saved, OPENING);
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out, saved);
});

test('pickInitialMessages：**空数组**要用开场白（2026-09-17 缺陷的回归守卫）', () => {
  const out = pickInitialMessages([], OPENING);
  assert.strictEqual(out.length, 1, '空存档必须回落到开场白，而不是空数组');
  assert.strictEqual(out[0].role, 'assistant');
  assert.strictEqual(out[0].content, OPENING);
});

test('pickInitialMessages：null / undefined → 开场白', () => {
  for (const v of [null, undefined]) {
    const out = pickInitialMessages(v, OPENING);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].content, OPENING);
  }
});

test('pickInitialMessages：全是脏数据 → 开场白（不能让脏数据把开场白顶掉）', () => {
  const dirty = [null, { role: 'assistant' }, { role: 'system', content: 'x' }, { role: 'user', content: 42 }, 'nope'];
  const out = pickInitialMessages(dirty, OPENING);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].content, OPENING);
});

test('pickInitialMessages：脏数据与好数据混在一起 → 只保留好数据（可续演）', () => {
  const mixed = [null, good('上次演到的地方'), { role: 'assistant' }];
  const out = pickInitialMessages(mixed, OPENING);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].content, '上次演到的地方');
});

test('pickInitialMessages：开场白不是字符串也不抛（内容类型兜底）', () => {
  const out = pickInitialMessages([], undefined as unknown as string);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].content, '');
});

test('sanitizeMessages：非数组一律返回空数组；元素逐个校验', () => {
  assert.deepStrictEqual(sanitizeMessages(null), []);
  assert.deepStrictEqual(sanitizeMessages('[]'), []);
  assert.deepStrictEqual(sanitizeMessages({ 0: good('x') }), []);
  assert.strictEqual(sanitizeMessages([good('a'), good('b', 'user')]).length, 2);
});

test('isUsableMessage：role 与 content 的边界', () => {
  assert.strictEqual(isUsableMessage(good('')), true, '空串 content 是合法的（开场白可能为空）');
  assert.strictEqual(isUsableMessage({ role: 'assistant', content: 'x' }), true);
  assert.strictEqual(isUsableMessage({ role: 'system', content: 'x' }), false);
  assert.strictEqual(isUsableMessage({ role: 'assistant' }), false);
  assert.strictEqual(isUsableMessage({ role: 'assistant', content: null }), false);
  assert.strictEqual(isUsableMessage({ role: 'assistant', content: ['a'] }), false);
  assert.strictEqual(isUsableMessage(undefined), false);
  assert.strictEqual(isUsableMessage('assistant'), false);
});

test('hasResumableSession：只有非空且可用才算「有进行中的剧情」', () => {
  assert.strictEqual(hasResumableSession(null), false);
  assert.strictEqual(hasResumableSession([]), false, '空数组 = 没有会话（详情页不该显示「继续剧情」）');
  assert.strictEqual(hasResumableSession([{ role: 'assistant' }]), false, '脏数据不算会话');
  assert.strictEqual(hasResumableSession([good('上次演到哪')]), true);
});

test('历史消息里的 versions/vi 等附加字段不因清洗丢失', () => {
  const m = { role: 'assistant' as const, content: 'v2', versions: ['v1', 'v2'], vi: 1, timestamp: 123 };
  const out = sanitizeMessages([m]);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0], m);
});

/**
 * 2026-09-18（用户 Twinkle 案）：会话尾部停在用户消息上 = 上一轮 AI 没接上。
 * 进剧情时必须认得出来（否则刷新后既无提示也无重试入口，那一句永远没人接）。
 */
test('endsWithUnansweredTurn：尾部是用户消息 → true（AI 没接上）', () => {
  assert.strictEqual(endsWithUnansweredTurn([good(OPENING), good('你怎么在这里', 'user')]), true);
  // 开场白就是**用户**消息（用户自建剧本可能这么写）也算：这一轮确实没人接
  assert.strictEqual(endsWithUnansweredTurn([good('我先开口', 'user')]), true);
});

test('endsWithUnansweredTurn：尾部是 AI 回复 / 空 / 脏数据 → false', () => {
  assert.strictEqual(endsWithUnansweredTurn([good('a', 'user'), good('b')]), false);
  assert.strictEqual(endsWithUnansweredTurn([]), false, '空会话要走开场白分支，不是「没接上」');
  assert.strictEqual(endsWithUnansweredTurn(null), false);
  assert.strictEqual(endsWithUnansweredTurn(undefined), false);
  // 尾部那条是脏数据 → 清洗后真正的尾部是 AI 回复 → 不算未完成
  assert.strictEqual(endsWithUnansweredTurn([good('a', 'user'), good('b'), { role: 'assistant' }]), false);
  assert.strictEqual(endsWithUnansweredTurn([good('a', 'user'), null]), true, '脏数据被剔掉后尾部仍是用户消息');
});
