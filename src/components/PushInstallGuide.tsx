/**
 * 「AI 主动找我」区块里的「装到桌面／主屏」引导（2026-10-02 立）。
 *
 * 为什么需要它（用户真机反馈原话）：
 *   「这里加主动找我也要有安装到手机桌面的部件，不然根本不通，开了是不是也没用」
 *   病根是 iOS 的系统限制：Safari **标签页**里的网页收不到 Web Push
 *   （`PushManager` 在 iOS Safari 里根本不存在，只有「加到主畫面」后的独立窗口才有）。
 *   于是开关打得开、也显示「已开启」，但推送永远不会来；
 *   而这一块原来只有一行 10px 的琥珀小字（profileProactivePushHint），
 *   用户不会因为一行小字就去装 App —— 这就是「开了也没用」的由来。
 *
 * 本组件把「先装到桌面／主屏」做成这个区块里看得见的东西：
 *   · 当前环境收不到推送（`!pushUsable`）→ 明确的「先装」卡片 + iOS 三步引导；
 *   · 能收推送但还没装（`mode === 'install'`，如安卓／桌面 Chrome）→ 一行轻提示 + 真安装按钮；
 *   · 已装、或既没有安装路径又能正常推送（如桌面 Chrome 在等 beforeinstallprompt）→ 不渲染，不打扰。
 *
 * 状态与「安装」动作都由 Home 的 `usePwaInstall` 单例注入，与底部轻提示、⋯ 里的
 * 「保存 Xiaoyu」共用同一份 `beforeinstallprompt`（这里绝不另起一份监听）。
 */
import { BellOff, Smartphone, Download } from 'lucide-react';
import { t } from '../i18n';
import { BTN } from './ui/controls';
import type { PwaInstallMode } from '../hooks/usePwaInstall';

export default function PushInstallGuide({
  installed,
  mode,
  pushUsable,
  promptInstall,
}: {
  /** 已经在桌面／主屏（standalone，或本地记住装过） */
  installed: boolean;
  /** 当前浏览器的安装能力：install=能真装 / ios=只能手动加主屏 / manual=手动快捷方式 / null=未知 */
  mode: PwaInstallMode;
  /** 当前环境能否真的收到 Web Push（iOS Safari 标签页 = false） */
  pushUsable: boolean;
  /** 真正触发安装（仅 mode==='install' 时可用；iOS 没有可编程安装入口） */
  promptInstall?: () => Promise<string>;
}) {
  if (installed) return null;

  const needsInstall = !pushUsable; // 不装就收不到推送 → 必须把「装」这件事说清楚
  const canInstallNow = !!promptInstall && mode === 'install'; // 能一键装（Chromium/安卓）
  // 既不需要装、又不能一键装、也没有手动路径 → 不打扰（如桌面 Chrome 未弹安装提示）
  if (!needsInstall && !canInstallNow && mode !== 'ios' && mode !== 'manual') return null;

  const Icon = needsInstall ? BellOff : Download;
  const title = needsInstall ? t('pushInstallTitleNeeded') : t('pushInstallTitleSoft');
  const body = mode === 'ios' ? t('pushInstallIosSteps') : mode === 'manual' ? t('installManualHint') : t('installSaveSub');

  return (
    <div className={'mt-2 rounded-xl border px-3 py-2.5 ' + (needsInstall ? 'border-amber-200/70 bg-accent-soft/50' : 'border-clay-border bg-clay-muted/40')}>
      <div className="flex items-start gap-2.5">
        <span className={'mt-0.5 w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ' + (needsInstall ? 'bg-amber-100 text-amber-700' : 'bg-primary-soft text-primary')}>
          <Icon className="w-4 h-4" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold text-ink leading-snug">{title}</p>
          <p className="text-[11px] text-ink-soft leading-snug mt-1">{body}</p>
          {needsInstall && mode === 'ios' && (
            <p className="text-[11px] text-ink-soft leading-snug mt-1">{t('pushInstallIosSystemNote')}</p>
          )}
        </div>
      </div>
      {canInstallNow && (
        <button
          type="button"
          onClick={() => { void promptInstall?.(); }}
          className={'mt-2.5 ' + BTN.primary + ' ' + BTN.sizeSm + ' inline-flex items-center justify-center gap-1.5'}
        >
          <Smartphone className="w-3.5 h-3.5" />
          {t('installSaveBtn')}
        </button>
      )}
    </div>
  );
}
