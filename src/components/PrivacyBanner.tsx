/**
 * 隐私提示横幅（非阻塞）：替代原全屏同意门
 * 正文直接渲染（利于 Google/AI 爬虫索引首页内容），底部常驻横幅提示隐私政策；
 * 点「同意并继续」或 ✕ 即记录同意（继续使用即视为同意，与横幅文案一致）。
 * 完整隐私政策与免责声明通过全局 PrivacyModal 打开。
 */
import { useLayoutEffect, useRef } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { t } from '../i18n';
import { useAppStore } from '../store/useAppStore';

interface PrivacyBannerProps {
  onAgree: () => void;
}

export default function PrivacyBanner({ onAgree }: PrivacyBannerProps) {
  const setPrivacyOpen = useAppStore((s) => s.setPrivacyOpen);
  const setPrivacyBannerH = useAppStore((s) => s.setPrivacyBannerH);
  const bannerRef = useRef<HTMLDivElement>(null);

  // 把横幅自身高度暴露给 store，供聊一聊等底部布局为其预留空间（避免遮挡输入栏 / coach 高亮）。
  // useLayoutEffect 在绘制前读取，避免首帧闪现空白；ResizeObserver 处理响应式（移动端堆叠等）高度变化。
  useLayoutEffect(() => {
    const el = bannerRef.current;
    if (!el) return;
    const report = () => setPrivacyBannerH(el.offsetHeight);
    report();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(report) : null;
    ro?.observe(el);
    window.addEventListener('resize', report);
    window.addEventListener('orientationchange', report);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', report);
      window.removeEventListener('orientationchange', report);
      setPrivacyBannerH(0); // 卸载（已同意/关闭）后释放预留空间
    };
  }, [setPrivacyBannerH]);

  return (
    <div ref={bannerRef} className="fixed bottom-0 inset-x-0 z-[60] bg-white/95 backdrop-blur border-t border-gray-200 shadow-[0_-4px_20px_rgba(0,0,0,0.08)]">
      <div className="container mx-auto px-3 sm:px-4 py-3 flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-4">
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <ShieldCheck className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
          <p className="text-xs sm:text-sm text-gray-600 leading-relaxed">
            {t('bannerNote')}{' '}
            <button
              onClick={() => setPrivacyOpen(true)}
              className="text-primary-text underline underline-offset-2 hover:text-primary font-medium"
            >
              {t('viewPrivacy')}
            </button>
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 self-end sm:self-auto">
          <button
            onClick={onAgree}
            className="bg-primary-strong text-white text-xs sm:text-sm font-semibold px-4 py-2 rounded-lg hover:bg-primary transition-all duration-200"
          >
            {t('agree')}
          </button>
          <button
            onClick={onAgree}
            aria-label={t('bannerDismiss')}
            className="w-7 h-7 rounded-full flex items-center justify-center text-ink-soft hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
