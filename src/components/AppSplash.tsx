/**
 * 应用内「启动画面」：已安装 PWA（standalone）打开时，短暂展示 hero 完整画面
 * （hero 背景 + 爱心 logo + 品牌标语），再淡出进入主页。
 * - 只在 standalone（已安装为 App）时显示；普通浏览器标签页不出现。
 * - 每个会话最多一次（sessionStorage），避免反复刷屏。
 * 注：OS 级 PWA splash 只能显示图标+底色，无法带文字，故用本组件补上「整个 hero 画面」。
 */
import { useEffect, useState } from 'react';
import { useSkin } from './SkinProvider';
import { t } from '../i18n';
import { ssGet, ssSet } from '../lib/safeStorage';

function isStandaloneApp(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const md = window.matchMedia?.('(display-mode: standalone)');
    if (md && md.matches) return true;
    return (navigator as unknown as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

export default function AppSplash() {
  const { meta } = useSkin();
  const [phase, setPhase] = useState<'show' | 'fade' | 'gone'>('show');

  useEffect(() => {
    if (!isStandaloneApp()) { setPhase('gone'); return; }
    // 存储被禁（Safari 无痕 / 内嵌 WebView）时裸调 sessionStorage 会抛异常；
    // 这里发生在**挂载期 effect**（渲染路径）→ 会整页白。走 safeStorage：读不到=当作没看过。
    if (ssGet('cure_splash_seen') === '1') { setPhase('gone'); return; }
    ssSet('cure_splash_seen', '1');
    const f1 = setTimeout(() => setPhase('fade'), 1200);
    const f2 = setTimeout(() => setPhase('gone'), 1900);
    return () => { clearTimeout(f1); clearTimeout(f2); };
  }, []);

  if (phase === 'gone' || !meta.hero) return null;

  return (
    <div className={'fixed inset-0 z-[100] flex flex-col items-center justify-center transition-opacity duration-700 ' + (phase === 'fade' ? 'opacity-0' : 'opacity-100')}>
      <img src={meta.hero} alt="" className="absolute inset-0 w-full h-full object-cover" />
      <div className="absolute inset-0 bg-white/10" />
      <div className="relative flex flex-col items-center gap-4 px-6 text-center">
        {meta.heart && (
          <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-2xl sm:rounded-3xl overflow-hidden bg-white shadow-lift ring-4 ring-white/50">
            <img src={meta.heart} alt="" className="w-full h-full object-cover" />
          </div>
        )}
        <p className="font-display text-2xl sm:text-3xl font-bold text-ink text-center leading-snug">{t('brandLine')}</p>
        <p className="text-sm sm:text-base text-primary-text text-center leading-snug">{t('heroSub')}</p>
      </div>
    </div>
  );
}
