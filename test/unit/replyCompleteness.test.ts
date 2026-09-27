/**
 * 「回复写完了吗」判定 + 续写去重叠（src/lib/replyCompleteness.ts）单测
 *
 * 判据来源：用户「小愈的朋友」那条真实半截回复（`……乖，慢慢刷。”\n\n（他并未退`），
 * 见 temp/rp-check/诊断-98e677f1-最新剧情回复是否中断.md。判据刻意保守：
 * 宁可漏报（少一次续写），也不要把写完之后又蹦个 emoji 的完整回复判成半截。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  incompleteReason,
  looksIncomplete,
  unclosedMarkers,
  unclosedPositions,
  unclosedNearTail,
  stripTrailingDecoration,
  overlapTrim,
  mergeContinuation,
  mergeContinuationGuarded,
  trimAdditionToBudget,
  continuationIsRetelling,
  longestCopyFrom,
  CONTINUATION_RETELL_MIN_CHARS,
  incompleteCode,
  autoContinueEligible,
  continuationAnchor,
} from '../../src/lib/replyCompleteness.js';

test('写完了：句末标点收尾（含中英标点与省略号、emoji 结尾）', () => {
  const done = [
    '他把杯子推到一边，没有再说话。',
    '你听见了吗？',
    '好！',
    '……',
    '他停住了，像是还想说什么……',
    'He stopped at the door.',
    'Wait, what?',
    '网络好像开小差了，稍后再试试好吗？🌱',
    '我知道啦～',
  ];
  for (const t of done) assert.strictEqual(looksIncomplete(t), false, t);
});

test('半截：括号/引号没配对（真实案例原样复现）', () => {
  const real = '（他低笑一声，指腹轻轻擦过你嘴角的水渍，顺势将你从被窝里打横抱起。\n\n“来，张嘴。daddy 帮你看着镜子……乖，慢慢刷。”\n\n（他并未退';
  assert.strictEqual(incompleteReason(real), 'unclosed');
  assert.deepStrictEqual(unclosedMarkers(real), ['（）']);
  // 结尾是完整的台词＋落单的（ → 仍是半截
  assert.strictEqual(incompleteReason('他往门边看了一眼。「你先走'), 'unclosed');
  // 英文直引号落单
  assert.strictEqual(incompleteReason('He said "come in'), 'unclosed');
});

test('半截：结尾不是句末标点（停在半句中间）', () => {
  const cases = [
    '他并未退',
    '他把手伸过来，指尖停在',
    '苏晚，你听我说，',
    'He stopped mid',
  ];
  for (const t of cases) assert.strictEqual(incompleteReason(t), 'mid_sentence', t);
});

test('以台词收尾且配对 → 算写完（模型常不写句号）', () => {
  assert.strictEqual(incompleteReason('他把门带上。\n\n「进来吧」'), null);
  assert.strictEqual(incompleteReason('「别动。」'), null);
  assert.strictEqual(incompleteReason('他轻声说：“乖。”'), null);
});

test('上游 finish_reason=length → 一律算没写完（哪怕文本以句号结尾）', () => {
  assert.strictEqual(incompleteReason('他笑了一下。', 'length'), 'length');
  assert.strictEqual(incompleteReason('他并未退', 'LENGTH'), 'length');
  // stop / 拿不到 → 回到文本判据
  assert.strictEqual(incompleteReason('他笑了一下。', 'stop'), null);
  assert.strictEqual(incompleteReason('他并未退', 'stop'), 'mid_sentence');
  assert.strictEqual(incompleteReason('他并未退'), 'mid_sentence');
});

test('空回复不归这里管（有独立的空回复重试）', () => {
  assert.strictEqual(incompleteReason(''), null);
  assert.strictEqual(incompleteReason('   \n\n '), null);
  assert.strictEqual(incompleteReason(undefined as unknown as string), null);
  assert.strictEqual(incompleteReason('', 'length'), null);
});

test('行尾装饰符：只剥装饰，不改判定依据', () => {
  assert.strictEqual(stripTrailingDecoration('他走了。🌱🌱  '), '他走了。');
  assert.strictEqual(stripTrailingDecoration('他并🌱'), '他并');
  // 结尾是数字/字母时不能被当装饰剥掉
  assert.strictEqual(stripTrailingDecoration('第 3 章 199'), '第 3 章 199');
});

test('overlapTrim：剪掉与已写内容逐字重复的开头（取最长重叠）', () => {
  // 真实断点续写：模型把「退」字重抄一遍
  assert.strictEqual(overlapTrim('……（他并未退', '退出去半步，反手把门带上。'), '出去半步，反手把门带上。');
  // 完全重叠（模型原样重抄）
  assert.strictEqual(overlapTrim('他并未退', '他并未退'), '');
  // 重叠更长时取最长那个（而不是最短）
  assert.strictEqual(overlapTrim('abcabc', 'abcabcdef'), 'def');
  // 没有重叠 → 原样返回
  assert.strictEqual(overlapTrim('他并未退', '，而是站住了。'), '，而是站住了。');
  // 空续写 / 空正文
  assert.strictEqual(overlapTrim('他并未退', ''), '');
  assert.strictEqual(overlapTrim('', '接着写'), '接着写');
  // 整段重写（addition 以整份 base 开头）→ 剪掉整份 base，只留新写的部分
  assert.strictEqual(overlapTrim('他并未退', '他并未退，只是站着没动。'), '，只是站着没动。');
  // 长于上限的重叠：按上限剪（不无限回溯，避免"通篇重复字符"时把正文误剪光）
  // roomy = 「前」+「同」×250；续写 = 「同」×250+「尾」→ 上限 200 剪掉 200 字，剩 50 个「同」+「尾」= 51 字
  const roomy = '前' + '同'.repeat(250);
  assert.strictEqual(overlapTrim(roomy, '同'.repeat(250) + '尾').length, 51);
});

test('mergeContinuation：拼接后判定为完整；没写出新内容则原样返回', () => {
  const base = '（他并未退';
  const merged = mergeContinuation(base, '退出去半步，反手把门带上。）「先睡。」');
  assert.strictEqual(merged, '（他并未退出去半步，反手把门带上。）「先睡。」');
  assert.strictEqual(looksIncomplete(merged), false);
  assert.strictEqual(mergeContinuation(base, base), base);
  assert.strictEqual(mergeContinuation(base, ''), base);
});

test('埋点原因码映射', () => {
  assert.strictEqual(incompleteCode('length'), 'PARTIAL_LENGTH');
  assert.strictEqual(incompleteCode('unclosed'), 'PARTIAL_UNCLOSED');
  assert.strictEqual(incompleteCode('mid_sentence'), 'PARTIAL_MID_SENTENCE');
  assert.strictEqual(incompleteCode(null), null);
});

/**
 * 触发闸（2026-09-19）：起因是用户「小愈的朋友」(8f17a9ac) 剧情回复里的**条内大段复读**——
 * 诊断结论：`mid_sentence`（只差句末标点）在这条 27B 链路上是**收尾习惯**，
 * 该用户 6/9 回合命中、续满 2 次后仍不完整；而每次续写都要把正文再喂一遍给弱模型，
 * 一旦它"重讲一遍"就会被拼进正文（最长 1112 字逐字重复）。
 */
test('触发闸：只有真截断才自动续写（length / unclosed 一律续）', () => {
  assert.strictEqual(autoContinueEligible('length', 'length'), true);
  assert.strictEqual(autoContinueEligible('unclosed', 'stop'), true);
  assert.strictEqual(autoContinueEligible(null), false);
});

test('触发闸：mid_sentence 且上游明确说完（stop）→ 不自动续写，交手动续写', () => {
  assert.strictEqual(autoContinueEligible('mid_sentence', 'stop'), false);
  assert.strictEqual(autoContinueEligible('mid_sentence', 'STOP'), false);
  // 上游没说（可能是流被掐断）→ 仍然续
  assert.strictEqual(autoContinueEligible('mid_sentence', ''), true);
  assert.strictEqual(autoContinueEligible('mid_sentence', undefined), true);
  // 旧口径开关：显式打开时恢复「mid_sentence 也续」
  assert.strictEqual(autoContinueEligible('mid_sentence', 'stop', { midSentence: true }), true);
});

test('续写锚点：只取尾部一段，且尽量落在句子边界上', () => {
  const body = '甲'.repeat(400) + '。\n\n' + '乙'.repeat(300) + '。\n\n' + '丙'.repeat(60);
  const anchor = continuationAnchor(body, 200);
  assert.ok(anchor.length < body.length, '应短于正文');
  assert.ok(body.endsWith(anchor), '锚点必须是正文的尾部（保证接着写的是同一句话）');
  assert.ok(!anchor.startsWith('乙'), '应从最后一句话的开头开始，不把上一句的残尾带进来（省 token、也少给模型可复述的材料）');
  // 短正文原样返回；max=0（开关）原样返回整篇
  assert.strictEqual(continuationAnchor('很短。', 20), '很短。');
  assert.strictEqual(continuationAnchor(body, 0), body);
});

test('续写锚点：窗口里没有句子边界时不退化成空（宁可切在半句）', () => {
  const body = '啊'.repeat(500);
  const anchor = continuationAnchor(body, 100);
  assert.strictEqual(anchor.length, 100);
  assert.strictEqual(continuationAnchor('', 100), '');
});

/**
 * 触发闸第二刀（2026-09-19）：`unclosed` 只在**断点真的落在未闭合标记里**时才算真截断。
 *
 * 起因：用户 cf8077d3（林清缇）的 8 个回合全部是 `回复仍不完整（unclosed，续写 2 次）`
 * （`data/server-err.log`），但全文的括号都是配对的——落单的是**开引号被当成闭引号用**
 * （`“台词……“`，位置在正文中段）。这类"中段落单"续写补不回来，只会换来一次重讲。
 */
test('触发闸：中段落单的开启符不算真截断（不自动续写）', () => {
  // 中段落单（距结尾 1500 字）→ 不续
  const midStray = '他低声道：“这双手若是不安……“' + '他继续说着别的事情。'.repeat(30) + '他终于停了下来。';
  assert.strictEqual(unclosedMarkers(midStray).length, 1, '夹具要有落单标记');
  assert.strictEqual(unclosedNearTail(midStray), false);
  assert.strictEqual(autoContinueEligible('unclosed', 'stop', { text: midStray }), false);
  // 断点就在尾部窗口里（真的写到一半被截断）→ 照旧续
  const tailStray = '（他低笑一声，把杯子放下。）\n\n（他并未退';
  assert.strictEqual(unclosedNearTail(tailStray), true);
  assert.strictEqual(autoContinueEligible('unclosed', 'stop', { text: tailStray }), true);
  // 不给正文 → 保持收窄前的口径（老调用方不受影响）
  assert.strictEqual(autoContinueEligible('unclosed', 'stop'), true);
  // length 一律续（上游明说截断，与文本长相无关）
  assert.strictEqual(autoContinueEligible('length', 'length', { text: midStray }), true);
  // 位置可定位（栈式配对：嵌套里没闭合的那个才是落单的）
  assert.deepStrictEqual(unclosedPositions('（他笑（了一下。）').map((p) => p.at), [0]);
});

/**
 * 重讲闸（2026-09-19）：弱模型的"重讲同一拍"。
 *
 * 阈值依据（全部实测）：真续写里逐字抄自已写正文 0–9 字（`temp/rp-rep-8f17a9ac/probe-continuation.mts`，
 * 8 次探针全部 0 字）；重讲是 50 / 98 / 141 / 461 字（用户 cf8077d3 的真实落盘，
 * `temp/rp-rep-cf8077d3/修复前后-真实数据核验.txt`），最长 1112 字（8f17a9ac）。
 * 阈值取 40（`CONTINUATION_RETELL_MIN_CHARS`）。
 * 夹具按这个结构写（中段整块逐字再来一遍、接缝处措辞微变），不引用任何真实用户正文。
 */
test('重讲闸：续写整块重抄已写正文 → 判为重讲并丢弃该段', () => {
  const said = '“这双手若是不安……”\n\n';
  const block = '他忽然收紧了揽在你腰间的手臂，将你更紧密地揽入怀中。他的一只手顺着你的大腿内侧缓缓上移，指尖带着不容置疑的力度，轻轻拨开层层叠叠的衣料边缘。';
  const base = said + block + '（他并未退';
  // 重讲：从更早的地方重铺一遍，接缝处一个字节都不重（措辞微变），中段整块逐字重复
  const retell = '他并未退却半分，只是把呼吸放得更缓。' + block + '他低语着，声音里带着几分笃定。';
  const r = continuationIsRetelling(base, retell);
  assert.ok(r.copied >= CONTINUATION_RETELL_MIN_CHARS, `应量出 ≥${CONTINUATION_RETELL_MIN_CHARS} 字逐字抄写，实际 ${r.copied}`);
  assert.strictEqual(r.retell, true);
  const g = mergeContinuationGuarded(base, retell);
  assert.strictEqual(g.retell, true);
  assert.strictEqual(g.text, base, '命中重讲 → 丢弃该段续写，正文一字不动');
  assert.strictEqual(g.added, '');
});

test('重讲闸：真续写（逐字抄写极少）照常拼接', () => {
  const base = '（他低笑一声，把杯子放下。）\n\n「来，张嘴。daddy 帮你看着镜子……乖，慢慢刷。」\n\n（他并未退';
  const good = '退出去半步，反手把门带上。）「先睡吧。」他没有再看你一眼，转身把灯关了。';
  const g = mergeContinuationGuarded(base, good);
  assert.strictEqual(g.retell, false);
  assert.ok(g.text.startsWith(base));
  assert.strictEqual(g.text, base + '出去半步，反手把门带上。）「先睡吧。」他没有再看你一眼，转身把灯关了。');
  assert.strictEqual(looksIncomplete(g.text), false);
  // 接缝处的逐字重叠照旧由 overlapTrim 剪掉（先剪再接，不算命中重讲）
  assert.ok(longestCopyFrom(base, good) < CONTINUATION_RETELL_MIN_CHARS, `真续写的逐字抄写应远低于阈值，实际 ${longestCopyFrom(base, good)}`);
});

test('重讲闸：原样重抄整篇 → 也走"丢弃该段"这条（而不是拼成两份）', () => {
  const base = '他并未退';
  const g = mergeContinuationGuarded(base, base);
  assert.strictEqual(g.text, base);
  assert.strictEqual(g.retell, false, '整份重抄由 overlapTrim 剪成空串（既有口径），不必判重讲');
  assert.strictEqual(g.added, '');
});

/**
 * 篇幅预算（2026-09-19 用户口径「续写应该只是满足一次的字数量，而不是每次都生成类似初始回复的量」）：
 * 续写新增的那一段要能被**裁进预算**，而且只在句末标点处裁（宁可超预算，也不把句子砍成半句）。
 */
test('trimAdditionToBudget：超预算时在句界处裁断；没有句界就原样保留', () => {
  // 超预算：第一次句子结束在 10 字处 → 裁到那里
  const add = '他停下了，把灯关了。' + '他'.repeat(300) + '。';
  const t = trimAdditionToBudget(add, 198);
  assert.strictEqual(t.trimmed, true);
  assert.strictEqual(t.text, '他停下了，把灯关了。');
  // 不超预算 → 原样
  assert.deepStrictEqual(trimAdditionToBudget('很短。', 100), { text: '很短。', trimmed: false });
  // 预算段里一个句界都没有 → 原样保留（绝不砍出半句）
  const noEnd = '他'.repeat(300);
  assert.deepStrictEqual(trimAdditionToBudget(noEnd, 100), { text: noEnd, trimmed: false });
  // 预算 0 / 空文本
  assert.deepStrictEqual(trimAdditionToBudget('abc。', 0), { text: 'abc。', trimmed: false });
  assert.deepStrictEqual(trimAdditionToBudget('', 50), { text: '', trimmed: false });
});
