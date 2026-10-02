/**
 * 角色剧情扮演
 * 剧本列表 → 剧本详情（设定）→ 剧情对话（角色扮演 chat）
 * 移动端优先：全屏、气泡对话、开场 AI 消息自动注入
 */

import { useEffect, useMemo, useRef, useState, useCallback, lazy, Suspense, type TouchEvent as ReactTouchEvent } from 'react';
import { createPortal } from 'react-dom';
import { bottomAnchorPx } from '../lib/viewportAnchor';
import { ArrowLeft, ArrowDown, Send, Sparkles, RotateCcw, ChevronLeft, ChevronRight, User, Users, Heart, ScrollText, BookOpen, AlertTriangle, Coins, Info, Pencil, Trash2, Upload, Search, X, Share2, Star, LayoutGrid, ExternalLink, SlidersHorizontal, Music, Volume2, VolumeX, MoreHorizontal, Palette, Moon } from 'lucide-react';
import { getRoleplayScenarios, getRoleplayScenario, roleplayChatStream, roleplaySuggest, getQuota, getCachedPlan, getRoleplaySession, saveRoleplaySession, saveRoleplayPreference, deleteRoleplaySession, isLoggedIn, createCustomRoleplay, listCustomRoleplay, deleteCustomRoleplay, publishCustomRoleplay, updateCustomRoleplay, roleplayCustomDraft, roleplayCustomRevise, getFeaturedRoleplay, getCommunityRoleplay, searchRoleplayScenarios, getRoleplayTags, likeRoleplayScenario, savePreferences, getPreferences, setScenarioUnlimited, quotaChatRemain, quotaIsUnlimited, confirmAdult, importStoryCharacter, type RoleplayScenarioInfo, type RoleplayMessage, type CustomScenarioInfo, type CustomStatus, type AuthUser, type RoleplayTagData, type QuotaInfo, type UserPreferences, getSceneArt, generateSceneArt, reportAiFailure, roleplayModelConfig } from '../services/api';
import { getCachedPreferences, setCachedPreferences } from '../lib/prefsCache';
import { markLocalAdultConfirmed } from '../lib/adultGate';
import { stripFallbackBubbles } from '../lib/fallbackBubbles';
import { pickInitialMessages, sanitizeMessages, hasResumableSession, endsWithUnansweredTurn } from '../lib/rpInitialMessages';
import { createSerialSaveQueue } from '../lib/serialSave';
import { resolveRpBack, RP_STAGE_RANK, type RpOverlay, type RpStage } from '../lib/rpDeepBack';
import { pushDeepBackHandler } from '../lib/deepBack';
import { dropsSavedReply } from '../lib/rpWriteGuard';
import { lsGet, lsSet, lsRemove, lsGetJson } from '../lib/safeStorage';
import { shouldAutoRetry, failCodeOf, AUTO_RETRY_DELAY_MS, AUTO_RETRY_MAX } from '../lib/autoRetry';
import { canRegenerateAt, startRegenerate, finishRegenerate, switchVersionIn, toRequestMessages, versionsOf, versionIndex, activeContent, canEditAt, canSwitchUserBranchAt, startEditResend, switchUserBranchIn, commitUserBranch, lastUserIndex } from '../lib/rpVersions';
import { looksIncomplete, incompleteCode, type IncompleteReason } from '../lib/replyCompleteness';
import { hasThoughtMarker } from '../lib/roleplayText';
import { parseCastSegments, stripCastTags, hasCastSpeaker, type CastName } from '../lib/roleplayCast';
import { type RoleplayMode, parseRoleplayMode, DEFAULT_ROLEPLAY_MODE } from '../lib/roleplayMode';
import { detectStuck, detectOocMeta, recordBridgeEvent, isIdleEnough, canShowBridge, readBridgeBudget, markBridgeShown, markBridgeDismissed, bridgeEnabled, buildBridgeDraft, BRIDGE_MIN_TURNS, type BridgeSeed, type BridgeTrigger } from '../lib/rpBridge';
import RoleplayRichText from './RoleplayRichText';
import { t, getLang } from '../i18n';
import { useVisualViewport } from '../hooks/useVisualViewport';
import { useIosKeyboardLock } from '../hooks/useIosKeyboardLock';
import FeedbackButton from './FeedbackButton';
import { SkinFeedbackIcon } from './SkinIcon';
import AiFeedbackMark from './AiFeedbackMark';
import SendFailedNotice from './SendFailedNotice';
import CopyButton from './CopyButton';
import StoryShareModal, { type StoryBubble } from './StoryShareModal';
import TypingDots from './TypingDots';
import { useAppStore } from '../store/useAppStore';
import { setLastChatChar } from '../lib/lastChatChar';
import StoryBgmPanel from './StoryBgmPanel';
import { useScenarioBgm } from '../hooks/useScenarioBgm';
import { useStoryVoice } from '../hooks/useStoryVoice';
import { useStoryAmbience } from '../hooks/useStoryAmbience';
import VoiceMessage from './VoiceMessage';
import StorySceneBackdrop, { applySceneBoot, clearSceneBoot, sceneBootUrlFor } from './StorySceneBackdrop';
import StorySceneAtmosphere from './StorySceneAtmosphere';
import { defaultVoiceForScenario } from '../lib/storyVoice';
import { matchTheme, isKeyMomentTheme, DEFAULT_THEME } from '../lib/storyScene';
import FeatureCoachmarks, { type CoachStep } from './FeatureCoachmarks';
import ImageUploadCrop from './ImageUploadCrop';
import { wwT } from '../werewolf/i18n';
import Modal from './ui/Modal';
// AI 文游（千世书引擎 + 字体）体积大，且仅在点开「AI 文游」时才需要 → 懒加载独立分包，
// 让普通角色扮演用户不下载整套引擎，也减轻主页预载角色扮演 chunk 的负担
const WenyouPage = lazy(() => import('./WenyouPage'));
// AI 狼人杀同样是「一级模式」的独立分包：只在点开狼人杀时才加载
const WolfchaHost = lazy(() => import('./WolfchaHost'));

/** 服务端返回「免费额度用完」时，由统一门控接管（不再把付费墙文案当普通消息展示） */
function isQuotaExhaustedResp(r: { code?: string; status?: number } | null | undefined): boolean {
  return !!r && (r.code === 'CHAT_QUOTA_EXCEEDED' || r.code === 'QUOTA_EXCEEDED' || r.status === 402);
}

/**
 * 当前历史条目是「剧情模式第几层」，由压条目时写的 `state.xiaoyuRp` 读回（缺省 0 = 列表层）。
 * 用它判断「本层有没有自己的历史条目可退」，不需要自己记账（文游子树也会压条目，记账必漂移）。
 */
function rpEntryRank(): number {
  try {
    const st = window.history.state;
    return st && typeof st.xiaoyuRp === 'number' ? st.xiaoyuRp : 0;
  } catch {
    return 0;
  }
}

/**
 * SSE `{type:'meta'}` 下发的审计信息（本轮实际走了哪个 provider）。
 *
 * 为什么要单独抽类型：它要在**两处**活着，流式中途构造的气泡，以及定稿时那个新构造的对象
 * （`finish()` 不带它 → `viaUnlimited/model` 全丢，管理端统计偏低，2026-09-17 记录在案的缺陷）。
 */
type MetaInfo = { adult: boolean; model: string };

/**
 * assistant 消息上的「生成时元信息」：无限制模型 / 模型名 / **叙事模式**（2026-09-18）。
 *
 * 为什么收敛成一个函数：全组件有**三处**定稿点都会构造新的 assistant 对象
 * （流式中途的气泡、`finish()` 定稿、续写完成），每多一个字段就多一次「漏搬 → 静默丢失」的机会
 * `viaUnlimited/model` 已经在 2026-09-17 栽过一次（见上面 MetaInfo 的注释）。
 *
 * `style` 为什么必须落盘：叙事模式原先只存在浏览器 localStorage，服务端与数据里没有这个维度，
 * 「经典档和沉浸档的收尾习惯是不是不一样」在真实数据上无法回答。落盘后只读扫描脚本可按模式分档。
 */
function assistantMetaOf(meta: MetaInfo | null, style: 'classic' | 'immersive') {
  return {
    ...(meta ? { viaUnlimited: meta.adult, model: meta.model } : {}),
    style,
  };
}

// 【非 AI 原创来源的作者标注：作品归属链接（用圆形图标按钮承载，不直接显示链接文本）】
const SOURCE_AUTHOR_LINKS: { key: string; url: string }[] = [
  { key: '糖醋鱼饼', url: 'https://xhslink.cn/m/wjX0GG97K7' },
];
function sourceAuthorLink(src: string): { name: string; url: string } | null {
  if (!src) return null;
  for (const a of SOURCE_AUTHOR_LINKS) {
    if (src.includes(a.key)) return { name: a.key, url: a.url };
  }
  return null;
}

/** 剧本来源行：来源作者 + 可点击的圆形作品链接图标（sourceUrl 优先，其次按名字匹配） */
function SourceAttribution({ src, sourceUrl, className }: { src: string; sourceUrl?: string; className?: string }) {
  const link = sourceUrl ? { name: src.split(',').pop()?.trim() || src, url: sourceUrl } : sourceAuthorLink(src);
  return (
    <p className={`text-center text-[11px] text-ink-soft flex items-center justify-center ${className ?? ''}`}>
      <span>{t('roleplaySource', { src })}</span>
      {link && (
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          title={link.name}
          aria-label={link.name}
          className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full bg-gray-100 text-ink-soft border border-gray-200 hover:bg-primary-strong hover:border-primary-strong hover:text-white transition-colors shrink-0"
        >
          <ExternalLink className="w-2.5 h-2.5" />
        </a>
      )}
    </p>
  );
}

/** 剧本封面 / AI 角色头像：有 avatar 图片则渲染图片（懒加载 + 失败回退 emoji），否则回退到 emoji cover（其它剧本不受影响） */
function RPCover({ s, imgClass, fallbackClass }: { s?: (Pick<RoleplayScenarioInfo, 'avatar' | 'cover' | 'title'> & { ai?: { name?: string } }) | null; imgClass: string; fallbackClass: string }) {
  const [broken, setBroken] = useState(false);
  const alt = s?.ai?.name || s?.title || s?.cover || '';
  if (!s?.avatar || broken) {
    return <span className={fallbackClass + ' flex-shrink-0'}>{s?.cover ?? '🎭'}</span>;
  }
  return <img src={s.avatar} alt={alt} loading="lazy" decoding="async" onError={() => setBroken(true)} className={imgClass + ' flex-shrink-0 object-cover'} />;
}

/**
 * 群像剧本的**角色头像**（2026-10-01）
 *
 * 三档（与「谁是主角」的语义对齐）：
 *   1. **主角色（lead）** → 头像**就是剧本头像**（走 `RPCover`，自带 onError → emoji 回退）；
 *   2. 其它角色 → 自带的 `avatar`；图挂了也回退到第 3 档；
 *   3. 都没有 → 「名字首字」色块（由调用方给底色/尺寸）。
 *
 * 为什么抽成组件：详情页「同场角色」与聊天气泡里的说话人头像**必须是同一张脸**。
 * 之前两处各写一份，详情页那份没认 `lead`，于是主角位上显示的是「裴」字色块
 *（用户截图指出「主角的位置都要有主角头像」），抽成一份就不会再分叉。
 */
function CastAvatar({ member, scenario, imgClass, textClass }: {
  member: { name: string; avatar?: string; lead?: boolean };
  scenario?: RoleplayScenarioInfo | null;
  imgClass: string;
  textClass: string;
}) {
  const [broken, setBroken] = useState(false);
  if (member.lead && scenario) return <RPCover s={scenario} imgClass={imgClass} fallbackClass={textClass} />;
  if (member.avatar && !broken) {
    return <img src={member.avatar} alt={member.name} loading="lazy" decoding="async" onError={() => setBroken(true)} className={imgClass} />;
  }
  return <span className={textClass}>{(member.name || '?').trim().charAt(0)}</span>;
}

/** 星野式竖版人物卡片：3:4 大图 + 顶部点赞角标 + 底部标题/文案/标签叠加 */
function RPStoryCard({ s, onOpen, onLike, liked, count }: {
  s: RoleplayScenarioInfo;
  onOpen: () => void;
  onLike: () => void;
  liked: boolean;
  count: number;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      className="group relative block w-full aspect-[3/4] rounded-2xl overflow-hidden bg-[#15161d] text-left shadow-soft hover:shadow-lift hover:-translate-y-0.5 transition-all focus-visible:outline-2 focus-visible:outline-primary"
    >
      <RPCover s={s} imgClass="absolute inset-0 w-full h-full transition-transform duration-500 group-hover:scale-[1.05]" fallbackClass="absolute inset-0 flex items-center justify-center text-5xl" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-black/10" />
      {/* 多角色角标（2026-10-01）：名单 >= 2 人的剧本在卡片左上角标出（右上角是点赞，不冲突） */}
      {(s.cast?.length ?? 0) >= 2 && (
        <span
          data-testid="rp-multi-badge"
          className="absolute left-2 top-2.5 inline-flex items-center gap-0.5 rounded-full bg-primary-strong/90 backdrop-blur-sm px-1.5 py-1 text-[10px] font-bold leading-none text-white shadow-sm"
        >
          <Users className="w-3 h-3" />
          {t('rpBothModesBadge')}
        </span>
      )}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); onLike(); }}
        aria-label={liked ? t('rpUnlikeAria') : t('rpLikeAria')}
        title={liked ? t('rpUnlikeAria') : t('rpLikeAria')}
        className="absolute right-2 top-2.5 inline-flex items-center gap-1 rounded-full bg-black/45 backdrop-blur-sm px-1.5 py-1 text-[11px] font-medium leading-none text-white/85 hover:text-rose-300 transition-colors"
      >
        <Heart className={'w-3 h-3 ' + (liked ? 'fill-current' : '')} />
        {count > 0 && <span className="tabular-nums">{count}</span>}
      </button>
      <div className="absolute inset-x-0 bottom-0 p-2.5">
        <h3 className="text-[15px] font-bold text-white leading-snug drop-shadow-sm">{s.title}</h3>
        {s.tagline && <p className="mt-1 text-[11px] text-white/85 leading-snug line-clamp-2">{s.tagline}</p>}
        {s.tags && s.tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {s.tags.slice(0, 3).map(tag => (
              <span key={tag} className="px-1.5 py-0.5 rounded-md bg-white/15 backdrop-blur-sm text-white/95 text-[10px] font-medium leading-none">{tag}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


interface RoleplayPageProps {
  onBack: () => void;
  onNeedLogin: () => void;
  authUser: AuthUser | null;
  onOpenMembership?: () => void; // 非 Pro 点击「最大」档时触发会员升级引导
  onNeedPay?: () => void;        // 免费额度用完 → 统一门控（游客注册 / 已注册「获取更多额度」）
  initialScenarioId?: string;    // 推送深链：直接进入上次那个剧本
  initialWenyouGame?: string;    // 推送深链：直接进入上次那局千世书文游
  initialCreate?: boolean;       // 聊一聊「角色扮演指令分流」卡片：直接打开「AI 创剧本」表单
  initialPrefOpen?: boolean;     // 邮件深链（?open=roleplay&pref=1）：进入剧情后直接打开「我的偏好」抽屉
  /**
   * 聊一聊成人向引导卡的一次性意愿：用户点的按钮上写着「打开无限制模式」，所以要真的替他开。
   * 消费规则见组件里那段 effect：模型不可用→只提示；已过 18+→直接开；未过→先弹闸门、确认后开。
   * ⚠️ 无论走哪条路，18+ 年龄确认**一步都不省**（合规红线，也是服务端硬门槛）。
   */
  initialAdultIntent?: boolean;
  /**
   * 年龄闸门开合状态上报给上层。
   * 为什么需要：闸门打开期间必须让 Home 压掉注册弹窗，否则会出现「偏好抽屉 + 注册弹窗 + 年龄闸门」
   * 三层叠着（视觉复核实测），闸门之外还挂着另一个带自己关闭按钮的对话框，阻塞意图含混。
   * 这道控制权在 Home（{modals} 由它渲染），所以只能上报。
   */
  onAdultGateChange?: (open: boolean) => void;
  /**
   * 剧情 → 聊一聊 跨模式桥（B 方案）：把草稿交给上层切到聊一聊。
   * 上层负责 setPendingChatSeed(seed) → 关剧情 → appMode='chat'；**绝不自动发送**。
   */
  onGoChat?: (seed: BridgeSeed) => void;
  /**
   * 把剧情角色加到聊一聊之后「去看看」用：上层负责 setPendingChatCharId(charId) → 关剧情 → appMode='chat'。
   * 与 onGoChat 分开是因为它**不带草稿**（不是跨模式引导，而是「去我新养的角色窗口」）。
   */
  onOpenChat?: () => void;
}

// 【剧情会话持久化：登录/游客都写后端（跨设备、供控制台查看）；游客本地作镜像与兜底】
/**
 * 会话本地键：**solo 沿用旧键**（`cure_rp_session_<id>`），multi 加后缀。
 * 这样老用户的本地存档一字不动地继续可用，多角色线从空档开始，不需要任何本地迁移。
 */
const rpSessionKey = (id: string, mode: RoleplayMode = 'solo') => 'cure_rp_session_' + id + (mode === 'multi' ? '_multi' : '');
/** 记住用户在这部剧本里上次选的是哪条线（下次进详情页默认选它） */
const rpModeKey = (id: string) => 'cure_rp_mode_' + id;
// 【角色名自定义（跨语言沉浸）：AI 角色名 / 用户自己的名字，按剧本存 localStorage】
const rpNamesKey = (id: string) => 'cure_rp_names_' + id;
function loadRpNames(id: string): { ai: string; user: string } | null {
  const o = lsGetJson<{ ai?: unknown; user?: unknown } | null>(rpNamesKey(id), null);
  if (o && typeof o.ai === 'string' && typeof o.user === 'string') return { ai: o.ai, user: o.user };
  return null;
}
function saveRpNames(id: string, ai: string, user: string): void {
  lsSet(rpNamesKey(id), JSON.stringify({ ai, user }));
}
// 【用户偏好/独特需求（每剧本）：登录/游客都写后端（跨设备、供控制台查看）；游客本地作镜像与兜底】
const rpPrefKey = (id: string, mode: RoleplayMode = 'solo') => 'cure_rp_pref_' + id + (mode === 'multi' ? '_multi' : '');
function loadLocalPreference(id: string, mode: RoleplayMode = 'solo'): string {
  return lsGet(rpPrefKey(id, mode)) || '';
}
function saveLocalPreference(id: string, mode: RoleplayMode, text: string): void {
  lsSet(rpPrefKey(id, mode), text);
}
/** 「我的偏好」也按线走：单角色线与多角色线可以有不同偏好（同档同偏好） */
async function loadPreference(id: string, mode: RoleplayMode = 'solo'): Promise<string> {
  if (isLoggedIn()) {
    try {
      const r = await getRoleplaySession(id, mode);
      if (r.success && r.data) return r.data.userPreference || '';
    } catch { /* 后端异常 → 兜底本地 */ }
    return loadLocalPreference(id, mode); // 后端无偏好/失败 → 本地兜底
  }
  return loadLocalPreference(id, mode);
}
async function savePreference(id: string, mode: RoleplayMode, text: string): Promise<void> {
  // 本地始终镜像（离线/后端失败兜底；游客也保留本机可续）
  saveLocalPreference(id, mode, text);
  try {
    await saveRoleplayPreference(id, text, mode); // 登录/游客都写后端（供控制台查看游客剧情偏好）
  } catch { /* 后端失败忽略（本地已保存） */ }
}
/**
 * 本地会话读取：**一律过形状校验**（sanitizeMessages）。
 * 为什么：`loadLocalSession` 是外部数据入口（可能来自旧版本、被手改、或写坏），
 * 以前只判「是不是数组」→ 一条 `{role:'assistant'}`（缺 content）就够让渲染期的
 * `messages[last].content.length` 抛错 → 无 ErrorBoundary → 整页白屏。
 * 返回语义保持「null = 没有可用会话」，调用方不要再用真值判断。
 */
function loadLocalSession(id: string, mode: RoleplayMode = 'solo'): RoleplayMessage[] | null {
  const clean = sanitizeMessages(lsGetJson<unknown>(rpSessionKey(id, mode), null));
  return clean.length > 0 ? clean : null;
}
function saveLocalSession(id: string, mode: RoleplayMode, msgs: RoleplayMessage[]): void {
  lsSet(rpSessionKey(id, mode), JSON.stringify(sanitizeMessages(msgs)));
}
function clearLocalSession(id: string, mode: RoleplayMode): void {
  lsRemove(rpSessionKey(id, mode));
}
async function loadSession(id: string, mode: RoleplayMode = 'solo'): Promise<RoleplayMessage[] | null> {
  const msgs = await loadSessionRaw(id, mode);
  /**
   * 读盘即**播种**「最近一次真的写下去的会话快照」（2026-09 编辑重发时补）。
   *
   * 为什么必须播种：`saveSession` 的「截断态不写」判据是**跟上一份写下去的内容比对**得出的
   *（`dropsSavedReply(prev, next)`）。如果这份快照是空的（刚进页面、还没写过任何一次），
   * 判据只能返回 false → 那个「以 user 结尾的中间态」会被真的写进本地镜像与服务端。
   * 对游客尤其致命：本地镜像就是他唯一的历史。
   */
  if (msgs && msgs.length > 0) lastWrittenSession.set(rpSnapshotKey(id, mode), msgs);
  return msgs;
}
/** `loadSession` 的本体（上面那层包壳负责播种写入快照） */
async function loadSessionRaw(id: string, mode: RoleplayMode = 'solo'): Promise<RoleplayMessage[] | null> {
  /** 本地兜底（游客的唯一来源 / 登录用户后端失败或没记录时） */
  const fromLocal = (): RoleplayMessage[] | null => {
    const local = loadLocalSession(id, mode);
    return local ? stripFallbackBubbles(local) : null;
  };
  if (isLoggedIn()) {
    try {
      const r = await getRoleplaySession(id, mode);
      // 服务端消息同样过形状校验：库里的**历史遗留数据**不受写入侧过滤器的保护（加载路径不校验）
      const clean = stripFallbackBubbles(sanitizeMessages(r.success ? r.data?.messages : null));
      if (clean.length > 0) return clean;
    } catch { /* 后端异常 → 兜底本地 */ }
    return fromLocal();
  }
  return fromLocal();
}
/**
 * 「最近一次真的写下去的会话快照」（每个剧本一份，仅本页生命周期内有效）。
 *
 * 用途：写入前跑一遍与服务端同源的「未完成回合」判据（`src/lib/rpWriteGuard.ts`），
 * 命中就**整笔跳过**（本地镜像 + 后端都不写），而不是像 2026-09-18 之前那样
 * 「本地先写下去、后端拒写」，让游客 / 后端回退路径拿到一份比服务端少一条回复的分叉数据。
 */
const lastWrittenSession = new Map<string, RoleplayMessage[]>();
/** 写入快照的键：**每条线各一份**（否则演多角色线时会被单角色线的快照判成"重复/截断"） */
const rpSnapshotKey = (id: string, mode: RoleplayMode) => id + '::' + mode;

async function saveSession(id: string, mode: RoleplayMode, msgs: RoleplayMessage[]): Promise<void> {
  // 兜底双保险：任何情况下都不把「失败提示」当成角色台词落盘（历史遗留数据也顺带清掉）
  const clean = stripFallbackBubbles(msgs);
  /**
   * 🚨 截断态不写（2026-09-18，与服务端 `roleplaySessions.save()` 同一份判据）。
   *
   * 客户端「重新生成」会先造一个「以用户消息结尾、比库里短、把已生成的回复截掉」的中间态
   *（`regenerateAt` → `setMessages(start.base)`）。以前这里会立刻把它写下去：
   *   ① 后端护栏拒写，并记一条运营埋点 `roleplay / UNANSWERED_TURN`，可**用户什么都没看到**
   *     （这一轮新回复回来后正常落盘），运营卡上的「用户实际看到失败提示」因此被凭空放大
   *     （2026-09-18 当天 25 次里 16 次就是这么来的）；
   *   ② 本地镜像**却被真的截断了**（本函数是先写本地、再写后端），游客（唯一来源就是本地镜像）
   *     与后端 GET 失败的回退路径会从此比服务端少一条回复。
   *
   * 所以直接在源头不写：等这一轮的新回复回来（以 assistant 结尾）再正常落盘，
   * 「重新生成」的正经用法一点不受影响（判据 3 不成立）。服务端那道护栏保留，用来兜底挡
   * 旧客户端 / 另一台设备的落后状态。
   */
  if (dropsSavedReply(lastWrittenSession.get(rpSnapshotKey(id, mode)), clean)) {
    console.info('[roleplay] 跳过「未完成回合」的截断写入（保留已有回复）:', id, mode, clean.length, '条');
    return;
  }
  // 本地始终镜像（游客可离线续写、后端失败兜底）
  saveLocalSession(id, mode, clean);
  lastWrittenSession.set(rpSnapshotKey(id, mode), clean);
  try {
    await saveRoleplaySession(id, clean, undefined, mode); // 登录/游客都写后端（供控制台查看游客剧情记录）
  } catch { /* 后端失败忽略（本地已保存） */ }
}
/**
 * 「重新开始」：**只清当前这条线**的存档（另一条线原样保留）。
 * 这就是双模式的直接体现，把多角色线重开，不该顺手抹掉用户的单角色线。
 */
function clearSession(id: string, mode: RoleplayMode): void {
  lastWrittenSession.delete(rpSnapshotKey(id, mode)); // 重开这段剧情：快照随之作废，别拿旧历史去比对
  clearLocalSession(id, mode);
  try { localStorage.removeItem(rpPrefKey(id, mode)); } catch { /* 忽略 */ }
  deleteRoleplaySession(id, mode).catch(() => {}); // 登录/游客都删后端（游客若已在后端则一并清除）
}

export default function RoleplayPage({ onBack, onNeedLogin, authUser, onOpenMembership, onNeedPay, initialScenarioId, initialWenyouGame, initialCreate, initialPrefOpen, initialAdultIntent, onAdultGateChange, onGoChat, onOpenChat }: RoleplayPageProps) {
  const [stage, setStage] = useState<RpStage>(() => {
    if (initialWenyouGame) return 'wenyou'; // 深链直达文游续玩
    /**
     * 2026-09-18（用户拍板 A 案）：**首次进入不再落到「模块介绍页」**。
     * 老逻辑是 `localStorage.cure_rp_intro_seen !== '1' ? 'intro' : 'list'`，新用户进剧情演绎会被
     * 整页介绍（这是什么/剧本来源/收费说明/温馨提示 + 唯一按钮「查看剧本」）拦住，不点进不去。
     * 现在剧情演绎底下是**三个并列模式**（AI剧情扮演 / AI文游 / AI狼人杀），落地直接进剧本列表
     * 才能一眼看到模式切换；那页介绍的内容也只描述了「角色扮演」一种模式，容易让新用户以为模块
     * 只有一个玩法。介绍页**不删**：顶栏 ⓘ「了解本功能」仍在，想看的用户随时能打开（`stage='intro'`）。
     * 因此 `cure_rp_intro_seen` 这个键**不再读写**（老用户残留的值无害，也没有任何地方再读它）。
     */
    return 'list';
  });
  // Android 的 WebView/Chrome 靠 `interactive-widget=resizes-content` 收缩布局视口，
// 用 CSS `top-0 bottom-0` 锚定的 fixed 壳会自动贴键盘上沿，不要叠 JS 的 top/height。
const IS_ANDROID = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');

// 真机 iOS 键盘处理：对局聊天用 fixed 全屏壳 + body 锁滚动 + 瞬时回落（与聊一聊一致）。
  // 仅「chat」阶段才锁，列表/详情/自建表单页仍需正常滚动，不能锁正文滚动。
  const { inset: kbInset, offsetTop: vvOffsetTop } = useVisualViewport();
  /**
   * 聊天壳底边：**默认铺到布局视口底边（0）**，只有「真键盘」弹起时才抬起。
   * 为什么需要阈值判定 → 见 `src/lib/viewportAnchor.ts` 的注释（工具栏收缩被误判成键盘，
   * 会让壳变矮、从下方露出**皮肤氛围背景图**，也就是用户反馈的那块空白）。
   */
  const liftBottom = bottomAnchorPx(kbInset);
  useIosKeyboardLock(stage === 'chat');
  // 【首次进入 · 剧情模式功能引导气泡（coach-mark）】
  const [rpCoachOpen, setRpCoachOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('cure_rp_coach_seen') !== '1'; } catch { return false; }
  });
  const rpModeBtnRef = useRef<HTMLButtonElement>(null);
  const rpWenyouBtnRef = useRef<HTMLButtonElement>(null);
  /** AI 狼人杀 tab（第三个模式，2026-09-17 开放后补上自己的引导气泡） */
  const rpWerewolfBtnRef = useRef<HTMLButtonElement>(null);
  const rpCreateBtnRef = useRef<HTMLButtonElement>(null);
  const rpIntroBtnRef = useRef<HTMLButtonElement>(null);
  const rpCoachLang = getLang();
  /**
   * 引导气泡的步骤顺序（用户 2026-09-17 拍板：狼人杀**并入现有队列**，不单独给老用户补弹）：
   * 三个模式 tab 相邻介绍（文游 → 狼人杀），再讲自建与介绍入口。
   * 记住：故事线里 tab 的视觉顺序是 角色剧情扮演 | AI 文游 | AI 狼人杀，
   * 这里把「角色剧情扮演(mode)」放在最后是历史顺序，不要为了“好看”重排，老用户虽然看不到，
   * 但换过序的截图/文档会对不上。
   */
  const rpCoachSteps = useMemo<CoachStep[]>(() => [
    { key: 'intro', anchorRef: rpIntroBtnRef, text: t('coachRpIntro') },
    { key: 'wenyou', anchorRef: rpWenyouBtnRef, text: t('coachRpWenyou') },
    { key: 'werewolf', anchorRef: rpWerewolfBtnRef, text: t('coachRpWerewolf') },
    { key: 'create', anchorRef: rpCreateBtnRef, text: t('coachRpCreate') },
    { key: 'mode', anchorRef: rpModeBtnRef, text: t('coachRpMode') },
  ], [rpModeBtnRef, rpWenyouBtnRef, rpWerewolfBtnRef, rpCreateBtnRef, rpIntroBtnRef, rpCoachLang, t]);
  const finishRpCoach = useCallback(() => {
    setRpCoachOpen(false);
    try { localStorage.setItem('cure_rp_coach_seen', '1'); } catch { /* 忽略 */ }
  }, []);
  /**
   * ===== AI 狼人杀 · 入口闸门 =====
   * **已开放（2026-09-15）**：默认对所有用户开放。此前按需求临时锁为「开发中」，
   * 目的是在适配未完成时不让我已有的用户玩到半成品。
   * 开放前已核实：开局正常、身份卡/夜间旁白/AI 出牌都走通、
   * 计费与每日次数闸门生效、console 无错误。
   * 保留一个**反向**调试开关，便于线上出问题时立刻回滚：
   *   URL 带 `?ww=off`，或 localStorage 设 `cure_ww_dev=0`。
   */
  const [werewolfUnlocked] = useState<boolean>(() => {
    try {
      if (localStorage.getItem('cure_ww_dev') === '0') return false;
      return new URLSearchParams(window.location.search).get('ww') !== 'off';
    } catch {
      return true;
    }
  });
  /** 「正在开发中」提示条（3s 自动消失；重复点击重置计时） */
  const [wwWipTip, setWwWipTip] = useState(false);
  const wwWipTimer = useRef<number | null>(null);
  useEffect(() => () => { if (wwWipTimer.current !== null) window.clearTimeout(wwWipTimer.current); }, []);
  const openWerewolf = () => {
    if (!werewolfUnlocked) {
      setWwWipTip(true);
      if (wwWipTimer.current !== null) window.clearTimeout(wwWipTimer.current);
      wwWipTimer.current = window.setTimeout(() => setWwWipTip(false), 3000);
      return;
    }
    setStage('werewolf');
  };
  const [scenarios, setScenarios] = useState<RoleplayScenarioInfo[]>([]);
  const [selected, setSelected] = useState<RoleplayScenarioInfo | null>(null);
  const [messages, setMessages] = useState<RoleplayMessage[]>([]);
  /**
   * 当前演的是哪条线（2026-10-01 双模式）：solo = 单角色线，multi = 多角色线。
   * 两条线**各有独立存档与偏好**；详情页的模式开关决定进哪条，并记住用户上次的选择。
   */
  const [rpMode, setRpMode] = useState<RoleplayMode>(DEFAULT_ROLEPLAY_MODE);
  /**
   * 开场白打字机（O1，2026-10-01）
   *
   * 需求：「第一条信息出来的时候是流式的」，多角色剧本里还要"每个角色的气泡逐个出现"。
   * 做法：进一部**没有存档**的剧本时，开场白不瞬间全出，而是把已揭示的字符数记在这里，
   * 渲染时切片；因为多角色解析器是流式容错的，切片推进时自然就是"旁白先长出来 → 李嬷嬷
   * 的气泡出现、再长 → 世子的气泡再出现"。
   *
   * 值 = 已揭示字符数；null = 不在动画中（存档续演、用户已发言、重新开始前）。
   * ⚠️ **只影响渲染**：`messages` 里始终是完整原文（落盘/回灌/分享/复制一律取全文），
   *     所以动画中途刷新也不会把半截开场白写进业务数据（红线⑥的同类风险）。
   */
  const [openingTyped, setOpeningTyped] = useState<number | null>(null);
  const [input, setInput] = useState('');
  // 输入框自动增高：内容换行时撑高完整显示（上限 160px，超出后在框内滚动），空态保持一行
  const rpInputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = rpInputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [input]);
  /**
   * 开场白打字机的推进器。
   * 步长按整段长度算（约 120 帧走完）：短开场不至于"刷"地一下，长开场也不会让人干等。
   * 只在**第 0 条 assistant 消息**是开场白时生效（见渲染处的切片），不新增/不修改任何消息。
   */
  useEffect(() => {
    if (openingTyped === null) return;
    const total = messages[0]?.content?.length ?? 0;
    if (openingTyped >= total) { setOpeningTyped(null); return; }
    const step = Math.max(1, Math.round(total / 120));
    const id = window.setTimeout(() => setOpeningTyped((n) => Math.min(total, (n ?? 0) + step)), 22);
    return () => window.clearTimeout(id);
  }, [openingTyped, messages]);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tipOpen, setTipOpen] = useState(false);
  // 【把剧情角色加到聊一聊（方案 A1）：确认卡 → 导入（物化角色 + 记忆迁移）→ 「去看看」】
  const [toChatOpen, setToChatOpen] = useState(false);
  const [toChatBusy, setToChatBusy] = useState(false);
  const [toChatErr, setToChatErr] = useState<string | null>(null);
  // 剧情背景速览（聊天气泡中随时查看人设/世界观）
  const [storyInfoOpen, setStoryInfoOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  /** 顶栏「⋯」低频项菜单（界面外观 / 意见反馈 / 分享对话 / 重新开始），见顶栏注释：7 个图标挤不下 */
  const [rpMoreOpen, setRpMoreOpen] = useState(false);
  /**
   * 「⋯」菜单的落点（相对**聊天壳**的 top/right，px）。
   * 为什么要搬出顶栏、用绝对定位算坐标：顶栏自己带 `backdrop-blur-md` ⇒ 顶栏是它内部所有元素的
   * **backdrop root**，菜单挂在顶栏里时它自己的 `backdrop-filter` 只能糊到"顶栏自己的像素"
   *（菜单悬在顶栏**外面**，那块什么都没有）→ 实测就是"菜单半透明但没有毛玻璃、底下的字直接穿上来"。
   * 把菜单挪成聊天壳的直接子节点（与顶栏**并列**）后，它的 backdrop 才包含整页 → 毛玻璃真正生效。
   * 证据：`temp/verify-rp-menu-backdroproot.mjs` 的 A/B（去掉父级 backdrop-filter 后，菜单区梯度能量 15.90 → 10.64）。
   */
  const [rpMorePos, setRpMorePos] = useState<{ top: number; right: number }>({ top: 56, right: 12 });
  const rpShellRef = useRef<HTMLDivElement>(null);
  /**
   * 剧情视图的**首帧兜底标记**由 index.html 的启动脚本打上（让皮肤层先显示最近一次的场景图，
   * 避免"先闪皮肤再跳到背景图"）。本组件卸载＝离开剧情视图 → 必须摘掉它，
   * 否则其它页面（首页等）也会被顶着那张场景图。
   */
  const rpMoreRef = useRef<HTMLDivElement>(null);
  /**
   * 「⋯」菜单**本体**的 ref。为什么需要它：菜单为了毛玻璃已经搬到聊天壳层（不再是 rpMoreRef 的子节点），
   * 而下面的「点外部关闭」判定原来只认 `rpMoreRef`，于是**点菜单项本身也会被当成点外部**：
   * mousedown 先把菜单关掉，随后的 click 落空 → 用户看到的就是「点了没反应」
   * （2026-09-15 用户反馈「剧情模式也有界面外观这个选项，但是点了以后没反应」的根因）。
   */
  const rpMoreMenuRef = useRef<HTMLDivElement>(null);
  /** 反馈入口收进「⋯」菜单（用户要求），与顶栏那个 FeedbackButton 调的是同一个 store 动作 */
  const setFeedbackOpen = useAppStore(s => s.setFeedbackOpen);
  /** 界面外观（含卡片不透明度滑块），见菜单里那一项：用户常问透明度在哪调 */
  const setAppearanceOpen = useAppStore(s => s.setAppearanceOpen);
  /** 「把 TA 加到聊一聊」：导入成功后把目标角色交给聊一聊（只走 UI 层，不写任何消息集合） */
  const setPendingChatCharId = useAppStore(s => s.setPendingChatCharId);
  useEffect(() => {
    if (!rpMoreOpen) return;
    /** 点「⋯」按钮本身或**菜单本体**都不算"点外部"（菜单本体在另一处渲染，见 rpMoreMenuRef 注释）。
     *  形参用 `Event` 而不是 `MouseEvent`：同一个处理函数要同时挂 mousedown 与 touchstart。 */
    const onDocDown = (e: Event) => {
      const t = e.target as Node | null;
      if (!t) return;
      const inButton = !!rpMoreRef.current && rpMoreRef.current.contains(t);
      const inMenu = !!rpMoreMenuRef.current && rpMoreMenuRef.current.contains(t);
      if (!inButton && !inMenu) setRpMoreOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    // 触摸端补一条：个别浏览器（老 Android WebView / 长按）不派发合成 mousedown，
    // 只靠 mousedown 会出现"点了菜单项没反应"或"点外部关不掉"
    document.addEventListener('touchstart', onDocDown);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('touchstart', onDocDown);
    };
  }, [rpMoreOpen]);
  // 【剧情配乐（BGM）：默认按剧本曲风映射；♪ 面板可换同风格曲目/关闭；登录用户跨设备同步】
  // 范围：剧本详情（看背景故事/开场）即随进入手势开播，进对话沿用同一 Audio 延续不重播；离开该剧本（回列表等）才停
  const [bgmOpen, setBgmOpen] = useState(false);
  const bgmStoryView = stage === 'detail' || stage === 'chat';
  const bgm = useScenarioBgm(bgmStoryView && selected ? selected.id : null, !!authUser, bgmStoryView && selected ? selected.tags : undefined);
  // 剧情角色配音（S1 声音层）：按「剧本标签分组 + AI 角色性别」自动选音色（storyVoice），
  //    默认关（想听再开），登录用户跨设备同步（偏好键 roleplayVoiceEnabled）；合成与播放见 useStoryVoice。
  const rpVoicePick = useMemo(
    () => (selected
      ? defaultVoiceForScenario(
        { tags: selected.tags, ai: selected.ai, audience: selected.audience },
        getLang() === 'en' ? 'en-US' : '',
      )
      : null),
    [selected],
  );
  const voice = useStoryVoice({
    design: rpVoicePick?.design || '',
    // 音色参考名 = 预设 id（侧车参考库 third_party/voice-refs/{id}.wav 一一对应）
    // → 剧情配音走克隆路径：自然语速（4.2~4.5 字/秒 vs 设计路径 2.4~2.8）+ 每个角色各自音色
    reference: rpVoicePick?.preset.id,
    aiName: selected?.ai?.name,
    loggedIn: !!authUser,
  });
  const rpVoiceEnabled = voice.enabled;
  const rpVoicePrepare = voice.prepare;
  // 场景画面换幕判定用的文本：最近一轮 AI 回复（没有则用开场白）
  const rpSceneText = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].content) return messages[i].content;
    }
    return selected?.openingAssistant || '';
  }, [messages, selected]);
  // 【场景画面（S2/S5）：当前幕只在明确命中新主题时推进；专属画面按需生成、缓存复用】
  const rpThemeHit = useMemo(() => matchTheme(rpSceneText), [rpSceneText]);
  // null = "还没有任何明确的一幕" → 底图走**主场景图**（这部剧自己的空间），不再掉进 daily 的厨房晨光
  const [rpSceneTheme, setRpSceneTheme] = useState<string | null>(null);
  const [rpSceneArt, setRpSceneArt] = useState<{ url: string | null; masterUrl: string | null; ownUrl: string | null; ownUrls: string[]; loading: boolean; msg: string | null }>({ url: null, masterUrl: null, ownUrl: null, ownUrls: [], loading: false, msg: null });
  useEffect(() => {
    // 进入"剧情浏览页 / 聊天"时，立刻把**最近一次看过的场景图**贴到皮肤层上（首帧兜底）；
    // 离开这两种视图（回列表/首页等）→ 摘掉标记，其它页面照旧用皮肤。
    // 为什么不能只靠 index.html 的启动脚本：从列表**点进**剧情是 SPA 内切换（不刷新），启动脚本不会跑。
    const active = stage === 'detail' || stage === 'chat';
    const url = active && selected
      ? sceneBootUrlFor(selected.id, rpSceneArt.ownUrl || rpSceneArt.masterUrl || rpSceneArt.url || '')
      : '';
    if (url) applySceneBoot(url);
    else clearSceneBoot();
  }, [stage, selected, rpSceneArt.ownUrl, rpSceneArt.masterUrl, rpSceneArt.url]);
  // 组件卸载（离开剧情）也要摘掉，避免顶着场景图到别的页面
  useEffect(() => () => clearSceneBoot(), []);
  const rpPrevScenarioRef = useRef<string | null>(null);
  // ⚠️ 只用一个 effect 管"换剧本复位"与"随剧情换幕"：
  // 曾拆成两个 effect，结果换剧本的复位在**同一轮提交里后执行**、把刚命中的幕又按回默认
  // （表现为：进入一个已有"雨"剧情的会话时，画面停在第一幕）。
  useEffect(() => {
    const id = selected?.id ?? null;
    const switched = rpPrevScenarioRef.current !== id;
    rpPrevScenarioRef.current = id;
    if (switched) {
      // 换剧本：直接落到"当前文本能明确命中的幕"；命中不了就保持 null（→ 用主场景图，而不是跳去日常厨房）
      setRpSceneTheme(rpThemeHit);
      return;
    }
    if (rpThemeHit && rpThemeHit !== rpSceneTheme) setRpSceneTheme(rpThemeHit);
  }, [selected?.id, rpThemeHit, rpSceneTheme]);
  // 【环境音（S1 声音层）：随「换幕」切换雨/风/室内底噪，剧情文本含"雷"触发一次性雷声；默认关】
  // 必须放在 rpSceneTheme/rpSceneText 之后（闭包引用它们）
  const ambience = useStoryAmbience({
    theme: rpSceneTheme || '',
    text: rpSceneText,
    active: bgmStoryView,
    loggedIn: !!authUser,
  });
  // 换剧本：清掉上一个剧本的专属画面（当前幕由上面的 effect 统一处理，避免两处抢同一状态）
  useEffect(() => {
    setRpSceneArt({ url: null, masterUrl: null, ownUrl: null, ownUrls: [], loading: false, msg: null });
  }, [selected?.id]);
  // 进入/换幕时取一次"这一幕的专属画面 + 已缓存的按需画面 + 该剧本的主场景图"（不发算力、不耗额度）
  // ⚠️ 2026-09-14：**不再要求登录**。此前写了 `!authUser → return`，导致**游客永远只看共享池图**
  //    （就是"跟剧情没关系"那批通用房间），而主场景图/已生成的专属图本来只是**读文件探测**，
  //    `/scene/art` 这个 GET 也不需要鉴权。生成（POST）仍然要登录 + 额度，权益没放松。
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    void getSceneArt(selected.id, rpSceneTheme || DEFAULT_THEME).then((r) => {
      if (!alive || !r.success) return;
      const url = r.data?.url || null;
      const masterUrl = r.data?.masterUrl || null;
      const ownUrl = r.data?.ownUrl || null;
      const ownUrls = r.data?.ownUrls || [];
      setRpSceneArt((s) => (
        s.url === url && s.masterUrl === masterUrl && s.ownUrl === ownUrl && s.ownUrls.length === ownUrls.length
          ? s : { ...s, url, masterUrl, ownUrl, ownUrls }
      ));
    }).catch(() => { /* 忽略：拿不到就用共享图 */ });
    return () => { alive = false; };
  }, [selected, rpSceneTheme, authUser]);
  // 提示文案 4s 自动消失
  useEffect(() => {
    if (!rpSceneArt.msg) return;
    const t = setTimeout(() => setRpSceneArt((s) => ({ ...s, msg: null })), 4000);
    return () => clearTimeout(t);
  }, [rpSceneArt.msg]);
  const [hasSaved, setHasSaved] = useState(false);
  // 【用户偏好/独特需求（每剧本持久保存，AI 后续始终参考）】
  const [userPreference, setUserPreference] = useState('');
  const [prefOpen, setPrefOpen] = useState(false);
  const [prefDraft, setPrefDraft] = useState('');
  /**
   * 「我的偏好」弹窗的手机适配（真机反馈：窗口顶部超出屏幕、被顶栏盖住，关闭键点不到、也拖不动）。
   * 根因：内容（7 个设置块 + 文本域）本来就比手机屏高，而旧写法用 `items-center` 居中
   * 超高时顶部与底部一起溢出，外层又不滚动 → 顶部的关闭 X 被推出可视区，永远够不着。
   * 现在的做法：手机上改成**底部抽屉**（贴底 + 头部固定 + 中间内容区独立滚动 + 按住把手下滑关闭），
   *              ≥sm 仍是居中弹窗；壳的 top/bottom 跟随 visualViewport，软键盘弹起时整块抬到键盘之上。
   */
  const [prefSheetDy, setPrefSheetDy] = useState(0); // 下滑跟手位移（px，0 = 原位）
  const prefSheetDrag = useRef({ startY: 0, dy: 0, active: false });
  const onPrefSheetTouchStart = (e: ReactTouchEvent) => {
    // ≥sm 是居中弹窗（没有把手），下滑关闭只属于手机上的抽屉：
    // 平板/触屏笔电上误拖会把居中弹窗拽走，反而不像原生弹窗
    if (typeof window !== 'undefined' && window.innerWidth >= 640) return;
    const touch = e.touches[0];
    if (!touch) return;
    prefSheetDrag.current = { startY: touch.clientY, dy: 0, active: true };
  };
  const onPrefSheetTouchMove = (e: ReactTouchEvent) => {
    const drag = prefSheetDrag.current;
    const touch = e.touches[0];
    if (!drag.active || !touch) return;
    const dy = Math.max(0, touch.clientY - drag.startY); // 只跟手向下拖（向上=内容滚动，不抢手势）
    drag.dy = dy;
    setPrefSheetDy(dy);
  };
  /** 松手：下滑超过 88px 视为「关闭抽屉」，否则弹回原位 */
  const onPrefSheetTouchEnd = () => {
    const drag = prefSheetDrag.current;
    if (!drag.active) return;
    drag.active = false;
    const dy = drag.dy;
    drag.dy = 0;
    setPrefSheetDy(0);
    if (dy > 88) setPrefOpen(false);
  };
  // 【剧情叙事模式（classic=小说笔法·第三人称长文 / immersive=对话笔法·口语短句）】
  /**
   * **服务端偏好为准 + localStorage 只做冷启动缓存**（2026-09-25 C 方案）。
   *
   * 改造前它只存在 `localStorage['rp_narrative_style']`：换设备/清缓存就回默认，
   * 控制台也看不到用户选了什么。现在：
   *   · 首屏先用缓存渲染（不闪一下默认值），
   *   · 拿到偏好后以**服务端**为准；若服务端是"还没选过"（undefined）而本地有值 → 迁上去一次。
   */
  const [narrativeStyle, setNarrativeStyle] = useState<'classic' | 'immersive'>(() => {
    try { return localStorage.getItem('rp_narrative_style') === 'classic' ? 'classic' : 'immersive'; } catch { return 'immersive'; }
  });
  /**
   * 叙事模式的说明文字改成**浮层提示**（3.5s 自动消失）：
   *   进入聊天时先浮一次（让第一次看到的人知道两种模式的区别），之后每次切换再浮一次。
   *   为什么改：常驻那一行 11px 小字是「模式行不能更透」的唯一原因（4.5:1 要求），
   *   而且白占 ~30px 高度。改成浮层后：行更矮 + 该行透明度可完全跟随顶栏。
   */
  const [rpStyleHint, setRpStyleHint] = useState(false);
  const rpStyleHintTimer = useRef<number | null>(null);
  const flashStyleHint = useCallback(() => {
    setRpStyleHint(true);
    if (rpStyleHintTimer.current) window.clearTimeout(rpStyleHintTimer.current);
    rpStyleHintTimer.current = window.setTimeout(() => setRpStyleHint(false), 3500);
  }, []);
  useEffect(() => {
    // 进入聊天时浮一次（列表/详情页不渲染这一行，所以这里等于"首次看到")
    if (stage !== 'chat') return;
    const t0 = window.setTimeout(flashStyleHint, 600);
    return () => { window.clearTimeout(t0); if (rpStyleHintTimer.current) window.clearTimeout(rpStyleHintTimer.current); };
  }, [stage, flashStyleHint]);

  /**
   * @param flash 是否弹那层 3.5s 浮层提示。详情页（进剧情之前）**不弹**
   *   它把两种写法的说明直接铺在卡片里，浮层只会重复一遍；聊天页的顶栏药丸仍然要弹
   *   （那里只有两个词，没有解释空间）。除这一个参数外，三处入口共用同一份副作用。
   */
  const changeNarrativeStyle = (v: 'classic' | 'immersive', flash = true) => {
    setNarrativeStyle(v);
    if (flash) flashStyleHint();
    try { localStorage.setItem('rp_narrative_style', v); } catch { /* ignore */ }
    // 服务端为准（跨设备同步）：失败也不回滚，下次进页面会以服务端值纠正过来
    savePreferences({ narrativeStyle: v }).then(r => {
      if (r.success && r.data) setCachedPreferences(r.data);
    }).catch(() => {});
  };
  // 【括号心理/神态（剧情模式独立开关，默认开；与偏好设置同步）】
  const [innerOn, setInnerOn] = useState(() => {
    const c = getCachedPreferences();
    return c ? c.roleplayInnerMonologueEnabled !== false : true;
  });
  const changeInnerOn = (v: boolean) => {
    setInnerOn(v);
    try { const c = getCachedPreferences(); if (c) setCachedPreferences({ ...c, roleplayInnerMonologueEnabled: v }); } catch { /* 忽略 */ }
    savePreferences({ roleplayInnerMonologueEnabled: v }).then(r => {
      if (r.success && r.data) setCachedPreferences(r.data);
    }).catch(() => {});
  };
  /**
   * 剧情文本「内容类型」首次提示（一次性，localStorage 记住）：
   * 括号写心理/神态是**约定**、不是自明的排版，Character.AI 也要靠官方文档教用户把括号读成舞台指示；
   * 既然现在心声有了独立的视觉（浅底+竖线），就顺手告诉用户"这团色块是什么"，点掉后永不再出现。
   */
  const [textLegendSeen, setTextLegendSeen] = useState(() => {
    try { return localStorage.getItem('rp_text_legend_seen') === '1'; } catch { return false; }
  });
  const dismissTextLegend = useCallback(() => {
    setTextLegendSeen(true);
    try { localStorage.setItem('rp_text_legend_seen', '1'); } catch { /* ignore */ }
  }, []);
  /** 第一条含括号心声的 AI 回复的下标（-1 = 不显示提示）。用轻量正则探测，不为问一句就全量分词 */
  const textLegendIdx = useMemo(() => {
    if (textLegendSeen) return -1;
    return messages.findIndex(m => m.role === 'assistant' && hasThoughtMarker(m.content));
  }, [messages, textLegendSeen]);

  // 【深度思考（剧情模式内联快捷开关，默认高；与偏好设置同步）】
  const [thinkingLevel, setThinkingLevel] = useState<'off' | 'high' | 'max'>(() => {
    const c = getCachedPreferences();
    // max 仅 Pro/Lifetime；非 Pro（游客/免费/Plus）初始即归为 high，避免残留 max 显示
    return c?.thinkingLevel === 'off' ? 'off'
      : (c?.thinkingLevel === 'max' && getCachedPlan() === 'pro') ? 'max'
      : 'high';
  });
  // 关键时刻自动画面（Pro 权益，默认关），状态声明必须在「偏好拉取 effect」之前（其 setter 会被那个 effect 用）
  const [autoArtOn, setAutoArtOn] = useState<boolean>(() => getCachedPreferences()?.roleplayAutoSceneArt === true);
  // 【无限制模式（默认关，需用户显式开启）】
  // 开启后剧情改用去限制模型，并在 system prompt 末尾注入「放开尺度、角色可更主动」的条款。
  // 默认关本身就是内容安全阀：不开就等于完全走 DeepSeek 的保守行为。
  const [unlimitedOn, setUnlimitedOn] = useState<boolean>(() => getCachedPreferences()?.roleplayUnlimited === true);
  // 该模式是否真的可用（第三方模型已配好且没被运维开关 RP_PROVIDER=deepseek 强制切回）；
  // null = 还在查。不可用时开关置灰，避免「用户开了但静默没生效」。
  const [unlimitedReady, setUnlimitedReady] = useState<boolean | null>(null);
  /**
   * 是否做过 18+ 成年确认（服务端留痕，adultConfirm.ts）。null = 还在查。
   * 与 unlimitedReady 是两件事：那个是「模型配好了没」，这个是「这个用户够不够格用」。
   */
  const [adultConfirmed, setAdultConfirmed] = useState<boolean | null>(() => getCachedPreferences()?.adultConfirmed ?? null);
  const [adultGateOpen, setAdultGateOpen] = useState(false);
  /** 这次弹 18+ 确认是为了开哪个开关：剧情「无限制模式」还是「用无限制模型生成剧本」，两者共用一个确认框 */
  const [adultGateFor, setAdultGateFor] = useState<'unlimited' | 'script'>('unlimited');
  const [adultGateBusy, setAdultGateBusy] = useState(false);
  const [adultGateErr, setAdultGateErr] = useState('');
  /** 用户点「我未满 18 岁」后的就地提示（挂在开关下方，而不是弹完就消失） */
  const [unlimitedNotice, setUnlimitedNotice] = useState('');
  /**
   * 瞬时提示（2.6s 自动消失）。只用在「开关开在别处、用户当场看不到结果」的时刻：
   * 引导卡自动开启、年龄未满、模型不可用。**刻意不做成常驻横幅**：聊天界面要保持干净、
   * 不堆提示（用户 2026-09-27 明确要求），所以反馈预算只花这几秒。
   */
  const [adultToast, setAdultToast] = useState('');
  const adultToastTimer = useRef<number | null>(null);
  const showAdultToast = (msg: string) => {
    setAdultToast(msg);
    if (adultToastTimer.current) window.clearTimeout(adultToastTimer.current);
    adultToastTimer.current = window.setTimeout(() => setAdultToast(''), 2600);
  };
  useEffect(() => () => { if (adultToastTimer.current) window.clearTimeout(adultToastTimer.current); }, []);
  // 把闸门开合上报给 Home：让它在这期间不渲染注册弹窗（否则弹窗会和闸门叠成两层，实测注册弹窗还盖在下面那层）
  useEffect(() => { onAdultGateChange?.(adultGateOpen); }, [adultGateOpen, onAdultGateChange]);
  useEffect(() => {
    roleplayModelConfig()
      .then(r => {
        if (r.success && r.data) {
          const ready = r.data.available === true;
          setUnlimitedReady(ready);
          const confirmed = typeof r.data.adultConfirmed === 'boolean' ? r.data.adultConfirmed : null;
          if (confirmed !== null) setAdultConfirmed(confirmed);
          // 模型不可用 / 没做过成年确认 → 服务端这一轮绝不会走成人模型，开关不能留成「开」
          //（否则用户看到的是「开着」，实际走的是保守模型，正是角色扮演这几处注释反复要避免的静默失效）
          if (!ready || confirmed === false) setUnlimitedOn(false);
        } else setUnlimitedReady(false);
      })
      .catch(() => setUnlimitedReady(false));
  }, []);

  /** 真正把开关落到偏好（本地缓存 + 服务端） */
  const applyUnlimited = (v: boolean) => {
    setUnlimitedOn(v);
    try { const c = getCachedPreferences(); if (c) setCachedPreferences({ ...c, roleplayUnlimited: v }); } catch { /* 忽略 */ }
    savePreferences({ roleplayUnlimited: v }).then(r => {
      if (r.success && r.data) {
        setCachedPreferences(r.data);
        // 服务端是权威：没做成年确认时它会把这次写入降级为关（见 routes/user.ts 的写入闸）。
        // 必须跟随服务端回传值，否则开关会显示成「开着但服务端不用」，正是 roleplayModel 里要避免的静默失效。
        if (typeof r.data.roleplayUnlimited === 'boolean') setUnlimitedOn(r.data.roleplayUnlimited);
        if (typeof r.data.adultConfirmed === 'boolean') setAdultConfirmed(r.data.adultConfirmed);
      }
    }).catch(() => {});
  };

  const changeUnlimitedOn = (v: boolean) => {
    if (v && unlimitedReady === false) return; // 不可用就不允许打开
    // 开启前必须先做 18+ 确认（服务端的硬门槛）。这里先弹确认框，是为了给出解释与边界，
    // 而不是让用户点下去、被服务端默默降级成关。
    if (v && adultConfirmed !== true) { setAdultGateErr(''); setAdultGateFor('unlimited'); setAdultGateOpen(true); return; }
    setUnlimitedNotice('');
    // 「本人用无限制模型建的剧本」：开关写的是**这个剧本**的显式选择（关只关这一个）；
    // 其它剧本（官方/别人的）行为不变，仍然写全局偏好。
    if (selected && isAdultDefaultScenario(selected)) applyScenarioUnlimited(selected.id, v);
    else applyUnlimited(v);
  };

  /**
   * 成人向引导卡（聊一聊「想聊色情/情欲」→ 点「去剧情并打开『无限制模式』」）的一次性意愿。
   *
   * 用户按的按钮上就写着「打开」，所以这份意愿带到底，而不是让他进去再找一次开关：
   *   · 模型不可用 → 只提示一句，不弹年龄闸门（确认完还是用不了，等于白问一遍）；
   *   · 已过 18+   → 直接替他拨开（与用户自己拨开关写的是同一条偏好，服务端留痕逻辑不变）；
   *   · 未过 18+   → 立刻弹年龄闸门，确认后自动打开；点「未满 18」什么都不开。
   * ⚠️ 年龄闸门**一次都不能省**：这是合规红线，也是服务端硬门槛（未确认的写入会被降级为关）。
   * 必须等 unlimitedReady / adultConfirmed 查回来再走（否则「查得慢」会变成误开或误弹）；
   * 配置请求失败时 unlimitedReady=false、adultConfirmed 可能停在 null，所以先判 available 再判年龄。
   */
  const adultIntentDone = useRef(false);
  /** 这次年龄闸门是不是引导卡带出来的：决定「未满 18」的结果要不要用瞬时提示说出来（抽屉没开时那句 notice 看不到） */
  const adultGateFromIntent = useRef(false);
  useEffect(() => {
    if (!initialAdultIntent || adultIntentDone.current) return;
    if (unlimitedReady === null) return; // 还在查，等下一轮
    if (unlimitedReady === false) {
      adultIntentDone.current = true;
      showAdultToast(t('rpUnlimitedUnavailable'));
      return;
    }
    if (adultConfirmed === null) return; // 模型可用、年龄状态还没回来（同一次请求，通常同时到）
    adultIntentDone.current = true;
    if (adultConfirmed === true) {
      if (!unlimitedOn) applyUnlimited(true);
      showAdultToast(t('rpAdultIntentOn'));
      return;
    }
    adultGateFromIntent.current = true;
    setAdultGateErr(''); setAdultGateFor('unlimited'); setAdultGateOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAdultIntent, unlimitedReady, adultConfirmed]);

  // 【剧本生成用无限制模型（默认关）】
  // 为什么单独一个开关：剧本生成默认走 DeepSeek（不占账号并发池），而它的任务提示词要求
  // 「不要净化成纯情清水」、官方 DeepSeek 恰恰会净化。把选择权交给用户，而不是替他决定。
  const [scriptUnlimitedOn, setScriptUnlimitedOn] = useState<boolean>(() => getCachedPreferences()?.roleplayScriptUnlimited === true);
  /** 真正把开关落到偏好（本地缓存 + 服务端）；服务端未过 18+ 确认时会把写入降级为关，必须跟随 */
  const applyScriptUnlimited = (v: boolean) => {
    setScriptUnlimitedOn(v);
    try { const c = getCachedPreferences(); if (c) setCachedPreferences({ ...c, roleplayScriptUnlimited: v }); } catch { /* 忽略 */ }
    savePreferences({ roleplayScriptUnlimited: v }).then(r => {
      if (r.success && r.data) {
        setCachedPreferences(r.data);
        if (typeof r.data.roleplayScriptUnlimited === 'boolean') setScriptUnlimitedOn(r.data.roleplayScriptUnlimited);
        if (typeof r.data.adultConfirmed === 'boolean') setAdultConfirmed(r.data.adultConfirmed);
      }
    }).catch(() => {});
  };
  const changeScriptUnlimited = (v: boolean) => {
    if (v && unlimitedReady === false) return; // 模型没配好就别让开
    // 与剧情开关共用同一个 18+ 确认框：两个开关的资格要求一致，用户不该看到两套流程
    if (v && adultConfirmed !== true) { setAdultGateErr(''); setAdultGateFor('script'); setAdultGateOpen(true); return; }
    applyScriptUnlimited(v);
  };

  /**
   * 把「无限制模式」只落到**这个剧本**上（本人用无限制模型建的剧本专用）。
   * 服务端是权威：未过 18+ 确认时它会把 true 降级成 false 落盘，所以必须跟随返回的 unlimited，
   * 不能拿请求值去更新界面（否则又会出现「显示开着、服务端不用」）。
   * 同时把返回的整张单剧本表写回缓存，保证切剧本时读到的是最新选择。
   */
  const applyScenarioUnlimited = (scenarioId: string, v: boolean) => {
    setUnlimitedOn(v);
    setScenarioUnlimited(scenarioId, v).then(r => {
      if (r.success && r.data) {
        const c = getCachedPreferences();
        if (c) setCachedPreferences({ ...c, roleplayUnlimitedByScenario: r.data.roleplayUnlimitedByScenario });
        if (typeof r.data.adultConfirmed === 'boolean') setAdultConfirmed(r.data.adultConfirmed);
        setUnlimitedOn(r.data.unlimited === true);
      }
    }).catch(() => {});
  };

  /**
   * 这个剧本有没有「成人模式默认开」的资格：**本人**创建、且创建时用的是无限制模型。
   *
   * 服务端有同一套判定（services/roleplay.ts 的 unlimitedForScenario 第 2 层）
   * 两边必须是同一套规则，否则会出现「开关显示开着、服务端却没用」的静默错位。
   * 从「精选/玩家共创」区块进来时那份数据不带该标记（那是非本人视角），
   * 所以回查一次自己的自建剧本列表：同一个人玩自己投稿过的剧本也该算数。
   */
  function isAdultDefaultScenario(s: RoleplayScenarioInfo | null): boolean {
    if (!s) return false;
    if (s.createdWithUnlimited === true) return true;
    return customScenarios.some((c) => c.id === s.id && c.createdWithUnlimited === true);
  }

  /**
   * 这个剧本此刻**实际生效**的无限制模式（只用于开关显示与写入分流），与服务端
   * unlimitedForScenario 同序：该剧本的显式选择 > 剧本自带默认 > 全局偏好。
   * 模型没配好 / 没做过 18+ 确认时一律显示为关，服务端那一轮绝不会走成人模型。
   */
  function effectiveUnlimitedFor(s: RoleplayScenarioInfo | null, prefs: UserPreferences | null = getCachedPreferences()): boolean {
    if (unlimitedReady === false || adultConfirmed === false) return false;
    const explicit = s ? prefs?.roleplayUnlimitedByScenario?.[s.id] : undefined;
    if (typeof explicit === 'boolean') return explicit;
    if (isAdultDefaultScenario(s)) return true;
    return prefs?.roleplayUnlimited === true;
  }
  /** 当前的剧本（effect 里要用到最新值，state 在闭包里会拿到初始的 null） */
  const rpSelectedRef = useRef<RoleplayScenarioInfo | null>(null);
  useEffect(() => { rpSelectedRef.current = selected; }, [selected]);

  /**
   * 本轮剧情生成的中断句柄（2026-09-29 审查 A5-P2-3）。
   * 此前两个 AbortController 建好后**从未 abort**（文件里 0 处 .abort()），也没有卸载清理、
   * 没有「这一轮还是不是当前轮」的身份校验 → 离开页面或切换剧本后，在途的流仍会往 state 写，
   * 自动存档还会把它存到**当前选中**的剧本 id 下（等于把 A 的对话存成 B 的）。
   */
  const rpTurnAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => { rpTurnAbortRef.current?.abort(); }, []);

  /** 18+ 确认框点「我已年满 18 岁」：服务端留痕成功后，继续原本的开启动作 */
  const confirmAdultAndEnable = async () => {
    setAdultGateBusy(true);
    setAdultGateErr('');
    try {
      const r = await confirmAdult('roleplay-toggle');
      if (!r.success) { setAdultGateErr(t('adultGateFailed')); return; }
      markLocalAdultConfirmed();
      setAdultConfirmed(true);
      setAdultGateOpen(false);
      setUnlimitedNotice('');
      // 回到用户原本想开的那个开关：剧情无限制模式 / 剧本生成用无限制模型
      if (adultGateFor === 'script') {
        applyScriptUnlimited(true);
      } else if (adultGateFromIntent.current) {
        // 聊一聊引导卡带出来的：此刻用户还在列表层、没有「当前剧本」，写全局偏好
        //（他要的就是「以后照实写」，而不是某这一部的例外）
        adultGateFromIntent.current = false;
        applyUnlimited(true);
        showAdultToast(t('rpAdultIntentOn'));
      } else if (selected && isAdultDefaultScenario(selected)) {
        // 本人用无限制模型建的剧本 → 只开这一个
        applyScenarioUnlimited(selected.id, true);
      } else {
        applyUnlimited(true);
      }
    } catch {
      setAdultGateErr(t('adultGateFailed'));
    } finally {
      setAdultGateBusy(false);
    }
  };
  const changeThinkingLevel = (v: 'off' | 'high' | 'max') => {
    // max 仅 Pro/Lifetime；非 Pro 不落档，改为触发会员升级引导
    if (v === 'max' && !rpIsPro) {
      onOpenMembership?.();
      return;
    }
    setThinkingLevel(v);
    try { const c = getCachedPreferences(); if (c) setCachedPreferences({ ...c, thinkingLevel: v }); } catch { /* 忽略 */ }
    savePreferences({ thinkingLevel: v }).then(r => {
      if (r.success && r.data) setCachedPreferences(r.data);
    }).catch(() => {});
  };
  /**
   * 叙事模式与**服务端偏好**对齐（2026-09-25 C 方案）。
   *
   * 三条规则，顺序不能反：
   *   ① 服务端有值 → 以它为准（跨设备一致；本地的旧值不再作数）；
   *   ② 服务端是"还没选过"（undefined）而 localStorage 有值 → 把本地选择**迁上去一次**（老用户不丢选择）；
   *   ③ 两边都没有 → 保持默认 immersive（与改造前的默认一致）。
   * 已经把本地值迁上去之后要写一个标记，避免每次进页面都重复 PUT。
   */
  useEffect(() => {
    const MIGRATED = 'rp_narrative_style_synced';
    const cached = getCachedPreferences();
    const local = (() => { try { return localStorage.getItem('rp_narrative_style'); } catch { return null; } })();
    const server = cached?.narrativeStyle;
    if (server === 'classic' || server === 'immersive') { setNarrativeStyle(server); return; }
    // 没有缓存时先拉一次偏好（否则会把"未登录/未拉到"误当"没选过"，把本地值推上去）
    const decide = (prefs: UserPreferences | null) => {
      const s = prefs?.narrativeStyle;
      if (s === 'classic' || s === 'immersive') { setNarrativeStyle(s); return; }
      let synced = false;
      try { synced = localStorage.getItem(MIGRATED) === '1'; } catch { /* 忽略 */ }
      if ((local === 'classic' || local === 'immersive') && !synced) {
        savePreferences({ narrativeStyle: local }).then(r => {
          if (r.success && r.data) setCachedPreferences(r.data);
          try { localStorage.setItem(MIGRATED, '1'); } catch { /* 忽略 */ }
        }).catch(() => {});
      }
    };
    if (cached) decide(cached);
    else getPreferences().then(r => decide(r.success && r.data ? r.data : null)).catch(() => decide(null));
  }, []);
  // 偏好未缓存时，从后端拉取一次，保证开关显示与已保存设置一致
  useEffect(() => {
    if (getCachedPreferences()) return;
    getPreferences().then(r => {
      if (r.success && r.data) {
        setCachedPreferences(r.data);
        if (typeof r.data.roleplayInnerMonologueEnabled === 'boolean') setInnerOn(r.data.roleplayInnerMonologueEnabled);
        if (typeof r.data.roleplayAutoSceneArt === 'boolean') setAutoArtOn(r.data.roleplayAutoSceneArt);
        // 开关按**当前剧本**的有效值重算（含「本人用无限制模型建的剧本默认开」）：
        // 不能直接照搬全局偏好，深链进来时 enterChat 可能跑在这之前，会把剧本默认开覆盖掉
        setUnlimitedOn(effectiveUnlimitedFor(rpSelectedRef.current, r.data));
        // 叙事模式以服务端为准（同一份偏好，冷启动时也会走到这里）
        if (r.data.narrativeStyle === 'classic' || r.data.narrativeStyle === 'immersive') setNarrativeStyle(r.data.narrativeStyle);
        if (r.data.thinkingLevel === 'off') setThinkingLevel('off');
        else if (r.data.thinkingLevel === 'max' && rpIsPro) setThinkingLevel('max');
        else setThinkingLevel('high');
      }
    }).catch(() => {});
  }, []);
  // 【重新生成（**任意一条** AI 回复，可选填反馈沉淀为偏好）】
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  /** 要重写的是第几条消息（null = 弹窗未打开）；每条 AI 回复各自可以重生成，不再只有最后一条 */
  const [regenerateTarget, setRegenerateTarget] = useState<number | null>(null);
  const [regenerateFeedback, setRegenerateFeedback] = useState('');
  const [regenerating, setRegenerating] = useState(false);
  /**
   * 「续写中」，服务端正在把上一条**没写完**的回复接着写完（自动续写或用户点「续写」）。
   * 与 sending / regenerating 分开：它不改历史结构（只让同一条继续往下长），
   * 但同样要占住输入框与按钮，避免用户以为是卡死而重复发送。
   */
  const [continuing, setContinuing] = useState(false);
  /**
   * A 方案（生成后重复闸）：服务端判到本条回复复读了历史片段，正在重写一版。
   * 重写期间服务端**不再下发 delta**（避免用户看到两段），最终文本由 done.reply 覆盖定稿。
   * 这里只为把"卡住"和"正在重写"区分开，否则用户会以为请求挂了。
   */
  const [rewriting, setRewriting] = useState(false);
  /**
   * 「编辑重发」（2026-09，用户拍板 1B + 2A）：正在改写的是第几条消息（null = 不在编辑态）。
   *
   * 口径（别顺手放宽）：只允许改**最后一条用户消息**（判据在 `canEditAt`）。
   * 因为只改最后一句，被作废的那一支最多只有 1 条回复 → 用「版本 + 冻结尾巴」就能完整保留
   *（`startEditResend`/`switchUserBranchIn`），不需要对话树，也不需要在弹窗里确认「将清掉其后 N 条」。
   *
   * 编辑态下输入栏预填原文；发送走 `editResend()`；取消则把进编辑态前的草稿还回去。
   */
  const [editTarget, setEditTarget] = useState<number | null>(null);
  /** 进编辑态前的输入框草稿（取消编辑要原样还回去，不能把用户正在写的话吃掉） */
  const editDraftBackupRef = useRef('');
  /**
   * 换剧本 / 回列表时退出编辑态。
   * 为什么必须清：`editTarget` 记的是「第几条」这个**下标**，跨剧本后会指到另一个剧本的历史上
   *（重发就会改写别的剧情，这类下标越界事故在这个文件里出过，宁可显式清掉）。
   */
  useEffect(() => {
    setEditTarget(null);
    editDraftBackupRef.current = '';
  }, [selected?.id, stage]);
  /**
   * 「这条写完了没有」的判定缓存（内容变了才重算）。
   * 为什么需要：流式每个 delta 都会重渲染整个消息列表，而 200 条历史里只有最后一条在变，
   * 每次渲染都对全部历史跑一遍括号配对纯属浪费。key = 长度 + 末尾 24 字符（够区分同屏消息）。
   */
  const halfCacheRef = useRef<Map<string, boolean>>(new Map());
  // 这一回合没接上（失败提示；**不是**角色台词）：'TIMEOUT' | 'NETWORK' | 其它 code；null = 正常
  const [sendFailed, setSendFailed] = useState<string | null>(null);
  /**
   * 上游并发排队信息（null = 没在排队）。
   * 去限制模型按「并发单元」计价：27B 每请求扣 2 单元、账号共 4 单元 → 约 2 路，
   * 第 3 个及以后会在本地闸门里等。没有这个提示时用户只看到一个不动的 spinner，像卡死；
   * 有了它就能明确说清「前面还有 N 个正在生成」。服务端在入队那一刻发一次（不轮询）。
   */
  const [queueInfo, setQueueInfo] = useState<{ ahead: number; waiting: number; running: number; maxConcurrent: number } | null>(null);
  // 剧情配音：新一轮回复定稿后预载音频（只在开启配音时真正发请求；失败静默，不影响剧情）。
  // 放在 regenerating 声明之后，避免闭包引用未初始化的块级变量。
  useEffect(() => {
    if (!rpVoiceEnabled || sending || regenerating) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || !last.content.trim()) return;
    rpVoicePrepare(String(messages.length - 1), last.content);
  }, [messages, sending, regenerating, rpVoiceEnabled, rpVoicePrepare]);
  // 【AI 辅助聊天：为玩家生成候选下一句（每次生成消耗 1 条聊天额度）】
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestError, setSuggestError] = useState('');
  const [chatQuota, setChatQuota] = useState<QuotaInfo | null>(null);
  /** 判重退费：本回合因与上一段重复而免扣额度。⚠️ 只做 UI 提示，绝不写进 messages（红线 6） */
  const [repeatFreeNotice, setRepeatFreeNotice] = useState(false);
  /** 判重退费：本次建议与上一批重复、未扣额度 */
  const [suggestDuplicate, setSuggestDuplicate] = useState(false);
  const rpIsPro = chatQuota ? (chatQuota.plan === 'pro' || !!chatQuota.lifetime) : getCachedPlan() === 'pro';

  // 【关键时刻自动画面（Pro 权益，默认关）】
  // 只在「高压/亲密/承诺/和好/离别」这几幕自动补一张专属画面；同一剧本同一幕只尝试一次（失败也静默）。
  const rpAutoTriedRef = useRef<Set<string>>(new Set());
  const changeAutoArt = (next: boolean) => {
    if (!rpIsPro) { onOpenMembership?.(); return; }   // 非 Pro 不落档，改为会员升级引导（与深度思考同口径）
    setAutoArtOn(next);
    try { const c = getCachedPreferences(); if (c) setCachedPreferences({ ...c, roleplayAutoSceneArt: next }); } catch { /* 忽略 */ }
    savePreferences({ roleplayAutoSceneArt: next }).then(r => {
      if (r.success && r.data) setCachedPreferences(r.data);
    }).catch(() => {});
  };
  useEffect(() => {
    if (!selected || !autoArtOn || !rpIsPro) return;
    if (sending || regenerating) return;                     // 等回复定稿
    if (!isKeyMomentTheme(rpSceneTheme)) return;             // 只有关键时刻
    if (rpSceneArt.url || rpSceneArt.loading) return;        // 已有画面/正在生成
    const key = `${selected.id}:${rpSceneTheme}`;
    if (rpAutoTriedRef.current.has(key)) return;             // 同一剧本同一幕只尝试一次
    rpAutoTriedRef.current.add(key);
    void (async () => {
      setRpSceneArt(s => ({ ...s, loading: true, msg: null }));
      try {
        const r = await generateSceneArt(selected.id, rpSceneTheme || DEFAULT_THEME, { auto: true });
        if (r.success && r.data?.url) setRpSceneArt(s => ({ ...s, url: r.data!.url as string, loading: false, msg: t('rpSceneArtAuto') }));
        else setRpSceneArt(s => ({ ...s, loading: false })); // 自动失败静默，不打扰剧情
      } catch {
        setRpSceneArt(s => ({ ...s, loading: false }));
      }
    })();
  }, [selected, autoArtOn, rpIsPro, sending, regenerating, rpSceneTheme, rpSceneArt.url, rpSceneArt.loading]);

  // 会员档位到位后，把「最大」档显示与持久化偏好对齐（Pro 恢复 max；非 Pro 保持 high）
  useEffect(() => {
    if (!chatQuota) return;
    const pro = chatQuota.plan === 'pro' || !!chatQuota.lifetime;
    if (pro) {
      const c = getCachedPreferences();
      if (c?.thinkingLevel === 'max') setThinkingLevel('max');
      else if (c?.thinkingLevel === 'off') setThinkingLevel('off');
      else setThinkingLevel('high');
    } else {
      setThinkingLevel(prev => prev === 'max' ? 'high' : prev);
    }
  }, [chatQuota]);

  // 【剧本点赞（乐观更新 + 服务端确认；likeState 覆盖服务端初始 likes/likedByMe）】
  const [likeState, setLikeState] = useState<Record<string, { liked: boolean; count: number }>>({});
  const likingIds = useRef(new Set<string>());
  const likeInfo = (s: RoleplayScenarioInfo) => likeState[s.id] || { liked: !!s.likedByMe, count: s.likes || 0 };
  // 点赞后立即实时重排：按当前有效点赞数从高到低排序，组内生效
  const sortedScenarios = useMemo(() => {
    const cp = [...scenarios];
    cp.sort((a, b) => likeInfo(b).count - likeInfo(a).count);
    return cp;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarios, likeState]);
  const toggleLike = async (s: RoleplayScenarioInfo) => {
    if (likingIds.current.has(s.id)) return; // 防连点（请求在途）
    likingIds.current.add(s.id);
    const prev = likeInfo(s);
    const next = { liked: !prev.liked, count: prev.count + (prev.liked ? -1 : 1) };
    setLikeState(st => ({ ...st, [s.id]: next }));
    try {
      const r = await likeRoleplayScenario(s.id);
      if (r.success && r.data) {
        setLikeState(st => ({ ...st, [s.id]: { liked: r.data!.liked, count: r.data!.count } }));
      } else {
        setLikeState(st => ({ ...st, [s.id]: prev }));
      }
    } catch {
      setLikeState(st => ({ ...st, [s.id]: prev }));
    } finally {
      likingIds.current.delete(s.id);
    }
  };
  // 【跨端实时同步点赞（SSE）：任何用户点赞/取消都会推送最新计数，更新后触发重排】
  useEffect(() => {
    const es = new EventSource('/api/roleplay/likes/stream');
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data || '{}');
        const id = String(msg?.scenarioId || '');
        const count = Number(msg?.count);
        if (id && Number.isFinite(count) && count >= 0) {
          setScenarios(prev => prev.map(s => (s.id === id ? { ...s, likes: count } : s)));
          setLikeState(prev => (prev[id] ? { ...prev, [id]: { ...prev[id], count } } : prev));
        }
      } catch { /* 忽略 */ }
    };
    return () => es.close();
  }, []);
  // 预取 AI 文游（千世书）分包：进入角色扮演页就在后台加载，点「AI 文游」标签时不用再等
  useEffect(() => {
    import('./WenyouPage').catch(() => {});
  }, []);
  // 自建剧本（登录用户私有）
  const [customScenarios, setCustomScenarios] = useState<CustomScenarioInfo[]>([]);
  // 玩家共创·精选（运营精选的自建剧本，任何人可玩）
  const [playerCreated, setPlayerCreated] = useState<CustomScenarioInfo[]>([]);
  // 玩家共创·一般（运营已通过的公开自建剧本，任何人可玩）
  const [community, setCommunity] = useState<CustomScenarioInfo[]>([]);
  // 搜索：query 非空时展示搜索结果（后端加权），标签 chips 快速筛选
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<(RoleplayScenarioInfo & { matched?: string[] })[] | null>(null); // null=未搜索
  // 注：2026-10-01 曾加过「多角色/单角色」筛选，双模式落地后它不再区分任何东西（每部剧本都有两条线）
  // → 已移除；改用卡片上的「群像可选」角标做提示。列表仍按点赞排序。
  const [searching, setSearching] = useState(false);
  const [tagData, setTagData] = useState<RoleplayTagData | null>(null); // 热门 + 分组标签
  const [tagFilter, setTagFilter] = useState(''); // 全部标签页内快速筛选
  const [customForm, setCustomForm] = useState({ title: '', aiName: '', aiPersona: '', background: '', opening: '', avatar: '', chatBackground: '' });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [editingCustom, setEditingCustom] = useState<CustomScenarioInfo | null>(null); // 非空=正在编辑某自建剧本
  // 编辑基线：进入编辑态时的字段原值，用于「已修改」标注与「恢复原样」（覆盖 AI 回填与手动改动）
  const [customBaseline, setCustomBaseline] = useState<{ title: string; aiName: string; aiPersona: string; background: string; opening: string } | null>(null);
  // 【AI 辅助创建剧本：灵感/整份剧本 → 草稿（标题/角色名/人设/背景/开场），每次生成消耗 1 条聊天额度】
  // 输入**不限字数**（用户可能直接把写好的整份剧本贴进来）；输入框随内容自动增高，长文也看得全
  const [draftIdea, setDraftIdea] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState('');
  const [draftOk, setDraftOk] = useState(false);
  const draftIdeaRef = useRef<HTMLTextAreaElement>(null);
  // 该输入框随内容自动增高（上限 320px）：用户可能贴进整份剧本，得多给几行视野（超出后在框内滚动）
  useEffect(() => {
    const el = draftIdeaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 320) + 'px';
  }, [draftIdea, stage]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 剧情滚动贴底守卫：用户上滑阅读时不拽回底部（对齐聊一聊做法）
  const stickToBottomRef = useRef(true);
  const rpRafRef = useRef<number | null>(null);
  // 区分「用户真实滚动」与「程序化自动滚动」：只有用户真的在滚动时才允许改变跟随意图。
  // 否则程序化 el.scrollTo 贴底产生的 scroll 事件会把 stickToBottom 翻回 true，
  // 流式时贴底处上滑会立刻被自动滚动拽回（用户「拉不上去」）。
  const rpUserScrollingRef = useRef(false);
  const rpUserScrollTimerRef = useRef<number | null>(null);
  const rpMarkUserScrolling = () => {
    rpUserScrollingRef.current = true;
    if (rpUserScrollTimerRef.current) window.clearTimeout(rpUserScrollTimerRef.current);
    rpUserScrollTimerRef.current = window.setTimeout(() => { rpUserScrollingRef.current = false; }, 180);
  };
  const [rpAtBottom, setRpAtBottom] = useState(true); // 是否贴近底部（决定「回到最新」按钮是否出现）
  const rpLang = getLang() === 'en' ? 'en' : getLang() === 'zh-TW' ? 'zh-TW' : 'zh';
  // 角色名自定义状态（按剧本加载/保存）
  const [aiName, setAiName] = useState('');
  const [userName, setUserName] = useState('');
  useEffect(() => {
    if (!selected) return;
    const saved = loadRpNames(selected.id);
    setAiName(saved?.ai ?? '');
    setUserName(saved?.user ?? '');
  }, [selected]);

  // ===== 剧情 → 聊一聊 跨模式桥（B 方案：桥①卡壳救援 / 桥②出戏保护 / 桥③落幕余音）=====
  // 设计稿：《剧情引流聊一聊-B方案设计稿.md》；判定规则纯函数在 src/lib/rpBridge.ts（有单测）。
  // 三条硬约束：① 只在自然停顿点出现（流式中/输入中绝不出现）② 频次预算与正向桥共用（72h 一次，连拒 2 次永久静默）
  //            ③ 只把上下文放进**用户自己的草稿**，绝不自动发送，也绝不写进 messages（红线 6）。
  const [bridgeKind, setBridgeKind] = useState<null | 'stuck' | 'ooc'>(null);
  const [afterglow, setAfterglow] = useState(false); // 桥③：刚离开对局时，在剧本设定页给一条轻提示
  const bridgeShownRef = useRef(false);        // 本次进入剧情只展示一次（三种桥共用同一预算）
  const bridgeStuckRef = useRef(false);        // 「求助过但没选中」信号
  const bridgeActivityRef = useRef(Date.now()); // 最后一次输入/收到回复的时间（空闲判定）

  const tryShowBridge = (kind: 'stuck' | 'ooc') => {
    if (bridgeShownRef.current) return;
    const verdict = canShowBridge({
      enabled: bridgeEnabled(),
      now: Date.now(),
      shownThisSession: bridgeShownRef.current,
      budget: readBridgeBudget(),
    });
    if (!verdict.show) return;
    bridgeShownRef.current = true;
    markBridgeShown();
    recordBridgeEvent('shown', kind);
    setBridgeKind(kind);
  };

  // 每 15s 检查一次：只有「自然停顿 + 确实卡了」才提议，且必须已演够 BRIDGE_MIN_TURNS 轮
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (stage !== 'chat' || !selected || bridgeShownRef.current) return;
      const busy = sending || regenerating;
      if (busy) return;
      const turns = messages.filter((m) => m.role === 'user').length;
      if (turns < BRIDGE_MIN_TURNS) return;
      const idle = isIdleEnough({
        lastActivityAt: bridgeActivityRef.current,
        now: Date.now(),
        inputEmpty: !input.trim(),
        busy,
      });
      if (bridgeStuckRef.current || idle) tryShowBridge('stuck');
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [stage, selected, sending, regenerating, messages, input]);

  // 输入/收到回复即刷新活动时间（用户正在忙 → 不提议）
  useEffect(() => { bridgeActivityRef.current = Date.now(); }, [input, messages.length]);

  const buildRpBridgeSeed = (trigger: BridgeTrigger): BridgeSeed => {
    const aName = aiName.trim() || selected?.ai.name || '';
    const uName = userName.trim() || selected?.user.name || '';
    // 只带「我从哪来」这一句：不带剧情正文（避免把剧情内容复制进另一个模式，也避免替用户立意图）
    return {
      draft: buildBridgeDraft(t('rpBridgeDraftPreface', { title: selected?.title || '', userName: uName, aiName: aName })),
      trigger,
      scenarioId: selected?.id || '',
      scenarioTitle: selected?.title || '',
      aiName: aName,
      kind: 'rp',
    };
  };

  const goChatFromBridge = () => {
    const trigger = bridgeKind === 'ooc' ? 'ooc' : 'stuck';
    const seed = buildRpBridgeSeed(trigger);
    recordBridgeEvent('clicked', trigger);
    setBridgeKind(null);
    onGoChat?.(seed);
  };

  /**
   * 跨模式桥的**用户主动入口**（B 方案 A 项）：剧情输入栏额度行右侧那个常显小链接。
   * 与三条「系统主动提示」不同，它是用户自己走进去的：**不消耗、也不受** 72h 预算约束，
   * 不调用 markBridgeShown（那是「我们打扰了用户一次」的记账）。
   */
  const goChatFromPull = () => {
    const seed = buildRpBridgeSeed('pull');
    recordBridgeEvent('clicked', 'pull');
    onGoChat?.(seed);
  };

  /**
   * 把 TA 加到聊一聊（方案 A1，`剧情角色接入聊一聊-方案.md`）：确认卡 → POST import-story（服务端幂等）。
   * 带过去：人设 / 头像 / 剧里的称呼 / 你们在这段剧情里的共同经历（摘要 + 场面片段）。
   * 不带过去：剧情原文（只在聊到相关话题时被**按需召回**）、无限制模式、剧情叙事规则与额度口径。
   */
  const doImportToChat = async () => {
    if (!selected) return;
    if (!authUser) { onNeedLogin(); return; }
    setToChatBusy(true);
    setToChatErr(null);
    try {
      const r = await importStoryCharacter({
        scenarioId: selected.id,
        aiName: aiName.trim() || undefined,
        userName: userName.trim() || undefined,
      });
      if (r.success && r.data) {
        // 交接：缓存「上一次聊天角色」+ 指定打开该角色 → 上层切到聊一聊（ChatPage 挂载时读一次即清空）
        setLastChatChar(r.data.character);
        setPendingChatCharId(r.data.character.id);
        setToChatOpen(false);
        onOpenChat?.();
      } else {
        setToChatErr(r.error || t('rpToChatFailed'));
      }
    } catch {
      setToChatErr(t('rpToChatFailed'));
    } finally {
      setToChatBusy(false);
    }
  };

  /** 桥③ 落幕余音：点了「去和小愈聊聊」 */
  const goChatFromAfterglow = () => {
    const seed = buildRpBridgeSeed('scene_end');
    recordBridgeEvent('clicked', 'scene_end');
    setAfterglow(false);
    onGoChat?.(seed);
  };

  const dismissBridge = (kind: 'stuck' | 'ooc') => {
    if (kind === 'ooc') { setBridgeKind(null); return; } // 「继续演」不是拒绝引流，不消耗拒绝额度
    markBridgeDismissed(); // 累计 2 次 → 永久静默（下次连卡片都不再出现）
    bridgeShownRef.current = true;
    setBridgeKind(null);
  };

  /**
   * 离开对局（回到剧本设定页）时，给一条「落幕余音」。
   * 只在**真的演过几轮**、且本会话还没展示过任何桥、且全局预算允许时才出现。
   */
  const leaveChat = () => {
    const turns = messages.filter((m) => m.role === 'user').length;
    if (turns >= BRIDGE_MIN_TURNS && !bridgeShownRef.current) {
      const verdict = canShowBridge({ enabled: bridgeEnabled(), now: Date.now(), shownThisSession: false, budget: readBridgeBudget() });
      if (verdict.show) {
        bridgeShownRef.current = true;
        markBridgeShown();
        recordBridgeEvent('shown', 'scene_end');
        setAfterglow(true);
      }
    }
    setBridgeKind(null);
    setStage('detail');
  };

  /**
   * 【手机返回键 / 屏幕边缘侧滑 / 浏览器后退：剧情模式内**逐级回退**】
   * 需求（2026-09-19 用户原话）：「剧情模式的每一层级，手机上的回退功能都应该是让它回退到上一个层级
   * 而不是全部到小愈主界面」。改之前这里没有注册过处理器，Home 的 popstate 一收到返回就把整个
   * 剧情模式关掉（`closeRoleplay()`）→ 不管在哪一层都跳回小愈主界面。
   *
   * 层级与「弹层也算一层」的优先级全在纯函数 `resolveRpBack()`（`src/lib/rpDeepBack.ts`，有单测钉死）；
   * 这里只负责落地：弹层 → 关掉最上面那个；对局 → `leaveChat()`（**必须与页内 ← 同源**，
   * 它还要记「落幕余音」桥的账）；子页 → 回列表；列表 → 返回 false 交回 Home 关掉本模块（= 小愈主界面）；
   * 文游 → 返回 false，让文游子树自己的处理器先把内部层级退完再退出。
   *
   * ⚠️ 注册必须放在下面各个 `if (stage === …) return` 之前（Hooks 规则）。
   * 处理器**只注册一次**（注册顺序 = 挂载顺序 = 嵌套深度）：更深的东西后注册、先被问到
   * 文游子树（src/wenyou/App.tsx）与自建剧本里的图片裁剪弹层都是这么接进来的。
   * 层级/弹层这些会变的值走 `rpBackRef` 快照（每次渲染后刷新），`leaveChat` 走 ref，
   * 这样既不重注册、也不会拿到旧的 `stage` / `messages`。
   */
  const leaveChatRef = useRef(leaveChat);
  useEffect(() => { leaveChatRef.current = leaveChat; });
  const rpBackRef = useRef<{ stage: RpStage; open: RpOverlay[] }>({ stage, open: [] });
  useEffect(() => {
    const open: RpOverlay[] = [];
    if (adultGateOpen && !adultGateBusy) open.push('adultGate'); // 正在提交确认时不关，别把半途的确认打断
    if (rpCoachOpen) open.push('coach');
    if (bgmOpen) open.push('bgm');
    if (shareOpen) open.push('share');
    if (prefOpen) open.push('pref');
    if (regenerateOpen) open.push('regenerate');
    if (confirmRestart) open.push('confirmRestart');
    if (storyInfoOpen) open.push('storyInfo');
    if (tipOpen) open.push('tip');
    if (rpMoreOpen) open.push('more');
    rpBackRef.current = { stage, open };
  });
  /**
   * 每进一层补压一条**自己的**历史条目（`xiaoyuRp: rank`）。
   * ⚠️ 实测教训（2026-09-19 首轮验证）：历史里只有 Home 那一条剧情模式条目时，返回键**只有第一次**
   * 是同文档回退（能被 popstate 接到），第二次就跨文档了，浏览器直接离开小愈。
   * 逐层压条目之后：对局 → 设定页 → 列表 → 小愈主界面 各消耗一次返回，第 5 次才离开站点。
   */
  useEffect(() => {
    const target = RP_STAGE_RANK[stage] ?? 0;
    let cur = rpEntryRank();
    while (cur < target) {
      cur += 1;
      try {
        window.history.pushState(
          { ...(window.history.state || {}), xiaoyuRp: cur },
          '',
          window.location.pathname + window.location.search,
        );
      } catch { break; }
    }
  }, [stage]);
  /** 「上一层」的落地（供 popstate 处理器与页内 ← 共用；决策见 resolveRpBack） */
  const applyRpUp = (d: ReturnType<typeof resolveRpBack>): void => {
    if (d.kind === 'leaveChat') { leaveChatRef.current(); return; }
    setStage('list'); // goList（其余分支上面已分流）
  };
  /**
   * 页内「上一层」统一入口（各层左上角 ←）：**优先交给浏览器后退**，由 popstate 处理器做层级变更
   * 页内 ← 与手机返回键就永远是同一条路径，不会各自漂移；只有历史里确实没有本层条目时才直接改状态。
   */
  const rpGoUp = useCallback(() => {
    const rank = RP_STAGE_RANK[stage] ?? 0;
    if (rank > 0 && rpEntryRank() > 0) {
      try { window.history.back(); return; } catch { /* 历史 API 不可用 → 直接改状态 */ }
    }
    const d = resolveRpBack(stage, []);
    if (d.kind === 'goList' || d.kind === 'leaveChat') applyRpUp(d);
    else onBack(); // 深层但历史不可用 / 落地层：直接退出到小愈主界面
  }, [stage, onBack]);
  useEffect(() => pushDeepBackHandler(() => {
    const snap = rpBackRef.current;
    const d = resolveRpBack(snap.stage, snap.open);
    switch (d.kind) {
      case 'closeOverlay':
        if (d.overlay === 'adultGate') setAdultGateOpen(false);
        else if (d.overlay === 'coach') finishRpCoach(); // 与引导气泡自己的「跳过」同义：关掉并记已看过，别下次又弹
        else if (d.overlay === 'bgm') setBgmOpen(false);
        else if (d.overlay === 'share') setShareOpen(false);
        else if (d.overlay === 'pref') setPrefOpen(false);
        else if (d.overlay === 'regenerate') setRegenerateOpen(false);
        else if (d.overlay === 'confirmRestart') setConfirmRestart(false);
        else if (d.overlay === 'storyInfo') setStoryInfoOpen(false);
        else if (d.overlay === 'tip') setTipOpen(false);
        else if (d.overlay === 'more') setRpMoreOpen(false);
        /**
         * 弹层自己没有历史条目，但这次返回已经把**本层条目**弹掉了 → 立刻补压一条同层条目，
         * 否则下一层会被提前吃掉：实测漏了这一步，第 2 次返回就直接离开了站点。
         */
        try {
          window.history.pushState(
            { ...(window.history.state || {}), xiaoyuRp: RP_STAGE_RANK[snap.stage] ?? 0 },
            '',
            window.location.pathname + window.location.search,
          );
        } catch { /* 忽略 */ }
        return true;
      case 'leaveChat':
        leaveChatRef.current();
        return true;
      case 'goList':
        setStage('list');
        return true;
      default:
        // 'delegate'（文游子树自己管）/ 'exit'（列表层）：不消费 → 交给下一个处理器，或由 Home 关掉本模块
        return false;
    }
  }), [finishRpCoach]); // finishRpCoach 是 useCallback([]) → 常量，等于「只注册一次」

  // 用户在对局里说了「不知道怎么说 / 帮我想想」这类求助 → 记下信号（真正的展示等停顿点）
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && detectStuck(last.content)) bridgeStuckRef.current = true;
  }, [messages]);

  // 桥② 出戏保护：用户**明说**「不演了 / 说点真的 / 这是我现实里的事」时才出现。
  // 只认显式元话语（Tier A），不做任何猜测，也绝不替用户判断情绪或危机（那是 safety.ts 的职责）。
  const bridgeOocRef = useRef(false);
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && detectOocMeta(last.content)) bridgeOocRef.current = true;
  }, [messages]);
  // 等这一轮回复收尾（不在流式里插卡），再出现；不受「演够几轮」限制（第一轮就想说真心话也该被接住）
  useEffect(() => {
    if (!bridgeOocRef.current || stage !== 'chat' || sending || regenerating) return;
    bridgeOocRef.current = false;
    tryShowBridge('ooc');
  }, [messages, sending, regenerating, stage]);

  // 推送深链：若指定 initialScenarioId 则直接进入该剧本。
  // - 官方剧本走「快速通道」：只取目标剧本（不下载完整列表），并行拉会话，更快
  // - 自建/投稿剧本（custom_*）：仍走完整列表加载后进入
  // - 无深链：正常全量加载（供列表/详情用）
  const scenarioAutoLinked = useRef(false);
  useEffect(() => {
    if (!initialScenarioId) {
      getRoleplayScenarios(rpLang).then(r => { if (r.success && Array.isArray(r.data)) setScenarios(r.data); }).finally(() => setLoading(false));
      return;
    }
    if (initialScenarioId.startsWith('custom_')) {
      getRoleplayScenarios(rpLang).then(r => {
        if (r.success && Array.isArray(r.data)) {
          setScenarios(r.data);
          if (!scenarioAutoLinked.current) {
            const target = r.data.find(s => s.id === initialScenarioId);
            if (target) void enterChat(target);
            scenarioAutoLinked.current = true;
          }
        }
      }).finally(() => setLoading(false));
      return;
    }
    // 官方剧本快速通道
    getRoleplayScenario(initialScenarioId, rpLang).then(sr => {
      if (sr.success && sr.data && !scenarioAutoLinked.current) {
        const target = sr.data;
        scenarioAutoLinked.current = true;
        void enterChat(target);
      }
    }).finally(() => setLoading(false));
    // 后台补全完整列表（返回列表视图用），不阻塞深链
    getRoleplayScenarios(rpLang).then(r => { if (r.success && Array.isArray(r.data)) setScenarios(r.data); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpLang, initialScenarioId]);

  // 加载标签数据（热门 + 分组）
  useEffect(() => {
    getRoleplayTags(rpLang).then(r => { if (r.success && r.data) setTagData(r.data); }).catch(() => {});
  }, [rpLang]);

  // 搜索：输入防抖 300ms 调后端加权搜索；清空恢复分组视图
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) { setSearchResults(null); setSearching(false); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      searchRoleplayScenarios(q, rpLang).then(r => {
        if (r.success && Array.isArray(r.data)) setSearchResults(r.data);
        else setSearchResults([]);
      }).catch(() => setSearchResults([])).finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, rpLang]);

  // 登录用户加载自己的自建剧本
  useEffect(() => {
    if (!authUser) { setCustomScenarios([]); return; }
    listCustomRoleplay(rpLang).then(r => { if (r.success && Array.isArray(r.data)) setCustomScenarios(r.data); }).catch(() => {});
  }, [authUser, rpLang]);

  // 玩家共创·精选（运营精选的公开自建剧本）
  useEffect(() => {
    getFeaturedRoleplay(rpLang).then(r => { if (r.success && Array.isArray(r.data)) setPlayerCreated(r.data); }).catch(() => {});
  }, [rpLang]);
  // 玩家共创·一般（运营已通过的公开自建剧本）
  useEffect(() => {
    getCommunityRoleplay(rpLang).then(r => { if (r.success && Array.isArray(r.data)) setCommunity(r.data); }).catch(() => {});
  }, [rpLang]);

  const updateRPScrollState = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < 80;
    setRpAtBottom(nearBottom);
    // 只有「用户真实滚动」才能改变跟随意图；程序化自动滚动（el.scrollTo 贴底）不改变，
    // 否则流式时贴底处上滑会被自动滚动拽回，用户拉不上去。
    if (rpUserScrollingRef.current) stickToBottomRef.current = nearBottom;
  };
  const requestRPScrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    if (rpRafRef.current !== null) return; // 本帧已有滚动请求
    rpRafRef.current = requestAnimationFrame(() => {
      rpRafRef.current = null;
      if (!stickToBottomRef.current) return; // 等待期间用户已上滑 → 放弃，避免拽回
      if (rpUserScrollingRef.current) return; // 用户正在拖拽/滚动：不与用户抢，等用户停下来再决定
      const el = scrollRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior });
    });
  };
  // 回到最新：出现「回到最新」按钮时点击，重新吸底
  const scrollToLatest = () => {
    stickToBottomRef.current = true;
    setRpAtBottom(true);
    requestRPScrollToBottom('smooth');
  };
  // 流式回复只原地更新最近一条 assistant 的 content（messages.length 不变），
  // 因此必须额外依赖「最后一条消息的长度」，否则流式期间文字变长时不会自动跟随。
  // ⚠️ 2026-09-17 加固：这里原来直接读 `.content.length`，只要历史里有一条缺 content 的脏数据
  // （旧版本写入 / localStorage 被改坏），这个**每次渲染都会执行**的表达式就抛错，
  // 而全站当时没有 ErrorBoundary → 整页白屏。改为对非字符串安全取值。
  const rpLastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const rpLastMsgLen = typeof rpLastMsg?.content === 'string' ? rpLastMsg.content.length : 0;
  useEffect(() => {
    if (stage !== 'chat') return;
    if (!stickToBottomRef.current) return; // 用户在上滑阅读，别打扰
    requestRPScrollToBottom(sending || regenerating ? 'auto' : 'smooth');
  }, [messages.length, rpLastMsgLen, sending, regenerating, stage]);
  // 卸载时清除「用户滚动」判定定时器，避免卸载后回调写 ref
  useEffect(() => () => {
    if (rpUserScrollTimerRef.current) window.clearTimeout(rpUserScrollTimerRef.current);
  }, []);

  // AI 辅助选项展开时会压缩聊天可视区，强制吸底，避免最近几条消息被遮住
  useEffect(() => {
    if (stage !== 'chat') return;
    if (!suggestLoading && suggestions.length === 0) return;
    stickToBottomRef.current = true;
    setRpAtBottom(true);
    requestRPScrollToBottom('auto');
  }, [suggestLoading, suggestions.length, stage]);

  // 剧本页面切换（intro/list/detail/custom/tags/chat）回到页面顶部，避免新页面「卡在中间」
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [stage]);

  /**
   * 剧情会话自动保存（退出后回来可继续；登录用户跨设备同步）。
   *
   * ⚠️ 2026-09-18：改成**串行 + 最新优先**（`createSerialSaveQueue`），以前是「状态一变就并发送一次
   * 整份历史」，于是 ①流式打字期间会重复发几十次一模一样的内容（每次都要整份重写服务端记录），
   * ②更旧的请求可能晚于更新的请求落盘，把新内容盖回去（线上日志抓到过：2 条的旧状态落在 3 条新状态之后）。
   * 现在同一时刻只有一个写请求在途，期间只保留最新一份，收尾再补写一次。
   */
  const saveQueueRef = useRef<ReturnType<typeof createSerialSaveQueue<{ id: string; mode: RoleplayMode; msgs: RoleplayMessage[] }>> | null>(null);
  useEffect(() => {
    if (stage !== 'chat' || !selected) return;
    if (!saveQueueRef.current) {
      saveQueueRef.current = createSerialSaveQueue<{ id: string; mode: RoleplayMode; msgs: RoleplayMessage[] }>(
        (job) => saveSession(job.id, job.mode, job.msgs),
      );
    }
    // payload 带上剧本 id + 模式：切剧本/切模式时，排队中的尾状态不会写进另一部剧本或另一条线
    saveQueueRef.current.enqueue({ id: selected.id, mode: rpMode, msgs: messages });
  }, [messages, stage, selected, rpMode]);

  // 进入剧本详情时检查是否有可继续的剧情（登录用户查后端，游客查本地）
  // 依赖 stage：退出聊天回到详情时 selected 未变，需在 stage 变为 detail 时重新检查 hasSaved
  useEffect(() => {
    if (!selected || stage !== 'detail') return;
    let alive = true;
    // 「有进行中的剧情」按**当前选中的模式**判定：单角色有档但多角色没档时，多角色应显示「开始」
    loadSession(selected.id, rpMode).then(saved => {
      // ⚠️ 2026-09-17 修复：loadSession 现在**总是返回数组**（无会话 = `[]`，见 stripFallbackBubbles），
      // 所以 `saved != null` 恒为真 → 每部剧本（含从没演过的）都显示「继续剧情 + 有进行中的剧情」。
      // 必须按长度判断：空数组 = 没有会话。
      if (alive) setHasSaved(hasResumableSession(saved));
    });
    return () => { alive = false; };
  }, [selected, stage, rpMode]);

  const enterChat = async (s: RoleplayScenarioInfo, opts?: { gesture?: boolean; mode?: RoleplayMode }) => {
    if (opts?.gesture) { bgm.markUserGesture(); bgm.tryPlay(); } // 用户点击进入 → 允许出声；详情页配乐被浏览器拦下时在此手势续播
    const mode: RoleplayMode = opts?.mode ?? rpMode;
    setRpMode(mode);
    try { lsSet(rpModeKey(s.id), mode); } catch { /* 存储被禁：不影响本会话 */ }
    setSelected(s);
    // 成人模式开关：「本人用无限制模型建的剧本」进来自动是开的（用户可手动关，且只关这一个）。
    // 和服务端 unlimitedForScenario 同一套优先级，切剧本时重算，不留上一个剧本的状态。
    setUnlimitedOn(effectiveUnlimitedFor(s));
    const savedNames = loadRpNames(s.id);
    const aName = (savedNames?.ai || '').trim() || s.ai.name;
    const uName = (savedNames?.user || '').trim() || s.user.name;
    setAiName(aName);
    setUserName(uName);
    // 偏好与上次会话并行拉取（深链打开更快）；**都按当前模式走**（两条线各一份档、各一份偏好）
    const [pref, saved] = await Promise.all([loadPreference(s.id, mode), loadSession(s.id, mode)]);
    setUserPreference(pref);
    setPrefDraft(pref);
    /**
     * 开场白按模式取：多角色线可用 `multiOpeningAssistant/Scene` 写一段**专属开场**
     *（两条线允许不同剧情线），没写就回落到通用开场。
     */
    let opening = (mode === 'multi' ? (s.multiOpeningAssistant || s.multiOpeningScene) : '') || s.openingAssistant || s.openingScene || '';
    // 开场文本里的默认名替换为自定义名（跨语言沉浸）
    if (aName !== s.ai.name && opening) opening = opening.split(s.ai.name).join(aName);
    // ⚠️ 2026-09-17 修复（线上反馈「无存档进剧情时开场白被吞」的根因）：
    // loadSession() 曾经的实现是 `stripFallbackBubbles(loadLocalSession(id))`，该函数**永远返回数组**，
    // 「没有会话」于是从 `null` 变成 `[]`，而 `[]` 是 truthy → 原来的 `saved || [{ 开场白 }]` 永远取到空数组，
    // 于是「第一次进一部没演过的剧情」剧情区一条消息都没有（开场白被吞），
    // 只有该剧本已有存档的用户才看得到内容（所以维护者自己「没问题」）。
    // 现在两个约束一起上：① loadSession 恢复了「null = 没有会话」的语义；
    //                        ② 这里改用纯函数 pickInitialMessages（**只认非空数组**），并有单测钉死。
    const initial = pickInitialMessages(saved, opening);
    setMessages(initial);
    // 新会话（没有存档）才播开场白打字机；续演存档一律不播（用户是回来接着看的，不该重放）
    setOpeningTyped(!hasResumableSession(saved) && (initial[0]?.content?.length ?? 0) > 0 ? 0 : null);
    /**
     * 🚨 2026-09-18：会话尾部停在一条**没人接的用户消息**上时，把失败态恢复出来。
     *
     * 之前这里是 `setSendFailed(null)` 一刀切，于是「生成失败 / 生成途中关掉页面 / 刚点『重新生成』
     * 就退出」留下的尾部用户消息，在刷新或重进剧情后**既没有提示条也没有重试入口**，
     * 用户看到的就是「我说了最后一句，AI 从此不回我了」，只能靠再发一条新消息绕过（那一句永远没人接）。
     * 线上实测 30 / 271 个会话是这个形态（含用户 Twinkle 的《疯批总裁的白月光》129 条那条）。
     *
     * 这里只恢复**系统提示条**（`SendFailedNotice` + 既有 `retryTurn()`），
     * 绝不替角色编台词、也不往 messages 里塞任何东西，2026-09-15 红线不变。
     */
    setSendFailed(endsWithUnansweredTurn(initial) ? 'UNANSWERED' : null);
    setInput('');
    setSuggestions([]);
    setSuggestError('');
    setStage('chat');
    loadChatQuota();
  };

  // 点卡片进剧本详情（读背景故事/开场）：同一用户手势让该剧本配乐开始自动播放
  const openStoryDetail = (s: RoleplayScenarioInfo) => {
    bgm.markUserGesture();
    setSelected(s);
    setStage('detail');
  };

  const restart = () => {
    setConfirmRestart(true);
  };

  const confirmRestartAction = () => {
    if (!selected) return;
    clearSession(selected.id, rpMode); // 只清当前这条线（另一条线原样保留）
    const freshOpening = (rpMode === 'multi' ? (selected.multiOpeningAssistant || selected.multiOpeningScene) : '') || selected.openingAssistant || selected.openingScene;
    setMessages([{ role: 'assistant', content: freshOpening }]);
    setOpeningTyped(freshOpening ? 0 : null);
    setSendFailed(null);
    setInput('');
    setUserPreference('');
    setPrefDraft('');
    setSuggestions([]);
    setSuggestError('');
    setHasSaved(false);
    setConfirmRestart(false);
  };

  // 自建剧本 → 转成可游玩的场景（跳过详情页，直接进入对话）
  const toScenarioInfo = (c: CustomScenarioInfo): RoleplayScenarioInfo => ({
    id: c.id,
    title: c.title,
    cover: '🎭',
    avatar: c.avatar,
    chatBackground: c.chatBackground,
    tagline: '',
    shortDesc: '',
    ai: { name: c.aiName || (getLang() === 'en' ? 'Them' : 'TA'), gender: '', age: '', height: '', looks: '', personality: c.aiPersona, speech: '' },
    user: { name: getLang() === 'en' ? 'You' : '你', gender: '', age: '', height: '', looks: '', personality: '' },
    background: c.background,
    source: t('rpCustomSource'),
    openingScene: '',
    openingAssistant: c.opening,
    // 带着「创建时用了无限制模型」这个标记进聊天：进这个剧本时成人模式默认开（见 enterChat）
    createdWithUnlimited: c.createdWithUnlimited === true ? true : undefined,
    tags: [t('rpCustomSource')],
    audience: 'her',
    likes: 0,
    likedByMe: false,
  });

  // 自建剧本审核状态徽标（待审核/已通过/精选/已驳回）
  const customStatusBadge = (c: CustomScenarioInfo) => {
    const s = c.status;
    if (!s) return null;
    if (s === 'pending') return <span className="text-[10px] text-amber-600 bg-amber-50 rounded-full px-2 py-0.5 flex-shrink-0" title={t('rpStatusPending')}>{t('rpStatusPending')}</span>;
    if (s === 'approved') return <span className="text-[10px] text-primary-text bg-primary-lighter/70 rounded-full px-2 py-0.5 flex-shrink-0" title={t('rpStatusApproved')}>{t('rpStatusApproved')}</span>;
    if (s === 'featured') return <span className="text-[10px] text-primary-text bg-primary-lighter/70 rounded-full px-2 py-0.5 flex-shrink-0" title={t('rpStatusFeatured')}>{t('rpStatusFeatured')}</span>;
    return <span className="text-[10px] text-red-600 bg-red-50 rounded-full px-2 py-0.5 flex-shrink-0" title={t('rpStatusRejected')}>{t('rpStatusRejected')}</span>;
  };

  const handleCreateClick = () => {
    if (!authUser) { onNeedLogin(); return; }
    setCreateError('');
    setEditingCustom(null);
    setCustomBaseline(null);
    setCustomForm({ title: '', aiName: '', aiPersona: '', background: '', opening: '', avatar: '', chatBackground: '' });
    setDraftIdea(''); setDraftError(''); setDraftOk(false); setDrafting(false);
    setStage('custom');
  };

  // 从聊一聊的引导卡一键过来（initialCreate）：进入即打开「AI 创剧本」表单；
  // 未登录走与按钮一致的登录门（自建剧本需要账号才能保存/同步）。只在挂载时执行一次。
  useEffect(() => {
    if (initialCreate) handleCreateClick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 编辑自建剧本：回填表单进入 custom 阶段（可手改字段，或让 AI 按要求改）
  const handleEditCustom = (c: CustomScenarioInfo) => {
    if (!authUser) return;
    setCreateError('');
    setEditingCustom(c);
    const base = { title: c.title || '', aiName: c.aiName || '', aiPersona: c.aiPersona || '', background: c.background || '', opening: c.opening || '' };
    setCustomBaseline(base);
    setCustomForm({ ...base, avatar: c.avatar || '', chatBackground: c.chatBackground || '' });
    setDraftIdea(''); setDraftError(''); setDraftOk(false); setDrafting(false);
    setStage('custom');
  };

  const handleCreateSubmit = async () => {
    if (creating) return;
    if (editingCustom) { handleUpdateSubmit(); return; }
    setCreating(true);
    setCreateError('');
    try {
      // 审计标记（方案 A2）：记录这个剧本创建时「剧本生成」开关是否开了无限制模式。
      // 只报 boolean，不报模型名，草稿生成路径目前不下发 meta，编造模型名不如不报。
      // 一并回传这次用过的「剧本灵感」：控制台要能看到用户是拿什么提示词让 AI 生成的
      // （草稿生成接口不落库，所以只能在这里带走；没写过灵感 / 纯手写时为 undefined）
      const r = await createCustomRoleplay({ ...customForm, createdWithUnlimited: scriptUnlimitedOn, creationPrompt: draftIdea.trim() || undefined });
      if (r.success && r.data) {
        const rec = r.data;
        setCustomScenarios(list => [rec, ...list]);
        await enterChat(toScenarioInfo(rec), { gesture: true });
      } else {
        setCreateError(t('rpCustomRejected'));
      }
    } catch {
      setCreateError(t('errNetwork'));
    } finally {
      setCreating(false);
    }
  };

  // 保存自建剧本修改（编辑态；保存后回到「我的剧本」列表，投稿状态会自动复位需重新投稿）
  const handleUpdateSubmit = async () => {
    if (!editingCustom || creating) return;
    setCreating(true);
    setCreateError('');
    const id = editingCustom.id;
    try {
      const r = await updateCustomRoleplay(id, customForm);
      if (r.success && r.data) {
        const updated = r.data;
        setCustomScenarios(list => list.map(c => (c.id === id ? { ...c, ...updated } : c)));
        // 内容变更后已公开副本须下架（后端复位为草稿），从本地「精选/一般」区块同步移除
        setPlayerCreated(list => list.filter(x => x.id !== id));
        setCommunity(list => list.filter(x => x.id !== id));
        setEditingCustom(null);
        setCustomBaseline(null);
        rpGoUp(); // 自建剧本表单 → 剧本列表（一层），走统一入口让历史条目同步退掉
      } else if (r.code === 'CONTENT_REJECTED') {
        setCreateError(t('rpCustomRejected'));
      } else {
        setCreateError(t('errNetwork'));
      }
    } catch {
      setCreateError(t('errNetwork'));
    } finally {
      setCreating(false);
    }
  };

  // AI 辅助创建剧本草稿：一句话灵感 → 后端生成草稿并回填表单（每次生成消耗 1 条聊天额度，失败后端自动退回）
  const handleAiDraft = async () => {
    const idea = draftIdea.trim();
    if (!idea || drafting) return;
    if (!authUser) { onNeedLogin(); return; }
    setDrafting(true);
    setDraftError('');
    setDraftOk(false);
    try {
      // 编辑态：让 AI 基于现有剧本按修改要求改；新建态：一句话灵感生成全新草稿
      const r = editingCustom
        ? await roleplayCustomRevise(editingCustom.id, idea, rpLang, { title: customForm.title, aiName: customForm.aiName, aiPersona: customForm.aiPersona, background: customForm.background, opening: customForm.opening })
        : await roleplayCustomDraft(idea, rpLang);
      if (r.success && r.data?.draft) {
        const d = r.data.draft;
        setCustomForm(s => ({ ...s, title: d.title ?? s.title, aiName: d.aiName ?? s.aiName, aiPersona: d.aiPersona ?? s.aiPersona, background: d.background ?? s.background, opening: d.opening ?? s.opening }));
        setDraftOk(true);
        setCreateError('');
        // 成功后把视野带到可编辑表单区，方便用户微调
        requestAnimationFrame(() => {
          document.getElementById('rp-custom-title')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      } else if (isQuotaExhaustedResp(r)) {
        // 额度用完：交给统一门控（游客→注册 / 已注册→分享/反馈），不把付费墙文案当错误展示
        onNeedPay?.();
        setDraftError('');
      } else if (r.code === 'DRAFT_FORMAT') {
        // 格式抖动（模型 JSON 没写好），与内容无关：措辞要让人安心并鼓励"再点一次"，别让他去改灵感
        setDraftError(editingCustom ? t('rpCustomAiFormatRevise') : t('rpCustomAiFormat'));
      } else if (r.code === 'CONTENT_REJECTED') {
        setDraftError(editingCustom ? t('rpCustomRejected') : t('rpCustomAiRejected'));
      } else {
        setDraftError(t('rpCustomAiNetwork'));
      }
    } catch {
      setDraftError(t('rpCustomAiNetwork'));
    } finally {
      setDrafting(false);
    }
  };

  const handleDeleteCustom = (id: string) => {
    if (!authUser) return;
    deleteCustomRoleplay(id).then(r => { if (r.success) setCustomScenarios(list => list.filter(c => c.id !== id)); }).catch(() => {});
  };

  const handlePublishCustom = async (c: CustomScenarioInfo, published: boolean) => {
    if (!authUser) return;
    const r = await publishCustomRoleplay(c.id, published);
    if (r.success && r.data) {
      const status: CustomStatus | undefined = published ? 'pending' : undefined;
      setCustomScenarios(list => list.map(x => x.id === c.id ? { ...x, published, status } : x));
      if (!published) { setPlayerCreated(list => list.filter(x => x.id !== c.id)); setCommunity(list => list.filter(x => x.id !== c.id)); }
    } else {
      setCreateError(t('rpCustomRejected'));
    }
  };

  /**
   * 单次尝试：只发请求 + 收敛结果，**不动** sendFailed / 版本收尾（由 runTurn 决定）。
   * 返回值是「这一轮到底怎么样了」的分类，便于自动重试与埋点判断。
   */
  const attemptTurn = async (base: RoleplayMessage[], prefOverride?: string, replacedReply?: string): Promise<
    { kind: 'ok'; reply: string; incomplete: IncompleteReason | null; continued: number; meta: MetaInfo | null; free: boolean } | { kind: 'quota' } | { kind: 'partial'; full: string; meta: MetaInfo | null } | { kind: 'abort' } | { kind: 'fail'; code: string; status?: number; error?: string }
  > => {
    let full = '';
    // 本轮实际使用的模型：服务端在选定 provider 后、开始生成前通过 {type:'meta'} 下发一次。
    // 存下来随这条 assistant 消息回传，保存会话时落到 RoleplayMessage.viaUnlimited/model（+ 叙事模式 style，
    // 见 assistantMetaOf），供管理端「用户行为」核对成人模式使用情况（方案 A2）与按叙事模式分档统计收尾习惯。
    // 拿不到就保持 null → 该条记为「未记录」。
    //
    // 🚨 用可变持有对象而不是 `let meta`：**除了 onDelta，还必须把它带回给调用方**
    //    2026-09-17 的记录里「41 条里 40 条未记录」就是这里漏的：runTurn 的 finish() 重新构造消息对象、
    //    没带上 meta，于是流式过程中带过 meta 的那条被定稿时覆盖掉了。
    const metaRef: { current: MetaInfo | null } = { current: null };
    // 先掐掉上一轮在途的流（避免两条流同时写同一份 state），并登记本轮句柄（2026-09-29 审查 A5-P2-3）
    rpTurnAbortRef.current?.abort();
    const ac = new AbortController();
    rpTurnAbortRef.current = ac;
    try {
      // 剧情走流式：逐 token 追加，不让用户对着 spinner 空等整段回复（不刻意变慢）
      // ⚠️ 上下文一律过 toRequestMessages：content 取「**当前选中**的那一版」
      //    否则切了版本/重抽之后，会把用户已经看不见的旧版当台词回灌给模型（本轮功能的关键不变量）
      const r = await roleplayChatStream(selected!.id, toRequestMessages(base), rpLang, aiName.trim() || undefined, userName.trim() || undefined, prefOverride ?? userPreference, narrativeStyle, {
        onDelta: (delta) => {
          // 这一轮已被切走/被新请求取代：流里的 delta 一律丢弃，绝不写进当前 state
          if (rpTurnAbortRef.current !== ac) return;
          full += delta;
          setQueueInfo(null); // 一旦开始出字，排队就结束了，立刻撤掉提示
          setMessages([...base, { role: 'assistant', content: full, ...assistantMetaOf(metaRef.current, narrativeStyle) }]);
        },
        onQueue: (info) => setQueueInfo(info),
        // meta 一定早于第一个 delta 到达（服务端在生成前下发），所以 onDelta 构造消息时已经拿得到
        onMeta: (m) => { metaRef.current = m; },
        // C 方案：服务端发现回复断在半句上，正在**自动续写**（同一段文字继续往下长）。
        // 这里只用来显示「正在续写」：不新增消息、不打断打字动效。
        onContinue: () => setContinuing(true),
        // A 方案：服务端正在重写这一版（重写期间不再有 delta，最终由 done.reply 覆盖）
        onRewrite: () => { setContinuing(false); setRewriting(true); },
        signal: ac.signal,
      }, innerOn, thinkingLevel, false, replacedReply, rpMode);
      setQueueInfo(null); // 流式已结束（无论成败），排队态一律清掉，避免残留提示
      setContinuing(false);
      setRewriting(false);
      if (r.success && r.data) {
        // B 方案：服务端在 done 里告诉我们「这一条写完没有」（自动续写后仍不完整才算没写完）
        return {
          kind: 'ok',
          reply: r.data.reply,
          incomplete: (r.data.incomplete ?? null) as IncompleteReason | null,
          continued: Number(r.data.continued) || 0,
          meta: metaRef.current,
          // 判重退费：服务端判到这一条与上一段重复 → 本次未扣额度（UI 据此提示用户）
          free: r.data.free === true,
        };
      }
      if (isQuotaExhaustedResp(r)) return { kind: 'quota' };
      if (full.trim()) return { kind: 'partial', full, meta: metaRef.current };
      if (r.code === 'ABORTED') return { kind: 'abort' };
      return { kind: 'fail', code: failCodeOf(r), status: r.status, error: r.error };
    } catch (e) {
      setQueueInfo(null);
      setContinuing(false);
      setRewriting(false);
      if (full.trim()) return { kind: 'partial', full, meta: metaRef.current };
      console.warn('[roleplay] 回复异常:', e);
      return { kind: 'fail', code: 'NETWORK' };
    }
  };

  /**
   * 一个回合（发送 / 重试 / 重新生成共用）。
   *
   * 🚨 2026-09-15 线上事故的根因就修在这里：请求失败时**绝不能**把兜底文案写进 messages。
   * 之前是 `applyAssist(r.error || t('errNetwork'))`，于是「网络好像开小差了，稍后再试试好吗？🌱」
   * 被当成角色台词显示、被自动保存进剧情会话、还被回灌给模型当上下文
   *（生产库 data/xiaoyu.sqlite 里已经留下 3 处：1 条 errNetwork + 2 条「生成失败，请稍后重试」）。
   *
   * 🆕 自动重试：网络断/超时这类**瞬时**失败、且一个字都没收到时，自动再 call 一次 AI；
   * 成功则用户完全无感（连失败条都不出现），仍然失败才提示「没发送成功 + 重试」。
   * 判定见 `src/lib/autoRetry.ts`（已流出内容 / 4xx 业务错误 / 用户取消都不重试）。
   */
  const runTurn = async (base: RoleplayMessage[], prefOverride?: string, regenPrev?: RoleplayMessage, rollbackTo?: RoleplayMessage[]) => {
    // 新一轮开始：先撤掉上一条「重复免扣」提示（是否免扣由服务端 done.free 决定）
    setRepeatFreeNotice(false);
    /** 本轮的审计信息（meta）：定稿时要用，所以在这一层持有，见 finish() */
    let outcomeMeta: MetaInfo | null = null;
    /** attemptTurn 的返回是联合类型（quota/abort/fail 没有 meta 字段），这里统一取一次 */
    const rememberMeta = (o: unknown): void => {
      const m = (o as { meta?: MetaInfo | null })?.meta;
      if (m) outcomeMeta = m;
    };
    /**
     * 重新生成时传进来的「被替换掉的那条」：新回复会作为最新一版**追加**进它的 versions，
     * 旧版全部保留（界面上可 ◀/▶ 回看）；不用它时就生成一条普通单版回复。
     */
    const finish = (text: string): RoleplayMessage => {
      const built = regenPrev ? finishRegenerate(regenPrev, text) : { role: 'assistant' as const, content: text };
      // A2 审计字段必须**在定稿时再带一次**：流式中途那版带过 meta，但定稿是重新构造对象，
      // 不显式搬过来就会静默丢掉 → 管理端 unlimitedTurns 系统性偏低（2026-09-17 记录的既有缺陷）。
      // 叙事模式同理（2026-09-18）：它是「按模式分档看收尾习惯」的唯一数据来源。
      return { ...built, ...assistantMetaOf(outcomeMeta, narrativeStyle) };
    };
    /** 重生成彻底失败（一个字都没生成）→ 把原来那条原样放回去，不让用户白丢一版 */
    const restorePrev = (): void => { if (regenPrev) setMessages([...base, regenPrev]); };
    /**
     * 回滚（失败 / 取消 / 额度不足）：
     *   · 编辑重发 → **整份快照**放回（`rollbackTo`）。这一步是 1B 能成立的前提：改写失败时
     *     用户必须回到跟动手前**一模一样**的状态（旧正文 + 旧回复都在），否则"回退"就变成了"丢剧情"。
     *   · 重新生成 → 只放回被替换掉的那条回复（其后对话本来就已经在用户确认下清掉了）。
     */
    const restore = (): void => { if (rollbackTo) setMessages(rollbackTo); else restorePrev(); };
    try {
      let outcome = await attemptTurn(base, prefOverride, regenPrev?.content);
      rememberMeta(outcome);
      const firstCode = outcome.kind === 'fail' ? outcome.code : '';

      // 【自动重试（上限 AUTO_RETRY_MAX，当前=1）：网络断 / 等超时 / 上游报错，且一个字都没收到】
      let autoRetries = 0;
      while (outcome.kind === 'fail' && autoRetries < AUTO_RETRY_MAX && shouldAutoRetry({ code: outcome.code, status: outcome.status }, false)) {
        autoRetries += 1;
        console.warn('[roleplay] 首次失败，立即自动再 call 一次:', outcome.code, outcome.status || '');
        // AUTO_RETRY_DELAY_MS 默认 0 = 不等（连接已经坏了，等再久那条连接也不会好；新请求会新建连接）
        if (AUTO_RETRY_DELAY_MS > 0) await new Promise((r) => setTimeout(r, AUTO_RETRY_DELAY_MS));
        outcome = await attemptTurn(base, prefOverride, regenPrev?.content);
        rememberMeta(outcome);
      }

      if (outcome.kind === 'ok') {
        const fresh = finish(outcome.reply);
        // B 方案：服务端仍判定「没写完」（自动续写用完上限 / 续写也失败）→ 给这条打标记，
        // 气泡下方出现「没写完 + 续写」入口；埋点按原因细分（PARTIAL_LENGTH / PARTIAL_UNCLOSED /
        // PARTIAL_MID_SENTENCE），运营端下次能一眼分辨「上游截断」还是「模型自己收尾过早」。
        if (outcome.incomplete) {
          reportAiFailure('roleplay', incompleteCode(outcome.incomplete) || 'PARTIAL', false);
        }
        setMessages([...base, outcome.incomplete ? { ...fresh, incomplete: true } : fresh]);
        setSendFailed(null);
        // 判重退费：本条与上一段重复 → 服务端已回滚额度，这里只提示用户（不写进 messages）
        setRepeatFreeNotice(outcome.free);
        if (firstCode) reportAiFailure('roleplay', firstCode, true); // 自动重试救回来了（用户无感）
      } else if (outcome.kind === 'quota') {
        // 额度用完：交给统一门控（游客→注册 / 已注册→分享/反馈），不把付费墙文案当作 AI 消息
        restore();
        setSendFailed(null);
        onNeedPay?.();
      } else if (outcome.kind === 'partial') {
        // 已流出内容 = 真实生成：保留并定稿，不再提示失败（避免一屏「半截台词 + 失败条」）
        setMessages([...base, finish(outcome.full)]);
        setSendFailed(null);
        reportAiFailure('roleplay', 'PARTIAL', false); // 半截也算「没接上」，运营端要看得到
      } else if (outcome.kind === 'abort') {
        // 用户自己切走/取消：不给失败提示（下一轮正常发即可），也不重试、不埋点
        restore();
        setSendFailed(null);
      } else {
        // 失败原因不再是「角色的台词」：只作为系统提示 + 可重试
        console.warn('[roleplay] 回复失败:', outcome.code, outcome.status || '', outcome.error || '');
        reportAiFailure('roleplay', outcome.code, false);
        restore();
        setSendFailed(outcome.error || outcome.code || 'NETWORK');
      }
    } finally {
      setSending(false);
      setRegenerating(false);
      loadChatQuota();
    }
  };

  const send = async (contentOverride?: string) => {
    const content = (typeof contentOverride === 'string' ? contentOverride : input).trim();
    if (!content || sending || regenerating || continuing || !selected) return;
    /**
     * 发下一条消息 = 把上一轮的「编辑分支」**固化**（只留当前那一支）。
     * 依据见 `commitUserBranch` 注释：2A 口径下改写只属于"当轮"，另一支之后永远切不回去
     *（切回要连其后所有对话一起换 = 对话树，已明确不做），而每个尾巴都是一整段台词（最长 4000 字）
     *。留着就是纯死重量，`roleplay-sessions.json` 会白涨。
     */
    const lastUser = lastUserIndex(messages);
    const baseMsgs = lastUser >= 0 ? commitUserBranch(messages, lastUser) : messages;
    setSending(true);
    setSendFailed(null);
    setOpeningTyped(null);          // 用户发言了 → 开场白打字机立即收尾（messages 里本来就是全文）
    setInput('');
    setEditTarget(null);            // 正常发送一律退出编辑态（编辑态的发送走 editResend，见 submitComposer）
    stickToBottomRef.current = true; // 发送后回到最新，跟随后续回复（对齐聊一聊）
    setRpAtBottom(true);
    // 发送后收起手机键盘，方便看后续
    try { (document.activeElement as HTMLElement | null)?.blur?.(); } catch { /* 忽略 */ }
    const newMsgs: RoleplayMessage[] = [...baseMsgs, { role: 'user', content }];
    setMessages(newMsgs);
    await runTurn(newMsgs);
  };

  // 【编辑重发（2026-09，1B + 2A）：改掉刚发的那句话，从这句重新接下去】
  /**
   * 进入编辑态：把这条用户消息的原文填进输入栏，并**备份**用户本来正在写的草稿
   *（取消编辑要原样还回去，不能因为点了一下「编辑」就把没发出去的话吃掉）。
   * 只有 `canEditAt` 认的那条（最后一条用户消息）才有调用入口。
   */
  const openEdit = (i: number) => {
    if (sending || regenerating || continuing) return;
    if (!canEditAt(messages, i)) return;
    editDraftBackupRef.current = input;
    setEditTarget(i);
    setInput(activeContent(messages[i]));
    setSuggestions([]);            // 收起「帮你接话」候选：编辑态下它们会抢走发送按钮
    setTimeout(() => { try { rpInputRef.current?.focus(); } catch { /* 忽略 */ } }, 0);
  };
  const cancelEdit = () => {
    if (editTarget == null) return;
    setEditTarget(null);
    setInput(editDraftBackupRef.current);   // 还回进编辑态前的草稿
    editDraftBackupRef.current = '';
  };
  /**
   * 提交一次编辑重发。与 `send()` 的三处关键差别：
   *   ① 历史用 `startEditResend()` 造：旧正文留成上一版、旧回复冻结成可切回的分支（1B）、
   *      主线截到改写句（以 user 结尾），这正是后端 `/chat` 要求的"以用户消息结尾"的回合起点；
   *   ② **必须**把编辑前的整份历史当快照交给 `runTurn`：失败/取消/额度不足时整体回滚（`rollbackTo`），
   *      用户回到动手前的样子，绝不能出现"改了但没接上，旧剧情也没了"；
   *   ③ 那个中间态（以 user 结尾、比已存历史短）**不许落盘**：前端 `saveSession` 的护栏会跳过，
   *      服务端 `roleplaySessions.save()` 里同一份判据再挡一层（见 `src/lib/rpWriteGuard.ts` 判据 2b）。
   */
  const editResend = async () => {
    if (!selected || sending || regenerating || continuing) return;
    if (editTarget == null) return;
    const text = input.trim();
    if (!text) return;              // 空内容不发（发送按钮本来就禁用了，这里再兜一层）
    const snapshot = messages;
    const next = startEditResend(messages, editTarget, text);
    if (!next) { cancelEdit(); return; }   // 判据不成立（换过剧本 / 下标失效）→ 退出编辑态，绝不乱改历史
    setSending(true);
    setSendFailed(null);
    setInput('');
    setEditTarget(null);
    editDraftBackupRef.current = '';
    stickToBottomRef.current = true;
    setRpAtBottom(true);
    try { (document.activeElement as HTMLElement | null)?.blur?.(); } catch { /* 忽略 */ }
    setMessages(next);   // 中间态：只用于请求与流式展示
    await runTurn(next, undefined, undefined, snapshot);
  };
  /**
   * 输入栏/发送按钮的统一入口：编辑态下回车或点发送 = 重发（而不是把改写内容当成一条新消息发出去）。
   * 这样"改完再发"在两种状态下都是同一个手势，用户不用先退出编辑态。
   */
  const submitComposer = () => {
    if (editTarget != null) void editResend();
    else void send();
  };
  /**
   * 切换这条用户消息的分支（◀/▶）：纯本地。不重新生成、不消耗额度、两边内容都不丢。
   * 只在「它仍是最后一条用户消息」时可用（2A），一旦又聊了新的，分支就固化了（见 send()）。
   */
  const switchUserBranch = (i: number, dir: -1 | 1) => {
    if (sending || regenerating || continuing) return;
    setMessages((cur) => switchUserBranchIn(cur, i, dir));
  };

  /** 重试上一回合：不重复插入用户消息、不重复扣额度气泡，只把这一轮重新要一次 */
  const retryTurn = async () => {
    if (sending || regenerating || continuing || !selected) return;
    const last = messages[messages.length - 1];
    if (!last) return;
    setSendFailed(null);
    if (last.role === 'assistant') {
      // 上一轮是「重新生成」失败后放回原版的：重试 = 再重生成这一条（而不是把角色的话再要一遍）
      void regenerateAt(messages.length - 1, '');
      return;
    }
    setSending(true);
    stickToBottomRef.current = true;
    setRpAtBottom(true);
    try { (document.activeElement as HTMLElement | null)?.blur?.(); } catch { /* 忽略 */ }
    await runTurn(messages);
  };

  // 【AI 辅助聊天：加载聊天额度、为玩家生成候选下一句、选中即发送】
  const loadChatQuota = () => {
    getQuota().then(r => { if (r.success && r.data) setChatQuota(r.data); }).catch(() => {});
  };
  // 额度（含统一点数）：返回「≈ 还能聊 N 条」，旧模式按档位条数/次数
  const chatQuotaRemain = (q: QuotaInfo | null): number => quotaChatRemain(q);
  // 因「选中即发送」会再消耗 1 条，免费 / Plus 需至少 2 条额度才可触发生成
  const canUseSuggest = (q: QuotaInfo | null): boolean => {
    const remain = chatQuotaRemain(q);
    if (!q) return true; // 未拿到额度时先放行，让后端 402 兜底
    return remain === Infinity ? true : remain >= 2; // 生成建议(1) + 点选发送的剧情回合(1)
  };
  const generateSuggestions = async () => {
    if (suggestLoading || sending || regenerating || !selected) return;
    if (editTarget != null) return;   // 编辑态下不生成候选（见 sendSuggestion 的注释）
    if (!canUseSuggest(chatQuota)) {
      setSuggestError(t('rpSuggestNeedQuota'));
      return;
    }
    setSuggestLoading(true);
    setSuggestError('');
    // 上一批建议 = 本轮判重退费的比较对象（清空前先留一份）
    const prevSuggestions = suggestions;
    setSuggestDuplicate(false);
    setSuggestions([]);
    try {
      const r = await roleplaySuggest(selected.id, toRequestMessages(messages), rpLang, aiName.trim() || undefined, userName.trim() || undefined, userPreference, narrativeStyle, prevSuggestions);
      if (r.success && r.data && r.data.duplicate) {
        // 与上一批重复：服务端已回滚额度（本次不扣），保留上一批并提示用户
        setSuggestions(prevSuggestions);
        setSuggestDuplicate(true);
      } else if (r.success && r.data && Array.isArray(r.data.suggestions) && r.data.suggestions.length > 0) {
        setSuggestions(r.data.suggestions);
      } else if (isQuotaExhaustedResp(r)) {
        onNeedPay?.();
        setSuggestError('');
      } else {
        setSuggestError(r.error || t('errNetwork'));
      }
      loadChatQuota();
    } catch {
      setSuggestError(t('errNetwork'));
    } finally {
      setSuggestLoading(false);
    }
  };
  const sendSuggestion = (content: string) => {
    // 编辑态下不接「帮你接话」：它会把改写内容替换成候选句并当成新消息发出去（用户正在改的是那一句）
    if (editTarget != null) return;
    setSuggestions([]);
    setSuggestError('');
    send(content);
  };

  // 【我的偏好/独特需求：打开编辑 & 保存】
  const openPref = () => {
    setPrefDraft(userPreference);
    setPrefOpen(true);
  };
  /**
   * 邮件深链（`?open=roleplay&pref=1`）：进入剧情后自动打开「我的偏好」抽屉，
   * 让用户点了邮件里的按钮就能直接看到「无限制模式」那个开关，不用自己找。
   * 只自动开一次（ref 守卫）；抽屉只在剧情对话页存在（依赖 selected），所以等进了剧情再开。
   *
   * 2026-09-27（A 案）：剧本详情页那条一键直达**不再**走这里，它改成在弹窗里就地开启
   * 无限制模式（changeUnlimitedOn(true)，未过 18+ 先弹闸门），不再开抽屉、也不再把人带进对话让他自己拨。
   * 于是 `prefOpenAfterEnter` 那套「每次点都算数」的状态机随之删掉，这条路只剩邮件深链一个入口。
   */
  const prefAutoOpened = useRef(false);
  useEffect(() => {
    if (stage !== 'chat' || !selected) return;
    if (initialPrefOpen && !prefAutoOpened.current) {
      prefAutoOpened.current = true;
      openPref();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrefOpen, stage, selected]);
  const savePref = async () => {
    if (!selected) return;
    const text = prefDraft.trim();
    setUserPreference(text);
    await savePreference(selected.id, rpMode, text);
    setPrefOpen(false);
  };

  // 【重新生成（**任意一条** AI 回复，可选填反馈沉淀为该剧本的用户偏好）】
  /**
   * 打开「重新生成」弹窗（带上是第几条）。
   * 每条 AI 回复都有自己的入口；开场白除外，它前面没有用户消息（后端 `/chat` 也要求历史以 user 结尾），
   * 且它是剧本设定的一部分，不是 AI 当场生成的。
   */
  const openRegenerate = (i: number) => {
    if (sending || regenerating || continuing || !canRegenerateAt(messages, i)) return;
    setRegenerateTarget(i);
    setRegenerateFeedback('');
    setRegenerateOpen(true);
  };
  /**
   * 重生成第 i 条 AI 回复：`base` 截到这条之前（其后对话作废，弹窗里已按条数明确提示），
   * 并把被替换掉的那条交给 `runTurn`，新回复作为**最新一版**追加，旧版留在 ◀/▶ 里可回看。
   */
  const regenerateAt = async (i: number, feedback: string) => {
    if (!selected || regenerating || sending || continuing) return;
    const start = startRegenerate(messages, i);
    if (!start) return;
    const fb = feedback.trim();
    setRegenerateOpen(false);
    setRegenerateTarget(null);
    setRegenerating(true);
    setSendFailed(null);
    let updatedPref = userPreference;
    // 用户对这条内容的反馈 → 记入该剧本的用户偏好 prompt，之后所有回复都参考
    if (fb) {
      updatedPref = (userPreference.trim() ? userPreference + '\n' : '') + '· 用户希望：' + fb;
      setUserPreference(updatedPref);
      await savePreference(selected.id, rpMode, updatedPref);
    }
    setMessages(start.base); // 从这条起重写（其后对话由用户在弹窗里确认后清掉）
    await runTurn(start.base, updatedPref, start.prev);
  };
  const handleRegenerate = () => {
    if (regenerateTarget != null) void regenerateAt(regenerateTarget, regenerateFeedback);
  };
  /**
   * 「续写」：把**没写完的那条**接着说下去（B/C 方案的手动入口，用户自己点）。
   *
   * 与「重新生成」的关键差别：
   *   - 重新生成是**换一版**（从这条起重写，其后对话作废）；续写是**在同一条里往下长**
   *     服务端接着断点写，用户看到的是半截台词自己续上，后面的剧情一句不动；
   *   - 请求把当前历史原样带回并置 `continueTurn: true`，服务端据此认出「最后一条 assistant 就是断点」；
   *   - 结果仍作为这条的**新一版**落进 versions（可从 ◀/▶ 回看续写前的半截）。
   *
   * 额度口径：与「重新生成」一致，算作新的一回合（服务端按回合扣）。**自动**续写不额外扣
   *。那次续写发生在同一个请求里，用户并没有发第二条消息。
   */
  const continueAt = async (i: number) => {
    if (!selected || sending || regenerating || continuing) return;
    const target = messages[i];
    if (!target || target.role !== 'assistant' || !target.content.trim()) return;
    const base = messages.slice(0, i + 1); // 含这条半截回复：服务端取最后一条 assistant 当断点
    const rest = messages.slice(0, i);
    // 先掐掉上一轮在途的流（避免两条流同时写同一份 state），并登记本轮句柄（2026-09-29 审查 A5-P2-3）
    rpTurnAbortRef.current?.abort();
    const ac = new AbortController();
    rpTurnAbortRef.current = ac;
    let full = target.content;
    // 用可变持有对象而不是 `let meta: T | null`：后者会被 TS 的控制流分析收窄成 never
    //（赋值发生在 await 之后的回调里，编译器在主流程上看不到它被改写）。
    const metaRef: { current: { adult: boolean; model: string } | null } = { current: null };
    setContinuing(true);
    setSendFailed(null);
    setRepeatFreeNotice(false);
    setRegenerateOpen(false);
    try {
      const r = await roleplayChatStream(selected.id, toRequestMessages(base), rpLang, aiName.trim() || undefined, userName.trim() || undefined, userPreference, narrativeStyle, {
        onDelta: (delta) => {
          // 这一轮已被切走/被新请求取代：流里的 delta 一律丢弃，绝不写进当前 state
          if (rpTurnAbortRef.current !== ac) return;
          // 续写增量直接接在同一段正文后面（不新增气泡），并把「没写完」标记临时撤掉
          full += delta;
          setMessages([...rest, { ...target, content: full, incomplete: undefined }]);
        },
        onMeta: (m) => { metaRef.current = m; },
        signal: ac.signal,
      }, innerOn, thinkingLevel, true, undefined, rpMode);
      if (r.success && r.data) {
        const reason = (r.data.incomplete ?? null) as IncompleteReason | null;
        if (reason) reportAiFailure('roleplay', incompleteCode(reason) || 'PARTIAL', false);
        // 判重退费：续写后仍与上一段重复 → 服务端已回滚额度（只提示，不写进 messages）
        setRepeatFreeNotice(r.data.free === true);
        // 续写后的全文作为这条的新一版（旧半截留在 ◀/▶ 里，可回看/可比对）
        const done = finishRegenerate(target, r.data.reply);
        const meta = metaRef.current;
        setMessages([...rest, {
          ...done,
          incomplete: reason ? true : undefined,
          ...assistantMetaOf(meta, narrativeStyle),
        }]);
      } else if (isQuotaExhaustedResp(r)) {
        setMessages(messages); // 额度不足：还原成续写前的样子，走统一门控
        onNeedPay?.();
      } else {
        // 续写失败：还原（不留"续写到一半"的渲染态）；半截仍旧在，用户可再点一次
        console.warn('[roleplay] 续写失败:', failCodeOf(r), r.status || '', r.error || '');
        setMessages(messages);
        setSendFailed(failCodeOf(r));
      }
    } catch (e) {
      console.warn('[roleplay] 续写异常:', e);
      setMessages(messages);
      setSendFailed('NETWORK');
    } finally {
      setContinuing(false);
      loadChatQuota();
    }
  };

  /**
   * 这一条要不要显示「没写完」提示（并给「续写」入口）。
   *
   * 两个来源取并集：
   *   ① 服务端标记 `m.incomplete`（B 方案：上游 finish_reason=length、或续写用尽上限后仍断在半句）；
   *   ② 对**当前显示的正文**跑一次完整性判定，好处是**老数据也管**：
   *      数据库里那些已经存成半截的历史（含用户「小愈的朋友」那条 `（他并未退`）刷新后同样会给提示与续写入口，
   *      不需要任何数据迁移；切版本时也会跟着当前版本重算。
   */
  const isHalfMessage = (m: RoleplayMessage): boolean => {
    if (m.role !== 'assistant' || !m.content.trim()) return false;
    if (m.incomplete === true) return true;
    const key = m.content.length + ':' + m.content.slice(-24);
    const cache = halfCacheRef.current;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const val = looksIncomplete(m.content);
    if (cache.size > 400) cache.clear(); // 长会话防无界增长（清空重算的代价可忽略）
    cache.set(key, val);
    return val;
  };

  /**
   * 切换某条 AI 回复的版本（◀/▶）：**只改这一条**，不截断后面的剧情。
   * `content` 同步成选中版本 ⇒ 下一轮请求的上下文就是「你正在看的那一版」。
   * 切换时同步重算「没写完」标记：标记跟着**当前显示的版本**走，否则切到完整的那一版还会挂着提示。
   */
  const switchVersion = (i: number, dir: -1 | 1) => {
    if (sending || regenerating || continuing) return;
    setMessages(prev => {
      const next = switchVersionIn(prev, i, dir);
      if (next === prev) return prev;
      return next.map((m, idx) => (idx === i && m.role === 'assistant'
        ? { ...m, incomplete: looksIncomplete(m.content) ? true : undefined }
        : m));
    });
  };
  /**
   * 顶栏「⋯」菜单开/收。菜单本体渲染在**聊天壳**层（与顶栏并列，见 rpMorePos 注释），
   * 所以这里按「⋯」按钮相对壳的位置算落点，行为与原来的 `absolute right-0 top-11` 一致。
   */
  const toggleMoreMenu = () => {
    if (rpMoreOpen) { setRpMoreOpen(false); return; }
    const b = rpMoreRef.current?.getBoundingClientRect();
    const sh = rpShellRef.current?.getBoundingClientRect();
    if (b && sh) setRpMorePos({ top: Math.round(b.bottom + 4 - sh.top), right: Math.max(8, Math.round(sh.right - b.right)) });
    setRpMoreOpen(true);
  };

  // ===== AI 文游（人生模拟器，千世书引擎移植） =====
  if (stage === 'wenyou') {
    return (
      <Suspense fallback={<div className="min-h-[100dvh] bg-brand flex items-center justify-center"><div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" /></div>}>
        <WenyouPage onBack={() => setStage('list')} initialResumeId={initialWenyouGame} onGoChat={onGoChat} />
      </Suspense>
    );
  }

  // ===== AI 狼人杀（和你的「聊一聊」角色玩一局） =====
  if (stage === 'werewolf') {
    return (
      <Suspense fallback={<div className="min-h-[100dvh] bg-clay-bg flex items-center justify-center"><div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" /></div>}>
        <WolfchaHost onBack={() => rpGoUp()} />
      </Suspense>
    );
  }

  // ===== 模块引导（**只从顶栏 ⓘ「了解本功能」进入**；首次进入不再自动落在这里，见 useState 初值处的说明） =====
  if (stage === 'intro') {
    const goList = () => rpGoUp();
    /**
     * 三模式说明（2026-09-18 用户拍板）：这页以前只讲「角色扮演」（标题还是 `roleplayTitle`），
     * 模块底下现在是三个并列模式 → 改成**模块级说明**：开头三行分别介绍三种玩法，
     * 名字**直接取各自 tab 的键**（切换器同一份文案，不另起名字、不会漂移）；
     * 后面三张卡（来源 / 收费 / 提示）也改成模块口径。
     * 狼人杀有反向闸门（`?ww=off` / `cure_ww_dev=0`），锁着时这一行挂「开发中」角标，不假装能玩。
     */
    const introModes = [
      { key: 'roleplay', icon: Sparkles, name: t('roleplayTitle'), body: t('rpIntroModeRoleplayBody'), locked: false },
      { key: 'wenyou', icon: ScrollText, name: t('wyTabLabel'), body: t('rpIntroModeWenyouBody'), locked: false },
      { key: 'werewolf', icon: Moon, name: wwT('tab'), body: t('rpIntroModeWerewolfBody'), locked: !werewolfUnlocked },
    ];
    return (
      <div className="min-h-[100dvh] bg-brand">
        <div className="sticky top-0 z-10 bg-white/85 backdrop-blur border-b border-gray-100">
          <div className="max-w-2xl mx-auto px-3 py-2 flex items-center justify-between">
            <button onClick={rpGoUp} aria-label={t('backHome')} title={t('backHome')} className="flex items-center text-sm text-ink-soft hover:text-gray-700 transition-colors p-2 -ml-2 min-h-[44px] min-w-[48px]">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <p className="font-semibold text-gray-800">{t('rpModuleTitle')}</p>
            <FeedbackButton />
          </div>
        </div>
        <div className="max-w-2xl mx-auto px-4 py-5 space-y-4">
          <div className="text-center pt-2">
            <div className="w-16 h-16 rounded-3xl bg-gradient-to-br from-primary-soft to-accent-soft flex items-center justify-center mx-auto mb-3">
              <Sparkles className="w-8 h-8 text-primary" />
            </div>
            <h1 className="text-xl font-bold text-gray-800">{t('rpModuleTitle')}</h1>
            <p className="text-sm text-ink-soft mt-1">{t('rpIntroSub')}</p>
          </div>

          <div className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm">
            <p className="text-xs font-bold text-primary-text mb-1.5 flex items-center gap-1.5"><Sparkles className="w-4 h-4" />{t('rpIntroWhatTitle')}</p>
            <p className="text-sm text-gray-700 leading-relaxed">{t('rpIntroWhatBody')}</p>
            {/* 三种玩法各一行：名字来自切换器同源的 tab 键 */}
            <ul className="mt-3 space-y-2">
              {introModes.map((m) => {
                const Icon = m.icon;
                return (
                  <li key={m.key} data-testid={'rp-intro-mode-' + m.key} className="flex gap-2.5 rounded-xl bg-clay-bg border border-clay-border px-3 py-2.5">
                    <span className="w-7 h-7 rounded-full bg-primary-lighter text-primary-text flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Icon className="w-4 h-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <span className="text-[13px] font-bold text-gray-800">{m.name}</span>
                        {m.locked && (
                          <span className="text-[9px] font-bold px-[5px] py-[1px] rounded-full bg-amber-100 text-amber-700 border border-amber-200">{wwT('wipBadge')}</span>
                        )}
                      </span>
                      <span className="block text-[13px] text-gray-700 leading-relaxed mt-0.5">{m.body}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm">
            <p className="text-xs font-bold text-gray-800 mb-1.5 flex items-center gap-1.5"><BookOpen className="w-4 h-4 text-primary" />{t('rpIntroSourceTitle')}</p>
            <p className="text-sm text-gray-700 leading-relaxed">{t('rpIntroSourceBody')}</p>
          </div>

          <div className="bg-white rounded-2xl border border-gray-100 p-4 shadow-sm">
            <p className="text-xs font-bold text-gray-800 mb-1.5 flex items-center gap-1.5"><Coins className="w-4 h-4 text-amber-700" />{t('rpIntroPriceTitle')}</p>
            <p className="text-sm text-gray-700 leading-relaxed">{t('rpIntroPriceBody')}</p>
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
            <p className="text-xs font-bold text-amber-900 mb-1.5 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" />{t('rpIntroRiskTitle')}</p>
            <p className="text-sm text-amber-900/80 leading-relaxed">{t('rpIntroRiskBody')}</p>
          </div>

          <button
            onClick={goList}
            className="w-full bg-primary-strong text-white font-semibold rounded-full py-3.5 shadow-soft hover:bg-primary active:scale-[0.98] transition-all"
          >
            {t('rpIntroStart')}
          </button>
        </div>
      </div>
    );
  }

  /**
   * 成人模式的公共浮层：18+ 年龄闸门 + 瞬时提示。
   *
   * ⚠️ 2026-09-27（A 案）：这两个 portal 必须挂在**所有 stage**，不能只留在「剧情对话」那一支里。
   * 实测教训：引导卡从「聊一聊」过来时用户停在**剧本列表**层、就地开启又发生在**剧本详情**的温馨提示里
   * 这两层都拿不到只有对话页才渲染的那份 JSX，于是 adultGateOpen=true 置了却**弹不出闸门**、
   * 瞬时提示也永远不出现（用户点下去像没反应）。所以下面三个 stage 的 return 各自套一层。
   * portal 挂 body 的原因见闸门自身注释（Home 的 {modals} 会盖住本页任何 fixed 后代）。
   */
  const adultOverlays = (
    <>
      {adultGateOpen && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[95] bg-black/50 flex items-center justify-center p-4" onClick={() => { if (!adultGateBusy) setAdultGateOpen(false); }}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-center gap-2 mb-2">
              <AlertTriangle className="w-5 h-5 text-amber-700" />
              <h3 className="text-lg font-bold text-gray-800">{t('adultGateTitle')}</h3>
            </div>
            <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">{t('adultGateBody')}</p>
            <div className="mt-3 rounded-xl border border-rose-100 bg-rose-50/70 px-3 py-2.5">
              <p className="text-[12px] text-rose-900/85 leading-relaxed whitespace-pre-line">{t('adultGateLimits')}</p>
            </div>
            {!!adultGateErr && <p className="mt-2 text-[12px] text-amber-700">{adultGateErr}</p>}
            <div className="mt-4 space-y-2">
              <button
                onClick={confirmAdultAndEnable}
                disabled={adultGateBusy}
                className="w-full bg-primary-strong text-white font-semibold rounded-full py-2.5 hover:bg-primary active:scale-[0.98] transition-all disabled:opacity-60"
              >
                {t('adultGateConfirm')}
              </button>
              <button
                onClick={() => {
                  setAdultGateOpen(false); setAdultGateErr(''); setUnlimitedNotice(t('adultGateUnderageMsg'));
                  // 「这句 notice 挂在抽屉里」，抽屉没开（引导卡 / 详情页弹窗里就地开启这两条路）时他看不到，
                  // 所以要补一句瞬时提示，别让点击像没反应；抽屉开着（用户自己拨开关）时保持原地提示，避免两处重复。
                  if (adultGateFromIntent.current || !prefOpen) showAdultToast(t('adultGateUnderageMsg'));
                  adultGateFromIntent.current = false;
                }}
                disabled={adultGateBusy}
                className="w-full bg-gray-100 text-gray-600 font-medium rounded-full py-2.5 hover:bg-gray-200 transition-all disabled:opacity-60"
              >
                {t('adultGateUnderage')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {/* 瞬时提示（2.6s 自动消失）：只用在「开关开在别处、用户当场看不到结果」的时刻（引导卡自动开启、
          年龄未满、模型不可用）。刻意不做成常驻横幅，聊天界面保持干净，不堆提示（用户 2026-09-27 要求）。 */}
      {!!adultToast && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed left-1/2 -translate-x-1/2 top-4 z-[90] max-w-[92vw] px-3.5 py-2 rounded-full bg-gray-900/88 text-white text-[12.5px] leading-snug shadow-lg pointer-events-none text-center"
          role="status"
          aria-live="polite"
        >
          {adultToast}
        </div>,
        document.body,
      )}
    </>
  );

  // ===== 剧本列表 =====
  if (stage === 'list') {
    return (
      <>
        {adultOverlays}
      <div className="min-h-[100dvh] bg-brand">
        {/* 狼人杀未开放提示条：挂在最外层（祖先里没有 backdrop-filter，`fixed` 才真的相对视口定位） */}
        {wwWipTip && (
          <div
            role="status"
            aria-live="polite"
            data-testid="rp-werewolf-wip-tip"
            className="fixed bottom-28 left-1/2 -translate-x-1/2 z-[95] bg-gray-800/90 text-white text-sm px-4 py-2 rounded-full shadow-lg max-w-[86vw] text-center"
          >
            {wwT('wipToast')}
          </div>
        )}
        {rpCoachOpen && (
          <FeatureCoachmarks steps={rpCoachSteps} onDone={finishRpCoach} />
        )}
        <div className="sticky top-0 z-10 bg-white/85 backdrop-blur border-b border-gray-100">
          <div className="max-w-2xl mx-auto px-3 py-2 flex items-center justify-between">
            <button onClick={onBack} aria-label={t('backHome')} title={t('backHome')} className="flex items-center text-sm text-ink-soft hover:text-gray-700 transition-colors p-2 -ml-2 min-h-[44px] min-w-[48px]">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <p className="font-semibold text-gray-800">{t('rpModuleTitle')}</p>
            <div className="flex items-center">
              <button
                ref={rpIntroBtnRef}
                onClick={() => setStage('intro')}
                aria-label={t('rpIntroAgain')}
                title={t('rpIntroAgain')}
                className="p-2 rounded-lg text-ink-soft hover:text-primary-text hover:bg-primary-lighter transition-colors"
              >
                <Info className="w-5 h-5" />
              </button>
              <FeedbackButton />
            </div>
          </div>
          {/* 平行模式切换：角色剧情扮演 | AI 文游（同为一级模式，地位对等） */}
          <div className="max-w-2xl mx-auto px-3 pb-2.5">
            <div className="grid grid-cols-3 gap-1 bg-gray-100 rounded-full p-1">
              <button
                ref={rpModeBtnRef}
                onClick={() => setStage('list')}
                className={"rounded-full py-2 text-sm font-semibold transition-all " + (stage === 'list' ? 'bg-white text-primary-text shadow-sm' : 'text-ink-soft hover:text-primary-text')}
              >
                {t('roleplayTitle')}
              </button>
              <button
                ref={rpWenyouBtnRef}
                onClick={() => setStage('wenyou')}
                className="rounded-full py-2 text-sm font-semibold transition-all text-ink-soft hover:text-primary-text"
              >
                {t('wyTabLabel')}
              </button>
              {/* 注意：stage === 'werewolf' 时本页会提前 return 整页渲染，所以这里不需要「选中态」样式 */}
              {/* 未开放闸门：锁定态点它只弹「正在开发中」（见 openWerewolf），普通用户进不去对局 */}
              <button
                ref={rpWerewolfBtnRef}
                onClick={openWerewolf}
                data-testid="rp-werewolf-tab"
                data-ww-locked={werewolfUnlocked ? undefined : '1'}
                aria-disabled={werewolfUnlocked ? undefined : true}
                title={werewolfUnlocked ? undefined : wwT('wipToast')}
                className={"rounded-full py-2 text-sm font-semibold transition-all whitespace-nowrap " + (werewolfUnlocked ? 'text-ink-soft hover:text-primary-text' : 'text-ink-soft')}
              >
                {wwT('tab')}
                {!werewolfUnlocked && (
                  <span
                    className="ml-1 align-[2px] text-[9px] font-bold px-[5px] py-[1px] rounded-full bg-amber-100 text-amber-700 border border-amber-200"
                    data-testid="rp-werewolf-wip-badge"
                  >
                    {wwT('wipBadge')}
                  </span>
                )}
              </button>
            </div>
          </div>
        </div>
        <div className="max-w-2xl mx-auto px-4 py-5">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-bold text-gray-800">{t('rpModuleTitle')}</h1>
          </div>
          <p className="text-sm text-ink-soft mt-1">{t('roleplaySub')}</p>

          {/* 搜索框 */}
          <div className="relative mt-4">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('rpSearchPh')}
              className="w-full pl-9 pr-8 py-2.5 border border-clay-border rounded-xl text-sm bg-white focus:ring-2 focus:ring-primary focus:border-transparent"
            />
            <Search className="w-4 h-4 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-soft hover:text-gray-600 p-1">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* 标签浏览：热门标签（编辑精选）+ 浏览全部按钮 */}
          {tagData && tagData.featured.length > 0 && (() => {
            const count: Record<string, number> = {};
            scenarios.forEach(s => (s.tags || []).forEach(t => { count[t] = (count[t] || 0) + 1; }));
            const totalTags = (tagData.groups || []).reduce((n, g) => n + g.tags.length, 0);
            return (
              <div className="mt-3">
                <p className="text-[11px] text-ink-soft font-medium mb-1.5">{t('rpHotTags')}</p>
                <div className="flex flex-wrap gap-1.5">
                  {tagData.featured.map(tag => (
                    <button
                      key={tag}
                      onClick={() => setSearchQuery(tag)}
                      className={"px-2.5 py-1 rounded-full text-[11px] font-medium border transition-all " + (searchQuery.trim() === tag ? 'bg-primary text-white border-primary' : 'bg-white text-gray-600 border-gray-200 hover:border-primary hover:text-primary-text')}
                    >
                      {tag}
                      <span className={"ml-1 text-[10px] " + (searchQuery.trim() === tag ? 'text-white/80' : 'text-ink-soft')}>{count[tag] || ''}</span>
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setStage('tags')}
                  className="mt-2.5 w-full flex items-center justify-center gap-1.5 py-2 rounded-xl border border-dashed border-primary/30 bg-primary-lighter/40 text-[12px] font-medium text-primary-text hover:bg-primary-lighter hover:border-primary active:scale-[0.99] transition-all"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                  {t('rpBrowseAllTags')}
                  <span className="text-[10px] text-primary-text/60">({totalTags})</span>
                  <span className="text-primary-text/50">→</span>
                </button>
              </div>
            );
          })()}

          {/* 搜索结果 */}
          {searchResults && (
            <div className="mt-5">
              {searching ? (
                <div className="text-center text-ink-soft py-6">{t('roleplayLoading')}</div>
              ) : searchResults.length === 0 ? (
                <div className="text-center text-ink-soft py-8">
                  <p className="text-sm">{t('rpSearchEmpty')}</p>
                  <button onClick={() => setSearchQuery('')} className="mt-2 text-xs text-primary hover:underline">{t('rpSearchClear')}</button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {searchResults.map(s => (
                    <RPStoryCard
                      key={s.id}
                      s={s}
                      onOpen={() => openStoryDetail(s)}
                      onLike={() => toggleLike(s)}
                      liked={likeInfo(s).liked}
                      count={likeInfo(s).count}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 自建剧本入口 */}
          <button
            ref={rpCreateBtnRef}
            onClick={handleCreateClick}
            className="mt-4 w-full flex items-center justify-center gap-2 rounded-xl border-2 border-primary bg-primary-soft px-4 py-3 text-[15px] font-bold text-primary-text shadow-sm active:scale-[.99] transition-all"
          >
            <Sparkles className="w-4 h-4" />
            {t('rpCustomCreate')}
          </button>
          <div className="mt-5 space-y-3">
            {loading ? (
              <div className="text-center text-ink-soft py-10">{t('roleplayLoading')}</div>
            ) : (
              <>
              {authUser && customScenarios.length > 0 && (
                <div className="rounded-2xl border border-gray-100 bg-white/60 overflow-hidden">
                  <div className="flex items-center gap-1.5 px-3 py-2.5">
                    <span className="w-1.5 h-4 rounded-full bg-primary flex-shrink-0" />
                    <span className="text-xs font-bold text-gray-600 flex-1">{t('rpCustomMy')}</span>
                    <span className="text-ink-soft text-xs font-normal">{customScenarios.length}</span>
                  </div>
                  <div className="px-3 pb-3 space-y-1.5">
                    {customScenarios.map(c => (
                      <div key={c.id} className="rounded-lg hover:bg-primary-lighter/60 transition-colors">
                        <div className="flex items-center gap-1">
                          <button onClick={() => enterChat(toScenarioInfo(c), { gesture: true })} className="flex-1 flex items-center gap-2 text-left px-2 py-1.5 min-w-0">
                            {c.avatar ? <img src={c.avatar} alt="" loading="lazy" decoding="async" className="w-7 h-7 rounded-full object-cover ring-1 ring-primary/20 flex-shrink-0" /> : <span className="text-base flex-shrink-0">🎭</span>}
                            <span className="flex-1 min-w-0">
                              <span className="block text-[13px] font-semibold text-gray-800 truncate">{c.title}</span>
                              <span className="block text-[11px] text-ink-soft truncate">{c.aiName || c.aiPersona}</span>
                            </span>
                          </button>
                          {customStatusBadge(c)}
                          <button onClick={() => handleEditCustom(c)} aria-label={t('rpCustomEdit')} title={t('rpCustomEdit')} className="p-1.5 text-ink-soft hover:text-primary-text transition-colors flex-shrink-0">
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button onClick={() => handlePublishCustom(c, !c.published)} className="p-1.5 text-ink-soft hover:text-primary-text transition-colors flex-shrink-0" aria-label={c.published ? t('rpUnpublish') : t('rpPublish')} title={c.published ? t('rpUnpublish') : t('rpPublish')}>
                            <Upload className="w-4 h-4" />
                          </button>
                          <button onClick={() => handleDeleteCustom(c.id)} aria-label={t('rpCustomDelete')} title={t('rpCustomDelete')} className="p-1.5 text-ink-soft hover:text-red-500 transition-colors flex-shrink-0">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                        {c.status === 'rejected' && c.reviewNote && (
                          <div className="px-2 pb-1.5 pt-0.5 text-[11px] leading-snug text-amber-700 bg-amber-50/60 rounded-md">{t('rpReviewPrefix')} {c.reviewNote}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {searchResults === null && sortedScenarios.some(s => s.likes > 0) && (
                <div className="mb-5">
                  <div className="flex items-center gap-1.5 mb-2.5 px-0.5">
                    <span className="w-1.5 h-4 rounded-full bg-amber-400 flex-shrink-0" />
                    <h2 className="text-[13px] font-bold text-gray-600">{t('rpFeaturedTitle')}</h2>
                    <span className="text-[11px] text-ink-soft">{t('rpFeaturedSub')}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {sortedScenarios.filter(s => s.likes > 0).slice(0, 6).map(s => (
                      <RPStoryCard key={s.id} s={s} onOpen={() => openStoryDetail(s)} onLike={() => toggleLike(s)} liked={likeInfo(s).liked} count={likeInfo(s).count} />
                    ))}
                  </div>
                </div>
              )}
              {searchResults === null && playerCreated.length > 0 && (
                <div className="mb-5">
                  <div className="flex items-center gap-1.5 mb-2.5 px-0.5">
                    <span className="w-1.5 h-4 rounded-full bg-primary flex-shrink-0" />
                    <h2 className="text-[13px] font-bold text-gray-600">{t('rpFeaturedCuratedTitle')}</h2>
                    <span className="text-[11px] text-ink-soft">{t('rpFeaturedCuratedSub')}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {playerCreated.map(c => (
                      <div key={c.id} className="rounded-xl border border-primary/20 bg-white/70 p-3 cursor-pointer hover:border-primary/40 transition-colors" onClick={() => enterChat(toScenarioInfo(c), { gesture: true })}>
                        <div className="flex items-center gap-2">
                          <span className="text-lg">⭐</span>
                          <span className="text-[13px] font-semibold text-gray-800 truncate">{c.title}</span>
                        </div>
                        <p className="mt-1 text-[11px] text-ink-soft line-clamp-2">{c.aiPersona || c.background}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {searchResults === null && community.length > 0 && (
                <div className="mb-5">
                  <div className="flex items-center gap-1.5 mb-2.5 px-0.5">
                    <span className="w-1.5 h-4 rounded-full bg-primary flex-shrink-0" />
                    <h2 className="text-[13px] font-bold text-gray-600">{t('rpCommunityTitle')}</h2>
                    <span className="text-[11px] text-ink-soft">{t('rpCommunitySub')}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {community.map(c => (
                      <div key={c.id} className="rounded-xl border border-gray-100 bg-white/70 p-3 cursor-pointer hover:border-primary/40 transition-colors" onClick={() => enterChat(toScenarioInfo(c), { gesture: true })}>
                        <div className="flex items-center gap-2">
                          <span className="text-lg">🎭</span>
                          <span className="text-[13px] font-semibold text-gray-800 truncate">{c.title}</span>
                        </div>
                        <p className="mt-1 text-[11px] text-ink-soft line-clamp-2">{c.aiPersona || c.background}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {searchResults === null && [
                { key: 'her', title: t('rpGroupHer'), items: sortedScenarios.filter(s => s.audience === 'her') },
                { key: 'him', title: t('rpGroupHim'), items: sortedScenarios.filter(s => s.audience === 'him') },
                { key: 'lgbt', title: t('rpGroupLgbt'), items: sortedScenarios.filter(s => s.audience === 'lgbt') },
              ].filter(g => g.items.length > 0).map(g => (
                <div key={g.key}>
                  <div className="flex items-center gap-2 mb-2.5 px-0.5">
                    <h2 className="text-[13px] font-bold text-gray-600">{g.title}</h2>
                    <span className="text-[11px] text-ink-soft">{g.items.length}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {g.items.map(s => (
                      <RPStoryCard
                        key={s.id}
                        s={s}
                        onOpen={() => openStoryDetail(s)}
                        onLike={() => toggleLike(s)}
                        liked={likeInfo(s).liked}
                        count={likeInfo(s).count}
                      />
                    ))}
                  </div>
                </div>
              ))}
              </>
            )}
          </div>
        </div>
      </div>
      </>
    );
  }

  // ===== 全部标签（分组浏览）=====
  if (stage === 'tags') {
    const count: Record<string, number> = {};
    scenarios.forEach(s => (s.tags || []).forEach(t => { count[t] = (count[t] || 0) + 1; }));
    const q = tagFilter.trim().toLowerCase();
    const pick = (tag: string) => { setSearchQuery(tag); rpGoUp(); };
    const featured = tagData?.featured || [];
    const groups = (tagData?.groups || [])
      .map(g => ({ ...g, tags: q ? g.tags.filter(t => t.toLowerCase().includes(q)) : g.tags }))
      .filter(g => g.tags.length > 0);
    const totalTags = (tagData?.groups || []).reduce((n, g) => n + g.tags.length, 0);
    const meta: Record<string, { icon: string }> = { setting: { icon: '🏙️' }, character: { icon: '👤' }, dynamic: { icon: '💞' }, vibe: { icon: '💛' }, other: { icon: '🏷️' } };
    return (
      <div className="min-h-[100dvh] bg-brand">
        <div className="sticky top-0 z-10 bg-white/85 backdrop-blur border-b border-gray-100">
          <div className="max-w-2xl mx-auto px-3 py-2 flex items-center justify-between">
            <button onClick={rpGoUp} aria-label={t('roleplayBack')} title={t('roleplayBack')} className="flex items-center text-sm text-gray-700 hover:text-primary-text p-2 -ml-2 min-h-[44px] min-w-[48px]">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <p className="font-semibold text-gray-800">{t('rpTagsAll')}</p>
            <FeedbackButton />
          </div>
        </div>
        <div className="max-w-2xl mx-auto px-4 py-5 space-y-4">
          {/* 页头 */}
          <div className="text-center pt-1">
            <h1 className="text-lg font-bold text-gray-800">{t('rpTagsAll')}</h1>
            <p className="text-xs text-ink-soft mt-1">{t('rpTagsHint')}</p>
          </div>

          {/* 快速筛选 */}
          <div className="relative">
            <input
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              placeholder={t('rpSearchPh')}
              className="w-full pl-9 pr-8 py-2.5 border border-clay-border rounded-xl text-sm bg-white focus:ring-2 focus:ring-primary focus:border-transparent"
            />
            <Search className="w-4 h-4 text-ink-soft absolute left-3 top-1/2 -translate-y-1/2" />
            {tagFilter && (
              <button onClick={() => setTagFilter('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-soft hover:text-gray-600 p-1">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* 热门精选 */}
          {!q && featured.length > 0 && (
            <div className="rounded-2xl bg-gradient-to-br from-primary to-primary-strong p-4 text-white shadow-soft">
              <p className="text-xs font-bold mb-2.5 flex items-center gap-1.5"><Star className="w-3.5 h-3.5" />{t('rpHotTags')}</p>
              <div className="flex flex-wrap gap-2">
                {featured.map(tag => (
                  <button key={tag} onClick={() => pick(tag)} className="px-3 py-1.5 rounded-full bg-white/15 hover:bg-white/25 border border-white/20 text-[12px] font-medium backdrop-blur transition-colors">
                    {tag}
                    <span className="ml-1 text-[10px] text-white/70">{count[tag] || ''}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 分组标签 */}
          {groups.length === 0 ? (
            <div className="text-center text-ink-soft py-12 text-sm">{t('rpSearchEmpty')}</div>
          ) : (
            groups.map(g => (
              <div key={g.key} className="bg-white rounded-2xl border border-clay-border p-4 shadow-sm">
                <p className="text-[13px] font-bold text-gray-700 mb-3 flex items-center gap-2">
                  <span className="text-base leading-none">{meta[g.key]?.icon || '🏷️'}</span>
                  {g.label}
                  <span className="ml-auto text-[10px] font-medium text-ink-soft bg-gray-100 rounded-full px-2 py-0.5">{g.tags.length}</span>
                </p>
                <div className="flex flex-wrap gap-2">
                  {g.tags.map(tag => (
                    <button
                      key={tag}
                      onClick={() => pick(tag)}
                      className="group px-3 py-1.5 rounded-full text-[12px] font-medium bg-clay-bg text-gray-600 border border-gray-100 hover:border-primary hover:text-primary-text hover:bg-primary-lighter transition-all"
                    >
                      {tag}
                      <span className="ml-1 text-[10px] text-ink-soft group-hover:text-primary-text/60">{count[tag] || ''}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}

          <p className="text-center text-[11px] text-ink-soft">{t('rpTagsTotal', { n: totalTags })}</p>
        </div>
      </div>
    );
  }

  // ===== 自建剧本 / 编辑剧本（登录用户）=====
  if (stage === 'custom') {
    const exitCustom = () => { setEditingCustom(null); rpGoUp(); };
    const isEdit = !!editingCustom;
    const canSubmit = customForm.aiPersona.trim() && customForm.background.trim() && customForm.opening.trim();
    // 【编辑态「已修改」标注：与进入编辑时的原值（customBaseline）对比，AI 回填与手动改动都会亮起；可单字段恢复原样】
    // 自建剧本可编辑字段：只作类型用（原为 `const fk = [...] as const` + `typeof fk[number]`，
    // 那个值从来没被读过，eslint 报「assigned a value but only used as a type」）
    type CustomFieldKey = 'title' | 'aiName' | 'aiPersona' | 'background' | 'opening';
    const changed = (k: CustomFieldKey) => !!customBaseline && (customForm[k] || '') !== (customBaseline[k] || '');
    const revertField = (k: CustomFieldKey) => {
      if (!customBaseline) return;
      setCustomForm(s => ({ ...s, [k]: customBaseline[k] }));
      setDraftOk(false);
    };
    const fieldCls = (k: CustomFieldKey) => changed(k) ? inputCls + ' border-amber-300 ring-1 ring-amber-200 bg-amber-50/30 focus:ring-amber-300 focus:border-amber-300' : inputCls;
    const changeNote = (k: CustomFieldKey) => changed(k) ? (
      <div className="mt-1 flex items-center gap-1.5 flex-wrap">
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 px-2 py-0.5 text-[10px] font-semibold leading-none">
          {t('rpCustomChangedBadge')}
        </span>
        <button
          type="button"
          onClick={() => revertField(k)}
          className="inline-flex items-center gap-1 text-[11px] text-primary-text hover:text-primary transition-colors"
        >
          <RotateCcw className="w-3 h-3" />
          {t('rpCustomRevert')}
        </button>
      </div>
    ) : null;
    const inputCls = 'w-full border border-clay-border rounded-xl px-3 py-2.5 text-sm bg-white focus:ring-2 focus:ring-primary focus:border-transparent';
    const setF = (k: 'title' | 'aiName' | 'aiPersona' | 'background' | 'opening') => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setCustomForm(s => ({ ...s, [k]: e.target.value }));
    return (
      <div className="min-h-[100dvh] bg-brand">
        <div className="sticky top-0 z-10 bg-white/85 backdrop-blur border-b border-gray-100">
          <div className="max-w-2xl mx-auto px-3 py-2 flex items-center justify-between">
            <button onClick={exitCustom} aria-label={t('roleplayBack')} title={t('roleplayBack')} className="flex items-center text-sm text-gray-700 hover:text-primary-text p-2 -ml-2 min-h-[44px] min-w-[48px]">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <p className="font-semibold text-gray-800">{isEdit ? t('rpCustomEditTitle') : t('rpCustomCreate')}</p>
            <FeedbackButton />
          </div>
        </div>
        <div className="max-w-2xl mx-auto px-4 py-5 space-y-4">
          <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2">{isEdit ? <Pencil className="w-5 h-5 text-primary" /> : <Sparkles className="w-5 h-5 text-primary" />}{isEdit ? t('rpCustomEditTitle') : t('rpCustomCreate')}</h1>
          <p className="text-sm text-ink-soft leading-relaxed">{isEdit ? t('rpCustomEditHint') : t('rpCustomHint')}</p>
          {isEdit && editingCustom?.published && (
            <p className="text-[11px] text-amber-600">
              {editingCustom.status === 'rejected' && editingCustom.reviewNote ? (<>{t('rpStatusRejected')}： {editingCustom.reviewNote}</>) : t('rpPublishedHint')} · {t('rpCustomEditRePub')}
            </p>
          )}
          {/* AI 辅助创建剧本：一句话灵感 → 草稿回填（每次生成消耗 1 条聊天额度） */}
          <div className="rounded-2xl border border-primary/25 bg-gradient-to-br from-primary-lighter/70 to-white p-4 shadow-sm">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary-text" />
              <p className="text-[13px] font-bold text-gray-800">{isEdit ? t('rpCustomAiEditTitle') : t('rpCustomAiTitle')}</p>
            </div>
            <p className="text-[11px] text-ink-soft leading-relaxed mt-1">{isEdit ? t('rpCustomAiEditHint') : t('rpCustomAiHint')}</p>
            <div className="flex items-end gap-2 mt-2.5">
              <textarea
                aria-label={t('composerLabel')}
                ref={draftIdeaRef}
                value={draftIdea}
                onChange={(e) => { setDraftIdea(e.target.value); setDraftOk(false); }}
                placeholder={isEdit ? t('rpCustomAiEditPh') : t('rpCustomAiPh')}
                rows={2}
                className="flex-1 resize-none border border-clay-border rounded-xl px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-primary focus:border-transparent"
              />
              <button
                onClick={() => handleAiDraft()}
                disabled={drafting || !draftIdea.trim()}
                className="inline-flex items-center gap-1.5 rounded-xl bg-primary-strong text-white text-[13px] font-semibold px-3.5 py-2.5 shadow-soft hover:bg-primary active:scale-[0.98] transition-all disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {drafting ? <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                {drafting ? t('rpCustomAiLoading') : draftOk ? (isEdit ? t('rpCustomAiEditAgain') : t('rpCustomAiAgain')) : (isEdit ? t('rpCustomAiEditRun') : t('rpCustomAiRun'))}
              </button>
            </div>
            {draftError && <p className="text-[11px] text-red-500 mt-1.5">{draftError}</p>}
            {draftOk && !draftError && <p className="text-[11px] text-primary-text mt-1.5 flex items-center gap-1"><Sparkles className="w-3 h-3" />{isEdit ? t('rpCustomAiEditDone') : t('rpCustomAiDone')}</p>}
            <p className="text-[10px] text-ink-soft mt-1.5">{t('rpCustomAiQuota')}</p>
            {/* 用无限制模型生成剧本：默认关（走 DeepSeek，不占账号并发池）。
                开着生成成人向剧本时不会被"净化成纯情清水"；与剧情开关共用同一个 18+ 确认框 */}
            <div className={'mt-2 flex items-start justify-between gap-3 rounded-xl border px-2.5 py-2 ' + (scriptUnlimitedOn ? 'border-rose-200 bg-rose-50/70' : 'border-clay-border bg-white/70')}>
              <div className="min-w-0">
                <p className={'text-[11px] font-semibold ' + (scriptUnlimitedOn ? 'text-rose-700' : 'text-gray-700')}>{t('rpScriptUnlimited')}</p>
                <p className={'mt-0.5 text-[10px] leading-snug ' + (scriptUnlimitedOn ? 'text-rose-700/75' : 'text-ink-soft')}>{t('rpScriptUnlimitedHint')}</p>
                {unlimitedReady === false && <p className="mt-0.5 text-[10px] text-amber-700">{t('rpUnlimitedUnavailable')}</p>}
                {unlimitedReady !== false && adultConfirmed === false && <p className="mt-0.5 text-[10px] text-amber-700">{t('rpScriptUnlimitedNeedAdult')}</p>}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={scriptUnlimitedOn}
                aria-label={t('rpScriptUnlimited')}
                aria-disabled={unlimitedReady === false}
                onClick={() => changeScriptUnlimited(!scriptUnlimitedOn)}
                className={'relative h-6 w-11 shrink-0 rounded-full transition-colors ' + (unlimitedReady === false ? 'bg-gray-200 opacity-60 cursor-not-allowed' : (scriptUnlimitedOn ? 'bg-rose-500' : 'bg-gray-300'))}
              >
                <span className={'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-[left] ' + (scriptUnlimitedOn ? 'left-[22px]' : 'left-0.5')} />
              </button>
            </div>
          </div>

          <div>
            <input id="rp-custom-title" value={customForm.title} onChange={setF('title')} placeholder={t('rpCustomTitlePh')} className={fieldCls('title')} maxLength={60} />
            {changeNote('title')}
          </div>
          <div>
            <input value={customForm.aiName} onChange={setF('aiName')} placeholder={t('rpCustomNamePh')} className={fieldCls('aiName')} maxLength={40} />
            {changeNote('aiName')}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-gray-600">{t('rpCustomPersonaPh')}</label>
            <textarea value={customForm.aiPersona} onChange={setF('aiPersona')} rows={4} className={fieldCls('aiPersona')} maxLength={2000} />
            {changeNote('aiPersona')}
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-gray-600">{t('rpCustomBgPh')}</label>
            <textarea value={customForm.background} onChange={setF('background')} rows={4} className={fieldCls('background')} maxLength={2000} />
            {changeNote('background')}
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-gray-600">{t('rpCustomOpeningPh')}</label>
            <textarea value={customForm.opening} onChange={setF('opening')} rows={4} className={fieldCls('opening')} maxLength={2000} />
            {changeNote('opening')}
          </div>

          {/* 角色头像 + 聊天背景图（可选；图片过大时支持自选裁剪） */}
          <div className="space-y-4 rounded-2xl border border-clay-border p-4 bg-white/60">
            <ImageUploadCrop
              label={t('rpCustomAvatar')}
              hint={t('rpCustomAvatarHint')}
              value={customForm.avatar}
              onChange={(v) => setCustomForm(s => ({ ...s, avatar: v }))}
              aspect={1}
              outputWidth={512}
              circle
              id="rp-custom-avatar"
            />
            <div className="h-px bg-gray-100" />
            <ImageUploadCrop
              label={t('rpCustomBgImage')}
              hint={t('rpCustomBgImageHint')}
              value={customForm.chatBackground}
              onChange={(v) => setCustomForm(s => ({ ...s, chatBackground: v }))}
              id="rp-custom-chat-bg"
            />
          </div>

          {createError && <p className="text-sm text-red-500">{createError}</p>}

          <button
            onClick={handleCreateSubmit}
            disabled={!canSubmit || creating}
            className="w-full bg-primary-strong text-white font-semibold rounded-full py-3.5 shadow-soft hover:bg-primary active:scale-[0.98] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {creating ? t('roleplayLoading') : (isEdit ? t('rpCustomSave') : t('rpCustomSubmit'))}
          </button>
        </div>
      </div>
    );
  }

  // ===== 剧本详情 =====
  if (stage === 'detail' && selected) {
    const s = selected;
    /**
     * 「开场剧情」卡显示的是**场景**文本（与改造前一致：这里一直是 openingScene）。
     * ⚠️ 注：进聊天时用的开场是**台词**优先（`openingAssistant`），两者取舍不同，别顺手统一。
     */
    const detailOpening = (rpMode === 'multi' ? (s.multiOpeningScene || s.multiOpeningAssistant) : '') || s.openingScene;
    return (
      <>
        {adultOverlays}
      <div className="min-h-[100dvh] bg-brand">
        {/* 🔴 2026-09-15 用户要求：剧情自己的浏览首页（进入聊天前）也用上场景图。
            用的是**该剧本的主场景图**（"整部剧发生在属于它的空间里"），缺失时
            `StorySceneBackdrop` 会自动退回共享主题池。
            ⚠️ **必须包一层 `fixed inset-0`**：`StorySceneBackdrop` 自身的根是 `absolute inset-0`，
            而这里的父容器没有定位 → 它只会覆盖"文档顶部一个视口"，**往下滚就露出界面皮肤**
            （用户实测截图：卡片下方仍是皮肤底色）。聊天页当时用了 fixed 包装，这里漏了。 */}
        <div className="pointer-events-none fixed inset-0 z-0">
          <StorySceneBackdrop scenario={s} theme={rpSceneTheme} masterUrl={rpSceneArt.masterUrl} />
        </div>
        <div className="pointer-events-none fixed inset-x-0 top-0 z-[1] h-20 bg-gradient-to-b from-white/55 via-white/40 to-transparent" />
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[1] h-36 bg-gradient-to-t from-white/70 via-white/45 to-transparent" />
        {/* 头部有**剧情标题文字**（比聊天页多一处文字）→ 用 `chrome-white`（下限 0.6，文字要 4.5:1），
            不像聊天页顶栏能压到 0.3（那里只有图标，3:1 即可） */}
        <div className="sticky top-0 z-30 chrome-white backdrop-blur-md border-b border-gray-100">
          <div className="max-w-2xl mx-auto px-3 py-2 flex items-center justify-between">
            <button onClick={rpGoUp} aria-label={t('roleplayBack')} title={t('roleplayBack')} className="flex items-center text-sm text-gray-700 hover:text-primary-text p-2 -ml-2 min-h-[44px] min-w-[48px]">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <p className="font-semibold text-gray-800">{s.title}</p>
            <div className="flex items-center">
              <button
                onClick={() => voice.setEnabled(!voice.enabled)}
                aria-label={voice.enabled ? t('rpVoiceOff') : t('rpVoiceOn')}
                aria-pressed={voice.enabled}
                title={t('rpVoiceAria') + ' · ' + t(rpVoicePick?.preset.label || 'rpVoiceCalm') + (voice.enabled ? '（' + t('rpVoiceOff') + '）' : '')}
                className="relative p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-700 hover:text-primary-text transition-colors"
              >
                {voice.enabled ? <Volume2 className="w-5 h-5 text-primary-text" /> : <VolumeX className="w-5 h-5" />}
                {voice.enabled && voice.speakingId !== null && <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-primary-strong animate-pulse" />}
              </button>
              <button onClick={() => setBgmOpen(true)} aria-label={t('rpBgmAria')} title={t('rpBgmAria')} className="relative p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-700 hover:text-primary-text transition-colors">
                <Music className={'w-5 h-5 ' + (bgm.playing ? 'text-primary-text' : '')} />
                {bgm.playing && <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-primary-strong animate-pulse" />}
              </button>
              <FeedbackButton />
            </div>
          </div>
        </div>
        <div className="relative z-10 max-w-2xl mx-auto px-4 py-5 space-y-4">
          {/* 桥③ 落幕余音：刚离开对局时的一条轻提示（可忽略；文案不进消息集合，红线 6）。
              设定页背后是场景图，这里用近实底白卡 + 模糊，保证对比度（截图复核过：半透明白卡在图上会发灰） */}
          {afterglow && (
            <div className="rounded-2xl border border-clay-border bg-white/95 backdrop-blur-md px-3 py-2.5 shadow-soft">
              <p className="text-[12px] font-medium text-ink">{t('rpBridgeSceneEndTitle')}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-gray-700">{t('rpBridgeSceneEndBody')}</p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  data-testid="rp-bridge-scene-end"
                  onClick={goChatFromAfterglow}
                  className="rounded-full bg-primary text-white text-[12px] px-3 py-1.5 hover:bg-primary-strong transition-colors"
                >
                  {t('rpBridgeSceneEndBtn')}
                </button>
                <button
                  type="button"
                  onClick={() => { markBridgeDismissed(); setAfterglow(false); }}
                  className="text-[11px] text-gray-600 hover:text-gray-800 px-2 py-1.5"
                >
                  {t('rpBridgeSceneEndDismiss')}
                </button>
              </div>
            </div>
          )}
          {/* 大图 hero：竖版人物卡延伸 */}
          <div className="relative overflow-hidden rounded-3xl shadow-soft">
            <RPCover s={s} imgClass="absolute inset-0 w-full h-full object-cover object-top" fallbackClass="absolute inset-0 flex items-center justify-center text-6xl" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/35 to-black/20" />
            <div className={`relative pt-40 sm:pt-48 ${s.avatar ? 'pb-6' : 'min-h-[16rem] pb-6'} px-5 text-white`}>
              <h1 className="text-2xl font-bold mt-2.5 leading-tight drop-shadow-sm">{s.title}</h1>
              {s.tagline && <p className="text-sm text-white/85 mt-1.5 leading-snug line-clamp-2">{s.tagline}</p>}
              {/* 多角色角标（2026-10-01）：与列表卡片同一处标记，进详情页也一眼看得出 */}
              {(s.cast?.length ?? 0) >= 2 && (
                <div className="mt-2.5">
                  <span data-testid="rp-multi-badge-detail" className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary-strong/90 backdrop-blur-sm text-white text-[11px] font-bold leading-none">
                    <Users className="w-3 h-3" />{t('rpBothModesBadge')} · {s.cast!.length}
                  </span>
                </div>
              )}
              {s.tags && s.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {s.tags.map(tag => (
                    <span key={tag} className="px-2 py-0.5 rounded-md bg-white/15 backdrop-blur-sm text-white/95 text-[11px] font-medium leading-none">{tag}</span>
                  ))}
                </div>
              )}
              <div className="mt-3.5 inline-flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => toggleLike(s)}
                  aria-label={likeInfo(s).liked ? t('rpUnlikeAria') : t('rpLikeAria')}
                  title={likeInfo(s).liked ? t('rpUnlikeAria') : t('rpLikeAria')}
                  className="inline-flex items-center gap-1.5 rounded-full bg-black/45 backdrop-blur-sm px-3 py-1.5 text-sm font-semibold text-white/90 hover:text-rose-300 transition-colors"
                >
                  <Heart className={'w-4 h-4 ' + (likeInfo(s).liked ? 'fill-current' : '')} />
                  <span className="tabular-nums">{likeInfo(s).count}</span>
                </button>
              </div>
            </div>
          </div>

          {/* 内容提示（涉心理题材的温和声明） */}
          {s.contentNote && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
              <p className="text-xs font-bold text-amber-700 mb-1 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4" />{t('rpContentNote')}
              </p>
              <p className="text-sm text-amber-800 leading-relaxed">{s.contentNote}</p>
            </div>
          )}

          {/* AI 角色卡 */}
          <div className="card-white-readable backdrop-blur-md rounded-2xl border border-gray-100 p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-2">
              {s.avatar && <img src={s.avatar} alt={s.ai.name} loading="lazy" decoding="async" className="w-9 h-9 rounded-xl object-cover border border-primary/20" />}
              <p className="text-xs font-bold text-primary-text flex items-center gap-1.5">
                <User className="w-4 h-4" />{t('roleplayAiRole')} · {s.ai.name}
              </p>
            </div>
            <p className="text-xs text-ink-soft leading-relaxed">{s.ai.gender} · {s.ai.age} · {s.ai.height}</p>
            <p className="text-sm text-gray-700 leading-relaxed mt-1.5"><b className="text-gray-800">{t('rpLooks')}: </b>{s.ai.looks}</p>
            <p className="text-sm text-gray-700 leading-relaxed mt-1.5"><b className="text-gray-800">{t('rpPersonality')}: </b>{s.ai.personality}</p>
            <p className="text-sm text-gray-700 leading-relaxed mt-1.5"><b className="text-gray-800">{t('rpSpeech')}: </b>{s.ai.speech}</p>
          </div>

          {/* 同场角色（多角色剧本）：把**全部**角色的身份与一句话介绍列出来
              主角的详细设定在上面的 AI 角色卡里，这里仍保留一条（带「主角」标记），
              这样"这部戏有谁"是一份完整名单，而不是让玩家自己去拼。 */}
          {(s.cast?.length ?? 0) >= 2 && (
            <div className="card-white-readable backdrop-blur-md rounded-2xl border border-gray-100 p-4 shadow-sm" data-testid="rp-cast-section">
              <p className="text-xs font-bold text-primary-text mb-2 flex items-center gap-1.5">
                <Users className="w-4 h-4" />{t('rpCastSection')} · {s.cast!.length}
              </p>
              <p className="text-[11px] text-ink-soft leading-relaxed mb-3">{t('rpCastSectionHint')}</p>
              <div className="space-y-3">
                {s.cast!.map(c => (
                  <div key={c.id} className="flex gap-2.5" data-testid={'rp-cast-card-' + c.id}>
                    <div className="w-9 h-9 rounded-full overflow-hidden bg-primary-soft flex items-center justify-center flex-shrink-0 text-[13px] font-semibold text-primary-text ring-1 ring-primary/20">
                      <CastAvatar member={c} scenario={s} imgClass="w-full h-full object-cover" textClass="text-[13px] font-semibold" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-gray-800 flex items-center gap-1.5 flex-wrap">
                        {c.name}
                        {c.role && <span className="text-[10px] font-normal text-ink-soft">{c.role}</span>}
                        {c.lead && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-primary-soft text-primary-text leading-none">{t('rpCastLeadTag')}</span>
                        )}
                      </p>
                      {c.desc && <p className="text-[12px] text-gray-700 leading-relaxed mt-0.5">{c.desc}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 用户角色卡 */}
          <div className="card-white-readable backdrop-blur-md rounded-2xl border border-gray-100 p-4 shadow-sm">
            <p className="text-xs font-bold text-gray-700 mb-2 flex items-center gap-1.5">
              <Heart className="w-4 h-4 text-amber-700" />{t('roleplayUserRole')} · {s.user.name}
            </p>
            <p className="text-xs text-ink-soft leading-relaxed">{s.user.gender} · {s.user.age} · {s.user.height}</p>
            <p className="text-sm text-gray-700 leading-relaxed mt-1.5"><b className="text-gray-800">{t('rpLooks')}: </b>{s.user.looks}</p>
            <p className="text-sm text-gray-700 leading-relaxed mt-1.5"><b className="text-gray-800">{t('rpPersonality')}: </b>{s.user.personality}</p>
          </div>

          {/* 角色名自定义（跨语言沉浸） */}
          <div className="card-white-readable backdrop-blur-md rounded-2xl border border-clay-border p-4 shadow-sm">
            <p className="text-xs font-bold text-gray-800 mb-1">{t('rpNameCustom')}</p>
            <p className="text-[11px] text-ink-soft mb-3">{t('rpNameCustomHint')}</p>
            <div className="space-y-2.5">
              <div>
                <label className="block text-xs text-ink-soft mb-1">{t('rpNameAi')}</label>
                <input
                  value={aiName}
                  onChange={(e) => { setAiName(e.target.value); saveRpNames(s.id, e.target.value, userName); }}
                  placeholder={s.ai.name}
                  maxLength={20}
                  className="w-full px-3 py-2 border border-clay-border rounded-lg text-sm bg-transparent placeholder:text-gray-700 focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-ink-soft mb-1">{t('rpNameUser')}</label>
                <input
                  value={userName}
                  onChange={(e) => { setUserName(e.target.value); saveRpNames(s.id, aiName, e.target.value); }}
                  placeholder={s.user.name}
                  maxLength={20}
                  className="w-full px-3 py-2 border border-clay-border rounded-lg text-sm bg-transparent placeholder:text-gray-700 focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
                />
              </div>
            </div>
          </div>

          {/* 背景故事 */}
          <div className="card-white-readable backdrop-blur-md rounded-2xl border border-gray-100 p-4 shadow-sm">
            <p className="text-xs font-bold text-gray-800 mb-2 flex items-center gap-1.5">
              <ScrollText className="w-4 h-4 text-primary" />{t('roleplayBackground')}
            </p>
            <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{s.background}</p>
          </div>

          {/* 开场剧情（按当前模式显示：多角色线可写专属开场） */}
          <div className="card-white-readable backdrop-blur-md rounded-2xl border border-gray-100 p-4 shadow-sm">
            <p className="text-xs font-bold text-gray-800 mb-2 flex items-center gap-1.5">
              <BookOpen className="w-4 h-4 text-primary" />{t('roleplayOpening')}
            </p>
            <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{detailOpening}</p>
          </div>

          {/**
            * 模式选择（2026-10-01 双模式）：同一部剧本两条线，**各一份存档**、互不影响。
            * 只有登记了 cast（>= 2 人）的剧本才显示这张卡；其余仍是纯单角色剧本。
            */}
          {(s.cast?.length ?? 0) >= 2 && (
            <div className="card-white-readable backdrop-blur-md rounded-2xl border border-gray-100 p-4 shadow-sm" data-testid="rp-mode-switch">
              <p className="text-xs font-bold text-gray-800 mb-2 flex items-center gap-1.5">
                <Users className="w-4 h-4 text-primary" />{t('rpModeTitle')}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { key: 'solo' as const, label: t('rpModeSolo'), hint: t('rpModeSoloHint') },
                  { key: 'multi' as const, label: t('rpModeMulti'), hint: t('rpModeMultiHint') },
                ]).map(o => (
                  <button
                    key={o.key}
                    type="button"
                    data-testid={'rp-mode-' + o.key}
                    aria-pressed={rpMode === o.key}
                    onClick={() => {
                      setRpMode(o.key);
                      try { lsSet(rpModeKey(s.id), o.key); } catch { /* 存储被禁：仅本次会话生效 */ }
                    }}
                    className={'text-left rounded-xl border px-3 py-2.5 transition-all ' + (rpMode === o.key
                      ? 'border-primary bg-primary-lighter/70 ring-1 ring-primary/30'
                      : 'border-clay-border bg-white/70 hover:border-primary/50')}
                  >
                    <span className="block text-[13px] font-bold text-gray-800">{o.label}</span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-ink-soft">{o.hint}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/**
            * 叙事模式（2026-10-02，用户要求「开始剧情的时候就要能选」）：
            * 以前这一项只在**进了对话之后**（顶栏药丸）和偏好抽屉里能改，等于用户先开演、
            * 写完一轮才发现"原来还能是小说/对话"。现在把它提到详情页、紧挨着进入按钮。
            * ⚠️ 三处入口（这里 / 聊天顶栏 / 偏好抽屉）**共用** narrativeStyle 与 changeNarrativeStyle，
            * 不要各写一份状态，否则会出现在 A 处改了、B 处还显示旧值。
            */}
          <div className="card-white-readable backdrop-blur-md rounded-2xl border border-gray-100 p-4 shadow-sm" data-testid="rp-narrative-switch">
            <p className="text-xs font-bold text-gray-800 mb-1 flex items-center gap-1.5">
              <Pencil className="w-4 h-4 text-primary" />{t('rpStyleSection')}
            </p>
            <p className="text-[11px] leading-snug text-ink-soft mb-3">{t('rpStyleSectionHint')}</p>
            <div className="grid grid-cols-2 gap-2">
              {([
                { key: 'classic' as const, label: t('rpStyleClassic'), hint: t('rpStyleClassicHint') },
                { key: 'immersive' as const, label: t('rpStyleImmersive'), hint: t('rpStyleImmersiveHint') },
              ]).map(o => (
                <button
                  key={o.key}
                  type="button"
                  data-testid={'rp-narrative-' + o.key}
                  aria-pressed={narrativeStyle === o.key}
                  onClick={() => changeNarrativeStyle(o.key, false)}
                  className={'text-left rounded-xl border px-3 py-2.5 transition-all ' + (narrativeStyle === o.key
                    ? 'border-primary bg-primary-lighter/70 ring-1 ring-primary/30'
                    : 'border-clay-border bg-white/70 hover:border-primary/50')}
                >
                  <span className="block text-[13px] font-bold text-gray-800">
                    {o.label}{narrativeStyle === o.key ? ' ✓' : ''}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-ink-soft">{o.hint}</span>
                </button>
              ))}
            </div>
          </div>

          <SourceAttribution src={s.source} sourceUrl={s.sourceUrl} />
          {hasSaved && (
            <p className="text-center text-[12px] text-amber-600 mb-1">{t('rpResumeHint')}</p>
          )}
          <button
            onClick={() => setTipOpen(true)}
            className="w-full bg-primary-strong text-white font-semibold rounded-full py-3.5 shadow-soft hover:bg-primary active:scale-[0.98] transition-all"
          >
            {hasSaved ? t('rpContinue') : t('roleplayStart')}
          </button>

          {/* 把剧情角色加到聊一聊（方案 A1）：把 TA 从"剧里"带到常驻聊天窗口，人设 + 你们的共同经历一起过去。
              入口下的一行小字先说清模式差异，点开后的确认卡里再用一整块讲「不是剧情模式 + 开不了无限制模式」。 */}
          <div className="mt-1">
            <button
              type="button"
              data-testid="rp-to-chat-entry"
              onClick={() => { setToChatErr(null); setToChatOpen(true); }}
              className="w-full flex items-center justify-center gap-1.5 rounded-full border border-primary/30 bg-white/70 backdrop-blur-sm text-primary-text text-[13px] font-medium py-2.5 hover:border-primary transition-colors"
            >
              <BookOpen className="w-4 h-4" />
              {t('rpToChatEntry')}
            </button>
            <p className="mt-1.5 text-center text-[11px] text-ink-soft leading-relaxed">{t('rpToChatHint')}</p>
          </div>

          {/* 导入确认卡：明写「带过去什么 / 不带什么」，并置顶一块「这不是剧情模式 / 无限制模式开不了」
              （合规与预期管理都在这张卡上；用户 2026-09-25 要求补模式差异说明） */}
          {toChatOpen && (
            <Modal onClose={() => setToChatOpen(false)} showClose={false} width="max-w-sm" padding="p-5" maxHeight="max-h-[calc(100dvh-2rem)]" panelClassName="overscroll-contain">
              <h3 className="text-base font-bold text-gray-800">{t('rpToChatConfirmTitle', { name: aiName.trim() || s.ai.name })}</h3>
              {/* 模式差异说明（2026-09-25 用户要求）：进来的人常以为「加过去＝换个地方接着演剧情」，
                  并会去找「无限制模式」开关。这里明说：这是聊一聊的日常聊天，不是剧情模式；
                  无限制模式是剧情专属、聊一聊里开不了。纯文案，不改变导入行为（本来就不迁移无限制模式）。 */}
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/80 px-3 py-2.5" data-testid="rp-to-chat-not-story">
                <p className="text-[12px] font-bold text-amber-800 mb-1 flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5" />{t('rpToChatNotStoryTitle')}
                </p>
                <p className="text-[12px] text-amber-900/85 leading-relaxed">{t('rpToChatNotStoryBody')}</p>
                <p className="mt-1.5 text-[12px] font-medium text-amber-900/85 leading-relaxed">{t('rpToChatNoUnlimited')}</p>
              </div>
              <p className="mt-2 text-[13px] text-gray-700 leading-relaxed">{t('rpToChatConfirmBring')}</p>
              <p className="mt-2 text-[13px] text-gray-700 leading-relaxed">{t('rpToChatConfirmNotBring')}</p>
              <p className="mt-2 text-[12px] text-ink-soft leading-relaxed">{t('rpToChatConfirmAgain')}</p>
              {toChatErr && <p className="mt-2 text-[12px] text-red-600" data-testid="rp-to-chat-err">{toChatErr}</p>}
              <div className="mt-4 space-y-2">
                <button
                  type="button"
                  data-testid="rp-to-chat-confirm"
                  disabled={toChatBusy}
                  onClick={() => void doImportToChat()}
                  className="w-full bg-primary-strong text-white font-semibold rounded-full py-2.5 hover:bg-primary active:scale-[0.98] transition-all disabled:opacity-60"
                >
                  {toChatBusy ? t('rpToChatBusy') : t('rpToChatConfirm')}
                </button>
                <button
                  type="button"
                  onClick={() => setToChatOpen(false)}
                  className="w-full bg-gray-100 text-gray-600 font-medium rounded-full py-2.5 hover:bg-gray-200 transition-all"
                >
                  {t('rpToChatCancel')}
                </button>
              </div>
            </Modal>
          )}
          {/* 进入剧情前的温馨提示 */}
          {tipOpen && (
            <Modal onClose={() => setTipOpen(false)} showClose={false} width="max-w-sm" padding="p-5" maxHeight="max-h-[calc(100dvh-2rem)]" panelClassName="overscroll-contain">
                <div className="flex items-center justify-center gap-2 mb-2">
                  <AlertTriangle className="w-5 h-5 text-amber-700" />
                  <h3 className="text-lg font-bold text-gray-800">{t('roleplayTipTitle')}</h3>
                </div>
                <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">{t('roleplayTipBody')}</p>
                {/* 内容尺度告知：让用户知道成人向剧情可以主动推进（同时写明与 safety.ts 一致的边界）。
                    2026-09-27 用户要求「直接点开剧情时也要明显提示、要让用户知道这是**需要被开启才有**的」：
                    这里就是那个时刻（每次进剧情前都会过这一关），所以① 明写「默认关」；② 给一键就地开启。
                    原来自带的那条「进剧情 → 右上角『我的偏好』」定位句已被这个按钮取代（少一行字、少两步走）：
                    点它就地开（未过 18+ 会先弹年龄闸门），状态就地翻成「已开启」，再点「我已了解，进入剧情」即可。 */}
                <div className="mt-3 rounded-xl border border-rose-100 bg-rose-50/70 px-3 py-2.5">
                  <p className="text-xs font-bold text-rose-700 mb-1 flex items-center gap-1.5">
                    <Heart className="w-3.5 h-3.5" />{t('rpScopeTitle')}
                  </p>
                  <p className="text-[13px] text-rose-900/85 leading-relaxed whitespace-pre-line">{t('rpScopeBody')}</p>
                  {unlimitedReady === false ? (
                    <p className="mt-2 text-[12px] font-medium text-amber-700 leading-relaxed">{t('rpUnlimitedUnavailable')}</p>
                  ) : unlimitedOn ? (
                    <p className="mt-2 text-[12px] font-semibold text-rose-700 leading-relaxed">{t('rpScopeOn')}</p>
                  ) : (
                    <>
                      <p className="mt-2 text-[12px] text-rose-900/80 leading-relaxed">{t('rpScopeOff')}</p>
                      <button
                        type="button"
                        data-testid="rp-scope-open-pref"
                        onClick={() => changeUnlimitedOn(true)}
                        className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-3.5 py-1.5 text-[12px] font-semibold text-white hover:bg-rose-700 active:scale-[0.98] transition-all"
                      >
                        <SlidersHorizontal className="w-3.5 h-3.5" />
                        {t('rpScopeOpen')}
                      </button>
                    </>
                  )}
                  <p className="mt-1.5 text-[11px] text-rose-700/80">{t('rpScopeAdult')}</p>
                </div>
                {s.contentNote && (
                  <p className="mt-2 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 leading-relaxed">{s.contentNote}</p>
                )}
                <div className="mt-4 space-y-2">
                  <button
                    onClick={() => { setTipOpen(false); enterChat(s, { gesture: true, mode: rpMode }); }}
                    className="w-full bg-primary-strong text-white font-semibold rounded-full py-2.5 hover:bg-primary active:scale-[0.98] transition-all"
                  >
                    {t('roleplayTipConfirm')}
                  </button>
                  <button
                    onClick={() => setTipOpen(false)}
                    className="w-full bg-gray-100 text-gray-600 font-medium rounded-full py-2.5 hover:bg-gray-200 transition-all"
                  >
                    {t('roleplayTipCancel')}
                  </button>
                </div>
            </Modal>
          )}

          {/* 配乐面板（详情页即可换曲/关闭/调音量；进对话同曲延续不重播） */}
          <StoryBgmPanel open={bgmOpen} onClose={() => setBgmOpen(false)} scenario={s} bgm={bgm} ambience={ambience} />
        </div>
      </div>
      </>
    );
  }

  // ===== 剧情对话 =====
  const s = selected;
  const rpContext = messages.map(m => (m.role === 'user' ? (getLang() === 'en' ? 'Me: ' : '我：') : (aiName || s?.ai?.name || (getLang() === 'en' ? 'Them' : 'TA')) + (getLang() === 'en' ? ': ' : '：')) + m.content).join('\n');
  /**
   * 多角色（群像）渲染上下文（2026-10-01）
   *   · 只有 cast.length >= 2 才启用；
   *   · 主角色（lead）的标记名跟随用户自定义名：与后端 roleplayReply、开场白替换**三处必须同口径**，
   *     否则前端认不出服务端下发的标记，整段会退回旁白；
   *   · 单角色剧本 cast 为空 → 下面所有分支都走原路径，行为逐字不变。
   */
  const castNames: CastName[] = (s?.cast?.length ?? 0) >= 2
    ? (s!.cast as CastName[]).map(c => (c.lead && aiName.trim() ? { ...c, name: aiName.trim() } : c))
    : [];
  const castActive = castNames.length >= 2;
  /** 要"没有标记"的展面（长图分享 / TTS / 引用）统一走它；单角色剧本原样返回 */
  const withoutTags = (text: string): string => (castActive ? stripCastTags(text, castNames) : text);
  /** 群像气泡的小头像：与详情页「同场角色」共用同一个组件（主角=剧本头像） */
  const castAvatar = (member: CastName) => (
    <CastAvatar member={member} scenario={s} imgClass="w-full h-full object-cover" textClass="text-[11px]" />
  );
  return (
    <>
      {adultOverlays}
    <div
      ref={rpShellRef}
      className={
        IS_ANDROID
          ? "inset-x-0 top-0 flex flex-col w-full max-w-2xl mx-auto bg-brand overflow-hidden overscroll-none"
          : "fixed inset-x-0 top-0 flex flex-col w-full max-w-2xl mx-auto bg-brand overflow-hidden overscroll-none"
      }
      style={
        IS_ANDROID
          ? { position: 'absolute', top: 0, bottom: liftBottom || 0 }
          // ⚠️ 2026-09-15 用户反馈「输入框下面有很大一块空白」→ 查清了：那块空白**是皮肤氛围背景图**
          // （`.skin-backdrop` 是铺满视口的 fixed 层，而聊天壳用透明的 `bg-brand`）→ 只要壳比视口矮就会露出来。
          // 原写法 `height: visualViewport.height` 与 `bottom: kbInset` **等价**（bottom 也是按同一个高度算的），
          // 所以两者都会在"可视视口 < 布局视口"时留白。
          // 现改为：**默认锚定布局视口底边**（`bottom: 0`），只有在**真键盘弹起**时才抬底边。
          // 阈值 120px：真软键盘 ≥ ~200px，而浏览器工具栏收缩通常 ≤ ~100px，目的是不把"工具栏"误判成"键盘"。
          : { top: vvOffsetTop ? vvOffsetTop + 'px' : 0, bottom: liftBottom || 0 }
      }
    >
      <StoryShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        title={t('rpShareTitle')}
        partnerName={aiName || s?.ai?.name || t('appName')}
        titleNameKey="rpShareTitleWithName"
        subtitle={s ? s.title : undefined}
        bubbles={messages.flatMap((m): StoryBubble[] => {
          if (m.role === 'user') return [{ side: 'me', name: t('chatShareMe'), content: m.content }];
          const fallbackName = aiName || s?.ai?.name || t('appName');
          // 多角色：长图里按说话人拆成多条，各自带自己的名字（标记不落进长图）
          if (castActive) {
            const segs = parseCastSegments(m.content, castNames);
            if (hasCastSpeaker(segs)) {
              return segs.map((seg): StoryBubble => ({ side: 'them', name: seg.speaker ? seg.speaker.name : fallbackName, content: seg.text }));
            }
          }
          return [{ side: 'them', name: fallbackName, content: m.content }];
        })}
      />
      {/* ⚠️ 2026-09-15 用户要求顶栏也跟随「卡片不透明度」变透明 → 与气泡/输入栏同一套
          （`card-white` + 毛玻璃；默认 80% 时观感与原来的 bg-white/85 几乎一致，往下拖才明显透出场景）。
          注意：图标是 `text-ink-soft`，全透时压在亮场景上对比度会变低，见 CHANGELOG 里记录的这个取舍。 */}
      {/* ⚠️ z-30：**必须高于模式行的 z-20**。原来顶栏与模式行同为 z-10、模式行 DOM 更靠后
          → 顶栏里的「⋯」下拉（哪怕写了 z-50）也被限制在顶栏的层叠上下文里，**整片被模式行盖住**
          （用户反馈"点开后内容被叙事模式选择覆盖了"）。 */}
      <div className="relative z-30 chrome-white-top backdrop-blur-md border-b border-gray-100 flex-shrink-0">
        <div className="px-3 py-2 flex items-center justify-between">
          <button onClick={rpGoUp} aria-label={t('roleplayBack')} title={t('roleplayBack')} className="flex items-center text-sm text-gray-700 hover:text-primary-text p-2 -ml-2 min-h-[44px] min-w-[48px]">
            <ArrowLeft className="w-5 h-5" />
          </button>
          {/* 聊天页不展示剧情名，把空间留给常用设置图标。
              ⚠️ 2026-09-15 用户反馈「顶栏图标有点挤了」：实测：7 个图标塞在 304px 里、**彼此间隙 0px**（手机 390px）。
              7 个图标在这个宽度本来就不够放，所以把**低频 4 项**（意见反馈 / 专属画面 / 重新开始 / 分享对话）收进「⋯」，
              常驻 5 个 + 「⋯」用 justify-between 均匀铺开 → 间隙更宽，触摸区仍保持 44px。
              「重新开始」是破坏性操作，收进菜单顺带更安全（不会误点）。 */}
          <div className="flex items-center flex-1 justify-between pl-1">
            <button
              onClick={() => voice.setEnabled(!voice.enabled)}
              aria-label={voice.enabled ? t('rpVoiceOff') : t('rpVoiceOn')}
              aria-pressed={voice.enabled}
              title={t('rpVoiceAria') + ' · ' + t(rpVoicePick?.preset.label || 'rpVoiceCalm') + (voice.enabled ? '（' + t('rpVoiceOff') + '）' : '')}
              className="relative p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-700 hover:text-primary-text transition-colors"
            >
              {voice.enabled ? <Volume2 className="w-5 h-5 text-primary-text" /> : <VolumeX className="w-5 h-5" />}
              {voice.enabled && voice.speakingId !== null && <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-primary-strong animate-pulse" />}
            </button>
            <button onClick={() => setBgmOpen(true)} className="relative p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-700 hover:text-primary-text transition-colors" aria-label={t('rpBgmAria')} title={t('rpBgmAria')}>
              <Music className={'w-5 h-5 ' + (bgm.playing ? 'text-primary-text' : '')} />
              {bgm.playing && <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-primary-strong animate-pulse" />}
            </button>
            <button onClick={() => setStoryInfoOpen(true)} className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-700 hover:text-primary-text transition-colors" aria-label={t('rpStoryInfo')} title={t('rpStoryInfo')}>
              <BookOpen className="w-5 h-5" />
            </button>
            {/* 「我的偏好」：无限制模式的状态就长在这个图标上，**不另加横幅/气泡**（聊天界面保持干净）。
                ① 没开且可用 → 右上角一颗小红点：一眼知道「这里有个还没开的东西」；
                ② 开了 → 图标转玫红；title / aria 始终带上状态文字，悬停、读屏都拿得到具体开还是关。 */}
            <button
              onClick={openPref}
              className={'relative p-2 min-h-[44px] min-w-[44px] flex items-center justify-center transition-colors ' + (unlimitedOn ? 'text-rose-600 hover:text-rose-700' : 'text-gray-700 hover:text-primary-text')}
              aria-label={t('rpPreference') + ' · ' + (unlimitedOn ? t('rpUnlimitedOnShort') : t('rpUnlimitedOffShort'))}
              title={t('rpPreference') + ' · ' + (unlimitedOn ? t('rpUnlimitedOnShort') : t('rpUnlimitedOffShort'))}
            >
              <SlidersHorizontal className="w-5 h-5" />
              {unlimitedReady === true && !unlimitedOn && (
                <span className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-rose-400" aria-hidden="true" />
              )}
            </button>
            {/* 「⋯」：收纳低频项（界面外观 / 意见反馈 / 分享对话 / 重新开始），让常驻图标有呼吸感。
                注意：**菜单本体不在这里渲染**（见文件下方聊天壳层的 `{rpMoreOpen && …}`）
                顶栏自带 backdrop-blur-md，菜单留在顶栏里就只是"半透明没有毛玻璃"。 */}
            <div className="relative flex-shrink-0" ref={rpMoreRef}>
              <button
                onClick={toggleMoreMenu}
                aria-label={rpMoreOpen ? t('rpMoreClose') : t('rpMoreOpen')}
                aria-expanded={rpMoreOpen}
                title={t('rpMoreOpen')}
                className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-700 hover:text-primary-text transition-colors"
              >
                {rpMoreOpen ? <X className="w-5 h-5" /> : <MoreHorizontal className="w-5 h-5" />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 顶栏「⋯」菜单本体：渲染在**聊天壳层**（与顶栏并列），而不是顶栏内部，这是毛玻璃能生效的前提。
          ⚠️ 踩过的坑：顶栏自己有 `backdrop-blur-md` ⇒ 顶栏成了它内部元素的 **backdrop root**，
          菜单挂在顶栏里时，它自己的 `backdrop-filter` 只能糊到"顶栏自己的像素"（菜单悬在顶栏外面，
          那块是空的）→ 实测观感就是"半透明但没毛玻璃、底下的字直接穿上来"。
          搬成壳的直接子节点后 backdrop 覆盖整页，毛玻璃才真正生效。
          A/B 证据：`temp/verify-rp-menu-backdroproot.mjs`（去掉父级 backdrop-filter 后菜单区梯度能量 15.90 → 10.64）。
          面板本身：半透明白（**保读性下限 0.48**，菜单是要读清楚才能点对的交互列表，不能全跟随滑块）+ 毛玻璃。 */}
      {rpMoreOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setRpMoreOpen(false)} />
          <div ref={rpMoreMenuRef} style={{ top: rpMorePos.top, right: rpMorePos.right }} className="bg-white absolute z-50 w-48 rounded-2xl shadow-lift border border-clay-border py-1.5 overflow-hidden">
            <button
              onClick={() => { setRpMoreOpen(false); setAppearanceOpen(true); }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-left text-gray-700 hover:bg-gray-50"
            >
              <Palette className="w-4 h-4 text-primary" />
              <span className="flex-1">{t('skinAppearance')}<span className="ml-1.5 text-[10px] text-ink-soft">{t('rpTransparencyHint')}</span></span>
            </button>
            <button
              onClick={() => { setRpMoreOpen(false); setFeedbackOpen(true); }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-left text-gray-700 hover:bg-gray-50"
            >
              <SkinFeedbackIcon className="w-4 h-4 text-primary" />
              <span className="flex-1">{t('profileFeedback')}</span>
            </button>
            <button
              onClick={() => { setRpMoreOpen(false); setShareOpen(true); }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-left text-gray-700 hover:bg-gray-50"
            >
              <Share2 className="w-4 h-4 text-primary" />
              <span className="flex-1">{t('chatShare')}</span>
            </button>
            <button
              onClick={() => { setRpMoreOpen(false); restart(); }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-left text-red-500 hover:bg-red-50"
            >
              <RotateCcw className="w-4 h-4" />
              <span className="flex-1">{t('roleplayRestart')}</span>
            </button>
          </div>
        </>
      )}

      {/* 剧情叙事风格选择（两种模式自选）
          ⚠️ 2026-09-15 用户要求两点，这里一起满足：
          ① **透明度跟随顶栏**：改 `chrome-white-top`（与顶栏同一个 clamp(0.18, 滑块, 0.3)）。
             之所以能这么透：两个模式名各自坐在**开关自己的轨道**上（`bg-gray-100/80` / 选中态绿底），
             可读性由轨道保证，**不依赖这一行的背景**。
          ② **压缩占位**：原来"开关 + 一行常驻 11px 说明文字"占 87px，而说明文字正是这一行不能更透的
             唯一原因（11px 小字要 4.5:1）。改成**切换时才浮现的浮层提示**（绝对定位、不占布局、
             `pointer-events-none`）→ 行高降到 ~56px，且不再有文字压在半透背景上。 */}
      <div className="relative z-20 flex-shrink-0 chrome-white-top backdrop-blur-md border-b border-gray-100 px-3 sm:px-4 py-2">
        <div className="flex rounded-full bg-gray-100/80 p-0.5">
          <button
            onClick={() => changeNarrativeStyle('classic')}
            aria-pressed={narrativeStyle === 'classic'}
            className={'flex-1 rounded-full py-1.5 text-xs font-medium transition-all ' + (narrativeStyle === 'classic' ? 'bg-primary-strong text-white shadow-sm' : 'text-gray-700 hover:text-gray-900')}
          >
            {t('rpStyleClassic')}
          </button>
          <button
            onClick={() => changeNarrativeStyle('immersive')}
            aria-pressed={narrativeStyle === 'immersive'}
            className={'flex-1 rounded-full py-1.5 text-xs font-medium transition-all ' + (narrativeStyle === 'immersive' ? 'bg-primary-strong text-white shadow-sm' : 'text-gray-700 hover:text-gray-900')}
          >
            {t('rpStyleImmersive')}
          </button>
        </div>
        {/* 切换时浮现的说明（3.5s 自动消失；绝对定位 → 不引起布局跳动、不占空间） */}
        {rpStyleHint && (
          <p className="pointer-events-none absolute inset-x-2 top-full mt-1 z-30 rounded-xl bg-black/70 backdrop-blur-sm px-3 py-1.5 text-[11px] leading-snug text-white text-center shadow-soft">
            {narrativeStyle === 'classic' ? t('rpStyleClassicHint') : t('rpStyleImmersiveHint')}
          </p>
        )}
      </div>

      {/* 保读性白纱（**不吃「卡片不透明度」滑块**）：顶/底各一层极淡渐变。
          为什么必须有：滑块拖到 0%（全透）时，顶栏图标（text-ink-soft）与模式行那行 11px 说明文字
          压在**亮场景**上会低于无障碍对比度（实测全透时约 3.8:1 < AA 4.5），这层保证"再透也读得清"。
          它是**下限**，不是遮罩：只在最上 144px / 最下 112px 有，中间完全是场景。 */}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[1] h-20 bg-gradient-to-b from-white/55 via-white/40 to-transparent" />
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[1] h-36 bg-gradient-to-t from-white/70 via-white/45 to-transparent" />

      {/* ⚠️ 这个容器**不能带 z-index**（`position:relative` + `z-index:auto` 才不创建层叠上下文）。
          原因：铺满整屏的背景层放在它里面，若这里给了 z-10，整个容器会成为层叠上下文、连带背景层一起
          压到顶栏/模式行之上（两者同为 z-10、DOM 更靠前）→ **场景图直接盖住顶栏**（实测踩到过）。
          现在背景层在本容器内是 z-0，与 chrome 的 z-10 在**同一个**（壳的）层叠上下文里比较 → 顺序正确。 */}
      <div className="relative flex-1 overflow-hidden">
      {/* 场景画面：自建剧本上传的背景图优先；否则用共享「主题池图」（换幕 + 淡入淡出 + 缓推拉）
          两者都铺底 + 半透明白遮罩，保证气泡可读 */}
      {s?.chatBackground ? (
        /* 🔴 2026-09-15 用户选 A：背景层由「只铺中间聊天区」改为**铺满整个视口**（`fixed inset-0`），
           顶栏/模式行/输入栏全部浮在场景之上，否则顶栏透明后露出的是**皮肤氛围背景**（浅色），
           会形成"浅色顶栏 → 硬边切进深色场景"的接缝。`pointer-events-none` 保证不拦截任何点击。 */
        <div className="pointer-events-none fixed inset-0 z-0">
          <img src={s.chatBackground} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
          <div className="absolute inset-0 bg-white/75" />
        </div>
      ) : (
        <div className="pointer-events-none fixed inset-0 z-0">
          <StorySceneBackdrop scenario={s} theme={rpSceneTheme} overrideUrl={rpSceneArt.ownUrl || rpSceneArt.url} masterUrl={rpSceneArt.masterUrl} preheatUrls={rpSceneArt.ownUrls} />
          {/* 半透明白遮罩：太厚会把插画洗掉（2026-09-14 复盘"对比度很低"调轻一档）。
              ⚠️ 2026-09-15 用户反馈"背景图效果不是很好"→ 实测再调轻：原 18%/38%/52% 把画面中下部洗掉近半，
              而正文本身是**白底卡片**、可读性不依赖这层遮罩 → 改成 10%/24%/40%（仍是"上清下沉"的既有设计意图）。
              注意：**正文气泡在自己卡片上**，所以这层只需给整体定调，不需要承担文字对比度。 */}
          <div className="absolute inset-0 bg-gradient-to-b from-white/10 via-white/24 to-white/40" />
          {/* 氛围层（S4 伪动效）：雨丝/浮尘/烛光呼吸等；只叠在遮罩之上、气泡之下；reduced-motion 时整层不渲染。
              主场景图固定后，**换幕的观感就靠这一层做调色/光效变化** */}
          <StorySceneAtmosphere theme={rpSceneTheme || ''} />
        </div>
      )}
      {/* 专属画面生成的轻提示（4s 自动消失；不阻塞剧情） */}
      {rpSceneArt.msg ? (
        <div data-testid="rp-scene-msg" className="absolute left-1/2 -translate-x-1/2 top-3 z-20 rounded-full bg-black/65 text-white text-[12px] px-3 py-1.5 shadow-soft max-w-[85%] text-center">
          {rpSceneArt.msg}
        </div>
      ) : null}
      <div ref={scrollRef} onScroll={updateRPScrollState} onWheel={rpMarkUserScrolling} onTouchStart={rpMarkUserScrolling} onTouchMove={rpMarkUserScrolling} onPointerDown={rpMarkUserScrolling} onKeyDown={rpMarkUserScrolling} className={'relative z-10 h-full overflow-y-auto px-3 sm:px-4 space-y-3 [overflow-anchor:none] ' + (rpSceneArt.msg ? 'pt-12 pb-4' : 'py-4')}>
        {messages.map((m, i) => {
          // 这一条 AI 回复的版本信息（没重生成过 = 单版，不显示切换器）
          const vers = m.role === 'assistant' ? versionsOf(m) : [];
          const viNow = vers.length > 0 ? versionIndex(m) : 0;
          // 每条 AI 回复都能重新生成；开场白（前面没有用户消息）除外
          const regenOk = canRegenerateAt(messages, i);
          /**
           * 用户消息的「编辑重发」入口（2026-09，1B + 2A）：
           * 只有**最后一条用户消息**可编辑（`canEditAt`），编辑过才有多分支可切（`userVers`）。
           * 这两个判据都写在 `src/lib/rpVersions.ts` 里（有单测），组件里不再各判一套。
           */
          const canEdit = m.role === 'user' && canEditAt(messages, i);
          const userVers = m.role === 'user' ? versionsOf(m) : [];
          const userVi = userVers.length > 0 ? versionIndex(m) : 0;
          const branchOk = m.role === 'user' && canSwitchUserBranchAt(messages, i);
          /**
           * 多角色分段（2026-10-01）：只有 assistant + 该剧本有 cast 时才解析；
           * 解析器是**流式容错**的，所以流式打字过程中每个渲染帧都能拿到当前已判定的段落，
           * 打字机自然就是"上一位说完、下一位的气泡才出现"。识别不到标记 → multi 为假 → 原单气泡。
           */
          /**
           * 开场白打字机（O1）：只切**第 0 条 assistant 消息的渲染文本**
           * 解析与显示都用切片，复制/落盘/长图分享/TTS 仍取 m.content 全文。
           * 多角色剧本下，切片推进 + 流式容错解析器 = 每个角色的气泡逐个出现、各自逐字长出来。
           */
          const shown = openingTyped !== null && i === 0 && m.role === 'assistant' ? m.content.slice(0, openingTyped) : m.content;
          const segs = castActive && m.role === 'assistant' ? parseCastSegments(shown, castNames) : [];
          const multi = castActive && hasCastSpeaker(segs);
          return (
          <div key={i} className={'flex items-end gap-2 ' + (m.role === 'user' ? 'justify-end' : 'justify-start')}>
            {m.role === 'assistant' && !multi && (
              <div className="w-8 h-8 rounded-full overflow-hidden bg-primary-soft flex items-center justify-center flex-shrink-0 text-base ring-1 ring-primary/20 shadow-sm">
                <RPCover s={s} imgClass="w-full h-full" fallbackClass="text-base" />
              </div>
            )}
            <div className={'flex flex-col max-w-[85%] ' + (m.role === 'user' ? 'items-end' : 'items-start')}>
              {multi ? (
                /* 群像：一段一个气泡。带标记的段落 = 该角色（自己的头像 + 名字 + 台词卡），
                   没有标记的段落 = 旁白（缩进对齐台词、无名字、字色更淡）。
                   与单气泡共用同一套 surface token（card-white），四套皮肤下都不翻车。 */
                <div className="flex flex-col gap-1.5 w-full" data-testid={'rp-cast-group-' + i}>
                  {segs.map((seg, k) => (seg.speaker ? (
                    <div key={k} className="flex items-end gap-2" data-testid={'rp-cast-seg-' + i + '-' + k}>
                      <div className="w-7 h-7 rounded-full overflow-hidden bg-primary-soft flex items-center justify-center flex-shrink-0 text-[11px] font-medium text-primary-text ring-1 ring-primary/20 shadow-sm">
                        {castAvatar(seg.speaker)}
                      </div>
                      <div className="flex flex-col items-start min-w-0">
                        <div className="mb-0.5 px-1 text-[11px] font-medium text-ink-soft">{seg.speaker.name}</div>
                        <div className="max-w-full rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap break-words shadow-sm card-white backdrop-blur-sm text-ink border border-gray-100 rounded-bl-sm">
                          <RoleplayRichText text={seg.text} lang={rpLang} />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div key={k} className="pl-9 max-w-full rounded-2xl px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap break-words card-white backdrop-blur-sm text-ink-soft border border-gray-100 rounded-bl-sm" data-testid={'rp-cast-narration-' + i + '-' + k}>
                      <RoleplayRichText text={seg.text} lang={rpLang} />
                    </div>
                  )))}
                </div>
              ) : (
              <div className={'max-w-full rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap break-words shadow-sm ' + (m.role === 'user' ? 'bg-primary-strong text-white rounded-br-sm' : 'card-white backdrop-blur-sm text-ink border border-gray-100 rounded-bl-sm') + (editTarget === i ? ' ring-2 ring-amber-300 ring-offset-1 ring-offset-white/40' : '')}>
                {/* 用户消息直出原文；AI 回复走三档渲染（对白「」/旁白/括号心声），
                    复制 / 落盘 / 长图分享 / TTS 一律仍取 m.content 原文 */}
                {m.role === 'user' ? m.content : <RoleplayRichText text={shown} lang={rpLang} />}
              </div>
              )}
              {/* 我发的那句话：编辑重发入口 + 分支切换（◀ n/m ▶）。
                  只有「最后一条用户消息」出现（2A）；编辑过之后才出现切换器（1B）。
                  与 AI 回复那排小胶囊同一套视觉，但右对齐（贴着用户气泡）。 */}
              {m.role === 'user' && (canEdit || branchOk) && !sending && !regenerating && !continuing && (
                <div className="mt-1 flex items-center gap-1.5 justify-end">
                  {branchOk && (
                    <div data-testid={'rp-user-branches-' + i} className="inline-flex items-center rounded-full border border-clay-border bg-white/80 shadow-sm">
                      <button
                        type="button"
                        data-testid={'rp-user-branch-prev-' + i}
                        onClick={() => switchUserBranch(i, -1)}
                        disabled={userVi === 0}
                        aria-label={t('rpVersionPrev')}
                        title={t('rpVersionPrev')}
                        className="pl-1 pr-0.5 py-1.5 text-ink-soft hover:text-primary-text disabled:opacity-30 transition-colors select-none"
                      >
                        <ChevronLeft className="w-3.5 h-3.5" />
                      </button>
                      <span className="px-0.5 text-[11px] leading-none tabular-nums text-ink-soft select-none">{t('rpVersionLabel', { n: userVi + 1, total: userVers.length })}</span>
                      <button
                        type="button"
                        data-testid={'rp-user-branch-next-' + i}
                        onClick={() => switchUserBranch(i, 1)}
                        disabled={userVi === userVers.length - 1}
                        aria-label={t('rpVersionNext')}
                        title={t('rpVersionNext')}
                        className="pl-0.5 pr-1 py-1.5 text-ink-soft hover:text-primary-text disabled:opacity-30 transition-colors select-none"
                      >
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                  {canEdit && (
                    /* 图标按钮、不写文字（2026-09 用户口径：「拿出来也不用加名字，可以直接放图标」）。
                       可发现性靠 aria-label + title；尺寸与「复制」小胶囊同档（p-1.5 + w-3.5 图标）。 */
                    <button
                      type="button"
                      data-testid={'rp-edit-' + i}
                      onClick={() => (editTarget === i ? cancelEdit() : openEdit(i))}
                      aria-label={t('rpEdit')}
                      title={t('rpEdit')}
                      className={'inline-flex items-center justify-center rounded-full border border-clay-border bg-white/80 p-1.5 text-ink-soft shadow-sm transition-colors hover:text-primary-text ' + (editTarget === i ? 'text-primary-text border-primary-soft bg-primary-lighter' : '')}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )}
              {m.role === 'assistant' && textLegendIdx === i && (
                <button
                  type="button"
                  data-testid="rp-text-legend"
                  onClick={dismissTextLegend}
                  title={t('rpTextLegendDismiss')}
                  className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-primary-soft bg-primary-lighter px-2.5 py-1 text-[11px] text-primary-text shadow-sm transition-colors hover:bg-primary-soft"
                >
                  <Info className="w-3 h-3" />
                  {t('rpTextLegend')}
                </button>
              )}
              {m.role === 'assistant' && isHalfMessage(m) && (
                /**
                 * 「这条没写完」（B 方案）。此前是**完全静默**的：半截台词被当成完整回复显示、
                 * 落盘、还回灌给模型当上下文（2026-09-18 诊断）。
                 * 现在给一个明确的、克制的提示 + 一个「续写」入口：
                 *   - 不自动改写用户已经看到的正文（半截也是内容，用户可能已经在读）；
                 *   - 续写由服务端接着断点写，结果作为这条的新一版（◀/▶ 可回看半截）。
                 */
                <div data-testid={'rp-incomplete-' + i} className="mt-1.5 flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-amber-200 bg-amber-50/85 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-amber-900">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>{t('rpIncompleteNotice')}</span>
                  <button
                    type="button"
                    data-testid={'rp-continue-' + i}
                    onClick={() => void continueAt(i)}
                    disabled={sending || regenerating || continuing}
                    aria-label={t('rpContinueWriting')}
                    title={t('rpContinueWriting')}
                    className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-white/90 px-2 py-0.5 text-[11px] leading-none font-medium text-amber-900 shadow-sm transition-colors hover:bg-amber-100 disabled:opacity-40"
                  >
                    <Sparkles className="w-3 h-3" />
                    {continuing ? t('rpContinuing') : t('rpContinueWriting')}
                  </button>
                </div>
              )}
              {m.role === 'assistant' && (
                <div className="mt-1 flex items-center gap-1.5 w-full">
                  <AiFeedbackMark context={rpContext} />
                  {/* 常显复制：不用长按也能单独复制 TA 的这一条（引用回复需后端存 replyTo，本轮未做） */}
                  {/* 复制/配音取**剃掉标记**的文本：多角色剧本的 m.content 里带着【角色名】标记，
                      原样复制会把标记粘给别人、原样合成会把角色名念出来（落盘与版本切换仍用原文）。 */}
                  <CopyButton text={withoutTags(m.content)} />
                  {/* 角色配音：听 TA 说这一轮（开启配音后出现；未合成时是静态入口，点了才合成） */}
                  {rpVoiceEnabled && withoutTags(m.content).trim() ? (
                    <VoiceMessage
                      src={voice.readyUrl(String(i), withoutTags(m.content))?.url}
                      duration={voice.readyUrl(String(i), withoutTags(m.content))?.duration ?? null}
                      playing={voice.speakingId === String(i)}
                      loading={voice.loadingId === String(i)}
                      onToggle={() => voice.toggle(String(i), withoutTags(m.content))}
                      accent="brand"
                      loadingLabel={t('voiceAiLoading')}
                      notReadyLabel={t('voiceTapToGenerate')}
                    />
                  ) : null}
                  {(regenOk || vers.length > 1) && !sending && !regenerating && (
                    <div className="ml-auto inline-flex items-center gap-1.5">
                      {/* 版本切换：这条被重新生成过才出现（◀ n/m ▶）。只改这一条，**不动**后面的剧情；
                          下一轮 AI 接着「你正在看的那一版」往下写（context 永远取当前版本） */}
                      {vers.length > 1 && (
                        <div data-testid={'rp-versions-' + i} className="inline-flex items-center rounded-full border border-clay-border bg-white/80 shadow-sm">
                          <button
                            type="button"
                            data-testid={'rp-version-prev-' + i}
                            onClick={() => switchVersion(i, -1)}
                            disabled={viNow === 0}
                            aria-label={t('rpVersionPrev')}
                            title={t('rpVersionPrev')}
                            className="pl-1 pr-0.5 py-1.5 text-ink-soft hover:text-primary-text disabled:opacity-30 transition-colors select-none"
                          >
                            <ChevronLeft className="w-3.5 h-3.5" />
                          </button>
                          <span className="px-0.5 text-[11px] leading-none tabular-nums text-ink-soft select-none">{t('rpVersionLabel', { n: viNow + 1, total: vers.length })}</span>
                          <button
                            type="button"
                            data-testid={'rp-version-next-' + i}
                            onClick={() => switchVersion(i, 1)}
                            disabled={viNow === vers.length - 1}
                            aria-label={t('rpVersionNext')}
                            title={t('rpVersionNext')}
                            className="pl-0.5 pr-1 py-1.5 text-ink-soft hover:text-primary-text disabled:opacity-30 transition-colors select-none"
                          >
                            <ChevronRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                      {/* 重新生成：**每一条** AI 回复都有（开场白除外），样式与 dislike / 复制同款常显小胶囊 */}
                      {regenOk && (
                        <button
                          type="button"
                          data-testid={'rp-regenerate-' + i}
                          onClick={() => openRegenerate(i)}
                          aria-label={t('rpRegenerate')}
                          title={t('rpRegenerate')}
                          className="inline-flex items-center gap-1 rounded-full border border-clay-border bg-white/80 px-2 py-1.5 text-[11px] leading-none text-ink-soft shadow-sm select-none transition-colors hover:text-primary-text hover:border-primary/30"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          {t('rpRegenerate')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          );
        })}
        {(sending || regenerating || continuing || rewriting) && (
          <div className="flex items-end gap-2 justify-start">
            <div className="w-8 h-8 rounded-full overflow-hidden bg-primary-soft flex items-center justify-center flex-shrink-0 text-base ring-1 ring-primary/20 shadow-sm"><RPCover s={s} imgClass="w-full h-full" fallbackClass="text-base" /></div>
            {rewriting && !queueInfo ? (
              /* A 方案：生成后重复闸判到本条复读了历史片段，服务端正在重写一版。
                 必须明说，否则用户会以为刚才那版突然消失了（重写期间没有 delta 流入）。 */
              <div data-testid="rp-rewriting" className="card-white backdrop-blur-sm border border-amber-200 bg-amber-50/80 rounded-2xl rounded-bl-sm px-4 py-3 shadow-soft max-w-[85%]">
                <p className="text-[12px] text-amber-800 flex items-center gap-2">
                  <span className="w-3 h-3 border-2 border-amber-500 border-t-transparent rounded-full animate-spin shrink-0" />
                  {t('rpRewriting')}
                </p>
              </div>
            ) : continuing && !queueInfo ? (
              /* C 方案：自动续写中。必须说清楚是「接着上一条往下写」，否则用户会以为新的一段莫名冒出来 */
              <div data-testid="rp-continuing" className="card-white backdrop-blur-sm border border-amber-200 bg-amber-50/80 rounded-2xl rounded-bl-sm px-4 py-3 shadow-soft max-w-[85%]">
                <p className="text-[12px] text-amber-800 flex items-center gap-2">
                  <span className="w-3 h-3 border-2 border-amber-500 border-t-transparent rounded-full animate-spin shrink-0" />
                  {t('rpContinuing')}
                </p>
              </div>
            ) : queueInfo ? (
              /* 上游并发已满，正在本地排队：明确说清「前面还有几个」，而不是让用户盯着不动的点点猜 */
              <div className="card-white backdrop-blur-sm border border-amber-200 bg-amber-50/80 rounded-2xl rounded-bl-sm px-4 py-3 shadow-soft max-w-[85%]">
                <p className="text-[12px] text-amber-800 flex items-center gap-2">
                  <span className="w-3 h-3 border-2 border-amber-500 border-t-transparent rounded-full animate-spin shrink-0" />
                  {queueInfo.ahead > 0
                    ? t('rpQueueAhead').replace('{n}', String(queueInfo.ahead))
                    : t('rpQueueStarting')}
                </p>
                <p className="mt-1 text-[10px] text-amber-700/80">{t('rpQueueHint')}</p>
              </div>
            ) : (
              <div className="card-white backdrop-blur-sm border border-clay-border rounded-2xl rounded-bl-sm px-4 py-3.5 shadow-soft">
                <TypingDots />
              </div>
            )}
          </div>
        )}
        {/* 🚨 失败提示（2026-09-15）：这里**只**提示 + 重试，绝不再把兜底文案塞进角色气泡 */}
        {sendFailed && !sending && !regenerating && (
          <SendFailedNotice
            testId="rp-send-failed"
            code={sendFailed}
            /**
             * 文案分两类：
             *  · UNANSWERED = 进剧情时发现「上一句还挂着、没人接」（2026-09-18），不是网络错，是那一轮没落上，
             *    所以用「这句还没等到回答」的口径 + 同一个重试按钮（点一下就让角色接上这一句）；
             *  · 其余（TIMEOUT / NETWORK / ABORTED）沿用「这条没发送成功」的文案。
             * 服务端可读错误串（旧行为）继续原样展示。
             */
            text={
              sendFailed === 'UNANSWERED' ? t('rpUnansweredTurnNotice')
                : sendFailed === 'TIMEOUT' || sendFailed === 'NETWORK' || sendFailed === 'ABORTED' ? t('sendFailedNotice')
                : sendFailed
            }
            retryLabel={sendFailed === 'UNANSWERED' ? t('rpUnansweredTurnRetry') : t('sendRetry')}
            onRetry={retryTurn}
            className="max-w-[92%] mx-auto"
          />
        )}
      </div>
        {!rpAtBottom && (
          <button onClick={scrollToLatest} aria-label={t('chatScrollToBottom')} title={t('chatScrollToBottom')} className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 rounded-full bg-primary text-white text-xs font-medium pl-2.5 pr-3 py-2 shadow-lg hover:bg-primary-strong transition-all">
            <ArrowDown className="w-4 h-4" />
            {t('chatScrollToBottom')}
          </button>
        )}
      </div>

      {/* 剧情 → 聊一聊 跨模式桥（B 方案）：只在停顿点出现的一条轻提示。
          桥① 卡壳救援 / 桥② 出戏保护 共用这一个槽位；不弹窗、不遮剧情、不打断流式。
          文案只在这里，绝不写进消息集合（红线 6）。 */}
      {bridgeKind && (
        <div className="relative z-20 flex-shrink-0 px-3 pt-2">
          <div className="card-white rounded-2xl border border-clay-border px-3 py-2.5 shadow-soft">
            <p className="text-[12px] font-medium text-ink">
              {t(bridgeKind === 'ooc' ? 'rpBridgeOocTitle' : 'rpBridgeStuckTitle')}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-gray-600">
              {t(bridgeKind === 'ooc' ? 'rpBridgeOocBody' : 'rpBridgeStuckBody')}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                data-testid={bridgeKind === 'ooc' ? 'rp-bridge-ooc' : 'rp-bridge-stuck'}
                onClick={goChatFromBridge}
                className="rounded-full bg-primary text-white text-[12px] px-3 py-1.5 hover:bg-primary-strong transition-colors"
              >
                {t(bridgeKind === 'ooc' ? 'rpBridgeOocBtn' : 'rpBridgeStuckBtn')}
              </button>
              <button
                type="button"
                onClick={() => dismissBridge(bridgeKind)}
                className="text-[11px] text-ink-soft hover:text-gray-700 px-2 py-1.5"
              >
                {t(bridgeKind === 'ooc' ? 'rpBridgeOocKeep' : 'rpBridgeStuckDismiss')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ⚠️ 2026-09-15 用户要求「输入框和 AI 的对话气泡可以透明，透明可调节」：
          两者都改用 `card-white`（= rgba(255,255,255, var(--card-bg-alpha, .8))），
          跟随「界面外观 → 卡片不透明度」滑块统一调节（0% 全透 → 100% 全实）。
          AI 气泡同上；**用户自己的绿气泡保持实色**（白字要靠它保证对比度，不做透明）。
          注：输入栏整条也一起透，这样场景图能从输入区透出来（沉浸感），不是只透里面的小输入框。 */}
      <div className="relative z-20 flex-shrink-0 border-t border-gray-100 chrome-white-top backdrop-blur-md px-3 pt-2 pb-[max(0.6rem,env(safe-area-inset-bottom))]">
        {/* 额度行 + 跨模式桥的「用户主动入口」（B 方案 A 项）。
            这一条**任何时刻都在**：不弹窗、不占额外高度、不消耗额度、不点就等于不存在；
            与时间驱动的三条桥不同，它不需要预算，72h 冷却只约束「系统主动提示」，不约束用户自己走进来的门。 */}
        <div className="mb-1.5 flex items-center justify-between gap-2">
          {chatQuota ? (
            <p className="text-[11px] text-gray-700 leading-relaxed">
              {t('rpQuotaSummary', {
                remain: quotaIsUnlimited(chatQuota) ? t('memUnlimited') : chatQuotaRemain(chatQuota),
                turn: 1,
                suggest: 1,
              })}
            </p>
          ) : <span />}
          {onGoChat && bridgeEnabled() && (
            <button
              type="button"
              data-testid="rp-bridge-pull"
              onClick={goChatFromPull}
              title={t('rpBridgePullHint')}
              className="flex-shrink-0 whitespace-nowrap text-[11px] text-primary-text underline decoration-dotted underline-offset-2 hover:text-primary transition-colors min-h-[28px]"
            >
              {t('rpBridgePullBtn')}
            </button>
          )}
        </div>
        {/* AI 辅助聊天：生成玩家候选下一句（每次生成消耗 1 条聊天额度） */}
        <div className="mb-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] text-gray-700 font-medium flex items-center gap-1"><Sparkles className="w-3.5 h-3.5 text-primary-text" />{t('rpSuggestTitle')}</span>
            <div className="flex items-center gap-1">
              <button
                onClick={generateSuggestions}
                disabled={suggestLoading || sending || regenerating || continuing || editTarget != null || !canUseSuggest(chatQuota)}
                title={(suggestions.length > 0 || suggestLoading) ? t('rpSuggestRegenerateHint') : t('rpSuggestHint')}
                className="inline-flex items-center gap-1 text-[11px] text-primary-text hover:text-primary-text/80 disabled:opacity-40 transition-colors"
              >
                <Sparkles className="w-3.5 h-3.5" />
                {(suggestions.length > 0 || suggestLoading) ? t('rpSuggestRegenerate') : t('rpSuggestButton')}
              </button>
              {(suggestions.length > 0 || suggestLoading) && (
                <button onClick={() => { setSuggestions([]); setSuggestError(''); bridgeStuckRef.current = true; }} aria-label={t('rpSuggestClose')} title={t('rpSuggestClose')} className="text-ink-soft hover:text-gray-700 p-0.5">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
          {suggestLoading ? (
            <div className="text-xs text-ink-soft flex items-center gap-1.5">
              <span className="w-3.5 h-3.5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              {t('rpSuggestLoading')}
            </div>
          ) : suggestions.length > 0 ? (
            <>
              {suggestDuplicate && (
                <p data-testid="rp-suggest-duplicate" className="mb-1.5 rounded-lg border border-amber-200 bg-amber-50/80 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-amber-900">
                  {t('rpSuggestDuplicate')}
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-[40vh] overflow-y-auto">
                {suggestions.map((sg, i) => (
                  <button
                    key={i}
                    onClick={() => sendSuggestion(sg)}
                    disabled={sending || regenerating || continuing}
                    className="text-left text-[13px] leading-relaxed rounded-xl border border-clay-border bg-white px-2.5 py-2 hover:border-primary hover:bg-primary-soft transition-colors disabled:opacity-50 whitespace-pre-wrap"
                  >
                    {sg}
                  </button>
                ))}
              </div>
            </>
          ) : (
            suggestError ? <p className="text-[11px] text-ink-soft leading-relaxed">{suggestError}</p> : null
          )}
        </div>
        {/* 判重退费提示（2026-10-01）：这一条与上一段重复 → 服务端已回滚额度、本次不扣。
            ⚠️ 纯 UI 提示，绝不写进 messages（红线 6）。 */}
        {repeatFreeNotice && (
          <div data-testid="rp-repeat-free-banner" className="mb-2 flex items-start gap-2 rounded-xl border border-primary/30 bg-primary-soft/70 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-gray-700">
            <Sparkles className="w-3.5 h-3.5 shrink-0 mt-[2px] text-primary-text" />
            <span className="flex-1">{t('rpRepeatFreeBanner')}</span>
            <button
              type="button"
              data-testid="rp-repeat-free-dismiss"
              onClick={() => setRepeatFreeNotice(false)}
              className="shrink-0 rounded-full border border-primary/30 bg-white/90 px-2 py-0.5 text-[11px] leading-none font-medium text-primary-text shadow-sm transition-colors hover:bg-primary-soft"
            >
              {t('profileCancel')}
            </button>
          </div>
        )}
        {/* 编辑重发提示条（2A：只有最后一条用户消息能改）。说清两件事：
            ① 重发会从这句重新接下去（否则用户会以为只是改个错别字、剧情不受影响）；
            ② 原来那一版不会丢，留成可切回的分支（1B 的承诺，要写出来用户才敢用）。 */}
        {editTarget != null && (
          <div data-testid="rp-edit-banner" className="mb-2 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/85 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-amber-900">
            <Pencil className="w-3.5 h-3.5 shrink-0 mt-[2px]" />
            <span className="flex-1">{t('rpEditBanner')}</span>
            <button
              type="button"
              data-testid="rp-edit-cancel"
              onClick={cancelEdit}
              className="shrink-0 rounded-full border border-amber-300 bg-white/90 px-2 py-0.5 text-[11px] leading-none font-medium text-amber-900 shadow-sm transition-colors hover:bg-amber-100"
            >
              {t('rpEditCancel')}
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            aria-label={t('composerLabel')}
            ref={rpInputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submitComposer(); } }}
            placeholder={editTarget != null ? t('rpEdit') : t('roleplayInputPh')}
            rows={1}
            enterKeyHint="send"
            className="flex-1 resize-none border border-clay-border rounded-xl px-3 py-2 text-[16px] leading-snug min-h-[44px] max-h-40 bg-transparent placeholder:text-gray-700 focus:ring-2 focus:ring-primary focus:border-transparent"
          />
          <button
            onClick={submitComposer}
            onMouseDown={(e) => e.preventDefault()} // 防移动端第一次点击被“收键盘”吞掉
            disabled={sending || regenerating || continuing || !input.trim()}
            aria-label={editTarget != null ? t('rpEdit') : undefined}
            className="w-11 h-11 rounded-full bg-primary-strong text-white flex items-center justify-center flex-shrink-0 disabled:opacity-40 hover:bg-primary transition-all"
          >
            {(sending || regenerating || continuing) ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Send className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* 我的偏好/独特需求
      {/* 18+ 年龄闸门与瞬时提示已上移到组件级的 adultOverlays（三种 stage 共用）：
          引导卡从「聊一聊」过来时用户在**剧本列表**层、就地开启又发生在**剧本详情**的温馨提示里，
          只挂在对话页那一支的话这两层根本弹不出来（实测：状态置 true、闸门不出现）。 */}
      {prefOpen && s && (
        <div
          className="fixed left-0 right-0 z-50 bg-black/50 flex items-end justify-center sm:items-center sm:p-4"
          style={{ top: vvOffsetTop || 0, bottom: liftBottom || 0 }}
          onClick={() => setPrefOpen(false)}
        >
          <div
            className="bg-white w-full sm:max-w-md max-h-full rounded-t-3xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden"
            style={{
              transform: prefSheetDy ? 'translateY(' + prefSheetDy + 'px)' : undefined,
              transition: prefSheetDy ? 'none' : 'transform 200ms ease',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 头部固定：把手（下滑关闭）+ 标题 + 关闭键，不参与滚动，任何屏高都点得到。
                ⚠️ 2026-09-17：这里**不再**放「偏好说明」，那段话讲的是下面的文本框，
                挂在这里离文本框 403px（真机实测），中间还隔着 4 组开关；已下移到文本框正上方（见内容区）。 */}
            <div
              className="shrink-0 px-5 pt-3 pb-1.5 touch-none"
              onTouchStart={onPrefSheetTouchStart}
              onTouchMove={onPrefSheetTouchMove}
              onTouchEnd={onPrefSheetTouchEnd}
              onTouchCancel={onPrefSheetTouchEnd}
            >
              <div className="sm:hidden mx-auto mb-1.5 h-1.5 w-10 rounded-full bg-gray-200" aria-hidden="true" />
              <div className="flex items-center justify-between gap-2">
                <p className="text-base font-bold text-gray-800 flex items-center gap-1.5 min-w-0"><SlidersHorizontal className="w-4 h-4 text-primary shrink-0" />{t('rpPreference')}</p>
                <button
                  type="button"
                  onClick={() => setPrefOpen(false)}
                  aria-label={t('rpPrefClose')}
                  title={t('rpPrefClose')}
                  className="shrink-0 -mr-1 p-1.5 rounded-full text-ink-soft hover:text-gray-600 hover:bg-gray-100 active:bg-gray-100 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            {/* 内容区：整块窗口唯一可滚动的地方（min-h-0 才能让 flex 子项收缩出滚动条）。
                2026-09-17 起明确分两节：上=即时生效的开关，下=需要保存的偏好文本
                标题「我的偏好」只覆盖后者，所以两节各自带小节标题，避免「不点保存就不算数」的误会。 */}
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 pt-1 pb-3 space-y-3">
              <div className="flex items-baseline justify-between gap-2 px-1">
                <p className="text-[11px] font-bold text-ink-soft">{t('rpSettingsSection')}</p>
                <p className="text-[11px] text-gray-400">{t('rpSettingsInstant')}</p>
              </div>
              <div className="flex items-center justify-between rounded-xl bg-clay-bg border border-clay-border px-3 py-2.5">
                <div className="flex-1 mr-2">
                  <p className="text-[12px] font-semibold text-gray-700">{t('rpInnerToggle')}</p>
                  <p className="text-[11px] text-ink-soft leading-snug mt-0.5">{t('rpInnerToggleHint')}</p>
                </div>
                <button
                  type="button"
                  onClick={() => changeInnerOn(!innerOn)}
                  className={'relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ' + (innerOn ? 'bg-primary' : 'bg-gray-300')}
                  aria-checked={innerOn}
                  role="switch"
                  aria-label={t('rpInnerToggle')}
                >
                  <span className={'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-[left] ' + (innerOn ? 'left-[22px]' : 'left-0.5')} />
                </button>
              </div>
              {/* 深度思考强度：剧情内快速切换，改完对下一回合立即生效（max 仅 Pro，非 Pro 自动降级 high） */}
              <div className="rounded-xl bg-clay-bg border border-clay-border px-3 py-2.5">
                <p className="text-[12px] font-semibold text-gray-700 mb-1.5">{t('profileDeepThink')}</p>
                <div className="flex rounded-full bg-white/70 border border-clay-border p-1">
                  {(['off', 'high', 'max'] as const).map((v) => {
                    const locked = v === 'max' && !rpIsPro;
                    return (
                      <button
                        key={v}
                        type="button"
                        onClick={() => changeThinkingLevel(v)}
                        aria-pressed={thinkingLevel === v}
                        aria-disabled={locked}
                        className={'relative flex-1 rounded-full py-1.5 text-[12px] font-medium transition-all ' + (locked
                          ? 'text-ink-soft cursor-not-allowed'
                          : (thinkingLevel === v ? 'bg-primary-strong text-white shadow-sm' : 'text-gray-600 hover:text-gray-800'))}
                      >
                        {t(v === 'off' ? 'thinkOff' : v === 'high' ? 'thinkHigh' : 'thinkMax')}
                        {v === 'max' && <span className={'ml-1 text-[9px] font-bold align-middle ' + (locked ? 'text-ink-soft' : 'text-white/80')}>Pro</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
              {/* 关键时刻自动画面（Pro）：剧情走到 高压/亲密/承诺/和好/离别 时自动补一张专属画面 */}
              <div className="rounded-xl bg-clay-bg border border-clay-border px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[12px] font-semibold text-gray-700">
                      {t('rpAutoArt')}
                      <span className={'ml-1 text-[9px] font-bold align-middle ' + (rpIsPro ? 'text-primary-text' : 'text-ink-soft')}>Pro</span>
                    </p>
                    <p className="mt-0.5 text-[11px] leading-snug text-ink-soft">{t('rpAutoArtHint')}</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={autoArtOn && rpIsPro}
                    aria-label={t('rpAutoArt')}
                    aria-disabled={!rpIsPro}
                    onClick={() => changeAutoArt(!autoArtOn)}
                    className={'relative h-6 w-11 shrink-0 rounded-full transition-colors ' + (autoArtOn && rpIsPro ? 'bg-primary-strong' : (rpIsPro ? 'bg-gray-300' : 'bg-gray-200 opacity-60'))}
                  >
                    <span className={'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-[left] ' + (autoArtOn && rpIsPro ? 'left-[22px]' : 'left-0.5')} />
                  </button>
                </div>
              </div>
              {/* 无限制模式（默认关）：改用去限制模型 + 注入放开尺度的提示词。不可用时置灰并说明原因 */}
              <div className={'rounded-xl border px-3 py-2.5 ' + (unlimitedOn ? 'bg-rose-50 border-rose-200' : 'bg-clay-bg border-clay-border')}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className={'text-[12px] font-semibold ' + (unlimitedOn ? 'text-rose-700' : 'text-gray-700')}>{t('rpUnlimited')}</p>
                    <p className={'mt-0.5 text-[11px] leading-snug ' + (unlimitedOn ? 'text-rose-700/75' : 'text-ink-soft')}>{t('rpUnlimitedHint')}</p>
                    {/* 这个「开」是剧本自带的默认、不是用户此刻拨的 → 说清它从哪来，否则像是自己开的 */}
                    {unlimitedOn && isAdultDefaultScenario(selected) && (
                      <p className="mt-1 text-[11px] leading-snug text-rose-700/75">{t('rpUnlimitedFromScript')}</p>
                    )}
                    {unlimitedReady === false && (
                      <p className="mt-1 text-[11px] leading-snug text-amber-700">{t('rpUnlimitedUnavailable')}</p>
                    )}
                    {unlimitedReady !== false && adultConfirmed === false && (
                      <p className="mt-1 text-[11px] leading-snug text-amber-700">{t('rpUnlimitedNeedAge')}</p>
                    )}
                    {!!unlimitedNotice && (
                      <p className="mt-1 text-[11px] leading-snug text-amber-700">{unlimitedNotice}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={unlimitedOn}
                    aria-label={t('rpUnlimited')}
                    aria-disabled={unlimitedReady === false}
                    onClick={() => changeUnlimitedOn(!unlimitedOn)}
                    className={'relative h-6 w-11 shrink-0 rounded-full transition-colors ' + (unlimitedReady === false ? 'bg-gray-200 opacity-60 cursor-not-allowed' : (unlimitedOn ? 'bg-rose-500' : 'bg-gray-300'))}
                  >
                    <span className={'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-[left] ' + (unlimitedOn ? 'left-[22px]' : 'left-0.5')} />
                  </button>
                </div>
              </div>
              {/* 叙事模式（2026-09-25 C 方案）：两种模式的**对比**就放在这里
                  以前只有一个切换条 + 一条 3.5s 浮层提示，用户没法在"设定"的地方看清差别；
                  这里把篇幅/语体/人称/收尾逐条列出来，并直接可切（与顶部切换条同一份状态）。 */}
              <div className="rounded-xl border border-clay-border bg-clay-bg px-3 py-2.5" data-testid="rp-style-card">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[12px] font-semibold text-gray-700">{t('rpStyleSection')}</p>
                    <p className="mt-0.5 text-[11px] leading-snug text-ink-soft">{t('rpStyleSectionHint')}</p>
                  </div>
                </div>
                <div className="mt-2 space-y-1.5">
                  {([['classic', 'rpStyleClassic', 'rpStyleClassicDetail'], ['immersive', 'rpStyleImmersive', 'rpStyleImmersiveDetail']] as const).map(([val, nameKey, detailKey]) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => changeNarrativeStyle(val)}
                      aria-pressed={narrativeStyle === val}
                      data-testid={'rp-style-' + val}
                      className={'w-full text-left rounded-lg border px-2.5 py-2 transition-colors ' + (narrativeStyle === val ? 'border-primary/40 bg-primary-soft/60' : 'border-clay-border bg-white hover:bg-gray-50')}
                    >
                      <span className={'text-[12px] font-semibold ' + (narrativeStyle === val ? 'text-primary-text' : 'text-gray-700')}>
                        {t(nameKey)}{narrativeStyle === val ? ' ✓' : ''}
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-snug text-ink-soft">{t(detailKey)}</span>
                    </button>
                  ))}
                </div>
              </div>
              {/* 小节 2：这段剧情的偏好。说明必须**紧贴**它要说明的文本框
                  2026-09-17 之前它挂在抽屉顶部，真机实测离文本框 403px（用户反馈「距离过远」）。 */}
              <div className="space-y-1.5 px-1 pt-0.5">
                <p className="text-[11px] font-bold text-ink-soft">{t('rpPrefSection')}</p>
                <p className="text-[12px] text-ink-soft">{t('rpPreferenceHint')}</p>
              </div>
              <div>
                <textarea
                  aria-label={t('composerLabel')}
                  value={prefDraft}
                  onChange={(e) => setPrefDraft(e.target.value)}
                  placeholder={t('rpPreferencePh')}
                  rows={5}
                  maxLength={2000}
                  className="w-full border border-clay-border rounded-xl px-3 py-2.5 text-sm bg-white focus:ring-2 focus:ring-primary focus:border-transparent"
                />
                {!userPreference && <p className="text-[11px] text-ink-soft mt-1.5">{t('rpPreferenceEmpty')}</p>}
              </div>
            </div>
            {/* 底部操作固定：不参与滚动，键盘弹起也在可视区内；底部预留 iOS 安全区 */}
            <div
              className="shrink-0 border-t border-clay-border px-5 pt-3 space-y-2"
              style={{ paddingBottom: 'calc(0.875rem + env(safe-area-inset-bottom))' }}
            >
              <button onClick={savePref} className="w-full bg-primary-strong text-white font-semibold rounded-full py-2.5 hover:bg-primary transition-all">{t('rpPreferenceSave')}</button>
              <button onClick={() => setPrefOpen(false)} className="w-full bg-gray-100 text-gray-600 font-medium rounded-full py-2.5 hover:bg-gray-200 transition-all">{t('profileCancel')}</button>
            </div>
          </div>
        </div>
      )}

      {/* 重新生成（**任意一条** AI 回复）：可选填反馈，会沉淀为该剧本的用户偏好 */}
      {regenerateOpen && (
        <Modal onClose={() => setRegenerateOpen(false)} showClose={false} width="max-w-md" padding="p-5" maxHeight="max-h-[calc(100dvh-2rem)]" panelClassName="overscroll-contain">
            <div className="flex items-center justify-between mb-2">
              <p className="text-base font-bold text-gray-800 flex items-center gap-1.5"><RotateCcw className="w-4 h-4 text-primary" />{t('rpRegenerateTitle')}</p>
              <button onClick={() => setRegenerateOpen(false)} className="text-ink-soft hover:text-gray-600 p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-[12px] text-ink-soft mb-3">{t('rpRegenerateHint')}</p>
            {/* 判重退费（2026-10-01）：先把承诺说清，用户才敢反复重抽 */}
            <p data-testid="rp-regenerate-free-hint" className="mb-3 flex items-start gap-1.5 rounded-xl border border-primary/25 bg-primary-soft/60 px-3 py-2 text-[11.5px] leading-relaxed text-gray-700">
              <Sparkles className="w-3.5 h-3.5 shrink-0 mt-[1px] text-primary-text" />
              <span>{t('rpRegenerateFreeHint')}</span>
            </p>
            {/* 重生成中间某条 = 从这条起重写：后面的剧情会被清掉，**必须提前说清条数**（否则是静默数据丢失） */}
            {regenerateTarget != null && regenerateTarget < messages.length - 1 && (
              <p data-testid="rp-regenerate-truncate" className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] leading-relaxed text-amber-900">
                {t('rpRegenerateTruncate', { n: messages.length - 1 - regenerateTarget })}
              </p>
            )}
            <textarea
              aria-label={t('composerLabel')}
              value={regenerateFeedback}
              onChange={(e) => setRegenerateFeedback(e.target.value)}
              placeholder={t('rpRegeneratePh')}
              rows={4}
              maxLength={1000}
              className="w-full border border-clay-border rounded-xl px-3 py-2.5 text-sm bg-white focus:ring-2 focus:ring-primary focus:border-transparent"
            />
            <div className="mt-4 space-y-2">
              <button onClick={handleRegenerate} disabled={regenerating} data-testid="rp-regenerate-confirm" className="w-full bg-primary-strong text-white font-semibold rounded-full py-2.5 hover:bg-primary transition-all disabled:opacity-40">{t('rpRegenerate')}</button>
              <button onClick={() => setRegenerateOpen(false)} className="w-full bg-gray-100 text-gray-600 font-medium rounded-full py-2.5 hover:bg-gray-200 transition-all">{t('profileCancel')}</button>
            </div>
        </Modal>
      )}

      {/* 重新开始确认（防误触） */}
      {confirmRestart && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setConfirmRestart(false)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-xs w-full p-5" onClick={(e) => e.stopPropagation()}>
            <p className="text-base font-bold text-gray-800 text-center">{t('rpConfirmRestartTitle')}</p>
            <p className="text-sm text-ink-soft text-center mt-1">{t('rpConfirmRestartBody')}</p>
            <div className="mt-4 space-y-2">
              <button onClick={confirmRestartAction} className="w-full bg-red-500 text-white font-semibold rounded-full py-2.5 hover:bg-red-600 transition-all">{t('roleplayRestart')}</button>
              <button onClick={() => setConfirmRestart(false)} className="w-full bg-gray-100 text-gray-600 font-medium rounded-full py-2.5 hover:bg-gray-200 transition-all">{t('profileCancel')}</button>
            </div>
          </div>
        </div>
      )}

      {/* 剧情背景速览：聊天中随时查看人设/世界观，不打断对话 */}
      {storyInfoOpen && s && (
        <Modal onClose={() => setStoryInfoOpen(false)} showClose={false} width="max-w-md" padding="p-5" maxHeight="max-h-[85vh]">
            <div className="flex items-center justify-between mb-4">
              <p className="text-base font-bold text-gray-800 flex items-center gap-1.5"><BookOpen className="w-4 h-4 text-primary" />{t('rpStoryInfo')}</p>
              <button onClick={() => setStoryInfoOpen(false)} className="text-ink-soft hover:text-gray-600 p-1">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 标题 + 标签 + tagline */}
            <div className="text-center mb-4">
              <div className="mb-1 flex justify-center"><RPCover s={s} imgClass="w-20 h-20 rounded-2xl shadow" fallbackClass="text-3xl" /></div>
              <h2 className="text-lg font-bold text-gray-800">{s.title}</h2>
              {s.tags && s.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 justify-center mt-1.5">
                  {s.tags.map(tag => (
                    <span key={tag} className="px-2.5 py-0.5 rounded-full bg-primary-lighter text-primary-text text-[11px] font-medium border border-primary/15">{tag}</span>
                  ))}
                </div>
              )}
              {s.tagline && <p className="text-[13px] text-ink-soft mt-1.5">{s.tagline}</p>}
            </div>

            {/* AI 角色 */}
            <div className="bg-clay-bg border border-clay-border rounded-xl p-3.5 mb-3">
              <p className="text-xs font-bold text-primary-text mb-1.5 flex items-center gap-1.5">
                <User className="w-3.5 h-3.5" />{t('roleplayAiRole')} · {s.ai.name}
              </p>
              <p className="text-[11px] text-ink-soft leading-relaxed">{s.ai.gender} · {s.ai.age} · {s.ai.height}</p>
              <p className="text-[13px] text-gray-700 leading-relaxed mt-1"><b className="text-gray-800">{t('rpLooks')}: </b>{s.ai.looks}</p>
              <p className="text-[13px] text-gray-700 leading-relaxed mt-1"><b className="text-gray-800">{t('rpPersonality')}: </b>{s.ai.personality}</p>
              {s.ai.speech && <p className="text-[13px] text-gray-700 leading-relaxed mt-1"><b className="text-gray-800">{t('rpSpeech')}: </b>{s.ai.speech}</p>}
            </div>

            {/* 用户角色 */}
            <div className="bg-clay-bg border border-clay-border rounded-xl p-3.5 mb-3">
              <p className="text-xs font-bold text-gray-700 mb-1.5 flex items-center gap-1.5">
                <Heart className="w-3.5 h-3.5 text-amber-700" />{t('roleplayUserRole')} · {s.user.name}
              </p>
              <p className="text-[11px] text-ink-soft leading-relaxed">{s.user.gender} · {s.user.age} · {s.user.height}</p>
              {s.user.looks && <p className="text-[13px] text-gray-700 leading-relaxed mt-1"><b className="text-gray-800">{t('rpLooks')}: </b>{s.user.looks}</p>}
              {s.user.personality && <p className="text-[13px] text-gray-700 leading-relaxed mt-1"><b className="text-gray-800">{t('rpPersonality')}: </b>{s.user.personality}</p>}
            </div>

            {/* 背景故事 */}
            {s.background && (
              <div className="bg-clay-bg border border-clay-border rounded-xl p-3.5 mb-3">
                <p className="text-xs font-bold text-gray-800 mb-1.5 flex items-center gap-1.5">
                  <ScrollText className="w-3.5 h-3.5 text-primary" />{t('roleplayBackground')}
                </p>
                <p className="text-[13px] text-gray-700 leading-relaxed whitespace-pre-line">{s.background}</p>
              </div>
            )}

            {/* 开场剧情 */}
            {s.openingScene && (
              <div className="bg-clay-bg border border-clay-border rounded-xl p-3.5 mb-3">
                <p className="text-xs font-bold text-gray-800 mb-1.5 flex items-center gap-1.5">
                  <BookOpen className="w-3.5 h-3.5 text-primary" />{t('roleplayOpening')}
                </p>
                <p className="text-[13px] text-gray-700 leading-relaxed whitespace-pre-line">{s.openingScene}</p>
              </div>
            )}

            <SourceAttribution src={s.source} sourceUrl={s.sourceUrl} className="mb-3" />
            <button onClick={() => setStoryInfoOpen(false)} className="w-full bg-primary-strong text-white font-semibold rounded-full py-2.5 hover:bg-primary transition-all">
              {t('roleplayTipConfirm')}
            </button>
        </Modal>
      )}

      {/* 配乐面板（换曲/音量/关闭） */}
      <StoryBgmPanel open={bgmOpen} onClose={() => setBgmOpen(false)} scenario={s} bgm={bgm} ambience={ambience} />
    </div>
      </>
  );
}
