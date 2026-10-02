/**
 * API服务模块
 * 处理与后端的所有通信
 */

import { getLang } from '../i18n';
import { getAttribution } from '../lib/attribution';
import { resetPreferencesCache } from '../lib/prefsCache';
import type { RoleplayMode } from '../lib/roleplayMode';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';
// 单次请求超时（ms）：避免请求挂死导致界面无限转圈
const API_TIMEOUT_MS = Number(import.meta.env.VITE_API_TIMEOUT_MS || 90000);
// 网络错误/429/5xx 重试次数（指数退避）；4xx 业务错误不重试
const API_MAX_RETRIES = 2;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 生成/获取设备指纹（canvas指纹 + 随机盐，持久化在 localStorage）
 * 用于服务端识别用户身份，实现免费次数限制
 */
function generateFingerprint(): string {
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (ctx) {
      canvas.width = 200; canvas.height = 40;
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(0, 0, 200, 40);
      ctx.fillStyle = '#069';
      ctx.fillText('cure-app-fp-2026', 10, 10);
      const data = canvas.toDataURL();
      let hash = 0;
      for (let i = 0; i < data.length; i++) {
        hash = ((hash << 5) - hash + data.charCodeAt(i)) | 0;
      }
      return 'fp' + Math.abs(hash).toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
  } catch { /* 忽略 */ }
  return 'fp-' + Math.random().toString(36).slice(2, 18);
}

export function getDeviceId(): string {
  try {
    const KEY = 'cure_app_device_id';
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = generateFingerprint();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return 'fp-' + Math.random().toString(36).slice(2, 18);
  }
}

/* ================= 登录态管理 ================= */

export interface AuthUser {
  userId: string;
  username: string | null;
  phone: string | null;
  email: string;
}

const TOKEN_KEY = 'cure_app_token';
const USER_KEY = 'cure_app_user';

export function getToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export function setAuth(token: string, user: AuthUser): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch { /* 忽略 */ }
}

export function getStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/* ================= 会员身份本地缓存 ================= */

const PLAN_CACHE_KEY = 'cure_membership_plan';

/** 读取缓存会员等级（仅未过期时生效）：首屏立即渲染 Pro/Plus 卡片，不等 getQuota 网络返回 */
export function getCachedPlan(): 'free' | 'plus' | 'pro' {
  try {
    const raw = localStorage.getItem(PLAN_CACHE_KEY);
    if (!raw) return 'free';
    const c = JSON.parse(raw) as { plan?: 'free' | 'plus' | 'pro'; unlockUntil?: number | null };
    if (c.plan && c.plan !== 'free' && c.unlockUntil && c.unlockUntil > Date.now()) return c.plan;
    return 'free';
  } catch { return 'free'; }
}

/** 读取缓存会员剩余天数（仅未过期时生效） */
export function getCachedDaysLeft(): number | null {
  try {
    const raw = localStorage.getItem(PLAN_CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as { plan?: 'free' | 'plus' | 'pro'; unlockUntil?: number | null };
    if (c.plan && c.plan !== 'free' && c.unlockUntil && c.unlockUntil > Date.now()) {
      return Math.max(0, Math.ceil((c.unlockUntil - Date.now()) / 86400000));
    }
    return null;
  } catch { return null; }
}

/** 写入会员身份缓存（free 且无到期时间时清除） */
export function setCachedPlan(plan: 'free' | 'plus' | 'pro', unlockUntil: number | null): void {
  try {
    if (plan === 'free' && !unlockUntil) localStorage.removeItem(PLAN_CACHE_KEY);
    else localStorage.setItem(PLAN_CACHE_KEY, JSON.stringify({ plan, unlockUntil }));
  } catch { /* 忽略 */ }
}

export function clearAuth(): void {
  // 偏好缓存随登录态一起清（2026-09-28 审查 B5）：api ⇄ prefsCache 的静态循环是安全的——
  // 两边都只在函数体内引用对方（不在模块初始化期调用），所以这里同步调用不会炸。
  try { resetPreferencesCache(); } catch { /* 忽略 */ }
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch { /* 忽略 */ }
  setCachedPlan('free', null); // 会员身份随登录态一并清除，避免串号展示
}

export function isLoggedIn(): boolean {
  return !!getToken();
}

export interface EmotionAnalysis {
  id: string;
  category?: string;
  emotion: string;
  intensity: number;
  timestamp: string;
  analysis: string;
  suggestions: string[];
}

export interface Question {
  id: string;
  question: string;
  type: string;
  purpose: string;
  answer?: string;
  timestamp: string;
}

export interface DetailedAnalysis {
  id: string;
  category?: string;
  valence?: 'positive' | 'negative' | 'neutral';
  emotionalState: string;
  triggers: string[];
  coreIssues: string[];
  positiveFactors: string[];
  recommendations: string[];
  timestamp: string;
}

export interface HealingStory {
  id: string;
  title: string;
  theme: string;
  readingTime: number;
  content: string;
  moral: string;
  mood: string;
  timestamp: string;
}

export interface UserSession {
  sessionId: string;
  emotionAnalysis?: EmotionAnalysis;
  questions: Question[];
  detailedAnalysis?: DetailedAnalysis;
  healingStory?: HealingStory;
  createdAt: string;
  updatedAt: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  /** 服务端 HTTP 状态码（非 2xx 时透传，便于前端按状态区分业务错误，如 402=额度不足）。 */
  status?: number;
  /** 服务端业务错误码（如 CHAT_QUOTA_EXCEEDED），与 status 搭配定位错误类型。 */
  code?: string;
}

/**
 * 组装请求头（设备指纹 / 语言 / 登录态）
 * 导出给子模块（如 `src/werewolf/api.ts`）复用，避免各自重写一套指纹/语言/登录态逻辑。
 */
export function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  const tz = getTimezoneHeader();
  return {
    'Content-Type': 'application/json',
    'X-Device-Id': getDeviceId(),
    'X-Lang': getLang(),
    // 本地时区（2026-09-19）：服务端「时间锚」要用它算**用户那边的今天/现在**。
    // 每个请求都带上（几十字节），这样**不必等用户去设置里开推送**才有时区：
    // 存量用户、游客、换设备/出国换时区的用户，从这一条请求起就立刻按自己的时区算。
    ...(tz ? { 'X-Timezone': tz } : {}),
    ...(getToken() ? { Authorization: 'Bearer ' + getToken() } : {}),
    ...(extra || {}),
  };
}

/** 浏览器时区（IANA，如 Asia/Hong_Kong）；只解析一次并缓存，避免每请求都建 Intl 实例 */
let cachedTimezone: string | null | undefined;
export function getTimezoneHeader(): string {
  if (cachedTimezone === undefined) {
    try { cachedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { cachedTimezone = null; }
  }
  return cachedTimezone || '';
}

/**
 * 后端错误文案本地化：后端统一返回中文错误串，这里按界面语言转成 en / zh-TW。
 * zh-CN 或未收录的串原样返回（避免误翻/漏翻）。
 */
const BACKEND_ERROR_EN: Record<string, string> = {
  // —— auth ——
  '邮箱验证码不正确，请先获取验证码并正确填写': 'The email code is incorrect. Please request a code and enter it correctly.',
  '请输入账号和密码': 'Please enter your email and password.',
  '账号或密码错误': 'Incorrect email or password.',
  '邮箱格式不正确': 'Invalid email format.',
  '该邮箱尚未注册': 'This email is not registered yet.',
  '该邮箱已注册，请直接登录': 'This email is already registered. Please log in instead.',
  '请完整填写邮箱、验证码和新密码': 'Please fill in your email, the code, and a new password.',
  '新密码至少6位': 'New password must be at least 6 characters.',
  '验证码错误或已过期': 'The code is incorrect or has expired.',
  '请先登录': 'Please log in first.',
  '原密码不正确': 'Your current password is incorrect.',
  '未登录': 'Not logged in.',
  '注销失败，请稍后重试': 'Account deletion failed. Please try again later.',
  // —— analysis / chat / structure ——
  '请提供有效的情绪描述': 'Please describe how you feel.',
  '未找到会话': 'Session not found.',
  '免费次数已用完，请付费解锁后继续使用': 'You have used up your free chats. Unlock more with membership to continue.',
  '请说点什么吧，或发一张图片': 'Say something, or send an image.',
  '聊天额度不足': 'Not enough chat quota.',
  '请提供会话ID': 'Session ID is required.',
  '未找到情感分析结果，请先进行情感分析': 'No analysis result found. Please run an analysis first.',
  '请提供有效的会话ID和答案': 'A valid session ID and answer are required.',
  '答案提交失败': 'Failed to submit your answer.',
  '未找到情感分析结果': 'No analysis result found.',
  '请先回答问题': 'Please answer the question first.',
  '未找到情绪理解结果，请先进行一次情绪分析': 'No emotion analysis found. Please run an analysis first.',
  '获取历史记录失败': 'Failed to load your records.',
  '获取聊天历史失败': 'Failed to load chat history.',
  '获取对话列表失败': 'Failed to load conversations.',
  '对话不存在或已过期': 'Conversation not found or expired.',
  '获取对话失败': 'Failed to load the conversation.',
  '删除对话失败': 'Failed to delete the conversation.',
  '没有可更新的内容': 'Nothing to update.',
  '更新对话失败': 'Failed to update the conversation.',
  '缺少会话ID或问题': 'Session ID or question is required.',
  '回答失败，请稍后重试': 'Failed to answer. Please try again later.',
  '获取会话信息失败': 'Failed to load session info.',
  // —— roleplay ——
  '剧本不存在': 'Story not found.',
  '缺少对话内容': 'Message content is missing.',
  '请先输入你想说的话': 'Please type what you want to say first.',
  '缺少剧本ID': 'Story ID is required.',
  '参数错误': 'Invalid parameters.',
  '人设、背景、开场均为必填': 'Persona, background and opening are all required.',
  '内容过长': 'Content is too long.',
  '内容包含不当信息，无法创建': 'Content was flagged as inappropriate. Unable to create.',
  // —— payment ——
  '缺少订单号': 'Order ID is required.',
  '订单无效或已过期，请重新下单': 'The order is invalid or has expired. Please place a new order.',
  '订单不存在': 'Order not found.',
  '当前无订阅可管理': 'No active subscription to manage.',
  'Stripe Webhook 未配置': 'Stripe webhook is not configured.',
  // —— user / diary ——
  '请填写反馈内容': 'Please enter your feedback.',
  '缺少图片数据': 'Image data is missing.',
  '无效的记忆索引': 'Invalid memory index.',
  '记忆不存在': 'Memory not found.',
  '请选择今天的心情': 'Please pick today\u2019s mood.',
  // —— 前端本地回退串（也走同一转译） ——
  'API响应格式错误': 'Invalid API response format.',
};
const BACKEND_ERROR_TW: Record<string, string> = {
  '邮箱验证码不正确，请先获取验证码并正确填写': '信箱驗證碼不正確，請先取得驗證碼並正確填寫。',
  '请输入账号和密码': '請輸入帳號和密碼。',
  '账号或密码错误': '帳號或密碼錯誤。',
  '邮箱格式不正确': '信箱格式不正確。',
  '该邮箱尚未注册': '該信箱尚未註冊。',
  '该邮箱已注册，请直接登录': '該信箱已註冊，請直接登入。',
  '请完整填写邮箱、验证码和新密码': '請完整填寫信箱、驗證碼和新密碼。',
  '新密码至少6位': '新密碼至少 6 位。',
  '验证码错误或已过期': '驗證碼錯誤或已過期。',
  '请先登录': '請先登入。',
  '原密码不正确': '原密碼不正確。',
  '未登录': '未登入。',
  '注销失败，请稍后重试': '註銷失敗，請稍後再試。',
  '请提供有效的情绪描述': '請提供有效的情緒描述。',
  '未找到会话': '找不到會話。',
  '免费次数已用完，请付费解锁后继续使用': '免費次數已用完，請付費解鎖後繼續使用。',
  '请说点什么吧，或发一张图片': '請說點什麼吧，或發一張圖片。',
  '聊天额度不足': '聊天額度不足。',
  '请提供会话ID': '請提供會話 ID。',
  '未找到情感分析结果，请先进行情感分析': '找不到情感分析結果，請先進行情感分析。',
  '请提供有效的会话ID和答案': '請提供有效的會話 ID 和答案。',
  '答案提交失败': '答案提交失敗。',
  '未找到情感分析结果': '找不到情感分析結果。',
  '请先回答问题': '請先回答問題。',
  '未找到情绪理解结果，请先进行一次情绪分析': '找不到情緒理解結果，請先進行一次情緒分析。',
  '获取历史记录失败': '取得歷史記錄失敗。',
  '获取聊天历史失败': '取得聊天歷史失敗。',
  '获取对话列表失败': '取得對話列表失敗。',
  '对话不存在或已过期': '對話不存在或已過期。',
  '获取对话失败': '取得對話失敗。',
  '删除对话失败': '刪除對話失敗。',
  '没有可更新的内容': '沒有可更新的內容。',
  '更新对话失败': '更新對話失敗。',
  '缺少会话ID或问题': '缺少會話 ID 或問題。',
  '回答失败，请稍后重试': '回答失敗，請稍後再試。',
  '获取会话信息失败': '取得會話資訊失敗。',
  '剧本不存在': '劇本不存在。',
  '缺少对话内容': '缺少對話內容。',
  '请先输入你想说的话': '請先輸入你想說的話。',
  '缺少剧本ID': '缺少劇本 ID。',
  '参数错误': '參數錯誤。',
  '人设、背景、开场均为必填': '人設、背景、開場均為必填。',
  '内容过长': '內容過長。',
  '内容包含不当信息，无法创建': '內容包含不當資訊，無法建立。',
  '缺少订单号': '缺少訂單號。',
  '订单无效或已过期，请重新下单': '訂單無效或已過期，請重新下單。',
  '订单不存在': '訂單不存在。',
  '当前无订阅可管理': '目前沒有可管理的訂閱。',
  'Stripe Webhook 未配置': 'Stripe Webhook 未配置。',
  '请填写反馈内容': '請填寫回饋內容。',
  '缺少图片数据': '缺少圖片資料。',
  '无效的记忆索引': '無效的記憶索引。',
  '记忆不存在': '記憶不存在。',
  '请选择今天的心情': '請選擇今天的心情。',
  'API响应格式错误': 'API 回應格式錯誤。',
};
function translateBackendError(err: string): string {
  if (!err) return err;
  const lang = getLang();
  if (lang === 'zh-CN') return err;
  const key = err.trim();
  if (lang === 'en' && BACKEND_ERROR_EN[key]) return BACKEND_ERROR_EN[key];
  if (lang === 'zh-TW' && BACKEND_ERROR_TW[key]) return BACKEND_ERROR_TW[key];
  return err;
}
function httpErrPrefix(): string {
  const lang = getLang();
  return lang === 'en' ? 'HTTP error: ' : lang === 'zh-TW' ? 'HTTP 錯誤: ' : 'HTTP错误: ';
}

// —— 通用「免费额度用尽」门控：任何接口/流式返回这些 code，都统一触发「注册/获取额度」弹窗 ——
const QUOTA_EXHAUSTED_CODES = new Set(['QUOTA_EXCEEDED', 'CHAT_QUOTA_EXCEEDED']);
function isFreeQuotaExhausted(code?: string): boolean {
  return !!code && QUOTA_EXHAUSTED_CODES.has(code);
}
function notifyQuotaExhausted(): void {
  try { window.dispatchEvent(new CustomEvent('xiaoyu:quota-exhausted')); } catch { /* 忽略 */ }
}

/**
 * 通用API请求函数
 * 导出给子模块（如 `src/werewolf/api.ts`）复用重试/超时/错误本地化逻辑。
 */
export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit & { timeoutMs?: number; retries?: number } = {}
): Promise<ApiResponse<T>> {
  const url = API_BASE_URL + endpoint;
  // 允许单请求覆盖超时（如 AI 整份剧本生成要走多次 DeepSeek，耗时可远超默认 90s）
  // `retries` 同理：交互式读取（点开一个会话）不该把 3 次超时串起来让用户干等
  const { timeoutMs = API_TIMEOUT_MS, retries = API_MAX_RETRIES, ...fetchOptions } = options;
  // 仅幂等方法（GET/HEAD/OPTIONS）自动重试；POST/PUT/DELETE 不重试，
  // 避免「服务端已成功但响应超时」时重试导致重复扣费/重复写。
  const method = (fetchOptions.method || 'GET').toUpperCase();
  const idempotent = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  const mergedHeaders: Record<string, string> = buildHeaders((fetchOptions.headers as Record<string, string>) || {});

  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(600 * Math.pow(2, attempt - 1));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...fetchOptions, headers: mergedHeaders, signal: controller.signal });

      if (response.ok) {
        const data = await response.json();
        // 确保返回的数据符合 ApiResponse 格式
        if (typeof data !== 'object' || data === null) {
          return { success: false, error: translateBackendError('API响应格式错误') };
        }
        // 如果响应没有 success 字段，假设它是成功的
        if (!Object.prototype.hasOwnProperty.call(data, 'success')) {
          return { success: true, data: data as T };
        }
        return data;
      }

      // HTTP 错误：4xx（除 429）为业务错误直接返回；429/5xx 可重试
      const status = response.status;
      const retryable = idempotent && (status === 429 || status >= 500);
      let errText = httpErrPrefix() + status + ' ' + response.statusText;
      let errCode = '';
      try {
        const errBody = await response.json();
        if (errBody && typeof errBody === 'object' && typeof errBody.error === 'string' && errBody.error) {
          errText = errBody.error;
        }
        if (errBody && typeof errBody === 'object' && typeof errBody.code === 'string' && errBody.code) {
          errCode = errBody.code;
        }
      } catch { /* 响应体非 JSON，用回退文案 */ }

      // 401 且当前携带 token → 登录态已失效/过期：清除本地 token 并通知界面（登录接口除外，避免误清）
      if (status === 401 && getToken() && endpoint !== '/api/auth/login') {
        clearAuth();
        try { window.dispatchEvent(new CustomEvent('auth-expired')); } catch { /* 忽略 */ }
      }

      if (!retryable || attempt === API_MAX_RETRIES) {
        if (isFreeQuotaExhausted(errCode)) notifyQuotaExhausted();
        return { success: false, error: translateBackendError(errText), status, code: errCode || undefined };
      }
      lastError = errText; // 429/5xx：继续重试
    } catch (e) {
      const isTimeout = e instanceof Error && e.name === 'AbortError';
      const isNetwork = e instanceof Error && e.name === 'TypeError';
      // 仅幂等方法对超时/网络错误重试；写操作不重试（可能已被服务端处理）
      if (!idempotent || (!isTimeout && !isNetwork) || attempt === API_MAX_RETRIES) {
        return { success: false, error: '' };
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return { success: false, error: translateBackendError(lastError) };
}

/**
 * 情感分析API
 */
export async function analyzeEmotion(
  emotionInput: string,
  sessionId?: string,
  characterId?: string
): Promise<ApiResponse<{ sessionId: string; analysis: EmotionAnalysis }>> {
  return apiRequest('/api/analysis/analyze', {
    method: 'POST',
    body: JSON.stringify({ emotionInput, sessionId, characterId }),
  });
}

/** 引用回复指向的那条消息（落库 + 供界面「点引用块跳回原消息」定位） */
export interface ReplyToRef {
  role: 'user' | 'assistant';
  content: string;
  /** 被引用的是「纯图片/纯语音」消息（本身没有文字）时记下类型，引用卡用占位词而不是空白卡 */
  kind?: 'image' | 'audio';
  /** 被引用消息的时间戳——回跳定位用它（消息 id 会随刷新而变，时间戳不会） */
  at?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  image?: string; // 用户消息附带的图片（base64 data URL）
  audio?: string; // 微信式语音气泡：用户消息附带的录音 data URL（可点播；模型靠 content 的理解）
  /** 被引用的消息（引用回复）：本地会话内展示 + 落库（刷新后引用卡还在） */
  replyTo?: ReplyToRef;
  /**
   * 这条回复的**来源链接**（2026-09-29）：本轮 `web_search` 命中的结构化结果（服务端收口，最多 5 条）。
   * 有它才谈得上「用户不必先知道可以要链接」——在这之前前端只收到一个布尔 search 事件，
   * 出处全凭模型自觉把 URL 写进正文。缺省 undefined = 这轮没搜索（或历史老数据）；
   * **不要**用 `[]` 回填，那会把「没搜」和「搜了没结果」混成同一件事。
   */
  sources?: ChatSource[];
  /**
   * **按段**的来源（段下标＝气泡下标；null = 该段没有引用）：这条回复按 \n\n 分段发送时，
   * 每段各自能挂自己的出处。与 `sources`（整轮）并存 —— 渲染时最后一段会把两者合并。
   * 拆分口径必须与写入侧一致：split('\n\n') → trim → 丢空段。
   */
  sourceSegments?: (ChatSource[] | null)[];
}

/** 一条来源（标题 + 链接）。界面只显示域名，完整标题走 title / aria-label。 */
export interface ChatSource {
  title: string;
  url: string;
  /** 展示用域名（发布方）：Google News 这类聚合链接的 url 域名没有信息量（见 api/services/news.ts 的 rssPublisherHost） */
  host?: string;
}

/**
 * 聊一聊「角色扮演指令分流」提示类型（后端 /api/analysis/chat[/stream] 命中时返回）：
 * - roleplay：用户想玩角色扮演/进剧情 → 前端给「去剧情演绎（可自建剧本）」卡片
 * - chatCharacter：用户想让 AI 扮演某个具体角色 → 前端给「在聊一聊新建角色」卡片
 * - adultRoleplay：用户想聊情欲 / 成人向内容（2026-09-25）→ 前端给「去剧情演绎开『无限制模式』」卡片，
 *   主按钮进剧情后**自动展开「我的偏好」抽屉**（把用户送到那个开关面前，而不是只丢个功能名）；
 *   口径与提示词层（chatVoice.ts 的 buildChatAdultRedirectBlock）一致：不冷拒、给一条走得通的路。
 *
 * `hintCompact = true`（2026-09-25 追加）：**小愈已经在自己的回复里把这件事说清楚了**（戏内升级那条路，
 * 见 api/services/chatRedirect.ts 的 shouldAttachAdultHint）⇒ 前端**只渲染一个直达按钮**，不重复整张说明卡。
 * 用户原话：「要有一个直达的按键而不只是信息说明」。
 */
export type ChatRedirectHint = 'roleplay' | 'chatCharacter' | 'adultRoleplay';

/**
 * AI 失败埋点（2026-09-15 事故后加）
 *
 * 事故教训：这一轮「AI 没接上」在服务端**完全静默**（连接在传输层断掉），运营端看不到任何异常，
 * 只能等用户投诉。这里把失败的 功能 + 原因码（+ 是否被自动重试救回）上报，让运营端看得见。
 *
 * 只报功能/原因码/是否恢复，**不含任何用户内容、不含 userId**；fire-and-forget，绝不影响主流程。
 */
export function reportAiFailure(feature: 'chat' | 'roleplay' | 'wenyou' | 'other', code: string, recovered = false): void {
  try {
    void apiRequest('/api/ai-failure', {
      method: 'POST',
      body: JSON.stringify({ feature, code, recovered }),
      timeoutMs: 8000,
    }).catch(() => { /* 埋点失败静默 */ });
  } catch { /* 埋点失败静默 */ }
}

/**
 * 流式请求的「空闲超时」守卫。
 *
 * 为什么需要它：浏览器 fetch 只能吃一个 signal，之前写法是 `signal: handlers.signal || controller.signal`
 * ——调用方一旦传了自己的 signal（聊一聊 / 剧情都传），内部的 N 秒超时就**完全失效**了：
 * 连接死掉时请求可以一直挂着（2026-09-15 线上：用户 13:02:58 发的消息，13:40:06 才收到失败提示，
 * 中间 37 分钟只有一个转圈）。这里把两者合并：外部取消照样传播，同时**空闲**超过阈值就中断。
 * 用「空闲」而不是「总时长」：正常的长回复/工具轮可能超过阈值，服务端每 12s 有心跳，不会误杀。
 */
function createIdleGuard(controller: AbortController, idleMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;
  return {
    /** 重新开始计时（拿到任何数据后都调用一次） */
    arm() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { fired = true; controller.abort(); }, idleMs);
    },
    stop() {
      if (timer) { clearTimeout(timer); timer = null; }
    },
    get fired() { return fired; },
  };
}

/** 流式失败的粗分类：供界面决定「用户自己取消 → 静默」还是「失败 → 提示 + 重试」 */
export type StreamFailReason = 'ABORTED' | 'TIMEOUT' | 'NETWORK';
function streamFailReason(idleFired: boolean, external?: AbortSignal): StreamFailReason {
  if (external?.aborted) return 'ABORTED';
  if (idleFired) return 'TIMEOUT';
  return 'NETWORK';
}

/**
 * 聊一聊（对话陪伴模式）发送消息
 */
export async function chatSend(
  sessionId: string | null,
  message: string,
  image?: string,
  /** 引用回复：这条消息在回复哪一句（后端落库 + 注入提示词「本轮回复指向」） */
  replyTo?: ReplyToRef
): Promise<ApiResponse<{ sessionId: string; reply: string; title?: string; hint?: ChatRedirectHint; hintCompact?: boolean; messages: { role: 'user' | 'assistant'; content: string; timestamp: string; image?: string }[] }>> {
  return apiRequest('/api/analysis/chat', {
    method: 'POST',
    body: JSON.stringify({ sessionId, message, image, ...(replyTo ? { replyTo } : {}) }),
  });
}

/**
 * 聊一聊流式发送（SSE 打字机效果）
 * 边生成边回调 onDelta(delta)；完成后 resolve 与 chatSend 相同结构的数据
 */
export async function chatSendStream(
  sessionId: string | null,
  message: string,
  handlers: { onDelta?: (delta: string) => void; onSearch?: () => void; signal?: AbortSignal } = {},
  image?: string,
  audio?: string,
  characterId?: string,
  region?: string,
  intensity?: string,
  chatInnerMonologueEnabled?: boolean,
  thinkingLevel?: ThinkingLevel,
  /** 重试上一回合：服务端据此避免把同一条用户消息重复写进会话（否则 AI 上下文里会出现两遍） */
  retry?: boolean,
  /** 引用回复：这条消息在回复哪一句（后端落库 + 注入提示词；重试时后端自己从会话里取，无需重发） */
  replyTo?: ReplyToRef,
  /**
   * 「编辑重发」（2026-09）：被改写那条用户消息的**时间戳（毫秒）**。
   *
   * 为什么用时间戳而不是下标/id：消息 id 是前端每次加载现生成的（刷新即变），下标在服务端历史被
   * 截断（MAX_CHAT_MSGS）后会错位；时间戳落库、跨设备一致 —— 引用回复的 `at` 也用同一套理由。
   * 服务端只认「它正好是**最后一条**用户消息」的情况（2A），对不上就当普通新消息处理（绝不清历史）。
   */
  editAt?: number
): Promise<ApiResponse<{ sessionId: string; reply: string; title?: string; hint?: ChatRedirectHint; hintCompact?: boolean; sources?: ChatSource[]; sourceSegments?: (ChatSource[] | null)[]; revised?: boolean }>> {
  const controller = new AbortController();
  const guard = createIdleGuard(controller, API_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  if (handlers.signal) {
    if (handlers.signal.aborted) controller.abort();
    else handlers.signal.addEventListener('abort', onExternalAbort);
  }
  guard.arm();
  try {
    const response = await fetch(API_BASE_URL + '/api/analysis/chat/stream', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ sessionId, message, image, audio, characterId, region, intensity, chatInnerMonologueEnabled, thinkingLevel, ...(retry ? { retry: true } : {}), ...(replyTo ? { replyTo } : {}), ...(typeof editAt === 'number' && editAt > 0 ? { editAt } : {}) }),
      signal: controller.signal,
    });

    if (!response.ok) {
      let errText = httpErrPrefix() + response.status + ' ' + response.statusText;
      let errCode = '';
      try {
        const errBody = await response.json();
        if (errBody && typeof errBody === 'object' && typeof errBody.error === 'string' && errBody.error) errText = errBody.error;
        if (errBody && typeof errBody === 'object' && typeof errBody.code === 'string' && errBody.code) errCode = errBody.code;
      } catch { /* 非 JSON */ }
      if (response.status === 401 && getToken()) {
        clearAuth();
        try { window.dispatchEvent(new CustomEvent('auth-expired')); } catch { /* 忽略 */ }
      }
      if (isFreeQuotaExhausted(errCode)) notifyQuotaExhausted();
      return { success: false, error: translateBackendError(errText), status: response.status, code: errCode || undefined };
    }

    if (!response.body) return { success: false, error: '' };
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let doneData: { sessionId: string; reply: string; title?: string; hint?: ChatRedirectHint; hintCompact?: boolean; sources?: ChatSource[]; sourceSegments?: (ChatSource[] | null)[]; revised?: boolean } | null = null;
    let streamError = '';
    let streamCode = '';

    while (true) {
      const { done, value } = await reader.read();
      guard.arm(); // 拿到数据（含服务端 `: ping` 心跳）→ 连接还活着
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.indexOf('data:') !== 0) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const ev = JSON.parse(payload);
          if (ev.type === 'delta' && typeof ev.content === 'string') handlers.onDelta?.(ev.content);
          else if (ev.type === 'search') handlers.onSearch?.();
          else if (ev.type === 'done') doneData = ev.data;
          else if (ev.type === 'error' && ev.error) { streamError = ev.error; streamCode = typeof ev.code === 'string' ? ev.code : ''; }
        } catch { /* 忽略 */ }
      }
    }

    if (doneData) return { success: true, data: doneData };
    return { success: false, error: streamError, code: streamCode || undefined };
  } catch {
    // 失败原因不再吞掉：区分「用户自己切走/取消」/「等太久（空闲超时）」/「网络断了」
    return { success: false, error: '', code: streamFailReason(guard.fired, handlers.signal) };
  } finally {
    guard.stop();
    handlers.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/** 聊一聊多对话：单个对话的列表元信息 */
export interface ChatSessionMeta {
  sessionId: string;
  title: string;
  preview: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean; // 是否置顶（置顶会话排在列表最前）
  characterId?: string; // 所属聊一聊角色（缺省 = 小愈）
  /** 这条会话自己的未读条数（第二层「多对话」抽屉里指出来是哪一条还有未读；缺省=老接口不带） */
  unread?: number;
}

/**
 * 获取当前用户的聊一聊对话列表（按最近更新倒序）
 * `opts.timeoutMs` / `opts.retries`：交互式读取用（打开一个聊天不该等满默认 90s×3 次重试
 * —— 2026-09-21 真机走查：服务端抖动时用户会盯着「正在恢复上次对话…」转很久）。
 */
export async function getChatSessions(opts?: { timeoutMs?: number; retries?: number }): Promise<ApiResponse<ChatSessionMeta[]>> {
  return apiRequest('/api/analysis/chats', opts);
}

/**
 * 获取单个聊一聊对话的消息（`opts` 同上，供交互式打开会话时收短超时并关掉自动重试）
 */
export async function getChatSession(sessionId: string, opts?: { timeoutMs?: number; retries?: number }): Promise<ApiResponse<{ sessionId: string; title: string; characterId?: string; messages: { role: 'user' | 'assistant'; content: string; timestamp: string; image?: string; audio?: string; replyTo?: ReplyToRef }[] }>> {
  return apiRequest('/api/analysis/chats/' + encodeURIComponent(sessionId), opts);
}

/**
 * 删除单个聊一聊对话
 */
export async function deleteChatSession(sessionId: string): Promise<ApiResponse<{ message: string }>> {
  return apiRequest('/api/analysis/chats/' + encodeURIComponent(sessionId), { method: 'DELETE' });
}

/**
 * 重命名聊一聊对话
 */
export async function renameChatSession(sessionId: string, title: string): Promise<ApiResponse<{ sessionId: string; title: string }>> {
  return apiRequest('/api/analysis/chats/' + encodeURIComponent(sessionId), { method: 'PATCH', body: JSON.stringify({ title }) });
}

/**
 * 置顶 / 取消置顶聊一聊对话
 */
export async function pinChatSession(sessionId: string, pinned: boolean): Promise<ApiResponse<{ sessionId: string; pinned: boolean }>> {
  return apiRequest('/api/analysis/chats/' + encodeURIComponent(sessionId), { method: 'PATCH', body: JSON.stringify({ pinned }) });
}

/** 剧情摘要档案（剧情角色：共同经历 / 未完成的线 / 口吻特征） */
export interface StoryDigestView {
  summary: string;
  keyEvents: { text: string; date?: string }[];
  openThreads: string[];
  voiceTraits?: string;
  msgCount: number;
  at: number;
}

/** 剧情出身绑定（聊一聊角色的来源 = 哪部剧本、剧内叫什么） */
export interface StoryBindingView {
  scenarioId: string;
  scenarioTitle: string;
  kind: 'official' | 'custom';
  aiName: string;
  userName: string;
  importedAt: number;
  syncedMsgCount: number;
  syncedAt?: number;
  digest?: StoryDigestView;
}

/** 「TA 记得的这段剧情」只读回看（GET /chat/characters/:id/story） */
export interface StoryView {
  binding: StoryBindingView;
  mode: 'in' | 'out';
  blocks: { id: string; at: number; from: number; to: number; text: string }[];
  liveMsgCount: number;
  /** 剧情那边又玩了几条（>0 时可以提示「同步这段剧情」） */
  pendingMsgCount: number;
}

/** 聊一聊自定义角色（灵魂框架：identity / boundaries / voice / opening） */
export interface ChatCharacterMeta {
  id: string;
  name: string;
  avatar?: string;
  identity: string;
  boundaries: string;
  voice: string;
  ttsVoice?: string;
  opening?: string;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
  /** 来源：缺省 = 用户自建；'story' = 从剧情模式导入的剧情角色 */
  origin?: 'user' | 'story';
  story?: StoryBindingView;
  /** 剧情角色双态：in 入戏（默认）/ out 出戏 */
  storyMode?: 'in' | 'out';
  useCompanionMode?: boolean;
  /**
   * 关系档（2026-09-21）：朋友/损友/家人/恋人，每角色一档；缺省 = 朋友。
   * 只影响聊一聊的口吻参数（称呼/分寸/玩梗强度/连发条数），不影响内容尺度。
   */
  relation?: ChatRelationKind;
}

/** 聊一聊关系档（与后端 `api/services/chatRelation.ts` 的 RelationKind 一一对应） */
export type ChatRelationKind = 'friend' | 'buddy' | 'family' | 'lover';

/** 获取当前用户的聊一聊角色列表（含内置小愈，第一位） */
export async function getChatCharacters(): Promise<ApiResponse<ChatCharacterMeta[]>> {
  return apiRequest('/api/analysis/chat/characters');
}

/** 新建自定义角色（需登录；人设内容会过安全过滤；首次创建会送 1 次 AI 剧本生成额度） */
export interface ChatCharacterGift { type: string; genCredit: number }
export async function createChatCharacter(data: { name: string; avatar?: string; identity: string; boundaries: string; voice: string; ttsVoice?: string; opening?: string; relation?: ChatRelationKind }): Promise<ApiResponse<ChatCharacterMeta & { gift?: ChatCharacterGift | null }>> {
  return apiRequest('/api/analysis/chat/characters', { method: 'POST', body: JSON.stringify(data) });
}

/** 狼人杀自建角色内容安全校验（红线⑤）：本地自建/导入的人设也要过服务端同一张过滤词表 */
export async function checkWolfchaCharacterSafety(fields: string[]): Promise<ApiResponse<{ safe: boolean; code?: string }>> {
  return apiRequest('/api/wolfcha-compat/custom-character/check', { method: 'POST', body: JSON.stringify({ fields }) });
}

/** 更新自定义角色（含剧情角色的双态开关 storyMode） */
export async function updateChatCharacter(id: string, data: Partial<{ name: string; avatar?: string; identity: string; boundaries: string; voice: string; ttsVoice?: string; opening?: string; storyMode: 'in' | 'out'; relation: ChatRelationKind }>): Promise<ApiResponse<ChatCharacterMeta>> {
  return apiRequest('/api/analysis/chat/characters/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(data) });
}

/**
 * 把一段剧情导入成聊一聊角色（方案 A1）。
 * 幂等：同一剧本重复调用 = 刷新该角色的人设与记忆（不会新建第二个）。
 */
export async function importStoryCharacter(data: { scenarioId: string; aiName?: string; userName?: string; storyMode?: 'in' | 'out' }): Promise<ApiResponse<{ character: ChatCharacterMeta; created: boolean; msgCount: number; blockCount: number; digestByModel: boolean }>> {
  return apiRequest('/api/analysis/chat/characters/import-story', { method: 'POST', body: JSON.stringify(data) });
}

/** 增量同步：把剧情那边的新进展并进该角色的记忆 */
export async function syncStoryCharacter(id: string): Promise<ApiResponse<{ added: number; syncedMsgCount: number; byModel: boolean }>> {
  return apiRequest('/api/analysis/chat/characters/' + encodeURIComponent(id) + '/story-sync', { method: 'POST', body: JSON.stringify({}) });
}

/** 「TA 记得的这段剧情」（只读回看） */
export async function getCharacterStory(id: string): Promise<ApiResponse<StoryView>> {
  return apiRequest('/api/analysis/chat/characters/' + encodeURIComponent(id) + '/story');
}

/**
 * 微信式消息列表（方案 A2）：**一个角色一行** —— 最后一条 / 时间 / 未读数（跨该角色的多条会话求和）。
 * 未读口径：`chatLastReadAt` 之后角色说过的话（老会话没有该字段 = 视为已读，不会一上线全是红点）。
 */
export interface ChatInboxRow {
  characterId: string;
  sessionId: string;
  title: string;
  preview: string;
  /** 最后一条是谁说的（列表里用「我：」区分自己说的） */
  lastRole: 'user' | 'assistant';
  updatedAt: number;
  unread: number;
  pinned: boolean;
  messageCount: number;
  /** 该角色真正有未读的那条会话（点列表行时打开它）；没有未读时为空串 */
  unreadSessionId: string;
}

export async function getChatInbox(): Promise<ApiResponse<ChatInboxRow[]>> {
  return apiRequest('/api/analysis/chat/inbox');
}

/**
 * 标记已读。
 * `upTo` = 屏幕上最后一条消息的时间戳（ms）——**必须传**，否则流式过程中那次已读会把
 * "服务端随后才落库的这条回复"算成未读（用户会看到"有红点、进去却没有新消息"）。
 */
export async function markChatRead(data: { sessionId?: string; characterId?: string; upTo?: number }): Promise<ApiResponse<{ marked: number }>> {
  return apiRequest('/api/analysis/chat/read', { method: 'POST', body: JSON.stringify(data) });
}

/** 删除自定义角色（内置小愈不可删） */
export async function deleteChatCharacter(id: string): Promise<ApiResponse<boolean>> {
  return apiRequest('/api/analysis/chat/characters/' + encodeURIComponent(id), { method: 'DELETE' });
}

/** 长期记忆条目（带时间轴，2026-09-17）：at=时间锚，kind=durable/state/event/plan，stale=已过期或可能已变 */
export interface MemoryEntryView {
  text: string;
  at: number;
  kind: string;
  atApprox?: boolean;
  dateKey?: string;
  stale?: boolean;
}

/** 自定义角色成长档案（关系记忆 / 日记 / 反思 / 自画像）——只读观景窗 */
export interface ChatCharacterGrowth {
  userId: string;
  characterId: string;
  relationship: { text: string; at: number }[];
  diary: { text: string; at: number }[];
  reflections: { text: string; at: number }[];
  selfPortrait?: { text: string; at: number };
  portraitHistory?: { text: string; at: number }[];
  userFacts?: string[];
  /** 同上，带时间轴（观景窗显示「记住于 X」） */
  userFactEntries?: MemoryEntryView[];
  exchangeCount: number;
  lastReflectAt: number;
  lastPortraitAt: number;
  updatedAt: number;
}

export async function getChatCharacterGrowth(id: string): Promise<ApiResponse<ChatCharacterGrowth>> {
  return apiRequest('/api/analysis/chat/characters/' + encodeURIComponent(id) + '/growth');
}

/** 按访问者 IP 建议默认界面语言（首次访问无语言记录时调用；返回 null 表示不建议/失败） */
export async function getGeoLang(timeoutMs?: number): Promise<string | null> {
  try {
    const r = await apiRequest<{ lang: string }>('/api/geo/lang', timeoutMs !== undefined ? { timeoutMs } : undefined);
    if (r.success && r.data && (r.data.lang === 'zh-CN' || r.data.lang === 'zh-TW' || r.data.lang === 'en')) return r.data.lang;
  } catch { /* 忽略 */ }
  return null;
}

/** 访问者地理信息（country / region / 是否中国大陆；2026-09-23 起不再用于隐藏微信支付入口） */
export interface MyGeo {
  country: string;
  region: string;
  isMainland: boolean;
}

/** 获取访问者地理信息（country / region / 是否中国大陆） */
export async function getMyGeo(): Promise<ApiResponse<MyGeo>> {
  return apiRequest('/api/geo/me');
}

/**
 * 生成问题API
 */

/**
 * 获取聊一聊历史记录（跨会话聚合，按时间正序）
 */
export async function getChatHistory(): Promise<ApiResponse<{ role: 'user' | 'assistant'; content: string; timestamp: string }[]>> {
  return apiRequest('/api/analysis/chat-history');
}

export async function generateQuestions(
  sessionId: string
): Promise<ApiResponse<{ questions: Question[] }>> {
  return apiRequest('/api/analysis/questions', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  });
}

/**
 * 提交答案API
 */
export async function submitAnswers(
  sessionId: string,
  answers: { questionId: string; answer: string }[]
): Promise<ApiResponse<{ message: string }>> {
  return apiRequest('/api/analysis/answers', {
    method: 'POST',
    body: JSON.stringify({ sessionId, answers }),
  });
}

/**
 * 生成详细分析API
 */
export async function generateDetailedAnalysis(
  sessionId: string
): Promise<ApiResponse<{ analysis: DetailedAnalysis }>> {
  return apiRequest('/api/analysis/detailed-analysis', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  });
}

/**
 * 生成暖心故事API
 */
export async function generateHealingStory(
  sessionId: string
): Promise<ApiResponse<{ story: HealingStory }>> {
  return apiRequest('/api/analysis/story', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  });
}

/**
 * 获取会话信息API
 */
export async function getSession(
  sessionId: string
): Promise<ApiResponse<{ session: UserSession }>> {
  return apiRequest(`/api/analysis/session/${sessionId}`);
}

/**
 * 健康检查API
 */
export async function healthCheck(): Promise<ApiResponse<{ message: string }>> {
  return apiRequest('/api/health');
}

/* ================= 配额与付费 ================= */

export interface QuotaInfo {
  freeTotal: number;
  freeUsed: number;
  bonusFree: number;
  remainFree: number; // 理一理剩余次数
  chatFreeRemain?: number; // 对话剩余条数（聊一聊/角色扮演共用）
  chatBonusFree?: number; // 对话池已获得的注册奖励
  registerChatBonus?: number; // 活动期内注册可送的对话额度（前端提示用）
  registerProPromoActive?: boolean; // 新人 Pro 限时活动是否进行中（注册页优先提示用）
  registerProDays?: number; // 新人注册即送的 Pro 天数（0=未开启）
  unlockUntil: number | null;
  unlocked: boolean;
  canUse: boolean;
  plan?: 'free' | 'plus' | 'pro';
  lifetime?: boolean; // 买断·终身（前端展示「永久会员」）
  chatUsedToday?: number;
  chatLimitPerDay?: number | null; // null = 无限（Pro）
  // 待通知奖励；note = 运营者随奖励写的话（目前仅反馈奖励会带），站内弹窗据它展示原文
  pendingReward?: { count: number; reason: string; at: number; note?: string } | null;
  trialProActive?: boolean; // 老用户 7 天 Pro 体验中
  trialProUntil?: number | null; // 体验到期时间戳
  genCredit?: number; // 额外 AI 剧本生成额度
  userId?: string; // 解析后的用户标识（游客为设备指纹+IP 哈希），用于生成稳定邀请链接
  // —— 统一点数（credit）：账本用点数，用户可见单位是「条」（整数价目表；真实用量也四舍五入到整条）——
  creditEnabled?: boolean; // 是否开启点数计费（决定显示「旧条数」还是「点数折算的条数」）
  creditUnlimited?: boolean; // 统一口径下的 Pro：无限（此时 creditRemain 为 null，**不能**当成 0）
  /** 最近 7 天的分模式日均用量（推荐器预填；从未用过则为 null） */
  usage7d?: { chat: number; textgame: number; structure: number; werewolf: number } | null;
  creditRemain?: number;    // 剩余点数（bonus + 每日剩余）
  creditDailyCap?: number | null; // 每日点数上限（Pro 也设兜底，非 null）
  creditUsedToday?: number;
  creditBonus?: number;     // 持久赠送点数
  unitCredit?: number;      // 1 标准单次 ≈ 普通聊一聊短消息平均点数（默认 2）
  /**
   * 分档日额度（点数）：**文案的唯一数字来源**（游客 5 条/天、注册 20 条/天）。
   * 前端任何地方都不许写死这两个数字——改 `.env`（`GUEST_DAILY_TIAO` / `FREE_DAILY_CREDIT`）就全局跟着变。
   */
  guestDailyCredit?: number; // 游客档（未注册）
  freeDailyCredit?: number;  // 注册免费档
  /**
   * 已填过的预设邀请码（null / undefined = 还没填过）。
   * 登录账号才有值；「补填邀请码」入口据此显示——填过就隐藏，游客为 null 也不显示。
   */
  inviteCode?: string | null;
  /** Google OAuth Client ID（公开值）。服务端未配置时不返回；前端据此决定是否渲染「用 Google 继续」 */
  googleClientId?: string;
}

/**
 * 聊天额度换算（「≈ 还能聊 N 条」）+ 无限档判定**只有一处实现** → 见 `src/lib/quotaDisplay.ts`
 * （纯函数，可被 `test/unit/quotaDisplay.test.ts` 直接覆盖；老位置在 api.ts 里测不到）。
 *
 * ⚠️ `quotaChatRemain()` 对**无限档**（Pro / 终身 / 7 天 Pro 体验）返回的是 JS 的 `Infinity`——
 *    它是内部哨兵值，**不能**直接插进 i18n 模板，否则线上会印出英文 `Infinity`
 *    （2026-09-17 真机：「額度剩餘 ≈ 還能聊 Infinity 條」）。渲染前先问 `quotaIsUnlimited()`。
 */
export { quotaChatRemain, quotaIsUnlimited, type QuotaRemainFields } from '../lib/quotaDisplay';

export type PlanKey = 'plus' | 'pro';

/** 购买方式：月付 / 年付 / 买断·终身 */
export type PayTerm = 'monthly' | 'yearly' | 'lifetime';

/** 单档位三币种价格（USD / HKD / CNY，含开业优惠原价） */
export interface PlanPrice {
  usd: number;
  hkd: number;
  cny: number;
  /** 开业优惠：划线原价（默认 2×现价） */
  originalUsd?: number;
  originalHkd?: number;
  originalCny?: number;
  /** 开业折扣（%） */
  discountPct?: number;
  /** 连续包月价（USD，订阅） */
  subUsd?: number;
  subHkd?: number;
  /** 连续包月价（CNY，同折扣比例） */
  subCny?: number;
  /** 首月试用价（USD，开启订阅试用时存在） */
  trialUsd?: number;
  /** 年付价（USD / HKD / CNY，≈省 3 个月） */
  yearlyUsd?: number;
  yearlyHkd?: number;
  yearlyCny?: number;
  /** 买断·终身价（USD / HKD / CNY，限量） */
  lifetimeUsd?: number;
  lifetimeHkd?: number;
  lifetimeCny?: number;
}

export interface PayConfig {
  price: number; // 兼容字段：默认 Plus 人民币价（CNY，仅作价格参照）
  unlockDays: number;
  model?: string;
  /**
   * 本次结算币种（服务端按访客 IP 判定）：港澳 HKD / 内地 CNY / 其他 USD。
   * 前端**只负责展示**这一个币种的价格；Stripe 实扣同源（服务端也按 IP 判定），
   * 因此页面显示价 = 实扣价。
   */
  payCurrency?: 'HKD' | 'CNY' | 'USD';
  /**
   * 微信收款码 URL（备用通道，2026-09-26 回到用户侧）：服务端按图片内容哈希加了 `?v=`
   * —— 换图即换 URL，不会让用户看到旧码。付费弹窗据此展示扫码付款（人工确认后开通）。
   */
  payQrUrl?: string;
  /** 开业优惠开关 */
  launchOffer?: boolean;
  discountPct?: number;
  /** 开业优惠截止日期（YYYY-MM-DD；空/常开则无） */
  offerEndsAt?: string;
  /** 三币种定价（港澳/海外为主，展示顺序 USD → HKD → CNY） */
  pricing?: {
    currencyOrder: ['USD', 'HKD', 'CNY'];
    fxUsdHkd: number;
    plans: { plus: PlanPrice; pro: PlanPrice };
    /** 开业优惠开关/折扣（%） */
    launchOffer?: boolean;
    discountPct?: number;
  };
  /** 邀请/注册奖励配置（前端文案显示真实数值） */
  bonuses?: { register: number; invite: number; inviteMax: number };
  /** 会员权益数值（与 .env 一致，前端对比表/推荐逻辑实时展示，避免页面文案不同步） */
  quota?: PayQuotaConfig;
}

export interface PayQuotaConfig {
  /** 理一理 免费次数 */
  freeStruct: number;
  /** 对话 免费条数（聊一聊/角色扮演共用） */
  freeChat: number;
  /** Plus 每日聊一聊条数 */
  chatDailyLimit: number;
  /** 聊一聊上下文窗口（条） */
  contextFree: number;
  contextPlus: number;
  contextPro: number;
  /** 长期记忆事实上限（条） */
  memoryFree: number;
  memoryPlus: number;
  memoryPro: number;
  /** 千世书「AI 托管」每日回合上限 */
  autoPlayDailyLimit: number;
  /** 专属画面每日新图上限（Pro 无限，前端按「无限」展示） */
  sceneArtFree?: number;
  sceneArtPlus?: number;
  /** 统一点数（credit）每日上限：Free / Plus / Pro（Pro 也设兜底非无限） */
  creditEnabled?: boolean;   // 统一口径（一个池）是否已开：前端据此切换对比表的行结构
  /** 推荐器权重：每模式一次动作 = 多少条（后端下发，前端不写死） */
  featureCostTiao?: { chat?: number; textgame?: number; structure?: number; werewolf?: number };
  freeDailyCredit?: number;
  /** 游客档（未注册）每日点数上限：文案「游客 N 条/天」的数字来源，前端不写死 */
  guestDailyCredit?: number;
  plusDailyCredit?: number;
  proDailyCredit?: number;
  /** 1 标准单次 ≈ 普通聊一聊短消息平均点数（前端「≈ 每天能聊 N 条」折算） */
  unitCredit?: number;
}

export interface PayOrder {
  orderId: string;
  plan?: PlanKey;
  price: number;
  unlockDays: number;
  tip: string;
}

/**
 * 获取当前用户配额
 */
export async function getQuota(): Promise<ApiResponse<QuotaInfo>> {
  const r = await apiRequest<QuotaInfo>('/api/payment/quota');
  if (r.success && r.data && r.data.userId) setResolvedUserId(r.data.userId);
  return r;
}

/**
 * 确认已查看奖励通知（展示恭喜提示后调用，清除后端待通知标记）
 */
export async function ackReward(): Promise<ApiResponse<{ message: string }>> {
  return apiRequest('/api/payment/reward/ack', { method: 'POST', body: JSON.stringify({}) });
}

/** 小愈信箱里的一封信（运营者写给当前用户；弹窗只负责叫醒，信负责留存） */
export interface InboxLetter {
  id: string;
  kind: 'reward' | 'system';
  /** 奖励条数（kind='reward' 时用于文案；0 = 无奖励附言的纯消息） */
  rewardCount: number;
  /** 运营者写的原文（可能为空字符串：没附言的信依然留档，便于回看奖励） */
  body: string;
  read: boolean;
  createdAt: number;
}

/**
 * 小愈信箱：当前用户的信件（新在前）+ 未读数
 * 游客同样可用（身份 = 设备+IP 哈希）：运营端的奖励邮件到不了无邮箱的游客，信箱可以。
 */
export async function getInbox(): Promise<ApiResponse<{ items: InboxLetter[]; unread: number }>> {
  return apiRequest('/api/inbox');
}

/**
 * 标记信件已读：传 id = 只标这一封；不传 = 全部已读
 */
export async function readInbox(id?: string): Promise<ApiResponse<{ unread: number }>> {
  return apiRequest('/api/inbox/read', { method: 'POST', body: JSON.stringify(id ? { id } : {}) });
}

/**
 * 获取支付配置
 */
export async function getPayConfig(): Promise<ApiResponse<PayConfig>> {
  return apiRequest('/api/payment/config');
}

/**
 * 创建付费订单（人民币标价；供运营侧人工核对 / 补单使用）
 */
export async function createPayOrder(plan: PlanKey = 'plus', days?: number, purchase: PayTerm = 'monthly'): Promise<ApiResponse<PayOrder>> {
  return apiRequest('/api/payment/order', {
    method: 'POST',
    body: JSON.stringify({ plan, days, purchase }),
  });
}

/**
 * 用户标记已付款
 */
export async function confirmPayOrder(orderId: string, remark: string): Promise<ApiResponse<{ orderId: string; status: string; message: string }>> {
  return apiRequest('/api/payment/confirm', {
    method: 'POST',
    body: JSON.stringify({ orderId, remark }),
  });
}

/**
 * 查询订单状态（轮询解锁）
 */
export async function checkPayStatus(orderId: string): Promise<ApiResponse<{ orderId: string; status: string; unlockUntil: number | null }>> {
  return apiRequest(`/api/payment/status/${orderId}`);
}

/* ================= 历史记录 ================= */

export interface HistoryRecord {
  sessionId: string;
  createdAt: string;
  emotion?: string;
  intensity?: number;
  analysis?: string;
  suggestions?: string[];
  questionsCount: number;
  answeredCount: number;
  detailedState?: string;
  storyTitle?: string;
  storyMood?: string;
  storyContent?: string;
}

/**
 * 获取当前用户的历史陪伴记录
 */
export async function getHistory(): Promise<ApiResponse<HistoryRecord[]>> {
  return apiRequest('/api/analysis/history');
}

/* ================= 与你的旅程 ================= */

export interface JourneyMoment {
  at: number;
  date: string; // YYYY-MM-DD
  type: 'first' | 'mood' | 'memory' | 'portrait' | 'like';
  characterId: string;
  characterName: string;
  text?: string;
  mood?: string;
  note?: string;
  /** like 类：该剧情是用户自建 → 剧名旁渲染「自建」标志 */
  custom?: boolean;
  /** like 类：该自建剧本已被创作者删除 → 另加「已删」标志 */
  deleted?: boolean;
}

export interface JourneyCharacter {
  id: string;
  name: string;
  isDefault: boolean;
  avatar?: string; // 聊一聊该角色头像（自定义角色为用户上传/设置；内置小愈为空，由前端按皮肤解析）
  daysKnown: number;
  streak: number;
  firstChatAt?: number;
  chatDays: number;
  milestones: number[]; // 已达成对话轮数里程碑（30/100/300）
  relationMemories: { text: string; at: number }[];
  selfPortrait?: { text: string; at: number };
  portraitHistory: { text: string; at: number }[];
  facts: string[];
  /** 同上，带时间轴（显示「记住于 X」，2026-09-17） */
  factEntries?: MemoryEntryView[];
}

export interface JourneyStory {
  scenarioId: string;
  /** 真实剧名（自建剧本解析不到真名时为空串，前端用兜底文案） */
  title: string;
  at: number;
  kind?: 'roleplay' | 'wenyou';
  /** 用户自建（角色扮演自建剧本 / 千世书自建书）→ 渲染「自建」标志 */
  custom?: boolean;
  /** 自建剧本已被创作者删除 → 另加「已删」标志（记录里可能只剩兜底文案） */
  deleted?: boolean;
}

export interface JourneyData {
  summary: {
    daysKnown: number;
    checkins: number;
    characters: number;
    memories: number;
    portraits: number;
    likes: number;
    moodStreak: number;
  };
  characters: JourneyCharacter[];
  moments: JourneyMoment[];
  stories: JourneyStory[];
}

export async function getJourney(): Promise<ApiResponse<JourneyData>> {
  return apiRequest('/api/journey');
}

/**
 * 多轮追问
 */
export async function followUp(sessionId: string, question: string): Promise<ApiResponse<{ answer: string }>> {
  return apiRequest('/api/analysis/followup', { method: 'POST', body: JSON.stringify({ sessionId, question }) });
}

/** 订阅状态 */
export interface SubscriptionStatus {
  subscribed: boolean;
  plan?: 'plus' | 'pro';
  status?: string;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  daysLeft?: number;
}

/** 查询当前用户订阅状态 */
export async function getSubscriptionStatus(): Promise<ApiResponse<{ data: SubscriptionStatus }>> {
  return apiRequest('/api/payment/subscription-status');
}

/** 生成 Stripe 订阅管理（Customer Portal）链接 */
export async function getStripePortal(): Promise<ApiResponse<{ url: string }>> {
  return apiRequest('/api/payment/stripe/portal', { method: 'POST' });
}

/**
 * 提交用户反馈
 */
export async function stripePay(plan: PlanKey = 'plus', days?: number, mode: 'subscription' | 'payment' = 'subscription', purchase: PayTerm = 'monthly'): Promise<ApiResponse<{ url: string; sessionId: string; plan?: PlanKey; mode?: string }>> {
  return apiRequest('/api/payment/stripe/create-checkout', { method: 'POST', body: JSON.stringify({ plan, days, mode, purchase }) });
}

export async function saveFeedback(type: string, content: string, contact?: string, context?: string): Promise<ApiResponse<{ id: string; message: string; reward?: { granted: boolean; count: number } }>> {
  return apiRequest('/api/feedback', { method: 'POST', body: JSON.stringify({ type, content, contact, context }) });
}

/**
 * 获取公告（三语字段，前端按用户语言选择显示）
 */
export interface AnnouncementLangs {
  id: string;
  titleZh: string; contentZh: string;
  titleTw: string; contentTw: string;
  titleEn: string; contentEn: string;
  updatedAt: number;
}
export async function getAnnouncement(): Promise<ApiResponse<AnnouncementLangs[]>> {
  return apiRequest('/api/announcement');
}

/**
 * 角色剧情扮演：剧本列表与对话
 */
export interface RoleplayScenarioInfo {
  id: string; title: string; cover: string; avatar?: string; chatBackground?: string; tagline: string; shortDesc: string;
  ai: { name: string; gender: string; age: string; height: string; looks: string; personality: string; speech: string };
  user: { name: string; gender: string; age: string; height: string; looks: string; personality: string };
  background: string; source: string; sourceUrl?: string; openingScene: string; openingAssistant: string; contentNote?: string; tags: string[]; audience: 'her' | 'him' | 'lgbt';
  /**
   * **多角色线专属开场**（可选，2026-10-01 双模式）：两条线允许不同剧情线。
   * 没写 → 多角色线回落到通用 `openingScene/openingAssistant`。
   */
  multiOpeningScene?: string;
  multiOpeningAssistant?: string;
  /**
   * 多角色（群像）剧本的说话人名单（2026-10-01）。服务端已按界面语言本地化。
   * 缺省/空数组（或 length < 2）= 单角色剧本 → 前端不做任何多角色渲染，行为与改造前逐字一致。
   */
  cast?: { id: string; name: string; avatar?: string; lead?: boolean; role?: string; desc?: string }[];
  likes: number; likedByMe: boolean;
  /**
   * 这份剧本当初是不是用「无限制模型」创建的（本人自建剧本才有这个标记）。
   * 为 true 时，进这个剧本的聊天「无限制模式」默认开——用户仍可手动关，且只关这一个。
   * 缺省 undefined = 未记录，**不是 false**。
   */
  createdWithUnlimited?: boolean;
}
/**
 * 剧情演绎的一条消息。
 *
 * `versions` / `vi`：AI 回复的「多条候选版本」（2026-09-15 新增，支持每条回复都能重新生成 + 回看旧版）。
 *   - 只有**被重新生成过**的 assistant 消息才带这两个字段；`versions[vi]` 永远等于 `content`；
 *   - 请求后端时只取 `role`/`content`（`api/routes/roleplay.ts` 会过滤），所以「AI 接着哪一版往下写」
 *     完全由当前选中的那一版决定 —— 切了版本，下一轮上下文就是切后的那一版。
 */
export interface RoleplayMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 服务端落盘时补的时间戳（毫秒）。前端渲染不用它，但**编辑重发/切换分支时要原样搬回去**，别丢 */
  timestamp?: number;
  /**
   * 这条消息的全部版本（含当前这条，按生成先后排列；首版在前）。
   *
   * · assistant：`重新生成` 产生的多版候选（◀/▶ 回看，下一轮上下文取当前版）；
   * · user：**编辑重发**产生的多版正文（2026-09，见 `src/lib/rpVersions.ts` 下半节），
   *   每一版还可以带一个「冻结尾巴」`tails`。
   */
  versions?: string[];
  /** 当前显示的版本下标（对应 versions；缺省视为最后一条） */
  vi?: number;
  /**
   * **用户消息**的分支尾巴（仅编辑重发过的用户消息才有；与 `versions` 按下标对齐）。
   *
   * `tails[k]` = 「第 k 版正文之后的对话」被冻结保存的那一段（用户可 ◀/▶ 切回）；
   * 当前选中那一版对应的位置是 null —— 它的后续就活在主线里。
   *
   * ⚠️ 尾巴**不是**正式历史：`toRequestMessages()` 只带 role/content，所以它永远不会进模型上下文；
   * 渲染/分享/配音也一律走主线。它纯粹是给用户的"还能切回去"入口。
   */
  tails?: (RoleplayMessage[] | null)[];
  /**
   * 这条 assistant 回复是否由「无限制模式（成人模型）」生成。仅 assistant 有。
   *
   * 来源：流式过程中的 `{type:'meta'}` 事件（服务端在选定 provider 后立刻下发）。
   * 保存会话时随消息回传给服务端，落到 RoleplayMessage 上供管理端核对。
   * 缺省 undefined = 未记录（老数据 / 该路径未带上），**不要当作 false**。
   */
  viaUnlimited?: boolean;
  /** 生成这条回复用的模型名（同上来路）。仅 assistant 有 */
  model?: string;
  /**
   * 这条回复**没写完**（内容中断，被上游/模型截断在半句上）。仅 assistant 有。
   *
   * 来源：SSE `done` 事件里的 `incomplete`（服务端判据见 `src/lib/replyCompleteness.ts`）。
   * 用途：① 气泡上给「没写完 + 续写」入口（而不是把半截当完整台词）；
   * ② 随会话保存回传，刷新/换设备后仍然分得清。缺省 undefined = 老数据/未知。
   */
  incomplete?: boolean;
  /**
   * 生成这条回复时用户选的**叙事模式**（classic 经典 / immersive 沉浸）。仅 assistant 有。
   *
   * 为什么要有：叙事模式原先只存在浏览器 `localStorage`（`rp_narrative_style`），服务端与落盘数据里
   * 完全没有这个维度 —— 「经典档和沉浸档的收尾习惯是不是不一样」在真实数据上无法回答。
   * 保存会话时随消息回传（`assistantMetaOf`），服务端投影落盘，只读扫描脚本按它分档。
   * 缺省 undefined = 老数据未记录（**不要**用默认真值回填，那会把「不知道」伪造成快照值）。
   */
  style?: 'classic' | 'immersive';
}

export async function getRoleplayScenarios(lang: string = 'zh'): Promise<ApiResponse<RoleplayScenarioInfo[]>> {
  return apiRequest('/api/roleplay/scenarios?lang=' + lang);
}

/** 单个剧本详情（深链/直达用：只取目标剧本，避免拉全列表） */
export async function getRoleplayScenario(id: string, lang: string = 'zh'): Promise<ApiResponse<RoleplayScenarioInfo>> {
  const q = lang && lang !== 'zh' ? '?lang=' + lang : '';
  return apiRequest('/api/roleplay/scenario/' + encodeURIComponent(id) + q);
}

/**
 * 搜索角色剧情剧本（后端加权：tag > 标题 > 来源 > 简介 > 角色名 > 详情）
 * 返回带 matched 字段（命中来源：tag/title/source/intro/character/detail）
 */
export async function searchRoleplayScenarios(q: string, lang: string = 'zh'): Promise<ApiResponse<RoleplayScenarioInfo[] & { matched?: string[] }[]>> {
  return apiRequest('/api/roleplay/search?q=' + encodeURIComponent(q) + '&lang=' + lang);
}

export interface RoleplayTagGroup { key: string; label: string; tags: string[]; }
// 双模式（2026-10-01）：模式类型/判据的单一真源在 src/lib/roleplayMode.ts
export type { RoleplayMode } from '../lib/roleplayMode';
export interface RoleplayTagData { featured: string[]; groups: RoleplayTagGroup[]; }

/**
 * 角色剧情标签（按语言）：热门标签 + 分组标签，供「标签浏览」
 */
export async function getRoleplayTags(lang: string = 'zh'): Promise<ApiResponse<RoleplayTagData>> {
  return apiRequest('/api/roleplay/tags?lang=' + lang);
}
export async function roleplayChat(scenarioId: string, messages: RoleplayMessage[], lang: string = 'zh', aiName?: string, userName?: string, userPreference?: string, narrativeStyle?: string, innerMonologueEnabled?: boolean, thinkingLevel?: ThinkingLevel): Promise<ApiResponse<{ reply: string }>> {
  return apiRequest('/api/roleplay/chat', { method: 'POST', body: JSON.stringify({ scenarioId, messages, lang, aiName, userName, userPreference, narrativeStyle, innerMonologueEnabled, thinkingLevel }) });
}
/** 剧情对话流式客户端：逐 token 回调 onDelta，最后回 full reply（与聊一聊 chatSendStream 同构） */
export async function roleplayChatStream(scenarioId: string, messages: RoleplayMessage[], lang: string = 'zh', aiName?: string, userName?: string, userPreference?: string, narrativeStyle?: string, handlers: { onDelta?: (delta: string) => void; onQueue?: (info: { ahead: number; waiting: number; running: number; maxConcurrent: number }) => void; onMeta?: (info: { adult: boolean; model: string; thinking: boolean }) => void; onContinue?: (attempt: number) => void; /** A 方案：服务端判定本次回复复读了历史片段、正在重写一版（重写期间不发 delta，最终由 done.reply 覆盖） */ onRewrite?: () => void; signal?: AbortSignal } = {}, innerMonologueEnabled?: boolean, thinkingLevel?: ThinkingLevel, continueTurn?: boolean, replacedReply?: string, /** 本回合演哪条线（solo 缺省 / multi 群像）—— 决定服务端是否注入群像 prompt 块 */ mode: RoleplayMode = 'solo'): Promise<ApiResponse<{ reply: string; incomplete?: boolean; finishReason?: string; continued?: number; free?: boolean; repeated?: boolean; repeatDegree?: number }>> {
  const controller = new AbortController();
  const guard = createIdleGuard(controller, API_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  if (handlers.signal) {
    if (handlers.signal.aborted) controller.abort();
    else handlers.signal.addEventListener('abort', onExternalAbort);
  }
  guard.arm();
  try {
    const response = await fetch(API_BASE_URL + '/api/roleplay/chat?stream=1', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ scenarioId, messages, lang, aiName, userName, userPreference, narrativeStyle, innerMonologueEnabled, thinkingLevel, mode, ...(continueTurn ? { continueTurn: true } : {}), ...(replacedReply ? { replacedReply } : {}) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      let errText = httpErrPrefix() + response.status + ' ' + response.statusText;
      let errCode = '';
      try {
        const errBody = await response.json();
        if (errBody && typeof errBody === 'object' && typeof errBody.error === 'string' && errBody.error) errText = errBody.error;
        if (errBody && typeof errBody === 'object' && typeof errBody.code === 'string' && errBody.code) errCode = errBody.code;
      } catch { /* 非 JSON */ }
      if (response.status === 401 && getToken()) {
        clearAuth();
        try { window.dispatchEvent(new CustomEvent('auth-expired')); } catch { /* 忽略 */ }
      }
      if (isFreeQuotaExhausted(errCode)) notifyQuotaExhausted();
      return { success: false, error: translateBackendError(errText), status: response.status, code: errCode || undefined };
    }
    if (!response.body) return { success: false, error: '' };
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    // B 方案：done 里多了 incomplete / finishReason / continued（老服务端不带 → undefined，行为不变）
    let doneData: { reply: string; incomplete?: boolean; finishReason?: string; continued?: number; free?: boolean; repeated?: boolean; repeatDegree?: number } | null = null;
    let streamError = '';
    while (true) {
      const { done, value } = await reader.read();
      guard.arm(); // 拿到数据（含服务端心跳）→ 连接还活着
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.indexOf('data:') !== 0) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const ev = JSON.parse(payload);
          if (ev.type === 'delta' && typeof ev.content === 'string') handlers.onDelta?.(ev.content);
          else if (ev.type === 'queue') handlers.onQueue?.({ ahead: Number(ev.ahead) || 0, waiting: Number(ev.waiting) || 0, running: Number(ev.running) || 0, maxConcurrent: Number(ev.maxConcurrent) || 0 });
          // 审计元信息：服务端在选定 provider 后、开始生成前下发一次。前端存下并随会话保存回传。
          // thinking：本回合是否开着思考模式（成人档灰度 / 官方深度思考档位）——
          // 思考期不会有任何 delta（成人档实测首个字要等 70s），前端据此显示「正在深度思考…」。
          else if (ev.type === 'meta') handlers.onMeta?.({ adult: ev.adult === true, model: String(ev.model || ''), thinking: ev.thinking === true });
          // C 方案：服务端开始自动续写（把断掉的那半句接着写完）——前端据此显示"正在续写"
          else if (ev.type === 'continue') handlers.onContinue?.(Number(ev.attempt) || 1);
          // A 方案（生成后重复闸）：服务端判到复读，正在重写一版。重写期间不会有 delta，
          // 前端据此显示「正在重写」；最终文本由随后的 done.reply 一次性覆盖。
          else if (ev.type === 'rewrite') handlers.onRewrite?.();
          else if (ev.type === 'done') doneData = ev.data;
          else if (ev.type === 'error' && ev.error) streamError = ev.error;
        } catch { /* 忽略 */ }
      }
    }
    if (doneData) return { success: true, data: doneData };
    return { success: false, error: streamError };
  } catch {
    return { success: false, error: '', code: streamFailReason(guard.fired, handlers.signal) };
  } finally {
    guard.stop();
    handlers.signal?.removeEventListener('abort', onExternalAbort);
  }
}
/** AI 辅助聊天：为玩家生成 4 条候选「下一句」（非流式；重复时不消耗额度） */export async function roleplaySuggest(scenarioId: string, messages: RoleplayMessage[], lang: string = 'zh', aiName?: string, userName?: string, userPreference?: string, narrativeStyle?: string, previousSuggestions?: string[]): Promise<ApiResponse<{ suggestions: string[]; duplicate?: boolean; free?: boolean; repeatDegree?: number }>> {
  return apiRequest('/api/roleplay/suggestions', { method: 'POST', body: JSON.stringify({ scenarioId, messages, lang, aiName, userName, userPreference, narrativeStyle, ...(previousSuggestions && previousSuggestions.length ? { previousSuggestions } : {}) }) });
}
/**
 * 剧情模型配置：判断「无限制模式」开关是否可用（第三方模型已配置且未被运维开关强制切回）。
 * 不可用时前端应把开关置灰并说明原因，避免用户开了却静默用不上。
 */
export async function roleplayModelConfig(): Promise<ApiResponse<{ available: boolean; zh: string | null; en: string | null; adultConfirmed?: boolean; unlimitedActive?: boolean; routing?: { zh: string; en: string } }>> {
  return apiRequest('/api/roleplay/model-config');
}
// —— 剧情「按需出图」（S5）：给某剧本生成该主题的专属场景图（服务端白名单拼 prompt，用户文本不进 prompt）——
export interface SceneArtInfo {
  url: string | null;
  masterUrl?: string | null;
  /** C 方案：该剧本**这一幕的批量专属图**（云 API 跑批预生成；有则优先于 url/masterUrl） */
  ownUrl?: string | null;
  /** 该剧本已有哪些幕的专属图 URL（预热用 → 换幕即命中缓存） */
  ownUrls?: string[];
  /** 当前出图后端（排查用：用了哪家、有没有配 key、支持不支持负向词） */
  backend?: { provider: string; label: string; ready: boolean; negative: boolean; size: string };
  cached?: boolean; seconds?: number; used?: number; cap?: number; plan?: string
}

/** 已缓存的专属画面（不发算力、不耗额度） */
export async function getSceneArt(scenarioId: string, theme: string): Promise<ApiResponse<SceneArtInfo>> {
  return apiRequest<SceneArtInfo>('/api/roleplay/scene/art?scenarioId=' + encodeURIComponent(scenarioId) + '&theme=' + encodeURIComponent(theme));
}

/**
 * 按需生成专属画面。失败/降级（侧车没跑、显存不足、超限）时返回 success:false + code，
 * 前端**继续用共享图库**、不阻塞剧情（方案 §4.5 的降级口径）。
 */
export async function generateSceneArt(scenarioId: string, theme: string, opts: { auto?: boolean } = {}): Promise<ApiResponse<SceneArtInfo> & { degraded?: boolean; code?: string }> {
  const r = await apiRequest<SceneArtInfo & { url?: string }>('/api/roleplay/scene/art', {
    method: 'POST',
    body: JSON.stringify({ scenarioId, theme, ...(opts.auto ? { auto: true } : {}) }),
  });
  const raw = r as unknown as { success?: boolean; error?: string; code?: string; degraded?: boolean; data?: SceneArtInfo };
  if (raw?.success && raw.data && typeof raw.data.url === 'string') return { success: true, data: raw.data };
  return { success: false, error: raw?.error, code: raw?.code, degraded: !!raw?.degraded };
}

/**
 * 会话读写一律带 \`mode\`（2026-10-01 双模式）：solo = 单角色线，multi = 多角色线，**各一份存档**。
 * 缺省 solo —— 与服务端 / 本地键的默认口径一致。
 */
export async function getRoleplaySession(scenarioId: string, mode: RoleplayMode = 'solo'): Promise<ApiResponse<{ messages: RoleplayMessage[] | null; userPreference?: string; mode?: RoleplayMode }>> {  return apiRequest('/api/roleplay/session?scenarioId=' + encodeURIComponent(scenarioId) + '&mode=' + encodeURIComponent(mode));
}
export async function saveRoleplaySession(scenarioId: string, messages: RoleplayMessage[], userPreference?: string, mode: RoleplayMode = 'solo'): Promise<ApiResponse<null>> {
  return apiRequest('/api/roleplay/session', { method: 'POST', body: JSON.stringify({ scenarioId, messages, userPreference, mode }) });
}
export async function saveRoleplayPreference(scenarioId: string, userPreference: string, mode: RoleplayMode = 'solo'): Promise<ApiResponse<null>> {
  return apiRequest('/api/roleplay/session', { method: 'POST', body: JSON.stringify({ scenarioId, userPreference, mode }) });
}
export async function deleteRoleplaySession(scenarioId: string, mode: RoleplayMode = 'solo'): Promise<ApiResponse<null>> {
  return apiRequest('/api/roleplay/session?scenarioId=' + encodeURIComponent(scenarioId) + '&mode=' + encodeURIComponent(mode), { method: 'DELETE' });
}
export async function likeRoleplayScenario(scenarioId: string): Promise<ApiResponse<{ liked: boolean; count: number }>> {
  return apiRequest('/api/roleplay/like', { method: 'POST', body: JSON.stringify({ scenarioId }) });
}

/** 剧情配乐偏好（登录用户跨设备同步；游客走 localStorage 不进此接口） */
export async function getRoleplayBgmPrefs(): Promise<ApiResponse<{ bgmByScenario: Record<string, string> }>> {
  return apiRequest('/api/roleplay/bgm/prefs');
}
export async function saveRoleplayBgmPref(scenarioId: string, trackId: string): Promise<ApiResponse<{ bgmByScenario: Record<string, string> }>> {
  return apiRequest('/api/roleplay/bgm/prefs', { method: 'PUT', body: JSON.stringify({ scenarioId, trackId }) });
}

/**
 * 自建剧本（登录用户私有）
 */
export type CustomStatus = 'pending' | 'approved' | 'featured' | 'rejected';
export interface CustomScenarioInfo {
  id: string; title: string; aiName: string; aiPersona: string; background: string; opening: string; createdAt: number; updatedAt: number;
  avatar?: string; chatBackground?: string;
  published?: boolean; status?: CustomStatus; featured?: boolean; featuredAt?: number; reviewNote?: string; reviewedAt?: number;
  likes?: number; likedByMe?: boolean; source?: string;
  /**
   * 创建这份剧本时是否用了「无限制模式（成人模型）」。缺省 undefined = 未记录（老数据/手写），**不要当作 false**。
   * 服务端在 GET /api/roleplay/custom 里原样返回；进聊天时成人模式默认开就靠它（见 RoleplayPage）。
   */
  createdWithUnlimited?: boolean;
  /** 创建时用户给 AI 的提示词原文（「AI 帮我写剧本」的灵感；非 AI 生成 / 老数据为 undefined） */
  creationPrompt?: string;
}
export async function createCustomRoleplay(data: { title?: string; aiName?: string; aiPersona: string; background: string; opening: string; avatar?: string; chatBackground?: string; createdWithUnlimited?: boolean; createdWithModel?: string; creationPrompt?: string }): Promise<ApiResponse<CustomScenarioInfo>> {
  return apiRequest('/api/roleplay/custom', { method: 'POST', body: JSON.stringify(data) });
}

/** AI 辅助创建剧本草稿字段（自建剧本创建页回填表单用） */
export interface CustomDraftInfo {
  title: string; aiName: string; aiPersona: string; background: string; opening: string;
}

/** AI 辅助创建自建剧本草稿：一句话灵感 → 标题/角色名/人设/背景/开场草稿（每次生成消耗 1 条聊天额度） */
export async function roleplayCustomDraft(idea: string, lang: string = 'zh'): Promise<ApiResponse<{ draft: CustomDraftInfo; quota?: QuotaInfo }>> {
  return apiRequest('/api/roleplay/custom/draft', { method: 'POST', body: JSON.stringify({ idea, lang }) });
}
export async function listCustomRoleplay(lang: string = 'zh'): Promise<ApiResponse<CustomScenarioInfo[]>> {
  return apiRequest('/api/roleplay/custom?lang=' + encodeURIComponent(lang));
}
/**
 * 把「无限制模式（成人模型）」的开关**只**改在某个自建剧本上。
 *
 * 用途：本人用无限制模型创建的剧本，进聊天时成人模式默认开；用户在那个剧本里关掉时，
 * 关的必须只是这一个剧本——写全局偏好会把他所有剧本的成人模式一起关掉。
 *
 * 只有「本人的、且 createdWithUnlimited === true 的自建剧本」受理（其余 400
 * SCENARIO_NOT_ADULT_DEFAULT）；未过 18+ 成年确认时服务端会把 true 降级为 false 落盘，
 * 所以**必须跟随返回的 unlimited**，不要拿请求值去更新界面。
 */
export async function setScenarioUnlimited(scenarioId: string, unlimited: boolean): Promise<ApiResponse<{ scenarioId: string; unlimited: boolean; roleplayUnlimitedByScenario: Record<string, boolean>; adultConfirmed: boolean }>> {
  return apiRequest('/api/roleplay/unlimited', { method: 'POST', body: JSON.stringify({ scenarioId, unlimited }) });
}
export async function publishCustomRoleplay(id: string, published: boolean): Promise<ApiResponse<CustomScenarioInfo>> {
  return apiRequest('/api/roleplay/custom/' + encodeURIComponent(id) + '/publish', { method: 'POST', body: JSON.stringify({ published }) });
}
export async function updateCustomRoleplay(id: string, data: { title?: string; aiName?: string; aiPersona?: string; background?: string; opening?: string; avatar?: string; chatBackground?: string }): Promise<ApiResponse<CustomScenarioInfo>> {
  return apiRequest('/api/roleplay/custom/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(data) });
}

/** AI 按修改要求改动自建剧本：给出现有剧本 + 一句话修改要求，返回改动后的完整草稿（回填表单再保存） */
export async function roleplayCustomRevise(id: string, instruction: string, lang: string = 'zh', current?: { title?: string; aiName?: string; aiPersona?: string; background?: string; opening?: string }): Promise<ApiResponse<{ draft: CustomDraftInfo; quota?: QuotaInfo }>> {
  return apiRequest('/api/roleplay/custom/' + encodeURIComponent(id) + '/revise', { method: 'POST', body: JSON.stringify({ instruction, lang, current }) });
}

export async function deleteCustomRoleplay(id: string): Promise<ApiResponse<null>> {
  return apiRequest('/api/roleplay/custom/' + encodeURIComponent(id), { method: 'DELETE' });
}

/** 运营精选的公开自建剧本（「精选」区块） */
export async function getFeaturedRoleplay(lang: string = 'zh'): Promise<ApiResponse<CustomScenarioInfo[]>> {
  return apiRequest('/api/roleplay/featured?lang=' + encodeURIComponent(lang));
}

/** 运营已通过·一般公开的自建剧本（「玩家共创」一般区块） */
export async function getCommunityRoleplay(lang: string = 'zh'): Promise<ApiResponse<CustomScenarioInfo[]>> {
  return apiRequest('/api/roleplay/community?lang=' + encodeURIComponent(lang));
}

/* ================= AI 文游（人生模拟器，千世书引擎） ================= */
export interface TextGameMessage {
  role: 'user' | 'assistant';
  content: string;
}
/** 文游回合：把千世书引擎拼好的 messages 交给后端 DeepSeek（走小愈额度），返回 AI 叙事+选项。
 *  json=true 时后端强制 JSON 输出并在同一请求内自修复，避免解析失败重试重复扣额。
 *  auto=true 表示「AI 托管」回合，后端据此做 Pro/每日上限门控（成本保护）。 */
export async function textgameChat(
  messages: TextGameMessage[],
  opts?: { json?: boolean; auto?: boolean },
): Promise<ApiResponse<{ reply: string }>> {
  return apiRequest('/api/textgame/chat', {
    method: 'POST',
    body: JSON.stringify({ messages, lang: getLang(), json: opts?.json === true, auto: opts?.auto === true }),
  });
}

/** AI 文游「AI 生成剧本」：给主题，后端 DeepSeek 生成整份剧本（Pro 专属 + 每日限量，走小愈额度）。
 *  注意：整份生成耗时远超 100s，经 Cloudflare 回源时同步请求会被边缘以 524 掐断——
 *  正常入口请用 `generateWenyouScenarioStream`（SSE 进度流）；本函数保留作兼容/降级。 */
export async function generateWenyouScenario(opts: { theme: string; target: number; existingIds: string[] }): Promise<ApiResponse<{ scenario: unknown }>> {
  return apiRequest('/api/textgame/generate-scenario', {
    method: 'POST',
    body: JSON.stringify({ theme: opts.theme, target: opts.target, existingIds: opts.existingIds, lang: getLang() }),
    // 整份剧本要顺序调用多次 DeepSeek（骨架 + 多批事件），耗时可远超默认 90s；给足超时避免误报「生成失败」
    timeoutMs: 420000,
  });
}

/** AI 文游「AI 生成剧本」流式版：SSE 边生成边推进度（骨架完成 / 支线 n/total），收尾回整份剧本。
 *  为什么流式：整份生成要多段高思考 DeepSeek（总耗时远超 100s），同步请求在 Cloudflare 边缘约 100s
 *  无数据即回 524（用户侧「HTTP错误: 524」）；服务端持续下发进度/心跳后不再触发该超时。
 *  onProgress 仅用于界面展示；失败返回 { error, status, code }（错误码语义与同步版一致）。 */
export async function generateWenyouScenarioStream(
  opts: { theme: string; target: number; existingIds: string[] },
  onProgress?: (p: { step: 'skeleton' | 'events'; done: number; total: number }) => void,
  signal?: AbortSignal,
): Promise<ApiResponse<{ scenario: unknown }>> {
  // 空闲超时守卫（2026-09-15 事故后统一）：服务端每 10s 发 `: ping` 心跳，
  // 所以「长时间收不到任何数据」= 连接死了；用空闲而不是总时长，正常的长生成不会被误杀。
  const controller = new AbortController();
  const guard = createIdleGuard(controller, API_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onExternalAbort, { once: true });
  guard.arm();
  try {
    const response = await fetch(API_BASE_URL + '/api/textgame/generate-scenario?stream=1', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ theme: opts.theme, target: opts.target, existingIds: opts.existingIds, lang: getLang() }),
      signal: controller.signal,
    });
    if (!response.ok) {
      // 401/400/402 仍是普通 JSON（开流之前就返回），沿用同步版错误码语义
      let errText = httpErrPrefix() + response.status + ' ' + response.statusText;
      let errCode = '';
      try {
        const errBody = await response.json();
        if (errBody && typeof errBody.error === 'string' && errBody.error) errText = errBody.error;
        if (errBody && typeof errBody.code === 'string' && errBody.code) errCode = errBody.code;
      } catch { /* 非 JSON */ }
      if (response.status === 401 && getToken()) {
        clearAuth();
        try { window.dispatchEvent(new CustomEvent('auth-expired')); } catch { /* 忽略 */ }
      }
      if (isFreeQuotaExhausted(errCode)) notifyQuotaExhausted();
      return { success: false, error: translateBackendError(errText), status: response.status, code: errCode || undefined };
    }
    if (!response.body) return { success: false, error: '' };
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let doneData: { scenario: unknown } | null = null;
    let streamError = '';
    let streamCode = '';
    while (true) {
      const { done, value } = await reader.read();
      guard.arm(); // 拿到数据（含服务端 `: ping` 心跳）→ 连接还活着
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.indexOf('data:') !== 0) continue; // ': ping' 心跳等注释行自动忽略
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const ev = JSON.parse(payload);
          if (ev.type === 'progress' && (ev.step === 'skeleton' || ev.step === 'events')) {
            onProgress?.({ step: ev.step, done: Number(ev.done) || 0, total: Number(ev.total) || 0 });
          } else if (ev.type === 'done' && ev.data) {
            doneData = ev.data as { scenario: unknown };
          } else if (ev.type === 'error' && ev.error) {
            streamError = ev.error;
            if (typeof ev.code === 'string') streamCode = ev.code;
          }
        } catch { /* 忽略无法解析的行 */ }
      }
    }
    if (doneData) return { success: true, data: doneData };
    if (isFreeQuotaExhausted(streamCode)) notifyQuotaExhausted();
    return { success: false, error: streamError ? translateBackendError(streamError) : '', code: streamCode || undefined };
  } catch {
    // 失败原因不再吞掉：区分「用户自己取消 / 等超时（空闲） / 网络断」
    return { success: false, error: '', code: streamFailReason(guard.fired, signal) };
  } finally {
    guard.stop();
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

/** 文游回合流式（SSE）：正文逐 token 回调 onDelta（传累计全文，前端用 visibleNarrative 取可见正文），最后回 full reply。 */
export async function textgameChatStream(
  messages: TextGameMessage[],
  opts?: { json?: boolean; auto?: boolean },
  onDelta?: (text: string) => void,
  signal?: AbortSignal,
): Promise<ApiResponse<{ reply: string }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(API_BASE_URL + '/api/textgame/chat?stream=1', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ messages, lang: getLang(), json: opts?.json === true, auto: opts?.auto === true }),
      signal: signal || controller.signal,
    });
    if (!response.ok) {
      let errText = httpErrPrefix() + response.status + ' ' + response.statusText;
      let errCode = '';
      try {
        const errBody = await response.json();
        if (errBody && typeof errBody.error === 'string' && errBody.error) errText = errBody.error;
        if (errBody && typeof errBody.code === 'string' && errBody.code) errCode = errBody.code;
      } catch { /* 非 JSON */ }
      if (response.status === 401 && getToken()) {
        clearAuth();
        try { window.dispatchEvent(new CustomEvent('auth-expired')); } catch { /* 忽略 */ }
      }
      if (isFreeQuotaExhausted(errCode)) notifyQuotaExhausted();
      return { success: false, error: translateBackendError(errText), status: response.status, code: errCode || undefined };
    }
    if (!response.body) return { success: false, error: '' };
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let full = '';
    let doneData: { reply: string } | null = null;
    let streamError = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.indexOf('data:') !== 0) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          const ev = JSON.parse(payload);
          if (ev.type === 'delta' && typeof ev.content === 'string') { full += ev.content; onDelta?.(full); }
          else if (ev.type === 'done') doneData = ev.data;
          else if (ev.type === 'error' && ev.error) streamError = ev.error;
        } catch { /* 忽略 */ }
      }
    }
    if (doneData) return { success: true, data: doneData };
    return { success: false, error: streamError };
  } catch {
    return { success: false, error: '' };
  } finally {
    clearTimeout(timer);
  }
}

/** 千世书自建剧本：拉取服务端列表（登录用户；未登录 401，游客仍走本地） */
export async function getWenyouScenarios(): Promise<ApiResponse<{ scenarios: unknown[] }>> {
  return apiRequest('/api/wenyou/scenarios');
}

/** 千世书自建剧本：整表保存（前端负责本地与服务端合并） */
export async function saveWenyouScenarios(scenarios: unknown[]): Promise<ApiResponse<{ scenarios: unknown[] }>> {
  return apiRequest('/api/wenyou/scenarios', {
    method: 'PUT',
    body: JSON.stringify({ scenarios }),
  });
}

/** 千世书进度：拉取服务端（登录用户跨设备；未登录 401，游客仍走本地） */
export interface WenyouProgressPayload {
  games?: Record<string, unknown> | null; // scenarioId → 进行中局（每回合自动保存）
  slots?: unknown[];
  endings?: Record<string, string[]>;
  stats?: unknown | null;
}
export async function getWenyouProgress(): Promise<ApiResponse<WenyouProgressPayload>> {
  return apiRequest('/api/wenyou/progress');
}

/** 千世书进度：整表保存（前端负责合并） */
export async function saveWenyouProgress(bundle: WenyouProgressPayload): Promise<ApiResponse<WenyouProgressPayload>> {
  return apiRequest('/api/wenyou/progress', {
    method: 'PUT',
    body: JSON.stringify(bundle),
  });
}

/**
 * 获取/保存个性化偏好
 */
export type CompanionMode = 'hug' | 'ally' | 'clarify' | 'light' | 'objective';
export type Region = 'putonghua' | 'dongbei' | 'jingjin' | 'chuanyu' | 'yuegang' | 'jiangnan' | 'guanzhong' | 'minnan' | 'mindong' | 'taiwan' | 'neutral' | 'us' | 'uk';
export type Intensity = 'natural' | 'obvious' | 'strong';
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';
export interface UserPreferences {
  userId: string;
  tone: 'warm' | 'direct';
  storyStyle: 'poetic' | 'concise' | 'warm' | 'abstract';
  mode: CompanionMode;
  language: 'zh-CN' | 'zh-TW' | 'en';
  region: Region;
  intensity: Intensity;
  smartFitEnabled: boolean;
  dataEnhance: boolean;
  activityAwareness: boolean;
  chatInnerMonologueEnabled: boolean;
  /** 和小愈的关系档（2026-09-21）：朋友/损友/家人/恋人，缺省 friend */
  xiaoyuRelation?: ChatRelationKind;
  roleplayInnerMonologueEnabled: boolean;
  thinkingLevel: ThinkingLevel;
  assistantVoiceEnabled?: boolean; // 小愈朗读开关（默认关）；开启才预加载 TTS
  roleplayVoiceEnabled?: boolean; // 剧情「角色配音」开关（默认关）；开启才在剧情回复下方显示语音气泡并预加载 TTS
  roleplayAmbienceEnabled?: boolean; // 剧情「环境音」开关（默认关）；随换幕播放雨/风/室内底噪与雷声
  roleplayAutoSceneArt?: boolean; // 关键时刻自动画面（默认关，Pro 权益）
  roleplayUnlimited?: boolean; // 剧情「无限制模式」（默认关）：改用去限制模型 + 放开尺度提示词
  roleplayScriptUnlimited?: boolean; // 剧情「用无限制模型生成剧本」（默认关）：仅影响 AI 生成/改写自建剧本（同样受 18+ 确认闸）
  /**
   * 剧情**叙事模式**（2026-09-25 C 方案，跨设备同步）：`classic` 小说笔法 / `immersive` 对话笔法。
   * 差异定义在服务端 `api/services/narrativeStyle.ts`（篇幅/语体/收尾/亲密档/续写带）。
   * **缺省 undefined = 用户还没选过**（前端会用 localStorage 里的旧选择迁一次上来）。
   */
  narrativeStyle?: 'classic' | 'immersive';
  /**
   * 单剧本的「无限制模式」显式选择：剧本 id → 用户在那个剧本里拨的开关（默认空表）。
   * 表里没有某个剧本 = 用户没在那个剧本里拨过开关（≠ 关）→ 回落到「剧本自带默认 / 全局偏好」。
   * 只读：写入走 setScenarioUnlimited()（服务端读-合并-写，避免整表覆盖）。
   */
  roleplayUnlimitedByScenario?: Record<string, boolean>;
  /** 服务端的 18+ 成年确认留痕（不是偏好，客户端只读；未确认时 roleplayUnlimited 会被服务端按关处理） */
  adultConfirmed?: boolean;
  proactivePush?: boolean;
  proactiveFrequency?: 'random' | 'frequent' | 'occasional' | 'intense';
  learnedPreferences?: {
    directness: number; warmth: number; humor: number; adviceTendency: number;
    responseLength: number; questionDensity: number; markerDensity: number; softness: number;
  };
  updatedAt: number;
}
export async function getPreferences(): Promise<ApiResponse<UserPreferences>> {
  return apiRequest('/api/preferences');
}
export async function savePreferences(prefs: { tone?: 'warm' | 'direct'; storyStyle?: 'poetic' | 'concise' | 'warm' | 'abstract'; mode?: CompanionMode; language?: 'zh-CN' | 'zh-TW' | 'en'; region?: Region; intensity?: Intensity; smartFitEnabled?: boolean; dataEnhance?: boolean; activityAwareness?: boolean; chatInnerMonologueEnabled?: boolean; roleplayInnerMonologueEnabled?: boolean; thinkingLevel?: ThinkingLevel; assistantVoiceEnabled?: boolean; roleplayVoiceEnabled?: boolean; roleplayAmbienceEnabled?: boolean; roleplayAutoSceneArt?: boolean; roleplayUnlimited?: boolean; roleplayScriptUnlimited?: boolean; narrativeStyle?: 'classic' | 'immersive'; proactivePush?: boolean; proactiveFrequency?: 'random' | 'frequent' | 'occasional' | 'intense'; xiaoyuRelation?: ChatRelationKind }): Promise<ApiResponse<UserPreferences>> {
  return apiRequest('/api/preferences', { method: 'PUT', body: JSON.stringify(prefs) });
}

/**
 * 记录 18+ 成年确认（自声明，一次即可；服务端留痕后「无限制模式」才可能生效）。
 * source 只用于留痕区分来源：邮件落地页 / App 内开关前确认。
 */
export async function confirmAdult(source: 'email-campaign' | 'roleplay-toggle' | 'api' = 'api'): Promise<ApiResponse<{ confirmed: boolean; confirmedAt: number; loggedIn: boolean }>> {
  return apiRequest('/api/adult-confirm', { method: 'POST', body: JSON.stringify({ source }) });
}

/** PWA 推送 VAPID 公钥（订阅时作为 applicationServerKey） */
export async function getPushVapid(): Promise<ApiResponse<{ publicKey: string }>> {
  return apiRequest('/api/reengage/push/vapid');
}
/** 保存当前浏览器的推送订阅 */
export async function subscribePush(subscription: PushSubscriptionLike): Promise<ApiResponse<{ subscribed: boolean }>> {
  return apiRequest('/api/reengage/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription }) });
}
/** 移除推送订阅（关闭「AI 主动找我」时） */
export async function unsubscribePush(endpoint: string): Promise<ApiResponse<{ unsubscribed: boolean }>> {
  return apiRequest('/api/reengage/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) });
}
/** 发一条「测试推送」给自己（当前登录用户）：用最近一次使用场景的角色口吻，跳过流失/冷却筛选 */
export async function sendPushTestSelf(): Promise<ApiResponse<{ ok: boolean; detail: string; subject?: string; body?: string; senderName?: string; icon?: string; sent: number; failed: number }>> {
  return apiRequest('/api/reengage/push/test', { method: 'POST', body: JSON.stringify({}) });
}

/** 当前登录用户的「主动找我」偏好轮廓（静音对象 / 安静时段 / 时区） */
export async function getOutreachProfile(): Promise<ApiResponse<{ proactivePush: boolean; proactiveFrequency: string; mutedSubjects: string[]; quietHours: { start: string; end: string } | null; timezone: string | null }>> {
  return apiRequest('/api/reengage/outreach/profile');
}

/** 当前登录用户全部「可主动找你」对象 + 静音状态 */
export async function getOutreachSubjects(): Promise<ApiResponse<{ subjectKey: string; feature: string; label: string; muted: boolean }[]>> {
  return apiRequest('/api/reengage/outreach/subjects');
}

/** 静音某个对象（聊一聊角色 / 剧本 / 千世书 / 理一理） */
export async function muteOutreachSubject(subjectKey: string): Promise<ApiResponse<{ subjectKey: string; muted: boolean }>> {
  return apiRequest('/api/reengage/mute', { method: 'POST', body: JSON.stringify({ subjectKey }) });
}

/** 取消静音对象 */
export async function unmuteOutreachSubject(subjectKey: string): Promise<ApiResponse<{ subjectKey: string; muted: boolean }>> {
  return apiRequest('/api/reengage/unmute', { method: 'POST', body: JSON.stringify({ subjectKey }) });
}

/** 设置安静时段（本地 HH:mm；空则清除） */
export async function setOutreachQuietHours(start: string, end: string): Promise<ApiResponse<{ quietHours: { start: string; end: string } | null }>> {
  return apiRequest('/api/reengage/quiet-hours', { method: 'POST', body: JSON.stringify({ start, end }) });
}

/** 上报用户本地时区（供安静时段/每日预算准时） */
export async function reportTimezone(timezone: string): Promise<ApiResponse<{ timezone: string | null }>> {
  return apiRequest('/api/reengage/timezone', { method: 'POST', body: JSON.stringify({ timezone }) });
}

export interface PushSubscriptionLike {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
  expirationTime?: number | null;
}

/**
 * 修改用户名（昵称）
 */
export async function renameUser(username: string): Promise<ApiResponse<{ message: string; user: AuthUser }>> {
  return apiRequest<{ message: string; user: AuthUser }>('/api/auth/rename', { method: 'POST', body: JSON.stringify({ username }) });
}

/**
 * 上报网站访问（独立访客统计）
 */
export async function reportVisit(): Promise<void> {
  // 顺带带上来源归因（本次落地的触点 + first-touch + 触点路径）——服务端按设备 id 记 first-touch，
  // 注册时再落到账号上；这样「哪个渠道带来的访问/注册」才有答案
  const attr = getAttribution();
  try { await apiRequest('/api/analysis/visit', { method: 'POST', body: JSON.stringify({ attr: { ...attr, current: attr.path[attr.path.length - 1] || attr.first } }) }); } catch { /* 忽略 */ }
}

/**
 * 上报活跃时长（秒）：用户端前台+聚焦期间的心跳，供控制台「用户使用时长」统计。
 * `extra` 用于附带**身份兜底**（deviceId / token）与活跃门诊断（vis / focus / interaction / beacon）——
 * 因为兜底 flush 走 `sendBeacon`，它带不了自定义请求头，只能靠 body 认人（见 src/services/usageTime.ts）。
 * POST 不自动重试；fire-and-forget，失败静默忽略。
 */
export async function reportUsageTime(seconds: number, extra?: Record<string, unknown>): Promise<void> {
  try {
    await apiRequest('/api/usage-time/hit', { method: 'POST', body: JSON.stringify({ seconds, ...(extra || {}) }) });
  } catch { /* 忽略 */ }
}

/**
 * 上报当前皮肤（首次加载 + 切换皮肤时各一次）：供控制台「用户行为」页统计用户当前皮肤。
 * POST 不自动重试；fire-and-forget，失败静默忽略。
 */
export async function reportSkin(skin: string): Promise<void> {
  try {
    await apiRequest('/api/skin/usage', { method: 'POST', body: JSON.stringify({ skin }) });
  } catch { /* 忽略 */ }
}

/**
 * 上报一次「安装/下载 Xiaoyu」（PWA 装到桌面/主屏，含 iOS 添加到主屏）：供控制台统计用户下载。
 * 每次设备只报一次（见 usePwaInstall 的 cure_pwa_install_reported 守卫）；POST 不自动重试、失败静默忽略。
 */
export async function reportPwaInstall(): Promise<void> {
  try {
    await apiRequest('/api/pwa/install', { method: 'POST', body: '{}' });
  } catch { /* 忽略 */ }
}

/**
 * 上报一次「复制了我的专属邀请链接」（2026-09-29）。
 *
 * 为什么要有：运营端要能区分「压根没复制过链接」和「复制了但没人注册」——前者是不知道有这个入口，
 * 后者是该给话术/激励的人群。此前只有结果口径（拉来几个人），没有动作口径。
 * 每个复制入口都调一次（关于页 / 聊一聊 / 邀请弹窗 / 付费弹窗 / 个人资料 / 额度用尽弹窗）；
 * 失败静默忽略——复制本身已经成功，埋点绝不能反过来打断用户。
 */
export async function trackInviteCopy(): Promise<void> {
  try {
    await apiRequest('/api/referral/copied', { method: 'POST', body: '{}' });
  } catch { /* 忽略 */ }
}

/* ================= 表情包（在线贴纸搜索） ================= */

export interface StickerItem {
  url: string;
  thumbUrl?: string;
  title?: string;
}

/** 表情包在线搜索。后端默认未配置（STICKER_API_URL/KEY 未设）时返回 success:false + error:'not_configured'。 */
export async function stickerSearch(q: string): Promise<ApiResponse<{ items?: StickerItem[] }>> {
  return apiRequest<{ items?: StickerItem[] }>('/api/stickers/search?q=' + encodeURIComponent(q), { timeoutMs: 15000 });
}

export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  image: string;
}

/** 链接预览（微信/QQ 式卡片）：抓取目标网页的标题/描述/缩略图。 */
export async function getLinkPreview(url: string, timeoutMs = 12000): Promise<ApiResponse<LinkPreview>> {
  return apiRequest<LinkPreview>('/api/link-preview?url=' + encodeURIComponent(url), { timeoutMs });
}

/** 缩略图通过本站图片代理加载（规避混合内容/上游 SSL 异常）。 */
export function linkPreviewImageUrl(image: string): string {
  return API_BASE_URL + '/api/link-preview/image?u=' + encodeURIComponent(image);
}

/** 语音转文字（服务端 Whisper）：audioBase64 为 16kHz 单声道 PCM16 的 base64。 */
export async function asr(opts: { lang: string; audioBase64: string }): Promise<ApiResponse<{ text: string }>> {
  return apiRequest<{ text: string }>('/api/asr', {
    method: 'POST',
    body: JSON.stringify({ lang: opts.lang, audioBase64: opts.audioBase64 }),
    timeoutMs: 45000, // 冷启动/长音频略久
  });
}

/** 朗读（TTS）：把文本合成为音频 Blob（/api/tts 用 msedge-tts 自然年轻女声）。 */
export async function ttsToAudio(text: string, lang: string, voice?: string, reference?: string): Promise<Blob> {
  const body: Record<string, unknown> = { text: text.slice(0, 2000), lang };
  if (voice) body.voice = voice;
  // 音色参考名（侧车参考库里的名字）→ 服务端转给 VoxCPM 走克隆路径（见 api/routes/tts.ts）
  if (reference) body.reference = reference;
  const resp = await fetch(API_BASE_URL + '/api/tts', {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error('tts failed ' + resp.status);
  return await resp.blob();
}

/**
 * 流式朗读：POST /api/tts/stream（SSE），每收到一个 PCM 帧就调用 onChunk(samples, sr)。
 * 前端把各帧排队进 WebAudio 渐进播放，首段更早出声。
 */
export async function ttsToAudioStream(
  text: string,
  lang: string,
  voice: string | undefined,
  onChunk: (samples: Float32Array, sr: number) => void,
): Promise<void> {
  const body: Record<string, unknown> = { text: text.slice(0, 2000), lang };
  if (voice) body.voice = voice;
  const resp = await fetch(API_BASE_URL + '/api/tts/stream', {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  if (!resp.ok || !resp.body) throw new Error('tts stream failed ' + resp.status);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const decodePcm = (b64: string): Float32Array => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    return f32;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
      if (!dataLine) continue;
      try {
        const evt = JSON.parse(dataLine.slice(6));
        if (evt.pcm) onChunk(decodePcm(evt.pcm), evt.sr || 48000);
        if (evt.done) return;
        if (evt.error) throw new Error(evt.error);
      } catch (e) {
        if ((e as Error)?.message && !/Unexpected token/.test((e as Error)?.message)) throw e;
      }
    }
  }
}

/* ================= 心情日记 ================= */

export interface DiaryEntry {
  userId: string;
  date: string;
  mood: string;
  note: string;
  createdAt: number;
}

export async function saveDiary(mood: string, note: string): Promise<ApiResponse<{ entry: DiaryEntry; streak: number; reward: { bonus: number } | null; message: string }>> {
  return apiRequest('/api/diary', { method: 'POST', body: JSON.stringify({ mood, note }) });
}

export async function getDiary(): Promise<ApiResponse<{ records: DiaryEntry[]; streak: number; today: DiaryEntry | null }>> {
  return apiRequest('/api/diary');
}

/* ================= 分享邀请 ================= */

/**
 * 生成我的邀请链接（登录用户用 userId，游客用设备指纹）
 */
/* 解析后的用户 ID 缓存（游客邀请归因用）：配额接口返回后写入，生成邀请链接时优先使用 */
const RESOLVED_ID_KEY = 'cure_app_resolved_id';
export function getResolvedUserId(): string {
  try { return localStorage.getItem(RESOLVED_ID_KEY) || ''; } catch { return ''; }
}
function setResolvedUserId(id: string): void {
  try { if (id) localStorage.setItem(RESOLVED_ID_KEY, id); } catch { /* 忽略 */ }
}

export function getInviteLink(): string {
  const user = getStoredUser();
  const ref = user ? user.userId : (getResolvedUserId() || getDeviceId());
  return `${window.location.origin}${window.location.pathname}?ref=${encodeURIComponent(ref)}`;
}

/* ================= 邀请反馈（我的邀请记录） ================= */

/** 一行被邀人（服务端已打码邮箱；`rejectReason` 只在没计入奖励时有值） */
export interface MyReferralInvitee {
  name: string;
  maskedEmail: string | null;
  at: number;
  rewarded: boolean;
  credits: number;
  rejectReason: string | null;
  /** 待激活：朋友注册了、还没开始用（他开口后你才拿到奖励） */
  pending: boolean;
  /** 这一笔享了新账号加成（×1.5） */
  boost: number | null;
  memberDays: number;
  friendPurchasedPlan: string | null;
}

export interface MyReferralSummary {
  eligible: boolean;
  ineligibleReason: 'not-account' | 'too-new' | null;
  daysUntilEligible: number;
  config: {
    inviteBonus: number; inviteMax: number; minDays: number; yearlyCapDays: number; monthlyBonusDays: number;
    /** 新账号加成：注册 ≤ newAccountBoostDays 天时邀请成功奖励 ×newAccountBoost */
    newAccountBoost: number; newAccountBoostDays: number;
  };
  invitedCount: number;
  rewardedCount: number;
  /** 待激活人数（朋友注册了还没开口） */
  pendingCount: number;
  /** 判定不合格人数（反套利/超上限） */
  rejectedCount: number;
  creditsEarned: number;
  memberDaysEarned: number;
  invitees: MyReferralInvitee[];
}

/**
 * 我的邀请记录（邀请弹窗里的「邀请反馈区」）：有没有人通过我的链接注册、我因此拿到多少额度/会员天数。
 * 游客也会返回 200（`eligible=false`），前端据此显示「注册后邀请好友」。
 */
export async function getReferralSummary(): Promise<ApiResponse<MyReferralSummary>> {
  return apiRequest('/api/referral/summary');
}
/**
 * 注册后补填预设邀请码（注册时没填的用户可以补，一人一次）。
 * 成功返回本次获得的对话额度；失败看 `code`：INVITE_CODE_INVALID / INVITE_CODE_USED / NOT_LOGGED_IN。
 */
export async function applyInviteCode(code: string): Promise<ApiResponse<{ bonus: number; code: string }>> {
  return apiRequest('/api/referral/invite-code', { method: 'POST', body: JSON.stringify({ code }) });
}

/* ================= 账户 ================= */

export interface AuthResult {
  token: string;
  user: AuthUser;
}

export async function register(params: { username?: string; phone?: string; email: string; password: string; ref?: string; code?: string; inviteCode?: string; heardFrom?: string }): Promise<ApiResponse<AuthResult>> {
  // 注册即转化时刻：带上本地存好的来源归因（first-touch + 触点路径 + 自报来源），
  // 服务端按 X-Device-Id 把匿名浏览与这个账号 stitch 起来（否则注册用户全都像凭空出现）
  const { heardFrom, ...rest } = params;
  return apiRequest('/api/auth/register', { method: 'POST', body: JSON.stringify({ ...rest, attr: { ...getAttribution(), heardFrom: heardFrom || null } }) });
}

export async function login(account: string, password: string): Promise<ApiResponse<AuthResult>> {
  return apiRequest('/api/auth/login', { method: 'POST', body: JSON.stringify({ account, password }) });
}

/**
 * Google 一键登录 / 注册。
 * credential = Google Identity Services 返回的 ID token（JWT），**服务端验签**后换本站 token；
 * defaultName = Google 没返回姓名时的兜底昵称（按界面语言传，别让英文用户拿到中文默认名）。
 * 服务端返回 { token, user, isNew }，isNew 用来区分「登录」与「新注册」（触发注册后提示）。
 */
export async function loginWithGoogle(credential: string, defaultName?: string): Promise<ApiResponse<AuthResult & { isNew?: boolean }>> {
  return apiRequest('/api/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential, defaultName, attr: { ...getAttribution() } }),
  });
}

export async function sendEmailCode(email: string, purpose: 'register' | 'reset'): Promise<ApiResponse<{ message: string }>> {
  return apiRequest('/api/auth/send-code', { method: 'POST', body: JSON.stringify({ email, purpose }) });
}

export async function resetPassword(email: string, code: string, newPassword: string): Promise<ApiResponse<{ message: string }>> {
  return apiRequest('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ email, code, newPassword }) });
}

/** 获取当前登录用户（权威账号信息）。用于刷新本地缓存的昵称，避免改名发生在其它会话/设备后本地仍显示旧名。 */
export async function fetchCurrentUser(): Promise<ApiResponse<{ user: AuthUser }>> {
  return apiRequest<{ user: AuthUser }>('/api/auth/me');
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<ApiResponse<{ message: string }>> {
  return apiRequest('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) });
}

export async function logout(): Promise<void> {
  try { await apiRequest('/api/auth/logout', { method: 'POST' }); } catch { /* 忽略 */ }
  clearAuth();
}

/**
 * 注销账户（删除所有个人信息）
 */
export async function deleteAccount(): Promise<ApiResponse<{ message: string }>> {
  const r = await apiRequest<{ message: string }>('/api/auth/account', { method: 'DELETE' });
  if (r.success) clearAuth();
  return r;
}

/* ================= 长期记忆管理（P1-09b） ================= */

/** 获取我的长期记忆（「小愈记得我」列表；entries 带时间轴） */
export async function getMemory(): Promise<ApiResponse<{ facts: string[]; entries: MemoryEntryView[] }>> {
  return apiRequest('/api/memory');
}

/** 删除一条长期记忆（按索引，仅本人）；characterId 指定角色维度（聊一聊自定义角色），缺省为内置小愈 */
export async function deleteMemory(index: number, characterId?: string): Promise<ApiResponse<{ facts: string[]; entries: MemoryEntryView[] }>> {
  const qs = characterId ? '?characterId=' + encodeURIComponent(characterId) : '';
  return apiRequest('/api/memory/' + index + qs, { method: 'DELETE' });
}