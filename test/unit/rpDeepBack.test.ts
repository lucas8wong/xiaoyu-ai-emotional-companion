/**
 * 剧情模式「返回键」层级表的单测（2026-09-19）
 * 需求口径：「剧情模式的每一层级，手机上的回退功能都应该是让它回退到上一个层级而不是全部到小愈主界面」；
 * 弹层也算一层（先关最上面的弹层，再按一次才回上一层）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  RP_OVERLAY_ORDER,
  RP_STAGE_PARENT,
  RP_STAGE_RANK,
  resolveRpBack,
  topOverlay,
  type RpOverlay,
  type RpStage,
} from '../../src/lib/rpDeepBack.js';
import { pushDeepBackHandler, runDeepBack, deepBackHandlerCount } from '../../src/lib/deepBack.js';

const ALL_STAGES: RpStage[] = ['list', 'intro', 'tags', 'custom', 'detail', 'chat', 'wenyou', 'werewolf'];

test('剧情返回 · 每一层的上一层：对局→设定页→列表→小愈主界面（其余子页→列表）', () => {
  assert.deepStrictEqual(resolveRpBack('chat', []), { kind: 'leaveChat' }, '对局的上一层是剧本设定页（与页内 ← 同源）');
  assert.deepStrictEqual(resolveRpBack('detail', []), { kind: 'goList' });
  assert.deepStrictEqual(resolveRpBack('list', []), { kind: 'exit' }, '列表层交回 Home = 回小愈主界面');
  for (const s of ['intro', 'tags', 'custom', 'werewolf'] as RpStage[]) {
    assert.deepStrictEqual(resolveRpBack(s, []), { kind: 'goList' }, s + ' 的上一层是列表');
  }
  assert.deepStrictEqual(resolveRpBack('wenyou', []), { kind: 'delegate' }, '文游子树自己还有层级，先交给它');
});

test('剧情返回 · 层级表与决策一致（不留「表里写了一层、代码走了另一层」的死角）', () => {
  const parentOf = (s: RpStage): RpStage | 'exit' | 'delegate' => {
    const d = resolveRpBack(s, []);
    if (d.kind === 'exit') return 'exit';
    if (d.kind === 'delegate') return 'delegate';
    if (d.kind === 'goList') return 'list';
    if (d.kind === 'leaveChat') return 'detail';
    return 'detail';
  };
  for (const s of ALL_STAGES) {
    assert.strictEqual(parentOf(s), RP_STAGE_PARENT[s], s + ' 的上一层与层级表不一致');
  }
  assert.deepStrictEqual(Object.keys(RP_STAGE_PARENT).sort(), [...ALL_STAGES].sort(), '层级表必须覆盖全部 stage');
});

test('剧情返回 · 弹层优先于层级：开着弹层时先关弹层，页面层级不动', () => {
  for (const s of ALL_STAGES) {
    assert.deepStrictEqual(
      resolveRpBack(s, ['pref']),
      { kind: 'closeOverlay', overlay: 'pref' },
      s + ' 上有弹层时，先关弹层',
    );
  }
});

test('剧情返回 · 同时开着多层时只关最上面那个（z-index 从高到低）', () => {
  // z-95 的 18+ 闸门 > z-50 的偏好抽屉
  assert.deepStrictEqual(resolveRpBack('chat', ['pref', 'adultGate']), { kind: 'closeOverlay', overlay: 'adultGate' });
  // z-90 的引导气泡 > z-50 的温馨提示
  assert.deepStrictEqual(resolveRpBack('list', ['tip', 'coach']), { kind: 'closeOverlay', overlay: 'coach' });
  // z-70 的配乐面板 > z-60 的分享长图
  assert.deepStrictEqual(resolveRpBack('chat', ['share', 'bgm']), { kind: 'closeOverlay', overlay: 'bgm' });
  // 传进来的顺序不影响结果
  assert.strictEqual(topOverlay(['tip', 'adultGate']), 'adultGate');
  assert.strictEqual(topOverlay([]), null);
});

test('剧情返回 · 弹层清单完整且无重复（新增弹层忘了登记会被这条抓住）', () => {
  const all: RpOverlay[] = ['adultGate', 'coach', 'bgm', 'share', 'pref', 'regenerate', 'confirmRestart', 'storyInfo', 'tip', 'more'];
  assert.strictEqual(RP_OVERLAY_ORDER.length, all.length, '弹层数量变化时请同步更新这张表与单测');
  assert.strictEqual(new Set(RP_OVERLAY_ORDER).size, RP_OVERLAY_ORDER.length, '优先级表不能有重复项');
  assert.deepStrictEqual([...RP_OVERLAY_ORDER].sort(), [...all].sort(), '弹层清单必须一一对应');
});

/** 把决策落地成「下一状态」，用来模拟真机连着按返回键 */
function press(stage: RpStage | 'main', open: RpOverlay[]): { next: RpStage | 'main'; open: RpOverlay[]; kind: string } {
  if (stage === 'main') return { next: 'main', open, kind: 'leave-site' };
  const d = resolveRpBack(stage, open);
  if (d.kind === 'closeOverlay') return { next: stage, open: open.filter((k) => k !== d.overlay), kind: 'closeOverlay:' + d.overlay };
  if (d.kind === 'leaveChat') return { next: 'detail', open, kind: 'leaveChat' };
  if (d.kind === 'goList') return { next: 'list', open, kind: 'goList' };
  if (d.kind === 'delegate') return { next: 'list', open, kind: 'delegate' }; // 文游自己退完内部层级后回到列表
  return { next: 'main', open, kind: 'exit' }; // Home 关掉剧情模式 = 小愈主界面
}

test('剧情返回 · 连着按返回键：对局(开着偏好抽屉) → 设定页 → 列表 → 小愈主界面，一次只退一层', () => {
  let s: RpStage | 'main' = 'chat';
  let open: RpOverlay[] = ['pref'];
  const seq: string[] = [];
  for (let i = 0; i < 4; i++) {
    const r = press(s, open);
    seq.push(r.kind);
    s = r.next;
    open = r.open;
  }
  assert.deepStrictEqual(seq, ['closeOverlay:pref', 'leaveChat', 'goList', 'exit']);
  assert.strictEqual(s, 'main', '第 4 次返回到小愈主界面');
});

test('剧情返回 · 干净的对局（无弹层）三下退回小愈主界面，不会一下跳到主界面', () => {
  let s: RpStage | 'main' = 'chat';
  const seq: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = press(s, []);
    seq.push(r.kind);
    s = r.next;
  }
  assert.deepStrictEqual(seq, ['leaveChat', 'goList', 'exit']);
  assert.strictEqual(s, 'main');
});

test('剧情返回 · 文游子树：先退内部层级，再退回剧情列表（本层不抢它的返回）', () => {
  let s: RpStage | 'main' = 'wenyou';
  const first = press(s, []);
  assert.strictEqual(first.kind, 'delegate');
  s = first.next;
  assert.strictEqual(s, 'list');
});

test('剧情返回 · 层级深度表：每层都有自己的历史条目（对局比设定页深一层）', () => {
  assert.strictEqual(RP_STAGE_RANK.list, 0, '列表层 = Home 压的那条条目');
  assert.strictEqual(RP_STAGE_RANK.detail, 1);
  assert.strictEqual(RP_STAGE_RANK.chat, 2, '对局永远比设定页深一层');
  for (const s of ['intro', 'tags', 'custom', 'wenyou', 'werewolf'] as RpStage[]) {
    assert.strictEqual(RP_STAGE_RANK[s], 1, s + ' 与设定页同层');
  }
  assert.deepStrictEqual(Object.keys(RP_STAGE_RANK).sort(), [...ALL_STAGES].sort(), '深度表要覆盖全部 stage');
  // 深度必须与「上一层」自洽：父级每上一层，深度恰好 +1
  for (const s of ALL_STAGES) {
    const parent = RP_STAGE_PARENT[s];
    if (parent === 'list') assert.strictEqual(RP_STAGE_RANK[s], 1, s + ' 的深度应为 1');
    if (parent === 'detail') assert.strictEqual(RP_STAGE_RANK[s], 2, s + ' 的深度应为 2');
  }
});

test('返回协调器 · 从最深（最后注册）往前问，有人消费就不再问更浅的', () => {
  const before = deepBackHandlerCount();
  const calls: string[] = [];
  const unParent = pushDeepBackHandler(() => { calls.push('parent'); return false; });
  const unChild = pushDeepBackHandler(() => { calls.push('child'); return true; });
  assert.strictEqual(runDeepBack(), true);
  assert.deepStrictEqual(calls, ['child'], '子（后注册）先答，它消费了就不该再惊动父');
  unChild();
  calls.length = 0;
  assert.strictEqual(runDeepBack(), false, '父的处理器被问到了（它自己返回 false = 交回 Home）');
  assert.deepStrictEqual(calls, ['parent']);
  unParent();
  assert.strictEqual(deepBackHandlerCount(), before, '注销要干净');
});

test('返回协调器 · 子组件注销不会抹掉父组件的处理器（单例时代的隐患）', () => {
  const before = deepBackHandlerCount();
  const unParent = pushDeepBackHandler(() => true);
  const unChild = pushDeepBackHandler(() => false); // 文游/剧情这类「让位」处理器
  unChild(); // 子先卸载（例如文游退回列表）
  assert.strictEqual(runDeepBack(), true, '父仍在册，返回不该掉到 Home 去关掉整个模块');
  unParent();
  assert.strictEqual(deepBackHandlerCount(), before);
});

test('返回协调器 · 某个处理器抛错不阻断后面的处理器', () => {
  const before = deepBackHandlerCount();
  const unBoom = pushDeepBackHandler(() => { throw new Error('boom'); });
  const unOk = pushDeepBackHandler(() => true);
  assert.strictEqual(runDeepBack(), true);
  unBoom(); unOk();
  assert.strictEqual(deepBackHandlerCount(), before);
});
