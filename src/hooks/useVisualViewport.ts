/**
 * useVisualViewport —— 监听 browser / embedded webview 的 visualViewport，
 * 返回 { height, inset, offsetTop, offsetLeft }，用「可视视口」而不是 CSS 的 `100dvh` 来约束聊天容器高度。
 *
 * 背景：聊一聊底部输入栏在 Instagram 等应用内浏览器里会跑到软键盘后面消失。
 * 根因是这类 webview 对软键盘的表现不一致：
 *  - iOS/WKWebView：键盘是「覆盖式」，`window.innerHeight`（布局视口）不变，
 *    但 `visualViewport.height` 会缩小（= 屏幕可视区），旧写法靠
 *    `innerHeight - visualViewport.height` 算键盘高再加底部占位块；
 *  - 部分嵌入式 webview：`visualViewport.height` 缩了，可 CSS 的 `100dvh`
 *    仍按旧布局视口算（没跟着缩），于是容器高度没变小、又没占位块 → 输入栏被键盘盖住。
 *
 * 修复思路：把容器高度直接设成「可视视口高度」，让容器底边永远贴住屏幕可视底边（键盘上方）。
 * 无论键盘是覆盖式（visualViewport.height 缩小）还是布局压缩式（window.innerHeight 缩小），
 * 输入栏都会待在该底边之上，不再依赖 `100dvh` 是否同步变化，也无需额外底部占位块（避免叠算）。
 *
 * 取 `min(visualViewport.height, window.innerHeight)`：覆盖式键盘下 visualViewport.height 更小；
 * 布局压缩式下两者相等（都缩小）。个别 webview 只缩其中一者时也能取到较小值，避免输入栏被键盘盖住。
 *
 * —— 关于 offsetTop（Instagram 等 webview 的「平移漂移」）——
 * 即使 `overflow:hidden` + `body{position:fixed}`，iOS WKWebView 的软键盘仍会**平移 visual viewport**
 * （`visualViewport.offsetTop > 0`，见 WebKit bug 311821）。此时一个 `position:fixed; top:0` 的容器
 * 仍锚在「布局视口」顶部，会随平移一起被推出可视区 → 输入框消失。因此这里把 offsetTop/offsetLeft 一并暴露，
 * 由调用方把固定壳的 `top` 设为 `offsetTop`，让壳始终贴住可视区域顶部。
 *
 * 另外，部分 webview 在键盘弹起时不派发 visualViewport 的 resize/scroll 事件，这里加一个低频 setInterval
 * 兜底同步，并做浅比较避免无效重渲染。
 */
import { useEffect, useState } from 'react';

/** 可视视口高度（CSS px）。取 visualViewport.height 与 window.innerHeight 的较小者；
 *  并 clamp 到 `innerHeight - offsetTop`——部分 iOS/WKWebView 在键盘弹起时**只平移**
 *  （visualViewport.offsetTop > 0）而不缩 visualViewport.height，此时真正可见（键盘上方）的高度
 *  最多为 `innerHeight - offsetTop`。取两者较小值，避免「top=offsetTop + 全高容器」把输入栏推出可视区。 */
function visibleHeight(): number {
  const vv = window.visualViewport;
  const inner = window.innerHeight || 0;
  if (!vv) return inner;
  const panned = Math.max(0, vv.offsetTop || 0);
  const panLimited = Math.max(0, inner - panned);
  return Math.min(vv.height, panLimited);
}

/** 软键盘遮住的高度（CSS px）：window.innerHeight - 可视高度。无键盘时为 0。 */
function keyboardInset(): number {
  return Math.max(0, (window.innerHeight || 0) - visibleHeight());
}

/** visual viewport 相对布局视口的平移量（CSS px）。iOS/webview 键盘弹起时常 > 0。 */
function viewportOffset(): { top: number; left: number } {
  const vv = window.visualViewport;
  return {
    top: vv ? Math.max(0, Math.round(vv.offsetTop || 0)) : 0,
    left: vv ? Math.max(0, Math.round(vv.offsetLeft || 0)) : 0,
  };
}

export interface VisualViewportSize {
  /** 当前可视视口高度（CSS px）。软键盘弹起时会缩小，约等于「屏幕可视区」高度。 */
  height: number;
  /** 软键盘遮住的高度（CSS px）：window.innerHeight - 可视高度。无键盘时为 0。 */
  inset: number;
  /** visual viewport 距布局视口顶部的平移（CSS px）；键盘弹起导致页面被平移时 > 0。 */
  offsetTop: number;
  /** visual viewport 距布局视口左侧的平移（CSS px）；一般键盘弹起时为 0。 */
  offsetLeft: number;
}

function readSize(): VisualViewportSize {
  const { top, left } = viewportOffset();
  return {
    height: Math.round(visibleHeight()),
    inset: Math.round(keyboardInset()),
    offsetTop: top,
    offsetLeft: left,
  };
}

function sameSize(a: VisualViewportSize, b: VisualViewportSize): boolean {
  return a.height === b.height && a.inset === b.inset && a.offsetTop === b.offsetTop && a.offsetLeft === b.offsetLeft;
}

export function useVisualViewport(): VisualViewportSize {
  const [size, setSize] = useState<VisualViewportSize>(() => {
    if (typeof window === 'undefined' || typeof window.visualViewport === 'undefined') {
      return { height: 0, inset: 0, offsetTop: 0, offsetLeft: 0 };
    }
    return readSize();
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => {
      const next = readSize();
      setSize(prev => (sameSize(prev, next) ? prev : next));
    };
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', update);
      vv.addEventListener('scroll', update);
    }
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    // 部分 embedded webview 在键盘弹起时不派发 visualViewport/window 事件，低频轮询兜底。
    const interval = window.setInterval(update, 250);
    update();
    return () => {
      if (vv) {
        vv.removeEventListener('resize', update);
        vv.removeEventListener('scroll', update);
      }
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      window.clearInterval(interval);
    };
  }, []);

  return size;
}
