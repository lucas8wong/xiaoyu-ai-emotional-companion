/**
 * 新用户界面导览（UI Tour）
 * 告诉新用户「这些功能在哪里」：了解小愈 / 我的(会员·邀请) / 心情打卡 / 我的记录 / 个性化偏好 / 界面外观(皮肤) / 反馈
 * 游客首次访问、以及新注册用户各展示一次（localStorage 标记；注册后直接进主页，不再有前置引导）
 */

import { Info, User as UserIcon, CalendarDays, Settings2, MessageSquareHeart, Check, Sparkles, X, History, Palette, ChevronRight, Compass } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { t } from '../i18n';
import Modal from './ui/Modal';

export type UiTourTarget = 'about' | 'profile' | 'mood' | 'records' | 'journey' | 'prefs' | 'skin' | 'feedback';

interface UiTourModalProps {
  open: boolean;
  onClose: () => void;
  /** 点击条目后跳转到对应功能（弹窗/页面）；未传则仅高亮该条目 */
  onNavigate?: (target: UiTourTarget) => void;
}

export function hasSeenUiTour(): boolean {
  try { return localStorage.getItem('cure_ui_tour_seen') === '1'; } catch { return false; }
}
export function markUiTourSeen(): void {
  try { localStorage.setItem('cure_ui_tour_seen', '1'); } catch { /* 忽略 */ }
}

export default function UiTourModal({ open, onClose, onNavigate }: UiTourModalProps) {
  if (!open) return null;
  const items: { icon: LucideIcon; label: string; desc: string; color: string; target: UiTourTarget }[] = [
    { icon: Info, label: t('uiTourAbout'), desc: t('uiTourAboutDesc'), color: 'bg-primary-soft text-primary', target: 'about' },
    { icon: UserIcon, label: t('uiTourProfile'), desc: t('uiTourProfileDesc'), color: 'bg-amber-50 text-amber-600', target: 'profile' },
    { icon: CalendarDays, label: t('uiTourMood'), desc: t('uiTourMoodDesc'), color: 'bg-green-50 text-green-600', target: 'mood' },
    { icon: History, label: t('uiTourRecords'), desc: t('uiTourRecordsDesc'), color: 'bg-sky-50 text-sky-600', target: 'records' },
    { icon: Compass, label: t('uiTourJourney'), desc: t('uiTourJourneyDesc'), color: 'bg-violet-50 text-violet-600', target: 'journey' },
    { icon: Settings2, label: t('uiTourPrefs'), desc: t('uiTourPrefsDesc'), color: 'bg-purple-50 text-purple-600', target: 'prefs' },
    { icon: Palette, label: t('uiTourSkin'), desc: t('uiTourSkinDesc'), color: 'bg-indigo-50 text-indigo-600', target: 'skin' },
    { icon: MessageSquareHeart, label: t('profileFeedback'), desc: t('uiTourFeedbackDesc'), color: 'bg-pink-50 text-pink-600', target: 'feedback' },
  ];
  const close = () => { markUiTourSeen(); onClose(); };
  const handleItem = (target: UiTourTarget) => {
    onNavigate?.(target);
    close();
  };
  return (
    <Modal open={open} onClose={close} overlayClassName="z-[990] bg-black/50 flex items-center justify-center p-4" padding="p-5" radius="rounded-3xl" maxHeight="max-h-[90vh]" overflow="" layout="flex" showClose={false}>
        <h2 className="text-lg font-bold text-gray-800 text-center">{t('uiTourTitle')}</h2>
        <p className="text-xs text-ink-soft text-center mt-1 mb-4">{t('uiTourSub')}</p>
        <div className="flex-1 overflow-y-auto space-y-2.5 pr-0.5">
          {items.map((it, i) => {
            const Icon = it.icon;
            const inner = (
              <>
                <span className={'w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ' + it.color}>
                  <Icon className="w-5 h-5" />
                </span>
                <div className="flex-1 min-w-0 text-left">
                  <p className="text-sm font-semibold text-gray-800 leading-tight">{it.label}</p>
                  <p className="text-[11px] sm:text-xs text-ink-soft leading-snug mt-0.5">{it.desc}</p>
                </div>
                {onNavigate && <ChevronRight className="w-4 h-4 text-ink-soft group-hover:text-primary flex-shrink-0 mt-2.5 transition-colors" />}
              </>
            );
            return (
              <button
                key={i}
                type="button"
                onClick={() => handleItem(it.target)}
                disabled={!onNavigate}
                className="w-full flex items-start gap-3 rounded-xl border border-gray-100 bg-gray-50/60 px-3 py-2.5 text-left transition-colors group hover:bg-primary-lighter hover:border-primary/30 disabled:cursor-default disabled:hover:bg-gray-50/60 disabled:hover:border-gray-100"
              >
                {inner}
              </button>
            );
          })}
        </div>
        <button onClick={close} className="mt-4 w-full bg-primary-strong text-white py-3 rounded-full text-sm font-semibold hover:bg-primary active:scale-[0.98] transition-all">
          <span className="inline-flex items-center gap-1.5"><Check className="w-4 h-4" />{t('uiTourDone')}</span>
        </button>
    </Modal>
  );
}

/**
 * 新用户导览提示条（非阻塞）：替代自动弹出的全屏 UiTourModal，
 * 正文/首屏不被遮挡；点「查看导览」再打开完整弹窗，点 ✕ 直接关闭并记录已看过。
 */
interface UiTourBarProps {
  onDismiss: () => void;
  onView: () => void;
}

export function UiTourBar({ onDismiss, onView }: UiTourBarProps) {
  return (
    <div className="bg-primary-lighter/80 border-b border-primary/20 px-3 sm:px-4 py-2 flex items-center gap-2 sm:gap-3">
      <Sparkles className="w-4 h-4 text-primary flex-shrink-0" />
      <p className="text-xs sm:text-sm text-primary-text flex-1 min-w-0 truncate">{t('uiTourBarText')}</p>
      <button
        onClick={onView}
        className="text-xs sm:text-sm font-semibold text-primary-text underline underline-offset-2 hover:text-primary flex-shrink-0"
      >
        {t('uiTourView')}
      </button>
      <button
        onClick={onDismiss}
        aria-label={t('bannerDismiss')}
        className="w-7 h-7 rounded-full flex items-center justify-center text-ink-soft hover:text-gray-600 hover:bg-white/60 transition-colors flex-shrink-0"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
