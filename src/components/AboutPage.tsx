/**
 * 了解小愈：聚合本 app 的全部介绍内容
 * 品牌 · 功能（聊一聊/理一理/状态自适应陪伴/地区口音）· 角色剧情扮演 · 剧本来源 · 收费模式 · 额度会员 · 温馨提示 · 隐私条款
 * 移动端优先
 */

import { useState } from 'react';
import { ArrowLeft, BookOpen, Coins, AlertTriangle, ShieldCheck, Info, Crown, Umbrella, PartyPopper, HeartHandshake, Lock, Fingerprint, Copy, Check, UserPlus } from 'lucide-react';
import { t } from '../i18n';
import { getInviteLink, isLoggedIn } from '../services/api';
import FeedbackButton from './FeedbackButton';
import SocialFollow from './SocialFollow';
import BrandHeart from './BrandHeart';
import { useSkin } from './SkinProvider';

interface AboutPageProps {
  onBack: () => void;
  onOpenPrivacy: () => void;
  onOpenMembership: () => void;
  /** 游客一键直达注册（注册获得额度） */
  onNeedLogin?: () => void;
  /** 新人 Pro 限时活动：注册即送 Pro 无限使用（true 时额度区文案优先展示 Pro） */
  registerProPromoActive?: boolean;
  registerProDays?: number;
  /**
   * 注册可得的对话额度（限时活动；0 = 活动期外）。
   * ⚠️ 必须由后端实时值传入：文案里原来写死「注册立得 20 条」，
   * 活动一结束（registerChatBonus=0）就会与 guest 额度条自相矛盾。
   */
  registerChatBonus?: number;
  /**
   * 分档日额度（条，2026-09-27）：游客 `g` 条/天、注册账号 `d` 条/天。
   * 由调用方（Home）用 `quotaTierTiao(quota, payCfg)` 从后端数字算好传入；
   * 拿不到（undefined）时退回旧文案，绝不渲染出 `undefined 条`。
   */
  guestDailyTiao?: number;
  registeredDailyTiao?: number;
}

export default function AboutPage({ onBack, onOpenPrivacy, onOpenMembership, onNeedLogin, registerProPromoActive = false, registerProDays = 0, registerChatBonus = 0, guestDailyTiao, registeredDailyTiao }: AboutPageProps) {
  const { meta, skin } = useSkin(); // 当前皮肤：字标/心形/三功能插图随皮肤切换
  const [inviteCopied, setInviteCopied] = useState(false);
  const loggedIn = isLoggedIn();
  const copyInvite = () => {
    try { navigator.clipboard.writeText(getInviteLink()); setInviteCopied(true); setTimeout(() => setInviteCopied(false), 1600); } catch { setInviteCopied(false); }
  };
  // 三功能插图：治愈主题统一「方块内圆形裁剪」，chat 与 structure / story 保持一致；经典/禅意仍用圆角方块兜底。
  const aboutImgShape = skin === 'healing' ? 'rounded-full' : 'rounded-xl';
  return (
    <div className="min-h-[100dvh] bg-brand">
      <div className="sticky top-0 z-10 bg-white/85 backdrop-blur border-b border-gray-100">
        <div className="max-w-2xl mx-auto px-3 py-2 flex items-center justify-between">
          <button onClick={onBack} aria-label={t('backHome')} title={t('backHome')} className="flex items-center text-sm text-ink-soft hover:text-gray-700 p-2 -ml-2 min-h-[44px] min-w-[44px]">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <p className="font-semibold text-gray-800">{t('aboutTitle')}</p>
          <FeedbackButton />
        </div>
      </div>
      <div className="max-w-2xl mx-auto px-4 py-5 space-y-4">
        {/* 品牌 */}
        <div className="text-center pt-2">
          <img src={meta.wordmark || '/skins/healing/wordmark.webp?v=4'} alt={t('appName')} className={`mx-auto mb-3 h-20 sm:h-24 w-auto object-contain drop-shadow-sm${skin === 'star' || skin === 'candy' ? '' : ' mix-blend-multiply'}`} loading="lazy" />
          <h1 className="text-xl font-bold text-gray-800">{t('aboutBrandTitle')}</h1>
          <p className="text-sm text-ink-soft mt-1 leading-relaxed px-2">{t('aboutBrandBody')}</p>
          <div className="mt-3 pt-3 border-t border-primary/10">
            <SocialFollow />
          </div>
        </div>

        {/* 品牌故事：她的故事（小芽精灵完整版） */}
        <div className="bg-gradient-to-br from-primary-soft to-accent-soft rounded-2xl border border-primary/15 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-2">
            <BrandHeart boxClass="w-8 h-8 flex-shrink-0" iconClass="w-4 h-4 text-white" />
            <h2 className="text-base font-bold text-gray-800">{t('aboutStoryTitle')}</h2>
          </div>
          <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{t('aboutStoryBody')}</p>
          <p className="text-[12px] text-primary-text/80 leading-relaxed mt-2 pt-2 border-t border-primary/10">{t('aboutStoryNickname')}</p>
        </div>

        {/* 品牌价值：低落被接住 / 快乐被见证 / 不是重新开始（移动端 3 列并排，仅图标+标题） */}
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-white rounded-lg border border-gray-100 p-2.5 text-center">
            <Umbrella className="w-6 h-6 text-primary mx-auto mb-1.5" />
            <p className="text-xs font-semibold text-gray-800 leading-tight">{t('feature1Title')}</p>
            <p className="hidden sm:block text-[11px] text-ink-soft leading-snug mt-1">{t('feature1Desc')}</p>
          </div>
          <div className="bg-white rounded-lg border border-gray-100 p-2.5 text-center">
            <PartyPopper className="w-6 h-6 text-primary mx-auto mb-1.5" />
            <p className="text-xs font-semibold text-gray-800 leading-tight">{t('feature2Title')}</p>
            <p className="hidden sm:block text-[11px] text-ink-soft leading-snug mt-1">{t('feature2Desc')}</p>
          </div>
          <div className="bg-white rounded-lg border border-orange-100 p-2.5 text-center">
            <HeartHandshake className="w-6 h-6 text-orange-500 mx-auto mb-1.5" />
            <p className="text-xs font-semibold text-gray-800 leading-tight">{t('feature3Title')}</p>
            <p className="hidden sm:block text-[11px] text-ink-soft leading-snug mt-1">{t('feature3Desc')}</p>
          </div>
        </div>

        {/* 功能：聊一聊 / 理一理 / 角色扮演 */}
        <div>
          <p className="text-xs font-bold text-ink-soft mb-2 px-1">{t('aboutFeatureTitle')}</p>
          <div className="space-y-2.5">
            <div className="flex items-start gap-3 rounded-xl border-2 border-primary/25 bg-primary-lighter px-3.5 py-2.5">
              <span className={`w-10 h-10 sm:w-11 sm:h-11 ${aboutImgShape} overflow-hidden flex-shrink-0 border border-primary/20 bg-white shadow-sm`}>
                <img src={meta.chatSm || meta.chat || '/skins/healing/chat.webp?v=4'} alt="" className="w-full h-full object-cover" loading="lazy" />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-800 leading-tight">{t('entryChatTitle')}</p>
                <p className="text-[11px] sm:text-xs text-ink-soft leading-snug mt-0.5">{t('obOverviewChatDesc')}</p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-xl border-2 border-primary/25 bg-primary-lighter px-3.5 py-2.5">
              <span className={`w-10 h-10 sm:w-11 sm:h-11 ${aboutImgShape} overflow-hidden flex-shrink-0 border border-primary/20 bg-white shadow-sm`}>
                <img src={meta.structureSm || meta.structure || '/skins/healing/structure.webp?v=3'} alt="" className="w-full h-full object-cover" loading="lazy" />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-800 leading-tight">{t('entryStructureTitle')}</p>
                <p className="text-[11px] sm:text-xs text-ink-soft leading-snug mt-0.5">{t('obOverviewStructureDesc')}</p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-xl border-2 border-primary/25 bg-gradient-to-r from-primary-lighter to-accent-soft px-3.5 py-2.5">
              <span className={`w-10 h-10 sm:w-11 sm:h-11 ${aboutImgShape} overflow-hidden flex-shrink-0 border border-primary/20 bg-white shadow-sm`}>
                <img src={meta.storySm || meta.story || '/skins/healing/story.webp?v=3'} alt="" className="w-full h-full object-cover" loading="lazy" />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-800 leading-tight">{t('roleplayTitle')}</p>
                <p className="text-[11px] sm:text-xs text-ink-soft leading-snug mt-0.5">{t('aboutRoleplayDesc')}</p>
                <p className="text-[11px] text-ink-soft leading-snug mt-1 flex items-start gap-1">
                  <BookOpen className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <span>{t('aboutSourceBody')}</span>
                </p>
              </div>
            </div>
            <div className="rounded-xl bg-gray-50 border border-gray-100 px-3.5 py-2.5">
              <p className="text-[11px] text-ink-soft leading-relaxed text-center">{t('obOverviewDimNote')}</p>
            </div>
          </div>
        </div>

        {/* 信任：消除顾虑（隐私 / 数据 / 不评判），放在收费之前 */}
        <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-100">
          <p className="text-xs font-bold text-ink-soft px-4 pt-3 pb-1">{t('trustTitle')}</p>
          {[
            { icon: ShieldCheck, bg: 'bg-primary-soft', fg: 'text-primary', t1: t('trust1'), d: t('trust1Desc') },
            { icon: Lock, bg: 'bg-primary-soft', fg: 'text-primary', t1: t('trust2'), d: t('trust2Desc') },
            { icon: Fingerprint, bg: 'bg-orange-100', fg: 'text-orange-600', t1: t('trust3'), d: t('trust3Desc') },
          ].map((it, i) => {
            const It = it.icon;
            return (
              <div key={i} className="flex items-start gap-3 px-4 py-3">
                <div className={`w-9 h-9 rounded-full ${it.bg} flex items-center justify-center flex-shrink-0`}>
                  <It className={`w-4 h-4 ${it.fg}`} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-800">{it.t1}</p>
                  <p className="text-[12px] text-ink-soft leading-snug mt-0.5">{it.d}</p>
                </div>
              </div>
            );
          })}
        </div>

        {/* 收费 · 额度说明（信任之后给价格，价格透明） */}
        <div className="space-y-2">
          <div className="flex items-start gap-2 px-1">
            <Coins className="w-4 h-4 text-amber-700 flex-shrink-0 mt-0.5" />
            <p className="text-[12px] text-ink-soft leading-relaxed"><b className="text-gray-700">{t('aboutPriceTitle')}：</b>{t('aboutPriceBody')}</p>
          </div>
          <div className="flex items-start gap-2 px-1">
            <ShieldCheck className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
            <p className="text-[12px] text-ink-soft leading-relaxed"><b className="text-gray-700">{t('aboutQuotaTitle')}：</b>{registerProPromoActive && registerProDays > 0
              ? t('aboutQuotaBodyPro', { days: registerProDays })
              : (guestDailyTiao != null && registeredDailyTiao != null
                ? (registerChatBonus > 0
                  ? t('aboutQuotaBodyTiers', { g: guestDailyTiao, d: registeredDailyTiao, b: registerChatBonus })
                  : t('aboutQuotaBodyTiersNoBonus', { g: guestDailyTiao, d: registeredDailyTiao }))
                : registerChatBonus > 0
                  ? t('aboutQuotaBodyBonus', { b: registerChatBonus })
                  : t('aboutQuotaBody'))}</p>
          </div>
          {/* 一键直达：注册获得额度（游客） / 复制邀请链接获得额度（已登录） */}
          {(!loggedIn && onNeedLogin) ? (
            <button
              onClick={onNeedLogin}
              className="w-full flex items-center justify-center gap-2 rounded-xl border-2 border-primary/25 bg-primary-lighter px-3.5 py-2.5 text-sm font-semibold text-primary-text hover:bg-primary/10 active:scale-[0.99] transition-all"
            >
              <UserPlus className="w-4 h-4" />
              {t('memRegBtn')}
              <span className="text-primary-text/60">→</span>
            </button>
          ) : loggedIn ? (
            <button
              onClick={copyInvite}
              className="w-full flex items-center justify-center gap-2 rounded-xl border-2 border-clay-border bg-white px-3.5 py-2.5 text-sm font-medium text-ink hover:border-primary hover:text-primary-text active:scale-[0.99] transition-all"
            >
              {inviteCopied ? <Check className="w-4 h-4 text-primary" /> : <Copy className="w-4 h-4" />}
              {inviteCopied ? t('profileCopied') : t('quotaShareBtn')}
            </button>
          ) : null}
        </div>

        {/* 会员入口：价格说明后立即给 CTA（兴趣峰值转化） */}
        <button
          onClick={onOpenMembership}
          className="w-full flex items-center justify-center gap-2 rounded-xl border-2 border-primary/25 bg-primary-lighter px-3.5 py-3 text-sm font-semibold text-primary-text hover:bg-primary/10 active:scale-[0.99] transition-all"
        >
          <Crown className="w-4 h-4" />
          {t('aboutSeeMembership')}
          <span className="text-primary-text/60">→</span>
        </button>

        {/* 使用说明：决定要用了才需要知道"怎么用" */}
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <p className="text-xs font-bold text-ink-soft mb-3">{t('howTitle')}</p>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="w-9 h-9 bg-primary-soft rounded-full flex items-center justify-center mx-auto mb-2"><span className="text-primary font-bold text-sm">1</span></div>
              <p className="text-[13px] font-semibold text-gray-800">{t('how1')}</p>
              <p className="text-[11px] text-ink-soft leading-snug mt-0.5">{t('how1Desc')}</p>
            </div>
            <div>
              <div className="w-9 h-9 bg-primary-soft rounded-full flex items-center justify-center mx-auto mb-2"><span className="text-primary font-bold text-sm">2</span></div>
              <p className="text-[13px] font-semibold text-gray-800">{t('how2')}</p>
              <p className="text-[11px] text-ink-soft leading-snug mt-0.5">{t('how2Desc')}</p>
            </div>
            <div>
              <div className="w-9 h-9 bg-orange-100 rounded-full flex items-center justify-center mx-auto mb-2"><span className="text-orange-600 font-bold text-sm">3</span></div>
              <p className="text-[13px] font-semibold text-gray-800">{t('how3')}</p>
              <p className="text-[11px] text-ink-soft leading-snug mt-0.5">{t('how3Desc')}</p>
            </div>
          </div>
        </div>

        {/* 温馨提示（轻量警示条） */}
        <div className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2.5">
          <p className="text-[12px] text-amber-900/80 leading-relaxed flex items-start gap-1.5">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span><b>{t('aboutRiskTitle')}：</b>{t('aboutRiskBody')}</span>
          </p>
        </div>

        {/* 隐私条款 */}
        <button
          onClick={onOpenPrivacy}
          className="w-full flex items-center justify-center gap-1.5 text-sm text-primary hover:text-primary-text underline underline-offset-4 py-2"
        >
          <Info className="w-4 h-4" />
          {t('privacy')}
        </button>
        <p className="text-center text-[11px] text-ink-soft pb-4">{t('poweredBy')}</p>
      </div>
    </div>
  );
}
