import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTempCwd } from './setup.js';

setupTempCwd();
const { aiFailureStore } = await import('../../api/services/aiFailure.js');

test('AI 失败埋点：按日累计 + 区分「自动重试救回」', () => {
  const before = aiFailureStore.summary(1).total;
  aiFailureStore.record('roleplay', 'NETWORK', false); // 没救回来
  aiFailureStore.record('roleplay', 'TIMEOUT', true);  // 自动重试救回来了
  const s = aiFailureStore.summary(1);
  assert.equal(s.total, before + 2, '失败次数含被救回的那次（口径：所有「没接上」）');
  assert.equal(s.recovered, 1);
  assert.equal(s.total - s.recovered, before + 1, '用户实际看到失败提示的量 = 总数 − 救回');
  assert.equal(s.byCode.NETWORK, 1);
  assert.equal(s.byCode.TIMEOUT, 1);
  assert.equal(s.byFeature.roleplay, 2);
  assert.equal(s.days[0].total, before + 2, '今日桶');
});

test('AI 失败埋点：只存功能/原因码/时间，不存用户内容与 userId（隐私）', () => {
  aiFailureStore.record('chat', 'PARTIAL', false);
  const s = aiFailureStore.summary(7);
  const dump = JSON.stringify(s);
  assert.ok(!/userId|content|手机|邮箱|@/.test(dump), '埋点里不能出现用户内容/身份字段');
  assert.ok(s.recent.length > 0);
  assert.deepEqual(Object.keys(s.recent[0]).sort(), ['at', 'code', 'feature', 'recovered']);
});

test('AI 失败埋点：异常参数兜底为 UNKNOWN/other，不抛错', () => {
  assert.doesNotThrow(() => aiFailureStore.record('', '', false));
  const s = aiFailureStore.summary(1);
  assert.ok(s.byCode.UNKNOWN >= 1);
  assert.ok(s.byFeature.other >= 1);
});

test('AI 失败埋点：护栏类原因码（拦写保护）单独算，不计入「用户实际看到失败提示」', () => {
  const b = aiFailureStore.summary(1);
  aiFailureStore.record('roleplay', 'UNANSWERED_TURN', false); // 服务端拒写「未完成回合」：用户看不到任何提示
  aiFailureStore.record('roleplay', 'PARTIAL_UNCLOSED', false); // 真·截断：用户看得到「没写完 + 续写」
  const s = aiFailureStore.summary(1);
  assert.equal(s.guardTotal - b.guardTotal, 1, '护栏命中进 guardTotal');
  assert.equal(s.guardByCode.UNANSWERED_TURN - (b.guardByCode.UNANSWERED_TURN || 0), 1);
  assert.equal(s.days[0].guardTotal - b.days[0].guardTotal, 1, '单日护栏量由原因码现算（落盘结构没动，老数据零迁移）');
  assert.equal(s.total - b.total, 2, 'raw total 口径不变（含护栏，不改历史语义）');
  assert.equal(
    (s.total - s.recovered - s.guardTotal - s.truncatedTotal) - (b.total - b.recovered - b.guardTotal - b.truncatedTotal),
    0,
    '护栏类不计入「用户实际看到失败提示」（拦写保护时用户什么提示都看不到；同批的 PARTIAL_UNCLOSED 归截断类，见下一条）',
  );
});

test('AI 失败埋点：「回复被截断」类（PARTIAL*）单独算，同样不计入「用户看到失败提示」', () => {
  const b = aiFailureStore.summary(1);
  aiFailureStore.record('roleplay', 'PARTIAL_UNCLOSED', false); // 续写用尽上限仍半截：用户看到「没写完 · 续写」提示条
  aiFailureStore.record('roleplay', 'PARTIAL_LENGTH', false);   // 撞 max_tokens：同上
  const s = aiFailureStore.summary(1);
  assert.equal(s.truncatedTotal - b.truncatedTotal, 2, 'PARTIAL* 都归入截断类');
  assert.equal(s.truncatedByCode.PARTIAL_UNCLOSED - (b.truncatedByCode.PARTIAL_UNCLOSED || 0), 1);
  assert.equal(s.truncatedByCode.PARTIAL_LENGTH - (b.truncatedByCode.PARTIAL_LENGTH || 0), 1);
  assert.equal(s.days[0].truncatedTotal - b.days[0].truncatedTotal, 2, '单日分类量由原因码现算（零迁移）');
  assert.equal(s.guardTotal, b.guardTotal, '截断类不能混进护栏类');
  assert.equal(
    (s.total - s.recovered - s.guardTotal - s.truncatedTotal) - (b.total - b.recovered - b.guardTotal - b.truncatedTotal),
    0,
    '截断类与护栏类一样，都从「用户实际看到失败提示」里剔除',
  );
});

test('AI 失败埋点：summary 天数参数有界（1~90）', () => {
  assert.equal(aiFailureStore.summary(0).days.length, 7, '0/非法 → 回退 7 天');
  assert.equal(aiFailureStore.summary(999).days.length, 90, '上限 90 天');
  assert.equal(aiFailureStore.summary(3).days.length, 3);
});
