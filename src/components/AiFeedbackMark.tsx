/**
 * AI 输出旁的「反馈小标」
 * 放在各 AI 输出（聊一聊回复 / 理一理故事 / 角色扮演台词）下方，低调、可点：
 * 点击后打开全局反馈弹窗，并把该输出所在上下文带上，供用户决定是否附上。
 */

import { ThumbsDown } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { t } from '../i18n';

interface AiFeedbackMarkProps {
  context?: string;
  className?: string;
}

export default function AiFeedbackMark({ context, className = '' }: AiFeedbackMarkProps) {
  const openFeedback = useAppStore(s => s.openFeedback);
  return (
    <button
      type="button"
      onClick={() => openFeedback({ context, type: 'suggest' })}
      aria-label={t('fbMarkAi')}
      title={t('fbMarkAi')}
      className={'inline-flex items-center text-ink-soft hover:text-ink-soft bg-white/80 rounded-full p-1.5 shadow-sm transition-colors ' + className}
    >
      <ThumbsDown className="w-4 h-4" />
    </button>
  );
}
