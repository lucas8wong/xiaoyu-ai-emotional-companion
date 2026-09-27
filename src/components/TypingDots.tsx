/**
 * 「正在输入」指示器（三条薄荷呼吸条）—— 聊一聊 / 剧情共用的那一颗原子。
 *
 * 为什么要有这个组件（原来两处各自内联 `<span class="typing-dots">`）：
 * 光靠 CSS 动画不够 —— 系统「减弱动效」、浏览器扩展或任何「禁动画」策略会把它整条掐掉，
 * 用户就只看到三条静止的竖条（实测反馈过两次）。所以样式（`src/index.css`）之外，
 * 这里再挂一条不依赖 CSS 动画的 JS 兜底驱动（`src/lib/typingIndicator.ts`）。
 *
 * 调用方：聊一聊 `ChatPage`、剧情 `RoleplayPage`（可访问性口径不变：三条空 span 本身不承载文字，
 * 「正在输入」的状态仍由气泡下方那行文案/剧情页上下文表达）。
 */
import { useEffect, useRef } from 'react';
import { startTypingIndicatorDriver } from '../lib/typingIndicator';

export default function TypingDots() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    return startTypingIndicatorDriver(ref.current);
  }, []);
  return (
    <span ref={ref} className="typing-dots">
      <span />
      <span />
      <span />
    </span>
  );
}
