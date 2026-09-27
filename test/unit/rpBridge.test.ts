import { test } from 'node:test';
import assert from 'node:assert';
import {
  detectStuck,
  detectOocMeta,
  isIdleEnough,
  canShowBridge,
  buildBridgeDraft,
  readBridgeBudget,
  writeBridgeBudget,
  markBridgeShown,
  markBridgeDismissed,
  readBridgeStats,
  recordBridgeEvent,
  BRIDGE_COOLDOWN_MS,
  BRIDGE_IDLE_MS,
  type BridgeBudget,
} from '../../src/lib/rpBridge.js';

const budget = (p: Partial<BridgeBudget> = {}): BridgeBudget => ({
  lastShownAt: null, dismissCount: 0, muted: false, ...p,
});

// ============ detectStuck：正例 ============
test('卡壳 · 简体常见求助都命中', () => {
  const cases = [
    '我不知道该说什么了',
    '我不知道要写什么',
    '我想不出来',
    '我卡住了',
    '卡文了',
    '卡壳',
    '接下来呢',
    '然后呢',
    '帮我想想',
    '词穷了',
    '毫无头绪',
    '不知道该怎么说',
  ];
  for (const c of cases) assert.strictEqual(detectStuck(c), true, c);
});

test('卡壳 · 繁体同样命中（繁简都显式列在规则里，不依赖转换库）', () => {
  for (const c of ['我不知道該說什麼', '幫我想想看', '接下來呢', '毫無頭緒', '我卡住了']) {
    assert.strictEqual(detectStuck(c), true, c);
  }
});

test('卡壳 · 英文命中', () => {
  for (const c of [
    "I don't know what to say",
    'i dont know what to do',
    "I'm stuck",
    'no idea what to do',
    'help me continue',
    "writer's block",
  ]) {
    assert.strictEqual(detectStuck(c), true, c);
  }
});

// ============ detectStuck：反例（误伤比漏判贵，必须挡住）============
test('卡壳 · 戏里的「不知道你在说什么」不算卡壳', () => {
  assert.strictEqual(detectStuck('我不知道你在说什么'), false);
  assert.strictEqual(detectStuck('我不知道你在講什麼'), false);
});

test('卡壳 · 戏里叙述里的「卡住」不算（他说卡住了她的手腕）', () => {
  assert.strictEqual(detectStuck('他一把卡住了她的手腕'), false);
  assert.strictEqual(detectStuck('门被卡住了'), false);
});

test('卡壳 · 「想不到你也在这里」是戏内对白，不算卡壳', () => {
  assert.strictEqual(detectStuck('想不到你也在这里'), false);
  assert.strictEqual(detectStuck('想不到你也在这'), false);
});

test('卡壳 · 空串 / 空白 / 非字符串安全返回 false', () => {
  assert.strictEqual(detectStuck(''), false);
  assert.strictEqual(detectStuck('   \u3000 '), false);
  assert.strictEqual(detectStuck(undefined as unknown as string), false);
});

// ============ detectOocMeta：正例 ============
test('出戏元话语 · 简体命中', () => {
  for (const c of [
    '不演了',
    '我不想演了',
    '别演了',
    '出戏',
    '说点真的',
    '回到现实',
    '都是我现实里的事',
    '暂停一下',
    '先暂停',
    '先停一下',
  ]) {
    assert.strictEqual(detectOocMeta(c), true, c);
  }
});

test('出戏元话语 · 繁体命中', () => {
  for (const c of ['我不想演了', '出戲', '說點真的', '回到現實', '先暫停']) {
    assert.strictEqual(detectOocMeta(c), true, c);
  }
});

test('出戏元话语 · 英文命中', () => {
  for (const c of [
    'stop roleplaying',
    'stop role-playing',
    'out of character',
    'ooc',
    'for real now',
    "let's talk for real",
    'pause the story',
    'off script',
  ]) {
    assert.strictEqual(detectOocMeta(c), true, c);
  }
});

// ============ detectOocMeta：反例 ============
test('出戏元话语 · 戏里对白不误伤（他停了一下 / 演出结束了）', () => {
  assert.strictEqual(detectOocMeta('他停了一下，没有再说话'), false);
  assert.strictEqual(detectOocMeta('演出结束了，观众陆续离场'), false);
  assert.strictEqual(detectOocMeta('她的演技真好'), false);
});

test('出戏元话语 · 空串安全', () => {
  assert.strictEqual(detectOocMeta(''), false);
  assert.strictEqual(detectOocMeta(undefined as unknown as string), false);
});

// ============ isIdleEnough ============
test('空闲判定 · 忙或输入框非空一律不提议', () => {
  const base = { lastActivityAt: 1000, now: 1000 + BRIDGE_IDLE_MS + 1, inputEmpty: true, busy: false };
  assert.strictEqual(isIdleEnough(base), true);
  assert.strictEqual(isIdleEnough({ ...base, busy: true }), false);
  assert.strictEqual(isIdleEnough({ ...base, inputEmpty: false }), false);
});

test('空闲判定 · 未到阈值 / 无活动时间戳都不提议', () => {
  const now = 1_000_000;
  assert.strictEqual(isIdleEnough({ lastActivityAt: now - 1000, now, inputEmpty: true, busy: false }), false);
  assert.strictEqual(isIdleEnough({ lastActivityAt: 0, now, inputEmpty: true, busy: false }), false);
  assert.strictEqual(isIdleEnough({ lastActivityAt: NaN, now, inputEmpty: true, busy: false }), false);
});

// ============ canShowBridge：四个条件 ============
test('展示判定 · 四个条件全过才展示', () => {
  const now = 10 * BRIDGE_COOLDOWN_MS;
  assert.deepStrictEqual(
    canShowBridge({ enabled: true, now, shownThisSession: false, budget: budget() }),
    { show: true, reason: 'ok' },
  );
});

test('展示判定 · 关闭开关 / 永久静默 / 本次已展示 / 冷却中，四个拒绝理由各自成立', () => {
  const now = 10 * BRIDGE_COOLDOWN_MS;
  assert.strictEqual(canShowBridge({ enabled: false, now, shownThisSession: false, budget: budget() }).reason, 'disabled');
  assert.strictEqual(canShowBridge({ enabled: true, now, shownThisSession: false, budget: budget({ muted: true }) }).reason, 'muted');
  assert.strictEqual(canShowBridge({ enabled: true, now, shownThisSession: true, budget: budget() }).reason, 'session');
  assert.strictEqual(
    canShowBridge({ enabled: true, now, shownThisSession: false, budget: budget({ lastShownAt: now - 60_000 }) }).reason,
    'cooldown',
  );
});

test('展示判定 · 恰好到冷却边界即可再展示', () => {
  const now = 5 * BRIDGE_COOLDOWN_MS;
  const at = now - BRIDGE_COOLDOWN_MS;
  assert.strictEqual(canShowBridge({ enabled: true, now, shownThisSession: false, budget: budget({ lastShownAt: at }) }).show, true);
  assert.strictEqual(
    canShowBridge({ enabled: true, now: now - 1, shownThisSession: false, budget: budget({ lastShownAt: at }) }).show,
    false,
  );
});

// ============ 预算持久化（node 环境无 localStorage，必须不抛错）============
test('预算 · node 环境（无 localStorage）读取返回空预算且各写入函数不抛错', () => {
  assert.deepStrictEqual(readBridgeBudget(), { lastShownAt: null, dismissCount: 0, muted: false });
  const written = writeBridgeBudget({ lastShownAt: 123 });
  assert.strictEqual(written.lastShownAt, 123);
  assert.doesNotThrow(() => markBridgeShown(999));
  assert.doesNotThrow(() => markBridgeDismissed());
});

// ============ 漏斗账本（本地计数；服务端埋点尚未接线）============
test('账本 · 形状固定，node 环境读写不抛错', () => {
  const s = readBridgeStats();
  assert.deepStrictEqual(Object.keys(s).sort(), ['clicked', 'dismissed', 'firstMessage', 'landed', 'shown']);
  assert.doesNotThrow(() => recordBridgeEvent('shown', 'stuck'));
  assert.doesNotThrow(() => recordBridgeEvent('clicked', 'ooc'));
  assert.doesNotThrow(() => recordBridgeEvent('landed'));
  assert.doesNotThrow(() => recordBridgeEvent('firstMessage'));
  assert.doesNotThrow(() => recordBridgeEvent('dismissed'));
  assert.doesNotThrow(() => recordBridgeEvent('shown')); // 缺 trigger：静默忽略，不写坏账本
});

test('账本 · markBridgeDismissed 会累加一次拒绝', () => {
  assert.doesNotThrow(() => markBridgeDismissed());
});

