import { useEffect, useRef, useState, useMemo, useCallback, lazy, Suspense } from 'react';
import { Heart, History, ArrowLeft, User as UserIcon, AlertCircle, LogOut, MessageSquareHeart, MessageCircleHeart, Compass, Crown, CalendarDays, Settings2, Drama, Info, SlidersHorizontal, Megaphone, ChevronDown, ChevronUp, X, Palette, Gift, Mail } from 'lucide-react';
import { SkinModeIcon, SkinPlanIcon, SkinFeedbackIcon } from '../components/SkinIcon';
import { useAppStore } from '../store/useAppStore';
import { useLocation, useNavigate } from 'react-router-dom';
import { runDeepBack } from '../lib/deepBack';
import EmotionInput from '../components/EmotionInput';
// 理一理分析结果视图仅在提交情绪后才需要 → 懒加载独立分包，减小主页首屏 chunk
const AnalysisResult = lazy(() => import('../components/AnalysisResult'));
const QuestionInteraction = lazy(() => import('../components/QuestionInteraction'));
const DetailedAnalysis = lazy(() => import('../components/DetailedAnalysis'));
const HealingStory = lazy(() => import('../components/HealingStory'));
const PayModal = lazy(() => import('../components/PayModal'));
const QuotaPromptModal = lazy(() => import('../components/QuotaPromptModal'));
const HistoryModal = lazy(() => import('../components/HistoryModal'));
const JourneyModal = lazy(() => import('../components/JourneyModal'));
const AuthModal = lazy(() => import('../components/AuthModal'));
const ProfileModal = lazy(() => import('../components/ProfileModal'));
const InviteModal = lazy(() => import('../components/InviteModal'));
const InboxModal = lazy(() => import('../components/InboxModal'));
const ChatPage = lazy(() => import('../components/ChatPage'));
const MembershipModal = lazy(() => import('../components/MembershipModal'));
const MoodCheckinModal = lazy(() => import('../components/MoodCheckinModal'));
const PreferencesModal = lazy(() => import('../components/PreferencesModal'));
const AppearanceModal = lazy(() => import('../components/AppearanceModal'));
import PreferenceInfo from '../components/PreferenceInfo';
import PreferencePanel from '../components/PreferencePanel';
import EntryRegionNudge from '../components/EntryRegionNudge';
import FeedbackButton from '../components/FeedbackButton';
import { useOverflowRow } from '../hooks/useOverflowRow';
const StartModal = lazy(() => import('../components/StartModal'));
const RoleplayPage = lazy(() => import('../components/RoleplayPage'));
const AboutPage = lazy(() => import('../components/AboutPage'));
import LangSwitch from '../components/LangSwitch';
import MoreMenu from '../components/MoreMenu';
import UiTourModal, { UiTourBar, markUiTourSeen, type UiTourTarget } from '../components/UiTourModal';
import SocialFollow from '../components/SocialFollow';
import InstallAppBanner from '../components/InstallAppBanner';
import MoodRewardBanner from '../components/MoodRewardBanner';
import InstallAppDialog from '../components/InstallAppDialog';
import InstallExitModal from '../components/InstallExitModal';
import { usePwaInstall } from '../hooks/usePwaInstall';
import PageTourBanner from '../components/PageTourBanner';
import FeatureCoachmarks, { type CoachStep } from '../components/FeatureCoachmarks';
import { getStoredUser, getToken, logout, reportVisit, getQuota, getPayConfig, getAnnouncement, ackReward, getCachedPlan, getCachedDaysLeft, setCachedPlan, fetchCurrentUser, getDiary, confirmAdult, isLoggedIn, quotaChatRemain, quotaIsUnlimited, getReferralSummary, type AuthUser, type PayConfig, type QuotaInfo, type MyReferralSummary } from '../services/api';
import { guestQuotaLineText, quotaTierTiao } from '../lib/quotaTiers';
import { loadPreferences } from '../lib/prefsCache';
import { markLocalAdultConfirmed, markAdultPending, hasLocalAdultConfirmation, flushAdultPending } from '../lib/adultGate';
import { setLastChatChar } from '../lib/lastChatChar';
import { pickBottomPromo } from '../lib/bottomPromo';
import type { BridgeSeed } from '../lib/rpBridge';
import { useSkin } from '../components/SkinProvider';
import { t, getLang } from '../i18n';
import { companionShortName } from '../lib/companionName';
import { mainPrice } from '../lib/payPrice';
import { DiscountBadge, StrikePrice, OfferDeadline } from '../components/ui/DiscountBadge';

function StepLoading() {
  return (
    <div className="py-12 flex items-center justify-center">
      <div className="w-6 h-6 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
    </div>
  );
}

export default function Home() {
  const { meta, skin } = useSkin(); // 当前界面皮肤（供 hero 背景 / 三入口插画按皮肤切换）
  // 三入口 logo：治愈主题统一「方块内圆形裁剪」（rounded-full + overflow-hidden + object-cover），
  // 让 chat 与 structure / story 保持一致（不再把方块图放进圆形里）；经典/禅意仍用圆角方块兜底。
  const entryImgShape = skin === 'healing' ? 'rounded-full' : 'rounded-2xl';
  const { currentStep, resetSession, payOpen, setPayOpen, payPlan, payTerm, payDays, setPayPlan, setPayTerm, setPayDays, setEmotionInput, appMode, setAppMode, sessionId, chatSessionId, setChatSessionId, chatMessages, setCurrentStep, setFeedbackOpen, setPrivacyOpen, setStructureCharacterId, setPendingChatSeed } = useAppStore();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [journeyOpen, setJourneyOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authTab, setAuthTab] = useState<'login' | 'register' | 'reset'>('login');
  // 邮件深链预填（Open Xiaoyu 按钮带 email+code）
  const [authEmail, setAuthEmail] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [authUser, setAuthUser] = useState<AuthUser | null>(() => getStoredUser());
  /** 邀请战绩（首页邀请条上的「已邀请 N 人」）：与「我的」/邀请弹窗同源，登录后才拉 */
  const [inviteStats, setInviteStats] = useState<MyReferralSummary | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  // 额度用完「获取更多额度」弹窗（已注册/免费用户；游客走注册，Plus 每日用完走会员）
  const [quotaPromptOpen, setQuotaPromptOpen] = useState(false);
  const [moodOpen, setMoodOpen] = useState(false);
  // 每日打卡奖励是否可领取（仅登录用户「今天未打卡」）→ 控制顶栏 🎁 角标 + 底部引导条
  const [moodEligible, setMoodEligible] = useState(false);
  // 底部引导条是否已曝光过（只在首次未打卡时显示一次）
  const [moodBannerSeen, setMoodBannerSeen] = useState<boolean>(() => {
    try { return localStorage.getItem('cure_mood_reward_banner_seen') === '1'; } catch { return false; }
  });
  // 重新查询今天是否已打卡（登录用户未打卡 → 显示奖励露出；打完卡/未登录 → 隐藏）
  const refreshMoodEligible = useCallback(() => {
    if (!getToken()) { setMoodEligible(false); return; }
    getDiary().then(r => {
      if (r.success && r.data) setMoodEligible(!r.data.today);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    // 邀请战绩：登录才拉（游客没有邀请资格）；失败静默，条上就不显示徽标
    if (!authUser && !getToken()) { setInviteStats(null); return; }
    let alive = true;
    getReferralSummary()
      .then((r) => { if (alive && r.success && r.data) setInviteStats(r.data); })
      .catch(() => { /* 忽略：徽标是附加信息 */ });
    return () => { alive = false; };
  }, [authUser, inviteOpen]);

  useEffect(() => { refreshMoodEligible(); }, [authUser, refreshMoodEligible]);
  const dismissMoodBanner = useCallback(() => {
    setMoodBannerSeen(true);
    try { localStorage.setItem('cure_mood_reward_banner_seen', '1'); } catch { /* 忽略 */ }
  }, []);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [prefsFocusPush, setPrefsFocusPush] = useState(false); // 直达「主动找我」：打开后定位/高亮推送开关
  // 界面外观弹窗改由全局 store 承载（原来是本页局部 state），这样剧情聊天页的「⋯」菜单也能直接打开它，
  // 用户问透明度在哪儿调时，可以在聊天里一键跳到调节处。
  const skinOpen = useAppStore((s) => s.appearanceOpen);
  const setSkinOpen = useAppStore((s) => s.setAppearanceOpen);
  const [inlinePrefsOpen, setInlinePrefsOpen] = useState(false); // 理一理顶栏内的偏好面板
  const [startOpen, setStartOpen] = useState(false);
  const [roleplayOpen, setRoleplayOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [toastDismissed, setToastDismissed] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  const install = usePwaInstall(); // 保存/安装 提示（底部轻提示 + More 菜单对话框 + 离开引导共用同一份 beforeinstallprompt）
  // 底部轻提示：只要没装且有能力提示，每次进入都显示；用户点 × 才隐藏当前视图，刷新后仍未装会再出现
  const toastVisible = !toastDismissed && install.toastEligible;
  // 底部隐私同意横幅当前高度（未同意的新访客才有），推广浮层要叠在它**上方**而不是压在它身上（F4）
  const privacyBannerH = useAppStore((s) => s.privacyBannerH);
  // 底部推广浮层排队（F4）：同屏最多一条，优先级 打卡 > 安装；隐私横幅不参与排队（合规提示常显）
  const bottomPromo = pickBottomPromo({ toastVisible, moodEligible, moodBannerSeen });
  // 直达「主动找我」：打开偏好并定位/高亮 AI 主动找我开关（顺手收起底部轻提示 / 离开引导）
  const openProactivePushPrefs = useCallback(() => {
    setToastDismissed(true);
    setExitOpen(false);
    setPrefsFocusPush(true);
    setPrefsOpen(true);
  }, []);
  // 桌面版「要离开」引导：鼠标移出页面顶部时，每天最多弹一次（已安装不弹）
  useEffect(() => {
    const onMouseOut = (e: MouseEvent) => {
      if (e.relatedTarget === null && e.clientY <= 0) {
        if (install.installed || !install.exitEligible) return;
        if (installOpen || exitOpen || toastVisible) return;
        setExitOpen(true);
        install.markExitSeen();
      }
    };
    document.addEventListener('mouseout', onMouseOut);
    return () => document.removeEventListener('mouseout', onMouseOut);
  }, [install.installed, install.exitEligible, install.markExitSeen, installOpen, exitOpen, toastVisible]);
  const [stripeSuccess, setStripeSuccess] = useState(false);
  /** Stripe 结账页点「返回」回到本站：付费弹窗要原样重开，并给一句「已取消」的说明 */
  const [payCanceled, setPayCanceled] = useState(false);
  // 待通知奖励（系统发 credit 后，用户下次登录/刷新时恭喜提示）。
  // note = 运营者随奖励写给用户的话（目前仅反馈奖励会带）：横幅据此显示回复摘要，
  // 完整内容在「小愈信箱」里（ack 只清横幅，信不会跟着消失）。
  const [rewardNotice, setRewardNotice] = useState<{ count: number; note?: string } | null>(null);
  // 小愈信箱弹窗（入口：「我的」里的信箱卡片；奖励横幅带 note 时也有「查看」直达）
  const [inboxOpen, setInboxOpen] = useState(false);
  const [membershipOpen, setMembershipOpen] = useState(false);

  const [, setLangTick] = useState(0); // 顶栏语言切换后强制重渲染全部文案（值本身不被读取，仅作触发）
  const [showApp, setShowApp] = useState(false);
  const location = useLocation();
  // 推送/PWA 深链：点通知直接进入「上次那个会话」
  const [initialRoleplayScenario, setInitialRoleplayScenario] = useState<string | null>(null);
  const [initialWenyouGame, setInitialWenyouGame] = useState<string | null>(null);
  // 从聊一聊「角色扮演指令分流」卡片过来时，直接打开「AI 创剧本」表单
  const [initialRoleplayCreate, setInitialRoleplayCreate] = useState(false);
  // 邮件深链（?open=roleplay&pref=1）：进剧情后直接打开「我的偏好」抽屉（把用户送到开关面前）
  const [initialRoleplayPref, setInitialRoleplayPref] = useState(false);
  /**
   * 聊一聊成人向引导卡（「去剧情并打开『无限制模式』」）：把用户的**开启意愿**带进剧情页。
   * 与 initialRoleplayPref 分开是有意的：邮件深链那条只打开抽屉「指路」，这条路是**真的替他开**
   * （前提是过得了 18+ 年龄闸门，见 RoleplayPage 的 initialAdultIntent）。2026-09-27 用户拍板 A 案。
   */
  const [initialRoleplayAdult, setInitialRoleplayAdult] = useState(false);
  // 【18+ 成年确认门槛（邮件落地 ?adult=1；服务端留痕见 api/services/adultConfirm.ts）】
  const [adultGateOpen, setAdultGateOpen] = useState(false);
  const [adultGateBusy, setAdultGateBusy] = useState(false);
  const [adultGateErr, setAdultGateErr] = useState('');
  /** 剧情页那处 18+ 闸门是否开着（由 RoleplayPage 上报）：开着时同样不渲染注册弹窗 */
  const [rpAdultGateOpen, setRpAdultGateOpen] = useState(false);
  const navigate = useNavigate();

  /** 去掉 URL 里的 adult=1（确认完成后调用）→ 深链 effect 会重跑，继续原本的跳转参数 */
  const stripAdultParam = useCallback(() => {
    const qs = new URLSearchParams(location.search);
    if (!qs.has('adult')) return;
    qs.delete('adult');
    const s = qs.toString();
    navigate(location.pathname + (s ? '?' + s : ''), { replace: true });
  }, [location.pathname, location.search, navigate]);

  /**
   * 用户点「我未满 18 岁」：清掉这次深链的剧情跳转参数，留在首页。
   * 不继续把他送进剧情设置里，那封邮件的目标就是成人向设置，不该顺着往下推。
   */
  const declineAdultGate = useCallback(() => {
    const qs = new URLSearchParams(location.search);
    ['adult', 'open', 'pref', 'scenario'].forEach(k => qs.delete(k));
    const s = qs.toString();
    navigate(location.pathname + (s ? '?' + s : ''), { replace: true });
  }, [location.pathname, location.search, navigate]);

  useEffect(() => {
    const qs = new URLSearchParams(location.search);
    /**
     * 18+ 门槛：邮件里的按钮带 adult=1。确认之前**不做任何跳转**
     * 否则用户会直接落到「无限制模式」那个开关面前，把年龄确认变成一句脚注。
     * 本地已确认过（同一台设备点过一次）时不再拦，去掉参数继续走原深链；
     * 服务端仍是权威：真没留痕的话，开关那一步会再弹一次确认。
     */
    if (qs.get('adult') === '1') {
      if (!hasLocalAdultConfirmation()) { setAdultGateOpen(true); return; }
      qs.delete('adult');
      const rest = qs.toString();
      navigate(location.pathname + (rest ? '?' + rest : ''), { replace: true });
      return;
    }
    const open = qs.get('open');
    if (open === 'chat') {
      const session = qs.get('session');
      if (session) setChatSessionId(session);
      setAppMode('chat');
      setShowApp(true);
    } else if (open === 'roleplay') {
      const scenario = qs.get('scenario');
      if (scenario) setInitialRoleplayScenario(scenario);
      if (qs.get('pref') === '1') setInitialRoleplayPref(true);
      setRoleplayOpen(true);
    } else if (open === 'wenyou') {
      const game = qs.get('game');
      if (game) setInitialWenyouGame(game);
      setRoleplayOpen(true);
    } else if (open === 'structure') {
      setAppMode('structure');
      setShowApp(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  /**
   * 邮件落地页的 18+ 确认。
   *
   * 无论是否登录都先提交一次（游客按设备身份留痕，注册时由 mergeGuest 并入账号）；
   * 未登录时**额外**记一个 pending 标记：等登录/注册成功后再用账号身份补交一次，
   * 这样「手机上点邮件 → 去登录 → 回来开启」这条路径也能留下账号级记录。
   */
  const confirmAdultFromEmail = async () => {
    setAdultGateBusy(true);
    setAdultGateErr('');
    try {
      const r = await confirmAdult('email-campaign');
      if (!r.success) { setAdultGateErr(t('adultGateFailed')); return; }
      markLocalAdultConfirmed();
      if (!isLoggedIn()) markAdultPending();
      setAdultGateOpen(false);
      stripAdultParam();
    } catch {
      setAdultGateErr(t('adultGateFailed'));
    } finally {
      setAdultGateBusy(false);
    }
  };

  // 登录/注册后把「未登录时的确认」补交到账号上（幂等；失败留待下次）
  useEffect(() => {
    if (!authUser) return;
    void flushAdultPending('email-campaign');
  }, [authUser]);

  // 【首次进入 · 主页功能引导气泡（coach-mark；排队于注册/新手导览/UI 导览之后）】
  const [homeCoachOpen, setHomeCoachOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('cure_home_coach_seen') !== '1'; } catch { return false; }
  });
  const homeChatBtnRef = useRef<HTMLButtonElement>(null);
  const homeRoleplayBtnRef = useRef<HTMLButtonElement>(null);
  const homeSortBtnRef = useRef<HTMLButtonElement>(null);
  const homeMoreBtnRef = useRef<HTMLButtonElement>(null);
  const homeMoodBtnRef = useRef<HTMLButtonElement>(null);
  const homeSettingsGroupRef = useRef<HTMLDivElement>(null);
  const homeLangRef = useRef<HTMLDivElement>(null);
  const homeCoachLang = getLang();
  const homeCoachSteps = useMemo<CoachStep[]>(() => [
    { key: 'more', anchorRef: homeMoreBtnRef, text: t('coachHomeMore') },
    { key: 'mood', anchorRef: homeMoodBtnRef, text: t('coachHomeMood') },
    { key: 'langFont', anchorRef: homeLangRef, text: t('coachHomeLangFont') },
    { key: 'settings', anchorRef: homeSettingsGroupRef, text: t('coachHomeSettings') },
    { key: 'roleplay', anchorRef: homeRoleplayBtnRef, text: t('coachHomeRoleplay') },
    { key: 'sort', anchorRef: homeSortBtnRef, text: t('coachHomeSort') },
    { key: 'chat', anchorRef: homeChatBtnRef, text: t('coachHomeChat') },
  ], [homeChatBtnRef, homeRoleplayBtnRef, homeSortBtnRef, homeMoreBtnRef, homeMoodBtnRef, homeSettingsGroupRef, homeLangRef, homeCoachLang, t]);
  const finishHomeCoach = useCallback(() => {
    setHomeCoachOpen(false);
    try { localStorage.setItem('cure_home_coach_seen', '1'); } catch { /* 忽略 */ }
  }, []);
  // 主页气泡导航只在「注册弹窗/新手导览/UI 导览」都关掉后出现；且注册已弹过/已登录才算「首次进入的展示窗口」
  const homeRegProceeded = (() => {
    try { return localStorage.getItem('cure_reg_prompted') === '1' || localStorage.getItem('cure_guest_prompted') === '1'; } catch { return false; }
  })();


  // 会员到期提醒：null=无需提醒；'expired'=已过期；数字=剩余天数
  const [renewal, setRenewal] = useState<null | 'expired' | number>(null);
  // 当前用户会员等级（free/plus/pro）+ 剩余天数（主页会员身份展示）
  // 首次进入用本地缓存立即渲染（避免 Pro/Plus 卡片等 getQuota 网络返回才「刷新」出来）
  const [userPlan, setUserPlan] = useState<'free' | 'plus' | 'pro'>(() => getCachedPlan());
  const [memberDaysLeft, setMemberDaysLeft] = useState<number | null>(() => getCachedDaysLeft());
  // 支付定价配置（会员块价格/开业优惠）
  const [payCfg, setPayCfg] = useState<PayConfig | null>(null);
  // 配额（免费剩余次数等，会员状态条用）
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  // 公告（最多3条，轮播）
  const [announcements, setAnnouncements] = useState<{ id: string; titleZh: string; contentZh: string; titleTw: string; contentTw: string; titleEn: string; contentEn: string }[]>([]);
  const [annIndex, setAnnIndex] = useState(0);
  const [annCollapsed, setAnnCollapsed] = useState(true); // 所有用户/游客进首页默认折叠公告
  const [annReadIds, setAnnReadIds] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('cure_announce_read_ids') || '[]'); } catch { return []; } });
  const annScrollerRef = useRef<HTMLDivElement>(null);
  const markAnnRead = (ids: string[]) => {
    if (!ids.length) return;
    setAnnReadIds(prev => {
      const merged = Array.from(new Set([...prev, ...ids]));
      try { localStorage.setItem('cure_announce_read_ids', JSON.stringify(merged)); } catch { /* 忽略 */ }
      return merged;
    });
  };

  // 上报网站访问（独立访客统计，每次打开页面算一次）
  useEffect(() => {
    reportVisit();
  }, []);

  // 用后端权威账号刷新昵称：本地缓存可能落后于后端（改名发生在其它会话/设备时）→ 顶栏/「我的」显示才与 AI 称呼一致
  useEffect(() => {
    if (!getToken()) return;
    fetchCurrentUser().then(r => {
      if (r.success && r.data?.user) {
        const u = r.data.user;
        setAuthUser(u);
        try { localStorage.setItem('cure_app_user', JSON.stringify(u)); } catch { /* 忽略 */ }
      }
    });
    // 仅在挂载时执行一次
     
  }, []);

  // 预热懒加载 chunk（聊一聊/角色扮演/了解小愈）：首屏快 + 点击秒开，两不误
  useEffect(() => {
    import('../components/ChatPage').catch(() => {});
    import('../components/RoleplayPage').catch(() => {});
    import('../components/AboutPage').catch(() => {});
  }, []);



  // 解析支付回跳参数（Stripe 付款成功 / 点「返回」取消）
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      const flag = p.get('stripe');
      if (flag === 'success') {
        setStripeSuccess(true);
        window.history.replaceState({}, '', window.location.pathname); // 清理 URL，避免刷新重复触发
        return;
      }
      if (flag === 'cancel') {
        /**
         * 用户在 Stripe 结账页点了「← 返回」：把他放回**刚刚那一屏**（付费弹窗：连续包月 / 单次购买 +
         * 档位 + 天数都还原），而不是丢回首页从头找入口，服务端 cancel_url 带了这套 query。
         * 老链接（无 pay/plan/term）也能用：按当前 store 的档位默认值打开弹窗。
         */
        const plan = p.get('plan');
        if (plan === 'plus' || plan === 'pro') setPayPlan(plan);
        const termRaw = p.get('term');
        if (termRaw === 'monthly' || termRaw === 'yearly' || termRaw === 'lifetime') setPayTerm(termRaw);
        const days = Number(p.get('days'));
        setPayDays(Number.isFinite(days) && days > 0 ? days : undefined);
        setPayCanceled(true);
        setPayOpen(true);
        window.history.replaceState({}, '', window.location.pathname); // 清理 URL，避免刷新重复弹
      }
    } catch { /* 忽略 */ }
  }, [setPayOpen, setPayPlan, setPayTerm, setPayDays]);

  // 支付成功：过完隐私同意门后，自动打开「我的」显示会员状态 + 成功横幅数秒后消失
  useEffect(() => {
    if (stripeSuccess) {
      const t1 = setTimeout(() => setProfileOpen(true), 700);
      const t2 = setTimeout(() => setStripeSuccess(false), 6000);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
  }, [stripeSuccess]);

  // 预取常用懒加载弹窗/页面 chunk：首次点击顶栏 logo 即开，消掉 ~0.5s 延迟（空闲后台拉取，不阻塞首屏）
  useEffect(() => {
    const prefetch = () => {
      const mods: Promise<unknown>[] = [
        import('../components/AuthModal'),
        import('../components/AboutPage'),
        import('../components/MoodCheckinModal'),
        import('../components/ProfileModal'),
        import('../components/InboxModal'),
        import('../components/PreferencesModal'),
        import('../components/AppearanceModal'),
        import('../components/HistoryModal'),
        import('../components/MembershipModal'),
        import('../components/ChatPage'),
      ];
      void Promise.allSettled(mods);
    };
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      (window as any).requestIdleCallback(() => prefetch(), { timeout: 1500 });
    } else {
      const t = setTimeout(() => prefetch(), 800);
      return () => clearTimeout(t);
    }
  }, []);

  // 首次访问（未注册过、未弹过注册弹窗）：新用户进页面直接弹注册（注册 tab 优先）。
  // 不再等隐私横幅「同意并继续」，隐私横幅仍常驻底部，弹窗层级高于横幅（AuthModal z-70）。
  useEffect(() => {
    if (authUser) return;
    if (getToken()) return; // 存在登录会话（token）即便本地用户缓存暂缺也视为已登录，不再自动弹注册，避免闪现/误弹
    let prompted = false;
    try {
      prompted = localStorage.getItem('cure_reg_prompted') === '1' || localStorage.getItem('cure_guest_prompted') === '1';
    } catch { /* 忽略 */ }
    if (prompted) return;
    // 稍等首屏渲染，避免弹窗打断加载
    const timer = setTimeout(() => {
      // 付费弹窗正开着（如 Stripe 取消返回后自动重开）→ 不叠加注册弹窗（AuthModal z 更高会盖住它）
      if (useAppStore.getState().payOpen) return;
      // 二次确认：期间可能已登录/已弹过注册弹窗
      try {
        if (localStorage.getItem('cure_reg_prompted') === '1') return;
        if (localStorage.getItem('cure_guest_prompted') === '1') return;
      } catch { return; }
      setAuthTab('register');
      setAuthOpen(true);
    }, 600);
    return () => clearTimeout(timer);
  }, [authUser]);

  // 新用户界面导览：游客首次进入 / 新注册用户各展示一次（注册后直接进主页，不再有前置引导弹窗）
  const [uiTourOpen, setUiTourOpen] = useState(false);
  const [uiTourFullOpen, setUiTourFullOpen] = useState(false); // 点「查看导览」才打开完整弹窗（提示条不挡首屏）
  useEffect(() => {
    if (uiTourOpen) return;
    try {
      if (localStorage.getItem('cure_ui_tour_seen') === '1') return;
    } catch { return; }
    if (authOpen) return;   // 等注册/登录弹窗关掉
    const timer = setTimeout(() => {
      // 付费弹窗开着（如 Stripe 取消返回后自动重开）→ 导览条让位，别压住用户正在做的事
      if (useAppStore.getState().payOpen) return;
      setUiTourOpen(true);
    }, 800);
    return () => clearTimeout(timer);
  }, [showApp, authOpen, uiTourOpen]);

  // 邮件深链：邮件 "Open Xiaoyu" 按钮带 verify/email/code，自动打开弹窗并预填
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      const verify = p.get('verify');
      if ((verify === 'register' || verify === 'reset') && !authUser) {
        const email = p.get('email') || '';
        const code = p.get('code') || '';
        if (email && code) {
          setAuthEmail(email);
          setAuthCode(code);
          setAuthTab(verify === 'reset' ? 'reset' : 'register');
          setAuthOpen(true);
          window.history.replaceState({}, '', window.location.pathname); // 清理 URL，避免刷新重复触发
        }
      }
    } catch { /* 忽略 */ }
  }, [authUser]);

  // 游客免费用完（理一理触发）→ 弹注册（注册送次数）
  useEffect(() => {
    const handler = () => {
      try { localStorage.setItem('cure_reg_prompted', '1'); } catch { /* 忽略 */ }
      setAuthTab('register');
      setAuthOpen(true);
    };
    window.addEventListener('xiaoyu:need-register', handler);
    return () => window.removeEventListener('xiaoyu:need-register', handler);
  }, []);

  // 获取支付定价配置（会员块价格/开业优惠）
  useEffect(() => {
    getPayConfig().then((r) => {
      if (r.success && r.data) {
        setPayCfg(r.data);
      }
    });
  }, []);

  // 获取公告（列表）
  useEffect(() => {
    getAnnouncement().then((r) => {
      if (r.success && Array.isArray(r.data) && r.data.length > 0) {
        setAnnouncements(r.data.map(a => ({
          id: a.id,
          titleZh: a.titleZh || '', contentZh: a.contentZh || '',
          titleTw: a.titleTw || '', contentTw: a.contentTw || '',
          titleEn: a.titleEn || '', contentEn: a.contentEn || '',
        })));
      }
    });
  }, []);

  // 公告默认形态：所有用户/游客进首页一律折叠（默认关闭，不再区分游客/首访展开）

  // 公告处于展开态时视为已读（默认折叠；用户点开后即标记，折叠时不再标注「新」）
  useEffect(() => {
    if (annCollapsed || announcements.length === 0) return;
    try {
      const cur = JSON.parse(localStorage.getItem('cure_announce_read_ids') || '[]') as string[];
      const unseen = announcements.filter(a => !cur.includes(a.id)).map(a => a.id);
      if (unseen.length) markAnnRead(unseen);
    } catch { /* 忽略 */ }
     
  }, [annCollapsed, announcements]);

  // 会员到期检查 + 待通知奖励检测 + 会员身份（主页展示）
  useEffect(() => {
    getQuota().then((r) => {
      if (r.success && r.data) {
        const q = r.data;
        setQuota(q);
        if (q.unlocked && q.unlockUntil) {
          const days = Math.ceil((q.unlockUntil - Date.now()) / 86400000);
          if (days <= 3) setRenewal(days);
          else setRenewal(null);
        } else if (q.unlockUntil) {
          setRenewal('expired');
        } else {
          setRenewal(null);
        }
        // 会员等级 + 剩余天数（主页身份展示）
        const plan = q.plan || (q.unlocked ? 'plus' : 'free');
        const daysLeft = q.unlockUntil ? Math.max(0, Math.ceil((q.unlockUntil - Date.now()) / 86400000)) : null;
        setUserPlan(plan);
        setMemberDaysLeft(daysLeft);
        setCachedPlan(plan, q.unlockUntil); // 缓存身份：下次进入秒开 Pro/Plus 卡片
        // 系统奖励待通知：弹恭喜提示（登录后或刷新时）
        if (q.pendingReward && q.pendingReward.count > 0) {
          setRewardNotice({ count: q.pendingReward.count, note: q.pendingReward.note });
        }
      }
    });
  }, [authUser, payOpen]);

  /**
   * 展示奖励恭喜提示：5 秒后自动消失，并通知后端已读。
   *
   * ⚠️ 带 note（运营者写了回复）时**不自动消失**：这段回复的完整内容在「小愈信箱」里，
   * 横幅是用户此刻唯一能点进信箱的线索，5 秒后自己消失等于把线索也吞了。
   * 用户关掉或点「查看」时才 ack（信仍在信箱，不受影响）。
   */
  useEffect(() => {
    if (rewardNotice == null) return;
    if (rewardNotice.note) return;
    const timer = setTimeout(() => {
      ackReward().finally(() => setRewardNotice(null));
    }, 5000);
    return () => clearTimeout(timer);
  }, [rewardNotice]);

  // 预热偏好缓存（聊一聊/理一聊打开时偏好已就绪）
  // 2026-09-23：不再同步「陪伴方式」到全局 store，用户侧档位已退场，判断交给小愈自己
  useEffect(() => {
    loadPreferences().catch(() => {});
  }, []);

  // 将步骤字符串转换为数字
  const getStepNumber = (step: string) => {
    const stepMap: Record<string, number> = {
      'input': 1,
      'analysis': 2,
      'questions': 3,
      'detailed': 4,
      'story': 5,
    };
    return stepMap[step] || 1;
  };
  
  const currentStepNumber = getStepNumber(currentStep);

  const handleStartJourney = () => {
    setStructureCharacterId(null); // 独立理一理 = 默认小愈
    setAppMode('structure');
    setShowApp(true);
    window.scrollTo(0, 0);
  };

  const handleBackToHome = () => {
    setShowApp(false);
    window.scrollTo(0, 0);
  };

  // 理一理流程步骤：支持回看任意已到达的步骤
  const STEP_KEYS = ['input', 'analysis', 'questions', 'detailed', 'story'] as const;
  const handleBackStep = () => {
    const idx = STEP_KEYS.indexOf(currentStep);
    if (idx > 0) {
      setCurrentStep(STEP_KEYS[idx - 1]);
    } else {
      handleBackToHome();
    }
  };
  const handleJumpStep = (n: number) => {
    if (n >= 1 && n <= currentStepNumber) {
      setCurrentStep(STEP_KEYS[n - 1]);
    }
  };

  /**
   * 聊一聊 chunk 的**提前下载**（2026-09-20 提速）：
   * 懒加载 chunk 只在点开时才下载，慢网（跨境走 Cloudflare）那一下就多等半秒；
   * 空闲预取（现有 requestIdleCallback）之后如果用户点得很快仍会撞上，所以手指**按下**那一刻就开始拉。
   */
  const warmChatChunk = () => { void import('../components/ChatPage'); };

  // 聊一聊：进入对话陪伴模式（若已有理一理会话，带上它保持连续性）
  const handleStartChat = () => {
    if (sessionId && !chatSessionId) setChatSessionId(sessionId);
    setAppMode('chat');
    setShowApp(true);
    window.scrollTo(0, 0);
  };

  // 从聊一聊转去理一理：把最近一段完整对话（双方）带过去，让 AI 接得上
  const handleGoStructure = () => {
    const recent = chatMessages.slice(-8);
    // 这段前缀会**预填进理一理的输入框**（用户看得见），所以必须跟随界面语言
    const isEn = getLang() === 'en';
    const transcript = recent
      .map(m => (m.role === 'user' ? (isEn ? 'Me: ' : '我：') : companionShortName() + (isEn ? ': ' : '：')) + m.content)
      .join('\n');
    const seed = recent.length > 0
      ? (isEn ? '(I was just talking with ' + companionShortName() + ' - please help me sort this out)\n' : '（我刚和小愈聊了一会儿，想请你帮我理一理）\n') + transcript
      : '';
    setEmotionInput(seed);
    setStructureCharacterId(null); // 独立理一理 = 默认小愈（逐角色理一理走聊一聊内「帮我理一理」）
    setAppMode('structure');
    setCurrentStep('input');
    window.scrollTo(0, 0);
  };

  // 进入 / 退出「剧情演绎」：从聊一聊的引导卡过来时可指定直达「AI 创剧本」表单；
  // 从剧情角色的「回剧情继续」过来时带 scenarioId（否则那个按钮只会落到剧本列表，名不副实）。
  const openRoleplay = (opts?: { create?: boolean; scenarioId?: string; pref?: boolean; adult?: boolean }) => {
    setInitialRoleplayCreate(!!opts?.create);
    setInitialRoleplayScenario(opts?.scenarioId || null);
    /**
     * 邮件深链（?open=roleplay&pref=1）：进剧情后自动展开「我的偏好」抽屉，把用户送到开关前
     * 这条路只**指路**，不替用户改任何设置。
     */
    setInitialRoleplayPref(!!opts?.pref);
    /**
     * 成人向引导卡（聊一聊里说想聊色情/情欲 → 点「去剧情并打开『无限制模式』」）：
     * 用户按的按钮上就写着「打开」，所以这份意愿带到底，不再让他进去自己找开关（2026-09-27 A 案）。
     * 三个分支（不可用只提示 / 已过 18+ 直接开 / 未过先弹闸门）都在 RoleplayPage 那侧执行，
     * 这里只负责把意图递进去。⚠️ 18+ 闸门一步都不省。
     */
    setInitialRoleplayAdult(!!opts?.adult);
    setRoleplayOpen(true);
  };
  /**
   * 退出剧情模块时把「深链目标剧本」一起清掉。
   * 为什么：`initialRoleplayScenario` 是**一次性意图**（推送通知/邮件深链/「回剧情继续」），
   * 留着的话下次从首页进剧情会又被拽回同一个剧本（用户以为"怎么老是这一部"）。
   */
  const closeRoleplay = () => {
    setRoleplayOpen(false);
    setInitialRoleplayCreate(false);
    setInitialRoleplayScenario(null);
    setInitialWenyouGame(null);
    // 「自动展开我的偏好」也是**一次性意图**（同上面那条注释的理由）：不清掉的话，
    // 用户下次从首页正常进剧情、一挑完剧本就又被抽屉拦住，像是自己冒出来的。
    // 之前只有邮件深链用它，邮件本身是低频入口所以没暴露；聊一聊引导卡是高频入口，必须清。
    setInitialRoleplayPref(false);
    // 同理，成人向意图也是**一次性**的：不清掉的话，下次正常从首页进剧情会被莫名打开无限制模式。
    setInitialRoleplayAdult(false);
  };

  // 剧情 → 聊一聊 跨模式桥（B 方案）：接收角色扮演页写好的草稿，切到聊一聊。
  // 草稿只是**填进输入框**，等用户自己点发送；绝不自动发送、绝不写进消息集合（红线 6）。
  const goChatWithBridgeSeed = (seed: BridgeSeed) => {
    setPendingChatSeed(seed);
    setRoleplayOpen(false);
    setInitialRoleplayCreate(false);
    setAppMode('chat');
    setShowApp(true);
    window.scrollTo(0, 0);
  };

  /**
   * 把剧情角色加到聊一聊之后「去看看」：切到聊一聊。
   * 与上面那条桥的区别：**不带草稿**，目标角色由 RoleplayPage 写进 `pendingChatCharId`，
   * 聊一聊挂载时读一次即清空（落到新角色的会话线，而不是用户的输入框）。
   */
  const openChatAfterImport = () => {
    setPendingChatSeed(null);
    setRoleplayOpen(false);
    setInitialRoleplayCreate(false);
    setAppMode('chat');
    setShowApp(true);
    window.scrollTo(0, 0);
  };

  // 【手机返回键/浏览器后退适配：深页返回在 App 内逐级回退，而不是退出浏览器】
  // 深页：角色扮演 / 关于 / 理一理 / 聊一聊（showApp）
  const deepViewKey = roleplayOpen ? 'roleplay'
    : aboutOpen ? 'about'
    : showApp ? (appMode === 'chat' ? 'chat' : 'structure')
    : null;
  const prevDeepRef = useRef<string | null>(null);
  // 深页 / 模式 / 理一理步骤切换后回到页面顶部（否则新页面会「卡在中间」；html 有 scroll-behavior:smooth，显式 instant 强制瞬时）
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [showApp, appMode, currentStep, roleplayOpen, aboutOpen]);
  // 从首页进入深页时 pushState，让手机的返回键触发 popstate
  // 必须保留 search：分享/邀请/邮件深链参数（?s=&o=、?ref=、?verify=）不能被丢
  useEffect(() => {
    if (deepViewKey && prevDeepRef.current === null) {
      window.history.pushState(
        // xiaoyuRp: 0 = 剧情模式的「剧本列表层」起点（RoleplayPage 读 history.state.xiaoyuRp 判断
        // 自己在第几层、要不要补压历史条目）。这里显式归零，避免从上一轮剧情模式带过来的旧层号
        // 让剧情模式少压历史条目（返回键就会提前离开站点）。
        { ...(window.history.state || {}), xiaoyuView: deepViewKey, xiaoyuRp: 0 },
        '',
        window.location.pathname + window.location.search,
      );
    }
    prevDeepRef.current = deepViewKey;
  }, [deepViewKey]);
  // 返回键：深页内按返回 → App 内回退一层；顶层首页时交给浏览器（退出/上一页）
  useEffect(() => {
    const onPop = () => {
      // 先问已注册的深页组件（剧情模式本身 / 千世书文游…，从最深往前问）能否消费这次返回
      // 它们内部按返回键应逐级回退，而不是被这里直接关掉整个角色扮演、跳回主界面
      if (runDeepBack()) return;
      if (aboutOpen) { setAboutOpen(false); return; }
      if (roleplayOpen) { closeRoleplay(); return; }
      if (showApp) {
        if (appMode === 'structure') {
          const idx = STEP_KEYS.indexOf(currentStep);
          if (idx > 0) { setCurrentStep(STEP_KEYS[idx - 1]); return; }
        }
        setShowApp(false);
        return;
      }
      // 顶层：不拦截，让浏览器处理
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleplayOpen, aboutOpen, showApp, appMode, currentStep]);

  const openAuth = (tab: 'login' | 'register' | 'reset' = 'login') => {
    setAuthTab(tab);
    setAuthOpen(true);
  };

  // 免费用完：游客 → 先弹注册（注册送次数，优先于付费）；已注册免费用户 → 弹「获取更多额度」（分享/反馈）；
  // Plus 每日额度用完 → 弹会员升级（每日额度无法靠分享/反馈解决）
  const handleQuotaExhausted = () => {
    if (!authUser) {
      // 游客：先注册拿更多免费次数（而非直接付费）
      try { localStorage.setItem('cure_reg_prompted', '1'); } catch { /* 忽略 */ }
      setAuthTab('register');
      setAuthOpen(true);
    } else if (userPlan === 'plus') {
      setMembershipOpen(true);
    } else {
      setQuotaPromptOpen(true);
    }
  };
  // 任意功能触发「免费额度用完」统一入口：游客→注册；已注册→「获取更多额度」/会员升级
  useEffect(() => {
    const handler = () => handleQuotaExhausted();
    window.addEventListener('xiaoyu:quota-exhausted', handler);
    return () => window.removeEventListener('xiaoyu:quota-exhausted', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser, userPlan]);

  const handleLoginSuccess = (user: AuthUser) => {
    setAuthUser(user);
    // 无论登录还是注册，都标记"已弹过注册弹窗"，下次不再打扰
    try { localStorage.setItem('cure_reg_prompted', '1'); } catch { /* 忽略 */ }
    // 登录成功即视为同意隐私：写入标记 + 通知 App 关闭底部横幅
    try { localStorage.setItem('cure_privacy_agreed', '1'); } catch { /* 忽略 */ }
    try { window.dispatchEvent(new CustomEvent('privacy-agreed')); } catch { /* 忽略 */ }
  };

  // 注册成功：直接进主页（2026-10-02 起新用户引导整体下线，注册后不再弹「你想从哪一种感觉开始」）
  const handleRegistered = () => {
    try { localStorage.setItem('cure_reg_prompted', '1'); } catch { /* 忽略 */ }
    // 注册成功即视为同意隐私：写入标记 + 通知 App 关闭底部横幅
    try { localStorage.setItem('cure_privacy_agreed', '1'); } catch { /* 忽略 */ }
    try { window.dispatchEvent(new CustomEvent('privacy-agreed')); } catch { /* 忽略 */ }
  };

  const handleLogout = async () => {
    await logout();
    setAuthUser(null);
    resetSession();
    setLastChatChar(null); // 清理「上一次聊天角色」缓存，避免跨账号串角色
  };

  const displayName = authUser?.username || authUser?.phone || (authUser ? authUser.email.split('@')[0] : '');

  // 会员到期提醒条
  const renewalBanner = renewal !== null ? (
    <div className="bg-amber-50 border-b border-amber-200">
      <div className="container mx-auto px-4 py-2 flex items-center justify-center gap-2 text-sm text-amber-800">
        <AlertCircle className="w-4 h-4 flex-shrink-0" />
        {renewal === 'expired' ? (
          <span>{t('renewalExpired')}<button onClick={() => setPayOpen(true)} className="underline font-medium">{t('renewalBtnExpired')}</button></span>
        ) : (
          <span>{t('renewalDays', { n: renewal })}<button onClick={() => setPayOpen(true)} className="underline font-medium">{t('renewalBtn')}</button>{t('renewalTip')}</span>
        )}
      </div>
    </div>
  ) : null;

  // 公告横幅（多条轮播）
  const currentAnn = announcements[Math.min(annIndex, Math.max(0, announcements.length - 1))];
  // 公告按用户所选语言显示（三语字段，缺语言回退中文）
  const annLang = getLang();
  const annText = currentAnn ? (
    annLang === 'en'
      ? { title: currentAnn.titleEn || currentAnn.titleZh, content: currentAnn.contentEn || currentAnn.contentZh }
      : annLang === 'zh-TW'
        ? { title: currentAnn.titleTw || currentAnn.titleZh, content: currentAnn.contentTw || currentAnn.contentZh }
        : { title: currentAnn.titleZh, content: currentAnn.contentZh }
  ) : null;
  // 公告滑动：手指/滚轮横向滑动查看其它通告，圆点同步当前条
  const scrollAnnTo = (i: number) => {
    const el = annScrollerRef.current;
    if (!el) return;
    const idx = Math.max(0, Math.min(i, announcements.length - 1));
    el.scrollTo({ left: idx * el.clientWidth, behavior: 'smooth' });
    setAnnIndex(idx);
  };
  const handleAnnScroll = () => {
    const el = annScrollerRef.current;
    if (!el || el.clientWidth === 0) return;
    const idx = Math.round(el.scrollLeft / el.clientWidth);
    setAnnIndex(Math.max(0, Math.min(idx, announcements.length - 1)));
  };
  // 是否存在用户未读的新公告（用于折叠条上的「新」徽标）
  const hasNewAnn = announcements.some(a => !annReadIds.includes(a.id));
  const announcementBanner = announcements.length > 0 && currentAnn && annText ? (
    annCollapsed ? (
      // 折叠：细条通知，点击展开 / 可关闭（本次会话隐藏，刷新再出现）
      <div className="bg-primary-strong text-white">
        <div className="container mx-auto px-4 py-1.5 flex items-center gap-1">
          <button onClick={() => setAnnCollapsed(false)} className="flex items-center gap-1.5 text-[12px] sm:text-[13px] font-medium min-w-0 flex-1 text-left">
            <Megaphone className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="truncate">{t('notiLabel')}</span>
            {hasNewAnn && (
              <span className="ml-0.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-amber-400 text-white text-[10px] font-bold">新</span>
            )}
          </button>
          {/* ⚠️ 2026-09-21 键盘走查 O7：这个下箭头与左边那个「通知」按钮是**同一个动作**（都是展开公告）。
              以前它也写 aria-label={t('notiLabel')}，于是读屏连着听到两个一模一样的「通知」按钮，分不清谁是谁。
              它只是左边按钮的视觉补强 ⇒ 从无障碍树和 Tab 序列里摘掉（鼠标点击照旧）。
              如果哪天要给它独立语义，应新增自己的 i18n 键（如 notiExpand＝展開公告），别再复用 notiLabel。 */}
          <button onClick={() => setAnnCollapsed(false)} aria-hidden="true" tabIndex={-1} className="text-white/70 hover:text-white flex-shrink-0 p-1">
            <ChevronDown className="w-4 h-4" />
          </button>
          <button onClick={() => setAnnouncements([])} aria-label={t('notiClose')} className="text-white/70 hover:text-white flex-shrink-0 p-1">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    ) : (
      // 展开：可左右滑动的公告轮播（横向滚动 + 圆点跳转）
      <div className="bg-primary-strong text-white">
        <div className="container mx-auto px-4 py-2.5 flex items-start gap-3">
          <div
            ref={annScrollerRef}
            onScroll={handleAnnScroll}
            className="flex flex-1 min-w-0 overflow-x-auto snap-x snap-mandatory scroll-smooth [&::-webkit-scrollbar]:hidden"
          >
            {announcements.map((a) => {
              const txt = annLang === 'en'
                ? { title: a.titleEn || a.titleZh, content: a.contentEn || a.contentZh }
                : annLang === 'zh-TW'
                  ? { title: a.titleTw || a.titleZh, content: a.contentTw || a.contentZh }
                  : { title: a.titleZh, content: a.contentZh };
              return (
                <div key={a.id} className="w-full max-w-full flex-shrink-0 snap-center pr-1">
                  <p className="text-[13px] sm:text-sm leading-snug break-words">
                    <b>{txt.title}：</b>{txt.content}
                  </p>
                </div>
              );
            })}
          </div>
          <div className="flex flex-col items-center gap-1 flex-shrink-0 pt-0.5">
            <button onClick={() => setAnnCollapsed(true)} aria-label={t('notiCollapse')} className="text-white/70 hover:text-white p-1">
              <ChevronUp className="w-4 h-4" />
            </button>
            {announcements.length > 1 && (
              <div className="flex items-center gap-1">
                {announcements.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => scrollAnnTo(i)}
                    aria-label={t('notiSwipeHint')}
                    className={`w-1.5 h-1.5 rounded-full ${i === Math.min(annIndex, announcements.length - 1) ? 'bg-white' : 'bg-white/40'}`}
                  />
                ))}
              </div>
            )}
            <button onClick={() => setAnnouncements([])} aria-label={t('notiClose')} className="text-white/70 hover:text-white p-1">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    )
  ) : null;

  // 所有弹窗（两个视图共用）：懒加载弹窗仅在打开时才渲染（不再全部常驻），
  // 避免首屏就把 Profile/Auth/Pay/Membership 等弹窗 chunk 一起拉下来拖慢首绘。
  const modals = (
    <Suspense fallback={null}>
      <>
      {/* 18+ 成年确认（邮件落地 ?adult=1）：确认前挡住后续跳转。
          层级必须**高于模态层**：AuthModal/InstallAppDialog/PrivacyModal/InviteModal 分别是 70/70/80/90，
          与它同层或更高（实测新访客会自动弹注册框，且在 DOM 里更靠后 → 同层时把闸门整个盖住，
          用户根本看不到年龄确认，闸门形同不存在）。取 95：高于全部模态层，仍低于应用级浮层
          （AppSplash 100 / LangSwitch 120），那些是加载与引导，本就该在最上面。 */}
      {adultGateOpen && (
        <div className="fixed inset-0 z-[95] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-5">
            <div className="flex items-center justify-center gap-2 mb-2">
              <AlertCircle className="w-5 h-5 text-amber-700" />
              <h3 className="text-lg font-bold text-gray-800">{t('adultGateTitle')}</h3>
            </div>
            <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">{t('adultGateBody')}</p>
            <div className="mt-3 rounded-xl border border-rose-100 bg-rose-50/70 px-3 py-2.5">
              <p className="text-[12px] text-rose-900/85 leading-relaxed whitespace-pre-line">{t('adultGateLimits')}</p>
            </div>
            {!!adultGateErr && <p className="mt-2 text-[12px] text-amber-700">{adultGateErr}</p>}
            <div className="mt-4 space-y-2">
              <button
                onClick={confirmAdultFromEmail}
                disabled={adultGateBusy}
                className="w-full bg-primary-strong text-white font-semibold rounded-full py-2.5 hover:bg-primary active:scale-[0.98] transition-all disabled:opacity-60"
              >
                {t('adultGateConfirm')}
              </button>
              <button
                onClick={() => { setAdultGateOpen(false); setAdultGateErr(''); declineAdultGate(); }}
                disabled={adultGateBusy}
                className="w-full bg-gray-100 text-gray-600 font-medium rounded-full py-2.5 hover:bg-gray-200 transition-all disabled:opacity-60"
              >
                {t('adultGateUnderage')}
              </button>
            </div>
          </div>
        </div>
      )}
      {payOpen && (
        <PayModal
          open
          plan={payPlan}
          days={payDays}
          term={payTerm}
          canceled={payCanceled}
          onClose={() => { setPayOpen(false); setPayDays(undefined); setPayCanceled(false); }}
          onNeedLogin={() => { setPayOpen(false); setPayCanceled(false); openAuth('register'); }}
          onOpenMembership={() => { setPayOpen(false); setPayCanceled(false); setMembershipOpen(true); }}
          onSwitchPlan={(p) => { setPayPlan(p); setPayDays(undefined); }}
        />
      )}
      {historyOpen && <HistoryModal open onClose={() => setHistoryOpen(false)} />}
      {journeyOpen && (
        <JourneyModal
          open
          onClose={() => setJourneyOpen(false)}
          onStartChat={() => { setJourneyOpen(false); handleStartChat(); }}
          onStartStructure={() => { setJourneyOpen(false); handleStartJourney(); }}
          onStartRoleplay={() => { setJourneyOpen(false); setRoleplayOpen(true); }}
        />
      )}
      {moodOpen && <MoodCheckinModal open onClose={() => { setMoodOpen(false); refreshMoodEligible(); }} />}
      {prefsOpen && <PreferencesModal open onClose={() => { setPrefsOpen(false); setPrefsFocusPush(false); }} onFeedback={() => { setPrefsOpen(false); setPrefsFocusPush(false); setFeedbackOpen(true); }} onRequestMembership={() => setMembershipOpen(true)} focusProactivePush={prefsFocusPush} pwaInstall={{ installed: install.installed, mode: install.mode, promptInstall: install.promptInstall }} />}
      {skinOpen && <AppearanceModal open onClose={() => setSkinOpen(false)} />}
      {startOpen && (
        <StartModal
          open
          onClose={() => setStartOpen(false)}
          onChat={() => { setStartOpen(false); handleStartChat(); }}
          onStructure={() => { setStartOpen(false); handleStartJourney(); }}
          onRoleplay={() => { setStartOpen(false); setRoleplayOpen(true); }}
        />
      )}
      {/* 年龄闸门未答完之前，不渲染注册弹窗：两者同时弹出时，实测注册弹窗会盖住闸门
          （新访客首屏自动弹注册框），用户就看不到年龄确认了。先答闸门，答完注册框自然出现。
          rpAdultGateOpen 覆盖剧情页里那处闸门（状态由 RoleplayPage 上报）。 */}
      {authOpen && !adultGateOpen && !rpAdultGateOpen && (
        <AuthModal
          open
          onClose={() => { setAuthOpen(false); try { localStorage.setItem('cure_reg_prompted', '1'); } catch { /* 忽略 */ } }}
          onLoginSuccess={handleLoginSuccess}
          onRegistered={handleRegistered}
          initialTab={authTab}
          initialEmail={authEmail}
          initialCode={authCode}
          registerChatBonus={quota?.registerChatBonus ?? 0}
          registerProPromoActive={quota?.registerProPromoActive ?? false}
          registerProDays={quota?.registerProDays ?? 0}
          registeredDailyTiao={quotaTierTiao(quota, payCfg)?.d}
          googleClientId={quota?.googleClientId}
        />
      )}
      {profileOpen && (
        <ProfileModal
          open
          onClose={() => setProfileOpen(false)}
          onLogout={() => { setAuthUser(null); resetSession(); setLastChatChar(null); }}
          onNeedPay={() => { setProfileOpen(false); setPayOpen(true); }}
          onOpenMembership={() => { setProfileOpen(false); setMembershipOpen(true); }}
          // 「我的 → 邀请好友」里的「查看我的邀请记录」：关掉我的，打开邀请弹窗（明细在那边）
          onOpenInvite={() => { setProfileOpen(false); setInviteOpen(true); }}
          // 「我的 → 小愈信箱」：同样钻取式，关掉我的，打开信箱（避免弹窗套弹窗的层级/滚动问题）
          onOpenInbox={() => { setProfileOpen(false); setInboxOpen(true); }}
          onNeedLogin={() => { setProfileOpen(false); openAuth('login'); }}
          onRenamed={(u) => setAuthUser(u)}
        />
      )}
      {inboxOpen && (
        <InboxModal
          open
          onClose={() => setInboxOpen(false)}
        />
      )}
      {membershipOpen && (
        <MembershipModal
          open
          onClose={() => setMembershipOpen(false)}
          onOpenPay={(plan, term) => { setMembershipOpen(false); setPayPlan(plan); setPayTerm(term || 'monthly'); setPayOpen(true); }}
          onOpenRenew={(days) => { setMembershipOpen(false); setPayPlan('pro'); setPayDays(days); setPayOpen(true); }}
          userPlan={userPlan}
          memberDaysLeft={memberDaysLeft}
          initialConfig={payCfg}
        />
      )}
      {inviteOpen && (
        <InviteModal
          open
          onClose={() => setInviteOpen(false)}
          onNeedRegister={() => { setInviteOpen(false); openAuth('register'); }}
        />
      )}
      {quotaPromptOpen && (
        <QuotaPromptModal
          open
          onClose={() => setQuotaPromptOpen(false)}
          onOpenFeedback={() => { setQuotaPromptOpen(false); setFeedbackOpen(true); }}
          onOpenMembership={() => { setQuotaPromptOpen(false); setMembershipOpen(true); }}
        />
      )}
      {uiTourFullOpen && (
        <UiTourModal
          open
          onClose={() => setUiTourFullOpen(false)}
          onNavigate={(target: UiTourTarget) => {
            if (target === 'about') setAboutOpen(true);
            else if (target === 'profile') setProfileOpen(true);
            else if (target === 'mood') setMoodOpen(true);
            // 「我的记录」= 理一理的陪伴记录（HistoryModal 展示的是理一理会话）→ 导览条目不再在主页直开弹窗，
            // 而是带用户进理一理（记录入口在理一理顶栏 🕘）
            else if (target === 'records') handleStartJourney();
            else if (target === 'journey') setJourneyOpen(true);
            else if (target === 'prefs') setPrefsOpen(true);
            else if (target === 'skin') setSkinOpen(true);
            else if (target === 'feedback') setFeedbackOpen(true);
          }}
        />
      )}
      {installOpen && (
        <InstallAppDialog
          open
          onClose={() => setInstallOpen(false)}
          installed={install.installed}
          mode={install.mode}
          promptInstall={install.promptInstall}
        />
      )}
      {exitOpen && (
        <InstallExitModal
          open
          onClose={() => setExitOpen(false)}
          onOpenGuide={() => { setExitOpen(false); setInstallOpen(true); }}
          installed={install.installed}
          mode={install.mode}
          promptInstall={install.promptInstall}
          onOpenProactivePush={openProactivePushPrefs}
        />
      )}
      </>
    </Suspense>
  );

  // 顶部右侧用户区（手机上紧凑：只显示图标，文字在 sm 以上显示）
  const structNavOverflow = useOverflowRow();
  const userArea = (
    <div className="hidden sm:flex items-center space-x-2 sm:space-x-3">
      {/* 会员徽章：登录且是会员时显示（点击打开会员中心） */}
      {authUser && userPlan !== 'free' && (
        <button
          onClick={() => setMembershipOpen(true)}
          title={userPlan === 'pro' ? t('memBadgePro') : t('memBadgePlus')}
          className={"flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full border shadow-sm transition-all " + (userPlan === 'pro'
            ? 'bg-gradient-to-r from-[var(--color-accent)] to-[var(--color-primary)] text-white border-transparent'
            : 'bg-primary-lighter text-primary-text border-primary/30')}
        >
          <Crown className="w-3.5 h-3.5" />
          {userPlan === 'pro' ? 'Pro' : 'Plus'}
        </button>
      )}
      <button
        onClick={() => setMoodOpen(true)}
        title={t('profileMoodModule')}
        aria-label={t('profileMoodModule')}
        className="flex items-center space-x-1 text-sm text-primary-text hover:text-primary transition-colors p-1.5 sm:p-0"
      >
        <CalendarDays className="w-5 h-5 sm:w-4 sm:h-4" />
        <span className="hidden sm:inline">{t('profileMoodModule')}</span>
      </button>
      <button
        onClick={() => setPrefsOpen(true)}
        title={t('profilePrefs')}
        aria-label={t('profilePrefs')}
        className="flex items-center space-x-1 text-sm text-gray-600 hover:text-gray-800 transition-colors p-1.5 sm:p-0"
      >
        <Settings2 className="w-5 h-5 sm:w-4 sm:h-4" />
        <span className="hidden sm:inline">{t('profilePrefs')}</span>
      </button>
      <button
        onClick={() => setSkinOpen(true)}
        title={t('skinAppearance')}
        aria-label={t('skinAppearance')}
        className="flex items-center space-x-1 text-sm text-gray-600 hover:text-gray-800 transition-colors p-1.5 sm:p-0"
      >
        <Palette className="w-5 h-5 sm:w-4 sm:h-4" />
        <span className="hidden sm:inline">{t('skinAppearance')}</span>
      </button>
      <button
        onClick={() => setHistoryOpen(true)}
        className="flex items-center space-x-1 text-sm text-primary-text hover:text-primary transition-colors p-1.5 sm:p-0"
      >
        <History className="w-5 h-5 sm:w-4 sm:h-4" />
        <span className="hidden sm:inline">{t('myRecords')}</span>
      </button>
      <button
        onClick={() => setProfileOpen(true)}
        className="flex items-center space-x-1 text-sm text-gray-600 hover:text-gray-800 transition-colors p-1.5 sm:p-0"
      >
        <UserIcon className="w-5 h-5 sm:w-4 sm:h-4" />
        <span className="hidden sm:inline">{t('myProfile')}</span>
      </button>
      <button
        onClick={() => setFeedbackOpen(true)}
        title={t('profileFeedback')}
        aria-label={t('profileFeedback')}
        className="flex items-center space-x-1 text-sm text-gray-600 hover:text-gray-800 transition-colors p-1.5 sm:p-0"
      >
        <SkinFeedbackIcon className="w-6 h-6 sm:w-5 sm:h-5" />
        <span className="hidden sm:inline">{t('profileFeedback')}</span>
      </button>
      {authUser ? (
        <>
          <span className="hidden sm:inline text-sm font-medium text-gray-700 max-w-[80px] truncate">{displayName}</span>
          <button
            onClick={handleLogout}
            title={t('loginOut')}
            aria-label={t('loginOut')}
            className="flex items-center text-sm text-ink-soft hover:text-red-500 transition-colors p-1.5 sm:p-0"
          >
            <LogOut className="w-5 h-5 sm:w-4 sm:h-4" />
          </button>
        </>
      ) : (
        <button
          onClick={() => openAuth('login')}
          className="text-xs sm:text-sm text-primary-text hover:text-primary font-medium transition-colors whitespace-nowrap"
        >
          {t('login')}
        </button>
      )}
    </div>
  );



  // 了解小愈（聚合介绍页）
  if (aboutOpen) {
    return (
      <>
        <Suspense fallback=<div className="min-h-screen bg-brand flex items-center justify-center"><div className="w-8 h-8 rounded-full border-2 border-white/30 border-t-white animate-spin" /></div>><AboutPage onBack={() => setAboutOpen(false)} onOpenPrivacy={() => setPrivacyOpen(true)} onOpenMembership={() => setMembershipOpen(true)} onNeedLogin={() => openAuth('register')} registerProPromoActive={quota?.registerProPromoActive ?? false} registerProDays={quota?.registerProDays ?? 0} registerChatBonus={quota?.registerChatBonus ?? 0} guestDailyTiao={quotaTierTiao(quota, payCfg)?.g} registeredDailyTiao={quotaTierTiao(quota, payCfg)?.d} /></Suspense>
        {modals}
      </>
    );
  }

  // 角色剧情扮演（独立全屏模块）
  if (roleplayOpen) {
    return (
      <>
        <Suspense fallback=<div className="min-h-screen bg-brand flex items-center justify-center"><div className="w-8 h-8 rounded-full border-2 border-white/30 border-t-white animate-spin" /></div>><RoleplayPage onBack={closeRoleplay} onNeedLogin={() => openAuth('login')} onNeedPay={handleQuotaExhausted} authUser={authUser} onOpenMembership={() => setMembershipOpen(true)} initialScenarioId={initialRoleplayScenario ?? undefined} initialWenyouGame={initialWenyouGame ?? undefined} initialCreate={initialRoleplayCreate} initialPrefOpen={initialRoleplayPref} initialAdultIntent={initialRoleplayAdult} onAdultGateChange={setRpAdultGateOpen} onGoChat={goChatWithBridgeSeed} onOpenChat={openChatAfterImport} /></Suspense>
        {modals}
      </>
    );
  }

  // 如果用户选择开始应用，显示相应的步骤组件
  if (showApp) {
    // 聊一聊：对话陪伴模式
    if (appMode === 'chat') {
      return (
        <>
          <div className="bg-brand">
            <Suspense fallback=<div className="min-h-screen bg-brand flex items-center justify-center"><div className="w-8 h-8 rounded-full border-2 border-white/30 border-t-white animate-spin" /></div>>
              <ChatPage onBack={handleBackToHome} onGoStructure={handleGoStructure} onGoRoleplay={(stage, scenarioId, opts) => openRoleplay({ create: stage === 'custom', scenarioId, pref: opts?.pref, adult: opts?.adult })} onNeedPay={handleQuotaExhausted} onOpenMembership={() => setMembershipOpen(true)} onNeedLogin={() => openAuth('register')}>
                {announcementBanner}
                {renewalBanner}
              </ChatPage>
            </Suspense>
          </div>
          {modals}
        </>
      );
    }
    return (
      <>
      <div className="min-h-screen bg-brand">
        {announcementBanner}
        {renewalBanner}
        <div className="sticky top-0 z-50 bg-white shadow-sm border-b border-gray-100">
          <div className="container mx-auto px-3 sm:px-4 py-3 sm:py-4">
            <div className="flex items-center justify-between">
              <button
                onClick={handleBackStep}
                aria-label={currentStepNumber > 1 ? t('prevStep') : t('backHome')}
                title={currentStepNumber > 1 ? t('prevStep') : t('backHome')}
                className="flex items-center text-sm text-ink-soft hover:text-gray-700 transition-colors p-2 -ml-2 min-h-[44px] min-w-[48px]"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              
              <div className="flex items-center space-x-1.5 sm:space-x-2">
                <Heart className="w-5 h-5 sm:w-6 sm:h-6 text-primary" />
                <span className="font-semibold text-gray-800 text-sm sm:text-base">{t('appShort')}</span>
              </div>
              
              <div ref={structNavOverflow.containerRef} className="flex items-center space-x-2 sm:space-x-3 min-w-0">
                {/* 用户区：带文字功能项一旦会换行 → 隐藏并改用「…」 */}
                <div className={structNavOverflow.overflowing ? 'hidden' : 'flex items-center'}>{userArea}</div>
<MoreMenu
          show={structNavOverflow.overflowing}
          authUser={!!authUser}
          displayName={displayName}
          plan={userPlan}
          onMood={() => setMoodOpen(true)}
          onHistory={() => setHistoryOpen(true)}
          onPrefs={() => setPrefsOpen(true)}
          onSkin={() => setSkinOpen(true)}
          onProfile={() => setProfileOpen(true)}
          onJourney={() => setJourneyOpen(true)}
          onLogout={handleLogout}
          onLogin={() => openAuth("login")}
          onFeedback={() => setFeedbackOpen(true)}
          onFaq={() => { window.location.href = '/faq'; }}
          onInstall={() => setInstallOpen(true)}
        />
                <FeedbackButton />
                <button
                  onClick={() => setInlinePrefsOpen(!inlinePrefsOpen)}
                  aria-label={t('profilePrefs')}
                  title={t('profilePrefs')}
                  className={"p-1.5 rounded-lg transition-colors " + (inlinePrefsOpen ? 'text-primary-text bg-primary-lighter' : 'text-ink-soft hover:text-primary-text hover:bg-primary-lighter')}
                >
                  <SlidersHorizontal className="w-5 h-5" />
                </button>
                <button
                  onClick={() => setHistoryOpen(true)}
                  aria-label={t('myRecords')}
                  title={t('myRecords')}
                  className="p-1.5 rounded-lg text-ink-soft hover:text-primary-text hover:bg-primary-lighter transition-colors"
                >
                  <History className="w-5 h-5" />
                </button>
                <div className="hidden md:block text-sm text-ink-soft">
                  {t('step')} {currentStepNumber} / 5
                </div>
              </div>
              {/* 不可见 canary：量取完整右栏自然宽度（含反馈/偏好/历史/步骤，非交互占位） */}
              <div
                ref={structNavOverflow.canaryRef}
                aria-hidden="true"
                className="absolute left-0 top-full -z-10 flex items-center space-x-2 sm:space-x-3 whitespace-nowrap opacity-0 pointer-events-none"
              >
                {userArea}
                <span className="w-9 h-9 flex items-center justify-center"><MessageSquareHeart className="w-5 h-5" /></span>
                <span className="w-9 h-9 flex items-center justify-center"><SlidersHorizontal className="w-5 h-5" /></span>
                <span className="w-9 h-9 flex items-center justify-center"><History className="w-5 h-5" /></span>
                <span className="text-sm text-ink-soft">3 / 5</span>
              </div>
            </div>
          </div>
        </div>

        <PageTourBanner page="structure" />
        {/* 偏好面板：理一理窗口内直接修改偏好 */}
        {inlinePrefsOpen && (
          <div className="bg-white border-b border-gray-100">
            <div className="container mx-auto px-3 sm:px-4 py-3">
              <div className="bg-clay-bg border border-clay-border rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 border-b border-clay-border">
                  <div className="flex items-center gap-0.5">
                    <span className="text-sm font-semibold text-ink">{t('profilePrefs')}</span>
                    <PreferenceInfo />
                  </div>
                  <button onClick={() => setInlinePrefsOpen(false)} className="text-xs font-medium text-primary-text px-2.5 py-1 rounded-lg hover:bg-primary-lighter">
                    {t('prefsDone')}
                  </button>
                </div>
                <div className="p-3">
                  <PreferencePanel variant="global" onFeedback={() => setFeedbackOpen(true)} onRequestMembership={() => setMembershipOpen(true)} />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 步骤进度条（手机上横向滚动） */}
        <div className="bg-white border-b border-gray-100">
          <div className="container mx-auto px-3 sm:px-4 py-3">
            <div className="flex items-center space-x-3 sm:space-x-4 overflow-x-auto pb-1">
              {[
                { step: 1, label: t('step1') },
                { step: 2, label: t('step2') },
                { step: 3, label: t('step3') },
                { step: 4, label: t('step4') },
                { step: 5, label: t('step5') },
              ].map(({ step, label }) => {
                const reached = currentStepNumber >= step;
                const isCurrent = currentStepNumber === step;
                const inner = (
                  <>
                    <div className={`w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-xs sm:text-sm font-medium ${
                      reached ? 'bg-primary-strong text-white' : 'bg-clay-muted text-ink-soft'
                    }`}>
                      {isCurrent ? <ArrowLeft className="w-3.5 h-3.5" /> : step}
                    </div>
                    <span className={`ml-1.5 sm:ml-2 text-xs sm:text-sm whitespace-nowrap ${
                      reached ? 'text-primary font-medium' : 'text-ink-soft'
                    }`}>
                      {label}
                    </span>
                  </>
                );
                return (
                  <div key={step} className="flex items-center flex-shrink-0">
                    {reached ? (
                      <button
                        onClick={() => handleJumpStep(step)}
                        title={t('prevStep')}
                        aria-label={t('prevStep')}
                        className="flex items-center focus:outline-none"
                      >
                        {inner}
                      </button>
                    ) : (
                      <div className="flex items-center">{inner}</div>
                    )}
                    {step < 5 && (
                      <div className={`w-5 sm:w-8 h-0.5 mx-2 sm:mx-4 ${
                        currentStepNumber > step ? 'bg-primary' : 'bg-clay-muted'
                      }`} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* 主要内容区域 */}
         <div className="container mx-auto px-4 py-8">
           <EntryRegionNudge />
           {currentStep === 'input' && <EmotionInput />}
           {currentStep === 'analysis' && <Suspense fallback={<StepLoading />}><AnalysisResult /></Suspense>}
           {currentStep === 'questions' && <Suspense fallback={<StepLoading />}><QuestionInteraction /></Suspense>}
           {currentStep === 'detailed' && <Suspense fallback={<StepLoading />}><DetailedAnalysis /></Suspense>}
           {currentStep === 'story' && <Suspense fallback={<StepLoading />}><HealingStory /></Suspense>}
         </div>
      </div>
      {modals}
      </>
    );
  }

  // 默认显示首页
  return (
    <>
    {/* 付费弹窗开着时（含 Stripe 取消返回后自动重开）不让引导气泡浮在上面：用户在办事，别插话 */}
    {homeCoachOpen && !payOpen && !authOpen && !uiTourFullOpen && (!!authUser || !!getToken() || homeRegProceeded) && (
      <FeatureCoachmarks steps={homeCoachSteps} onDone={finishHomeCoach} />
    )}
    <div className="min-h-screen bg-brand">
      {/* 跳转到主内容：键盘/读屏用户第一个 Tab 就能跳过顶栏与各种横幅（better-accessibility「Structure is navigation」） */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[80] focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-ink focus:shadow-lg"
      >
        {t('skipToContent')}
      </a>
      {/* 底部推广浮层（2026-09-21 F4/F7 修复）：
          ① 同屏最多一条（优先级：今日打卡 > 安装/保存），不再两条竖着叠在一起互相压；
          ② 桌面视口收成右下角窄卡（宽度由各 banner 的 `sm:w-[22rem]` 控制），不再通栏压在 hero 正文上；
          ③ bottom 按隐私同意横幅的实际高度（store `privacyBannerH`）抬升 ⇒ 谁也压不住隐私横幅（合规提示必须可见）。
          未同意的新访客：横幅实测高度就绪前 privacyBannerH=0，此时等同原来的 bottom-4（16px）。 */}
      {(bottomPromo.showInstallBanner || bottomPromo.showMoodBanner) && (
        <div
          className="fixed inset-x-0 z-40 px-4 flex flex-col items-center sm:items-end gap-2 pointer-events-none"
          style={{ bottom: privacyBannerH + 16 }}
        >
          {bottomPromo.showInstallBanner && <InstallAppBanner mode={install.mode} promptInstall={install.promptInstall} dismiss={() => setToastDismissed(true)} onOpenProactivePush={openProactivePushPrefs} />}
          {bottomPromo.showMoodBanner && (
            <MoodRewardBanner
              onCheckin={() => { setMoodOpen(true); dismissMoodBanner(); }}
              onDismiss={dismissMoodBanner}
            />
          )}
        </div>
      )}
      {stripeSuccess && (
        <div className="bg-primary-strong text-white">
          <div className="container mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
            <p className="text-[13px] sm:text-sm font-medium">{t('stripeSuccessMsg')}</p>
            <button onClick={() => setStripeSuccess(false)} className="text-white/70 hover:text-white text-lg leading-none">✕</button>
          </div>
        </div>
      )}
      {rewardNotice != null && (
        <div className="bg-amber-500 text-white">
          <div className="container mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
            <div className="min-w-0 flex items-center gap-2">
              {rewardNotice.note ? <Mail className="w-4 h-4 shrink-0" aria-hidden /> : <Gift className="w-4 h-4 shrink-0" aria-hidden />}
              <div className="min-w-0">
                <p className="text-[13px] sm:text-sm font-semibold">
                  {rewardNotice.note ? t('rewardNoticeWithNote') : t('rewardNotice', { n: rewardNotice.count })}
                </p>
                {/* 回复摘要：**字符级截断**，不用 line-clamp（Chrome 153 实测会露出下一行字头，见 ChatPage 同款注释）；
                    全文在「小愈信箱」里，点「查看」直达 */}
                {rewardNotice.note && (
                  <p className="text-[12px] text-white/90 leading-snug mt-0.5">
                    {rewardNotice.note.length > 56 ? rewardNotice.note.slice(0, 56) + '…' : rewardNotice.note}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {rewardNotice.note && (
                <button
                  onClick={() => { ackReward().finally(() => setRewardNotice(null)); setInboxOpen(true); }}
                  className="text-[12px] font-semibold bg-white/20 hover:bg-white/30 rounded-full px-3 py-1 transition-colors"
                >
                  {t('inboxOpenLetter')}
                </button>
              )}
              <button
                onClick={() => { ackReward().finally(() => setRewardNotice(null)); }}
                aria-label={t('authClose')}
                className="text-white/80 hover:text-white text-lg leading-none p-1 -m-1"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      )}
      {announcementBanner}
      {renewalBanner}
      {/* 顶部用户区（置顶固定）
          ⚠️ 2026-09-15 用户要求：「主页的顶栏不应该有透明」→ 由 `bg-white/85 backdrop-blur`
          （85% 白 + 毛玻璃）改为**不透明** `bg-white`，并去掉 backdrop-blur（底不透了，毛玻璃也照不到东西，
          留着只是白耗 GPU）。实测那条 15% 的透明会让**皮肤氛围背景图**从顶栏底下透出来，观感就是"顶栏是花的/半透的"。
          注：本页顶部另一条（「开始/引导」分步视图的顶栏）本来就是 `bg-white`，不透明，两处现在一致。 */}
      <div className="sticky top-0 z-50 bg-white border-b border-gray-100">
        <div className="container mx-auto px-3 sm:px-4 py-3 flex items-center justify-between gap-2">
          {/* 会员徽章：登录后显示对应档位的会员图（点击打开会员中心） */}
          {authUser && (userPlan === 'pro' ? meta.planPro : userPlan === 'plus' ? meta.planPlus : meta.planFree) ? (
            <button
              onClick={() => setMembershipOpen(true)}
              title={userPlan === 'pro' ? t('memBadgePro') : userPlan === 'plus' ? t('memBadgePlus') : t('membershipTitle')}
              aria-label={t('membershipTitle')}
              className="w-9 h-9 rounded-full overflow-hidden bg-white border border-amber-200/70 shadow-sm transition-transform hover:scale-105"
            >
              <img
                src={userPlan === 'pro' ? meta.planPro : userPlan === 'plus' ? meta.planPlus : meta.planFree}
                alt={t('appName')}
                loading="lazy"
                className="w-full h-full object-cover"
              />
            </button>
          ) : authUser ? (
            <button
              onClick={() => setMembershipOpen(true)}
              title={userPlan === 'pro' ? t('memBadgePro') : userPlan === 'plus' ? t('memBadgePlus') : t('membershipTitle')}
              aria-label={t('membershipTitle')}
              className="w-9 h-9 rounded-full bg-amber-400 flex items-center justify-center border border-amber-300 shadow-sm transition-transform hover:scale-105"
            >
              <Crown className="w-4 h-4 text-white" />
            </button>
          ) : null}
          <div className="flex items-center gap-1.5 sm:gap-3 min-w-0 ml-auto">
            {/* 语言/字体：单图标（低频，点开下拉选语言，并随当前界面语言联动选择字体） */}
            <div ref={homeLangRef} className="flex items-center">
              <LangSwitch variant="icon" onChange={() => setLangTick(t => t + 1)} />
            </div>
            {/* 了解小愈 */}
            <button
              onClick={() => setAboutOpen(true)}
              aria-label={t('aboutTitle')}
              className="w-8 h-8 rounded-full flex items-center justify-center text-ink-soft hover:text-primary hover:bg-primary-lighter transition-all tap-y"
            >
              <Info className="w-5 h-5" />
            </button>
            {/* 心情打卡（常驻） */}
            <button
              ref={homeMoodBtnRef}
              onClick={() => setMoodOpen(true)}
              title={t('profileMoodModule')}
              aria-label={t('profileMoodModule')}
              className="relative w-8 h-8 rounded-full flex items-center justify-center text-primary hover:text-primary-text hover:bg-primary-lighter transition-all tap-y"
            >
              <CalendarDays className="w-5 h-5" />
              {moodEligible && (
                <span
                  className="absolute -top-1 -right-1 flex items-center gap-0.5 bg-amber-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full leading-none shadow-sm animate-pulse"
                  aria-label={t('moodEligibleBadge')}
                  title={t('moodEligibleBadge')}
                >
                  🎁 +5
                </span>
              )}
            </button>
            {/* 我的（常驻） */}
            <button
              onClick={() => setProfileOpen(true)}
              title={t('myProfile')}
              aria-label={t('myProfile')}
              className="w-8 h-8 rounded-full flex items-center justify-center text-gray-600 hover:text-gray-800 hover:bg-gray-100 transition-all tap-y"
            >
              <UserIcon className="w-5 h-5" />
            </button>
            {/* 设置/外观组：个性化偏好 + 皮肤（从「…」拿出来，用分隔线分层） */}
            <span className="w-px h-5 bg-clay-border mx-1 flex-shrink-0" />
            {/* 设置/外观组：个性化偏好 + 皮肤（coach-mark 以一个「洞」同时圈住这两个按钮） */}
            <div ref={homeSettingsGroupRef} className="flex items-center gap-1.5 sm:gap-3">
              <button
                onClick={() => setPrefsOpen(true)}
                title={t('profilePrefs')}
                aria-label={t('profilePrefs')}
                className="w-8 h-8 rounded-full flex items-center justify-center text-ink-soft hover:text-primary hover:bg-primary-lighter transition-all tap-y"
              >
                <Settings2 className="w-5 h-5" />
              </button>
              <button
                onClick={() => setSkinOpen(true)}
                title={t('skinAppearance')}
                aria-label={t('skinAppearance')}
                className="w-8 h-8 rounded-full flex items-center justify-center text-ink-soft hover:text-primary hover:bg-primary-lighter transition-all tap-y"
              >
                <Palette className="w-5 h-5" />
              </button>
            </div>
            {/* 登录/注册：游客常驻（移动端不再藏进「…」） */}
            {!authUser && (
              <button
                onClick={() => openAuth('login')}
                className="text-xs sm:text-sm text-primary-text hover:text-primary font-medium transition-colors whitespace-nowrap"
              >
                {t('login')}
              </button>
            )}
            {/* 「…」：低频项 与你的旅程 / 安装 / 意见反馈 / FAQ / 退出（个性化偏好与界面外观已提为顶栏常驻；
                「我的记录」已归入理一理 → 主页 ⋯ 不传 onHistory，因此不渲染该项（理一理顶栏 🕘 / 理一理 ⋯ 才有）） */}
            <MoreMenu
              show
              minimal
              menuBtnRef={homeMoreBtnRef}
              authUser={!!authUser}
              displayName={displayName}
              plan={userPlan}
              onMood={() => setMoodOpen(true)}
              onPrefs={() => setPrefsOpen(true)}
              onSkin={() => setSkinOpen(true)}
              onProfile={() => setProfileOpen(true)}
              onJourney={() => setJourneyOpen(true)}
              onFeedback={() => setFeedbackOpen(true)}
              onFaq={() => { window.location.href = '/faq'; }}
              onInstall={() => setInstallOpen(true)}
              onLogout={handleLogout}
              onLogin={() => openAuth("login")}
            />
          </div>
        </div>
      </div>

      {/* 新用户导览提示条（非阻塞，可关闭；完整导览点「查看导览」再开） */}
      {uiTourOpen && (
        <UiTourBar
          onDismiss={() => { markUiTourSeen(); setUiTourOpen(false); }}
          onView={() => { setUiTourOpen(false); setUiTourFullOpen(true); }}
        />
      )}

      {/* Hero Section（手机紧凑：首屏尽快露出三入口） */}
      <div id="main-content" role="main" tabIndex={-1} className="container mx-auto px-4 pt-6 sm:pt-16 pb-6 sm:pb-8">
        <div className="text-center">
          {/* 电影感 Hero 背景：仅非默认皮肤时展示；中心径向落地 + 底部渐隐，保证文字可读 */}
          <div className="relative overflow-hidden rounded-[1.6rem] sm:rounded-[3rem] shadow-lift">
            {meta.hero && (
              <div aria-hidden className="absolute inset-0">
                <img src={meta.hero} alt="" loading="eager" fetchPriority="high" className={`w-full h-full object-cover ${skin === 'zen' ? 'object-[50%_84%]' : 'object-[50%_72%]'}`} />
                <div className="absolute inset-0 bg-[radial-gradient(72%_62%_at_50%_46%,var(--color-bg),transparent_74%)]" />
                <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-[var(--color-bg)] to-transparent" />
              </div>
            )}
            <div className="relative px-3 py-6 sm:py-12 sm:px-8">
              <div className="flex justify-center mb-3 sm:mb-6">
                {meta.heart ? (
                  <div className="w-16 h-16 sm:w-24 sm:h-24 rounded-2xl sm:rounded-3xl overflow-hidden bg-white shadow-lift ring-4 ring-white/50">
                    <img src={meta.heart} alt={t('appName')} className="w-full h-full object-cover" loading="eager" />
                  </div>
                ) : (
                  <div className="w-14 h-14 sm:w-20 sm:h-20 bg-primary rounded-full flex items-center justify-center shadow-lift">
                    <Heart className="w-7 h-7 sm:w-10 sm:h-10 text-white" />
                  </div>
                )}
              </div>
              <h1 className="font-display text-[1.4rem] sm:text-4xl md:text-[2.9rem] font-bold leading-[1.2] sm:leading-[1.18] tracking-tight text-ink mb-2 sm:mb-4 max-w-2xl mx-auto">{t('heroTitle')}</h1>
              <p className="text-sm sm:text-lg text-primary-text font-medium max-w-xl mx-auto px-2 mb-3 sm:mb-5">{t('heroSub')}</p>
              <div className="hidden sm:flex items-center justify-center gap-2.5 mb-4">
                <span className="w-10 h-px bg-clay-border" />
                <Heart className="w-3.5 h-3.5 text-primary" />
                <span className="w-10 h-px bg-clay-border" />
              </div>
              <p className="hidden sm:block text-sm sm:text-base text-ink-soft leading-relaxed max-w-xl mx-auto px-4">{t('heroSub2')}</p>
            </div>
          </div>
        </div>

        {/* 会员状态条：会员=金色尊贵感，免费=绿色引导感（所有人可见） */}
        <div className="max-w-4xl mx-auto px-4 mt-6">
          {userPlan !== 'free' ? (
            <div className="rounded-2xl bg-gradient-to-r from-[var(--color-accent)] to-[var(--color-primary)] text-white p-3.5 shadow-lg flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className={"w-9 h-9 rounded-xl overflow-hidden flex items-center justify-center flex-shrink-0 ring-4 ring-white/50 shadow-lift " + (userPlan === 'pro' ? 'bg-amber-50 text-amber-700' : 'bg-primary-lighter text-primary')}>
                  <SkinPlanIcon plan={userPlan} className="w-full h-full" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-bold leading-tight flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
                    {userPlan === 'pro' ? t('memBadgePro') : t('memBadgePlus')}
                    <span className="text-[10px] font-medium bg-white/20 rounded-full px-2 py-0.5 whitespace-nowrap">{t('memStatusActive')}</span>
                  </p>
                  {memberDaysLeft != null && (
                    <p className="text-[11px] text-white/80 mt-0.5">{t('memStatusDaysLeft', { n: memberDaysLeft })}</p>
                  )}
                </div>
              </div>
              <button
                onClick={() => setMembershipOpen(true)}
                className="flex-shrink-0 whitespace-nowrap bg-white text-[var(--color-accent)] text-xs font-bold px-3.5 py-2 rounded-full hover:bg-[var(--color-accent-soft)] transition-all"
              >
                {userPlan === 'pro' ? t('memRenewBtn') : t('memUpgradeBtn')}
              </button>
            </div>
          ) : (
            <div className="rounded-2xl bg-gradient-to-r from-primary-strong to-primary text-white p-3.5 shadow-lg shadow-primary/20 flex items-center justify-between gap-3">
              {(!authUser && !getToken()) ? (
                <>
                  {/* 游客：引导注册领取奖励额度（注册优先于充值） */}
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="w-9 h-9 rounded-xl overflow-hidden flex items-center justify-center flex-shrink-0 ring-4 ring-white/50 shadow-lift bg-amber-50 text-amber-700">
                      <Gift className="w-5 h-5" />
                    </span>
                    <div className="min-w-0">
                      {/* ⚠️ 2026-09-25（用户口径「游客界面显示免费 20 额度、注册再送 0 额度，明显不对」）：
                          注册奖励（REGISTER_CHAT_BONUS）是限时活动，活动期外后端返回 registerChatBonus=0。
                          这里原来无条件套 remainingCreditReg（「…注册账户可再得 {b} 条」），活动一结束就印出
                          「可再得 0 条」；`?? 20` 兜底还会在额度没回来之前先闪一个假的 20。
                          现在：只有真有奖励才提奖励；没有就只说剩余；额度没回来时不报数字。 */}
                      <p className="text-sm font-bold leading-tight">{!quota
                        ? t('memFreeHint')
                        : quota.creditEnabled
                          // 统一口径（一个池）：口径是「条」，且数值取信用额度换算后的剩余。
                          // 2026-09-27 分档：游客条必须同时给出「游客 N 条 / 注册后 M 条」两档数字
                          // （单一实现在 lib/quotaTiers.ts，与聊一聊顶栏、理一理输入区逐字一致）
                          ? (quota.registerProPromoActive && (quota.registerProDays ?? 0) > 0
                            ? t('remainingCreditRegPro', { n: quotaChatRemain(quota), days: quota.registerProDays ?? 0 })
                            : (guestQuotaLineText(t, quota, payCfg, quotaChatRemain(quota))
                              ?? t('remainingCreditNoBonus', { n: quotaChatRemain(quota) })))
                          : (quota.registerProPromoActive && (quota.registerProDays ?? 0) > 0
                            ? t('remainingRegPro', { n: quota.remainFree ?? 0, days: quota.registerProDays ?? 0 })
                            : (quota.registerChatBonus ?? 0) > 0
                              ? t('remainingReg', { n: quota.remainFree ?? 0, b: quota.registerChatBonus ?? 0 })
                              : t('remainingNoBonus', { n: quota.remainFree ?? 0 }))}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => openAuth('register')}
                    className="flex-shrink-0 bg-white text-primary-text text-xs font-bold px-3.5 py-2 rounded-full hover:bg-primary-lighter transition-all"
                  >
                    {t('memRegBtn')}
                  </button>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="w-9 h-9 rounded-xl overflow-hidden flex items-center justify-center flex-shrink-0 ring-4 ring-white/50 shadow-lift bg-gray-50 text-ink-soft">
                      <SkinPlanIcon plan="free" className="w-full h-full" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-bold leading-tight">{t('memFreeHint')}</p>
                      {/* 统一口径下「剩余」的单位是**条**（不是理一理池的「次」），注册免费档就是每天 20 条 */}
                      <p className="text-[11px] text-white/80 mt-0.5">{quota?.creditEnabled
                        ? (quotaIsUnlimited(quota) ? t('chatQuotaPro') : t('chatQuotaCredit', { n: quotaChatRemain(quota) }))
                        : t('memFreeLeft', { n: quota?.remainFree ?? 0 })}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setMembershipOpen(true)}
                    className="flex-shrink-0 bg-white text-primary-text text-xs font-bold px-3.5 py-2 rounded-full hover:bg-primary-lighter transition-all"
                  >
                    {t('memUnlockBtn')}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* 主入口：聊一聊 / 角色扮演。软合并后「理一理」降为次级入口（聊一聊内可「帮我理一理」） */}
        <div className="grid grid-cols-2 gap-2 sm:gap-4 mt-8 max-w-4xl mx-auto px-4">
          <button
            ref={homeChatBtnRef}
            onPointerDown={warmChatChunk}
            onClick={handleStartChat}
            className="group text-center sm:text-left card-white rounded-xl sm:rounded-2xl px-2 py-3 sm:p-5 shadow-lg border-2 border-clay-border hover:border-primary hover:shadow-xl transition-all duration-200"
          >
            {(meta.chatSm || meta.chat) ? (
              <span className={`inline-flex w-10 h-10 sm:w-14 sm:h-14 ${entryImgShape} overflow-hidden items-center justify-center mx-auto mb-1.5 sm:mr-0 sm:mb-2 sm:inline-flex border border-clay-border shadow-sm bg-clay-bg`}>
                <img src={meta.chatSm || meta.chat} alt="" loading="lazy" className="w-full h-full object-cover" />
              </span>
            ) : (
              <span className="inline-flex w-9 h-9 sm:w-11 sm:h-11 rounded-full bg-primary-soft text-primary items-center justify-center mx-auto mb-1.5 sm:mr-0 sm:mb-2 sm:inline-flex">
                <MessageCircleHeart className="w-5 h-5 sm:w-6 sm:h-6" />
              </span>
            )}
            <span className="block text-[13px] sm:text-xl font-bold text-gray-800 leading-tight">{t('entryChatTitle')}</span>
            {/* 手机显示极短说明，桌面显示完整描述 */}
            <span className="block sm:hidden text-[10px] text-gray-700 leading-tight mt-0.5">{t('entryChatShort')}</span>
            <span className="hidden sm:block text-[13px] sm:text-sm text-ink-soft leading-relaxed mt-2">{t('entryChatDesc')}</span>
          </button>
          <button
            ref={homeRoleplayBtnRef}
            onClick={() => setRoleplayOpen(true)}
            className="group text-center sm:text-left card-white rounded-xl sm:rounded-2xl px-2 py-3 sm:p-5 shadow-lg border-2 border-clay-border hover:border-primary hover:shadow-xl transition-all duration-200"
          >
            {(meta.storySm || meta.story) ? (
              <span className={`inline-flex w-10 h-10 sm:w-14 sm:h-14 ${entryImgShape} overflow-hidden items-center justify-center mx-auto mb-1.5 sm:mr-0 sm:mb-2 sm:inline-flex border border-clay-border shadow-sm bg-clay-bg`}>
                <img src={meta.storySm || meta.story} alt="" loading="lazy" className="w-full h-full object-cover" />
              </span>
            ) : (
              <span className="inline-flex w-9 h-9 sm:w-11 sm:h-11 rounded-full bg-white/80 text-primary items-center justify-center mx-auto mb-1.5 sm:mr-0 sm:mb-2 sm:inline-flex">
                <Drama className="w-5 h-5 sm:w-6 sm:h-6" />
              </span>
            )}
            <span className="block text-[13px] sm:text-xl font-bold text-gray-800 leading-tight">{t('rpModuleTitle')}</span>
            {/* 手机显示极短说明，桌面显示完整描述 */}
            <span className="block sm:hidden text-[10px] text-gray-700 leading-tight mt-0.5">{t('roleplayShort')}</span>
            <span className="hidden sm:block text-[13px] sm:text-sm text-ink-soft leading-relaxed mt-2">{t('rpModuleSub')}</span>
          </button>
        </div>

        {/* 理一理：次级入口（软合并 C：聊一聊为唯一前门；这里保留深流程/我的记录/偏好入口） */}
        <div className="max-w-4xl mx-auto px-4 mt-4 flex justify-center">
          <button
            ref={homeSortBtnRef}
            onClick={handleStartJourney}
            className="group mx-auto flex items-center justify-center gap-2 text-sm text-primary-text rounded-full border border-clay-border bg-white/70 hover:bg-primary-lighter hover:border-primary hover:shadow-md transition-all px-5 py-2.5"
          >
            {(meta.structureSm || meta.structure) ? (
              <span className={`inline-flex w-6 h-6 ${entryImgShape} overflow-hidden items-center justify-center border border-clay-border shadow-sm bg-clay-bg flex-shrink-0 group-hover:scale-105 transition-transform`}>
                <img src={meta.structureSm || meta.structure} alt="" loading="lazy" className="w-full h-full object-cover" />
              </span>
            ) : (
              <span className="inline-flex w-6 h-6 rounded-full bg-accent-soft text-amber-700 items-center justify-center flex-shrink-0">
                <Compass className="w-4 h-4" />
              </span>
            )}
            <span className="leading-tight">{t('entryStructureLink')}</span>
          </button>
        </div>

        {/* 邀请好友：紧凑提示条（放在功能入口之后，不挤占「聊一聊/角色扮演/理一理」的位置、手机更清爽；点开邀请弹窗） */}
        <div className="max-w-4xl mx-auto px-4 mt-5">
          <button
            onClick={() => setInviteOpen(true)}
            className="w-full flex items-center justify-between gap-3 rounded-xl bg-amber-50/70 border border-amber-200/70 px-3.5 py-2.5 hover:bg-amber-50 hover:border-amber-300 transition-all text-left"
          >
            <span className="flex items-center gap-2 min-w-0">
              <Gift className="w-4 h-4 text-amber-700 flex-shrink-0" />
              <span className="text-[12px] text-amber-800 leading-snug truncate">
                {(!!authUser || !!getToken())
                  ? t('homeInviteCardTitle', { n: payCfg?.bonuses?.invite ?? 50 })
                  : t('homeInviteCardTitleGuest', { n: payCfg?.bonuses?.invite ?? 50 })}
              </span>
            </span>
            <span className="flex-shrink-0 flex items-center gap-1.5">
              {/* 战果前置到首屏：有人**计入**才显示数字（0 时不占位，避免噪音）。
                  口径与「我的」摘要里的「已邀请」一致（都用 rewardedCount = 真发奖励的人数），
                  不然两处同一个词会给出两个数（注册了但没开口的不算「已邀请」）。 */}
              {inviteStats && inviteStats.rewardedCount > 0 && (
                <span className="text-[11px] font-semibold text-primary-text bg-primary-soft rounded-full px-2 py-[3px] tabular-nums">
                  {t('homeInviteBadge', { n: inviteStats.rewardedCount })}
                </span>
              )}
              <span className="text-[12px] font-bold text-amber-800 bg-white/70 rounded-full px-2.5 py-1">
                {(!!authUser || !!getToken()) ? t('homeInviteCardBtn') : t('homeInviteCardBtnGuest')}
              </span>
            </span>
          </button>
        </div>

        {/* 会员权益区块 */}
        <div className="mt-16 card-white rounded-2xl p-5 sm:p-7 shadow-lg border border-clay-border">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mb-5">
            <div className="text-center sm:text-left">
              <h2 className="text-xl sm:text-2xl font-semibold text-gray-800">{userPlan !== 'free' ? t('memHomeCenter') : t('membershipTitle')}</h2>
              <p className="text-sm text-ink-soft mt-1">{t('membershipSub')}</p>
            </div>
            <button
              onClick={() => setMembershipOpen(true)}
              className="text-sm text-primary-text border border-clay-border rounded-full px-4 py-2 hover:bg-primary-lighter transition-all flex-shrink-0"
            >
              {t('membershipSeeAll')}
            </button>
          </div>
          {/* 手机上三列紧凑，桌面三列完整大卡 */}
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {(() => {
              const plans = payCfg?.pricing?.plans;
              const launch = payCfg?.launchOffer;
              const pct = payCfg?.discountPct ?? 50;
              // 价格一律用**本币结算币种**（港澳 HKD / 内地 CNY / 其他 USD），与付费弹窗/会员弹窗同一口径
              const money3 = (usd?: number, hkd?: number, cny?: number) => mainPrice(payCfg, usd, hkd, cny);
              const orig = (p?: { originalUsd?: number; originalHkd?: number; originalCny?: number }) =>
                launch && p?.originalUsd != null && p.originalUsd > 0
                  ? money3(p.originalUsd, p.originalHkd, p.originalCny)
                  : '';
              return [
                { key: 'free', name: t('mFreeName'), tag: t('memTagFree'), price: t('mFreePrice'), orig: '', border: 'border-gray-200' },
                { key: 'plus', name: t('mPlusName'), tag: t('memTagPlus'), price: money3(plans?.plus?.usd, plans?.plus?.hkd, plans?.plus?.cny) || t('mPlusPrice'), orig: orig(plans?.plus), border: 'border-primary bg-primary-lighter', badge: '⭐ ' + t('membershipRecommended') },
                { key: 'pro', name: t('mProName'), tag: t('memTagPro'), price: money3(plans?.pro?.usd, plans?.pro?.hkd, plans?.pro?.cny) || t('mProPrice'), orig: orig(plans?.pro), border: 'border-amber-200 bg-amber-50/40' },
              ].map(c => {
                return (
                <button
                  key={c.name}
                  onClick={() => setMembershipOpen(true)}
                  className={"relative rounded-xl border-2 px-2 py-3 sm:px-4 sm:py-3.5 hover:shadow-soft transition-all text-center sm:text-left " + c.border}
                >
                  {c.badge && (
                    <span className="absolute -top-2 left-1/2 sm:left-3 -translate-x-1/2 sm:translate-x-0 text-[11px] font-medium text-white bg-primary rounded-full px-2 py-0.5 whitespace-nowrap">
                      {c.badge}
                    </span>
                  )}
                  <p className="text-sm sm:text-base font-bold text-gray-800 flex items-center justify-center sm:justify-start gap-1.5">
                    <span className={"w-10 h-10 sm:w-12 sm:h-12 rounded-xl overflow-hidden flex items-center justify-center flex-shrink-0 " + (c.key === 'pro' ? 'bg-amber-50 text-ink-soft' : c.key === 'plus' ? 'bg-primary-lighter text-primary' : 'bg-gray-50 text-ink-soft')}>
                      <SkinPlanIcon plan={c.key as 'free' | 'plus' | 'pro'} className="w-full h-full" />
                    </span>
                    {c.name}
                  </p>
                  <p className="hidden sm:block text-[11px] text-ink-soft font-medium mt-0.5">{c.tag}</p>
                  {c.key !== 'free' && (
                    <div className="flex items-baseline justify-center sm:justify-start gap-1 mt-1 flex-wrap">
                      <span className="text-sm font-bold text-primary-text">{c.price}</span>
                      <span className="text-[11px] text-ink-soft">{t('memPerMonth')}</span>
                    </div>
                  )}
                  {c.orig && (
                    <p className="hidden sm:block mt-0.5"><StrikePrice>{c.orig}</StrikePrice></p>
                  )}
                  {/* 折扣标注（2026-09-29）：与付费弹窗/会员卡同一组件；手机三列格子窄，故不带图标、用 sm 号，
                      但仍然是填充色块（旧写法是 10px 琥珀小胶囊文字，实测对比度不达标）。
                      期限一行（OfferDeadline）在手机三列里放不下（实测 390px 会撑出 4px 横向溢出），
                      与划线原价同样处理：**只在 ≥sm 显示**；手机上「限时特惠 -50%」徽章仍在。 */}
                  {launch && c.orig && (
                    <span className="mt-1 inline-flex flex-col items-center sm:items-start gap-0.5">
                      <DiscountBadge tone="offer" size="sm" icon={false}>{t('membershipLaunchOffer', { pct })}</DiscountBadge>
                      <OfferDeadline until={payCfg?.offerEndsAt} size="sm" className="hidden sm:inline-flex" />
                    </span>
                  )}
                </button>
                );
              });
            })()}
          </div>
        </div>


        {/* 场景区块：点一句最像你的处境，直接进「怎么开始」（聊一聊 / 理一聊 / 剧情）
            ⚠️ 2026-09-23：原来每张卡挂一个「推荐「接住我」」的陪伴方式标签、点开还要先选档位；
               档位退场后标签一并去掉。卡上的插画沿用皮肤里的陪伴插画素材，**仅作配图**，不再代表档位。 */}
        <div id="scenarios" className="mt-12 scroll-mt-6">
          <h2 className="text-lg sm:text-xl font-semibold text-gray-800 mb-3 text-center">
            {t('scenarioTitle')}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {[
              { text: t('scenario1'), art: 'hug' as const },
              { text: t('scenario2'), art: 'ally' as const },
              { text: t('scenario3'), art: 'clarify' as const },
              { text: t('scenario4'), art: 'light' as const },
              { text: t('scenario5'), art: 'hug' as const },
            ].map((s, i) => (
              <button
                key={i}
                onClick={() => setStartOpen(true)}
                className="flex items-center gap-2 card-white rounded-lg px-3 py-2 border border-gray-100 text-left hover:border-primary hover:shadow-sm transition-all"
              >
                <SkinModeIcon mode={s.art} className="w-10 h-10 sm:w-11 sm:h-11 flex-shrink-0 text-primary" />
                <span className="flex-1 min-w-0 text-[13px] text-gray-600 leading-snug">{s.text}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 结尾 CTA */}
        <div className="mt-16 text-center rounded-2xl bg-gradient-to-br from-primary to-primary-strong p-8 sm:p-12 text-white shadow-lift relative overflow-hidden">
          <div className="absolute -top-10 -right-10 w-40 h-40 rounded-full bg-white/10" />
          <div className="absolute -bottom-12 -left-8 w-44 h-44 rounded-full bg-white/5" />
          <h2 className="text-2xl sm:text-3xl font-bold mb-3 leading-snug">{t('ctaEndTitle')}</h2>
          <p className="text-white/90 mb-7 leading-relaxed">{t('ctaEndSub')}</p>
          <button
            onClick={() => setStartOpen(true)}
            className="bg-white text-primary-text py-3 px-10 rounded-full text-lg font-semibold hover:bg-primary-lighter shadow-lg transition-all duration-200"
          >
            {t('ctaEndBtn')}
          </button>
        </div>


        {/* 意见反馈：显眼入口，鼓励用户反馈 */}
        <div className="mt-16 rounded-2xl card-white border-2 border-clay-border p-6 sm:p-8 flex flex-col sm:flex-row items-center justify-between gap-4 shadow-lg">
          <div className="flex items-center gap-4">
            <span className="w-12 h-12 rounded-xl overflow-hidden bg-primary-soft text-primary flex items-center justify-center flex-shrink-0">
              <SkinFeedbackIcon className="w-full h-full" />
            </span>
            <div>
              <h3 className="text-lg font-bold text-gray-800">{t('profileFeedback')}</h3>
              <p className="text-sm text-ink-soft mt-0.5 leading-relaxed">{t('profileFeedbackSent')}</p>
            </div>
          </div>
          <button
            onClick={() => setFeedbackOpen(true)}
            className="flex-shrink-0 bg-primary-strong text-white px-6 py-2.5 rounded-full text-sm font-semibold hover:bg-primary transition-all"
          >
            {t('profileSendFeedback')}
          </button>
        </div>

        {/* 页脚 */}
        <div className="text-center mt-10 pb-4 space-y-2">
          <p className="text-sm text-ink-soft font-medium">{t('brandLine')}</p>
          <p className="text-xs text-ink-soft">{t('heroSub')}</p>
          <p className="text-xs text-ink-soft italic">{t('brandFootEn')}</p>
          <p className="text-xs text-ink-soft">
            {t('poweredBy')}
          </p>
          <p className="text-xs text-ink-soft">{t('brandSince')}</p>
          <div className="mt-4 pt-3 border-t border-clay-border">
            <SocialFollow />
          </div>
          <button onClick={() => setPrivacyOpen(true)} className="text-xs text-ink-soft hover:text-gray-600 underline">
            {t('privacy')}
          </button>
          <span className="text-xs text-ink-soft">·</span>
          <button onClick={() => setMembershipOpen(true)} className="text-xs text-ink-soft hover:text-primary-text underline">
            {t('membershipTitle')}
          </button>
        </div>
      </div>
    </div>
    {modals}
    </>
  );
}