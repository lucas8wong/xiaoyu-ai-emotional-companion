/**
 * 聊一聊（对话陪伴模式）
 * 移动端优先：全屏对话、底部输入栏、气泡消息、可一键转入「理一理」
 */

import { useEffect, useRef, useState, useMemo, useCallback, lazy, Suspense } from 'react';
import { ArrowLeft, ArrowDown, ArrowRight, Send, Loader2, Wand2, SlidersHorizontal, Share2, Plus, Trash2, X, Pencil, Check, ImagePlus, MapPin, Pin, CornerUpLeft, Copy, Mic, MicOff, ChevronDown, Eye, Camera, Smile, Volume2, UserPlus, BookOpen, RefreshCw, MessageSquare } from 'lucide-react';
import { BTN } from './ui/controls';
import { SkinFeedbackIcon } from './SkinIcon';
import { useAppStore } from '../store/useAppStore';
import { chatSendStream, getQuota, getPayConfig, getChatSessions, getChatSession, deleteChatSession, renameChatSession, pinChatSession, getInviteLink, trackInviteCopy, isLoggedIn, getChatCharacters, createChatCharacter, updateChatCharacter, deleteChatCharacter, getChatCharacterGrowth, deleteMemory, asr, ttsToAudio, savePreferences, quotaChatRemain, quotaIsUnlimited, reportAiFailure, getCharacterStory, syncStoryCharacter, getChatInbox, markChatRead, type ChatMessage, type ChatSource, type ChatSessionMeta, type QuotaInfo, type ChatCharacterMeta, type ChatCharacterGrowth, type ChatRedirectHint, type StoryView, type ChatInboxRow, type ChatRelationKind } from '../services/api';
import { guestQuotaLineText } from '../lib/quotaTiers';
import { VoiceSettingsModal, VoiceConfigPicker, DEFAULT_VOICE_CONFIG, loadVoiceConfig, saveVoiceConfig, composeVoice, effectiveDialect, loadVoiceEnabled, saveVoiceEnabled, type VoiceConfig } from './VoiceSettingsModal';
import { getCachedPreferences, setCachedPreferences, loadPreferences } from '../lib/prefsCache';
import { shouldAutoRetry, failCodeOf, AUTO_RETRY_DELAY_MS, AUTO_RETRY_MAX } from '../lib/autoRetry';
import SendFailedNotice from './SendFailedNotice';
import PreferencePanel from './PreferencePanel';
import EntryRegionNudge from './EntryRegionNudge';
import StoryShareModal, { type StoryBubble } from './StoryShareModal';
import TypingDots from './TypingDots';
import AiFeedbackMark from './AiFeedbackMark';
import LinkCard from './LinkCard';
import ChatSources from './ChatSources';
import { mergeSources } from '../lib/chatServerMessages';
import { findMessageLinks } from '../lib/messageLinks';
import PageTourBanner from './PageTourBanner';
import FeatureCoachmarks, { type CoachStep } from './FeatureCoachmarks';
import EmotionInput from './EmotionInput';
const EmojiPicker = lazy(() => import('./EmojiPicker'));
const AnalysisResult = lazy(() => import('./AnalysisResult'));
const QuestionInteraction = lazy(() => import('./QuestionInteraction'));
const DetailedAnalysis = lazy(() => import('./DetailedAnalysis'));
const HealingStory = lazy(() => import('./HealingStory'));
import { useSkin } from './SkinProvider';
import VoiceMessage from './VoiceMessage';
import { isMediaRecorderSupported, resolveSpeechLang, encodeAudioToPcm16Base64, pickMediaMime, createSilenceDetector, blobToDataUrl, type SpeechLangKey, type SilenceDetector } from '../services/speech';
import { t, getLang } from '../i18n';
import { companionShortName, displayNameForCharacter } from '../lib/companionName';
import { mapServerMessages } from '../lib/chatServerMessages';
import { findQuotedMessage } from '../lib/quoteTarget';
import { recordBridgeEvent } from '../lib/rpBridge';
import { copyText } from '../lib/clipboard';
import { memoryWhenText, growthWhenText } from '../lib/memoryTime';
import { pickActiveCharacter } from '../lib/pickActiveCharacter';
import { getLastChatChar, setLastChatChar } from '../lib/lastChatChar';
import { pushDeepBackHandler } from '../lib/deepBack';
import { useVisualViewport } from '../hooks/useVisualViewport';
import { useIosKeyboardLock } from '../hooks/useIosKeyboardLock';
import { useVirtualKeyboardInset } from '../hooks/useVirtualKeyboardInset';
import Modal from './ui/Modal';

/**
 * 「指令分流」卡片文案表（2026-09-25 从 JSX 的三元式里提出来）
 * 为什么提到模块级：成人向卡片加进来后，原来的「是 roleplay 否则就是 chatCharacter」二元式
 * 会变成三元套三元（可读性差、且新增一类极易漏改）；表驱动后，新增一类 hint 只加一行。
 * 文案本体在 src/i18n/index.ts（三语）。
 */
const REDIRECT_CARD: Record<ChatRedirectHint, { title: string; bullets: string[] }> = {
  roleplay: {
    title: 'chatGoRoleplayTitle',
    bullets: ['chatGoRoleplayB1', 'chatGoRoleplayB2', 'chatGoRoleplayB3', 'chatGoRoleplayB4'],
  },
  chatCharacter: {
    title: 'chatGoCharacterTitle',
    bullets: ['chatGoCharacterB1', 'chatGoCharacterB2', 'chatGoCharacterB3', 'chatGoCharacterB4'],
  },
  adultRoleplay: {
    title: 'chatGoAdultTitle',
    bullets: ['chatGoAdultB1', 'chatGoAdultB2', 'chatGoAdultB3', 'chatGoAdultB4'],
  },
};

interface ChatPageProps {
  children?: React.ReactNode; // 顶部通告/续费横幅
  onBack: () => void;
  onGoStructure: () => void;
  onNeedPay: () => void;
  onOpenMembership: () => void;
  /** 游客一键直达注册（注册获得额度） */
  onNeedLogin?: () => void;
  /** 去「剧情演绎」功能区（stage='custom' 时直接打开「AI 创剧本」表单），角色扮演指令分流卡片用
   *  opts.pref：进去后自动展开「我的偏好」抽屉（邮件深链用，只指路、不改设置）
   *  opts.adult：成人向引导卡专用，把「打开无限制模式」这份意愿带进剧情页（已过 18+ 直接开；
   *   没过就先弹年龄闸门、确认后自动开。见 RoleplayPage 的 initialAdultIntent） */
  onGoRoleplay?: (stage?: 'list' | 'custom', scenarioId?: string, opts?: { pref?: boolean; adult?: boolean }) => void;
}

// 【时间戳与日期分界线】
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function fmtDate(d: Date): string {
  const lang = getLang();
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  if (lang === 'en') {
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return MON[d.getMonth()] + ' ' + day + ', ' + y;
  }
  return y + '年' + m + '月' + day + '日';
}
function fmtTime(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return h + ':' + mi;
}
// 相对时间：对话列表用（刚刚 / n 分钟前 / n 小时前 / n 天前 / 日期）
function fmtRel(ts: string): string {
  const lang = getLang();
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return lang === 'en' ? 'now' : '刚刚';
  if (min < 60) return lang === 'en' ? min + 'm ago' : min + '分钟前';
  const hr = Math.floor(min / 60);
  if (hr < 24) return lang === 'en' ? hr + 'h ago' : hr + '小时前';
  const day = Math.floor(hr / 24);
  if (day < 7) return lang === 'en' ? day + 'd ago' : day + '天前';
  return fmtDate(d);
}

function newMsg(role: 'user' | 'assistant', content: string, image?: string, replyTo?: ChatMessage['replyTo'], audio?: string): ChatMessage {
  return { id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, role, content, timestamp: new Date().toISOString(), ...(image ? { image } : {}), ...(audio ? { audio } : {}), ...(replyTo ? { replyTo } : {}) };
}

/** 把一条消息收成「引用卡」的正文：
 *  - 纯图片/纯语音消息 content 为空 → 用占位词，避免渲染出一张只有「小愈：」的空引用卡；
 *  - 换行/连续空白压成空格（引用卡只是一句「引子」，不重排版落结构）；
 *  - 过长按 max 截断并加省略号。
 *  ⚠️ 这里刻意**不用 `line-clamp-N` 收口**（2026-09-17 实测）：Chrome 153 下引用卡在 3 行盒高里
 *  仍会把第 4 行的**字头**画出来（clipped=33px），屏幕上就是一条半截字；改为「字符级截断 + 不裁切」，
 *  卡片高度随内容自然生长（最窄手机上也只多一两行），永远不会切字。 */
function quoteText(q: { content: string; kind?: 'image' | 'audio' }, max: number): string {
  const body = q.content.replace(/\s+/g, ' ').trim();
  if (!body) return q.kind === 'audio' ? t('chatQuoteAudio') : t('chatQuoteImage');
  return body.length > max ? `${body.slice(0, max)}…` : body;
}

/** 去除 AI 回复里可能残留的 Markdown 符号，保证气泡格式干净 */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*/g, '')          // **加粗**
    .replace(/^#{1,6}\s+/gm, '')    // # 标题
    .replace(/^[-*]\s+/gm, '');    // - 或 * 列表符（行首）
}

/**
 * 把 AI 回复里的 URL 渲染成微信/QQ 式的可点击「链接卡片」。
 * 识别规则（裸域名、邮箱排除、尾随标点剥离、中文路径）都在 lib/messageLinks
 * 纯函数、可单测；2026-10-03 把「中文路径被截断 → 点开 404」的判据钉在那里。
 * 这里只负责：命中的 URL 换成 LinkCard，周围正文原样留下。
 */
function renderMessageText(text: string): React.ReactNode[] {
  const cleaned = stripMarkdown(text);
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const link of findMessageLinks(cleaned)) {
    if (link.index > last) out.push(cleaned.slice(last, link.index));
    if (link.href) {
      out.push(<LinkCard key={key++} url={link.href} />);
      if (link.tail) out.push(link.tail);
    } else {
      out.push(link.raw);
    }
    last = link.index + link.raw.length;
  }
  if (last < cleaned.length) out.push(cleaned.slice(last));
  return out;
}

/** 观景窗：一块只读的成长档案分区（可折叠，默认收起）
 *  meta = 这条记忆/成长条目的时间说明（「记住于 2026-09-14（3 天前）」/「时间不详…」）
 *  2026-09-17 起带时间轴，用户能看到 TA 记得的事是哪时候的，不再有"把很久以前当今天"的错位。 */
function GrowthSection({ title, entries, open, onToggle, onDelete }: { title: string; entries: { text: string; meta?: string }[]; open: boolean; onToggle: () => void; onDelete?: (index: number) => void }) {
  if (!entries || entries.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-lg border border-clay-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-clay-bg text-left hover:bg-clay-bg/70 transition-colors"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-[12px] font-semibold text-ink-soft">{title}</span>
          <span className="text-[10px] leading-none text-ink-soft bg-white/70 border border-clay-border rounded-full px-1.5 py-0.5 flex-shrink-0">{entries.length}</span>
        </span>
        <ChevronDown className={`w-4 h-4 text-ink-soft flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-3 py-2 space-y-1.5 bg-white">
          {entries.map((e, i) => (
            <div key={i} className="bg-clay-bg border border-clay-border rounded-lg px-3 py-2 text-sm text-gray-700 leading-relaxed whitespace-pre-line">
              {onDelete ? (
                <div className="flex items-start justify-between gap-2">
                  <span className="break-all">{e.text}</span>
                  <button
                    type="button"
                    onClick={() => onDelete(i)}
                    aria-label={t('memoryDelete')}
                    title={t('memoryDelete')}
                    className="text-ink-soft hover:text-red-500 shrink-0 mt-0.5"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : e.text}
              {e.meta && <div className="mt-1 text-[10px] leading-none text-ink-soft">{e.meta}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 拟人化分段发送：SSE 收 full，按「段落」拆成多条消息连续发（像真人连发几条） */
interface StreamState {
  full: string;             // SSE 已累积的完整文本
  sentLen: number;          // 已发送（成为独立气泡）的字符数
  ended: boolean;           // SSE 是否已结束
  done: boolean;            // 分段器是否已处理完
  cancel: boolean;          // 已取消（切会话/卸载/新消息）
  firstMsgId: string | null;// 第一条 assistant 消息 id
}

// 图片压缩：≤800px、JPEG，输出 base64 data URL（GIF 保持原样以保留动画）
function fileToCompressedDataUrl(file: File, maxDim = 800, quality = 0.75): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read error'));
    reader.onload = () => {
      const raw = String(reader.result || '');
      if (file.type === 'image/gif') { resolve(raw); return; }
      const img = new Image();
      img.onerror = () => resolve(raw);
      img.onload = () => {
        try {
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) { resolve(raw); return; }
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch { resolve(raw); }
      };
      img.src = raw;
    };
    reader.readAsDataURL(file);
  });
}

// 头像上传：压缩成小方形（≤160px），用于自定义角色头像（data:image JPEG）
function fileToAvatarDataUrl(file: File): Promise<string> {
  return fileToCompressedDataUrl(file, 160, 0.72);
}

// 表情包：经本站图片代理取图，转成 base64 data URL（保留原 MIME 类型，GIF 动画不回退）
async function urlToDataUrl(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) throw new Error('fetch error');
    const blob = await r.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('read error'));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(blob);
    });
  } finally {
    clearTimeout(timer);
  }
}

// Android 的 WebView/Chrome 靠 `interactive-widget=resizes-content` 收缩布局视口，
// 用 CSS `top-0 bottom-0` 锚定的 fixed 壳会自动贴键盘上沿，**不要**再叠 JS 的 top/height（会双重补偿、把壳带跑）。
const IS_ANDROID = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');

// 移动端软键盘：用 visualViewport 拿「可视视口高度 + 键盘 inset」，容器高度直接跟随可视视口
// （见 ../hooks/useVisualViewport）。桌面/无键盘时 inset=0、height=innerHeight，行为不变。
// 移动端判断：emoji 面板在 <768px 时停靠到屏幕底部（替代虚拟键盘），宽屏保留浮层
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(max-width: 767px)').matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 767px)');
    const update = () => setIsMobile(mq.matches);
    update();
    if (mq.addEventListener) {
      mq.addEventListener('change', update);
      return () => mq.removeEventListener('change', update);
    }
    mq.addListener(update);
    return () => mq.removeListener(update);
  }, []);
  return isMobile;
}

// 朗读声音设置（VoxCPM2）：改为弹窗结构化配置（性别/声线/语速/语种），见 VoiceSettingsModal
/**
 * 会话消息的**进程内缓存**（2026-09-20 提速）：只活在当前标签页、只留最近 6 条会话。
 * 目的：来回"消息列表 ↔ 对话"时秒开；服务端刷新照旧，读到的最新内容会覆盖它。
 */
const sessionMsgCache = new Map<string, ChatMessage[]>();

/**
 * 打开一个会话的**交互式**超时。默认 90s（api.ts 的 API_TIMEOUT_MS）是给 AI 长任务留的，
 * 用在「点开一个聊天」上就意味着用户可能对着转圈等一分半，2026-09-21 真机走查实测到过。
 * 15s 足够跨境网络完成一次普通列表/消息读取；超了就走失败态 + 重试。
 */
const CHAT_OPEN_TIMEOUT_MS = 15000;

/**
 * 交互式读取会话用的请求选项：短超时 + **不自动重试**（GET 默认会重试 2 次，三次 15s 串起来
 * 又是 45s+ 的转圈）。这类请求失败后由界面直接给「重试」按钮，比自动重试更透明也更快。
 */
const CHAT_OPEN_FETCH_OPTS = { timeoutMs: CHAT_OPEN_TIMEOUT_MS, retries: 0 };

export default function ChatPage({ children, onBack, onNeedPay, onOpenMembership, onNeedLogin, onGoRoleplay }: ChatPageProps) {
  const { meta } = useSkin(); // 当前皮肤：AI 陪伴头像随皮肤切换
  const {
    chatSessionId, setChatSessionId,
    chatMessages, setChatMessages, setChatMessageSources,
    chatSessions, setChatSessions,
    addChatMessage,
    updateChatMessage,
    setFeedbackOpen,
    currentStep,
    setSessionId, setCurrentStep, setStructureCharacterId,
    privacyBannerH,
    pendingChatSeed,
    setPendingChatSeed,
    pendingChatCharId,
    setPendingChatCharId,
  } = useAppStore();

  // 剧情 → 聊一聊 跨模式桥（B 方案）：落地时把草稿填进输入框，并提示「来自哪段剧情」。
  // 三条硬约束：① 只预填、**绝不自动发送**（草稿是用户自己的话，这也是上下文能合法过来的原因）
  //            ② 读一次即清空（切走再回来不会重复填）③ 文案不进 messages（红线 6，只做 UI 层 chip）
  const [bridgeFrom, setBridgeFrom] = useState<string | null>(null);
  const bridgeDraftRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingChatSeed) return;
    setInput(pendingChatSeed.draft);
    bridgeDraftRef.current = pendingChatSeed.draft;
    setBridgeFrom(pendingChatSeed.scenarioTitle || null);
    recordBridgeEvent('landed');
    setPendingChatSeed(null);
  }, [pendingChatSeed, setPendingChatSeed]);

  /** 移除剧情上下文：草稿没被改过就一起清掉（用户不要这段背景），改过则只撤掉标签 */
  const dropBridgeContext = () => {
    if (bridgeDraftRef.current !== null && input === bridgeDraftRef.current) setInput('');
    bridgeDraftRef.current = null;
    setBridgeFrom(null);
  };

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false);
  // 拟人化分段发送：ref 存真值；typing 控制「正在输入」气泡
  const streamRef = useRef<StreamState | null>(null);
  // 流式防串号：每次发送一个代号 + 可中断的 AbortController（切会话/新开/卸载时 abort + 增代号使旧 onDelta 失效）
  const streamAbortRef = useRef<AbortController | null>(null);
  const sendGenRef = useRef(0);
  const [typing, setTyping] = useState(false);
  const [searching, setSearching] = useState(false); // 函数调用搜索中：显示「正在搜索」
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [quotaMsg, setQuotaMsg] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [inviteBonus, setInviteBonus] = useState(50); // 邀请奖励额度：默认 50，配置接口返回后覆盖（避免写死漂移）
  const [companionStyleOpen, setCompanionStyleOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // 【聊一聊自定义角色（灵魂框架：identity/boundaries/voice/opening）】
  const [characters, setCharacters] = useState<ChatCharacterMeta[]>([]);
  const [activeCharacter, setActiveCharacter] = useState<ChatCharacterMeta | null>(() => getLastChatChar());
  /**
   * 和小愈的关系档（2026-09-21）：内置小愈不是用户记录（`userId === ''`），它的档位存在**用户级偏好**
   * 里；自定义角色的同名字段在角色记录上（每角色一档）。初值取本地缓存（秒显），服务端偏好回来后覆盖。
   */
  const [xiaoyuRelation, setXiaoyuRelation] = useState<ChatRelationKind>(getCachedPreferences()?.xiaoyuRelation ?? 'friend');
  // 角色是否已从后端加载完成（用于在「无缓存且仍在加载」时展示占位，避免先闪默认小愈）
  const [charReady, setCharReady] = useState(false);
  /**
   * 角色列表自身的加载态 / 失败态（2026-09-25。用户口径：「点进聊一聊，默认小愈加载很慢，
   * 很多时候都是看到空白页无角色」）。之前有两个问题：
   *  ① **角色行被消息列表拖住**：两个请求虽然并行发出，但 `setCharacters` 要等 Promise.all 一起回来；
   *     消息列表是按该用户全部会话聚合 + 统计未读的，会话一多就明显慢于角色接口，
   *     于是「小愈」这一行迟迟不出现，中间那段空态被用户当成「空白页没有角色」。
   *  ② **加载失败与「真的没有角色」共用同一个空态**：一次请求抖动（跨境网络很常见）就让列表永久停在
   *     「还没有对话，开始聊聊吧」，且没有任何重试入口，只能刷新页面。
   */
  const [charsLoading, setCharsLoading] = useState(true);
  const [charsFailed, setCharsFailed] = useState(false);
  /** 用户是否已自己选过角色（点过列表某行）：挂载时那次默认挑选不覆盖用户的选择 */
  const userPickedCharRef = useRef(false);
  // 是否仍在恢复「上一次会话」（进入/切换角色时先显示加载，避免先闪「新会话」再跳回上次会话）
  const [sessionLoading, setSessionLoading] = useState(true);
  /**
   * 会话恢复失败（超时/网络抖动）→ 给一条明确的失败提示 + 重试，而不是**一直转圈**
   * （2026-09-21 真机走查：服务端返回 502/520 时，页面能转「正在恢复上次对话…」一分钟以上，
   * 用户既不知道出了什么事、也点不动任何东西，只能手动刷新页面）。
   */
  const [sessionLoadFailed, setSessionLoadFailed] = useState(false);
  const [charEditorOpen, setCharEditorOpen] = useState(false);
  const [charMenuOpen, setCharMenuOpen] = useState(false);
  const charMenuRef = useRef<HTMLDivElement>(null);
  const [editingChar, setEditingChar] = useState<ChatCharacterMeta | null>(null);
  const [charForm, setCharForm] = useState({ name: '', identity: '', boundaries: '', voice: '', ttsVoice: '', opening: '' });
  const [charSaving, setCharSaving] = useState(false);
  const [charError, setCharError] = useState<string | null>(null);
  const [charAvatar, setCharAvatar] = useState('');
  const charAvatarRef = useRef<HTMLInputElement>(null);
  // 【观景窗：只读查看角色的成长档案（关系/反思/日记/自画像）】
  const [growthOpen, setGrowthOpen] = useState(false);
  const [growthView, setGrowthView] = useState<ChatCharacterGrowth | null>(null);
  const [growthCharName, setGrowthCharName] = useState('');
  const [growthCharId, setGrowthCharId] = useState('');
  // 观景窗各分区的展开状态（A1 分区折叠 / B1 默认全收起）
  const [growthOpenSec, setGrowthOpenSec] = useState<Record<string, boolean>>({});
  // 【剧情角色（origin='story'）：「TA 记得的这段剧情」回看 + 入戏/出戏双态 + 增量同步】
  const [storyOpen, setStoryOpen] = useState(false);
  const [storyView, setStoryView] = useState<StoryView | null>(null);
  const [storyLoading, setStoryLoading] = useState(false);
  const [storySyncing, setStorySyncing] = useState(false);
  const [storyModeSaving, setStoryModeSaving] = useState(false);
  // 【微信式消息列表（方案 A2）：角色列表（谁给我发了消息 / 未读几条）】
  const [inbox, setInbox] = useState<ChatInboxRow[]>([]);
  /**
   * 消息列表（微信式**第一层首页**，2026-09-20 用户口径「要做成首页」）：
   * 默认打开（进来先看到"谁给我发了消息"），点某一行才进入对话视图。
   * 与 inboxOpen 的旧语义差别：它不再是"抽屉/遮罩"，而是这个模块的家。
   */
  const [listOpen, setListOpen] = useState(true);
  // 【首次进入 · 功能引导气泡（coach-mark；所有用户首次进入显示，可逐个关闭/跳过）】
  /**
   * ⚠️ 2026-09-21 **按层拆成两套气泡**（用户口径「聊一聊的导航气泡要改进，因为点进去现在是可以聊天的人」）。
   *
   * 事实：消息列表已经是聊一聊的**第一层首页**（进来看到的是“谁给我发了消息”，点一行才进对话），
   * 而原来的气泡**全部锚在对话窗口**的顶栏 / 输入栏上，人还停在列表层时它们照样在跑：
   * 实测（改前，见 temp/verify-chat-coach/）气泡文案是「这里看所有人的消息、开新对话…」，
   * 而它指的“洞”落在**已被列表整屏盖住**的对话顶栏上（视觉上正好压在列表第 1 行），讲的是用户此刻看不到的东西。
   *
   * 现在分两层，各记各的：
   *  ① **列表层**（localStorage 键 cure_chat_list_coach_seen）：点一行进对话、在哪儿新建角色；
   *  ② **对话层**（键 cure_chat_coach_seen，沿用旧键）：TA 的多个对话 / 角色资料 / 怎么陪你 / 理一理 / 开始聊。
   * 两条规矩：**离开某一层＝那一层的气泡结束**（来回切换不该反复弹第一个气泡）；
   * 「跳过」＝真的不想看引导（两层一起收掉），而列表层走完不算跳过（对话层那套还该讲）。
   */
  const [coachListSeen, setCoachListSeen] = useState<boolean>(() => {
    try { return localStorage.getItem('cure_chat_list_coach_seen') === '1'; } catch { return false; }
  });
  const [coachConvSeen, setCoachConvSeen] = useState<boolean>(() => {
    try { return localStorage.getItem('cure_chat_coach_seen') === '1'; } catch { return false; }
  });
  const markCoachListSeen = useCallback(() => {
    setCoachListSeen(true);
    try { localStorage.setItem('cure_chat_list_coach_seen', '1'); } catch { /* 忽略 */ }
  }, []);
  const markCoachConvSeen = useCallback(() => {
    setCoachConvSeen(true);
    try { localStorage.setItem('cure_chat_coach_seen', '1'); } catch { /* 忽略 */ }
  }, []);
  const skipAllCoach = useCallback(() => { markCoachListSeen(); markCoachConvSeen(); }, [markCoachListSeen, markCoachConvSeen]);
  /** 层变了就把上一层的气泡收掉（见上面的规矩） */
  const coachLayerRef = useRef(listOpen);
  useEffect(() => {
    if (coachLayerRef.current === listOpen) return;
    if (coachLayerRef.current) markCoachListSeen(); else markCoachConvSeen();
    coachLayerRef.current = listOpen;
  }, [listOpen, markCoachListSeen, markCoachConvSeen]);
  const roleBtnRef = useRef<HTMLButtonElement>(null);
  const historyGroupRef = useRef<HTMLDivElement>(null);
  const imageBtnRef = useRef<HTMLButtonElement>(null);
  const structureBtnRef = useRef<HTMLButtonElement>(null);
  const chatSettingsGroupRef = useRef<HTMLDivElement>(null);
  // 列表层气泡的两个锚点：第一行（没有角色时退到空态文案）与底部「新建角色」
  const inboxFirstRowRef = useRef<HTMLDivElement>(null);
  const inboxNewCharRef = useRef<HTMLButtonElement>(null);
  // coach-mark 引导步骤：锚定到具体功能按钮（ref 稳定；文案跟随当前语言）
  const coachLang = getLang();
  const listCoachSteps = useMemo<CoachStep[]>(() => [
    { key: 'listRows', anchorRef: inboxFirstRowRef, text: t('coachChatListRows') },
    { key: 'listNew', anchorRef: inboxNewCharRef, text: t('coachChatListNew') },
  ], [inboxFirstRowRef, inboxNewCharRef, coachLang, t]);
  const convCoachSteps = useMemo<CoachStep[]>(() => [
    { key: 'history', anchorRef: historyGroupRef, text: t('coachChatHistory') },
    { key: 'role', anchorRef: roleBtnRef, text: t('coachChatRole') },
    { key: 'settings', anchorRef: chatSettingsGroupRef, text: t('coachChatSettings') },
    { key: 'sort', anchorRef: structureBtnRef, text: t('coachChatSort') },
    { key: 'start', anchorRef: imageBtnRef, text: t('coachChatStart') },
  ], [roleBtnRef, historyGroupRef, imageBtnRef, structureBtnRef, chatSettingsGroupRef, coachLang, t]);
  // 【聊天内「理一理」子视图（软合并 A）：从当前角色一键进入结构化深整理】
  const [structureOpen, setStructureOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  // 智能跟随：用户贴近底部时自动滚到最新；上滑阅读时暂停，避免「读上一条被拽走/晃动」
  const stickToBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true); // 是否贴近底部（决定「回到最新」按钮是否出现）
  const rafRef = useRef<number | null>(null); // 合并同一帧内的多次滚动请求（减少抖动）
  // 区分「用户真实滚动」与「程序化自动滚动」：只有用户真的在滚动时才允许改变跟随意图。
  // 否则程序化 el.scrollTo 贴底产生的 scroll 事件会把 stickToBottom 翻回 true，
  // 流式时贴底处上滑会立刻被自动滚动拽回（用户「拉不上去」）；提前上滑则因早已 false 而不再被拽。
  const userScrollingRef = useRef(false);
  const userScrollTimerRef = useRef<number | null>(null);
  const markUserScrolling = () => {
    userScrollingRef.current = true;
    if (userScrollTimerRef.current) window.clearTimeout(userScrollTimerRef.current);
    userScrollTimerRef.current = window.setTimeout(() => { userScrollingRef.current = false; }, 180);
  };
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraFileRef = useRef<HTMLInputElement>(null);
  // 「聊一聊」标题：空间不足需省略号时，改为直接隐藏文字
  const chatTitleRef = useRef<HTMLSpanElement>(null);
  const [chatTitleOverflow, setChatTitleOverflow] = useState(false);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  // 附件菜单（拍照 / 从相册选择）
  const [imageMenuOpen, setImageMenuOpen] = useState(false);
  const imageMenuRef = useRef<HTMLDivElement>(null);
  // Emoji 面板（聊一聊输入栏）
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiWrapRef = useRef<HTMLDivElement>(null);
  const emojiPanelRef = useRef<HTMLDivElement>(null);
  // 移动端停靠面板打开时记录插入位置（不聚焦、支持连续点选）
  const emojiCursorRef = useRef(0);
  // 预取「理一理」用到的懒加载块（结构化分析/追问/深聊/故事/表情）：进理一理即开，消掉首次 ~0.5s 延迟
  useEffect(() => {
    const prefetch = () => {
      const mods: Promise<unknown>[] = [
        import('./AnalysisResult'),
        import('./QuestionInteraction'),
        import('./DetailedAnalysis'),
        import('./HealingStory'),
        import('./EmojiPicker'),
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
  // 【发送位置（轻量：定位→文本消息）提示】
  const [locMsg, setLocMsg] = useState<string | null>(null);
  const locMsgTimer = useRef<number | null>(null);
  const isMobile = useIsMobile();
  const { height: vvHeight, offsetTop: vvOffsetTop } = useVisualViewport();
  // VirtualKeyboard API：覆盖式键盘（IG Android WebView）唯一能拿到键盘高度的信号。
  // vkInset>0 → 输入栏底边贴键盘上沿；==0 且已聚焦 → 回退「置顶」方案兜底。
  const vkInset = useVirtualKeyboardInset();
  // 记录「键盘收起时」的可视视口高度（最大值），据此判断软键盘是否弹起：
  // 弹起时不再为底部隐私横幅预留空间（横幅已被键盘盖住不可见），让输入栏真正贴住键盘上沿。
  const maxVvHeightRef = useRef(0);
  if (vvHeight > maxVvHeightRef.current) maxVvHeightRef.current = vvHeight;
  const keyboardUp = maxVvHeightRef.current > 0 && vvHeight < maxVvHeightRef.current - 1;

  // 【真机 iOS Safari 键盘处理】
  // iOS Safari 的软键盘是「覆盖式」，且它会在聚焦输入框时自动滚动页面，让输入框保持在键盘上方。
  // 这个页面滚动会让 visualViewport.offsetTop > 0，导致底部输入栏与键盘之间出现大片空白、
  // 甚至键盘弹起瞬间输入栏先消失。聊天页挂载期间锁住 html/body 的滚动（overflow:hidden），
  // 让页面无法被 Safari 滚动，offsetTop 恒为 0，于是容器高度=可视视口高度时，
  // 输入栏底边正好贴住键盘上沿（既有 useVisualViewport 的定位才真正生效）。
  // 真机 iOS 键盘处理（锁滚动 / body fixed / 瞬时回落）抽成共享 hook，聊一聊、剧情对局共用。
  useIosKeyboardLock(true);
  // 移动端停靠面板高度：网格 + 底部工具条合计约占视口 40%；据此算出网格高度（扣掉工具条 36px）
  const emojiDockHeight = useMemo(() => {
    if (!isMobile) return 280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    const gridH = Math.round(vh * 0.4) - 36;
    // 下限 180（太矮不好点），上限 290（太高盖住聊天）
    return Math.max(180, Math.min(290, gridH));
  }, [isMobile]);
  const [, setInputFocused] = useState(false);
  // Android（含 IG 内嵌浏览器）：该环境键盘为纯覆盖层、零视口信号，无法把底部输入栏顶上去。
  // 方案 B，聚焦时把输入栏整体「钉到屏幕顶部」，键盘只占下半屏，输入框永远不被遮挡（同一个 textarea，焦点不丢）。
  const [androidComposerTop, setAndroidComposerTop] = useState(false);
  // 键盘让位量（Android）：
  //  - 视口已随键盘收缩（keyboardUp：普通 Android Chrome，interactive-widget=resizes-content）→ 0，
  //    壳自己跟着收缩即可，不能再叠键盘高度（否则双重补偿、把输入栏顶到键盘上面去）。
  //  - 视口不给信号（IG 内嵌浏览器）→ 用 VirtualKeyboard API 报出的键盘高度。
  const kbOffset = keyboardUp ? 0 : vkInset;
  // 两个信号都没有时，才回退「输入栏置顶」兜底（否则键盘会盖住输入框）。
  const pinComposerTop = IS_ANDROID && androidComposerTop && !keyboardUp && vkInset === 0;
  // 输入框自动增高：内容换行时撑高以完整显示所有文字（上限 max-h-28 ≈ 112px，超出后再在框内滚动）
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [input]);
  // 引用回复 + 复制：**常显在每条消息下方**的图标按钮（2026-09 从 ⋯ 弹层里拿出来，见下方 handler 注释）
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [copiedToast, setCopiedToast] = useState(false);
  /**
   * 「编辑重发」（2026-09，方案 1B + 2A）：正在被改写的那条消息（null = 不在编辑态）。
   *
   * 2A 口径：只有**最后一条用户消息**能编辑（判据 `canEditLastUser`）。这里不保留旧分支，聊一聊的
   * 历史归服务端、且是「追加式」，没有剧情模式那套版本/尾巴结构；代价是被作废的那一轮回复不再可切回，
   * 所以入口只在（且只在）最后一轮出现，并明确提示「这条之后的内容会被清掉」。
   */
  const [editTarget, setEditTarget] = useState<ChatMessage | null>(null);
  /** 进编辑态前的输入框草稿（取消编辑要原样还回去） */
  const editDraftBackupRef = useRef('');
  // 引用跳转：点引用块 → 滚到被引用的那条消息并闪一下（Telegram / iMessage / shadcn 同类交互）
  const [flashMsgId, setFlashMsgId] = useState<string | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  useEffect(() => () => { if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current); }, []);
  // 【语音输入（MediaRecorder 录音 + 服务端 Whisper 转文字，复用现有文本管线）】
  const [recording, setRecording] = useState(false);
  const [voicePending, setVoicePending] = useState(false); // 录音结束、正在服务端转文字
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const voiceSupported = isMediaRecorderSupported();
  // 识别语言：默认「自动」（跟随界面）；用户可切 普通话/广东话/英语
  const [micLang, setMicLang] = useState<SpeechLangKey>('auto');
  const micLangRef = useRef<SpeechLangKey>('auto'); // 供 onstop 闭包读取最新语言（录音中可切换）
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const vadRef = useRef<SilenceDetector | null>(null); // 静音检测（自动停）
  const voiceErrorTimer = useRef<number | null>(null);
  // 录音中的实时秒数（用于「正在聆听 · N″/60″」提示；60 秒封顶自动停）
  const [recSec, setRecSec] = useState(0);
  const recTimerRef = useRef<number | null>(null);
  const startRecTimer = () => {
    setRecSec(0);
    if (recTimerRef.current) window.clearInterval(recTimerRef.current);
    recTimerRef.current = window.setInterval(() => setRecSec(s => Math.min(60, s + 1)), 1000);
  };
  const stopRecTimer = () => {
    if (recTimerRef.current) { window.clearInterval(recTimerRef.current); recTimerRef.current = null; }
  };
  // 朗读 Xiaoyu 回复（TTS）：当前正在朗读的消息 id + 每次播放的独立 Audio 对象（新建，避免共享元素跨音色残留）
  const [voiceReplyId, setVoiceReplyId] = useState<string | null>(null);
  const playAudioRef = useRef<HTMLAudioElement | null>(null);
  // ref 始终持有"最新"朗读状态：即使某条消息按钮/闭包是旧的，也读到当前值（避免改音色后读旧声/状态残留）
  const voiceReplyIdRef = useRef(voiceReplyId);
  voiceReplyIdRef.current = voiceReplyId;
  // 朗读声音设置（VoxCPM2）：结构化配置驱动，弹窗可调
  const [voiceCfg, setVoiceCfg] = useState<VoiceConfig>(() => loadVoiceConfig());
  const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(false);
  // 小愈朗读开关：关闭后不预加载声音、回复下方不显示语音气泡（省服务端 TTS 负载）
  const [voiceEnabled, setVoiceEnabled] = useState<boolean>(() => loadVoiceEnabled());
  const voiceEnabledRef = useRef(voiceEnabled);
  voiceEnabledRef.current = voiceEnabled;
  const handleVoiceEnabledChange = (v: boolean) => {
    setVoiceEnabled(v);
    saveVoiceEnabled(v);
    // 同步到服务端偏好（控制台据此统计「谁开了/谁没开」；游客与登录都写后端）
    savePreferences({ assistantVoiceEnabled: v }).then(r => {
      if (r.success && r.data) setCachedPreferences(r.data);
    }).catch(() => { /* 静默 */ });
  };
  // 加载到服务端偏好后，用「小愈朗读」开关覆盖本地默认（跨设备一致；未设置则保持默认关）
  useEffect(() => {
    void loadPreferences().then((p) => {
      if (p && typeof p.assistantVoiceEnabled === 'boolean') {
        setVoiceEnabled(p.assistantVoiceEnabled);
        saveVoiceEnabled(p.assistantVoiceEnabled);
      }
      // 关系档：跨设备一致（和小愈是什么关系是用户级偏好）
      if (p && p.xiaoyuRelation) setXiaoyuRelation(p.xiaoyuRelation);
    }).catch(() => { /* 忽略 */ });
  }, []);
  // 语言自动跟界面语言（简/繁→中文；en→英文口音），角色音色里存的英文口音在中文界面下也按中文读
  const ttsVoice = voiceCfg.mode === 'clone' ? '' : composeVoice({ ...voiceCfg, dialect: effectiveDialect(voiceCfg.dialect, getLang()) });
  // 当前聊天角色的专属音色（未设则跟随全局/小愈默认）
  const activeCharVoice = ((): string | null => {
    if (activeCharacter?.ttsVoice) {
      try { const c = JSON.parse(activeCharacter.ttsVoice) as VoiceConfig; return c.mode === 'clone' ? '' : composeVoice({ ...c, dialect: effectiveDialect(c.dialect, getLang()) }); } catch { /* ignore */ }
    }
    return null;
  })();
  // 用户选的「地区语气」（比语言更细），说话语言跟随它
  const userRegion = getCachedPreferences()?.region;
  // 顶栏声音编辑的目标：自定义角色→该角色；小愈/默认→全局
  const voiceTarget = activeCharacter && activeCharacter.id !== 'xiaoyu' ? activeCharacter : null;
  const voiceTargetCfg: VoiceConfig = ((): VoiceConfig => {
    if (voiceTarget?.ttsVoice) { try { return { ...DEFAULT_VOICE_CONFIG, ...JSON.parse(voiceTarget.ttsVoice) }; } catch { /* ignore */ } }
    return DEFAULT_VOICE_CONFIG;
  })();
  const saveCharVoice = (id: string, cfg: VoiceConfig) => {
    void updateChatCharacter(id, { ttsVoice: JSON.stringify(cfg) });
  };
  // ref 始终持有"最新音色"：即使某条消息的按钮闭包是旧的，也能读到当前音色（避免改音色后读旧声）
  const ttsVoiceRef = useRef(ttsVoice);
  ttsVoiceRef.current = ttsVoice;
  // 朗读合成中（喇叭按钮显示转圈，提示在生成）
  const [voiceLoading, setVoiceLoading] = useState<string | null>(null);
  // 后台自动预载进行中（只会是最新一条；区别于点击触发的 voiceLoading）。
  // 预载在途的气泡同样显示真实「声音准备中…」加载态，而不是静态「点击生成语音」。
  const [voicePreloadingId, setVoicePreloadingId] = useState<string | null>(null);
  // 【小愈朗读音频（TTS）：按消息 id 缓存 object URL + 时长，供文字下方语音气泡展示/播放复用】
  const [ttsMeta, setTtsMeta] = useState<Record<string, { url: string; duration: number }>>({});
  const ttsUrlRef = useRef(new Map<string, { url: string; duration: number; text: string }>());

  // 【朗读预加载：AI 回复定稿后先在后台合成音频，用户点喇叭即点即播】
  // 以「消息 id + 音色 + 语言」为 key 复用缓存/在途请求，预加载与点击共用同一份，避免重复合成/重复请求。
  // 关键：把所有真实合成请求「串行化」（并发=1）。一段回复常被拆成多条气泡，若同时并发多个 /api/tts，
  // VoxCPM 侧车可能把音频缓冲串位（表现为「点上一句播的是下一句」）；串行可彻底避免。
  const ttsCacheRef = useRef(new Map<string, { blob: Blob; text: string }>());
  const ttsInflightRef = useRef(new Map<string, { text: string; promise: Promise<Blob> }>());
  const ttsChainRef = useRef<Promise<void>>(Promise.resolve());
  const TTS_CACHE_MAX = 20; // 只保留最近若干条，避免长会话内存膨胀
  const ttsCacheKey = (id: string, voice: string, lang: string) => `msg:${id}||${voice}||${lang}`;
  // 串行队列：上一个 /api/tts 结束后再发下一个，保证同一时刻只有一个合成请求在途
  const enqueueTts = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const result = ttsChainRef.current.then(fn, fn);
    ttsChainRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);
  const getTtsAudio = useCallback((id: string, text: string, voice: string): Promise<Blob> => {
    const lang = getLang();
    const key = ttsCacheKey(id, voice, lang);
    const cached = ttsCacheRef.current.get(key);
    // 缓存/在途都带「文本校验」：请求文本与已合成文本不一致（内容已变/串位）时不复用，重新合成，避免播错音频
    if (cached && cached.text === text) return Promise.resolve(cached.blob);
    if (cached) ttsCacheRef.current.delete(key);
    const inflight = ttsInflightRef.current.get(key);
    if (inflight && inflight.text === text) return inflight.promise;
    const p = enqueueTts(async () => {
      // 拿到锁后二次确认缓存（可能已被前面的串行请求填好）
      const again = ttsCacheRef.current.get(key);
      if (again && again.text === text) return again.blob;
      const blob = await ttsToAudio(text, lang, voice);
      const m = ttsCacheRef.current;
      m.delete(key);
      m.set(key, { blob, text });
      while (m.size > TTS_CACHE_MAX) {
        const first = m.keys().next().value;
        if (first === undefined || first === key) break;
        m.delete(first);
      }
      return blob;
    });
    ttsInflightRef.current.set(key, { text, promise: p });
    return p;
  }, [enqueueTts]);
  // 预加载某条消息（以最新音色后台合成，失败静默，不影响聊天）
  const preloadTextAudio = useCallback((messageId: string, text: string) => {
    if (!voiceEnabledRef.current) return;
    const t = stripMarkdown(text).trim();
    if (!t) return;
    const voice = activeCharVoice ?? ttsVoiceRef.current;
    void getTtsAudio(messageId, t, voice).catch(() => { /* 预加载失败：静默 */ });
  }, [activeCharVoice, getTtsAudio]);
  // 把已合成的 TTS blob 注册成可复用 object URL + 时长（供语音气泡展示/播放）。
  // 以「消息 id + 文本」为准：文本/音色变化（换角色、改声音、内容更新）会重新注册，
  // 避免播到旧文本/旧音色的音频（读字错音、漏字的根因之一）。
  const registerTtsUrl = useCallback(async (id: string, blob: Blob, text: string): Promise<{ url: string; duration: number }> => {
    const existing = ttsUrlRef.current.get(id);
    if (existing && existing.text === text) return existing;
    if (existing) { try { URL.revokeObjectURL(existing.url); } catch { /* 忽略 */ } }
    const url = URL.createObjectURL(blob);
    const duration = await new Promise<number>((resolve) => {
      const a = new Audio(url);
      let settled = false;
      const once = (v: number) => {
        if (settled) return;
        settled = true;
        a.removeAttribute('src');
        try { a.load(); } catch { /* 忽略 */ }
        resolve(v);
      };
      a.onloadedmetadata = () => once(Math.round(a.duration || 0));
      a.onerror = () => once(0);
      // 兜底：个别音频取不到时长时 1s 后按 0 处理（气泡显示「…″」占位）
      setTimeout(() => once(Math.round(a.duration || 0)), 1000);
    });
    const meta = { url, duration, text };
    ttsUrlRef.current.set(id, meta);
    setTtsMeta(prev => ({ ...prev, [id]: { url, duration } }));
    return meta;
  }, []);

  // 【角色：当前头像/名称（默认小愈；小愈头像跟随皮肤）】
  const skinAvatar = meta.companion || '/skins/healing/companion.webp?v=3';
  // 无缓存且角色尚未加载完成时，用占位（…/spinner），避免先闪默认小愈再切换
  const charLoading = !activeCharacter && !charReady;
  const activeAvatar = activeCharacter && activeCharacter.id !== 'xiaoyu' ? (activeCharacter.avatar || skinAvatar) : skinAvatar;
  // 头像解析：内置小愈跟随当前皮肤；自定义角色优先自己的头像，无则回退当前皮肤陪伴头像
  const avatarFor = (c: ChatCharacterMeta) => (c.isDefault ? skinAvatar : (c.avatar || skinAvatar));
  // 内置小愈的显示名**跟随界面语言**；自定义角色一律用自己的名字。
  // 2026-09-27 修正：此前是 `activeCharacter?.name` 优先，而内置角色的记录名恒为「小愈」，
  // 于是英文界面的顶栏、设置面板标题、分享卡与给模型的说话人标签都错显成「小愈」。
  const charDisplayName = displayNameForCharacter(activeCharacter);
  // 角色名统一口径（顶栏 / 设置面板 / 分享卡 / 模型上下文）
  const activeName = charDisplayName;
  // 顶栏标题：用短名字（默认小愈官方名过长，窄屏会挤压两侧按钮）；自定义角色名过长时靠 truncate + max-w 截断
  const headerName = charLoading ? '…' : charDisplayName;
  // 开场白：自定义角色用自己的「开场」；未填开场用「我是<名字>…」，不回退成小愈的开场白
  const greetingText = activeCharacter && activeCharacter.id !== 'xiaoyu'
    ? (activeCharacter.opening || (getLang() === 'en' ? 'I am ' + activeCharacter.name + '. What would you like to talk about?' : '我是' + activeCharacter.name + '。想聊点什么？'))
    : t('chatGreeting');
  /**
   * 「正在输入…」小字（2026-09-21 修）：此前写死 `t('chatTyping')`，那两串文案里带「小愈」，
   * 于是切到自定义角色（自建 / 剧情角色导入）后，头像和名字都换成了 TA，这行小字却还在说小愈。
   * 规则：内置小愈沿用原文（口吻一致），其他角色一律用 TA 的名字。
   */
  const typingLabel = (() => {
    const other = activeCharacter && activeCharacter.id !== 'xiaoyu' ? (activeCharacter.name || '').trim() : '';
    if (other) return searching ? t('chatSearchingBy', { name: other }) : t('chatTypingBy', { name: other });
    return searching ? t('chatSearching') : t('chatTyping');
  })();

  const loadCharacters = async (): Promise<ChatCharacterMeta[]> => {
    setCharsLoading(true);
    setCharsFailed(false);
    try {
      const r = await getChatCharacters();
      if (r.success && Array.isArray(r.data)) {
        const data = r.data;
        setCharacters(data);
        setActiveCharacter(prev => (prev ? data.find(c => c.id === prev.id) || data[0] : data[0] || null));
        setCharsFailed(false);
        setCharsLoading(false);
        return data;
      }
      // 失败：让列表层显示「加载失败 + 重试」，而不是骗用户说「还没有对话」
      setCharsFailed(true);
      setCharsLoading(false);
    } catch {
      setCharsFailed(true);
      setCharsLoading(false);
    }
    return [];
  };

  // 加载某个角色的会话并自动打开最近一条（每角色独立会话线）
  /**
   * 打开**指定会话**（2026-09-20 提速）：只要 1 个 RTT 就能把消息铺上屏
   * 会话列表（第二层抽屉用）**并行**去拉，不再"先拉列表再拉消息"串行等两次往返。
   * 用户口径：「点聊一聊进去要等至少 2 秒才看到角色对话」，串行请求在跨境网络下就是 2 秒的来源。
   */
  const openSession = async (characterId: string, sessionId: string) => {
    if (streamRef.current) streamRef.current.cancel = true;
    setTyping(false);
    setSessionLoading(true);
    setSessionLoadFailed(false);
    try {
      setChatSessionId(sessionId);
      /**
       * 先铺**进程内缓存**的那份（来回"列表 ↔ 对话"时秒开，不用干等一次往返），
       * 再去服务端刷新，刷新回来会覆盖，所以看到的永远是最新内容。
       * 缓存只在内存里、只留在当前标签页，不落盘（隐私与陈旧两头都不占）。
       */
      const cached = sessionMsgCache.get(sessionId);
      const hadCached = !!(cached && cached.length > 0);
      if (hadCached) setChatMessages(cached as ChatMessage[]);
      const [r, listR] = await Promise.all([
        getChatSession(sessionId, CHAT_OPEN_FETCH_OPTS),
        getChatSessions(CHAT_OPEN_FETCH_OPTS),
      ]);
      if (r.success && r.data) {
        const mapped = mapServerMessages(r.data.messages);
        setChatMessages(mapped);
        // 打开即已读（上限=屏幕上最后一条，服务端随后落库的消息不会被提前吞掉）
        void clearUnread(sessionId, lastTsOf(mapped));
      } else if (!hadCached) {
        // 屏幕上有缓存内容时不要用失败页把它盖掉；真正空屏才提示失败+重试
        setSessionLoadFailed(true);
      }
      if (listR.success && Array.isArray(listR.data)) {
        setChatSessions(listR.data.filter(s => (s.characterId || 'xiaoyu') === characterId));
      }
    } catch {
      // 超时/网络失败：交给失败态 + 重试按钮，绝不无声转圈
      setSessionLoadFailed(true);
    } finally {
      setSessionLoading(false);
    }
  };

  /**
   * 加载某个角色的会话并打开：
   * `preferSessionId`（可选）= 指定先打开哪一条（用于"从消息列表点进来"时打开**真正有未读的那一条**，
   * 否则用户会看到角标一直在、点进去却什么都没变，列表行的角标可能来自该角色另一条更旧的会话）。
   */
  const loadSessionsFor = async (characterId: string, preferSessionId?: string | null) => {
    // 已经知道要开哪条会话（从消息列表点进来）→ 直接开，省掉"先拉列表"那一跳
    if (preferSessionId) { await openSession(characterId, preferSessionId); return; }
    if (streamRef.current) streamRef.current.cancel = true;
    setTyping(false);
    setSessionLoading(true);
    setSessionLoadFailed(false);
    try {
      const listR = await getChatSessions(CHAT_OPEN_FETCH_OPTS);
      if (listR.success && Array.isArray(listR.data)) {
        const mine = listR.data.filter(s => (s.characterId || 'xiaoyu') === characterId);
        setChatSessions(mine);
        if (mine.length > 0) {
          const prefer = preferSessionId ? mine.find(s => s.sessionId === preferSessionId) : undefined;
          const target = prefer || mine[0];
          setChatSessionId(target.sessionId);
          const r = await getChatSession(target.sessionId, CHAT_OPEN_FETCH_OPTS);
          if (r.success && r.data) {
            const mapped = mapServerMessages(r.data.messages);
            setChatMessages(mapped);
            // 打开即已读，但**上限是屏幕上最后一条**（不是 now），服务端随后才落库的消息不会被提前吞掉
            void clearUnread(target.sessionId, lastTsOf(mapped));
          } else {
            setSessionLoadFailed(true);
          }
        }
      } else {
        setSessionLoadFailed(true);
      }
    } catch {
      setSessionLoadFailed(true);
    } finally {
      setSessionLoading(false);
    }
  };

  // 切换角色：重置当前会话并加载该角色自己的会话线
  const switchCharacter = (c: ChatCharacterMeta, preferSessionId?: string | null) => {
    // 用户自己选了角色（挂载时那次默认挑选不该再覆盖它，见 userPickedCharRef）
    userPickedCharRef.current = true;
    if (c.id === activeCharacter?.id) {
      // 同一角色、但指定了要打开的那条会话（从消息列表点进来）→ 也要真的切过去
      if (preferSessionId && preferSessionId !== chatSessionId) {
        setHistoryOpen(false);
        void loadSessionsFor(c.id, preferSessionId);
      }
      return;
    }
    cancelStream();
    setActiveCharacter(c);
    setLastChatChar(c);
    setChatSessionId(null);
    setChatMessages([]);
    setSessionLoading(true);
    setInput('');
    setQuotaMsg(null);
    clearRedirectHint();
    setReplyTo(null);
    setHistoryOpen(false);
    void loadSessionsFor(c.id, preferSessionId);
  };

  // 聊天内「理一理」：带当前角色的会话与角色信息进入结构化深整理，结束后回到聊天
  const openStructure = () => {
    // 复用当前聊天的会话线（结构数据与该角色共存于同一会话）；若还没有会话则让理一理新建
    setSessionId(chatSessionId || null);
    if (activeCharacter && activeCharacter.id !== 'xiaoyu') setStructureCharacterId(activeCharacter.id);
    else setStructureCharacterId(null);
    setCurrentStep('input');
    setStructureOpen(true);
  };
  const closeStructure = () => {
    setStructureOpen(false);
    // 回到聊天：清掉理一理临时状态，避免下次（含独立理一理页）串用旧会话/角色
    setSessionId(null);
    setStructureCharacterId(null);
    setCurrentStep('input');
  };

  // 【角色编辑（新建/编辑/删除）】
  const openNewChar = () => {
    setEditingChar(null);
    setCharForm({ name: '', identity: '', boundaries: '', voice: '', ttsVoice: '', opening: '' });
    setCharAvatar('');
    setCharError(null);
    setCharEditorOpen(true);
  };
  const openEditChar = (c: ChatCharacterMeta) => {
    setEditingChar(c);
    setCharForm({ name: c.name, identity: c.identity, boundaries: c.boundaries, voice: c.voice, ttsVoice: c.ttsVoice || '', opening: c.opening || '' });
    setCharAvatar(c.avatar || '');
    setCharError(null);
    setCharEditorOpen(true);
  };
  // 观景窗：只读查看该角色的关系记忆/反思/日记/自画像
  const openGrowth = async (c: ChatCharacterMeta) => {
    setGrowthCharName(c.name);
    setGrowthCharId(c.id);
    setGrowthView(null);
    setGrowthOpenSec({}); // 每次打开观景窗默认全收起
    setGrowthOpen(true);
    try {
      const r = await getChatCharacterGrowth(c.id);
      if (r.success && r.data) setGrowthView(r.data);
    } catch { /* 忽略 */ }
  };
  // 观景窗：删除某条「TA 记得的你」（用户事实），按当前角色维度删除
  const handleDeleteGrowthFact = async (index: number) => {
    if (!growthCharId) return;
    const r = await deleteMemory(index, growthCharId);
    if (r.success && r.data) {
      // 列表以带时间轴的 entries 渲染 → 删除后两者都要同步，否则被删的那条还挂在界面上
      const { facts, entries } = r.data;
      setGrowthView(v => v ? { ...v, userFacts: facts, userFactEntries: entries } : v);
    }
  };
  // 【剧情角色（origin='story'）：TA 记得的这段剧情】
  const isStoryChar = (c: ChatCharacterMeta | null | undefined): boolean => c?.origin === 'story';
  /**
   * 改「关系类型」（2026-09-21）。写哪儿取决于当前角色：
   *   · 内置小愈 → **用户级偏好**（它不是用户记录，`userId === ''`）
   *   · 自定义角色 → **角色字段**（每角色一档，换角色不串）
   *   · 剧情角色 → 面板里根本不显示这一项（剧本人设自带关系与称呼，叠一层会把它冲成"小愈味"）
   * 乐观更新 + 失败回滚，与 storyMode 的写法一致（改完立刻在会话里生效，不等下一轮）。
   */
  const changeActiveRelation = (r: ChatRelationKind) => {
    const c = activeCharacter;
    if (c && c.id !== 'xiaoyu') {
      const prev = c.relation ?? 'friend';
      const apply = (v: ChatRelationKind) => {
        setCharacters(list => list.map(x => (x.id === c.id ? { ...x, relation: v } : x)));
        setActiveCharacter(a => (a && a.id === c.id ? { ...a, relation: v } : a));
      };
      apply(r);
      updateChatCharacter(c.id, { relation: r }).then(res => { if (!res.success) apply(prev); }).catch(() => apply(prev));
      return;
    }
    setXiaoyuRelation(r);
    try { const cc = getCachedPreferences(); if (cc) setCachedPreferences({ ...cc, xiaoyuRelation: r }); } catch { /* 忽略 */ }
    void savePreferences({ xiaoyuRelation: r });
  };
  /** 打开「TA 记得的这段剧情」（只读：摘要 + 未完成的线 + 场面块 + 剧情那边的新进度） */
  const openStory = async (c: ChatCharacterMeta) => {
    setStoryOpen(true);
    setStoryView(null);
    setStoryLoading(true);
    try {
      const r = await getCharacterStory(c.id);
      if (r.success && r.data) setStoryView(r.data);
    } catch { /* 忽略 */ } finally { setStoryLoading(false); }
  };
  /** 增量同步：把剧情那边新玩的几轮并进记忆（只提炼新增段，块按区间去重） */
  const handleStorySync = async () => {
    const c = activeCharacter;
    if (!isStoryChar(c) || !c) return;
    setStorySyncing(true);
    try {
      const r = await syncStoryCharacter(c.id);
      if (r.success) {
        const v = await getCharacterStory(c.id);
        if (v.success && v.data) setStoryView(v.data);
      }
    } catch { /* 忽略 */ } finally { setStorySyncing(false); }
  };
  /** 双态切换（入戏 / 出戏）：记忆不变，只是"怎么看待这段关系"换了说法 */
  const handleStoryMode = async (mode: 'in' | 'out') => {
    const c = activeCharacter;
    if (!isStoryChar(c) || !c || (c.storyMode || 'in') === mode) return;
    setStoryModeSaving(true);
    try {
      const r = await updateChatCharacter(c.id, { storyMode: mode });
      if (r.success) {
        const next = { ...c, storyMode: mode };
        setActiveCharacter(next);
        setLastChatChar(next);
        setCharacters(list => list.map(x => (x.id === c.id ? { ...x, storyMode: mode } : x)));
        setStoryView(v => (v ? { ...v, mode } : v));
      }
    } catch { /* 忽略 */ } finally { setStoryModeSaving(false); }
  };
  // 头像上传：压缩成小图后存为 data URL
  const pickAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      setCharAvatar(dataUrl);
    } catch { /* 忽略 */ }
  };
  const saveChar = async () => {
    const name = charForm.name.trim();
    const identity = charForm.identity.trim();
    const boundaries = charForm.boundaries.trim();
    const voice = charForm.voice.trim();
    if (!name || !identity || !boundaries || !voice) { setCharError(t('chatCharRequired')); return; }
    setCharSaving(true);
    setCharError(null);
    try {
      const payload = { name, avatar: charAvatar || undefined, identity, boundaries, voice, ttsVoice: charForm.ttsVoice || undefined, opening: charForm.opening.trim() || undefined };
      const r = editingChar
        ? await updateChatCharacter(editingChar.id, payload)
        : await createChatCharacter(payload);
      if (r.success && r.data) {
        setCharEditorOpen(false);
        if (editingChar) {
          // 编辑：保留当前激活角色不变（loadCharacters 会维持 prev active）
          await loadCharacters();
        } else {
          // 新建：自动切换到新角色，让它立刻以自己的身份/开场陪聊
          const created = r.data;
          await loadCharacters();
          switchCharacter(created);
        }
      } else {
        // 诊断：把后端返回的具体错误打到控制台，便于定位「保存失败」的真实原因
        console.warn('[chatChar] save failed:', JSON.stringify(r));
        setCharError(r.error || t('chatCharFail'));
      }
    } catch { setCharError(t('chatCharFail')); }
    finally { setCharSaving(false); }
  };
  const removeChar = async (c: ChatCharacterMeta) => {
    if (c.isDefault) return;
    if (!window.confirm(t('chatCharDelete') + '「' + c.name + '」？')) return;
    const r = await deleteChatCharacter(c.id);
    if (r.success) {
      await loadCharacters();
      if (activeCharacter?.id === c.id) {
        const xiaoyu = characters.find(x => x.id === 'xiaoyu');
        if (xiaoyu) switchCharacter(xiaoyu);
        else { setActiveCharacter(null); setChatSessionId(null); setChatMessages([]); }
      }
    } else {
      try { window.alert(r.error || t('chatCharFail')); } catch { /* 忽略 */ }
    }
  };

  // 点击「角色」下拉菜单外部关闭
  useEffect(() => {
    if (!charMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (charMenuRef.current && !charMenuRef.current.contains(e.target as Node)) setCharMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [charMenuOpen]);

  // 标题「聊一聊」若放不下需要省略号 → 改为直接隐藏文字
  useEffect(() => {
    const el = chatTitleRef.current;
    if (!el) return;
    const check = () => setChatTitleOverflow(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    window.addEventListener('resize', check);
    return () => { ro.disconnect(); window.removeEventListener('resize', check); };
  }, []);

  // 「转入理一理」提示：用户可在当次对话内选择不再提醒（按会话 id 记忆）
  const [hintDismissed, setHintDismissed] = useState(false);
  useEffect(() => {
    try {
      const k = chatSessionId ? 'cure_hint_dismiss_' + chatSessionId : '';
      setHintDismissed(k ? localStorage.getItem(k) === '1' : false);
    } catch { setHintDismissed(false); }
  }, [chatSessionId]);
  const dismissHint = () => {
    setHintDismissed(true);
    try {
      if (chatSessionId) localStorage.setItem('cure_hint_dismiss_' + chatSessionId, '1');
    } catch { /* 忽略 */ }
  };

  // 「角色扮演指令分流」提示卡：后端判定用户这条消息是「来玩角色扮演」的指令时返回 hint
  // （不调 AI、不扣额度），这里给一张带一键直达的卡片；仅对当前这条消息生效，切会话/再发一条即消失。
  const [redirectHint, setRedirectHint] = useState<ChatRedirectHint | null>(null);
  /**
   * 「小愈已经在回复里自己说清楚了」→ 只渲染一个**直达按钮**，不重复整张说明卡（2026-09-25）。
   * 用户原话：「要有一个直达的按键而不只是信息说明」，戏内升级那条路是模型用自己的话引导的，
   * 以前用户看得到"该去哪"却**按不到**；后端据此回传 hintCompact（见 chatRedirect.shouldAttachAdultHint）。
   */
  const [redirectHintCompact, setRedirectHintCompact] = useState(false);
  /** 卡片/按钮的统一下线（提示卡是"这一条消息的附注"，任何换会话/再发送都要跟着消失） */
  const clearRedirectHint = () => { setRedirectHint(null); setRedirectHintCompact(false); };
  // 这一回合「没接上」的失败提示（2026-09-15）：'' 表示正常。
  // 存 'TIMEOUT' / 'NETWORK' / 'ABORTED' 这类 code，或服务端返回的可读错误串。
  // 🚨 它**不是**小愈的回复，只作为系统提示 + 重试入口渲染（不再塞进 assistant 气泡）。
  const [sendFailed, setSendFailed] = useState('');
  const failedTurnRef = useRef<{ content: string; image?: string; audio?: string } | null>(null);
  const goRoleplayFromHint = (stage?: 'list' | 'custom', opts?: { pref?: boolean; adult?: boolean }) => {
    clearRedirectHint();
    onGoRoleplay?.(stage, undefined, opts);
  };
  // 「在聊一聊建角色」：已登录直接开新建角色表单；游客先走注册/登录（角色需要账号才能保存与同步）
  const createCharacterFromHint = () => {
    clearRedirectHint();
    if (!isLoggedIn()) { onNeedLogin?.(); return; }
    openNewChar();
  };

  // 加载配额（免费剩余 / Plus 每日额度 / Pro 无限）
  useEffect(() => {
    getQuota().then(r => { if (r.success && r.data) setQuota(r.data); });
    // 邀请奖励数值取后端配置（避免写死漂移）；拿不到时保留默认 50
    getPayConfig().then(r => { if (r.success && r.data?.bonuses?.invite) setInviteBonus(r.data.bonuses.invite); });
  }, []);

  // 加载角色列表 + 多对话列表；默认打开「上一次聊天」的角色（最近更新会话所属角色），而非固定小愈
  useEffect(() => {
    let cancelled = false;
    (async () => {
      /**
       * 提速（2026-09-20 用户口径「进去要等至少 2 秒」）：
       * 原来是**四跳串行**（角色 → 会话列表 → 这条会话的消息 → 消息列表首页），
       * 跨境网络（走 Cloudflare 回源）每跳 300–500ms ⇒ 首屏 1.5–2s。
       * 现在：**首屏只等"角色 + 消息列表"两个并行请求**（列表页真正需要的就这两样），
       * 会话列表/消息只在"需要直接进某个角色的对话"时才去拉，且两者并行。
       */
      /**
       * 角色行**先于**消息列表上屏（2026-09-25。用户口径：「点进聊一聊，默认小愈加载很慢，
       * 很多时候都是看到空白页无角色」）。
       * 两个请求虽然并行发出，但下面原来要等 Promise.all 两个都回来才 setCharacters，而消息列表是
       * 按该用户全部会话聚合 + 统计未读的，会话一多就明显慢于角色接口，把「小愈」这一行也一起拖住了。
       * 现在：角色一到就先把行画上，消息列表随后到再补预览/未读。
       */
      const charsP = getChatCharacters();
      const inboxP = getChatInbox();

      // 兜底 catch：apiRequest 内部已吞网络错误，但万一这层抛了也不能让列表永远停在骨架上
      const charsR = await charsP.catch(() => ({ success: false } as { success: boolean; data?: ChatCharacterMeta[] }));
      if (cancelled) return;
      const chars = (charsR.success && Array.isArray(charsR.data)) ? charsR.data : [];
      setCharacters(chars);
      if (!charsR.success) setCharsFailed(true);
      setCharsLoading(false);
      setCharReady(true);

      const inboxR0 = await inboxP.catch(() => ({ success: false } as { success: boolean; data?: ChatInboxRow[] }));
      if (cancelled) return;
      const inboxRows = (inboxR0.success && Array.isArray(inboxR0.data)) ? inboxR0.data : [];
      setInbox(inboxRows);
      // 列表可以画了：先把"加载中"放下，别让首屏干等后面的请求
      setSessionLoading(false);

      // 用消息列表页拿到的行当"轻量会话列表"：`updatedAt` 要给真 ISO 串，否则 pickActiveCharacter 的排序会全是 NaN
      const all: ChatSessionMeta[] = inboxRows
        .filter((r) => !!r.sessionId)
        .map((r) => ({
          sessionId: r.sessionId,
          characterId: r.characterId,
          title: r.title,
          preview: r.preview,
          messageCount: r.messageCount,
          createdAt: new Date(r.updatedAt || Date.now()).toISOString(),
          updatedAt: new Date(r.updatedAt || Date.now()).toISOString(),
          pinned: r.pinned,
        }));
      const active = pickActiveCharacter(chars, all, chatSessionId);
      /**
       * 剧情页刚导入了一个角色并点了「去看看」→ 直接落到那个角色（优先于"上一次聊天角色"）。
       * 读一次即清空：用户下次自己切走后不该被拽回来。
       */
      const wanted = pendingChatCharId ? chars.find(c => c.id === pendingChatCharId) : undefined;
      const chosen = wanted || active;
      // ⚠️ 角色行现在会**先于**消息列表上屏，用户可能已经自己点过某一行，别把默认挑选盖在他头上
      if (!userPickedCharRef.current) {
        setActiveCharacter(chosen);
        setLastChatChar(chosen); // 同步缓存：下次进入免加载直接显示该角色
      }
      if (pendingChatCharId) {
        setPendingChatCharId(null);
        // 从剧情页「加到聊一聊」过来：这一次要**直接进它的对话**（不是停在消息列表）
        if (wanted) setListOpen(false);
      }

      /**
       * 默认停在消息列表首页 ⇒ **列表之外的东西一律不预取**。
       * 只有两种情况需要马上把某条会话铺上屏：① 从剧情页导入后直接进它的对话；
       * ② 页面重挂载时记住的上一条会话。两者都用 `openSession`（1 跳出消息 + 并行拉列表）。
       */
      const wantConversation = !!pendingChatCharId || (!!chatSessionId && !listOpenAtMount.current);
      if (!wantConversation) return;
      const targetId = pendingChatCharId
        ? (inboxRows.find((r) => r.characterId === (chosen?.id || 'xiaoyu') && (r.unreadSessionId || r.sessionId))?.unreadSessionId
           || inboxRows.find((r) => r.characterId === (chosen?.id || 'xiaoyu'))?.sessionId)
        : chatSessionId;
      if (targetId) await openSession(chosen?.id || 'xiaoyu', targetId);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 新消息 / 流式内容增长时滚动到底部
  const lastMsgLen = chatMessages.length > 0 ? chatMessages[chatMessages.length - 1].content.length : 0;

  // 智能跟随：距底部 <80px 视为「贴底」。贴底才自动滚到最新；上滑阅读时暂停，
  // 避免「读上一条时被新消息拽走 / 页面晃动」。
  const updateScrollState = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceFromBottom < 80;
    setAtBottom(nearBottom);
    // 只有「用户真实滚动」才能改变跟随意图；程序化自动滚动（el.scrollTo 贴底）不改变，
    // 否则流式时贴底处上滑会被自动滚动拽回，用户拉不上去。
    if (userScrollingRef.current) stickToBottomRef.current = nearBottom;
  };

  // 回到最新 / 自动跟随统一入口：同一帧内多次触发只滚一次，减少抖动
  const requestScrollToBottom = (behavior: ScrollBehavior) => {
    if (rafRef.current !== null) return; // 本帧已有滚动请求
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      // 如果等待期间用户已上滑阅读，就放弃本次自动滚动，避免把视图拽下去
      if (!stickToBottomRef.current) return;
      // 用户正在拖拽/滚动：不与用户抢，等用户停下来再决定是否跟随
      if (userScrollingRef.current) return;
      const el = scrollRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior });
    });
  };

  // 回到最新：出现「回到最新」按钮时点击，重新吸底
  const scrollToBottom = () => {
    stickToBottomRef.current = true;
    setAtBottom(true);
    requestScrollToBottom('smooth');
  };

  // 新消息 / 流式内容增长时，仅当用户「贴底」才自动滚到最新（rAF 合帧，避免连续滚动抖动）
  useEffect(() => {
    if (!stickToBottomRef.current) return; // 用户在上滑阅读，别打扰
    requestScrollToBottom(streaming ? 'auto' : 'smooth');
  }, [chatMessages.length, sending, streaming, lastMsgLen, typing, searching, vvHeight]);

  /**
   * 用最终正文**重建本轮的助手气泡**（2026-09-29 输出卫生闸专用）。
   *
   * 为什么需要：流式是边生成边显示的，而「剥掉开头自言自语」与「自言自语重生成」都是**事后**才知道的
   * 那时原文已经画在屏幕上了（而且前端优先用流式文本，不重建就会**永久留着一个错误版本**）。
   * 所以服务端在 done 里带 revised=true 时，这里按最终正文重排气泡，保证「打字时看到的」
   * 与「最终 / 重进历史看到的」一致。段落口径与分段发送器、服务端完全一致：split('\n\n')→trim→丢空段。
   */
  const rebuildTurnBubbles = (finalReply: string) => {
    const list = useAppStore.getState().chatMessages;
    const ids: string[] = [];
    for (let i = list.length - 1; i >= 0 && list[i].role === 'assistant'; i--) ids.unshift(list[i].id);
    if (!ids.length) return;
    const parts = String(finalReply || '').split('\n\n').map(p => p.trim()).filter(Boolean);
    if (!parts.length) return;
    const start = list.findIndex(x => x.id === ids[0]);
    if (start < 0) return;
    const rebuilt = parts.map(p => newMsg('assistant', p));
    setChatMessages([...list.slice(0, start), ...rebuilt, ...list.slice(start + ids.length)]);
  };

  /**
   * 把来源挂到**对应的那条气泡**上（2026-09-29 用户实测反馈后重做）。
   *
   * 两条来源、两种归属，规则与历史还原（src/lib/chatServerMessages.ts）逐字一致：
   *  · `segSources[j]` = 第 j 段（＝第 j 条气泡）**自己引用**的来源 → 挂那条气泡
   *    （用户要的正是这个：讲这条新闻的那条气泡下面，挂这条新闻的出处）；
   *  · `turnSources` = 整轮（web_search 工具命中）→ 挂**最后一条**（原来的语义）；
   *  · 最后一条两者都有 → 合并去重。
   *
   * 段↔气泡的对齐：分段发送器把回复按 \n\n 拆成气泡，所以「本轮连续的助手气泡」按顺序就是各段。
   * 数量对不上（理论上不会）时退回「全部挂最后一条」，绝不因为对齐失败把来源丢掉。
   * ⚠️ 必须在 cancelStream() 之前调用：那会 ++sendGenRef，之后的迟到逻辑一律作废。
   */
  const attachSourcesBySegment = (turnSources?: ChatSource[], segSources?: (ChatSource[] | null)[]) => {
    const list = useAppStore.getState().chatMessages;
    const ids: string[] = [];
    for (let i = list.length - 1; i >= 0 && list[i].role === 'assistant'; i--) ids.unshift(list[i].id);
    if (!ids.length) return;
    /**
     * 先把「段 → 来源」摊成一张与气泡一一对应的表，再统一写回。
     * ⚠️ 段数比气泡多时（理论上不该发生）把多出来的并到**最后一条**，绝不静默丢弃
     * 2026-09-29 实测踩过：那时 `aligned=false` 会把整批来源直接吞掉，用户看到的就是「一条来源都没有」。
     */
    const perBubble: ChatSource[][] = ids.map(() => []);
    (segSources || []).forEach((s, j) => {
      if (!s || !s.length) return;
      const target = Math.min(j, ids.length - 1);
      perBubble[target] = mergeSources(perBubble[target], s);
    });
    ids.forEach((id, j) => {
      const isLast = j === ids.length - 1;
      const merged = mergeSources(perBubble[j], isLast ? (turnSources || []) : []);
      if (merged.length) setChatMessageSources(id, merged);
    });
  };

  // 【拟人化分段发送（一个段落 = 一条气泡；段落内容到达即开气泡并逐字浮出，段落间保留「正在输入」）】
  const openBubble = (s: StreamState, text: string): string => {
    const m = newMsg('assistant', text);
    if (!s.firstMsgId) s.firstMsgId = m.id;
    addChatMessage(m);
    return m.id;
  };
  const runReveal = async (s: StreamState) => {
    // 打字机节奏：每 CHAR_MS 露出 1 字；MAX_CHARS_PER_TICK 兜底浏览器节流/时间跳变，避免突跳
    const CHAR_MS = 14;            // ≈71 字/秒，轻快但仍看得出在逐字输入
    const MAX_CHARS_PER_TICK = 12; // 单次最多补的字数
    const PARA_PAUSE_MS = 420;     // 段落间「正在输入」停顿，模拟真人连发

    let paraStart = s.sentLen;     // 当前段落在 s.full 中的起始偏移
    let revealed = s.sentLen;      // 当前段已逐字画出的偏移
    let openId: string | null = null;
    let lastType = Date.now();

    setTyping(true);

    while (true) {
      if (s.cancel) return;

      // 当前段落还没任何内容：流没结束就继续等（保持「正在输入」）
      if (s.full.length <= paraStart) {
        if (s.ended) break;
        await sleep(60);
        continue;
      }

      const boundary = s.full.indexOf('\n\n', revealed);
      const paraEnd = boundary < 0 ? s.full.length : boundary;

      // 跳过空段 / 纯空白段（开头或连续的 \n\n），避免开出空白气泡
      let j = paraStart;
      while (j < paraEnd && /\s/.test(s.full[j])) j++;
      if (j >= paraEnd) {
        if (boundary >= 0) { paraStart = boundary + 2; revealed = paraStart; continue; }
        if (s.ended) break;
        await sleep(30);
        continue;
      }
      if (j > paraStart) { paraStart = j; revealed = j; }

      // 段落刚有内容：开气泡、先露出首个字符
      if (!openId) {
        const first = Math.min(revealed + 1, paraEnd);
        const text = s.full.slice(paraStart, first);
        openId = openBubble(s, text);
        revealed = first;
        setTyping(false);
        updateChatMessage(openId, s.full.slice(paraStart, revealed).trim());
        lastType = Date.now();
        continue;
      }

      // 打字机：按已过时间补字，但不越过段尾、不一次补太多
      const now = Date.now();
      let step = Math.floor((now - lastType) / CHAR_MS);
      if (step < 1) { await sleep(CHAR_MS); continue; }
      step = Math.min(step, MAX_CHARS_PER_TICK);
      lastType = now;
      revealed = Math.min(revealed + step, paraEnd);
      updateChatMessage(openId, s.full.slice(paraStart, revealed).trim());

      if (revealed >= paraEnd) {
        if (boundary >= 0) {
          // 整段浮完：定稿该气泡（去掉 \n\n），跳到下一段，先「正在输入」再开新气泡
          updateChatMessage(openId, s.full.slice(paraStart, boundary).trim());
          paraStart = boundary + 2;
          revealed = paraStart;
          openId = null;
          setTyping(true);
          if (s.cancel) return;
          await sleep(PARA_PAUSE_MS);
          lastType = Date.now();
          continue;
        }
        // 还没遇到 \n\n：继续等更多 token（或流结束）
        if (s.ended) break;
        await sleep(30);
        continue;
      }

      await sleep(20);
    }

    // 流结束：未定稿的段落补上尾巴；否则把还没发出的文字作为一条气泡
    if (openId) {
      updateChatMessage(openId, s.full.slice(paraStart).trim());
    } else if (s.full.length > s.sentLen) {
      const tail = s.full.slice(s.sentLen).trim();
      if (tail) { openBubble(s, tail); }
    }
    setTyping(false);
    s.done = true;
  };
  const waitRevealDone = async () => {
    const s = streamRef.current;
    if (!s) return;
    const t0 = Date.now();
    // 等分段器把剩余段落自然发完（已移除人为打字/思考停顿，这里只作极端卡死的兜底）；
    // 之前 3s 硬超时会在「正在输入」后提前 cancelStream，把还没发出的段落丢弃
    //（表现为：正在输入突然消失、消息不出现，重进历史才看到）。
    // 这里改为 60s 兜底（正常 runReveal 在 s.ended 后必然置 done），仅极端卡死才触发。
    while (!s.done && !s.cancel && Date.now() - t0 < 60000) await sleep(60);
  };
  const cancelStream = () => {
    sendGenRef.current++; // 使在途 onDelta 立即失效，避免旧会话迟到 token 串进新会话
    if (streamAbortRef.current) { streamAbortRef.current.abort(); streamAbortRef.current = null; }
    if (streamRef.current) streamRef.current.cancel = true;
    streamRef.current = null;
    setTyping(false);
    setSearching(false);
  };

  // 组件卸载 / 切会话时停止当前分段发送，并取消未执行的滚动请求
  useEffect(() => () => {
    cancelStream();
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    if (userScrollTimerRef.current) window.clearTimeout(userScrollTimerRef.current);
  }, []);

  // 预热 EmojiPicker 懒加载 chunk：浏览器空闲时预取，避免首次点开 emoji 才下载 366KB 而卡顿
  useEffect(() => {
    const warm = () => { import('./EmojiPicker').catch(() => { /* 忽略 */ }); };
    const w = window as unknown as { requestIdleCallback?: (cb: () => void) => number; cancelIdleCallback?: (h: number) => void };
    const id = w.requestIdleCallback ? w.requestIdleCallback(warm) : window.setTimeout(warm, 1500);
    return () => {
      if (w.cancelIdleCallback && typeof id === 'number') w.cancelIdleCallback(id);
      else window.clearTimeout(id as number);
    };
  }, []);

  // 【语音输入：录音（MediaRecorder）→ 上传服务端 Whisper 转文字，回填输入框（不自动发送）】
  const showVoiceError = (msg: string) => {
    setVoiceError(msg);
    if (voiceErrorTimer.current) window.clearTimeout(voiceErrorTimer.current);
    voiceErrorTimer.current = window.setTimeout(() => setVoiceError(null), 4200);
  };

  const startVoice = async () => {
    if (voicePending || sending) return;
    if (!voiceSupported) { showVoiceError(t('voiceUnsupported')); return; }
    if (!navigator.mediaDevices?.getUserMedia) { showVoiceError(t('voiceUnsupported')); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickMediaMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        try { stream.getTracks().forEach((tr) => tr.stop()); } catch { /* 忽略 */ }
        setRecording(false);
        stopRecTimer();
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || mime || 'audio/webm' });
        if (!blob.size) { showVoiceError(t('voiceNoSpeech')); return; }
        setVoicePending(true);
        try {
          const audioBase64 = await encodeAudioToPcm16Base64(blob);
          const lang = resolveSpeechLang(micLangRef.current, getLang());
          const r = await asr({ lang, audioBase64 });
          const text = (r.success && r.data?.text ? r.data.text : '').trim();
          // 微信式语音气泡：转写后自动发送，并附带原始录音 data URL（可点播）；Xiaoyu 靠 text 理解
          if (text) {
            let audioDataUrl: string | undefined;
            try { audioDataUrl = await blobToDataUrl(blob); } catch { /* 拿不到气泡音频则仅发文字 */ }
            handleSend(text, undefined, audioDataUrl);
          } else {
            showVoiceError(t('voiceNoSpeech'));
          }
        } catch {
          showVoiceError(t('voiceNetwork'));
        } finally {
          setVoicePending(false);
        }
      };
      rec.onerror = () => { setRecording(false); showVoiceError(t('voiceNetwork')); };
      recRef.current = rec;
      mediaStreamRef.current = stream;
      // 检测「说完（静音）」自动停录音并转写，不再需要用户手动点停止；不可用时退回手动停止
      try {
        vadRef.current = createSilenceDetector(stream, () => stopVoice(), { silenceMs: 800, minSpeechMs: 400, maxMs: 60000 });
      } catch { vadRef.current = null; }
      setRecording(true);
      startRecTimer();
      setVoiceError(null);
      setInput('');
      rec.start();
    } catch (err) {
      setRecording(false);
      const name = (err as Error)?.name;
      showVoiceError(name === 'NotAllowedError' || name === 'SecurityError' ? t('voicePermissionDenied') : t('voiceUnsupported'));
    }
  };

  const stopVoice = () => {
    try { vadRef.current?.stop(); } catch { /* 忽略 */ }
    vadRef.current = null;
    stopRecTimer();
    const rec = recRef.current;
    if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch { /* 忽略 */ } }
  };

  // 录音中切换识别语言：只记录下一次转写用的语言（MediaRecorder 不能在录音中途换语言）
  const changeVoiceLang = (v: SpeechLangKey) => {
    setMicLang(v);
    micLangRef.current = v;
  };

  // 输入框内「语音转文字」：无内容→开始录音；录音中/转写中→停止
  const toggleVoice = () => {
    if (voicePending || recording) { stopVoice(); return; }
    if (voiceSupported) { startVoice(); return; }
  };

  // 朗读 Xiaoyu 的回复（TTS，自然年轻女声）：点喇叭播放/停止；同一时间只播一条
  const playAssistantVoice = async (m: ChatMessage, voiceOverride?: string) => {
    const usedVoice = voiceOverride || (activeCharVoice ?? ttsVoiceRef.current);
    if (voiceReplyIdRef.current === m.id) {
      // 停止当前播放（独立 Audio，直接丢弃即可）
      const cur = playAudioRef.current;
      if (cur) { try { cur.pause(); cur.removeAttribute('src'); try { cur.load(); } catch { /* ignore */ } } catch { /* ignore */ } }
      setVoiceReplyId(null);
      return;
    }
    try {
      setVoiceLoading(m.id);
      const text = stripMarkdown(m.content).trim();
      if (!text) { setVoiceLoading(null); return; }
      // 与设置面板「试听」同走 /api/tts 全量 WAV（同一音色路径，保证听感一致）。
      // 走 getTtsAudio：若后台预加载已完成则直接用缓存（即点即播）；否则等正在合成的同一请求。
      const blob = await getTtsAudio(m.id, text, usedVoice);
      // 注册/复用该消息的 object URL（预加载已就绪则直接拿来播，避免重复 URL + 重复取 metadata）
      const meta = await registerTtsUrl(m.id, blob, text);
      // 每次播放都新建一个独立 Audio 对象（不复用共享元素，避免跨音色/跨句的浏览器解码残留导致"怪声"）
      if (playAudioRef.current) { try { playAudioRef.current.pause(); } catch { /* ignore */ } }
      setVoiceReplyId(null);
      const a = new Audio(meta.url);
      a.onended = () => { setVoiceReplyId(null); };
      a.onerror = () => setVoiceReplyId(null);
      playAudioRef.current = a;
      await a.play();
      setVoiceReplyId(m.id);
      setVoiceLoading(null);
    } catch { /* 合成失败：静默，不影响聊天 */ setVoiceLoading(null); }
  };

  // 自动预加载：仅当「小愈朗读」开启，且流式/发送结束后，为最新一条 assistant 回复后台合成音频。
  // 只预载最新一条（其余历史按需点播、点一下才合成）；关闭开关=0 次调用，显著降低服务端 TTS 负载。
  // 预载期间把该消息 id 记入 voicePreloadingId → 气泡显示真实「声音准备中…」加载态（禁用点击），
  // 合成完成并注册 object URL 后就绪可播；结束时按 id 精确清除（旧请求晚到不会误清新请求的状态）。
  useEffect(() => {
    if (!voiceEnabled || streaming || sending || typing || searching || sessionLoading) return;
    const voice = activeCharVoice ?? ttsVoiceRef.current;
    const candidates = chatMessages
      .filter((m: ChatMessage) => m.role === 'assistant')
      .map((m: ChatMessage) => ({ id: m.id, text: stripMarkdown(m.content).trim() }))
      .filter((x) => x.text)
      .slice(-1);
    const target = candidates[0];
    if (!target) return;
    const { id, text } = target;
    setVoicePreloadingId(id);
    const run = (async () => {
      try {
        const blob = await getTtsAudio(id, text, voice);
        await registerTtsUrl(id, blob, text); // url+时长注册完再结束加载态，避免就绪前闪回静态入口
      } catch { /* 预加载失败：静默，气泡回到静态「点击生成语音」可重试 */ }
      finally {
        setVoicePreloadingId((prev) => (prev === id ? null : prev)); // 按 id 精确清除，旧请求晚到不误清新请求
      }
    });
    void run();
  }, [chatMessages, streaming, sending, typing, searching, sessionLoading, activeCharVoice, ttsVoice, getTtsAudio, registerTtsUrl, voiceEnabled]);

  // 组件卸载时回收小愈朗读的临时 object URL，避免内存/引用泄漏
  useEffect(() => () => {
    ttsUrlRef.current.forEach(({ url }) => { try { URL.revokeObjectURL(url); } catch { /* 忽略 */ } });
    ttsUrlRef.current.clear();
  }, []);

  // 右端「加号 / 发送」：空内容→加号（打开相册/拍照/发送位置）；有内容→发送
  /**
   * 输入栏统一提交入口（2026-09）：编辑态下「发送」= **重发**（服务端按 `editAt` 把历史回到那条之前再生成），
   * 否则就是普通新消息。这样「改完再发」在两种状态下是同一个手势（微信式：在输入框里改、按发送）。
   */
  const submitChat = () => {
    if (sending) return;
    if (editTarget) {
      const at = new Date(editTarget.timestamp).getTime();
      void handleSend(input, undefined, undefined, { editAt: Number.isFinite(at) ? at : undefined });
      return;
    }
    void handleSend();
  };
  const handlePlusOrSend = () => {
    if (sending || recording || voicePending) return;
    if (input.trim() || pendingImage) { submitChat(); return; }
    setImageMenuOpen(o => !o);
  };

  // 卸载 / 切会话时中止录音并清理提示计时器
  useEffect(() => () => {
    try { vadRef.current?.stop(); } catch { /* 忽略 */ }
    stopRecTimer();
    try { if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop(); } catch { /* 忽略 */ }
    try { mediaStreamRef.current?.getTracks().forEach((tr) => tr.stop()); } catch { /* 忽略 */ }
    if (voiceErrorTimer.current) window.clearTimeout(voiceErrorTimer.current);
    if (locMsgTimer.current) window.clearTimeout(locMsgTimer.current);
  }, []);

  const assistantCount = chatMessages.filter(m => m.role === 'assistant').length;
  const showStructureHint = assistantCount >= 2 && !hintDismissed;

  // 选择图片：压缩后暂存预览，发送时随消息一起带上
  const handlePickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await fileToCompressedDataUrl(file);
      setPendingImage(dataUrl);
    } catch { /* 忽略 */ }
  };

  // 附件菜单：选择「拍照」直开相机（移动端 capture 生效），或「从相册选择」走原 gallery 路径
  const openImageFrom = (kind: 'camera' | 'gallery') => {
    setImageMenuOpen(false);
    if (kind === 'camera') {
      cameraFileRef.current?.click();
    } else {
      fileRef.current?.click();
    }
  };

  // 发送位置（轻量方案 B）：浏览器定位 → 拼接位置文本 → 作为普通消息发出
  const showLocMsg = (msg: string) => {
    setLocMsg(msg);
    if (locMsgTimer.current) window.clearTimeout(locMsgTimer.current);
    locMsgTimer.current = window.setTimeout(() => setLocMsg(null), 4200);
  };
  const sendLocation = () => {
    if (!('geolocation' in navigator)) { showLocMsg(t('chatLocationUnsupported')); return; }
    setImageMenuOpen(false);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        const url = `https://www.google.com/maps?q=${latitude},${longitude}`;
        const text = `${t('chatLocationPrefix')}：${latitude.toFixed(6)}, ${longitude.toFixed(6)}\n${url}`;
        handleSend(text);
      },
      () => showLocMsg(t('chatLocationError')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  };

  // 点击附件菜单外 / Esc 时关闭
  useEffect(() => {
    if (!imageMenuOpen) return;
    const onDocPointer = (e: MouseEvent | TouchEvent) => {
      if (imageMenuRef.current && !imageMenuRef.current.contains(e.target as Node)) {
        setImageMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setImageMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocPointer);
    document.addEventListener('touchstart', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocPointer);
      document.removeEventListener('touchstart', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [imageMenuOpen]);

  // 点击 Emoji 面板外 / Esc 时关闭
  useEffect(() => {
    if (!emojiOpen) return;
    const onDocPointer = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      const inside = emojiWrapRef.current?.contains(target) || emojiPanelRef.current?.contains(target);
      if (inside) return;
      setEmojiOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEmojiOpen(false);
    };
    document.addEventListener('mousedown', onDocPointer);
    document.addEventListener('touchstart', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocPointer);
      document.removeEventListener('touchstart', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [emojiOpen]);

  // 打开/关闭 emoji 面板：打开时记录当前光标；移动端停靠时收起软键盘（面板占据键盘位置）
  const openEmoji = useCallback(() => {
    const el = inputRef.current;
    if (!emojiOpen) emojiCursorRef.current = el?.selectionStart ?? input.length;
    setEmojiOpen(o => !o);
    if (!emojiOpen && isMobile) {
      try { el?.blur(); } catch { /* 忽略 */ }
    }
  }, [emojiOpen, isMobile]);

  // 把选中的 emoji 插入输入框光标处（可连续点选）
  // 移动端停靠：不重新聚焦（避免挑一个就重新弹起键盘），用 emojiCursorRef 维护插入位置
  // 桌面浮层：插入后恢复光标位置并保持焦点，方便继续打字
  const insertEmoji = useCallback((emoji: string) => {
    const el = inputRef.current;
    const start = isMobile ? emojiCursorRef.current : (el?.selectionStart ?? input.length);
    const end = isMobile ? start : (el?.selectionEnd ?? input.length);
    const next = input.slice(0, start) + emoji + input.slice(end);
    setInput(next);
    if (isMobile) {
      emojiCursorRef.current = start + emoji.length;
      return;
    }
    requestAnimationFrame(() => {
      try {
        el?.setSelectionRange(start + emoji.length, start + emoji.length);
      } catch { /* 忽略 */ }
    });
    try { el?.focus(); } catch { /* 忽略 */ }
  }, [input, isMobile]);

  const handleSend = async (text?: string, imageOverride?: string, audioOverride?: string, opts?: { retry?: boolean; editAt?: number }) => {
    const isRetry = opts?.retry === true;
    const editAt = typeof opts?.editAt === 'number' && opts.editAt > 0 ? opts.editAt : undefined;
    const content = (text ?? input).trim();
    const image = imageOverride ?? pendingImage ?? undefined;
    const audio = audioOverride; // 微信式语音气泡：录音 data URL（仅展示/播放；Xiaoyu 靠 content 理解）
    /**
     * 编辑重发：被改写的那条（服务端用同一把尺子定位，时间戳 + 必须是最后一条用户消息，见
     * `api/routes/analysis.ts` 的 rewindForEdit）。定位不到就退回普通发送（绝不按猜的下标截历史）。
     */
    let editIdx = -1;
    if (editAt != null) {
      for (let i = chatMessages.length - 1; i >= 0; i--) {
        if (chatMessages[i].role !== 'user') continue;
        if (new Date(chatMessages[i].timestamp).getTime() === editAt) editIdx = i;
        break;   // 只看最后一条用户消息（2A）
      }
    }
    const editing = editIdx >= 0 ? chatMessages[editIdx] : null;
    // 引用回复：在本轮发送内先固定下来（下面会 setReplyTo(null)，闭包里的 state 不能再用）。
    // kind：被引用的是纯图片/纯语音消息（没有文字）→ 界面用占位词；at：被引用消息的时间戳 → 点引用块跳回原消息时定位。
    // 重试：改用**本地那条用户消息自带的 replyTo**（首次失败时服务端没落库，重试正是它补写的机会；
    // 若服务端已有这条待回复的用户消息，它会忽略请求里的引用，不会重复写）。
    const lastUserMsg = [...chatMessages].reverse().find(m => m.role === 'user');
    const replyToForSend = isRetry
      ? lastUserMsg?.replyTo
      // 编辑重发：沿用原来那条的引用关系（「我在回你那句」不因为改了措辞而失效）
      : editing
        ? editing.replyTo
        : (replyTo ? {
            role: replyTo.role,
            content: replyTo.content,
            ...(replyTo.image ? { kind: 'image' as const } : replyTo.audio ? { kind: 'audio' as const } : {}),
            ...(replyTo.timestamp ? { at: replyTo.timestamp } : {}),
          } : undefined);
    if ((!content && !image && !audio) || sending) return;
    setSending(true);
    setStreaming(false);
    clearRedirectHint(); // 上一条消息的分流提示卡随新一轮发送收起
    setSendFailed(''); // 新一轮开始 → 收起上一轮的失败提示
    // 跨模式桥：用户开始说自己的话了 → 「来自《…》」这条上下文标签完成使命，收起（草稿本身留在输入框/消息里）
    if (bridgeFrom) { setBridgeFrom(null); bridgeDraftRef.current = null; recordBridgeEvent('firstMessage'); }
    if (isRetry) {
      // 重试：用户那条消息已经在界面上（也存在服务端会话里），不重复插入、不动输入框
      failedTurnRef.current = null;
    } else if (editing) {
      /**
       * 编辑重发（2026-09）：本地**先截到那条之前**，再插入改写后的这条
       * 与服务端在同一个请求里做的事完全一致（`rewindForEdit`）。乐观展示失败时由下面的
       * 「回滚本地乐观展示」分支把整份 `chatMessages` 放回去，不会留下半截历史。
       */
      failedTurnRef.current = null;
      setInput('');
      setPendingImage(null);
      setEditTarget(null);
      editDraftBackupRef.current = '';
      try { inputRef.current?.blur(); } catch { /* 忽略 */ }
      const userMsg = newMsg('user', content, image, replyToForSend, audio);
      setChatMessages([...chatMessages.slice(0, editIdx), userMsg]);
      setReplyTo(null);
    } else {
      setInput('');
      setPendingImage(null); // 点击发送后立即清掉预览，图片已进聊天室
      // 发送后收起手机键盘，方便看后续回复
      try { inputRef.current?.blur(); } catch { /* 忽略 */ }
      // 本地先展示用户消息（含图片；若是引用回复则带上被引用的内容，与服务端落库的是同一份）
      const userMsg = newMsg('user', content, image, replyToForSend, audio);
      setChatMessages([...chatMessages, userMsg]);
      setReplyTo(null); // 已带入本条回复，清空引用
    }

    // 用户自己发消息 → 强制贴底（让接下来的回复跟着自己走）
    stickToBottomRef.current = true;
    setAtBottom(true);

    let full = '';
    try {
      const gen = ++sendGenRef.current; // 本次发送代号：切会话/新开/重发后旧流无条件丢弃
      const pref = getCachedPreferences(); // 当前地区语气/程度：切地区后下一句立即生效
      const ac = new AbortController();
      streamAbortRef.current = ac;
      // 🆕 自动重试（2026-09-15 事故后加）：网络断/超时这类**瞬时**失败、且一个字都没收到时，
      // 自动再 call 一次 AI；成功则用户完全无感（连失败提示都不出现），仍然失败才提示 + 让用户手动重试。
      // 判定见 src/lib/autoRetry.ts（已流出内容 / 4xx 业务错误 / 用户取消都不重试）。
      let firstFailCode = '';
      for (let attempt = 0; ; attempt++) {
      const r = await chatSendStream(chatSessionId, content, {
        onDelta: (delta) => {
          if (gen !== sendGenRef.current) return; // 已切换会话：丢弃旧会话迟到 token
          full += delta;
          setSearching(false); // 有内容输出 → 搜索结束
          let s = streamRef.current;
          if (!s) {
            // 首个 token：启动「分段发送器」，之后按段落依次放出独立气泡
            s = { full: '', sentLen: 0, ended: false, done: false, cancel: false, firstMsgId: null };
            streamRef.current = s;
            setStreaming(true);
            void runReveal(s);
          }
          s.full += delta;
        },
        onSearch: () => { if (gen === sendGenRef.current) setSearching(true); },
        signal: ac.signal,
      }, image, audio, activeCharacter?.id, pref?.region, pref?.intensity, pref ? pref.chatInnerMonologueEnabled !== false : true, pref?.thinkingLevel, isRetry || attempt > 0,
      replyToForSend, editAt);
      if (ac.signal.aborted) return; // 已切会话/新开导致中断：不往当前会话补任何内容
      if (r.success && r.data) {
        if (!chatSessionId && r.data.sessionId) setChatSessionId(r.data.sessionId);
        // 角色扮演指令分流：后端判定命中 → 展示一键直达卡片（同一代号内才认，避免切会话后串卡）
        if (r.data.hint && gen === sendGenRef.current) { setRedirectHint(r.data.hint); setRedirectHintCompact(r.data.hintCompact === true); }
        const s = streamRef.current;
        if (s) {
          // 标记流结束，等分段器把剩余段落自然发完
          s.full = full || r.data.reply;
          s.ended = true;
          await waitRevealDone();
          // 输出卫生闸改过正文（剥掉开头自言自语 / 重生成）→ 用最终正文重建本轮气泡，
          // 否则屏幕上会永久留着那段自言自语（前端优先用流式文本）。必须在 cancelStream() 之前。
          if (r.data.revised) rebuildTurnBubbles(r.data.reply);
          // 来源按段挂到对应气泡（整轮来源挂最后一条），必须赶在 cancelStream() 之前（见该函数注释）
          attachSourcesBySegment(r.data.sources, r.data.sourceSegments);
          cancelStream();
        } else {
          // 无 token 流式（极端情况）：直接补完整回复
          const fbMsg = newMsg('assistant', r.data!.reply);
          // 无分段时只有一段：段来源与整轮来源合并后一起挂
          const fbSources = mergeSources(r.data.sourceSegments?.[0] || [], r.data.sources || []);
          if (fbSources.length) fbMsg.sources = fbSources;
          addChatMessage(fbMsg);
          preloadTextAudio(fbMsg.id, r.data!.reply);
        }
        if (firstFailCode) reportAiFailure('chat', firstFailCode, true); // 自动重试救回来了（用户无感）
        break;
      } else if (r.code === 'CHAT_QUOTA_EXCEEDED' || r.code === 'QUOTA_EXCEEDED' || r.status === 402 || (r.error && (r.error.includes('聊天额度') || r.error.includes('免费次数') || r.error.includes('quota') || r.error.includes('free chats')))) {
        setQuotaMsg(t('quotaSub'));
        onNeedPay(); // 额度用完 → 统一门控（游客注册 / 已注册「获取更多额度」/ Plus 会员）
        cancelStream();
        setChatMessages(chatMessages); // 回滚本地乐观展示
        break;
      } else if (streamRef.current) {
        // 流中途失败但已有部分内容：放出已收到的段落后收尾
        const s = streamRef.current;
        s.ended = true;
        await waitRevealDone();
        cancelStream();
        reportAiFailure('chat', 'PARTIAL', false); // 半截也算「没接上」，运营端要看得到
        break;
      } else if (attempt < AUTO_RETRY_MAX && shouldAutoRetry(r, false)) {
        // 【一个字都没收到 + 瞬时失败原因 → 自动再 call 一次】
        firstFailCode = failCodeOf(r);
        console.warn('[chat] 首次失败，立即自动再 call 一次:', firstFailCode, r.status || '');
        // AUTO_RETRY_DELAY_MS 默认 0 = 不等（连接已经坏了，等再久那条连接也不会好；新请求会新建连接）
        if (AUTO_RETRY_DELAY_MS > 0) await sleep(AUTO_RETRY_DELAY_MS);
        if (ac.signal.aborted || gen !== sendGenRef.current) return; // 等待期间用户切了会话：不补内容
        continue;
      } else {
        // 🚨 失败**不再**伪装成小愈的回复（原为 `r.error || t('chatFallback')`）：
        // 一句「网络好像开小差了」不该被当成她的回答，也避免用户以为她说错话了。
        // 这里记下这一回合，界面上给「系统提示 + 重试」。
        const code = failCodeOf(r);
        console.warn('[chat] 回复失败:', code, r.status || '', r.error || '');
        reportAiFailure('chat', firstFailCode || code, false);
        failedTurnRef.current = { content, image, audio };
        setSendFailed(r.error || code || 'NETWORK');
        break;
      }
      }
    } catch {
      if (!streamRef.current) {
        reportAiFailure('chat', 'NETWORK', false);
        failedTurnRef.current = { content, image, audio };
        setSendFailed('NETWORK');
      } else {
        // 网络中断但已有部分：保留并收尾
        const s = streamRef.current;
        s.ended = true;
        await waitRevealDone();
        cancelStream();
      }
    } finally {
      streamAbortRef.current = null;
      setSending(false);
      setStreaming(false);
      setSearching(false);
      /**
       * 收尾标已读（2026-09-20 修的 bug）：流式过程中那次已读发生在**服务端把这条回复落库之前**，
       * 于是刚看过的回复会被算成未读（用户报的「有红点、进去却没有新消息」）。
       * 这里用"屏幕上最后一条消息的时间戳"作为已读上限；`done` 一定在服务端落库之后到达，
       * 所以此刻的最后一条就是那条回复本身。
       */
      if (chatSessionIdRef.current) {
        const lastTs = lastMessageTimeRef.current;
        void clearUnread(chatSessionIdRef.current, lastTs);
      }
      // 每次发完都刷新额度（免费剩余 / Plus 每日 / Pro 无限）
      getQuota().then(r => { if (r.success && r.data) setQuota(r.data); });
      // 刷新多对话列表（新对话出现 / 标题与预览更新；按当前角色过滤）
      getChatSessions().then(rr => {
        if (rr.success && Array.isArray(rr.data)) {
          const cid = activeCharacter?.id || 'xiaoyu';
          setChatSessions(rr.data.filter(s => (s.characterId || 'xiaoyu') === cid));
        }
      });
    }
  };

  /** 重试上一回合：不重复插入用户消息（`retry: true` 也让服务端不重复写库），只把这一轮再要一次 */
  const retryLastTurn = () => {
    const turn = failedTurnRef.current;
    if (!turn || sending || streaming) return;
    void handleSend(turn.content, turn.image, turn.audio, { retry: true });
  };

  // 表情包：经本站图片代理取图 → data URL → 直接作为图片消息发送（微信式：点选即发），发送后收起面板
  const sendStickerImage = useCallback(async (url: string) => {
    if (sending) return;
    try {
      const dataUrl = await urlToDataUrl('/api/stickers/img?u=' + encodeURIComponent(url));
      setEmojiOpen(false);
      await handleSend('', dataUrl);
    } catch {
      // 图片取不到：保持面板打开，让用户换一张（不打断）
    }
  }, [sending, handleSend]);

  // 新开一个对话：清空当前会话与消息，回到空态
  const handleNewChat = () => {
    cancelStream();
    setChatSessionId(null);
    setChatMessages([]);
    stickToBottomRef.current = true;
    setAtBottom(true);
    setInput('');
    setQuotaMsg(null);
    clearRedirectHint();
    setReplyTo(null);
    setHistoryOpen(false);
    try { scrollRef.current?.scrollTo({ top: 0, behavior: 'auto' }); } catch { /* 忽略 */ }
  };

  // 打开某个历史对话
  const handleOpenChat = async (sid: string) => {
    setHistoryOpen(false);
    if (sid === chatSessionId) return;
    cancelStream();
    setChatSessionId(sid);
    setChatMessages([]);
    stickToBottomRef.current = true;
    setAtBottom(true);
    setInput('');
    setQuotaMsg(null);
    clearRedirectHint();
    setReplyTo(null);
    // 先回到顶部，避免切到新会话时还停留在旧消息的中间位置（消息加载后会自动滚到底部看最新）
    try { scrollRef.current?.scrollTo({ top: 0, behavior: 'auto' }); } catch { /* 忽略 */ }
    const r = await getChatSession(sid);
    if (r.success && r.data) {
      const mapped = mapServerMessages(r.data.messages);
      setChatMessages(mapped);
      // 打开即已读：只清**这一条会话**（该角色其它会话的未读留着，不被静默吞掉），上限=最后一条
      void clearUnread(sid, lastTsOf(mapped));
    }
  };

  /**
   * 已读（方案 A2）：服务端清未读 + 本地角标归零。
   * 传 sessionId 只清这一条会话；只传 characterId 清该角色全部会话（用于进入角色窗口时）。
   */
  /**
   * 已读（方案 A2）：服务端清未读 + 本地角标归零。
   *
   * ⚠️ 2026-09-20 修正为**按会话**清（原来是按角色清全部）：
   * 一个角色可能有多条会话（「新对话」按钮），而角色主动消息只落在**最新那条**上。
   * 按角色清全部会出现"点进窗口看了一眼，另一条会话里的未读被静默吞掉、用户永远看不到"。
   * 现在：点列表某行 → 只清**会被打开的那条**；正在看的会话 → 只清**当前这条**。
   */
  const clearUnread = async (sessionId: string | null | undefined, upTo?: number) => {
    if (!sessionId) return;
    try {
      await markChatRead({ sessionId, ...(typeof upTo === 'number' && upTo > 0 ? { upTo } : {}) });
    } catch { /* 忽略：已读是体验优化，失败不该影响聊天 */ }
    /**
     * 用服务端**重算**过的列表覆盖本地：按会话清之后，行上的未读和必须由服务端算
     * （本地拍 0 会把"同一角色另一条会话还有未读"一起抹平，正是要避免的那个 bug）。
     */
    try {
      const r = await getChatInbox();
      if (r.success && Array.isArray(r.data)) setInbox(r.data);
    } catch { /* 忽略 */ }
    /**
     * 第二层（多对话抽屉）里的**会话级未读点**也要一起清：
     * 抽屉读的是 `chatSessions`（GET /chats 带 unread），它是"点进会话那一刻"拉的快照
     * 不本地同步的话，刚读完的那条会话在抽屉里仍然挂着红点（2026-09-20 复核实测到的）。
     */
    // ⚠️ `setChatSessions` 是 store 的"整份替换"动作（不吃 updater 函数），传函数会把 state 变成函数，
    // 下一帧 `.map` 直接炸（2026-09-20 端到端实测抓到）。所以先取最新值再替换。
    const curSessions = useAppStore.getState().chatSessions;
    if (Array.isArray(curSessions)) {
      setChatSessions(curSessions.map(s => (s.sessionId === sessionId ? { ...s, unread: 0 } : s)));
    }
  };

  /**
   * 消息列表里点某个角色：打开**真正有未读的那条会话**（没有未读就打开最近那条）并清它的未读。
   *
   * 为什么不是"打开最近那条"：行的角标是**跨该角色所有会话**的和，角色主动消息只落在最新一条上，
   * 但如果用户之后又开了新对话，未读就留在更旧的那条里；此时打开最近那条会出现
   * 「角标一直在、点进去什么都没变」的死结。所以服务端额外告诉我们 `unreadSessionId`。
   */
  const openFromInbox = (row: ChatInboxRow) => {
    setListOpen(false);
    const target = row.unreadSessionId || row.sessionId;
    // 已读不在这里标：此刻消息还没加载，标不了 upTo，交给下面加载完的那条路（loadSessionsFor / handleOpenChat）
    const c = characters.find(x => x.id === row.characterId);
    if (c) switchCharacter(c, target || null);
    else if (target) void loadSessionsFor(row.characterId, target);
  };

  /**
   * 「我正在看这条会话」→ 标已读（方案 A2）。
   *
   * 为什么放在这里而不是让 GET /chats/:id 顺手标：聊一聊挂载时就会先 GET 最近一条会话，
   * 若由 GET 标已读，未读角标会在用户看到列表之前就被抹掉（端到端实测抓到的坑）。
   *
   * ⚠️ 那为什么**挂载后第一次加载也不算已读**：第一版写成「有消息 + 列表没开 → 标已读」，
   * 于是自动加载最近会话这一下就把那个角色的未读清掉了（真机实测非确定性复现：角标有时在、有时空）。
   * 现在的判据是**消息条数相对挂载时发生变化**（= 用户自己发了/收到了，确实在跟这条会话互动）
   * 单纯"被程序铺在界面后面"不算读过。清除未读的另外两条路是显式动作：点列表某一行、从抽屉打开某条会话。
   */
  const mountMsgCountRef = useRef<number | null>(null);
  /** 挂载那一刻是否停在消息列表（挂载 effect 里判断"要不要顺手把上一条会话铺上屏"） */
  const listOpenAtMount = useRef(listOpen);
  /** 供"发送收尾标已读"读最新值（避免闭包里拿到旧的 sessionId / 旧的消息时间） */
  const chatSessionIdRef = useRef<string | null>(null);
  const lastMessageTimeRef = useRef<number | undefined>(undefined);
  useEffect(() => { chatSessionIdRef.current = chatSessionId; }, [chatSessionId]);
  // 会话消息进程内缓存（见 openSession 的说明）
  useEffect(() => {
    if (!chatSessionId || chatMessages.length === 0 || listOpen) return;
    sessionMsgCache.set(chatSessionId, chatMessages);
    if (sessionMsgCache.size > 6) {
      const oldest = sessionMsgCache.keys().next().value;
      if (oldest && oldest !== chatSessionId) sessionMsgCache.delete(oldest);
    }
  }, [chatSessionId, chatMessages, listOpen]);
  useEffect(() => {
    const last = chatMessages[chatMessages.length - 1];
    const raw = last?.timestamp as unknown;
    const t = raw instanceof Date ? raw.getTime() : (typeof raw === 'string' ? new Date(raw).getTime() : NaN);
    if (Number.isFinite(t)) lastMessageTimeRef.current = t;
  }, [chatMessages]);
  useEffect(() => {
    if (mountMsgCountRef.current === null) { mountMsgCountRef.current = chatMessages.length; return; }
    if (listOpen || !activeCharacter || !chatSessionId) return;
    if (chatMessages.length === mountMsgCountRef.current) return;
    void clearUnread(chatSessionId, lastMessageTimeRef.current);
  }, [activeCharacter, chatSessionId, chatMessages.length, listOpen]);

  /**
   * 【手机返回键 / 页面 ← 的层级（2026-09-20 用户口径：「返回键要能返回上一级而不是退到首页」）】
   *
   * 与剧情模式（`rpDeepBack` + `RoleplayPage`）同一套做法，三条规矩一条都不能少：
   *  ① **每进一层压一条自己的历史条目**（`xiaoyuChat`）。实测教训（2026-09-19 剧情模式首轮验证）：
   *     历史里只有 Home 那条模块条目时，返回键**只有第一次**是同文档回退，第二次就跨文档离开站点。
   *  ② **注册返回处理器**（`pushDeepBackHandler`）：Home 的 popstate 会先问这里，
   *     本层（弹层 / 对话层）能消费就返回 true，消费不了才让 Home 关掉整个聊一聊。
   *  ③ **页内 ← 与手机返回键走同一条路**（`history.back()`），否则两条路迟早漂移。
   */
  const entryHasChatLevel = (): boolean => {
    try {
      const st = window.history.state as { xiaoyuChat?: unknown } | null;
      return !!st && typeof st.xiaoyuChat === 'number';
    } catch { return false; }
  };
  useEffect(() => {
    if (listOpen) return; // 列表层不需要额外条目（Home 那条模块条目就是它的）
    if (entryHasChatLevel()) return;
    try {
      window.history.pushState(
        { ...(window.history.state || {}), xiaoyuChat: 1 },
        '',
        window.location.pathname + window.location.search,
      );
    } catch { /* 忽略 */ }
  }, [listOpen]);
  // 返回层级：弹层（先关最上面那个）→ 对话层（回消息列表）→ 交给 Home 关模块
  const backRef = useRef<{ list: boolean; overlays: string[] }>({ list: true, overlays: [] });
  useEffect(() => {
    const open: string[] = [];
    if (charMenuOpen) open.push('charMenu');
    if (historyOpen) open.push('history');
    if (storyOpen) open.push('story');
    if (growthOpen) open.push('growth');
    if (companionStyleOpen) open.push('companion');
    backRef.current = { list: listOpen, overlays: open };
  });
  useEffect(() => pushDeepBackHandler(() => {
    const { list, overlays } = backRef.current;
    const close = (fn: () => void) => { fn(); return true; };
    // 弹层自己不算一层历史条目 → 关掉之后要把本层条目补回去（否则下一层会被提前吃掉）
    const reopenEntry = () => {
      if (!list) {
        try {
          window.history.pushState({ ...(window.history.state || {}), xiaoyuChat: 1 }, '', window.location.pathname + window.location.search);
        } catch { /* 忽略 */ }
      }
    };
    const top = overlays[overlays.length - 1];
    if (top === 'charMenu') return close(() => { setCharMenuOpen(false); reopenEntry(); });
    if (top === 'history') return close(() => { setHistoryOpen(false); reopenEntry(); });
    if (top === 'story') return close(() => { setStoryOpen(false); reopenEntry(); });
    if (top === 'growth') return close(() => { setGrowthOpen(false); reopenEntry(); });
    if (top === 'companion') return close(() => { setCompanionStyleOpen(false); reopenEntry(); });
    if (!list) { setListOpen(true); return true; } // 对话层 → 回消息列表（本条历史已被这次返回消费）
    return false; // 列表层 → 让 Home 按原逻辑关掉聊一聊
  }), []);

  /** 屏幕上最后一条消息的时间戳（= 这次已读能推进到的上限；拿不到就不带 upTo） */
  const lastTsOf = (msgs: ChatMessage[]): number | undefined => {
    const raw = msgs[msgs.length - 1]?.timestamp as unknown;
    const t = raw instanceof Date ? raw.getTime() : (typeof raw === 'string' ? new Date(raw).getTime() : NaN);
    return Number.isFinite(t) ? t : undefined;
  };

  /** 页内「上一层」统一入口：有本层条目就交给浏览器后退（与手机返回键同一条路），否则直接改状态 */
  const chatGoUp = () => {
    if (entryHasChatLevel()) { try { window.history.back(); return; } catch { /* 落到直接改状态 */ } }
    setListOpen(true);
  };
  /** 列表层左上角 ←：有模块条目就交回浏览器（Home 的 popstate 关模块），否则直接 onBack */
  const chatExit = () => {
    try {
      const st = window.history.state as { xiaoyuView?: unknown } | null;
      if (st && st.xiaoyuView === 'chat') { window.history.back(); return; }
    } catch { /* 落到直接 onBack */ }
    onBack();
  };

  // 复制专属邀请链接：每邀请 1 人注册得邀请奖励（数值取配置）
  const copyInvite = () => {
    // 埋点：控制台要能看出「复制过邀请链接」的人（失败静默，见 trackInviteCopy）
    try { navigator.clipboard.writeText(getInviteLink()); void trackInviteCopy(); setInviteCopied(true); setTimeout(() => setInviteCopied(false), 1500); } catch { /* 忽略 */ }
  };

  // 【消息操作：长按（移动端）/ 悬停 ⋯（桌面）/ 右键 打开 回复·复制 菜单】
  /**
   * 点引用块 → 跳回被引用的那条消息并闪一下。
   * 定位走 findQuotedMessage（内容/时间戳/前缀三级匹配，id 会随刷新而变不能用作依据）；
   * 找不到就静默不动（老会话没存定位信息、或那条消息已被清掉），绝不乱跳。
   * 动效：滚动与高亮都尊重 prefers-reduced-motion（减弱动效下直接定位 + 保留静态描边环）。
   */
  const jumpToQuotedMessage = (m: ChatMessage) => {
    const target = findQuotedMessage(chatMessages, m.replyTo);
    if (!target) return;
    const el = document.getElementById('msg-' + target.id);
    if (!el) return;
    let reduce = false;
    try { reduce = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { /* 忽略 */ }
    try { el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' }); } catch { el.scrollIntoView(); }
    setFlashMsgId(target.id);
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashMsgId(cur => (cur === target.id ? null : cur)), 1500);
  };
  /**
   * 消息操作：**回复 / 编辑 / 复制 = 常显图标按钮**（2026-09 用户口径：「像这种都可以直接拿出来而不是放在
   * ⋯ 里，拿出来也不用加名字，可以直接放图标」）。
   *
   * 为什么把弹层整条路拿走（连长按 / 右键一起）：这三个动作就是一条消息上的全部操作，弹层里**再没有别的项**
   * 留着只会多一条"得先点开才知道有什么"的路径，还得同时维护定位、背板、关闭三件事。顺带消失的还有
   * 长按的副作用（长按选不中文字）。可发现性与无障碍靠 `aria-label` + `title`：图标不写字，但必须能被读出来、
   * 能悬停看名字（图标按钮的通用要求，别为了"简洁"把这两个也删了）。
   */
  /** 图标按钮统一口径（沿用常显 ⋯ 那套视觉：白底 + 浅描边 + 圆形，触控区约 38px） */
  const iconBtnCls = 'inline-flex items-center justify-center text-ink-soft hover:text-primary-text bg-white/80 border border-clay-border rounded-full p-1.5 shadow-sm transition-colors';
  /** 引用回复：与编辑态互斥（两个提示条会打架），点开一个就收掉另一个 */
  const replyToMessage = (m: ChatMessage) => {
    if (editTarget) cancelEditMessage();
    setReplyTo(m);
    setTimeout(() => { try { inputRef.current?.focus(); } catch { /* 忽略 */ } }, 0);
  };
  // 复制：统一走 src/lib/clipboard.ts（Clipboard API 优先 + execCommand 兜底，失败不静默）
  const copyMessage = async (m: ChatMessage) => {
    const ok = await copyText(m.content);
    if (ok) {
      setCopiedToast(true);
      setTimeout(() => setCopiedToast(false), 1500);
    }
  };
  /**
   * 这条消息能不能「编辑重发」（2A：只有**最后一条用户消息**，且是纯文字）。
   * 带图/语音的不开放：改写后要连附件一起重发，而附件是「这一轮新发的」语义，跟"改一句话"不是一回事。
   */
  const canEditMessage = (m: ChatMessage): boolean => {
    if (m.role !== 'user' || !m.content.trim() || m.image || m.audio) return false;
    const lastUser = [...chatMessages].reverse().find(x => x.role === 'user');
    return !!lastUser && lastUser.id === m.id;
  };
  /** 进入编辑态：原文填回输入栏，并备份用户本来在写的草稿（取消要还回去）；再点一次同一个图标 = 取消 */
  const editMessage = (m: ChatMessage) => {
    if (!canEditMessage(m)) return;
    if (editTarget?.id === m.id) { cancelEditMessage(); return; }
    editDraftBackupRef.current = input;
    setEditTarget(m);
    setReplyTo(null);
    setInput(m.content);
    setTimeout(() => { try { inputRef.current?.focus(); } catch { /* 忽略 */ } }, 0);
  };
  const cancelEditMessage = () => {
    if (!editTarget) return;
    setEditTarget(null);
    setInput(editDraftBackupRef.current);   // 还回进编辑态前的草稿
    editDraftBackupRef.current = '';
  };
  /** 切会话/新开对话时退出编辑态：editTarget 是**另一段对话**里的消息对象，留着会把改写发到新会话上 */
  useEffect(() => {
    setEditTarget(null);
    editDraftBackupRef.current = '';
  }, [chatSessionId]);

  // 删除某个历史对话（当前对话被删则回到新对话）
  const handleDeleteChat = async (sid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(t('chatDeleteConfirm'))) return;
    const r = await deleteChatSession(sid);
    if (r.success) {
      setChatSessions(chatSessions.filter(c => c.sessionId !== sid));
      if (sid === chatSessionId) handleNewChat();
    }
  };

  // 保存对话重命名
  const handleRenameSave = async (sid: string) => {
    const title = renameText.trim();
    setRenamingId(null);
    if (!title) return;
    if (title === (chatSessions.find(c => c.sessionId === sid)?.title || '')) return;
    const r = await renameChatSession(sid, title);
    if (r.success) {
      setChatSessions(chatSessions.map(c => c.sessionId === sid ? { ...c, title } : c));
    }
  };

  // 会话列表排序：置顶在前，其余按最近更新倒序（与后端 /chats 排序一致）
  const sortChats = (list: ChatSessionMeta[]) =>
    [...list].sort(
      (a, b) => Number(!!b.pinned) - Number(!!a.pinned) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

  // 置顶 / 取消置顶某个历史对话（乐观更新：点击立即反馈；失败回滚并提示，避免「点了没反应」）
  const handleTogglePin = async (c: ChatSessionMeta, e: React.MouseEvent) => {
    e.stopPropagation();
    const pinned = !c.pinned;
    const prev = chatSessions;
    setChatSessions(sortChats(prev.map(x => x.sessionId === c.sessionId ? { ...x, pinned } : x)));
    const r = await pinChatSession(c.sessionId, pinned);
    if (!r.success) {
      setChatSessions(sortChats(prev)); // 失败回滚
      try { window.alert(t('chatPinFail') + (r.error ? '：' + r.error : '')); } catch { /* 弹窗被拦则静默 */ }
    }
  };

  const starters = [t('chatStarter1'), t('chatStarter2'), t('chatStarter3')];

  // 反馈上下文：带上最近一段对话，供用户选择是否附上
  const chatContext = chatMessages.slice(-8).map(m => (m.role === 'user' ? (getLang() === 'en' ? 'Me: ' : '我：') : (getLang() === 'en' ? activeName + ': ' : activeName + '：')) + m.content).join('\n');

  // 额度/会员说明（原输入栏下方小字，现移到顶栏下方，避免挤压底部输入栏）
  const quotaCaption = !quota
    ? t('chatSub')
    : quota.creditEnabled
      // 无限档（Pro / 终身 / 7 天体验）：显示「无限畅聊」。⚠️ 绝不能把 quotaChatRemain() 的
      // Infinity 直接插进 {n}，线上就是这样印出英文「額度剩餘 ≈ 還能聊 Infinity 條」的。
      ? (quotaIsUnlimited(quota)
        ? t('chatQuotaPro')
        : (!isLoggedIn()
          // 游客条（2026-09-27 分档）：与首页会员条**逐字一致**，必须同时给出「游客 N 条 / 注册后 M 条」
          ? (guestQuotaLineText(t, quota, null, quotaChatRemain(quota)) ?? t('chatQuotaCredit', { n: quotaChatRemain(quota) }))
          : t('chatQuotaCredit', { n: quotaChatRemain(quota) })))
      : quota.plan === 'pro'
        ? t('chatQuotaPro')
        : quota.plan === 'plus'
          ? t('chatQuotaPlus', { n: Math.max(0, (quota.chatLimitPerDay ?? 0) - (quota.chatUsedToday ?? 0)), limit: quota.chatLimitPerDay ?? 0 })
          : !isLoggedIn()
            // 注册奖励是限时活动：活动期外 registerChatBonus=0 → 绝不能印「注册立得 0 条」（同 Home 额度条，2026-09-25）
            ? quota.registerProPromoActive && (quota.registerProDays ?? 0) > 0
              ? t('chatQuotaFreeRegPro', { n: quota.chatFreeRemain ?? 0, days: quota.registerProDays ?? 0 })
              : (quota.registerChatBonus ?? 0) > 0
                ? t('chatQuotaFreeReg', { n: quota.chatFreeRemain ?? 0, b: quota.registerChatBonus ?? 0 })
                : t('remainingNoBonus', { n: quota.chatFreeRemain ?? 0 })
            : t('chatQuotaFree', { n: quota.chatFreeRemain ?? 0 });

  return (
    <div
      className={
        IS_ANDROID
          ? "inset-x-0 top-0 flex flex-col w-full max-w-2xl mx-auto bg-transparent overflow-hidden overscroll-none"
          : "fixed inset-x-0 top-0 flex flex-col w-full max-w-2xl mx-auto bg-transparent overflow-hidden overscroll-none"
      }
      style={
        IS_ANDROID
          ? {
              position: 'absolute',
              bottom: kbOffset > 0 ? kbOffset + 'px' : 0,
              paddingBottom: (kbOffset > 0 || keyboardUp) ? undefined : (privacyBannerH || undefined),
            }
          : { height: vvHeight ? vvHeight + 'px' : '100dvh', top: vvOffsetTop ? vvOffsetTop + 'px' : undefined, paddingBottom: keyboardUp ? undefined : (privacyBannerH || undefined) }
      }
    >
      {children}
      {structureOpen && (
        <div className="fixed inset-0 z-[96] bg-white flex flex-col h-[100dvh]">
          <div className="flex items-center justify-between px-3 sm:px-4 py-3 border-b border-gray-100 flex-shrink-0 bg-white/95 backdrop-blur">
            <button onClick={closeStructure} aria-label={t('backHome')} title={t('backHome')} className="flex items-center gap-1 text-sm text-ink-soft hover:text-gray-700 transition-colors p-2 -ml-2 min-h-[44px] min-w-[48px]">
              <ArrowLeft className="w-5 h-5" />
              <span className="hidden sm:inline">{t('chatToStructureBack')}</span>
            </button>
            <div className="text-center min-w-0">
              <p className="font-semibold text-gray-800 text-sm leading-tight">{t('chatToStructure')}</p>
              {activeCharacter && activeCharacter.id !== 'xiaoyu' && (
                <p className="text-[11px] text-ink-soft leading-tight">和「{activeName}」一起理一理</p>
              )}
            </div>
            <button
              onClick={() => setCompanionStyleOpen(true)}
              aria-label={t('companionStyleTitle', { name: charDisplayName })}
              title={t('companionStyleTitle', { name: charDisplayName })}
              className="w-10 flex-shrink-0 flex items-center justify-center text-ink-soft hover:text-primary-text transition-colors"
            >
              <SlidersHorizontal className="w-[18px] h-[18px]" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto overscroll-none">
            <PageTourBanner page="structure" />
            <EntryRegionNudge name={charDisplayName} />
            <div className="container mx-auto px-4 py-6">
              {currentStep === 'input' && <EmotionInput />}
              {currentStep === 'analysis' && (
                <Suspense fallback={<div className="py-10 text-center"><div className="mx-auto w-7 h-7 rounded-full border-2 border-primary/30 border-t-primary animate-spin" /></div>}><AnalysisResult /></Suspense>
              )}
              {currentStep === 'questions' && (
                <Suspense fallback={<div className="py-10 text-center"><div className="mx-auto w-7 h-7 rounded-full border-2 border-primary/30 border-t-primary animate-spin" /></div>}><QuestionInteraction /></Suspense>
              )}
              {currentStep === 'detailed' && (
                <Suspense fallback={<div className="py-10 text-center"><div className="mx-auto w-7 h-7 rounded-full border-2 border-primary/30 border-t-primary animate-spin" /></div>}><DetailedAnalysis onExitStructure={closeStructure} /></Suspense>
              )}
              {currentStep === 'story' && (
                <Suspense fallback={<div className="py-10 text-center"><div className="mx-auto w-7 h-7 rounded-full border-2 border-primary/30 border-t-primary animate-spin" /></div>}><HealingStory onExitStructure={closeStructure} /></Suspense>
              )}
            </div>
          </div>
        </div>
      )}
      {/* 气泡导航按层出：列表层（进来先看到它）与对话层各一套，见上面的说明；key 让换层时序号回到 0 */}
      {listOpen && !coachListSeen && (
        <FeatureCoachmarks
          key="coach-list"
          steps={listCoachSteps}
          onDone={markCoachListSeen}
          onSkip={skipAllCoach}
        />
      )}
      {!listOpen && !coachConvSeen && (
        <FeatureCoachmarks
          key="coach-conv"
          steps={convCoachSteps}
          onDone={markCoachConvSeen}
          onSkip={skipAllCoach}
        />
      )}
      <StoryShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        title={t('chatShareTitle')}
        partnerName={activeName || t('appName')}
        titleNameKey="chatShareTitleWithName"
        bubbles={chatMessages.map((m): StoryBubble => ({
          side: m.role === 'user' ? 'me' : 'them',
          name: m.role === 'user' ? t('chatShareMe') : activeName,
          content: m.role === 'assistant' ? stripMarkdown(m.content) : m.content,
          image: m.image,
          // 引用回复也带进分享卡（长图/复制文字）：与聊天里的引用卡同款观感、同一套收口（quoteText）
          quote: m.replyTo ? { name: m.replyTo.role === 'assistant' ? activeName : t('chatShareMe'), text: quoteText(m.replyTo, 42) } : undefined,
        }))}
      />

      {/* 自定义角色编辑器（新建/编辑） */}
      {charEditorOpen && (
        <Modal
          onClose={() => setCharEditorOpen(false)}
          showClose={false}
          overlayClassName="z-[90] flex items-end sm:items-center justify-center p-0 sm:p-6 bg-black/40"
          width="max-w-lg" radius="rounded-t-2xl sm:rounded-2xl" maxHeight="max-h-[85vh]" overflow="" layout="flex"
          panelClassName="border border-gray-100"
        >
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 flex-shrink-0">
                <p className="font-semibold text-gray-800">{editingChar ? editingChar.name : t('chatCharTitle')}</p>
                <button onClick={() => setCharEditorOpen(false)} aria-label={t('prefsDone')} className="p-2 -mr-2 text-ink-soft hover:text-gray-600 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                <label className="block">
                  <span className="text-[12px] font-medium text-ink-soft">{t('chatCharAvatar')}</span>
                  <div className="mt-1 flex items-center gap-3">
                    <img src={charAvatar || '/skins/healing/companion.webp?v=3'} alt="" className="w-14 h-14 rounded-full object-cover border border-gray-200 shrink-0" />
                    <div className="flex flex-col gap-1">
                      <label className="text-sm text-primary-text cursor-pointer">
                        {t('chatCharUploadAvatar')}
                        <input ref={charAvatarRef} type="file" accept="image/*" className="hidden" onChange={pickAvatar} />
                      </label>
                      {charAvatar && (
                        <button type="button" onClick={() => setCharAvatar('')} className="text-[12px] text-ink-soft hover:text-red-500 text-left">{t('chatCharRemoveAvatar')}</button>
                      )}
                    </div>
                  </div>
                </label>
                <label className="block">
                  <span className="text-[12px] font-medium text-ink-soft">{t('chatCharName')}</span>
                  <input value={charForm.name} onChange={e => setCharForm({ ...charForm, name: e.target.value })} maxLength={40} className="mt-1 w-full text-sm px-3 py-2 rounded-lg border border-gray-200 outline-none focus:border-primary" />
                </label>
                <label className="block">
                  <span className="text-[12px] font-medium text-ink-soft">{t('chatCharIdentity')}</span>
                  <textarea value={charForm.identity} onChange={e => setCharForm({ ...charForm, identity: e.target.value })} rows={3} maxLength={2000} className="mt-1 w-full text-sm px-3 py-2 rounded-lg border border-gray-200 outline-none focus:border-primary resize-none" />
                </label>
                <label className="block">
                  <span className="text-[12px] font-medium text-ink-soft">{t('chatCharBoundaries')}</span>
                  <textarea value={charForm.boundaries} onChange={e => setCharForm({ ...charForm, boundaries: e.target.value })} rows={2} maxLength={2000} className="mt-1 w-full text-sm px-3 py-2 rounded-lg border border-gray-200 outline-none focus:border-primary resize-none" />
                </label>
                <label className="block">
                  <span className="text-[12px] font-medium text-ink-soft">{t('chatCharVoice')}</span>
                  <textarea value={charForm.voice} onChange={e => setCharForm({ ...charForm, voice: e.target.value })} rows={2} maxLength={2000} className="mt-1 w-full text-sm px-3 py-2 rounded-lg border border-gray-200 outline-none focus:border-primary resize-none" />
                </label>
                <div className="block">
                  <span className="text-[12px] font-medium text-ink-soft">角色声音（不设则跟随默认）</span>
                  <div className="mt-1 p-2.5 rounded-lg border border-gray-200 bg-white/70">
                    <VoiceConfigPicker
                      value={((): VoiceConfig => { try { return charForm.ttsVoice ? { ...DEFAULT_VOICE_CONFIG, ...JSON.parse(charForm.ttsVoice) } : DEFAULT_VOICE_CONFIG; } catch { return DEFAULT_VOICE_CONFIG; } })()}
                      onChange={cfg => setCharForm({ ...charForm, ttsVoice: JSON.stringify(cfg) })}
                      lang={getLang()}
                      region={userRegion}
                    />
                  </div>
                </div>
                <label className="block">
                  <span className="text-[12px] font-medium text-ink-soft">{t('chatCharOpening')}</span>
                  <textarea value={charForm.opening} onChange={e => setCharForm({ ...charForm, opening: e.target.value })} rows={2} maxLength={2000} className="mt-1 w-full text-sm px-3 py-2 rounded-lg border border-gray-200 outline-none focus:border-primary resize-none" />
                </label>
              </div>
              {charError && <p className="px-4 pb-2 text-[12px] text-red-500">{charError}</p>}
              <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-100 flex-shrink-0">
                <button onClick={() => setCharEditorOpen(false)} className="flex-1 text-sm font-medium text-ink-soft bg-gray-100 rounded-full py-2.5 hover:bg-gray-200 transition-all">{t('chatCharCancel')}</button>
                <button onClick={saveChar} disabled={charSaving} className="flex-1 text-sm font-medium text-white bg-primary rounded-full py-2.5 hover:bg-primary-strong transition-all disabled:opacity-60">{charSaving ? '…' : t('chatCharSave')}</button>
              </div>
        </Modal>
      )}

      {/* 观景窗：只读查看角色成长档案（关系/反思/日记/自画像） */}
      {growthOpen && (
        <Modal
          onClose={() => setGrowthOpen(false)}
          showClose={false}
          overlayClassName="z-[90] flex items-end sm:items-center justify-center p-0 sm:p-6 bg-black/40"
          width="max-w-lg" radius="rounded-t-2xl sm:rounded-2xl" maxHeight="max-h-[85vh]" overflow="" layout="flex"
          panelClassName="border border-gray-100"
        >
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 flex-shrink-0">
                <p className="font-semibold text-gray-800">{growthCharName} · {t('chatGrowth')}</p>
                <button onClick={() => setGrowthOpen(false)} aria-label={t('prefsDone')} className="p-2 -mr-2 text-ink-soft hover:text-gray-600 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                <p className="text-[12px] leading-relaxed text-ink-soft bg-primary-lighter border border-clay-border rounded-lg px-3 py-2">{t('chatGrowthIntro')}</p>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-ink-soft">{t('chatGrowthNewestFirst')}</p>
                  <button
                    type="button"
                    onClick={() => {
                      const keys = ['userFacts', 'selfPortrait', 'diary', 'reflections', 'relationship'];
                      const anyOpen = keys.some(k => growthOpenSec[k]);
                      setGrowthOpenSec(anyOpen ? {} : Object.fromEntries(keys.map(k => [k, true])));
                    }}
                    className="text-[11px] text-primary-text hover:underline flex-shrink-0"
                  >
                    {['userFacts', 'selfPortrait', 'diary', 'reflections', 'relationship'].some(k => growthOpenSec[k]) ? t('chatGrowthCollapseAll') : t('chatGrowthExpandAll')}
                  </button>
                </div>
                {!growthView ? (
                  <p className="text-[13px] text-ink-soft text-center py-10">…</p>
                ) : (
                  <>
                    <GrowthSection
                      title={t('chatGrowthFacts')}
                      entries={(growthView.userFactEntries && growthView.userFactEntries.length
                        ? growthView.userFactEntries
                        : (growthView.userFacts || []).map(text => ({ text, at: 0, kind: 'durable' }))
                      ).map(e => (e.at ? { text: e.text, meta: memoryWhenText(e) } : { text: e.text }))}
                      open={!!growthOpenSec['userFacts']}
                      onToggle={() => setGrowthOpenSec(s => ({ ...s, userFacts: !s.userFacts }))}
                      onDelete={handleDeleteGrowthFact}
                    />
                    <GrowthSection title={t('chatGrowthPortrait')} entries={growthView.selfPortrait ? [{ text: growthView.selfPortrait.text, meta: growthWhenText(growthView.selfPortrait.at, 'portrait') }] : []} open={!!growthOpenSec['selfPortrait']} onToggle={() => setGrowthOpenSec(s => ({ ...s, selfPortrait: !s.selfPortrait }))} />
                    <GrowthSection title={t('chatGrowthDiary')} entries={[...growthView.diary].sort((a, b) => b.at - a.at).map(d => ({ text: d.text, meta: growthWhenText(d.at, 'diary') }))} open={!!growthOpenSec['diary']} onToggle={() => setGrowthOpenSec(s => ({ ...s, diary: !s.diary }))} />
                    <GrowthSection title={t('chatGrowthReflect')} entries={[...growthView.reflections].sort((a, b) => b.at - a.at).map(r => ({ text: r.text, meta: growthWhenText(r.at, 'reflection') }))} open={!!growthOpenSec['reflections']} onToggle={() => setGrowthOpenSec(s => ({ ...s, reflections: !s.reflections }))} />
                    <GrowthSection title={t('chatGrowthRelation')} entries={[...growthView.relationship].sort((a, b) => b.at - a.at).map(r => ({ text: r.text, meta: growthWhenText(r.at, 'relationship') }))} open={!!growthOpenSec['relationship']} onToggle={() => setGrowthOpenSec(s => ({ ...s, relationship: !s.relationship }))} />
                    {growthView.relationship.length === 0 && growthView.diary.length === 0 && growthView.reflections.length === 0 && !growthView.selfPortrait && !(growthView.userFacts && growthView.userFacts.length > 0) && (
                      <p className="text-[13px] text-ink-soft text-center py-10">{t('chatGrowthEmpty')}</p>
                    )}
                  </>
                )}
              </div>
        </Modal>
      )}

      {/*
        消息列表 = 聊一聊的**第一层首页**（2026-09-20 用户口径「要做成首页」）：
        整屏白底、无遮罩、无关闭按钮，进来先看到"谁给我发了消息"，点一行才进对话。
        退出的方式是它自己的 ←（= 离开聊一聊回 App 主界面），与对话窗口里那支 ←（回列表）分工不同。
      */}
      {listOpen && (
        <div className="fixed inset-0 z-[75]">
          <div className="absolute inset-0 bg-white flex flex-col" data-testid="chat-inbox">
            <div className="flex items-center gap-1 px-3 py-3 border-b border-clay-border/70 flex-shrink-0">
              <button
                onClick={chatExit}
                aria-label={t('backHome')}
                title={t('backHome')}
                data-testid="chat-exit"
                className="w-[34px] h-[34px] -ml-1.5 rounded-full flex items-center justify-center text-ink-soft hover:text-ink hover:bg-clay-muted active:scale-[0.96] transition-[color,background-color,transform] duration-150"
              >
                <ArrowLeft className="w-[18px] h-[18px]" />
              </button>
              <p className="font-semibold text-[15px] text-ink flex-1">{t('chatInboxTitle')}</p>
            </div>
            <div className="flex-1 overflow-y-auto px-3 pb-6">
              {charsLoading && characters.length === 0 ? (
                /* 加载中：给骨架行，别让用户把「还在加载」误读成「这里什么都没有」（2026-09-25） */
                <div ref={inboxFirstRowRef} className="rounded-2xl border border-clay-border bg-white overflow-hidden divide-y divide-clay-border/60" aria-busy="true" data-testid="chat-inbox-loading">
                  {[0, 1].map((i) => (
                    <div key={i} className="flex items-center gap-3 px-3.5 py-3 animate-pulse">
                      <div className="w-11 h-11 rounded-full bg-clay-muted flex-shrink-0" />
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="h-3 w-20 rounded bg-clay-muted" />
                        <div className="h-3 w-40 rounded bg-clay-muted/70" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : charsFailed && characters.length === 0 ? (
                /* 加载失败 ≠ 没有角色：明确告知 + 一键重试（原来这两种情况共用同一个空态，失败后只能刷新页面） */
                <div ref={inboxFirstRowRef} className="text-center pt-16 pb-4" data-testid="chat-inbox-error">
                  <div className="mx-auto w-14 h-14 rounded-full bg-clay-muted flex items-center justify-center">
                    <RefreshCw className="w-6 h-6 text-ink-soft/70" />
                  </div>
                  <p className="mt-3 text-sm font-medium text-ink">{t('errLoad')}</p>
                  <button
                    type="button"
                    data-testid="chat-inbox-retry"
                    onClick={() => { void loadCharacters(); }}
                    className="mt-3 text-primary-text bg-white border border-clay-border rounded-full px-4 py-2 text-sm hover:bg-primary-lighter transition-all"
                  >
                    {t('sendRetry')}
                  </button>
                </div>
              ) : characters.length === 0 ? (
                // 空态时列表层气泡的锚点退到这里（没有行可指）
                <div ref={inboxFirstRowRef} className="text-center pt-16 pb-4">
                  <div className="mx-auto w-14 h-14 rounded-full bg-clay-muted flex items-center justify-center">
                    <MessageSquare className="w-6 h-6 text-ink-soft/70" />
                  </div>
                  <p className="mt-3 text-sm font-medium text-ink">{t('chatInboxNoChat')}</p>
                  <p className="mt-1 text-[12px] text-ink-soft">{t('chatHistoryEmpty')}</p>
                </div>
              ) : (
                /* 一行一个角色 = 一封来信：整块卡片 + 发丝分隔（结构用描边、不用投影，见 better-ui） */
                <div className="rounded-2xl border border-clay-border bg-white overflow-hidden divide-y divide-clay-border/60" data-testid="chat-inbox-list">
                  {characters.map((c, idx) => {
                    const row = inbox.find(r => r.characterId === c.id);
                    const unread = row?.unread || 0;
                    const isActive = c.id === activeCharacter?.id;
                    return (
                      <div
                        key={c.id}
                        ref={idx === 0 ? inboxFirstRowRef : undefined}
                        onClick={() => openFromInbox(row || { characterId: c.id, sessionId: '', title: '', preview: '', lastRole: 'assistant', updatedAt: 0, unread: 0, pinned: false, messageCount: 0, unreadSessionId: '' })}
                        className={'relative flex items-center gap-3 px-3.5 py-3 cursor-pointer transition-colors duration-150 ' + (isActive ? 'bg-primary-lighter/60' : 'hover:bg-clay-muted/35 active:bg-clay-muted/60')}
                        data-testid={`chat-inbox-row-${c.id}`}
                      >
                        {/* 当前角色：一条 3px 品牌色细带，比整行填色轻，且不抢未读的数字 */}
                        {isActive && <span aria-hidden className="absolute left-0 top-3 bottom-3 w-[3px] rounded-r-full bg-primary" />}
                        <div className="relative flex-shrink-0">
                          {/* 图片描边用 1px 低透明纯黑（better-ui 的 image-outline 配方）：比"灰边"干净，不吸底色 */}
                          <img src={avatarFor(c)} alt={displayNameForCharacter(c)} className="w-11 h-11 rounded-full object-cover bg-white mix-blend-multiply outline outline-1 -outline-offset-1 outline-black/5" />
                          {/* 未读数字角标：有 1 条就显示 1（用户原话）；用品牌色而非报警红，白环让它在头像上"浮"起来 */}
                          {unread > 0 && (
                            <span
                              data-testid={`chat-inbox-badge-${c.id}`}
                              className="absolute -top-1 -right-1 min-w-[19px] h-[19px] px-1 rounded-full bg-primary text-white text-[11px] leading-[19px] text-center font-semibold tabular-nums ring-2 ring-white"
                            >
                              {unread > 99 ? '99+' : unread}
                            </span>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          {/* 时间提到与名字同一行（微信/iMessage 的读法）：扫列表时先读"谁+什么时候" */}
                          <div className="flex items-baseline gap-1.5">
                            <p className={'truncate text-[15px] leading-tight text-ink ' + (unread > 0 ? 'font-semibold' : 'font-medium')}>{displayNameForCharacter(c)}</p>
                            {c.origin === 'story' && (
                              <span className="text-[10px] px-1.5 py-[1px] rounded-md bg-clay-muted text-ink-soft flex-shrink-0 leading-[14px]">{t('chatStoryBadge')}</span>
                            )}
                            {row?.pinned && <Pin className="w-3 h-3 text-ink-soft flex-shrink-0 self-center" />}
                            <span className="ml-auto pl-2 text-[11px] text-ink-soft flex-shrink-0 tabular-nums">{row?.updatedAt ? fmtRel(new Date(row.updatedAt).toISOString()) : ''}</span>
                          </div>
                          <p className={'mt-0.5 text-[13px] truncate ' + (unread > 0 ? 'text-gray-700' : 'text-ink-soft')}>
                            {row?.preview
                              ? <>{row.lastRole === 'user' && <span className="text-ink-soft/80">{t('chatInboxMe')}</span>}{row.preview}</>
                              : (row ? t('chatNewChat') : t('chatInboxNoChat'))}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {/* 微信式列表的"+ 发起新聊天"位：直接开角色新建（与小愈聊新话题走角色窗口里的「新对话」）
                  按钮用全站 BTN 口径；小字说明挪到按钮**下面**（原来夹在列表与按钮之间，把行动压到了最后） */}
              <button
                ref={inboxNewCharRef}
                type="button"
                data-testid="chat-inbox-newchar"
                onClick={() => { setListOpen(false); openNewChar(); }}
                className={'mt-3 flex items-center justify-center gap-1.5 ' + BTN.size + ' ' + BTN.secondary}
              >
                <Plus className="w-4 h-4" />
                {t('chatInboxNewChar')}
              </button>
              <p className="mt-2.5 text-[11px] text-ink-soft leading-relaxed text-center px-2">{t('chatInboxHint')}</p>
            </div>
          </div>
        </div>
      )}

      {/* 多对话抽屉：历史会话列表（新对话按钮已移到主区悬浮，见底部） */}
      {historyOpen && (
        <div className="fixed inset-0 z-[70]">
          <div className="absolute inset-0 bg-black/30" onClick={() => setHistoryOpen(false)} />
          <div className="absolute left-0 top-0 bottom-0 w-[82%] max-w-sm bg-white flex flex-col shadow-2xl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 flex-shrink-0">
              <p className="font-semibold text-gray-800">{t('chatHistoryTitle')}</p>
              <button onClick={() => setHistoryOpen(false)} aria-label={t('prefsDone')} className="p-2 -mr-2 text-ink-soft hover:text-gray-600 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-3">
              {chatSessions.length === 0 ? (
                <p className="text-center text-sm text-ink-soft py-10">{t('chatHistoryEmpty')}</p>
              ) : (
                chatSessions.map(c => (
                  <div
                    key={c.sessionId}
                    onClick={() => handleOpenChat(c.sessionId)}
                    className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-xl mb-1 cursor-pointer transition-colors ${c.sessionId === chatSessionId ? 'bg-primary-lighter' : 'hover:bg-gray-50'}`}
                  >
                    {renamingId === c.sessionId ? (
                      <div className="flex items-center gap-1 flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
                        <input
                          autoFocus
                          value={renameText}
                          onChange={(e) => setRenameText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRenameSave(c.sessionId);
                            else if (e.key === 'Escape') setRenamingId(null);
                          }}
                          placeholder={t('chatRenamePh')}
                          className="flex-1 min-w-0 text-sm px-2 py-1 rounded-lg border border-primary bg-white outline-none"
                        />
                        <button onClick={() => handleRenameSave(c.sessionId)} aria-label={t('chatRenameSave')} className="p-1 text-primary-text flex-shrink-0">
                          <Check className="w-4 h-4" />
                        </button>
                        <button onClick={() => setRenamingId(null)} aria-label={t('chatRenameCancel')} className="p-1 text-ink-soft flex-shrink-0">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-800 truncate">{c.title || t('chatNewChat')}</p>
                          <p className="text-[11px] text-ink-soft truncate">{c.preview}</p>
                        </div>
                        {/* 这条会话自己的未读（按会话清已读之后，用户要能看出是哪一条还有未读） */}
                        {(c.unread || 0) > 0 && (
                          <span
                            data-testid={`chat-session-unread-${c.sessionId}`}
                            className="flex-shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] leading-[18px] text-center font-semibold"
                          >
                            {c.unread! > 99 ? '99+' : c.unread}
                          </span>
                        )}
                        <span className="text-[10px] text-ink-soft flex-shrink-0">{fmtRel(c.updatedAt)}</span>
                        <button
                          onClick={(e) => handleTogglePin(c, e)}
                          aria-label={c.pinned ? t('chatUnpin') : t('chatPin')}
                          title={c.pinned ? t('chatUnpin') : t('chatPin')}
                          className={`p-1.5 flex-shrink-0 transition-colors ${c.pinned ? 'text-ink-soft' : 'text-ink-soft hover:text-ink-soft'}`}
                        >
                          <Pin className={`w-4 h-4 ${c.pinned ? 'fill-current' : ''}`} />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setRenamingId(c.sessionId); setRenameText(c.title || ''); }}
                          aria-label={t('chatRename')}
                          title={t('chatRename')}
                          className="p-1.5 text-ink-soft hover:text-primary-text transition-colors flex-shrink-0"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={(e) => handleDeleteChat(c.sessionId, e)}
                          aria-label={t('chatDelete')}
                          title={t('chatDelete')}
                          className="p-1.5 text-ink-soft hover:text-red-500 transition-colors flex-shrink-0"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* 顶栏（置顶固定） */}
      <div className="sticky top-0 z-50 bg-white/85 backdrop-blur border-b border-gray-100 flex-shrink-0">
        {/* 第 1 行：回消息列表 + 当前角色（点名字 = 这个角色的操作） + 分享·反馈 */}
        <div className="px-3 pt-2 pb-1 flex items-center justify-between gap-2">
          <div className="flex items-center shrink-0 gap-0.5">
            {/* 对话窗口的 ← 回**消息列表**（微信同款层级）；离开聊一聊由列表页自己那支 ← 负责 */}
            <button onClick={chatGoUp} aria-label={t('chatBackToList')} title={t('chatBackToList')} data-testid="chat-back-to-list" className="w-[32px] h-[32px] rounded-full flex items-center justify-center text-ink-soft hover:text-gray-700 hover:bg-primary-lighter transition-colors">
              <ArrowLeft className="w-[18px] h-[18px]" />
            </button>
          </div>
          <div className="flex-1 min-w-0 text-center px-1">
            <div className="relative inline-block min-w-0 w-full" ref={charMenuRef}>
              <button
                ref={roleBtnRef}
                type="button"
                onClick={() => setCharMenuOpen(v => !v)}
                aria-label={t('chatCharActions')}
                title={headerName}
                className="flex items-center justify-center gap-1.5 min-h-[44px] w-full min-w-0"
              >
                {charLoading ? (
                  <span className="w-6 h-6 rounded-full border-2 border-primary/30 border-t-primary animate-spin flex-shrink-0" />
                ) : (
                  <img src={activeAvatar} alt={headerName} className="w-6 h-6 rounded-full object-cover flex-shrink-0 mix-blend-multiply" />
                )}
                <span ref={chatTitleRef} title={chatTitleOverflow ? headerName : undefined} className="font-semibold text-gray-800 text-base leading-tight truncate min-w-0">{headerName}</span>
                <ChevronDown className="w-4 h-4 text-ink-soft flex-shrink-0" />
              </button>
              {/*
                ⚠️ 2026-09-20（用户口径「现在有两个位置可以切换角色，也很奇怪」）：
                这里原来是**角色切换列表**（下拉里选另一个角色），与新的消息列表首页重复。
                现在只保留**当前角色自己的操作**（剧情记忆 / 观景窗 / 编辑 / 删除），
                **切换角色只剩一个位置 = 消息列表**（微信的层级就是"列表 → 对话"）。
                新建角色也只在消息列表底部（这里是"这个人的资料页"，不是通讯录）。
              */}
              {charMenuOpen && activeCharacter && (
                <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 z-[85] bg-white rounded-xl shadow-2xl border border-gray-100 py-1.5 w-56 text-left" data-testid="chat-char-menu">
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100">
                    <img src={activeAvatar} alt={headerName} className="w-8 h-8 rounded-full object-cover flex-shrink-0 mix-blend-multiply" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-800 truncate">{headerName}</p>
                      {isStoryChar(activeCharacter) && (
                        <p className="text-[11px] text-ink-soft truncate">
                          {t('chatStoryBadge')} · 《{activeCharacter.story?.scenarioTitle || ''}》
                        </p>
                      )}
                    </div>
                  </div>
                  {isStoryChar(activeCharacter) && (
                    <button type="button" data-testid="chat-story-open" onClick={() => { setCharMenuOpen(false); void openStory(activeCharacter); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-primary-lighter transition-colors">
                      <BookOpen className="w-4 h-4 text-ink-soft" />
                      {t('chatStoryTitle')}
                    </button>
                  )}
                  <button type="button" onClick={() => { setCharMenuOpen(false); void openGrowth(activeCharacter); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-primary-lighter transition-colors">
                    <Eye className="w-4 h-4 text-ink-soft" />
                    {t('chatGrowth')}
                  </button>
                  {!activeCharacter.isDefault && (
                    <button type="button" onClick={() => { setCharMenuOpen(false); openEditChar(activeCharacter); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-primary-lighter transition-colors">
                      <Pencil className="w-4 h-4 text-ink-soft" />
                      {t('chatCharEdit')}
                    </button>
                  )}
                  {!activeCharacter.isDefault && (
                    <button type="button" onClick={() => { setCharMenuOpen(false); void removeChar(activeCharacter); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors">
                      <Trash2 className="w-4 h-4" />
                      {t('chatCharDelete')}
                    </button>
                  )}
                </div>
              )}
            </div>
            <p className="text-[11px] text-ink-soft truncate hidden sm:block">{t('chatSub')}</p>
          </div>
          <div className="flex items-center shrink-0 gap-0.5">
            {/* 分享 / 反馈：直接放右上，同一行 */}
            <button
              type="button"
              onClick={() => setShareOpen(true)}
              aria-label={t('chatShare')}
              title={t('chatShare')}
              className="w-[32px] h-[32px] rounded-full flex items-center justify-center text-ink-soft hover:text-primary-text hover:bg-primary-lighter transition-colors"
            >
              <Share2 className="w-[18px] h-[18px]" />
            </button>
            <button
              type="button"
              onClick={() => setFeedbackOpen(true)}
              aria-label={t('profileFeedback')}
              title={t('profileFeedback')}
              className="w-[32px] h-[32px] rounded-full flex items-center justify-center text-ink-soft hover:text-primary-text hover:bg-primary-lighter transition-colors"
            >
              <SkinFeedbackIcon className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>

        {/* 第 2 行：会话管理(历史 + 新建) + 当前角色设置/主行动(小愈怎么陪你·声音·理一理) */}
        <div className="px-3 pb-2 pt-1 flex items-center justify-between gap-1">
          <div ref={historyGroupRef} className="flex items-center gap-0.5">
            {/*
              这里原本有一个"打开消息列表"的图标，现在消息列表就是首页（左上角 ← 回去），
              再放一个入口等于**第二个切换角色的位置**（用户明确说"两个位置可以切换角色很奇怪"），故移除。
              本组只剩"该角色自己的多对话"（第二层）与"新对话"。
            */}
            <button
              onClick={() => setHistoryOpen(true)}
              aria-label={t('chatHistoryTitle')}
              title={t('chatHistoryTitle')}
              className="w-[32px] h-[32px] rounded-full flex items-center justify-center text-ink-soft hover:text-primary-text hover:bg-primary-lighter transition-colors"
            >
              <MessageSquare className="w-[18px] h-[18px]" />
            </button>
            <button
              onClick={handleNewChat}
              aria-label={t('chatNewChat')}
              title={t('chatNewChat')}
              disabled={recording}
              className="w-[32px] h-[32px] rounded-full flex items-center justify-center text-ink-soft hover:text-primary-text hover:bg-primary-lighter transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus className="w-[18px] h-[18px]" />
            </button>
          </div>
          <div className="flex items-center shrink-0 gap-0.5">
            {/* 当前角色设置组：小愈怎么陪你 + 声音（coach-mark 以一个「洞」同时圈住这两个按钮） */}
            <div ref={chatSettingsGroupRef} className="flex items-center gap-0.5">
              {/*
                ⚠️ 2026-09-20 修正：这里原本在"剧情角色"时**把设置按钮整个换成**「TA 记得的这段剧情」
                那样一来剧情角色窗口里就**再也调不到地区语气/语气程度/智能贴合/括号内心独白**了。
                现在改成：设置入口始终在，剧情角色时在面板**内部**加一块"剧情出身"（剧名 + 入戏/出戏 + 看记忆）。
                （2026-09-23：「陪伴方式」档位已从面板整体退场，这段解释保留是因为"别把入口整个换掉"那条教训仍然成立。）
              */}
              <button
                onClick={() => setCompanionStyleOpen(true)}
                aria-label={t('companionStyleTitle', { name: charDisplayName })}
                title={t('companionStyleTitle', { name: charDisplayName })}
                className="w-[32px] h-[32px] rounded-full flex items-center justify-center text-ink-soft hover:text-primary-text hover:bg-primary-lighter transition-colors"
              >
                <SlidersHorizontal className="w-[18px] h-[18px]" />
              </button>
              <button
                onClick={() => setVoiceSettingsOpen(true)}
                aria-label={t('voiceTitle', { name: voiceTarget ? voiceTarget.name : companionShortName() })}
                title={t('voiceTitle', { name: voiceTarget ? voiceTarget.name : companionShortName() })}
                className="w-[32px] h-[32px] rounded-full flex items-center justify-center text-ink-soft hover:text-primary-text hover:bg-primary-lighter transition-colors"
              >
                <Volume2 className="w-[18px] h-[18px]" />
              </button>
            </div>

            {/* 分割：设置组 与 主行动 分层 */}
            <span className="w-px h-5 bg-clay-border mx-1.5 flex-shrink-0" />

            {/* 主行动：理一理（主色图标，无文字） */}
            <button ref={structureBtnRef} onClick={openStructure} aria-label={t('chatToStructure')} title={t('chatToStructure')} className="w-[32px] h-[32px] rounded-full flex items-center justify-center text-white bg-primary hover:bg-primary-strong shrink-0 transition-colors">
              <Wand2 className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>
      </div>

      {/* 额度/会员说明：移到顶栏下方，避免挤压底部输入栏 */}
      <div className="flex-shrink-0 bg-white/85 backdrop-blur border-b border-gray-100 px-3 py-1 text-center">
        <p className="text-[11px] text-ink-soft leading-tight truncate">{quotaCaption}</p>
        {onNeedLogin && quota && !isLoggedIn() && quota.plan !== 'pro' && quota.plan !== 'plus' && (
          <button
            onClick={onNeedLogin}
            className="mt-0.5 inline-flex items-center justify-center gap-1 text-[11px] font-semibold text-white bg-primary-strong rounded-full px-3 py-1 hover:bg-primary transition-all"
          >
            <UserPlus className="w-3.5 h-3.5" />
            {t('memRegBtn')}
          </button>
        )}
      </div>

      {/* 消息区 */}
      <div className="relative flex-1 overflow-hidden">
        <div ref={scrollRef} onScroll={updateScrollState} onWheel={markUserScrolling} onTouchStart={markUserScrolling} onTouchMove={markUserScrolling} onPointerDown={markUserScrolling} onKeyDown={markUserScrolling} className="h-full overflow-y-auto px-3 sm:px-4 py-4 space-y-3 bg-brand [overflow-anchor:none]">
        <EntryRegionNudge name={charDisplayName} />
        {sessionLoading ? (
          <div className="py-16 flex items-center justify-center gap-2 text-sm text-ink-soft">
            <span className="w-6 h-6 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
            <span>{getLang() === 'en' ? 'Restoring your conversation…' : '正在恢复上次对话…'}</span>
          </div>
        ) : sessionLoadFailed ? (
          /* 恢复失败（超时/网络抖动）：明确告知 + 一键重试，绝不无声转圈等满 90s */
          <div className="py-16 px-6 flex flex-col items-center justify-center gap-3 text-sm text-ink-soft">
            <span className="text-center">{t('errLoad')}</span>
            <button
              onClick={() => {
                const cid = activeCharacter?.id || 'xiaoyu';
                if (chatSessionId) void openSession(cid, chatSessionId);
                else void loadSessionsFor(cid);
              }}
              className="text-primary-text bg-white border border-clay-border rounded-full px-4 py-2 hover:bg-primary-lighter transition-all"
            >
              {t('sendRetry')}
            </button>
          </div>
        ) : chatMessages.length === 0 && !sending ? (
          <div className="pt-6 px-4 pb-24">
            {/* 小愈开场白 */}
            <div className="flex items-end gap-2 justify-start mb-6">
              {charLoading ? (
                <span className="w-7 h-7 rounded-full border-2 border-primary/30 border-t-primary animate-spin flex-shrink-0" />
              ) : (
                <img src={activeAvatar} alt={activeName} className="w-7 h-7 rounded-full object-cover flex-shrink-0 mix-blend-multiply" />
              )}
              <div className="max-w-[78%] bg-white text-gray-800 border border-gray-100 rounded-2xl rounded-bl-sm px-4 py-3 text-[15px] leading-relaxed shadow-sm">
                {charLoading ? (getLang() === 'en' ? 'Loading…' : '加载中…') : greetingText}
              </div>
            </div>
            {/* 快速开始：这三颗是空对话页的**主入口**。
                2026-09-27 用户反馈「看不出能点」，病根是它们和下面的说明文字同一层级：
                1px 细描边 + 无阴影 + 无箭头 + 约 38px 高，且唯一的「可点」信号是 hover（手机上根本没有 hover）。
                现在把「可点」做成**静态**四件套，hover/active 只作锦上添花（better-ui：每个状态变化都要有静态线索）：
                  ① 2px 厚描边 + shadow-soft（与 .card-soft / .btn-primary 同一套「厚描边=实体」的黏土语言）；
                  ② 右侧常显箭头（第二信号，不依赖指针形状）；
                  ③ min-h-[44px] 触控高度（原来约 38px，未达 44 下限）；
                  ④ hover 时描边转主色、箭头圈填充、整颗上浮；按下 scale(0.98) 回弹（与 .btn-primary 同参数）。
                左侧 pl-9 与右侧「pr-3 + 28px 箭头圈 + gap-2」等宽，是为了让居中文字**光学居中**，
                而不是被箭头挤得偏左（better-ui：光学对齐优先于几何对齐）。 */}
            <div className="flex flex-col gap-2.5 max-w-xs mx-auto">
              {starters.map(s => (
                <button
                  key={s}
                  onClick={() => handleSend(s)}
                  className="group w-full min-h-[44px] flex items-center gap-2 text-sm font-medium text-primary-text bg-white border-2 border-clay-border rounded-full pl-9 pr-3 py-2 shadow-soft cursor-pointer transition-[background-color,border-color,box-shadow,transform] duration-150 hover:border-primary hover:bg-primary-lighter hover:-translate-y-0.5 hover:shadow-lift active:translate-y-0 active:scale-[0.98]"
                >
                  <span className="flex-1 text-center leading-snug">{s}</span>
                  <span
                    aria-hidden="true"
                    className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-primary-lighter text-primary-text transition-[background-color,color,transform] duration-150 group-hover:bg-primary group-hover:text-white group-hover:translate-x-0.5"
                  >
                    <ArrowRight className="w-4 h-4" strokeWidth={2} />
                  </span>
                </button>
              ))}
            </div>
            {/* 次级入口：同样给「厚描边 + 阴影 + 常显箭头」的可点三件套，只是字号更小、更靠近说明位。 */}
            <button
              onClick={() => handleSend(t('chatNewsPrompt'))}
              className="group flex items-center gap-1.5 mx-auto mt-4 max-w-[92%] text-[12.5px] text-ink bg-white/90 border-2 border-clay-border rounded-full px-3.5 py-2 shadow-soft cursor-pointer transition-[background-color,border-color,box-shadow,transform] duration-150 hover:border-primary hover:bg-white hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98]"
            >
              <span className="min-w-0 text-center">{t('chatNewsHint')}</span>
              <ArrowRight className="w-3.5 h-3.5 flex-shrink-0 text-primary-text transition-transform duration-150 group-hover:translate-x-0.5" strokeWidth={2.5} />
            </button>
            {/* 生活能力提示：它**不是按钮**（点了不会发生任何事），所以刻意和上面那颗按钮拉开层级
                无描边、无箭头、无阴影，只剩一层浅白底保证在棉花糖/深色等任何皮肤下都读得清。
                2026-09-27 之前它和「新闻」按钮同为 1px 描边白盒，这正是「到底哪些能点」说不清的另一半原因：
                可点性要靠**一致的正向信号**（描边+阴影+箭头），不能靠「长得都一样」。 */}
            <div className="mx-auto mt-3 max-w-[92%] text-center">
              <span className="inline-flex items-start gap-1 text-[11px] leading-snug text-ink-soft bg-white/70 rounded-lg px-2.5 py-1.5 select-none cursor-default">
                <span className="mt-px">🌦️</span>
                <span>{t('chatLifeHint')}</span>
              </span>
            </div>
          </div>
        ) : (
          <>
              {chatMessages.map((m, idx) => {
              const date = new Date(m.timestamp);
              const prev = idx > 0 ? new Date(chatMessages[idx - 1].timestamp) : null;
              const isNewDay = !prev || !sameDay(date, prev);
              return (
              <div key={m.id} id={'msg-' + m.id} data-role={m.role} className="group">
                {/* 跨天日期分界线 */}
                {isNewDay && (
                  <div className="flex items-center gap-2 my-2.5">
                    <div className="flex-1 h-px bg-gray-200" />
                    <span className="text-[11px] text-ink-soft flex-shrink-0">{fmtDate(date)}</span>
                    <div className="flex-1 h-px bg-gray-200" />
                  </div>
                )}
                {m.image && (
                  <div className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'} mb-1`}>
                    <img src={m.image} alt="" className="max-w-[70%] max-h-56 rounded-2xl border border-gray-200 object-cover shadow-sm" />
                  </div>
                )}
                <div className={`flex items-end gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {m.role === 'assistant' && (
                    <img src={activeAvatar} alt={activeName} className="w-7 h-7 rounded-full object-cover flex-shrink-0 mix-blend-multiply" />
                  )}
                  <div
                    /* 2026-09：气泡不再挂长按/右键处理器，操作已经常显在消息下方（见下），
                       长按回到浏览器默认行为（可以正常选中文字），也少掉"长按弹层"这条隐藏路径。 */
                    className={`max-w-[78%] rounded-2xl px-3.5 py-2.5 text-[15px] leading-relaxed whitespace-pre-line break-words shadow-sm ${
                    flashMsgId === m.id ? 'msg-flash ' : ''
                  }${editTarget?.id === m.id ? 'ring-2 ring-amber-300 ring-offset-1 ' : ''}${
                    m.role === 'user'
                      ? 'bg-primary text-white rounded-br-sm'
                      : 'bg-white text-gray-800 border border-gray-100 rounded-bl-sm'
                  }`}>
                    {/* 引用被回复的消息。设计要点（2026-09-17 三轮打磨，依据见 CHANGELOG 里的调研）：
                        · **按气泡角色反过来取色**：用户气泡是绿底 → 引用卡用**更深的同族绿**（`bg-primary-strong`）+ 白字，
                          读起来是「气泡里凹下去的一块」，和气泡是一体；小愈气泡是白底 → 引用卡用淡薄荷 + 深绿字，
                          依旧是「贴上来的浅卡」。即「卡片色始终与容器色反向」，不靠近白/近黑硬撞
                          （同一手法：WhatsApp/Signal 用半透明遮盖压/提气泡色；Stream/Slack/iMessage 在浅气泡里用中性次级面色）。
                        · 圆角走**同心**（better-ui：内层 = 外层 − 间距）：气泡 16px − 内边距 14px ≈ 2px，
                          这里取 4px（近方角、仍留一点软），Stream Chat 的引用气泡也刻意压成 `radius/6` 的近方角；
                          8px 圆角会读成「浮在上面的独立卡片」，正是上一版被嫌「白纸条」的同一种观感。
                        · 正文收口靠 quoteText() 的**字符级截断**（42 字 ≈ 手机端两行）+ 省略号；发信人名字永远完整
                          （ui-ux-pro-max ux-guidelines #84 截断要带省略号、#113 可辨识的名字不得被截）。
                          ⚠️ 不用 line-clamp：Chrome 会把下一行字头露出来（见 quoteText 注释）。
                        · 对比度实测（引用卡文字 vs 合成底色）：深绿底白字 4.76:1（candy 4.68 / zen 10.2 / star 15.1，五皮肤全 ≥4.5）；
                          淡薄荷底深绿字 4.79:1。⚠️ 别再写回裸 `var(--color-*)`，通道变量已就位（见 tailwind.config.js）。 */}
                    {m.replyTo && (
                      <button
                        type="button"
                        onClick={() => jumpToQuotedMessage(m)}
                        // 不把指针事件冒泡给气泡（同一手法见 src/components/CopyButton.tsx）：
                        // 气泡本身现在不再挂任何指针处理器，这一层只是沿用既有约定、避免将来加回来时打架。
                        onPointerDown={(e) => e.stopPropagation()}
                        onPointerUp={(e) => e.stopPropagation()}
                        aria-label={t('chatQuoteJump')}
                        title={t('chatQuoteJump')}
                        className={`mb-1.5 block w-full rounded border-l-2 px-2.5 py-1.5 text-left text-[12px] leading-snug transition-[filter,opacity] duration-150 hover:brightness-[1.08] active:brightness-95 ${
                          m.role === 'user'
                            ? 'border-white/70 bg-primary-strong text-white'
                            : 'border-primary bg-primary-lighter text-primary-text'
                        }`}
                      >
                        <span className="font-medium">{(m.replyTo.role === 'assistant' ? activeName : t('chatShareMe'))}：</span>
                        {quoteText(m.replyTo, 42)}
                      </button>
                    )}
                    {m.role === 'assistant' ? (
                      <>
                        {renderMessageText(m.content)}
                        {voiceEnabled && m.content.trim() ? (
                          <div className="mt-1.5 flex items-center">
                            <VoiceMessage
                              src={ttsMeta[m.id]?.url}
                              duration={ttsMeta[m.id]?.duration ?? null}
                              playing={voiceReplyId === m.id}
                              loading={voiceLoading === m.id || voicePreloadingId === m.id}
                              onToggle={() => playAssistantVoice(m)}
                              accent="brand"
                              loadingLabel={t('voiceAiLoading')}
                              notReadyLabel={t('voiceTapToGenerate')}
                            />
                          </div>
                        ) : null}
                      </>
                    ) : (m.audio ? (
                      <>{m.content}<div className="mt-1"><VoiceMessage src={m.audio} accent="light" /></div></>
                    ) : m.content)}
                  </div>
                </div>
                {/* 来源行（2026-09-29）：本轮 web_search 的命中，常显在气泡下方，用户不必先知道「可以要链接」。
                    只对带 sources 的 assistant 消息有内容（组件自身对空数组返回 null）；位置在气泡与「时间/操作行」之间。 */}
                {m.role === 'assistant' && <ChatSources sources={m.sources} />}
                {/* 时间戳 + 助手回复的反馈小标 + **常显的回复/编辑/复制图标**（2026-09 从 ⋯ 弹层里拿出来：
                    图标不写字，靠 aria-label + title 说话；编辑只对「最后一条用户消息」出现） */}
                <div className={`mt-0.5 flex items-center gap-1.5 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <span className="text-[11px] text-ink-soft">{fmtTime(date)}</span>
                  {m.role === 'assistant' && <AiFeedbackMark context={chatContext} />}
                  <button
                    type="button"
                    data-testid="chat-reply-btn"
                    onClick={() => replyToMessage(m)}
                    aria-label={t('chatReply')}
                    title={t('chatReply')}
                    className={iconBtnCls}
                  >
                    <CornerUpLeft className="w-4 h-4" />
                  </button>
                  {canEditMessage(m) && (
                    <button
                      type="button"
                      data-testid="chat-edit-btn"
                      onClick={() => editMessage(m)}
                      aria-label={t('chatEdit')}
                      title={t('chatEdit')}
                      className={iconBtnCls + (editTarget?.id === m.id ? ' text-primary-text border-primary-soft bg-primary-lighter' : '')}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="chat-copy-btn"
                    onClick={() => void copyMessage(m)}
                    aria-label={t('chatCopy')}
                    title={t('chatCopy')}
                    className={iconBtnCls}
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                </div>
              </div>
              );
            })}
            {(sending && !streaming) || typing || searching ? (
              <div className="justify-start">
                <div className="flex items-end gap-2">
                  <img src={activeAvatar} alt={activeName} className="w-7 h-7 rounded-full object-cover flex-shrink-0 mix-blend-multiply" />
                  <div className="bg-white border border-clay-border rounded-2xl rounded-bl-sm px-4 py-3.5 shadow-soft">
                    <TypingDots />
                  </div>
                </div>
                <div className="text-[11px] text-ink-soft mt-1 ml-9">{typingLabel}</div>
              </div>
            ) : null}
          </>
        )}

        {/* 指令分流提示卡（用户在聊一聊里输入「来玩角色扮演 / 你扮演我的男友 / 来点涩涩的」这类指令时出现；
            判定在后端 api/services/chatRedirect.ts，三种 hint 的文案见模块级 REDIRECT_CARD）。
            ⚠️ 成人向有两种形态：
              · hintCompact=false（规则层短路）→ 小愈只回了一段模板引导语，卡里要把「去哪、开什么、有什么好处」讲全；
              · hintCompact=true（戏内升级那条路）→ **小愈已经用自己的话解释过了**，这里只补一个**直达按键**
                （用户原话：「要有一个直达的按键而不只是信息说明」）。两处都用同一个 data-testid，测试统一认。 */}
        {redirectHint && redirectHintCompact && redirectHint === 'adultRoleplay' && (
          <div data-testid="chat-redirect-card" data-hint={redirectHint} data-compact="true" className="bg-primary-lighter border border-clay-border rounded-2xl p-3.5 mt-4">
            <p className="text-[12.5px] text-ink-soft leading-relaxed">{t('chatGoAdultCompactLead')}</p>
            <button
              onClick={() => goRoleplayFromHint('list', { adult: true })}
              data-testid="chat-redirect-adult-cta"
              className="w-full text-sm font-medium text-white bg-primary rounded-full py-2.5 mt-2.5 hover:bg-primary-strong transition-all"
            >
              {t('chatGoAdultBtn')}
            </button>
            <button
              onClick={clearRedirectHint}
              className="w-full text-[11px] text-ink-soft hover:text-gray-600 underline underline-offset-2 mt-1.5 text-center"
            >
              {t('chatGoRedirectDismiss')}
            </button>
          </div>
        )}
        {redirectHint && !(redirectHintCompact && redirectHint === 'adultRoleplay') && (
          <div data-testid="chat-redirect-card" data-hint={redirectHint} className="bg-primary-lighter border border-clay-border rounded-2xl p-3.5 mt-4">
            <p className="text-sm font-semibold text-primary-text leading-relaxed">
              {t(REDIRECT_CARD[redirectHint].title)}
            </p>
            <ul className="mt-2.5 space-y-1.5">
              {REDIRECT_CARD[redirectHint].bullets.map(k => (
                <li key={k} className="flex gap-1.5 text-[12.5px] text-ink-soft leading-relaxed">
                  <span className="text-primary flex-shrink-0">·</span>
                  <span>{t(k)}</span>
                </li>
              ))}
            </ul>
            {redirectHint === 'roleplay' && (
              <>
                <button
                  onClick={() => goRoleplayFromHint('list')}
                  className="w-full text-sm font-medium text-white bg-primary rounded-full py-2.5 mt-3 hover:bg-primary-strong transition-all"
                >
                  {t('chatGoRoleplayBtn')}
                </button>
                <button
                  onClick={() => goRoleplayFromHint('custom')}
                  className="w-full text-sm font-medium text-primary-text bg-white border border-primary/30 rounded-full py-2.5 mt-2 hover:bg-primary-lighter transition-all"
                >
                  {t('chatGoRoleplayCreateBtn')}
                </button>
              </>
            )}
            {redirectHint === 'chatCharacter' && (
              <button
                onClick={createCharacterFromHint}
                className="w-full text-sm font-medium text-white bg-primary rounded-full py-2.5 mt-3 hover:bg-primary-strong transition-all"
              >
                {t('chatGoCharacterBtn')}
              </button>
            )}
            {/* 成人向：主按钮进剧情并自动展开「我的偏好」抽屉（把用户直接送到「无限制模式」开关前）。
                只指路不给按钮的版本试过，用户进了剧情列表仍然不知道开关在哪，等于没解决。 */}
            {redirectHint === 'adultRoleplay' && (
              <button
                onClick={() => goRoleplayFromHint('list', { adult: true })}
                data-testid="chat-redirect-adult-cta"
                className="w-full text-sm font-medium text-white bg-primary rounded-full py-2.5 mt-3 hover:bg-primary-strong transition-all"
              >
                {t('chatGoAdultBtn')}
              </button>
            )}
            <button
              onClick={clearRedirectHint}
              className="w-full text-[11px] text-ink-soft hover:text-gray-600 underline underline-offset-2 mt-1.5 text-center"
            >
              {t('chatGoRedirectDismiss')}
            </button>
          </div>
        )}

        {/* 转入理一理提示（分流卡片在场时让位，避免两张绿卡叠在一起） */}
        {showStructureHint && !redirectHint && (
          <div className="bg-primary-lighter border border-clay-border rounded-2xl p-3.5 mt-4">
            <p className="text-sm text-primary-text leading-relaxed mb-2.5">
              {t('chatToStructureTip')}
            </p>
            <button
              onClick={openStructure}
              className="w-full text-sm font-medium text-white bg-primary rounded-full py-2.5 hover:bg-primary-strong transition-all"
            >
              {t('chatToStructureBtn')}
            </button>
            <button
              onClick={dismissHint}
              className="w-full text-[11px] text-ink-soft hover:text-gray-600 underline underline-offset-2 mt-1.5 text-center"
            >
              {t('chatHintDismiss')}
            </button>
          </div>
        )}

        {/* 🚨 失败提示（2026-09-15 线上事故修复）：只提示 + 重试，绝不把小愈的回复换成兜底文案 */}
        {sendFailed && !sending && !streaming && (
          <SendFailedNotice
            testId="chat-send-failed"
            code={sendFailed}
            text={sendFailed === 'TIMEOUT' || sendFailed === 'NETWORK' || sendFailed === 'ABORTED' ? t('sendFailedNotice') : sendFailed}
            retryLabel={t('sendRetry')}
            onRetry={retryLastTurn}
            className="mt-4"
          />
        )}
        </div>

        {!atBottom && (
          <button
            onClick={scrollToBottom}
            aria-label={t('chatScrollToBottom')}
            title={t('chatScrollToBottom')}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 rounded-full bg-primary text-white text-xs font-medium pl-2.5 pr-3 py-2 shadow-lg hover:bg-primary-strong transition-all"
          >
            <ArrowDown className="w-4 h-4" />
            {t('chatScrollToBottom')}
          </button>
        )}
      </div>

      {/* Android：输入栏钉到屏幕顶部时，加一层可点击的遮罩（点遮罩=收起键盘/回到普通视图） */}
      {pinComposerTop && (
        <div className="fixed inset-0 z-[190] bg-black/25" onClick={() => inputRef.current?.blur()} aria-hidden="true" />
      )}
      {/* 底部输入栏（移动端安全区适配）。Android 聚焦时改为 fixed 到屏幕顶部（方案 B）。 */}
      <div
        className={`flex-shrink-0 ${pinComposerTop ? 'border-b border-gray-100 shadow-lg' : 'border-t border-gray-100'} bg-white px-3 pt-2 ${isMobile && emojiOpen ? 'pb-1' : 'pb-[max(0.6rem,env(safe-area-inset-bottom))]'}`}
        style={pinComposerTop ? { position: 'fixed', top: 0, left: 0, right: 0, zIndex: 200, paddingTop: 'max(0.5rem, env(safe-area-inset-top))' } : undefined}
      >
        {pendingImage && (
          <div className="mb-2 inline-block relative">
            <img src={pendingImage} alt={t('chatAttachImage')} className="w-20 h-20 object-cover rounded-xl border border-clay-border shadow-sm" />
            <button
              onClick={() => setPendingImage(null)}
              aria-label={t('chatAttachRemove')}
              className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-gray-800/70 text-white flex items-center justify-center"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {/* 编辑重发提示条（2026-09）：说明白"重发会按新内容重新回复、这条之后的内容会被清掉"，
            并给一个明确的取消（把进编辑态前的草稿还回去）。样式沿用引用条那一套实色底（不用变量色+透明度）。 */}
        {editTarget && (
          <div data-testid="chat-edit-banner" className="mb-2 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <Pencil className="w-3.5 h-3.5 text-amber-700 mt-0.5 flex-shrink-0" />
            <span className="text-[12px] text-amber-900 flex-1 leading-snug min-w-0">{t('chatEditBanner')}</span>
            <button
              type="button"
              data-testid="chat-edit-cancel"
              onClick={cancelEditMessage}
              className="text-[11px] font-medium text-amber-900 bg-white/90 border border-amber-300 rounded-full px-2 py-0.5 flex-shrink-0 hover:bg-amber-100 transition-colors"
            >
              {t('chatEditCancel')}
            </button>
          </div>
        )}
        {/* 引用回复预览：正在回复某条消息（与气泡内引用卡同款实色淡薄荷底；⚠️ 不用 `border-primary/20`，变量色 + 透明度不生成 CSS，等于没有描边） */}
        {replyTo && !editTarget && (
          <div className="mb-2 flex items-start gap-2 bg-primary-lighter border border-primary-soft rounded-lg px-3 py-2">
            <span className="text-[12px] text-primary-text flex-1 leading-snug min-w-0">
              <span className="font-medium">{(replyTo.role === 'assistant' ? activeName : t('chatShareMe'))}：</span>
              {quoteText(replyTo, 60)}
            </span>
            <button onClick={() => setReplyTo(null)} aria-label={t('chatReplyCancel')} title={t('chatReplyCancel')} className="text-ink-soft hover:text-gray-600 p-0.5 flex-shrink-0">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {(recording || voicePending) && (
          <div className="mb-2 flex items-center gap-2 bg-primary-lighter border border-primary/20 rounded-xl px-3 py-2">
            <span className={"w-2 h-2 rounded-full flex-shrink-0 " + (recording ? "bg-red-500 animate-pulse" : "bg-primary animate-pulse")} />
            <p className="text-xs text-primary-text flex-1 leading-snug break-words">
              {recording ? `${t('voiceListening')} · ${recSec}″ / 60″` : t('voiceTranscribing')}
            </p>
            {recording && voiceSupported && (
              <select
                value={micLang}
                onChange={(e) => changeVoiceLang(e.target.value as SpeechLangKey)}
                aria-label={t('voiceLangLabel')}
                title={t('voiceLangLabel')}
                className="h-7 rounded-full bg-white border border-primary/20 text-[11px] text-primary-text px-2 flex-shrink-0 outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="auto">{t('voiceLangAuto')}</option>
                <option value="zh-CN">{t('voiceLangMandarin')}</option>
                <option value="zh-HK">{t('voiceLangCantonese')}</option>
                <option value="en-US">{t('voiceLangEnglish')}</option>
              </select>
            )}
          </div>
        )}
        {voiceError && (
          <div className="mb-2 flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
            <p className="text-xs text-red-700 flex-1">{voiceError}</p>
            <button onClick={() => setVoiceError(null)} aria-label={t('prefsDone')} title={t('prefsDone')} className="text-red-400 hover:text-red-600 p-0.5 flex-shrink-0">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {bridgeFrom && (
          <div className="mb-2 flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full border border-clay-border bg-white/80 px-2.5 py-1 text-[11px] text-ink-soft">
              {t('rpBridgeFromTag', { title: bridgeFrom })}
            </span>
            <button
              type="button"
              onClick={dropBridgeContext}
              className="text-[11px] text-ink-soft hover:text-gray-700"
            >
              {t('rpBridgeFromTagRemove')}
            </button>
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handlePickImage} />
          <input ref={cameraFileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handlePickImage} />
          {/* 输入框（语音转文字按钮内嵌于框内右侧） */}
          <div className="relative flex-1 min-w-0">
            <textarea
              aria-label={t('composerLabel')}
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPointerDown={(e) => {
                // 点输入框即收起 emoji 面板；并在同一用户手势内**同步** focus（Android Chrome 只有手势内 focus 才弹软键盘）
                if (emojiOpen) {
                  // 阻止浏览器默认的 focus/滚动，避免面板收起带动输入框大幅下移而被 Chrome 当成滚动、取消软键盘
                  e.preventDefault();
                  setEmojiOpen(false);
                  const el = inputRef.current;
                  try {
                    el?.focus({ preventScroll: true } as FocusOptions);
                    el?.setSelectionRange?.(el.value.length, el.value.length);
                  } catch { /* 忽略 */ }
                }
              }}
              onFocus={() => {
                setInputFocused(true);
                if (IS_ANDROID) setAndroidComposerTop(true);
                // 移动端：点输入框即打开软键盘并收起 emoji 面板（二者互斥占据底部）
                if (isMobile && emojiOpen) setEmojiOpen(false);
              }}
              onBlur={() => { setInputFocused(false); if (IS_ANDROID) setAndroidComposerTop(false); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submitChat();   // 编辑态下 = 重发（见 submitChat）
                }
              }}
              rows={1}
              enterKeyHint="send"
              placeholder={editTarget ? t('chatEdit') : t('chatPlaceholder')}
              className="block w-full min-h-[40px] max-h-40 resize-none pl-3 pr-10 py-2 text-[16px] leading-snug rounded-2xl border border-gray-200 bg-gray-50 focus:ring-2 focus:ring-primary focus:border-transparent focus:bg-white outline-none transition-all"
            />
            {voiceSupported && !sending && (recording || voicePending || !(input.trim() || pendingImage)) && (
              <button
                onClick={toggleVoice}
                disabled={voicePending}
                onMouseDown={(e) => e.preventDefault()} // 防移动端第一次点击被“收键盘”吞掉（需点两次才弹出）
                aria-label={recording ? t('voiceListening') : voicePending ? t('voiceTranscribing') : t('voiceStart')}
                title={recording ? t('voiceListening') : voicePending ? t('voiceTranscribing') : t('voiceStart')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full flex items-center justify-center text-ink-soft hover:text-primary-text hover:bg-primary-lighter transition-colors disabled:opacity-50"
              >
                {recording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </button>
            )}
          </div>
          {/* 表情 */}
          <div className="relative flex" ref={emojiWrapRef}>
            <button
              onClick={openEmoji}
              onMouseDown={(e) => e.preventDefault()} // 防移动端第一次点击被“收键盘”吞掉（需点两次才弹出）
              aria-label={t('chatEmoji')}
              title={t('chatEmoji')}
              className="w-10 h-10 rounded-full bg-gray-100 text-ink-soft hover:text-primary-text hover:bg-primary-lighter flex items-center justify-center flex-shrink-0 transition-colors"
            >
              <Smile className="w-[21px] h-[21px]" />
            </button>
            {/* 桌面/宽屏：按钮上方浮层小面板（移动端在底部停靠，见下方） */}
            {!isMobile && emojiOpen && (
              <div className="absolute bottom-full right-0 mb-0 z-[80]">
                <Suspense fallback={<div className="w-[340px] max-w-[calc(100vw-16px)] h-20 rounded-2xl bg-white/70 border border-clay-border shadow-xl" />}>
                  <EmojiPicker onPick={insertEmoji} onPickSticker={sendStickerImage} onClose={() => setEmojiOpen(false)} lang={getLang()} />
                </Suspense>
              </div>
            )}
          </div>
          {/* 加号 / 发送（空内容=加号打开相册/拍照/发送位置；有内容=发送） */}
          <div className="relative flex" ref={imageMenuRef}>
            <button
              ref={imageBtnRef}
              onClick={handlePlusOrSend}
              onMouseDown={(e) => e.preventDefault()} // 防移动端第一次点击被“收键盘”吞掉（需点两次才发送）
              disabled={sending || recording}
              className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 transition-all ${(input.trim() || pendingImage) && !sending ? 'bg-primary text-white hover:bg-primary-strong shadow-md' : 'bg-gray-100 text-ink-soft hover:text-primary-text hover:bg-primary-lighter'} ${sending ? 'opacity-50 cursor-not-allowed' : ''} ${recording ? 'opacity-40 cursor-not-allowed' : ''}`}
              aria-label={(input.trim() || pendingImage) ? t('chatSend') : t('chatAttachMenu')}
              title={(input.trim() || pendingImage) ? t('chatSend') : t('chatAttachMenu')}
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : (input.trim() || pendingImage) ? <Send className="w-4 h-4" /> : <Plus className="w-5 h-5" />}
            </button>
            {imageMenuOpen && (
              <div className={`absolute right-0 z-[70] w-48 rounded-xl bg-white border border-gray-200 shadow-lg overflow-hidden ${pinComposerTop ? 'top-full mt-2' : 'bottom-full mb-2'}`}>
                <button
                  type="button"
                  onClick={() => openImageFrom('gallery')}
                  aria-label={t('chatAttachGallery')}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-700 hover:bg-gray-50 text-left"
                >
                  <ImagePlus className="w-4 h-4 text-primary flex-shrink-0" />
                  {t('chatAttachGallery')}
                </button>
                <button
                  type="button"
                  onClick={() => openImageFrom('camera')}
                  aria-label={t('chatAttachCamera')}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-700 hover:bg-gray-50 text-left border-t border-gray-100"
                >
                  <Camera className="w-4 h-4 text-primary flex-shrink-0" />
                  {t('chatAttachCamera')}
                </button>
                <button
                  type="button"
                  onClick={sendLocation}
                  aria-label={t('chatAttachLocation')}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-700 hover:bg-gray-50 text-left border-t border-gray-100"
                >
                  <MapPin className="w-4 h-4 text-primary flex-shrink-0" />
                  {t('chatAttachLocation')}
                </button>
              </div>
            )}
          </div>
        </div>
        {quotaMsg ? (
          <>
          <div className="mt-2 flex items-center justify-between gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
            <p className="text-xs text-amber-800 flex-1">{quotaMsg}</p>
            <button onClick={onOpenMembership} className="text-xs text-primary underline underline-offset-2 flex-shrink-0">
              {t('chatQuotaUpgrade')}
            </button>
          </div>
          <div className="mt-1.5 flex items-center gap-2 bg-primary-lighter border border-primary/20 rounded-xl px-3 py-2">
            <span className="text-[11px] text-primary-text flex-1 leading-snug">{t('inviteEarnHint', { n: inviteBonus })}</span>
            <button onClick={copyInvite} className="text-[11px] text-primary underline underline-offset-2 flex-shrink-0">
              {inviteCopied ? t('profileCopied') : t('copyInvite')}
            </button>
          </div>
          </>
        ) : null}
      </div>
      {/* 移动端：emoji 面板停靠在屏幕底部（原键盘位置），全宽、贴合手机屏 */}
      {isMobile && emojiOpen && (
        <div ref={emojiPanelRef} className="flex-shrink-0">
          <Suspense fallback={<div className="w-full h-24 bg-white/70 border-t border-clay-border" />}>
            <EmojiPicker
              docked
              height={emojiDockHeight}
              onPick={insertEmoji}
              onPickSticker={sendStickerImage}
              onClose={() => setEmojiOpen(false)}
              lang={getLang()}
            />
          </Suspense>
        </div>
      )}
      {/* 键盘处理：容器高度跟随可视视口高度（见 useVisualViewport），配合 Home 的外层容器一起压缩，
          页面内容高度=可视高度，浏览器没有额外滚动余量、不会再把输入栏往上推；输入栏贴在容器底边=键盘上方。 */}

      {/* 复制成功提示 */}
      {copiedToast && (
        <div className="fixed bottom-28 left-1/2 -translate-x-1/2 z-[95] bg-gray-800/90 text-white text-sm px-4 py-2 rounded-full shadow-lg">
          {t('chatCopied')}
        </div>
      )}
      {/* 发送位置提示（定位失败/不支持） */}
      {locMsg && (
        <div className="fixed bottom-28 left-1/2 -translate-x-1/2 z-[95] bg-gray-800/90 text-white text-sm px-4 py-2 rounded-full shadow-lg">
          {locMsg}
        </div>
      )}
      {/* 剧情角色：TA 记得的这段剧情（只读回看 + 入戏/出戏 + 增量同步 + 回剧情继续） */}
      {storyOpen && isStoryChar(activeCharacter) && activeCharacter && (
        <Modal
          onClose={() => setStoryOpen(false)}
          showClose={false}
          overlayClassName="z-[90] flex items-end sm:items-center justify-center p-0 sm:p-6 bg-black/40"
          width="max-w-lg" radius="rounded-t-2xl sm:rounded-2xl" maxHeight="max-h-[85vh]" overflow="" layout="flex"
          panelClassName="border border-gray-100"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 flex-shrink-0">
            <div className="min-w-0">
              <p className="font-semibold text-gray-800 truncate" data-testid="chat-story-title">{t('chatStoryTitle')}</p>
              <p className="text-[11px] text-ink-soft truncate">
                {activeCharacter.name} · 《{storyView?.binding.scenarioTitle || activeCharacter.story?.scenarioTitle || ''}》
              </p>
            </div>
            <button onClick={() => setStoryOpen(false)} aria-label={t('prefsDone')} className="p-2 -mr-2 text-ink-soft hover:text-gray-600 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {/* 入戏 / 出戏：记忆是同一份，只是"怎么看待这段关系"换了说法 */}
            <div className="flex items-center gap-2" data-testid="chat-story-mode">
              {(['in', 'out'] as const).map(m => {
                const on = (activeCharacter.storyMode || 'in') === m;
                return (
                  <button
                    key={m}
                    type="button"
                    disabled={storyModeSaving}
                    onClick={() => void handleStoryMode(m)}
                    aria-pressed={on}
                    data-testid={`chat-story-mode-${m}`}
                    className={`flex-1 text-[12px] px-3 py-1.5 rounded-full border transition-colors disabled:opacity-60 ${on ? 'bg-primary text-white border-primary' : 'bg-white text-gray-700 border-gray-200 hover:border-primary'}`}
                  >
                    {m === 'in' ? t('chatStoryModeIn') : t('chatStoryModeOut')}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] leading-relaxed text-ink-soft">{t('chatStoryModeHint')}</p>

            {storyLoading ? (
              <div className="py-8 text-center"><div className="mx-auto w-6 h-6 rounded-full border-2 border-primary/30 border-t-primary animate-spin" /></div>
            ) : storyView ? (
              <>
                {storyView.pendingMsgCount > 0 && (
                  <button
                    type="button"
                    onClick={() => void handleStorySync()}
                    disabled={storySyncing}
                    data-testid="chat-story-sync"
                    className="w-full flex items-center justify-center gap-1.5 text-[12px] px-3 py-2 rounded-xl bg-primary-lighter text-primary-text border border-clay-border disabled:opacity-60"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${storySyncing ? 'animate-spin' : ''}`} />
                    {storySyncing ? t('chatStorySyncing') : t('chatStorySync', { n: storyView.pendingMsgCount })}
                  </button>
                )}
                {storyView.binding.digest?.summary && (
                  <div>
                    <p className="text-[12px] font-medium text-gray-800 mb-1">{t('chatStorySummary')}</p>
                    <p className="text-[12px] leading-relaxed text-gray-700 bg-clay-bg border border-clay-border rounded-lg px-3 py-2">{storyView.binding.digest.summary}</p>
                  </div>
                )}
                {!!storyView.binding.digest?.openThreads?.length && (
                  <div>
                    <p className="text-[12px] font-medium text-gray-800 mb-1">{t('chatStoryThreads')}</p>
                    <ul className="text-[12px] leading-relaxed text-gray-700 list-disc pl-5">
                      {storyView.binding.digest.openThreads.map((th, i) => <li key={i}>{th}</li>)}
                    </ul>
                  </div>
                )}
                {!!storyView.binding.digest?.keyEvents?.length && (
                  <div>
                    <p className="text-[12px] font-medium text-gray-800 mb-1">{t('chatStoryEvents')}</p>
                    <ul className="text-[12px] leading-relaxed text-gray-700 list-disc pl-5">
                      {storyView.binding.digest.keyEvents.slice(-8).map((e, i) => (
                        <li key={i}>{e.text}{e.date ? <span className="text-ink-soft">（{e.date}）</span> : null}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {!!storyView.blocks.length && (
                  <div>
                    <p className="text-[12px] font-medium text-gray-800 mb-1">{t('chatStoryBlocks', { n: storyView.blocks.length })}</p>
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {storyView.blocks.slice(-6).map(b => (
                        <p key={b.id} className="text-[11px] leading-relaxed text-ink-soft bg-white border border-gray-100 rounded-lg px-2.5 py-1.5">{b.text}</p>
                      ))}
                    </div>
                    <p className="text-[11px] text-ink-soft mt-1">{t('chatStoryBlocksHint')}</p>
                  </div>
                )}
              </>
            ) : (
              <p className="text-center text-[12px] text-ink-soft py-6">{t('chatStoryEmpty')}</p>
            )}

            {/* 剧情角色按剧本人设说话：把原因讲清楚，而不是让用户找不到入口 */}
            <p className="text-[11px] leading-relaxed text-ink-soft bg-primary-lighter border border-clay-border rounded-lg px-3 py-2">{t('chatStoryNoMode')}</p>
          </div>

          <div className="px-4 py-3 border-t border-gray-100 flex-shrink-0 flex items-center gap-2">
            {onGoRoleplay && activeCharacter.story?.scenarioId && (
              <button
                type="button"
                data-testid="chat-story-back"
                onClick={() => { setStoryOpen(false); onGoRoleplay('list', activeCharacter.story?.scenarioId); }}
                className="flex-1 text-[12px] px-3 py-2 rounded-full border border-gray-200 text-gray-700 hover:border-primary transition-colors"
              >
                {t('chatStoryBackToStory')}
              </button>
            )}
            <button
              type="button"
              onClick={() => setStoryOpen(false)}
              className="flex-1 text-[12px] px-3 py-2 rounded-full bg-primary text-white hover:bg-primary-strong transition-colors"
            >
              {t('prefsDone')}
            </button>
          </div>
        </Modal>
      )}

      {/* 小愈怎么陪你：地区/程度/智能贴合/聊天内心独白（理一理打开时含故事风格） */}
      {companionStyleOpen && (
        <Modal onClose={() => setCompanionStyleOpen(false)} overlayClassName="z-[120] flex items-end sm:items-center justify-center bg-black/40" width="w-full sm:max-w-md" padding="p-4" radius="rounded-t-2xl sm:rounded-2xl" maxHeight="max-h-[88vh]" panelClassName="text-gray-800" showClose={false}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-base font-semibold">{t('companionStyleTitle', { name: charDisplayName })}</h3>
              <button onClick={() => setCompanionStyleOpen(false)} aria-label={t('prefsDone')} className="p-1 text-ink-soft hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            {/* 剧情出身：剧名 + 双态 + 看「TA 记得的这段剧情」（只对剧情角色出现） */}
            {isStoryChar(activeCharacter) && activeCharacter && (
              <div className="mb-3 rounded-xl border border-clay-border bg-primary-lighter p-3" data-testid="chat-story-in-prefs">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[12px] font-semibold text-ink">{t('chatStoryTitle')}</p>
                  <button
                    type="button"
                    onClick={() => { const c = activeCharacter; setCompanionStyleOpen(false); void openStory(c); }}
                    className="text-[11px] text-primary-text underline underline-offset-2 flex-shrink-0"
                  >
                    {t('chatStoryOpenDetail')}
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-ink-soft truncate">《{activeCharacter.story?.scenarioTitle || ''}》</p>
                <div className="mt-2 flex items-center gap-2">
                  {(['in', 'out'] as const).map(m => {
                    const on = (activeCharacter.storyMode || 'in') === m;
                    return (
                      <button
                        key={m}
                        type="button"
                        disabled={storyModeSaving}
                        onClick={() => void handleStoryMode(m)}
                        aria-pressed={on}
                        className={`flex-1 text-[12px] px-3 py-1.5 rounded-full border transition-colors disabled:opacity-60 ${on ? 'bg-primary text-white border-primary' : 'bg-white text-gray-700 border-gray-200 hover:border-primary'}`}
                      >
                        {m === 'in' ? t('chatStoryModeIn') : t('chatStoryModeOut')}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="bg-clay-bg border border-clay-border rounded-xl p-3">
              <PreferencePanel
                variant="tone"                hideRelation={isStoryChar(activeCharacter)}
                name={charDisplayName}
                relationValue={activeCharacter && activeCharacter.id !== 'xiaoyu' && !isStoryChar(activeCharacter) ? (activeCharacter.relation ?? 'friend') : xiaoyuRelation}
                onRelationChange={changeActiveRelation}
                showStoryStyle={structureOpen}
                onRequestMembership={onOpenMembership}
              />
            </div>
        </Modal>
      )}
      {/* 角色声音设置弹窗（VoxCPM2），受控：改动即生效；顶栏=当前角色的声音（小愈=全局，自定义角色=该角色） */}
      <VoiceSettingsModal
        open={voiceSettingsOpen}
        onClose={() => setVoiceSettingsOpen(false)}
        lang={getLang()}
        region={userRegion}
        name={voiceTarget ? voiceTarget.name : companionShortName()}
        config={voiceTarget ? voiceTargetCfg : voiceCfg}
        onChange={voiceTarget ? (cfg) => setActiveCharacter({ ...voiceTarget, ttsVoice: JSON.stringify(cfg) }) : setVoiceCfg}
        onSave={voiceTarget ? (cfg) => saveCharVoice(voiceTarget.id, cfg) : saveVoiceConfig}
        enabled={voiceEnabled}
        onEnabledChange={handleVoiceEnabledChange}
      />
    </div>
  );
}