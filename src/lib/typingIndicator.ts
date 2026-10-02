/**
 * 「正在输入」指示器的 **JS 兜底驱动**（2026-09-20，用户实测「还是没动画，就是静止的」后补）。
 *
 * 为什么需要它，CSS 动画在某些环境里会被整条掐掉，而且这些环境我都改不动：
 *   ① 系统/浏览器开了「减弱动效」（`prefers-reduced-motion: reduce`）：`src/index.css` 顶部那条全局规则
 *      `* { animation-duration: .01ms !important; animation-iteration-count: 1 !important }` 会把所有动画压没；
 *   ② 浏览器扩展 / 省电模式 / 老 WebView 之类的「一律禁动画」策略；
 *   ③ 任何我们没预料到的、把 `animation` 变成空转的环境。
 * 用户已经报过一次「只有第一个点在动」、一次「完全静止」，两次都发生在**同一套 CSS 规则之下**，
 * 说明不能再赌「CSS 动画一定会跑」。所以这里补一条不依赖 CSS 动画的通路。
 *
 * 为什么不会和 CSS 打架（关键）：CSS 层叠里 **animation 的优先级高于行内样式**。
 *   所以本函数照常每帧写 `el.style.transform/opacity`：
 *     · CSS 动画在跑 → 动画赢，行内样式被忽略（视觉与现在完全一致，不会抖、不会双驱动）；
 *     · CSS 动画被掐 → 行内样式生效，波浪照旧在动。
 *   同一份形状/节奏在两条通路上复用：周期从 CSS 自定义属性 `--typing-cycle` 读（单一事实来源），
 *   相位公式与 `.typing-dots span:nth-child()` 的负延迟严格等价（第 i 条相位 = t/T − i/3）。
 *
 * 减弱动效下用「不位移的明暗呼吸」软波形（与 CSS 的 `typing-wave-soft` 同形），
 * 减的是大幅位移（前庭敏感），而不是把「正在输入」这个功能性反馈一起取消。
 */

const DEFAULT_CYCLE_MS = 900;

/** 读 `--typing-cycle`（写的是 900ms，也兼容 0.9s / 裸数字）。读不到就退回 900ms。 */
export function readTypingCycleMs(root: HTMLElement): number {
  try {
    const raw = getComputedStyle(root).getPropertyValue('--typing-cycle').trim();
    if (!raw) return DEFAULT_CYCLE_MS;
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_CYCLE_MS;
    return /ms$/i.test(raw) ? n : n * 1000;
  } catch {
    return DEFAULT_CYCLE_MS;
  }
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** 0→1 的连续波（余弦，峰在相位 0.5，与 CSS 关键帧的 50% 峰值对齐，全程无死区）。 */
function wave(phase: number): number {
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
}

/**
 * 在 `root`（`.typing-dots`）上启动兜底驱动，返回停止函数（组件卸载时调用）。
 * 刻意不做「先探测 CSS 有没有在跑」：指示器只活 420ms 左右，探测窗口就吃掉大半；
 * 而多写几帧无用的行内样式代价可忽略（三条元素、只在气泡存在期间）。
 */
export function startTypingIndicatorDriver(root: HTMLElement): () => void {
  const bars = Array.from(root.children).filter((el): el is HTMLElement => el instanceof HTMLElement);
  if (bars.length === 0) return () => { /* 无子元素，无事可做 */ };

  const cycle = readTypingCycleMs(root);
  const soft = prefersReducedMotion();
  let raf = 0;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    // 用绝对时钟而不是「挂载时刻」：相位跨挂载连续，永远不会停在相位的 0 点（等价于 CSS 的负延迟）
    const base = (performance.now() % cycle) / cycle;
    for (let i = 0; i < bars.length; i++) {
      // 与 CSS 负延迟严格等价：第 i 条相位 = base − i/3（CSS: delay = i·T/3 − T）
      const phase = (((base - i / 3) % 1) + 1) % 1;
      const w = wave(phase);
      const scaleY = soft ? 0.75 + 0.25 * w : 0.35 + 0.65 * w;
      const opacity = 0.45 + 0.55 * w;
      const el = bars[i];
      el.style.transform = `scaleY(${scaleY.toFixed(3)})`;
      el.style.opacity = opacity.toFixed(3);
    }
    raf = requestAnimationFrame(tick);
  };
  tick();

  return () => {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    for (const el of bars) {
      el.style.transform = '';
      el.style.opacity = '';
    }
  };
}
