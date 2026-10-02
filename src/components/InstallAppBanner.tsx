/**
 * 建议用户「保存/安装」Xiaoyu 的底部轻提示
 * - 可安装（桌面 Chrome/Edge/安卓）：给「安装」按钮 → 真正触发安装。
 * - iOS：给「添加到主屏幕」手动引导（无按钮）。
 * - 已安装 / 本次会话已关闭 / 均不支持：不渲染（由 usePwaInstall 的 mode 决定）。
 * 状态由 Home 的 usePwaInstall 单例注入（与 InstallAppDialog 共享同一份 beforeinstallprompt）。
 */
import { X, Download, Smartphone, Bell } from 'lucide-react';
import { t } from '../i18n';
import { useSkin } from './SkinProvider';
import type { PwaInstallMode } from '../hooks/usePwaInstall';

export default function InstallAppBanner({
  mode,
  promptInstall,
  dismiss,
  onOpenProactivePush,
}: {
  mode: PwaInstallMode;
  promptInstall: () => Promise<string>;
  dismiss: () => void;
  onOpenProactivePush?: () => void; // 直达「主动找我」偏好
}) {
  const { skin, setSkin, skins } = useSkin();
  if (!mode) return null;

  const isInstall = mode === 'install';
  const isManual = mode === 'manual';
  const Icon = isInstall ? Download : Smartphone;
  // 换肤图标提示：展示各皮肤 hero 爱心 logo 小样，点一下即可换皮肤
  const previewSkins = skins.filter((s) => s.id !== 'default' && s.hero).slice(0, 6);

  return (
    <div className="pointer-events-none w-full flex justify-center sm:w-auto sm:justify-end">
      {/* 桌面视口（sm 起）收成 22rem 窄卡，由 Home 的浮层容器靠右下角摆放
          通栏的 max-w-md 会直接压在首屏 hero 正文上（2026-09-21 走查 F7，1264×749 实拍）。 */}
      <div className="pointer-events-auto relative max-w-md w-full sm:w-[22rem] card-white-toast rounded-2xl border border-clay-border shadow-lg px-3.5 py-3">
        {/* ✕ 从首行挪到卡片右上角（绝对定位）：首行不再被它和按钮一起挤掉宽度，
            标题/说明才能「横向铺满、再自然换行」，而不是两三个字就折一行（2026-09-27 用户口径）。 */}
        <button
          onClick={dismiss}
          aria-label={t('installSaveDismiss')}
          title={t('installSaveDismiss')}
          className="absolute right-1 top-1 rounded-full p-2 text-ink-soft hover:text-gray-600 hover:bg-black/5 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>

        {/* 第一行：图标 + 文案（pr-6 给右上角 ✕ 留位） */}
        <div className="flex items-start gap-2.5 pr-6">
          <span className="w-9 h-9 rounded-xl overflow-hidden flex items-center justify-center flex-shrink-0 bg-primary-soft text-primary">
            <Icon className="w-5 h-5" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-800 leading-snug">{t('installToastTitle')}</p>
            <p className="text-xs text-ink-soft leading-snug mt-1">
              {isInstall ? t('installSaveSub') : isManual ? t('installManualHint') : t('installIosHint')}
            </p>
          </div>
        </div>

        {/* 第二行：两个动作按钮**并排**（安装按钮不再挂在首行右侧、也不再把正文挤窄）。
            「开『主动找我』」做成描边+铃铛图标的真按钮（原来是一行 11px 小字链接，看不出能点）。
            宽度策略：安装按钮按内容自适应（"安装"/"Install" 长短差很大），剩下的宽度给「主动找我」，
            这样英/中/繁三种语言都不会把按钮文字截断（实测见 temp/verify-install-banner/shots.mjs）。 */}
        {(onOpenProactivePush || isInstall) && (
          <div className="mt-3 flex items-center gap-2">
            {onOpenProactivePush && (
              <button
                onClick={onOpenProactivePush}
                className="flex-1 min-w-0 inline-flex items-center justify-center gap-1.5 rounded-full border border-primary/45 bg-white px-3 py-2 text-xs font-semibold text-primary-text hover:bg-primary-soft hover:border-primary active:scale-[0.98] transition-all"
              >
                <Bell className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="truncate">{t('proactiveOpen')}</span>
              </button>
            )}
            {isInstall && (
              <button
                onClick={() => { void promptInstall(); }}
                className="flex-shrink-0 inline-flex items-center justify-center gap-1.5 rounded-full bg-primary hover:bg-primary-strong px-5 py-2 text-xs font-semibold text-white shadow-sm active:scale-[0.98] transition-all"
              >
                <Download className="w-3.5 h-3.5" />
                {t('installSaveBtn')}
              </button>
            )}
          </div>
        )}
        <div className="mt-2.5 pt-2 border-t border-gray-100 flex items-center gap-2">
          <span className="text-[11px] text-ink-soft flex-1 leading-snug">{t('installSkinHint')}</span>
          <div className="flex items-center gap-1 flex-shrink-0">
            {previewSkins.map((s) => (
              <button
                key={s.id}
                onClick={() => setSkin(s.id)}
                title={s.id}
                aria-label={t('skinSwitchAria', { name: s.id === 'candy' ? t('skinCandy') : s.id === 'healing' ? t('skinHealing') : s.id === 'zen' ? t('skinZen') : s.id === 'star' ? t('skinStar') : t('skinDefault') })}
                className={'w-6 h-6 rounded overflow-hidden ring-1 transition-all ' + (skin === s.id ? 'ring-2 ring-primary' : 'ring-black/10 hover:ring-primary/60')}
              >
                <img src={`/skins/${s.id}/app-icon-48.png?v=2`} alt="" className="w-full h-full object-cover" loading="lazy" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
