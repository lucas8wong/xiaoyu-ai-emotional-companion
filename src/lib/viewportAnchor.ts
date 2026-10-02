/**
 * 聊天壳「底边锚定」的判定（纯函数，便于单测锁死）。
 *
 * 背景（2026-09-15 用户反馈「输入框下面有很大一块空白」）：
 *   那块空白**是皮肤氛围背景图**，`.skin-backdrop` 是铺满视口的 `position: fixed` 层，
 *   而聊天壳用的是**透明的** `bg-brand`；只要壳比视口矮，下面露出来的就是皮肤底图。
 *
 * 为什么不能直接用 `innerHeight − 可视视口高度` 当底边距离：
 *   这个差值在**两种**情况下都 > 0：
 *     ① 软键盘弹起（真键盘，通常 ≥200px），这时**应该**把底边抬上去，否则输入框被键盘挡住；
 *     ② 浏览器工具栏收缩 / webview 平移（通常 ≤100px），这时**不该**抬，抬了就会露出皮肤底图。
 *   原写法（含上一版 `bottom: inset`）把两者一视同仁 → 情况②下壳变矮 → 留白。
 *
 * 所以用阈值区分：**只有 ≥120px 才当作真键盘**。
 * 验证脚本：`temp/verify-input-bottom.mjs`（注入假 visualViewport 复现两种场景）。
 */
export const KEYBOARD_MIN_PX = 120;

/** 返回聊天壳的 `bottom` 值（px）：0 = 一直铺到布局视口底边；>0 = 键盘弹起，底边抬到键盘上方。 */
export function bottomAnchorPx(keyboardInset: number): number {
  if (!Number.isFinite(keyboardInset) || keyboardInset < KEYBOARD_MIN_PX) return 0;
  return Math.round(keyboardInset);
}
