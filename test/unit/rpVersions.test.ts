/**
 * 剧情演绎「每条 AI 回复都能重新生成 + 多版本回看」的核心规则单测。
 *
 * 为什么值得单独钉死：这套逻辑真正的风险不是按钮少了一个，而是**上下文取错版本**
 * 一旦发出去的历史里混进被重抽掉的旧版，模型就会接着一段用户已经看不见的剧情往下写，
 * 而界面上完全看不出来。所以这里把「content 必须等于 versions[vi]」和
 * 「切版本不动后续对话、但下一轮上下文取当前版本」两条都用断言锁住。
 * 真机界面验证见 `temp/verify-rp-regenerate.mjs`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  versionsOf, versionIndex, activeContent,
  canRegenerateAt, startRegenerate, finishRegenerate, switchVersionIn, toRequestMessages,
  canEditAt, canSwitchUserBranchAt, startEditResend, switchUserBranchIn, commitUserBranch,
  userTailsOf, lastUserIndex, normalizeUserBranches, MAX_USER_VERSIONS,
} from '../../src/lib/rpVersions.js';

type Msg = { role: 'user' | 'assistant'; content: string; versions?: string[]; vi?: number; tails?: (Msg[] | null)[] };

/** 一段典型剧情：开场白(A) + 用户 + AI 回复 */
const convo = (): Msg[] => [
  { role: 'assistant', content: '开场白' },
  { role: 'user', content: '你好' },
  { role: 'assistant', content: '第一版回复' },
];

test('versionsOf / versionIndex：没有 versions 的老数据 = 单版，不炸不越界', () => {
  assert.deepEqual(versionsOf({ role: 'assistant', content: 'A' }), ['A']);
  assert.deepEqual(versionsOf({ role: 'user', content: '我' }), ['我']);
  assert.strictEqual(versionIndex({ role: 'assistant', content: 'A' }), 0);
  // 脏数据：vi 越界 / 负数 / NaN → 一律回落到最后一版
  assert.strictEqual(versionIndex({ role: 'assistant', content: 'B', versions: ['A', 'B'], vi: 9 }), 1);
  assert.strictEqual(versionIndex({ role: 'assistant', content: 'B', versions: ['A', 'B'], vi: -3 }), 1);
  assert.strictEqual(versionIndex({ role: 'assistant', content: 'B', versions: ['A', 'B'], vi: NaN }), 1);
  // versions 里混入非字符串 → 过滤掉，仍然可读
  assert.deepEqual(versionsOf({ role: 'assistant', content: 'B', versions: ['A', 42 as any, 'B'] }), ['A', 'B']);
});

test('canRegenerateAt：只有「前面紧跟着用户消息的 AI 回复」能重生成（开场白不给）', () => {
  const m = convo();
  assert.strictEqual(canRegenerateAt(m, 0), false, '开场白之前没有用户消息 → 不给重生成（后端 /chat 也要求以 user 结尾）');
  assert.strictEqual(canRegenerateAt(m, 1), false, '用户消息本身不能重生成');
  assert.strictEqual(canRegenerateAt(m, 2), true, 'AI 回复可以重生成');
  assert.strictEqual(canRegenerateAt(m, 3), false, '越界下标');
  assert.strictEqual(canRegenerateAt([...m, { role: 'assistant', content: '连着两条 AI' }], 3), false, '两条 AI 连着时后一条没有前置 user');
});

test('startRegenerate：base 以 user 结尾（其后对话作废），prev 原样交还（失败可放回）', () => {
  const m = convo();
  const r = startRegenerate(m, 2)!;
  assert.strictEqual(r.base.length, 2);
  assert.strictEqual(r.base[r.base.length - 1].role, 'user', '上下文必须以用户消息结尾');
  assert.strictEqual(r.prev.content, '第一版回复');
  assert.strictEqual(startRegenerate(m, 0), null, '开场白 → null');

  // 中间那条：其后对话确实被切掉（用户已在弹窗里确认过）
  const long: Msg[] = [
    { role: 'assistant', content: '开场白' },
    { role: 'user', content: '第1句' },
    { role: 'assistant', content: 'AI 1' },
    { role: 'user', content: '第2句' },
    { role: 'assistant', content: 'AI 2' },
  ];
  const mid = startRegenerate(long, 2)!;
  assert.strictEqual(mid.base.length, 2);
  assert.strictEqual(mid.base[1].content, '第1句');
});

test('finishRegenerate：新回复追加为最新一版并选中，旧版全部保留（不覆盖）', () => {
  const first = finishRegenerate({ role: 'assistant', content: '第一版回复' }, '第二版回复');
  assert.deepEqual(first.versions, ['第一版回复', '第二版回复']);
  assert.strictEqual(first.vi, 1);
  assert.strictEqual(first.content, '第二版回复', 'content 必须等于 versions[vi]');

  const third = finishRegenerate(first, '第三版回复');
  assert.deepEqual(third.versions, ['第一版回复', '第二版回复', '第三版回复']);
  assert.strictEqual(third.vi, 2);

  // 从「已经切回旧版」的状态再重生成：不丢当前那版（versionsOf 已把它算在内）
  const backToFirst = switchVersionIn([first], 0, -1)[0];
  const again = finishRegenerate(backToFirst, '第四版回复');
  assert.deepEqual(again.versions, ['第一版回复', '第二版回复', '第四版回复']);
  assert.strictEqual(again.content, '第四版回复');
});

test('switchVersionIn：切版本只改这一条，**不截断后续对话**，边界不越界', () => {
  const m: Msg[] = [
    { role: 'assistant', content: '开场白' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: 'B', versions: ['A', 'B'], vi: 1 },
    { role: 'user', content: '之后我说的话' },
    { role: 'assistant', content: '之后的回复' },
  ];
  const prev = switchVersionIn(m, 2, -1);
  assert.strictEqual(activeContent(prev[2] as any), 'A', '◀ 回到旧版');
  assert.strictEqual(prev.length, m.length, '切版本不改对话长度（后续剧情不许被吃掉）');
  assert.strictEqual(prev[3].content, '之后我说的话', '后续用户消息原样保留');
  assert.strictEqual(prev[0], m[0], '未受影响的消息保持引用不变（避免整屏重渲染）');

  const next = switchVersionIn(prev, 2, 1);
  assert.strictEqual(activeContent(next[2] as any), 'B', '▶ 回到新版');

  // 边界：已在最后一版继续 ▶ / 已在第一版继续 ◀ → 原样返回（引用都不变）
  const atLast = { role: 'assistant', content: 'B', versions: ['A', 'B'], vi: 1 } as Msg;
  const arr = [m[0], m[1], atLast];
  assert.strictEqual(switchVersionIn(arr, 2, 1), arr, '最后一版再 ▶ = 不动');
  const atFirst = { role: 'assistant', content: 'A', versions: ['A', 'B'], vi: 0 } as Msg;
  const arr2 = [m[0], m[1], atFirst];
  assert.strictEqual(switchVersionIn(arr2, 2, -1), arr2, '第一版再 ◀ = 不动');
  // 单版消息 / 用户消息 / 越界 → 原样返回
  assert.strictEqual(switchVersionIn(m, 1, -1), m, '用户消息没有版本');
  assert.strictEqual(switchVersionIn(m, 9, -1), m, '越界');
});

test('🔴 上下文一致性：切版本后发给模型的上下文 = 当前选中版本（不是被重抽掉的那版）', () => {
  // 一次重生成 → 两版；此时默认选中新版
  const after = finishRegenerate({ role: 'assistant', content: '旧版回复' }, '新版回复');
  const m: Msg[] = [{ role: 'assistant', content: '开场白' }, { role: 'user', content: '你好' }, after];
  let req = toRequestMessages(m as any);
  assert.strictEqual(req[2].content, '新版回复', '默认上下文 = 最新那一版');
  assert.deepEqual(Object.keys(req[2]).sort(), ['content', 'role'], '请求体只带 role/content（不把版本字段发给后端）');

  // 用户 ◀ 回看旧版：下一轮上下文必须是旧版，这正是用户要求的「之后 AI 跟着最后那条回复」
  const flipped = switchVersionIn(m, 2, -1);
  req = toRequestMessages(flipped as any);
  assert.strictEqual(req[2].content, '旧版回复');

  // 再▶ 回新版：上下文又跟着回来
  req = toRequestMessages(switchVersionIn(flipped, 2, 1) as any);
  assert.strictEqual(req[2].content, '新版回复');

  // 覆盖不变量：任意版本下标下，activeContent 与 toRequestMessages 永远一致
  for (const vi of [0, 1]) {
    const withVi = [{ ...after, vi }] as Msg[];
    assert.strictEqual(toRequestMessages(withVi as any)[0].content, activeContent(withVi[0] as any));
  }
});

test('落库形状：重生成产生的版本可以被完整序列化/反序列化（跨设备续写不丢版本）', () => {
  const v = finishRegenerate({ role: 'assistant', content: '旧版' }, '新版');
  const round = JSON.parse(JSON.stringify([{ role: 'assistant', content: v.content, versions: v.versions, vi: v.vi, timestamp: 1 }]));
  assert.deepEqual(versionsOf(round[0]), ['旧版', '新版']);
  assert.strictEqual(versionIndex(round[0]), 1);
  assert.strictEqual(activeContent(round[0]), '新版');
});

test('三语文案齐全：版本切换 / 截断提示 在 简·繁·英 都有，且 {n} 插值正确（漏一个语种会在界面上露出 key）', async () => {
  const store: Record<string, string> = {};
  (globalThis as any).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  };
  const { t } = await import('../../src/i18n/index.js');
  const caseOf = (lang: string, label: string, truncate: RegExp, prevWord: string, nextWord: string) => {
    store.cure_lang = lang;
    const got = t('rpVersionLabel', { n: 2, total: 3 });
    assert.strictEqual(got, label, `${lang} 的版本标签`);
    assert.strictEqual(t('rpVersionPrev'), prevWord, `${lang} 的上一版 aria`);
    assert.strictEqual(t('rpVersionNext'), nextWord, `${lang} 的下一版 aria`);
    const hint = t('rpRegenerateTruncate', { n: 4 });
    assert.match(hint, truncate, `${lang} 的截断提示`);
    // 任何语种都不许漏键（漏了 t() 会直接把 key 吐出来）
    // 2026-09 追加：编辑重发（剧情模式 rpEdit* / 聊一聊 chatEdit*）两个模式各自的文案也在内
    for (const k of ['rpVersionLabel', 'rpVersionPrev', 'rpVersionNext', 'rpRegenerateTruncate',
      'rpEdit', 'rpEditBanner', 'rpEditCancel', 'chatEdit', 'chatEditBanner', 'chatEditCancel']) {
      assert.notStrictEqual(t(k, { n: 1, total: 2 }), k, `${lang} 缺少文案：${k}`);
    }
  };
  caseOf('zh-CN', '第 2/3 版', /还有\s*4\s*条/, '上一版', '下一版');
  caseOf('zh-TW', '第 2/3 版', /還有\s*4\s*則/, '上一版', '下一版');
  caseOf('en', 'v2/3', /4 more messages/, 'Previous version', 'Next version');
});

/* ==================================================================== *
 * 用户消息「编辑重发」（方案 1B + 2A）：
 * 改掉最后一句 → 旧正文 + 旧回复冻结成可切回的分支，主线换成新正文 + 新回复。
 * ==================================================================== */

/** 一段典型剧情：开场白 + 用户 + AI 回复 */
const turn = (): Msg[] => [
  { role: 'assistant', content: '开场白' },
  { role: 'user', content: '我有点累' },
  { role: 'assistant', content: '那就先歇一会儿。' },
];

test('canEditAt：2A 只认「最后一条用户消息」；空正文 / AI 消息 / 越界都不给编辑', () => {
  const m: Msg[] = [
    { role: 'assistant', content: '开场白' },
    { role: 'user', content: '第1句' },
    { role: 'assistant', content: 'AI 1' },
    { role: 'user', content: '第2句' },
    { role: 'assistant', content: 'AI 2' },
  ];
  assert.strictEqual(lastUserIndex(m), 3);
  assert.strictEqual(canEditAt(m, 3), true, '最后一条用户消息可编辑');
  assert.strictEqual(canEditAt(m, 1), false, '历史里的用户消息不给编辑（2A：不做对话树）');
  assert.strictEqual(canEditAt(m, 2), false, 'AI 回复不是「编辑」对象（它走重新生成）');
  assert.strictEqual(canEditAt(m, 9), false, '越界');
  assert.strictEqual(canEditAt([{ role: 'user', content: '   ' }], 0), false, '空正文没什么可改');
  assert.strictEqual(canEditAt([{ role: 'user', content: '你好' }], 0), true, '只有一条用户消息时（还没回复）也能改');
});

test('startEditResend：旧正文留版、旧回复冻结进 tails、主线截到改写句（以 user 结尾）', () => {
  const m = turn();
  const after = startEditResend(m as any, 1, '我其实挺难过的')!;
  assert.strictEqual(after.length, 2, '主线 = 开场白 + 改写后的用户消息（旧回复被摘出来冻结）');
  assert.strictEqual(after[1].role, 'user');
  assert.strictEqual(activeContent(after[1] as any), '我其实挺难过的');
  assert.deepEqual(versionsOf(after[1] as any), ['我有点累', '我其实挺难过的']);
  assert.strictEqual(versionIndex(after[1] as any), 1, '默认选中新写的那一版');
  const tails = userTailsOf(after[1] as any);
  assert.strictEqual(tails[0]!.length, 1, '旧版本的后续（那条回复）被冻结保存');
  assert.strictEqual(tails[0]![0].content, '那就先歇一会儿。');
  assert.strictEqual(tails[1], null, '新版本的尾巴活在主线里');

  assert.strictEqual(startEditResend(m as any, 0, 'x'), null, '开场白（assistant）不能编辑');
  assert.strictEqual(startEditResend(m as any, 1, '   '), null, '空白改写不成立');
  assert.ok(startEditResend(m as any, 1, '我有点累'), '改成同一句也允许（用户就是想把这条重发一次）');
});

test('switchUserBranchIn：切分支换整条尾巴，两支都不丢（1B）；非最后一条 / 单版不给切', () => {
  // 编辑 → 新回复回来 → 此刻：v1 在主线，v0 冻结
  const edited = startEditResend(turn() as any, 1, '我其实挺难过的')!;
  const withReply: Msg[] = [...edited, { role: 'assistant', content: '我在听，慢慢说。' }];
  const m = withReply as any[];
  assert.strictEqual(canSwitchUserBranchAt(m, 1), true);

  const back = switchUserBranchIn(m, 1, -1);   // ◀ 回旧版
  assert.strictEqual(back.length, 3, '切回旧分支：旧正文 + 旧回复都回来了');
  assert.strictEqual(activeContent(back[1] as any), '我有点累');
  assert.strictEqual(back[2].content, '那就先歇一会儿。');
  assert.strictEqual(userTailsOf(back[1] as any)[1]![0].content, '我在听，慢慢说。', '新分支被冻结（切回后仍不丢）');

  const again = switchUserBranchIn(back as any, 1, 1);  // ▶ 回新版
  assert.strictEqual(activeContent(again[1] as any), '我其实挺难过的');
  assert.strictEqual(again[2].content, '我在听，慢慢说。');
  assert.strictEqual(userTailsOf(again[1] as any)[0]![0].content, '那就先歇一会儿。');

  // 边界
  const atFirst = switchUserBranchIn(m, 1, -1) as any[];
  assert.strictEqual(switchUserBranchIn(atFirst as any, 1, -1), atFirst, '已在第一版再 ◀ = 不动');
  assert.strictEqual(switchUserBranchIn(m, 2, -1), m, 'AI 消息不走这条路径');
  const single = turn() as any[];
  assert.strictEqual(switchUserBranchIn(single, 1, -1), single, '没编辑过 = 单版，没有可切的分支');
  // 一旦这条不再是「最后一条用户消息」（后面又聊了），就不再允许切分支
  const moved: Msg[] = [
    { role: 'assistant', content: '开场白' },
    { role: 'user', content: '我有点累', versions: ['我有点累', '我其实挺难过的'], vi: 0 },
    { role: 'assistant', content: '那就先歇一会儿。' },
    { role: 'user', content: '后来我又说了一句' },
    { role: 'assistant', content: '嗯。' },
  ];
  assert.strictEqual(canSwitchUserBranchAt(moved as any, 1), false, '2A：它已不是最后一条用户消息');
  assert.strictEqual(switchUserBranchIn(moved as any, 1, 1), moved, '不给切 → 原样返回（引用都不变）');
});

test('🔴 编辑重发的上下文一致性：请求带的是**改写后**的正文；切分支后 = 该分支正文与其后回复', () => {
  const edited = startEditResend(turn() as any, 1, '我其实挺难过的')!;
  const withReply: Msg[] = [...edited, { role: 'assistant', content: '我在听，慢慢说。' }];
  let req = toRequestMessages(withReply as any);
  assert.strictEqual(req[1].content, '我其实挺难过的', '发出去的是改写后的正文，不是原文');
  assert.strictEqual(req[2].content, '我在听，慢慢说。');
  assert.deepEqual(Object.keys(req[1]).sort(), ['content', 'role'], '分支字段（versions/tails）不许发给后端');

  const back = switchUserBranchIn(withReply as any, 1, -1);
  req = toRequestMessages(back as any);
  assert.strictEqual(req[1].content, '我有点累', '切回旧分支 → 上下文跟着回到旧分支');
  assert.strictEqual(req[2].content, '那就先歇一会儿。');
  assert.strictEqual(req.length, 3, '旧分支的尾巴原样回来，不带新分支的那条');
});

test('commitUserBranch：这条不再是最后一条用户消息时固化（丢掉切不回去的死重量）', () => {
  const edited = startEditResend(turn() as any, 1, '我其实挺难过的')!;
  const withReply: Msg[] = [...edited, { role: 'assistant', content: '我在听，慢慢说。' }];
  const committed = commitUserBranch(withReply as any, 1);
  const u = committed[1];
  assert.strictEqual(activeContent(u as any), '我其实挺难过的', '固化保留当前分支的正文');
  assert.strictEqual(versionsOf(u as any).length, 1, '版本信息清掉');
  assert.strictEqual((u as any).tails, undefined, '尾巴清掉（另一支永远也切不回去了）');
  assert.strictEqual(committed.length, 3, '主线不动');
  // 单版消息：原样返回（引用不变）
  const plain = turn() as any[];
  assert.strictEqual(commitUserBranch(plain, 1), plain);
});

test('normalizeUserBranches：脏数据兜底（前后端共用），当前版永远不被裁掉', () => {
  assert.deepEqual(normalizeUserBranches({ role: 'user', content: 'a', versions: ['a'] }), {}, '单版 = 老数据格式，不带字段');
  assert.deepEqual(normalizeUserBranches({ role: 'assistant', content: 'a', versions: ['a', 'b'], vi: 1 }), {}, 'AI 消息不走这条');
  // vi 越界 / content 与 versions[vi] 对不上 → 数据自洽优先
  const dirty = normalizeUserBranches({ role: 'user', content: 'b', versions: ['a', 'b'], vi: 9, tails: ['脏', [{ role: 'assistant', content: 'x' }]] });
  assert.strictEqual(dirty.vi, 1);
  assert.deepEqual(dirty.versions, ['a', 'b']);
  // tails 只保留结构合法的（下标对齐：tails[1] 是合法尾巴；tails[0] 不是数组 → 当 null）
  assert.deepEqual(dirty.tails, [null, [{ role: 'assistant', content: 'x' }]]);
  // 全都是不合法尾巴 → 干脆不带这个字段（别给库/客户端塞空壳）
  assert.strictEqual(normalizeUserBranches({ role: 'user', content: 'b', versions: ['a', 'b'], vi: 1, tails: ['脏', 42] }).tails, undefined);
  // 内容对不上 → 按 content 追加一版并选中
  const rebuilt = normalizeUserBranches({ role: 'user', content: 'c', versions: ['a', 'b'], vi: 0 });
  assert.deepEqual(rebuilt.versions, ['a', 'b', 'c']);
  assert.strictEqual(rebuilt.vi, 2);
  // 超出上限：保留「当前版 + 最近 N-1 个」，且当前版一定在
  const many = normalizeUserBranches({ role: 'user', content: 'v5', versions: ['v0', 'v1', 'v2', 'v3', 'v4', 'v5'], vi: 5 });
  assert.strictEqual(many.versions!.length, MAX_USER_VERSIONS);
  assert.strictEqual(many.versions![many.vi!], 'v5');
  // 空正文 → 不带分支字段（这种数据本身不对劲）
  assert.deepEqual(normalizeUserBranches({ role: 'user', content: '', versions: ['a', 'b'], vi: 1 }), {});
});
