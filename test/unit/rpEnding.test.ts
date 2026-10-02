/**
 * 「收尾形态」判据测试（2026-09-18）
 *
 * 这份测试的定位：它是**度量工具的秤砣**。扫描脚本（`scripts/rp-ending-scan.mts`）与
 * 剧情提示词的「形态刹车」都建在这几个纯函数上，判据错了，前后对比的结论就是假的。
 * 所以这里既测「该命中的命中」，也把**已知误判与刻意保守的取舍显式钉成断言**，
 * 免得日后有人当它是精确分类器（那些取舍是设计，不是 bug）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rpEndingKind, rpEndsWithQuestion, rpHasTerminalPunctuation, rpIsContinuationAsk, rpLastClause, rpRecentEndingKinds } from '../../src/lib/rpEnding.js';

test('rpLastClause：取「他最后说的那一句」：剥两端装饰、按小句切分、保留句末标点', () => {
  // 剧情正文的常见形态是「旁白 + 逗号 + 台词」，必须只取台词那一段（否则形态榜聚不到一起）
  assert.equal(rpLastClause('他顿了顿，“想跟我多说点儿不？”'), '想跟我多说点儿不？');
  assert.equal(rpLastClause('「你先说。」'), '你先说。');
  assert.equal(rpLastClause('他低下头。\n\n（他等着你开口。）'), '他等着你开口。');
  assert.equal(rpLastClause('他笑了。  '), '他笑了。');
  assert.equal(rpLastClause(''), '');
});

test('硬判据 rpEndsWithQuestion：含问号即算（含「吗？！」这类混排），尾句是旁白则不算', () => {
  assert.equal(rpEndsWithQuestion('真的吗？'), true);
  assert.equal(rpEndsWithQuestion('真的吗？！'), true);
  assert.equal(rpEndsWithQuestion('“Want to tell me more?”'), true);
  // 问句在中间、尾句是旁白 → 这一轮其实是「动作收尾」，不该算问句收尾
  assert.equal(rpEndsWithQuestion('“你想说什么吗？”他低下头。'), false);
  assert.equal(rpEndsWithQuestion('他笑了。'), false);
  assert.equal(rpEndsWithQuestion('「……」'), false);
  // 已知盲区（刻意不做模糊补偿）：整段不写句末标点 → 判为非问句。报告里单列计数，不当成改善。
  assert.equal(rpEndsWithQuestion('你先说'), false);
});

test('启发式 rpIsContinuationAsk：「继续说类动词 + 征询标记/问句」才命中，简繁英都覆盖', () => {
  const yes = [
    '他顿了顿，“想跟我多说点儿不？”',
    '你还想聊点什么吗？',
    '要不要继续说下去？',
    '还想跟我说说吗',              // 无句末标点也行：命中征询标记
    '你想继续聊吗？',              // 无征询标记，但是问句
    '想跟我多說點嗎？',            // zh-TW
    '還有什麼想跟我聊的嗎？',       // zh-TW
    'Want to tell me more?',
    'Anything else you want to talk about?',
    'Would you like to keep talking?',
  ];
  for (const t of yes) assert.equal(rpIsContinuationAsk(t), true, '应判为征询继续：' + t);
});

test('启发式 rpIsContinuationAsk：不误伤普通问句、旁白与指令句', () => {
  const no = [
    '他低下头，把杯子放回桌上。',
    '你这是什么意思？',            // 普通疑问句＝情节推进
    '“要不要再喝一杯？”',          // 有「要不要」，但不是在问「要不要继续说话」
    '“还想听吗？”',                // 反向（它要讲给你听），不在本判据范围内，见模块 JSDoc 的留白说明
    '你想说什么？',                // 刻意保守：不带征询动词 → 只算 question（宁可少算）
    '继续。',                      // 只有动词、没有征询
    '“坐下。”',
    '他说了很多。',
    '“你先说说看。”',              // 有「说说」但是命令，不是征询
    '你再说一遍？',                // 命令式重复请求，已由 REPEAT_REQUEST 排除
  ];
  for (const t of no) assert.equal(rpIsContinuationAsk(t), false, '不该判为征询继续：' + t);
});

test('rpEndingKind：continuation_ask 优先于 question，其余归陈述', () => {
  assert.equal(rpEndingKind('你想要我继续说吗？'), 'continuation_ask');
  assert.equal(rpEndingKind('你这是什么意思？'), 'question');
  assert.equal(rpEndingKind('他把窗推开，夜风灌进来。'), 'statement');
});

test('已知误判（**刻意接受**，不是 bug）：问剧情第三人的台词会被算进 continuation_ask', () => {
  // 「想跟我说说他吗？」问的是剧情里的第三个人，属正常台词；但结构与元话语同形，
  // 判据无法在不引入句法分析的前提下区分。影响面：只让扫描的比例略偏高、
  // 及让这一句进入下轮「禁止复现」清单（本来就会进去），**不会改动任何正文**。
  assert.equal(rpEndingKind('“想跟我说说他吗？”'), 'continuation_ask');
});

test('英文的句号也算句末标点（漏掉它会让英文「最后一句」退化成整段正文）', () => {
  const en = '(I do not turn to hurry you.) "Come, press my chest. Even pressure, and relax a little."';
  // 小句切分：逗号也算切分点，所以取到的是最后一个小句而不是整句（这是刻意的，见模块 JSDoc）
  assert.equal(rpLastClause(en), 'and relax a little.');
  assert.equal(rpHasTerminalPunctuation(en), true);
  assert.equal(rpEndsWithQuestion(en), false);
  assert.equal(rpEndsWithQuestion('Come, press my chest, and tell me more?'), true);
  assert.equal(rpHasTerminalPunctuation('他笑了。'), true);
  assert.equal(rpHasTerminalPunctuation('你先说'), false);
});

test('rpRecentEndingKinds：只看 assistant、取最近 n 条、新的在后，脏数据不抛错', () => {
  const history = [
    { role: 'user', content: '嗯。' },
    { role: 'assistant', content: '他把外套递给你。' },
    { role: 'user', content: '谢谢。' },
    { role: 'assistant', content: '你想跟我说说吗？' },
    { role: 'user', content: '好。' },
  ];
  assert.deepEqual(rpRecentEndingKinds(history, 2), ['statement', 'continuation_ask']);
  assert.deepEqual(rpRecentEndingKinds(history, 1), ['continuation_ask']);
  assert.deepEqual(rpRecentEndingKinds(null), []);
  assert.deepEqual(rpRecentEndingKinds([{ role: 'assistant', content: '   ' }]), []);
  assert.deepEqual(rpRecentEndingKinds([{ role: 'assistant', content: undefined }]), []);
  assert.equal(rpEndingKind('   '), 'statement');
});
