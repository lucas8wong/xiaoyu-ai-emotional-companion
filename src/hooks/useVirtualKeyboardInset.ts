/**
 * useVirtualKeyboardInset —— 用 VirtualKeyboard API 取「软键盘高度」（CSS px）。
 *
 * 背景：Instagram 的 Android 内嵌浏览器（Chromium WebView）键盘是**纯覆盖层**——实测键盘弹起前后
 * `window.innerHeight`、`visualViewport.height/offsetTop`、`window.scrollY`、输入框 `getBoundingClientRect()`
 * **全部不变**，网页拿不到任何视口信号，因此无法用视口差值推算键盘高度。
 *
 * 覆盖式键盘在 Chromium 上有专门 API：`navigator.virtualKeyboard`。
 * - 设 `overlaysContent = true` 明确告知「键盘覆盖内容」，此时浏览器才会把键盘几何暴露出来；
 * - `boundingRect` 给出键盘在视口中的矩形，`.height` 即键盘高度（隐藏时为 0）；
 * - `geometrychange` 在键盘显示/隐藏/变高变矮时触发。
 *
 * 返回键盘高度（0 = 无键盘 / 不支持该 API）。不支持时调用方应回退到其它方案。
 */
import { useEffect, useState } from 'react';

interface VirtualKeyboardLike {
  overlaysContent?: boolean;
  boundingRect?: { height?: number } | null;
  addEventListener?: (type: string, fn: () => void) => void;
  removeEventListener?: (type: string, fn: () => void) => void;
}

export function virtualKeyboardSupported(): boolean {
  if (typeof navigator === 'undefined') return false;
  return !!(navigator as unknown as { virtualKeyboard?: VirtualKeyboardLike }).virtualKeyboard;
}

/** 应用内浏览器（IG / FB / 微信 / Line 等）：这些 WebView 的键盘常为纯覆盖层、不给视口信号，
 *  需要显式 `overlaysContent = true` 让浏览器暴露键盘几何。普通浏览器（Chrome/Safari）**不要**设，
 *  否则会覆盖它原本「键盘收缩布局视口」的行为、反而把输入栏弄歪。 */
function isInAppBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /(Instagram|FBAN|FBAV|FB_IAB|FB4A|Line\/|MicroMessenger|Twitter)/i.test(ua);
}

export function useVirtualKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    const vk = (navigator as unknown as { virtualKeyboard?: VirtualKeyboardLike }).virtualKeyboard;
    if (!vk) return;

    const read = () => {
      const r = vk.boundingRect;
      const h = r && typeof r.height === 'number' ? Math.max(0, Math.round(r.height)) : 0;
      setInset(prev => (prev === h ? prev : h));
    };

    // 仅内嵌浏览器：显式声明「键盘覆盖内容」，浏览器才会把键盘几何暴露给页面。
    if (isInAppBrowser()) {
      try { vk.overlaysContent = true; } catch { /* 忽略 */ }
    }

    read();
    vk.addEventListener?.('geometrychange', read);
    // 兜底轮询：部分 WebView 不派发 geometrychange
    const t = window.setInterval(read, 250);
    return () => {
      vk.removeEventListener?.('geometrychange', read);
      window.clearInterval(t);
    };
  }, []);

  return inset;
}
