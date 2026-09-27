/**
 * 意见反馈按钮（通用）：点击打开全局反馈弹窗
 * 各功能页（聊一聊/理一理/角色扮演/了解小愈…）统一使用此组件
 */

import { SkinFeedbackIcon } from './SkinIcon';
import { useAppStore } from '../store/useAppStore';
import { t } from '../i18n';

export default function FeedbackButton({ className = '' }: { className?: string }) {
  const setFeedbackOpen = useAppStore(s => s.setFeedbackOpen);
  return (
    <button
      type="button"
      onClick={() => setFeedbackOpen(true)}
      aria-label={t('profileFeedback')}
      title={t('profileFeedback')}
      className={'p-2 rounded-lg text-ink-soft hover:text-primary-text hover:bg-primary-lighter transition-colors ' + className}
    >
      <SkinFeedbackIcon className="w-6 h-6" />
    </button>
  );
}