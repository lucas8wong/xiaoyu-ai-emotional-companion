/**
 * 常显「复制」小按钮，聊一聊 / 剧情演绎 / 理一理的 AI 信息框共用。
 *
 * 解决的问题：AI 给的每条内容此前只有「长按 / 悬停」才会露出操作入口，
 * 用户不点、不长按就不知道能单独复制那一条。这里把它做成**一直可见**的弱化小按钮：
 * - 常显（不依赖 hover），但视觉很轻（白底片 + 浅描边 + ink-soft 文字），不抢 AI 内容；
 * - 点一下 → 图标变 ✓ + 「已复制」约 1.6s，动静明确（手机上看不到 title，所以给可见文案）；
 * - onPointerDown/onClick 都 stopPropagation：不会顺带触发聊一聊气泡的长按操作菜单；
 * - 复制走 src/lib/clipboard.ts（Clipboard API 优先 + execCommand 兜底，失败也不会静默）。
 *
 * 可读性沿用 2026-09-04 的图标修法：白底片 + 皮肤感知色，在鲜艳皮肤（棉花糖等）上也看得清。
 */

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { t } from '../i18n';
import { copyText } from '../lib/clipboard';

interface CopyButtonProps {
  /** 要复制的文本 */
  text: string;
  /** 是否常显「复制」两个字（默认 false：只显示图标，用于消息时间戳行等窄处） */
  showLabel?: boolean;
  /** 附加类名（由调用方控制间距/对齐） */
  className?: string;
  /** 复制成功后的回调（如需要额外埋点/提示） */
  onCopied?: () => void;
}

export default function CopyButton({ text, showLabel = false, className = '', onCopied }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const ok = await copyText(text);
    if (!ok) return;
    setCopied(true);
    onCopied?.();
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1600);
  };

  const label = copied ? t('actionCopied') : t('actionCopy');

  return (
    <button
      type="button"
      onClick={handleCopy}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label={label}
      title={label}
      className={
        'inline-flex items-center gap-1 rounded-full border shadow-sm select-none transition-colors ' +
        (showLabel ? 'px-2 py-[3px] ' : "p-1.5 relative after:absolute after:-inset-1 after:content-[''] ") +
        (copied
          ? 'bg-primary-lighter border-primary/30 text-primary-text '
          : 'bg-white/80 border-clay-border text-ink-soft hover:text-primary-text hover:border-primary/30 ') +
        className
      }
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      {(showLabel || copied) && <span className="text-[11px] leading-none">{label}</span>}
    </button>
  );
}
