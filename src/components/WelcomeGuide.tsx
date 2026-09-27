/**
 * 首屏欢迎引导（Onboarding）
 * 1 品牌开场 → 2 功能概览(聊一聊/理一理 · 角色剧情 · 地区语气) → 3 开始（选聊一聊/理一理）
 * 地区语气 / 语气程度改到「进聊一聊 / 进理一理」时再设置，不在此处收集。
 * 陪伴方式不在引导页选择（2026-09-23 起用户侧档位整体退场：由小愈按你的状态自己判断）
 * 可跳过；完成后保存语言偏好
 * 移动端优先：图标/字号/间距按手机尺寸设计，桌面（sm+）适度放大
 */

import { useState } from 'react';
import { Sparkles, ChevronRight, ArrowLeft, SkipForward, Languages, MessageCircle, Compass, type LucideIcon } from 'lucide-react';
import { savePreferences } from '../services/api';
import BrandHeart from './BrandHeart';
import { t, setLang, getLang, type Lang } from '../i18n';
import Modal from './ui/Modal';

interface WelcomeGuideProps {
  onClose: (entry?: string) => void;
  onFeedback?: () => void;
}

export function hasSeenGuide(): boolean {
  try { return localStorage.getItem('cure_guide_seen') === '1'; } catch { return false; }
}
export function markGuideSeen(): void {
  try { localStorage.setItem('cure_guide_seen', '1'); } catch { /* 忽略 */ }
}

const TOTAL_PAGES = 3;

export default function WelcomeGuide({ onClose }: WelcomeGuideProps) {
  const [page, setPage] = useState(1);
  const [lang, setLangState] = useState<Lang>(getLang());
  const [busy, setBusy] = useState(false);

  const finish = (entry?: string) => {
    if (busy) return;
    setBusy(true);
    // 后台保存语言偏好，不阻塞进入主页面（点跳过/开始应立即响应）；地区/程度由「进聊一聊/理一理」时设置
    savePreferences({ language: lang }).catch(() => {});
    if (lang !== getLang()) setLang(lang);
    markGuideSeen();
    onClose(entry);
  };

  const goNext = () => {
    if (page < TOTAL_PAGES) setPage(page + 1);
  };
  const goPrev = () => {
    if (page > 1) setPage(page - 1);
  };

  // 末页入口：聊一聊 / 理一理 / 角色剧情扮演（各配小字解释）
  const entries: { key: string; label: string; desc: string; icon: LucideIcon }[] = [
    { key: 'chat', label: t('entryChatTitle'), desc: t('entryChatDesc'), icon: MessageCircle },
    { key: 'structure', label: t('entryStructureTitle'), desc: t('entryStructureDesc'), icon: Compass },
    { key: 'roleplay', label: t('roleplayTitle'), desc: t('roleplayEntryDesc'), icon: Sparkles },
  ];

  const body = (pageText: string) => (
    <p className="text-[13px] sm:text-[15px] text-gray-600 leading-relaxed whitespace-pre-line text-center">
      {pageText}
    </p>
  );

  // 这个组件由父层决定挂不挂载（原来就是无条件渲染整屏引导），所以 Modal 的 open 恒为 true。
  return (
    <Modal open onClose={onClose} closeOnOverlayClick={false} overlayClassName="z-[998] bg-gradient-to-br from-primary to-primary-strong flex items-center justify-center p-3 sm:p-4" padding="p-5 sm:p-6" radius="rounded-3xl" shadow="shadow-lift" showClose={false}>
        {/* 右上角语言切换 */}
        <div className="absolute top-3 right-3 flex items-center gap-1 bg-white/70 rounded-full px-2 py-1 shadow-sm">
          <Languages className="w-3.5 h-3.5 text-ink-soft" />
          {((lang === 'en' ? [['zh-CN', 'SC'], ['zh-TW', 'TC'], ['en', 'EN']] : [['zh-CN', '简'], ['zh-TW', '繁'], ['en', 'EN']]) as [Lang, string][]).map(([v, label]) => (
            <button
              key={v}
              onClick={() => { setLang(v); setLangState(v); }}
              className={`text-[11px] px-1.5 py-0.5 rounded-full ${lang === v ? 'bg-primary-strong text-white font-medium' : 'text-ink-soft hover:bg-primary-lighter'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ===== 第 1 页：品牌开场 ===== */}
        {page === 1 && (
          <div className="text-center pt-8 sm:pt-10">
            <BrandHeart boxClass="w-14 h-14 sm:w-16 sm:h-16 mx-auto mb-4" iconClass="w-9 h-9 sm:w-10 sm:h-10 text-white" />
            <h1 className="text-xl sm:text-[26px] font-bold text-gray-800 leading-snug mb-3">
              {t('ob1Title')}
            </h1>
            {body(t('ob1Body'))}
            <p className="text-xs text-ink-soft mt-5 italic">{t('brandFootEn')}</p>
            <p className="text-[11px] text-ink-soft mt-3">{t('obNicknameHint')}</p>
          </div>
        )}

        {/* ===== 第 2 页：功能概览（聊一聊 / 理一理 · 陪伴方式 · 地区口音） ===== */}
        {page === 2 && (
          <div className="pt-8 sm:pt-10">
            <h1 className="text-lg sm:text-2xl font-bold text-gray-800 leading-snug mb-1 text-center">
              {t('obOverviewTitle')}
            </h1>
            {body(t('obOverviewSub'))}
            <div className="mt-4 space-y-2.5">
              <div className="flex items-start gap-3 rounded-xl border-2 border-primary/25 bg-primary-lighter px-3.5 py-2.5">
                <span className="w-9 h-9 rounded-full bg-primary-strong text-white flex items-center justify-center flex-shrink-0">
                  <MessageCircle className="w-5 h-5" />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-800 leading-tight">{t('entryChatTitle')}</p>
                  <p className="text-[11px] sm:text-xs text-ink-soft leading-snug mt-0.5">{t('obOverviewChatDesc')}</p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-xl border-2 border-accent/25 bg-accent-soft px-3.5 py-2.5">
                <span className="w-9 h-9 rounded-full bg-accent text-white flex items-center justify-center flex-shrink-0">
                  <Compass className="w-5 h-5" />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-800 leading-tight">{t('entryStructureTitle')}</p>
                  <p className="text-[11px] sm:text-xs text-ink-soft leading-snug mt-0.5">{t('obOverviewStructureDesc')}</p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-xl border-2 border-primary/25 bg-gradient-to-r from-primary-lighter to-accent-soft px-3.5 py-2.5">
                <span className="w-9 h-9 rounded-full bg-primary-strong text-white flex items-center justify-center flex-shrink-0">
                  <Sparkles className="w-5 h-5" />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-800 leading-tight">{t('roleplayTitle')}</p>
                  <p className="text-[11px] sm:text-xs text-ink-soft leading-snug mt-0.5">{t('aboutRoleplayDesc')}</p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-xl border-2 border-clay-border bg-white px-3.5 py-2.5">
                <span className="w-9 h-9 rounded-full bg-primary-soft text-primary flex items-center justify-center flex-shrink-0">
                  <Languages className="w-5 h-5" />
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-800 leading-tight">{t('obOverviewRegionTitle')}</p>
                  <p className="text-[11px] sm:text-xs text-ink-soft leading-snug mt-0.5">{t('obOverviewRegionDesc')}</p>
                </div>
              </div>
              <div className="rounded-xl bg-gray-50 border border-gray-100 px-3.5 py-2.5">
                <p className="text-[11px] text-ink-soft leading-relaxed text-center">{t('obOverviewDimNote')}</p>
              </div>
            </div>
          </div>
        )}

        {/* ===== 第 3 页：开始（选聊一聊 / 理一理） ===== */}
        {page === 3 && (
          <div className="pt-8 sm:pt-10">
            <h1 className="text-lg sm:text-2xl font-bold text-gray-800 leading-snug mb-5 text-center">
              {t('ob6Title')}
            </h1>
            <div className="space-y-3">
              {entries.map(e => {
                const EntryIcon = e.icon;
                return (
                <button
                  key={e.key}
                  onClick={() => finish(e.key)}
                  disabled={busy}
                  className="w-full flex items-center gap-3 rounded-xl border-2 border-gray-200 bg-white px-4 py-3 text-left hover:border-primary hover:bg-primary-lighter transition-all"
                >
                  <span className="w-9 h-9 rounded-full bg-primary-lighter text-primary flex items-center justify-center flex-shrink-0">
                    <EntryIcon className="w-5 h-5" />
                  </span>
                  <span className="flex-1">
                    <span className="block text-[15px] font-semibold text-gray-800">{e.label}</span>
                    <span className="block text-[11px] sm:text-xs text-ink-soft mt-0.5 leading-snug">{e.desc}</span>
                  </span>
                  <ChevronRight className="w-4 h-4 text-ink-soft flex-shrink-0" />
                </button>
                );
              })}
            </div>
            <button
              onClick={() => finish()}
              disabled={busy}
              className="w-full mt-3 py-2.5 rounded-full border-2 border-clay-border bg-white text-ink-soft text-sm hover:border-primary hover:text-primary-text transition-all"
            >
              {t('ob6Home')}
            </button>
            <p className="text-xs text-ink-soft mt-3 text-center">{t('ob6Hint')}</p>
          </div>
        )}

        {/* ===== 底部导航 ===== */}
        {page < TOTAL_PAGES ? (
          <div className="mt-5 flex items-center justify-between">
            <button
              onClick={() => finish()}
              disabled={busy}
              className="flex items-center gap-1.5 py-2 px-2.5 text-[13px] sm:text-sm text-ink-soft hover:text-gray-600"
            >
              <SkipForward className="w-4 h-4" />
              {t('obSkip')}
            </button>
            <div className="flex items-center gap-1.5">
              {page > 1 && (
                <button onClick={goPrev} aria-label={t('prevStep')} className="p-2 -m-2 rounded-full flex items-center justify-center text-ink-soft hover:text-gray-600">
                  <ArrowLeft className="w-4 h-4" />
                </button>
              )}
              {Array.from({ length: TOTAL_PAGES }, (_, i) => i + 1)
                .map(n => (
                <button
                  key={n}
                  onClick={() => setPage(n)}
                  className={`p-2 -m-2 rounded-full flex items-center justify-center`}
                  aria-label={`page ${n}`}
                >
                  <span className={`block rounded-full transition-all ${n === page ? 'bg-primary w-5 h-2.5' : 'bg-gray-300 w-2 h-2'}`} />
                </button>
              ))}
            </div>
            <button
              onClick={goNext}
              className="flex items-center gap-1 bg-primary-strong text-white py-1.5 px-3 rounded-full text-xs sm:text-sm font-semibold hover:bg-primary transition-all"
            >
              {t('obNext')}
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        ) : null}
    </Modal>
  );
}
