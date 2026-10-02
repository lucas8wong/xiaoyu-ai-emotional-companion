/**
 * 移动端顶部「更多」菜单
 * 手机上把 心情打卡 / 个性化偏好 / 界面外观 / 我的 / 退出 收进一个 ⋯ 下拉菜单，
 * 避免顶部 icon 密集、登出按钮溢出界面；桌面（sm+）不渲染，顶部照常显示 icon 行
 */
import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, CalendarDays, Settings2, User as UserIcon, LogOut, X, Crown, Palette, HelpCircle, History, Download, Compass } from 'lucide-react';
import { SkinFeedbackIcon } from './SkinIcon';
import { t } from '../i18n';

interface MoreMenuProps {
  authUser: boolean;
  displayName: string;
  plan?: 'free' | 'plus' | 'pro'; // 当前会员等级（头部徽章显示）
  onMood: () => void;
  onPrefs: () => void;
  onSkin: () => void;
  onProfile: () => void;
  onJourney: () => void;
  /** 「我的记录」（我的陪伴记录），理一理的记录：**不传即不渲染该项**（主页不传 → 主页 ⋯ 里没有它） */
  onHistory?: () => void;
  onFeedback: () => void;
  onFaq: () => void;
  onInstall: () => void;
  onLogout: () => void;
  onLogin: () => void;
  /** true 时不受默认 sm:hidden 限制（桌面溢出时也能显示「…」） */
  show?: boolean;
  /** true 时隐藏已「常驻主页置顶栏」的 我的/个性化偏好/界面外观（避免「…」里重复） */
  minimal?: boolean;
  /** 供上层功能引导气泡（coach-mark）定位到「…」触发按钮 */
  menuBtnRef?: React.Ref<HTMLButtonElement>;
}

interface Item {
  key: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  primary?: boolean;
}

export default function MoreMenu({ authUser, displayName, plan = 'free', onMood, onPrefs, onSkin, onProfile, onJourney, onHistory, onFeedback, onFaq, onInstall, onLogout, onLogin, show = false, minimal = false, menuBtnRef }: MoreMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 点击菜单外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const close = (fn: () => void) => () => { setOpen(false); fn(); };

  // 顺序按商业转化优先：我的（会员/邀请）→ 打卡（活跃度）→ 记录（资产感，仅理一理传 onHistory 时）→ 偏好（个性化）→ 反馈（发声）
  const items: Item[] = [
    { key: 'profile', icon: <UserIcon className="w-4 h-4 text-primary" />, label: t('myProfile'), onClick: close(onProfile), primary: true },
    { key: 'journey', icon: <Compass className="w-4 h-4 text-primary" />, label: t('journeyMenu'), onClick: close(onJourney), primary: true },
    { key: 'mood', icon: <CalendarDays className="w-4 h-4 text-primary" />, label: t('profileMoodModule'), onClick: close(onMood), primary: true },
    // 「我的记录」只在传了 onHistory 时出现（理一理顶栏/⋯ 才传；主页不传 → 主页 ⋯ 里不再有「我的记录」）
    ...(onHistory ? [{ key: 'history', icon: <History className="w-4 h-4 text-primary" />, label: t('myRecords'), onClick: close(onHistory), primary: true }] : []),
    { key: 'install', icon: <Download className="w-4 h-4 text-primary" />, label: t('installMenuLabel'), onClick: close(onInstall), primary: true },
    { key: 'prefs', icon: <Settings2 className="w-4 h-4 text-primary" />, label: t('profilePrefs'), onClick: close(onPrefs), primary: true },
    { key: 'skin', icon: <Palette className="w-4 h-4 text-primary" />, label: t('skinAppearance'), onClick: close(onSkin), primary: true },
    { key: 'feedback', icon: <SkinFeedbackIcon className="w-5 h-5 text-primary" />, label: t('profileFeedback'), onClick: close(onFeedback), primary: true },
    { key: 'faq', icon: <HelpCircle className="w-4 h-4 text-primary" />, label: t('faq'), onClick: close(onFaq), primary: true },
];
if (authUser) {
  items.push({ key: 'logout', icon: <LogOut className="w-4 h-4 text-red-500" />, label: t('profileLogout'), onClick: close(onLogout), danger: true });
} else {
  items.push({ key: 'login', icon: <UserIcon className="w-4 h-4 text-primary" />, label: t('login'), onClick: close(onLogin), primary: true });
}
  if (minimal) {
    // 主页置顶栏：隐藏已「常驻」的 我的 / 心情打卡 / 登录注册 / 个性化偏好 / 界面外观（避免「…」里重复）；
    // 「…」里收纳真正低频项：与你的旅程 / 安装 / 意见反馈 / FAQ / 退出
    // ⚠️「我的记录」（我的陪伴记录）不属于主页，已移到理一理里面（2026-09-16）：
    //   它展开的是理一理会话（情绪/强度/分析/深入/疗愈故事），归理一理；
    //   主页 ⋯ 不再提供该入口 → 只在「理一理」顶栏 🕘 我的记录 / 理一理 ⋯ 全量菜单（非 minimal）里出现。
    const keep = new Set(['journey', 'install', 'feedback', 'faq', 'logout']);
    for (let i = items.length - 1; i >= 0; i--) { if (!keep.has(items[i].key)) items.splice(i, 1); }
  }


  return (
    <div className={"relative flex-shrink-0 " + (show ? '' : 'sm:hidden')} ref={ref}>
      <button
        ref={menuBtnRef}
        onClick={() => setOpen(o => !o)}
        aria-label={open ? 'close menu' : 'more menu'}
        className="flex items-center justify-center w-9 h-9 rounded-full text-gray-600 hover:bg-gray-100 hover:text-gray-800 transition-colors"
      >
        {open ? <X className="w-5 h-5" /> : <MoreHorizontal className="w-5 h-5" />}
      </button>

      {open && (
        <>
          {/* 点击遮罩关闭 */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-11 z-50 w-48 bg-white rounded-2xl shadow-lift border border-clay-border py-1.5 overflow-hidden">
            {authUser && (
              <div className="px-4 py-2 border-b border-gray-100 mb-1">
                <p className="text-sm font-semibold text-gray-800 truncate flex items-center gap-1.5">
                  {displayName}
                  {plan !== 'free' && (
                    <span className={"inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full " + (plan === 'pro' ? 'bg-gradient-to-r from-amber-400 to-orange-500 text-white' : 'bg-primary-lighter text-primary-text')}>
                      <Crown className="w-2.5 h-2.5" />{plan === 'pro' ? 'Pro' : 'Plus'}
                    </span>
                  )}
                </p>
                <p className="text-[11px] text-ink-soft">{t('menuLoggedIn')}</p>
              </div>
            )}
            {items.map(it => (
              <button
                key={it.key}
                onClick={it.onClick}
                className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-left transition-colors ${
                  it.danger ? 'text-red-500 hover:bg-red-50' : it.primary ? 'text-primary-text hover:bg-primary-lighter' : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                {it.icon}
                <span className="flex-1">{it.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
