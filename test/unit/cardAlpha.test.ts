/**
 * 「卡片不透明度」默认值 = 38% 及其**迁移口径**的单测（2026-09-15 用户要求"所有用户默认都设置成 38%"）。
 *
 * 为什么必须测迁移：`applyCardBgAlpha` 挂载时会把当前值写进 localStorage，
 * 所以**老用户（从没拖过滑块）的存档里早就是旧默认 0.8** —— 只改常量对他们无效。
 * 迁移规则（容易写错的一步）：
 *   · 没有存档            → 新默认 0.38
 *   · 存档 === 旧默认 0.8 → 视为"从没主动改过" → 迁到 0.38
 *   · 存档 ≠ 0.8（用户自己拖的）→ **原样保留**
 *   · 版本号已是当前      → 一律以存档为准
 * 这个测试用小桩替换 localStorage（Node 里没有），不依赖 jsdom。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

const { getStoredCardBgAlpha, applyCardBgAlpha, DEFAULT_CARD_BG_ALPHA } = await import('../../src/lib/skin.js');

const reset = () => store.clear();

test('默认卡片不透明度是 38%', () => {
  assert.equal(DEFAULT_CARD_BG_ALPHA, 0.38);
  reset();
  assert.equal(getStoredCardBgAlpha(), 0.38, '没有任何存档时应为 38%');
});

test('迁移：老用户存档仍是旧默认 0.8 → 改成 38%（这就是"所有用户"能生效的关键）', () => {
  reset();
  store.set('cure_card_bg_alpha', '0.8'); // 旧版本写入的默认值，用户从没拖过滑块
  assert.equal(getStoredCardBgAlpha(), 0.38);
});

test('迁移：用户自己拖过的值（≠0.8）必须原样保留', () => {
  for (const v of ['0.5', '1', '0', '0.65']) {
    reset();
    store.set('cure_card_bg_alpha', v);
    assert.equal(getStoredCardBgAlpha(), Number(v), `用户自定义值 ${v} 被改掉了`);
  }
});

test('版本号已是当前 → 一律以存档为准（含存的正好是 0.8 的情况）', () => {
  reset();
  store.set('cure_card_bg_alpha_version', '2');
  store.set('cure_card_bg_alpha', '0.8');
  assert.equal(getStoredCardBgAlpha(), 0.8, '用户主动调回 80% 后不该再被迁移覆盖');
});

test('脏数据（空/非数/越界）→ 回退默认 38%', () => {
  for (const bad of ['', 'abc', '2', '-0.5', 'NaN']) {
    reset();
    store.set('cure_card_bg_alpha', bad);
    assert.equal(getStoredCardBgAlpha(), 0.38, `脏数据 "${bad}" 没回退默认值`);
  }
});

test('applyCardBgAlpha 会同时写入值 + 版本号（避免每次进来都被迁移）', () => {
  reset();
  applyCardBgAlpha(0.62);
  assert.equal(store.get('cure_card_bg_alpha'), '0.62');
  assert.equal(store.get('cure_card_bg_alpha_version'), '2');
  assert.equal(getStoredCardBgAlpha(), 0.62);
});

/* —— 浮层提示卡（底部「保存/安装到桌面」提示、今日打卡条）的白纱下限（2026-09-27 立） ——
 *
 * 背景：新用户默认卡片透明度 0.38，这两条浮层压在首页 hero 插画上，实测说明字对比度只有 2.2:1
 * （最暗像素处 1.2:1），用户反馈「保存到手机桌面的提示背景太透了」。改法见 index.css 的
 * .card-white-toast（给浮层一个可读性下限，不再跟着内容卡一起透）。
 * 本测试守三件事：① CSS 里的下限 ≥0.9；② 两个浮层组件确实用 card-white-toast（不许退回裸 card-white）；
 * ③ 这个下限在**纯黑背景**（最坏情况）下仍让标题 #1F2937 ≥7:1、说明字 #667085 ≥3.9:1。
 * 说明字要真到 AA 4.5:1 需要下限 ≈0.96（或把字色换深），本轮只动背景未动字色——所以这里守的是
 * 「不再是一层纱」的实际下限，而不是一条够不到的 AA 线。 */
const relLum = (rgb: number[]): number => {
  const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
};
const hexLum = (h: string): number => { const n = parseInt(h.slice(1), 16); return relLum([(n >> 16) & 255, (n >> 8) & 255, n & 255]); };
const contrast = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

test('浮层提示卡：白纱下限 ≥0.9，且最坏（纯黑）背景下标题 ≥7:1 / 说明字 ≥3.9:1', () => {
  const css = fs.readFileSync('src/index.css', 'utf8');
  const m = /\.card-white-toast\s*\{[^}]*clamp\(\s*([\d.]+)\s*,/.exec(css);
  assert.ok(m, 'index.css 应定义 .card-white-toast 的 clamp 下限');
  const floor = Number(m![1]);
  assert.ok(floor >= 0.9 && floor <= 1, `下限 ${floor} 应在 [0.9, 1]（低于 0.9 就会退回到"一层纱"）`);

  const overBlack = (a: number) => relLum([255 * a, 255 * a, 255 * a]);
  assert.ok(contrast(hexLum('#1F2937'), overBlack(floor)) >= 7, '标题在最坏背景下要 ≥7:1');
  assert.ok(contrast(hexLum('#667085'), overBlack(floor)) >= 3.9, '说明字在最坏背景下要 ≥3.9:1');
});

test('两个底部浮层都用 card-white-toast（不许退回裸 card-white）', () => {
  for (const f of ['src/components/InstallAppBanner.tsx', 'src/components/MoodRewardBanner.tsx']) {
    const src = fs.readFileSync(f, 'utf8');
    assert.match(src, /card-white-toast/, `${f} 应使用 card-white-toast`);
    const bare = src.split('\n').filter((l) => /card-white(?![\w-])/.test(l));
    assert.equal(bare.length, 0, `${f} 仍有裸 card-white：${bare.join(' | ')}`);
  }
});
