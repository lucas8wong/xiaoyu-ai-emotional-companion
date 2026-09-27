/**
 * 「聊天壳底边锚定」判据的单测。
 *
 * 这一条是**用户实测反馈**换来的：`innerHeight − 可视视口高度` 在「浏览器工具栏收缩」时也会 > 0，
 * 若一律拿它当底边距离，壳会比视口矮 → 下方露出**皮肤氛围背景图**（用户原话："输入框下面有很大一块空白"）。
 * 所以必须把「真键盘」和「其它收缩」分开，且这个分界**不许被后续重构简化掉**。
 * 复现脚本：`temp/verify-input-bottom.mjs`（注入假 visualViewport，实测 gap 9.6px 才算贴底）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bottomAnchorPx, KEYBOARD_MIN_PX } from '../../src/lib/viewportAnchor.js';

test('🔴 底边锚定：工具栏级别的收缩（≤~100px）不许抬底边，否则会露出皮肤背景图', () => {
  assert.strictEqual(bottomAnchorPx(0), 0, '无遮挡 → 铺到视口底边');
  assert.strictEqual(bottomAnchorPx(48), 0, '工具栏收缩 48px → 不抬（抬了就留白）');
  assert.strictEqual(bottomAnchorPx(80), 0, '工具栏收缩 80px（实测复现的那档）→ 不抬');
  assert.strictEqual(bottomAnchorPx(119), 0, '阈值以下都不抬');
});

test('底边锚定：真键盘（≥120px）必须抬，否则输入框被键盘挡住', () => {
  assert.strictEqual(KEYBOARD_MIN_PX, 120);
  assert.strictEqual(bottomAnchorPx(120), 120, '刚好到阈值 → 抬');
  assert.strictEqual(bottomAnchorPx(300), 300, '典型键盘高度 → 抬到键盘上方');
  assert.strictEqual(bottomAnchorPx(345.6), 346, '取整到整数像素');
});

test('底边锚定：异常输入一律退回"铺到视口底边"（宁可贴底，不可留白）', () => {
  assert.strictEqual(bottomAnchorPx(Number.NaN), 0);
  assert.strictEqual(bottomAnchorPx(Number.POSITIVE_INFINITY), 0);
  assert.strictEqual(bottomAnchorPx(-50), 0);
});
