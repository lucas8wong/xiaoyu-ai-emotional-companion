/**
 * 剧情判重退费回归网，2026-10-01
 *
 * 这一层的契约有三条，每条都有它要防的失效方式：
 *   ① 分档：明显重复走确定性档（不叫模型）；干净文本必须判「不重复」（否则用户正常聊天被白送额度）；
 *   ② 长度闸：短于 RP_REPEAT_REFUND_MIN_CHARS 直接跳过（短台词整段相同是常态，判了就误伤）；
 *   ③ 双钥匙：灰区必须过 AI 判官；判官被关闭时一律按「不重复」处理（照常扣费）。
 *
 * ⚠️ 所有样本都 >=80 字（或 >=10 字/条的建议），否则测的是早退分支而不是判据。
 * ⚠️ 单测里关掉语义信号与埋点写盘：不加载本地 embedding、不污染 data/。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupTempCwd } from './setup.js';

setupTempCwd();
process.env.RP_REPEAT_EMBED = '0';
process.env.RP_REPEAT_REFUND_STATS = '0';

const mod: any = await import('../../api/services/repeatRefund.js');
const { combinePairScore, pairScoreSync, assessReplyRepeat, assessSuggestionsRepeat, repeatRefundEnabled, repeatMinChars } = mod;

/* 互不共享长片段的干净样本（防止测试自己制造假阳性） */
const A1 = '他把窗推开一条缝，夜风灌进来，桌上的纸角翻了翻，又慢慢落回去。';
const A2 = '院子里的水缸结了一层薄冰，映着廊下那盏灯，亮得有些冷。';
const A3 = '远处传来更鼓声，一下，两下，随后就断了，只剩檐下的风。';
const A4 = '灶上的水开了，壶盖轻轻跳着，他把火压小，又添了半勺茶叶。';
const A5 = '他解开外袍的第一颗扣子，又停住，重新系好，像是改了什么主意。';
const A6 = '她把窗纸上的破洞用米糊补上，指尖在纸面上抹了两下才收回。';
const A7 = '檐下的灯笼晃了两下，他抬手扶住，指节上还沾着一点灰。';
const A8 = '院子角落那株梅树还没开，枝上挂着昨夜的霜，白得很安静。';

/** >=80 字的整段文本（severe 判定用） */
const LONG1 = '他垂着眼，把外袍的下摆拢好，动作不急不缓。“先把这碗汤喝了，凉了就没用了。”他说话的时候没有看你，只是把碗往你面前推了推，指尖在碗沿上停了片刻，像是在等一个回答。窗外的光斜斜地落在桌沿上，炉火旺着，发出细碎的噼啪声。';
const CLEAN = A3 + A4 + A5 + A6;
const len = (s: string) => s.replace(/\s+/g, '').length;

test('样本自身够长（否则下面测的是早退分支而不是判据）', () => {
  assert.ok(len(LONG1) >= 80, 'LONG1 太短：' + len(LONG1));
  assert.ok(len(CLEAN) >= 80, 'CLEAN 太短：' + len(CLEAN));
  for (const [n, s] of [['A1', A1], ['A5', A5], ['A7', A7], ['A8', A8]] as [string, string][]) {
    assert.ok(len(s) >= 10, n + ' 太短：' + len(s));
  }
});

/* ------------------------- 合成打分（纯函数） ------------------------- */

test('combinePairScore：明显重复 → 1；干净 → 0', () => {
  const hi = combinePairScore({ span: 100, minLen: 110, lexical: 1, cosine: 0, lang: 'zh' });
  assert.equal(hi.verbatim, 1);
  assert.equal(hi.score, 1);
  const lo = combinePairScore({ span: 0, minLen: 100, lexical: 0.1, cosine: 0, lang: 'zh' });
  assert.equal(lo.score, 0);
});

test('combinePairScore：三个信号取 max 而不是平均（整段照抄不该被低 Jaccard 稀释）', () => {
  // span 20 只是「刚过起算线」，但字面相似拉满 → 结果应当约等于字面那条，而不是两者平均
  const s = combinePairScore({ span: 20, minLen: 100, lexical: 0.95, cosine: 0, lang: 'zh' });
  assert.ok(Math.abs(s.score - 0.9) < 1e-9, 'score 应为 0.9（0.9×lexical），实际 ' + s.score);
});

test('combinePairScore：语义信号单独成立时也能判重（cos 0.95 → 0.8）', () => {
  const s = combinePairScore({ span: 0, minLen: 100, lexical: 0.05, cosine: 0.95, lang: 'zh' });
  assert.ok(Math.abs(s.score - 0.8) < 1e-9, 'score 应为 0.8，实际 ' + s.score);
});

test('pairScoreSync：同一段文本 → 1；互不相关 → 明显低', () => {
  assert.equal(pairScoreSync(LONG1, LONG1, 'zh').score, 1);
  assert.ok(pairScoreSync(A1, A2, 'zh').score < 0.35, '干净样本被误判：' + pairScoreSync(A1, A2, 'zh').score);
});

/* ------------------------- 剧情回复 ------------------------- */

test('剧情回复：与上一段逐字相同 → 判重（确定性档，不叫模型）', async () => {
  const a = await assessReplyRepeat(LONG1, [LONG1], 'zh');
  assert.equal(a.duplicate, true);
  assert.equal(a.source, 'deterministic');
  assert.ok(a.degree >= 0.75, 'degree=' + a.degree);
});

test('剧情回复：干净文本 → 不判重（不能白送额度）', async () => {
  const a = await assessReplyRepeat(CLEAN, [LONG1, A1 + A2], 'zh');
  assert.equal(a.duplicate, false);
  assert.equal(a.source, 'none');
});

test('剧情回复：短于长度闸 → 跳过（不判重）', async () => {
  const a = await assessReplyRepeat('他说好。', ['他说好。'], 'zh');
  assert.equal(a.duplicate, false);
  assert.equal(a.skipped, 'too-short');
  assert.ok(repeatMinChars('zh') >= 80, '默认长度闸应当是 80 字');
});

test('剧情回复：没有可比对象 → 跳过（首次生成不该被判重）', async () => {
  const a = await assessReplyRepeat(LONG1, [], 'zh');
  assert.equal(a.skipped, 'nothing-to-compare');
});

test('双钥匙：判官被关闭时，灰区一律按「不重复」处理（照常扣费）', async () => {
  const save = { high: process.env.RP_REPEAT_HIGH, low: process.env.RP_REPEAT_GRAY_LOW, judge: process.env.RP_REPEAT_JUDGE };
  process.env.RP_REPEAT_HIGH = '1';
  process.env.RP_REPEAT_GRAY_LOW = '0';
  process.env.RP_REPEAT_JUDGE = '0';
  try {
    const a = await assessReplyRepeat(CLEAN, [LONG1, A1 + A2], 'zh');
    assert.equal(a.duplicate, false);
    assert.equal(a.source, 'none');
    assert.ok(String(a.detail).includes('判官已关闭'), 'detail=' + a.detail);
  } finally {
    if (save.high === undefined) delete process.env.RP_REPEAT_HIGH; else process.env.RP_REPEAT_HIGH = save.high;
    if (save.low === undefined) delete process.env.RP_REPEAT_GRAY_LOW; else process.env.RP_REPEAT_GRAY_LOW = save.low;
    if (save.judge === undefined) delete process.env.RP_REPEAT_JUDGE; else process.env.RP_REPEAT_JUDGE = save.judge;
  }
});

/* ------------------------- 建议批次 ------------------------- */

test('建议批次：与上一批完全一样 → 判重', async () => {
  const batch = [A1, A2, A3, A4];
  const a = await assessSuggestionsRepeat(batch, batch, 'zh');
  assert.equal(a.duplicate, true);
  assert.equal(a.source, 'deterministic');
});

test('建议批次：全新四句 → 不判重', async () => {
  const a = await assessSuggestionsRepeat([A5, A6, A7, A8], [A1, A2, A3, A4], 'zh');
  assert.equal(a.duplicate, false);
});

test('建议批次：可比条数不足 → 跳过', async () => {
  const a = await assessSuggestionsRepeat([A5, A6], [A1, A2, A3, A4], 'zh');
  assert.equal(a.skipped, 'too-short');
});

test('建议批次：没有上一批（首次生成）→ 跳过', async () => {
  const a = await assessSuggestionsRepeat([A1, A2, A3, A4], [], 'zh');
  assert.equal(a.skipped, 'nothing-to-compare');
});

test('开关：默认开启；置 0 后整块跳过', async () => {
  assert.equal(repeatRefundEnabled(), true);
  process.env.RP_REPEAT_REFUND = '0';
  try {
    const a = await assessReplyRepeat(LONG1, [LONG1], 'zh');
    assert.equal(a.skipped, 'disabled');
  } finally {
    delete process.env.RP_REPEAT_REFUND;
  }
});
