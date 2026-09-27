/**
 * 「要离开时」的温馨引导（留存联动：安装 × 主动找我）。
 * 桌面版鼠标移出页面顶部时触发一次（每会话最多一次）；已安装不再弹。
 * 按状态给不同内容：可安装→「现在装」按钮；iOS→「看怎么装」引导；不支持→提醒回来/主动找我。
 */
import { X, Heart, Download, Smartphone } from 'lucide-react';
import { t } from '../i18n';
import type { PwaInstallMode } from '../hooks/usePwaInstall';

export default function InstallExitModal({
  open,
  onClose,
  onOpenGuide,
  installed,
  mode,
  promptInstall,
  onOpenProactivePush,
}: {
  open: boolean;
  onClose: () => void;
  onOpenGuide: () => void;
  installed: boolean;
  mode: PwaInstallMode;
  promptInstall: () => Promise<string>;
  onOpenProactivePush?: () => void; // 直达「主动找我」偏好
}) {
  if (!open || installed) return null;

  const body = mode === 'install' ? t('exitBodyInstall') : mode === 'ios' ? t('exitBodyIos') : t('exitBodyOther');
  const Icon = mode === 'install' ? Download : mode === 'ios' ? Smartphone : Heart;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative max-w-sm w-full rounded-2xl overflow-hidden shadow-lift border border-clay-border">
        <div className="bg-gradient-to-br from-primary-soft to-amber-50 px-5 pt-5 pb-4 text-center">
          <span className="mx-auto mb-2 w-12 h-12 rounded-full bg-white/80 flex items-center justify-center text-primary shadow-sm">
            <Icon className="w-6 h-6" />
          </span>
          <h3 className="text-lg font-bold text-ink leading-snug">{t('exitTitle')}</h3>
        </div>
        <div className="bg-white px-5 pb-5 pt-2">
          <p className="text-sm text-gray-600 leading-relaxed text-center">{body}</p>
          {mode === 'install' && (
            <button
              onClick={() => { void promptInstall(); onClose(); }}
              className="mt-4 w-full text-white bg-primary hover:bg-primary-strong py-2.5 rounded-full text-sm font-semibold transition-all"
            >
              {t('exitBtnInstall')}
            </button>
          )}
          {(mode === 'ios' || mode === 'manual') && (
            <button
              onClick={() => { onClose(); onOpenGuide(); }}
              className="mt-4 w-full text-white bg-primary hover:bg-primary-strong py-2.5 rounded-full text-sm font-semibold transition-all"
            >
              {t('exitBtnGuide')}
            </button>
          )}
          {onOpenProactivePush && (
            <button
              onClick={onOpenProactivePush}
              className="mt-2 w-full text-primary border border-primary/40 hover:bg-primary-soft py-2.5 rounded-full text-sm font-semibold transition-all"
            >
              {t('proactiveOpen')}
            </button>
          )}
          <button
            onClick={onClose}
            className="mt-2 w-full text-ink-soft hover:text-gray-700 py-2 rounded-full text-sm font-medium transition-colors"
          >
            {t('exitBtnLater')}
          </button>
        </div>
        <button
          onClick={onClose}
          aria-label={t('installSaveDismiss')}
          title={t('installSaveDismiss')}
          className="absolute top-3 right-3 text-white/80 hover:text-white p-1"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
