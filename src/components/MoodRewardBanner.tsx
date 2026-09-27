/**
 * 每日心情打卡奖励·底部非阻塞引导条
 * - 仅登录用户「今天还没打卡」时，由 Home 控制展示（顶栏打卡入口也会有 🎁 可领取角标）。
 * - 点击「去打卡」打开心情打卡弹窗；点 × 关闭（关闭后本会话不再出现，由 Home 写入 localStorage）。
 * - 不打断操作、不遮挡首屏，延续「温柔陪伴」调性。
 */
import { X, Gift } from 'lucide-react';
import { t } from '../i18n';

export default function MoodRewardBanner({
  onCheckin,
  onDismiss,
}: {
  onCheckin: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="pointer-events-none w-full flex justify-center sm:w-auto sm:justify-end">
      {/* 与 InstallAppBanner 同一套浮层版式：桌面收成右下角窄卡（F7），移动端保持原样通栏居中 */}
      <div className="pointer-events-auto max-w-md w-full sm:w-[22rem] card-white-toast rounded-2xl border border-amber-200 shadow-lg px-3.5 py-3">
        <div className="flex items-center gap-3">
          <span className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-amber-50 text-amber-600">
            <Gift className="w-5 h-5" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-800 leading-tight">{t('moodRewardBannerTitle')}</p>
            <p className="text-xs text-ink-soft leading-snug mt-0.5">{t('moodRewardBannerDesc')}</p>
          </div>
          <button
            onClick={onCheckin}
            className="flex-shrink-0 text-xs font-semibold text-white bg-amber-500 hover:bg-amber-600 px-3 py-2 rounded-full transition-all"
          >
            {t('moodRewardBannerBtn')}
          </button>
          <button
            onClick={onDismiss}
            aria-label={t('moodRewardBannerDismiss')}
            title={t('moodRewardBannerDismiss')}
            className="flex-shrink-0 text-ink-soft hover:text-gray-600 p-1.5 -mr-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
