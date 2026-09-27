import { useEffect } from 'react';

/**
 * 真机 iOS Safari 软键盘处理（聊一聊 / 剧情对局共享）：
 * - html/body 不可滚动 + body 钉成 fixed 全屏壳 → 文档无可滚动区域，页面不会被拖动/整页位移。
 * - 关闭文档级平滑滚动（index.css 的 `html{scroll-behavior:smooth}`），否则键盘弹起时的页面
 *   滚动/回落被平滑动画掉，输入框表现为「先飞高再慢慢滑落到键盘」，非常割裂。
 * - 兜底：若 iOS 仍试图滚动（visualViewport.offsetTop 短暂非 0），瞬时回到顶部，避免输入栏悬空/留白。
 *
 * ⚠️ 只对 iOS 生效：Android 的 WebView/Chrome 是靠**收缩布局视口**（`interactive-widget=resizes-content`
 * 让 `window.innerHeight` 随键盘缩小，见 super-productivity #9277）来给键盘让位，不需要也没法靠
 * 「锁 body 滚动」——锁定反而会卡住系统对键盘的处理、把输入栏盖在键盘下面。Android 交给
 * `useVisualViewport`（高度=min(visualViewport.height, window.innerHeight)）随视口收缩即可。
 *
 * @param active 为 false 时不加锁（例如剧情模式只在「对局聊天」阶段才锁，
 *               列表/详情/自建表单页仍需正常滚动，不能也不该锁定正文滚动）。
 */
function isIosBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // iPhone/iPad/iPod；iPadOS 13+ 伪装成 Mac（带 "Mobile"）
  return /(iPhone|iPad|iPod)/i.test(ua) || (/Macintosh/i.test(ua) && /Mobile/i.test(ua));
}

export function useIosKeyboardLock(active = true): void {
  useEffect(() => {
    if (!active || !isIosBrowser()) return;
    const html = document.documentElement;
    const body = document.body;
    const prev = {
      htmlOverflow: html.style.overflow,
      htmlOverflowY: html.style.overflowY,
      bodyOverflow: body.style.overflow,
      bodyOverflowY: body.style.overflowY,
      bodyPos: body.style.position,
      bodyTop: body.style.top,
      bodyLeft: body.style.left,
      bodyW: body.style.width,
      bodyH: body.style.height,
      htmlScrollBehavior: html.style.scrollBehavior,
    };
    html.style.overflow = 'hidden';
    html.style.overflowY = 'hidden';
    body.style.overflow = 'hidden';
    body.style.overflowY = 'hidden';
    body.style.position = 'fixed';
    body.style.top = '0';
    body.style.left = '0';
    body.style.width = '100%';
    body.style.height = '100%';
    html.style.scrollBehavior = 'auto';
    const resetScroll = () => { if (window.scrollY > 0) window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); };
    const vv = window.visualViewport;
    if (vv) vv.addEventListener('scroll', resetScroll);
    window.addEventListener('scroll', resetScroll, { passive: true });
    return () => {
      html.style.overflow = prev.htmlOverflow;
      html.style.overflowY = prev.htmlOverflowY;
      body.style.overflow = prev.bodyOverflow;
      body.style.overflowY = prev.bodyOverflowY;
      body.style.position = prev.bodyPos;
      body.style.top = prev.bodyTop;
      body.style.left = prev.bodyLeft;
      body.style.width = prev.bodyW;
      body.style.height = prev.bodyH;
      html.style.scrollBehavior = prev.htmlScrollBehavior;
      if (vv) vv.removeEventListener('scroll', resetScroll);
      window.removeEventListener('scroll', resetScroll);
    };
  }, [active]);
}
