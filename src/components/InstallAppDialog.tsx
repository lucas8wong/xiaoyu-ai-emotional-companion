/**
 * 常驻「保存/安装 Xiaoyu」对话框，从 More 菜单（⋯）进入，始终可达。
 * 不依赖底部轻提示（底条可被关闭），也不因「已安装/已关闭一次性提示」而不可见。
 * 状态由 Home 的 usePwaInstall 单例注入。
 * 按状态展示：可安装 → 安装按钮；iOS → 添加到主屏幕指引；已安装 → 已保存；都不支持 → 换浏览器提示。
 */
import { X, Download, Smartphone, CheckCircle2, MonitorSmartphone } from 'lucide-react';
import { useState } from 'react';
import { t } from '../i18n';
import type { PwaInstallMode } from '../hooks/usePwaInstall';
import { useSkin } from './SkinProvider';

export default function InstallAppDialog({
  open,
  onClose,
  installed,
  mode,
  promptInstall,
}: {
  open: boolean;
  onClose: () => void;
  installed: boolean;
  mode: PwaInstallMode;
  promptInstall: () => Promise<string>;
}) {
  const [installMsg, setInstallMsg] = useState<string | null>(null);
  const { skin, setSkin, skins } = useSkin();
  if (!open) return null;

  // 浏览器没弹出安装时给个友好提示（否则点了「安装」无反应会以为卡住）
  const handleInstall = async () => {
    const r = await promptInstall();
    if (r === 'no-prompt' || r === 'error' || r === 'timeout') setInstallMsg(t('installFallbackMsg'));
    else setInstallMsg(null);
  };

  // 「换肤图标也会变」预览：展示各皮肤 hero 正方形的 app-icon 小样，点一下即可换皮肤
  const previewSkins = skins.filter((s) => s.id !== 'default' && s.hero).slice(0, 6);

  const Icon = installed ? CheckCircle2 : mode === 'ios' ? Smartphone : mode === 'install' ? Download : MonitorSmartphone;
  const body = installed
    ? t('installDlgInstalled')
    : mode === 'install'
      ? t('installSaveSub')
      : mode === 'ios'
        ? t('installIosHint')
        : mode === 'manual'
          ? t('installManualHint') // manual（Firefox/QQ/内地不发安装提示等）→ 手动「添加到主屏幕/桌面快捷方式」
          : t('installDlgIncognito'); // null = Chromium（Chrome/Edge）但未触发安装（无痕/隐私）→ 引导用普通窗口

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl border border-clay-border shadow-lift p-5 max-w-sm w-full">
        <div className="flex items-start gap-3">
          <span className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-primary-soft text-primary">
            <Icon className="w-5 h-5" />
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-bold text-gray-800 leading-tight">{t('installToastTitle')}</h3>
            <p className="text-sm text-gray-600 mt-1 leading-relaxed">{body}</p>
          </div>
          <button
            onClick={onClose}
            aria-label={t('installSaveDismiss')}
            title={t('installSaveDismiss')}
            className="flex-shrink-0 text-ink-soft hover:text-gray-600 p-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="mt-3 pt-3 border-t border-gray-100 flex items-center gap-2">
          <span className="text-[11px] text-ink-soft flex-1 leading-snug">{t('installSkinHint')}</span>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {previewSkins.map((s) => (
              <button
                key={s.id}
                onClick={() => setSkin(s.id)}
                title={s.id}
                aria-label={t('skinSwitchAria', { name: s.id === 'candy' ? t('skinCandy') : s.id === 'healing' ? t('skinHealing') : s.id === 'zen' ? t('skinZen') : s.id === 'star' ? t('skinStar') : t('skinDefault') })}
                className={'w-7 h-7 rounded-md overflow-hidden ring-1 transition-all ' + (skin === s.id ? 'ring-2 ring-primary' : 'ring-black/10 hover:ring-primary/60')}
              >
                <img src={`/skins/${s.id}/app-icon-48.png?v=2`} alt="" className="w-full h-full object-cover" loading="lazy" />
              </button>
            ))}
          </div>
        </div>
        {mode === 'install' && (
          <button
            onClick={() => { void handleInstall(); }}
            className="mt-4 w-full text-white bg-primary hover:bg-primary-strong py-2.5 rounded-full text-sm font-semibold transition-all"
          >
            {t('installSaveBtn')}
          </button>
        )}
        {installMsg && (
          <p className="mt-2 text-xs text-amber-600 leading-snug">{installMsg}</p>
        )}
      </div>
    </div>
  );
}
