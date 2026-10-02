/**
 * AI 情绪分析 / 对话 / 结构化梳理 / 故事 路由
 */

import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import memoryStorage, { countUnread, type ChatMessage } from '../storage/memory.js';
import { type OutputLang } from '../services/zhConvert.js';
import {
  analyzeEmotion,
  generateQuestions,
  generateDetailedAnalysis,
  generateHealingStory,
  followUp,
  chatReply,
  chatReplyStream,
  chatOutputLang,
  extractMemoryFacts,
  runCharacterGrowthTick
} from '../services/gemini.js';
import { quotaStore, isCreditQuotaEnabled, actionPricePoints} from '../services/quota.js';
import { resolveUserId, isRecordOwner, getAuthUser } from '../services/session.js';
import { resolveUserTimezone } from '../services/requestTimezone.js';
import { visitStore } from '../services/visits.js';
import { preferenceStore, type Region, type Intensity } from '../services/preferences.js';
import { longMemoryStore, toEntryView } from '../services/longMemory.js';
import { todayKeyIn, nowParts } from '../services/timeAnchor.js';
import { chatCharacterStore, XIAOYU_CHARACTER, type ChatCharacter, type StoryMode } from '../services/chatCharacter.js';
// 关系档白名单（2026-09-21）：角色级的四档关系（朋友/损友/家人/恋人），非法值一律忽略
import { isRelationKind } from '../services/chatRelation.js';
import { chatCharacterGrowthStore } from '../services/chatCharacterGrowth.js';
// 会话状态层（B 档，2026-09-21）：每轮回复后更新「此刻在做什么 / 心情 / 未消的账 / 你们之间的梗」
// 纯规则、**零额外模型调用**（chatState.updateChatState 是纯函数），所以不需要像 ensureDailyLife 那样预热
import { updateChatState } from '../services/chatState.js';
import { storyArchiveStore } from '../services/storyArchive.js';
import { importStoryCharacter, syncStoryCharacter, getStoryView, resolveScenarioBrief, StoryBridgeError } from '../services/storyBridge.js';
import { ensureDailyLife } from '../services/chatDailyLife.js';
import { isFallbackBubble } from '../../src/lib/fallbackBubbles.js';
import { safeError } from '../services/safeError.js';
import { activityStore, isTestRequest } from '../services/activity.js';
import { checkContentSafety, isSelfHarmContent, checkAiOutputSafety, checkCustomScenario } from '../services/safety.js';
import { pickGuide, pickChatRedirectGuide } from '../services/prompts.js';
import { detectChatRedirect } from '../services/chatRedirect.js';
import { extractChatHandoff, createChatHandoffFilter, replySuggestsAdultHandoff } from '../services/chatSignal.js';
// 场景判定（玩梗/低落）：状态层记账时要排除"用户正难过"的情况，避免把安慰误记成账
import { pickChatScene } from '../services/chatRelation.js';
import { getClientCountry, getClientIp, lookupIp } from '../services/geo.js';

const router = Router();

// 图片消息的对话扣减系数（1 条图片 = 2 条文字对话；视觉模型不可缓存，留余量但不 3× 惩罚）
const CHAT_IMAGE_COST = 2;
// 单次请求最多同时理解的图片数（当前 + 最近历史）
const CHAT_MAX_IMAGES = 4;

/**
 * 从请求解析「生活工具」上下文：地理（是否大陆 / 城市）与语言，供天气/线路工具选数据源与兜底位置。
 * 注意：这里的 Region（地区语气）≠ 地理，绝不据此选数据源；地理一律以 IP 定位为准。
 */
function buildToolCtx(req: Request): { isMainland: boolean; city: string; lang: OutputLang } {
  const ip = getClientIp(req);
  const geo = lookupIp(ip, getClientCountry(req));
  const isMainland = geo.country === '中国大陆';
  let city = (geo.city || '').trim();
  // ip2region 的大陆 city 通常带「市」（如 广州市）；无城市时报空，让工具/模型自然追问
  if (!city && geo.region) city = geo.region.trim();
  const lang: OutputLang =
    (geo.country === '中国大陆' || geo.country === '新加坡' || geo.country === '马来西亚')
      ? 'zh-CN'
      : (geo.country === '香港' || geo.country === '澳门' || geo.country === '台湾') ? 'zh-TW' : 'en';
  return { isMainland, city, lang };
}

/**
 * 从请求解析「引用回复」：用户在长按某条消息后指定回复的那一句。
 *
 * 只做**白名单 + 限长**的收口（前端是唯一来源，但请求体不可信）：
 * - role 只认 'user' / 'assistant'；content 收成字符串、压掉换行、限 300 字；
 * - kind 只认 'image' / 'audio'（被引用消息本身没有文字时界面用占位词）；
 * - content 与 kind 都空 → 视为没带引用（不写脏数据）。
 * 存进会话的是**原始引用信息**（供刷新后还原引用卡），喂给模型的是 buildChatPromptParts 里的「本轮回复指向」块。
 */
export function parseReplyTo(raw: unknown): { role: 'user' | 'assistant'; content: string; kind?: 'image' | 'audio'; at?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { role?: unknown; content?: unknown; kind?: unknown; at?: unknown };
  const role = r.role === 'assistant' ? 'assistant' : r.role === 'user' ? 'user' : null;
  if (!role) return undefined;
  const content = typeof r.content === 'string' ? r.content.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  const kind = r.kind === 'image' || r.kind === 'audio' ? r.kind : undefined;
  // at：被引用消息的时间戳（ISO 字符串；只做「像时间戳」的形状校验 + 限长，界面回跳用它定位）
  const at = typeof r.at === 'string' && r.at.length <= 40 && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(r.at) ? r.at : undefined;
  if (!content && !kind) return undefined;
  return { role, content, ...(kind ? { kind } : {}), ...(at ? { at } : {}) };
}

/**
 * 本轮提示词要用的「回复指向」：**取自会话里最后一条用户消息**（而不是请求体）。
 * 这样重试（retry 不重复写入同一条用户消息）也自动带上引用，前端无需重发。
 */
function lastUserReplyTo(chatMessages: { role: string; replyTo?: { role: 'user' | 'assistant'; content: string; kind?: 'image' | 'audio'; at?: string } }[]) {
  for (let i = chatMessages.length - 1; i >= 0; i--) {
    if (chatMessages[i].role === 'user') return chatMessages[i].replyTo;
  }
  return undefined;
}

/**
 * 本轮「来源」收口（2026-09-29）：把一次回复里所有 web_search 命中的链接合并成**给界面看的一小组**。
 *
 * 为什么要在路由层再收一次口：
 *   · 一轮里模型最多可以调 2 次工具（见 gemini 的函数调用循环），两次可能命中同一条 → 按 URL 去重；
 *   · 小愈是陪伴产品、不是新闻聚合 → 最多留 5 条；界面默认只露 3 条域名，其余折进「看全部来源」
 *     （正文里模型自己也会给出最相关那条，见 gemini 的生活工具提示词）。
 * 顺序保留命中顺序（=相关性顺序），不额外排序。
 */
function collectTurnSources(list: { title: string; url: string; host?: string }[], max = 5): { title: string; url: string; host?: string }[] {
  const out: { title: string; url: string; host?: string }[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    const title = (s?.title || '').trim();
    const url = (s?.url || '').trim();
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url, ...(s.host ? { host: String(s.host).toLowerCase() } : {}) });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 「按段的来源」收集器（2026-09-29）：段下标＝**气泡下标**，必须保留 null 占位
 * 少了占位，后面的来源就会挪到错误的气泡上（把第 3 段的出处挂到第 1 条上）。
 * 同一段可能被回调多次（工具轮一次、快照引用一次），按 URL 去重后合并。
 */
type SegmentedSources = ({ title: string; url: string; host?: string }[] | null)[];
function collectSourceSegments(acc: SegmentedSources, segs: SegmentedSources): void {
  for (let i = 0; i < segs.length; i++) {
    while (acc.length <= i) acc.push(null);
    const s = segs[i];
    if (!s || !s.length) continue;
    const cur = acc[i] || [];
    for (const item of s) {
      if (!item?.url || cur.some((x) => x.url === item.url)) continue;
      cur.push({ title: item.title, url: item.url, ...(item.host ? { host: item.host } : {}) });
    }
    acc[i] = cur;
  }
}

/**
 * 从会话中解析「理一理」应使用的角色。
 * 会话的 characterId 已在 /analyze（或聊一聊）阶段校验过；此处仅按会话归属加载角色，
 * 用于让理一理按「该角色的人设 + 该角色维度的长期记忆」来梳理。缺省/内置小愈/失效 → 回落小愈。
 */
function resolveStructureCharacter(session: { characterId?: string; userId?: string }): ChatCharacter | undefined {
  const charId = session.characterId;
  if (!charId || charId === XIAOYU_CHARACTER.id) return undefined;
  return chatCharacterStore.get(session.userId || '', charId) || undefined;
}

/**
 * 收集本次要带给模型的多图：当前图片 + 最近上下文窗口内的历史图片（去重、限量）
 */
function collectImages(chatMessages: { image?: string }[], ctxWindow: number, currentImage?: string): string[] {
  const out: string[] = [];
  if (currentImage) out.push(currentImage);
  const recent = chatMessages.slice(-ctxWindow);
  for (const m of recent) {
    if (m.image && out.length < CHAT_MAX_IMAGES && !out.includes(m.image)) out.push(m.image);
  }
  return out;
}


/**
 * 同步界面语言到用户偏好（AI 输出语言跟随界面语言，X-Lang 由前端每次请求携带）
 */
function syncLang(req: Request, userId?: string | null): void {
  if (!userId) return;
  const lang = String(req.headers['x-lang'] || '');
  if (lang !== 'zh-CN' && lang !== 'zh-TW' && lang !== 'en') return;
  try {
    if (preferenceStore.get(userId).language !== lang) {
      preferenceStore.set(userId, { language: lang });
    }
  } catch { /* 忽略 */ }
}

/** 请求界面语言（降级引导文案用；缺省 zh-CN，P1-07） */
function pickLang(req: Request): string {
  const lang = String(req.headers['x-lang'] || '');
  return lang === 'en' || lang === 'zh-TW' || lang === 'zh-CN' ? lang : 'zh-CN';
}

/**
 * 情感分析
 * POST /api/analysis/analyze
 */
router.post('/analyze', async (req: Request, res: Response): Promise<void> => {
  // 配额回滚状态（提升到 try 外，便于 catch 访问）
  let quotaUserId: string | null = null;
  let quotaConsumed = false;
  let creditToken: string | null = null;
  const rollbackQuota = () => {
    if (quotaConsumed && quotaUserId) {
      quotaStore.rollback(quotaUserId);
      quotaConsumed = false;
    }
    if (creditToken && quotaUserId) {
      quotaStore.rollbackCredit(quotaUserId, creditToken);
      creditToken = null;
    }
  };

  try {
    const { emotionInput, sessionId, characterId } = req.body;
    const wantedCharId = String(characterId || '').trim();

    if (!emotionInput || typeof emotionInput !== 'string') {
      res.status(400).json({
        success: false,
        error: '请提供有效的情绪描述'
      });
      return;
    }

    // 生成或获取会话ID（先做归属校验再扣配额，避免探测他人会话时浪费配额）
    quotaUserId = resolveUserId(req);
    const currentSessionId = sessionId || uuidv4();
    let session = memoryStorage.getSession(currentSessionId);

    // 归属校验（防 IDOR）：已有会话必须属于当前调用者
    if (session && !isRecordOwner(req, session)) {
      res.status(404).json({ success: false, error: '未找到会话' });
      return;
    }
    // 无主遗留会话：首个调用者认领（写入 userId，防止他人继续写入，P1-01 复查 F1）
    if (session && !session.userId && quotaUserId) {
      memoryStorage.updateSession(currentSessionId, { userId: quotaUserId });
    }

    // 内容安全（P1-07）：高危/违规输入 → 降级引导（不调用 AI、不扣配额）
    const inputCheck = checkContentSafety(emotionInput);
    if (!inputCheck.safe) {
      const lang = pickLang(req);
      const guide = pickGuide(lang, isSelfHarmContent(emotionInput));
      if (!session) {
        session = memoryStorage.createSession(currentSessionId);
        if (quotaUserId) memoryStorage.updateSession(currentSessionId, { userId: quotaUserId, characterId: wantedCharId || undefined });
      }
      const emotionAnalysis = {
        id: uuidv4(),
        category: 'crisis',
        emotion: lang === 'en' ? 'Needs support' : '需要支持',
        intensity: 5,
        timestamp: new Date(),
        analysis: guide,
        suggestions: [lang === 'en' ? 'Reach out to a local crisis helpline' : lang === 'zh-TW' ? '聯繫當地心理援助專線' : '联系当地心理援助热线'],
      };
      memoryStorage.updateSession(currentSessionId, { emotionAnalysis, rawInput: emotionInput });
      res.json({ success: true, data: { sessionId: currentSessionId, analysis: emotionAnalysis } });
      return;
    }

    // 理一理自定义角色解析：内置小愈无需登录；自定义角色需登录且归本人所有（与聊一聊一致）
    let structureCharacter: ChatCharacter | undefined;
    if (wantedCharId && wantedCharId !== XIAOYU_CHARACTER.id) {
      const authUser = getAuthUser(req);
      if (!authUser) {
        res.status(401).json({ success: false, error: '请先登录后使用自定义角色', code: 'LOGIN_REQUIRED' });
        return;
      }
      structureCharacter = chatCharacterStore.get(authUser.userId, wantedCharId);
      if (!structureCharacter) {
        res.status(404).json({ success: false, error: '角色不存在' });
        return;
      }
    }

    // 配额检查：免费3次，超出需付费解锁（登录用户按账号计，游客按设备计）；开启点数则按预计 token 折算
    if (isCreditQuotaEnabled()) {
      const creditQuota = quotaStore.getCreditQuota(quotaUserId);
      const est = { credit: actionPricePoints('analyzeEmotion') }; // 整数价目表
      const reserve = quotaStore.reserveCredit(quotaUserId, 'structure', est);
      if (!reserve.ok) {
        res.status(402).json({
          success: false,
          error: '今日额度点数已用完，明天再来，或升级解锁更多',
          code: 'QUOTA_EXCEEDED',
          data: { quota: quotaStore.getQuota(quotaUserId), creditQuota }
        });
        return;
      }
      creditToken = reserve.token!;
    } else {
      const quota = quotaStore.getQuota(quotaUserId);
      if (!quota.canUse) {
        res.status(402).json({
          success: false,
          error: '免费次数已用完，请付费解锁后继续使用',
          code: 'QUOTA_EXCEEDED',
          data: { quota }
        });
        return;
      }
      // 占位扣减（AI 调用失败时回滚）
      quotaConsumed = quotaStore.consume(quotaUserId);
    }

    if (!session) {
      session = memoryStorage.createSession(currentSessionId);
      // 关联用户，用于历史记录查询
      if (quotaUserId) {
        memoryStorage.updateSession(currentSessionId, { userId: quotaUserId, characterId: wantedCharId || undefined });
      }
    }

    // 同步界面语言（AI 输出跟随）
    syncLang(req, quotaUserId);

    // 请求头时区落库（2026-09-19）：理一理的人设/记忆时间标签与深夜判断都按用户那边的日历算；
    // 用户第一次用就是理一理（没聊过天）时，也能立刻带上自己的时区
    resolveUserTimezone(req, quotaUserId || undefined);

    // 调用AI分析情绪
    const analysisResult = await analyzeEmotion(emotionInput, quotaUserId || undefined, structureCharacter);
    
    // 保存分析结果到会话
    const emotionAnalysis = {
      id: uuidv4(),
      category: analysisResult.category,
      emotion: analysisResult.emotion,
      intensity: analysisResult.intensity,
      timestamp: new Date(),
      analysis: analysisResult.analysis,
      suggestions: analysisResult.suggestions
    };

    memoryStorage.updateSession(currentSessionId, {
      emotionAnalysis,
      rawInput: emotionInput,
      characterId: wantedCharId || session.characterId || undefined
    });

    // 行为追踪：理一理发起分析（一次流程只计一次；测试请求不计）
    if (quotaUserId && !isTestRequest(getClientIp(req), String(req.headers['x-device-id'] || ''))) activityStore.trackFeature(quotaUserId, 'structure', { ip: getClientIp(req), country: getClientCountry(req) });

    if (creditToken && quotaUserId) { quotaStore.commitCredit(quotaUserId, creditToken); creditToken = null; }
    res.json({
      success: true,
      data: {
        sessionId: currentSessionId,
        analysis: emotionAnalysis
      }
    });
  } catch (error) {
    rollbackQuota();
    console.error('Emotion analysis error:', error);
    res.status(500).json({
      success: false,
      error: safeError('ai', error)
    });
  }
});

/**
 * 重试去重（2026-09-15）：客户端「重试上一回合」会把**同一条**用户消息再发一次
 * （前端不再重复插气泡，服务端也不该把这句话写进会话第二遍，否则 AI 上下文与
 * 运营端记录里会出现两遍同一句话）。
 * 判定条件刻意收窄：仅当**客户端显式声明 retry** 且会话最后一条就是这条**还没被回复**的用户消息时复用。
 */
function isRetryOfPendingTurn(msgs: Array<{ role: string; content?: string; image?: string }>, msg: string, img?: string): boolean {
  const last = msgs[msgs.length - 1];
  return !!last && last.role === 'user' && (last.content || '') === msg && !!last.image === !!img;
}

/**
 * 「编辑重发」定位（2026-09，聊一聊）：把会话历史**回到**被改写的那条用户消息之前。
 *
 * 判据刻意收窄（宁可不动手，也绝不乱截历史）：
 *   1) 客户端显式带了 `editAt`（毫秒时间戳），且它正好等于历史里**最后一条用户消息**的时间戳
 *      与前端同一口径（2A：只有最后一条能改）。时间戳而非下标/id：id 是前端加载时现生成的
 *      （刷新即变），下标会被存储层 MAX_CHAT_MSGS 截断错位；
 *   2) 命中后把这条**及其之后**的消息整段去掉（那条之后本来就只有它的回复）。
 * 对不上 → 返回 -1，调用方按普通新消息处理。
 *
 * 为什么只认「最后一条」：改写更早的消息要把其后所有对话作废或变成对话树，
 * 那超出本轮范围（口径见 `src/lib/rpVersions.ts` 顶部 1B + 2A）。
 *
 * ⚠️ 这是**原地截断**（`length =` 而非返回新数组）：调用方随后立刻把改写后的消息 push 进去，
 * 并在同一个请求里生成回复，全流程原子，不会留下"历史被砍了一半又没接上"的中间态。
 */
function rewindForEdit(msgs: ChatMessage[], editAt: number | null): number {
  if (!editAt) return -1;
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'user') { lastUser = i; break; } }
  if (lastUser < 0) return -1;
  const raw = msgs[lastUser].timestamp;
  const ts = raw instanceof Date ? raw.getTime() : new Date(String(raw)).getTime();
  if (!Number.isFinite(ts) || ts !== editAt) return -1;
  msgs.length = lastUser;
  return lastUser;
}

/** 请求体里的 editAt → 毫秒时间戳（非法/缺省 = null，调用方按普通新消息处理） */
function parseEditAt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * 聊一聊（对话陪伴模式）
 * POST /api/analysis/chat { sessionId?, message }
 * 配额与 /analyze 一致：免费3次（聊天消息同样计次），解锁后无限
 */
router.post('/chat', async (req: Request, res: Response): Promise<void> => {
  let quotaUserId: string | null = null;
  let quotaConsumed = 0; // 已扣减的对话条数（图片消息按多条计）
  let creditToken: string | null = null; // 统一点数（credit）预留令牌；开启 CREDIT_QUOTA_ENABLED 后使用
  const rollbackQuota = () => {
    if (quotaConsumed > 0 && quotaUserId) {
      for (let i = 0; i < quotaConsumed; i++) quotaStore.rollbackChat(quotaUserId);
      quotaConsumed = 0;
    }
    if (creditToken && quotaUserId) {
      quotaStore.rollbackCredit(quotaUserId, creditToken);
      creditToken = null;
    }
  };

  try {
    const { sessionId, message, image, audio, thinkingLevel } = req.body || {};
    const isRetry = req.body?.retry === true; // 重试上一回合：不重复写入同一条用户消息
    const editAt = parseEditAt(req.body?.editAt); // 编辑重发：把历史回到被改写的那条（2A：只认最后一条）
    const replyTo = parseReplyTo(req.body?.replyTo); // 引用回复：这条消息在回复哪一句
    const msg = typeof message === 'string' ? message.trim().slice(0, 1000) : '';
    const img = typeof image === 'string' && image.startsWith('data:image/') ? image.slice(0, 2000000) : undefined;
    const audioData = typeof audio === 'string' && audio.startsWith('data:audio/') ? audio.slice(0, 3000000) : undefined;
    if (!msg && !img) {
      res.status(400).json({ success: false, error: '请说点什么吧，或发一张图片' });
      return;
    }

    // 聊一聊配额：免费→共用免费次数；Plus→每日限额；Pro→无限；图片消息按 CHAT_IMAGE_COST 条计
    quotaUserId = resolveUserId(req);
    syncLang(req, quotaUserId);
    // 先做会话归属校验（防 IDOR），再扣配额
    const currentSessionId = sessionId || uuidv4();
    let session = memoryStorage.getSession(currentSessionId);
    if (session && !isRecordOwner(req, session)) {
      res.status(404).json({ success: false, error: '未找到会话' });
      return;
    }
    // 无主遗留会话：首个调用者认领（写入 userId，防止他人继续写入，P1-01 复查 F1）
    if (session && !session.userId && quotaUserId) {
      memoryStorage.updateSession(currentSessionId, { userId: quotaUserId });
    }

    // 内容安全（P1-07）：高危/违规输入 → 降级引导回复（不调用 AI、不扣配额）
    if (msg) {
      const inputCheck = checkContentSafety(msg);
      if (!inputCheck.safe) {
        const lang = pickLang(req);
        const guide = pickGuide(lang, isSelfHarmContent(msg));
        if (!session) {
          session = memoryStorage.createSession(currentSessionId);
          if (quotaUserId) memoryStorage.updateSession(currentSessionId, { userId: quotaUserId });
        }
        const msgs = session.chatMessages || [];
        msgs.push({ role: 'user', content: msg, timestamp: new Date(), image: img, audio: audioData, ...(replyTo ? { replyTo } : {}) });
        msgs.push({ role: 'assistant', content: guide, timestamp: new Date() });
        memoryStorage.updateSession(currentSessionId, { chatMessages: msgs, chatTitle: session.chatTitle || msg.slice(0, 30), chatUpdatedAt: new Date() });
        res.json({
          success: true,
          data: {
            sessionId: currentSessionId,
            reply: guide,
            title: session.chatTitle || msg.slice(0, 30),
            messages: msgs.slice(-quotaStore.getContextWindow(quotaUserId || ''))
          }
        });
        return;
      }
    }

    // 角色扮演指令分流（2026-09-12）：用户在聊一聊里输入「来玩角色扮演 / 你扮演我的男友」这类指令
    // → 不调用 AI、不扣额度，直接回一段引导语（指路「剧情演绎」或「新建角色」），并带 hint 让前端给一键直达卡片
    if (msg) {
      const redirect = detectChatRedirect(msg);
      if (redirect) {
        const guide = pickChatRedirectGuide(pickLang(req), redirect);
        if (!session) {
          session = memoryStorage.createSession(currentSessionId);
          if (quotaUserId) memoryStorage.updateSession(currentSessionId, { userId: quotaUserId });
        }
        const msgs = session.chatMessages || [];
        msgs.push({ role: 'user', content: msg, timestamp: new Date(), image: img, audio: audioData, ...(replyTo ? { replyTo } : {}) });
        msgs.push({ role: 'assistant', content: guide, timestamp: new Date() });
        memoryStorage.updateSession(currentSessionId, { chatMessages: msgs, chatTitle: session.chatTitle || msg.slice(0, 30), chatUpdatedAt: new Date() });
        res.json({
          success: true,
          data: {
            sessionId: currentSessionId,
            reply: guide,
            title: session.chatTitle || msg.slice(0, 30),
            hint: redirect,
            messages: msgs.slice(-quotaStore.getContextWindow(quotaUserId || ''))
          }
        });
        return;
      }
    }
    const quotaCost = img ? CHAT_IMAGE_COST : 1;
    // 【统一点数（credit）：开启后按预计 token 折算预扣，真实 usage 结算校正（渐进式，默认关）】
    if (isCreditQuotaEnabled()) {
      const creditQuota = quotaStore.getCreditQuota(quotaUserId);
      const est = { credit: actionPricePoints('chat') }; // 整数价目表：一条 = 1 条（含图不再加价）
      const reserve = quotaStore.reserveCredit(quotaUserId, 'chat', est);
      if (!reserve.ok) {
        res.status(402).json({
          success: false,
          // Pro 的「无限」有个内部公平使用阀：触发时不能再说"额度已用完"（用户会问"无限怎么会用完"）
          error: reserve.reason === 'fair-use'
            ? '今日用量异常（已达保护上限），为保护服务稳定已暂停，明日恢复；如属正常使用请联系我们'
            : '今日额度点数已用完，明天再来，或升级解锁更多',
          code: 'CHAT_QUOTA_EXCEEDED',
          data: { quota: quotaStore.getQuota(quotaUserId), chatQuota: quotaStore.getChatQuota(quotaUserId), creditQuota }
        });
        return;
      }
      creditToken = reserve.token!;
    } else {
      const chatQuota = quotaStore.getChatQuota(quotaUserId);
      if (chatQuota.remainToday !== null && (chatQuota.remainToday ?? 0) < quotaCost) {
        res.status(402).json({
          success: false,
          error: chatQuota.plan === 'plus'
            ? '今天的聊天额度用完啦，明天再来聊；或升级 Pro 无限畅聊'
            : '图片消息会消耗更多额度，免费次数不够啦；可以发文字，或解锁后继续',
          code: 'CHAT_QUOTA_EXCEEDED',
          data: { quota: quotaStore.getQuota(quotaUserId), chatQuota }
        });
        return;
      }
      quotaConsumed = quotaCost;
      for (let i = 0; i < quotaCost; i++) {
        if (!quotaStore.consumeChat(quotaUserId)) {
          for (let j = 0; j < i; j++) quotaStore.rollbackChat(quotaUserId);
          quotaConsumed = 0;
          res.status(402).json({ success: false, error: '聊天额度不足', code: 'CHAT_QUOTA_EXCEEDED', data: { quota: quotaStore.getQuota(quotaUserId), chatQuota } });
          return;
        }
      }
    }

    // 生成或复用会话（归属校验已在配额前完成；不存在则新建）
    if (!session) {
      session = memoryStorage.createSession(currentSessionId);
      if (quotaUserId) {
        memoryStorage.updateSession(currentSessionId, { userId: quotaUserId });
      }
      session = memoryStorage.getSession(currentSessionId)!;
    }

    const chatMessages = session.chatMessages || [];
    // 编辑重发（2026-09）：先把历史回到被改写的那条用户消息之前（对不上 = -1，按普通新消息处理）。
    // 命中时必须**照样 push** 改写后的内容，所以下面的去重判断要排除这种情况。
    const editedIdx = rewindForEdit(chatMessages, editAt);
    if (editedIdx >= 0) {
      console.log('[chat] 编辑重发：历史截到第 ' + editedIdx + ' 条之前 · session=' + currentSessionId.slice(0, 8));
    }
    if (editedIdx >= 0 || !(isRetry && isRetryOfPendingTurn(chatMessages, msg, img))) {
      chatMessages.push({ role: 'user', content: msg, timestamp: new Date(), image: img, audio: audioData, ...(replyTo ? { replyTo } : {}) });
    }

    // 多对话标题：无标题时取首条用户消息前 30 字，作为该对话的标题
    let chatTitle = session.chatTitle;
    if (!chatTitle) {
      const firstUser = chatMessages.find(m => m.role === 'user');
      if (firstUser) chatTitle = firstUser.content.slice(0, 30) || (firstUser.image ? '[图片]' : '');
    }

    // 会话上下文：若刚做完情绪梳理（理一理），把摘要带给 AI，让对话接得上
    let context = '';
    if (chatMessages.length <= 1 && session.emotionAnalysis) {
      context = `用户刚完成一次情绪梳理：主要情绪=${session.emotionAnalysis.emotion}，分析摘要=${(session.emotionAnalysis.analysis || '').slice(0, 200)}`;
    }

    // 上下文窗口按会员档位：Pro 更长上下文（免费 10 / Plus 20 / Pro 40）
    const ctxWindow = quotaStore.getContextWindow(quotaUserId || '');
    /**
     * 读历史时剔掉「失败兜底气泡」（红线 6）：聊一聊此前**既没有读侧过滤、也没有写侧过滤**，
     * 于是 `gemini.ts` 那句伪造台词一旦落盘，就会以"小愈说过的话"的身份被回灌给模型。
     * 只剔 assistant 且整串命中 `fallbackBubbles` 表的消息（user 的一律不动）。
     */
    const history = chatMessages
      .filter(m => !(m.role === 'assistant' && isFallbackBubble(m.content)))
      .slice(-ctxWindow)
      .map(m => ({ role: m.role, content: m.image ? (m.content ? '[图片] ' + m.content : '[图片]') : m.content }));
    const images = collectImages(chatMessages, ctxWindow, img);
    // 请求头 X-Timezone → 用户那边的「今天/现在」（立刻生效，不依赖是否在设置里上报过）
    const reqTz = resolveUserTimezone(req, quotaUserId || undefined);
    // 本轮来源收集器：web_search 命中什么就留下什么，最后结构化下发 + 随消息落盘（见 collectTurnSources）
    const turnSources: { title: string; url: string; host?: string }[] = [];
    // 按段的来源（段下标＝气泡下标）：模型引用「实时资讯速览」里某条时，出处挂到**提到它的那条气泡**上
    const turnSourceSegments: SegmentedSources = [];
    let revised = false;
    const reply = await chatReply(history, {
      userId: quotaUserId,
      timezone: reqTz,
      context,
      images,
      replyTo: lastUserReplyTo(chatMessages),
      onSources: (list) => turnSources.push(...list),
      onSourceSegments: (segs) => collectSourceSegments(turnSourceSegments, segs),
      // 输出卫生闸改过正文（剥掉/重写了自言自语）→ 前端要按最终正文重建气泡
      onRevised: () => { revised = true; },
      thinkingLevel: (thinkingLevel as any),
      toolCtx: buildToolCtx(req),
      ...(creditToken ? { onUsage: (_u: any) => { if (creditToken && quotaUserId) { quotaStore.settleCredit(quotaUserId, creditToken, actionPricePoints('chat')); creditToken = null; } } } : {}),
    });
    /**
     * 交接信号（2026-09-25）：模型**自己**判定"这次我把 TA 引到剧情 + 无限制模式了"，
     * 在回复末尾输出标记 → 这里剥掉（**落盘/下发都用剥好的正文**，红线 6：内部标记不是小愈说过的话）
     * 并把"出现过标记"当作模型的判断结果，给前端一个直达按钮。
     * 关键词判据（replySuggestsAdultHandoff）只作兜底：标记被模型忘了、但话里要件齐全时也出按钮。
     */
    const handoff = extractChatHandoff(reply);
    const replyText = handoff.text;
    // 输出安全（P1-07）：指令式高危内容替换为危机引导
    const finalReply = checkAiOutputSafety(replyText).safe ? replyText : pickGuide(pickLang(req), true);
    const attachAdultHint = handoff.handoff || replySuggestsAdultHandoff(finalReply);

    // 来源随消息落盘（刷新/换设备重进时来源行还在）；没有搜索就**不写这个字段**，
    // 让「这轮没搜索」与「搜索了但没结果」在数据上仍然分得开
    const sources = collectTurnSources(turnSources);
    const sourceSegments = turnSourceSegments.some(Boolean) ? turnSourceSegments : null;
    chatMessages.push({ role: 'assistant', content: finalReply, timestamp: new Date(), ...(sources.length ? { sources } : {}), ...(sourceSegments ? { sourceSegments } : {}) });
    memoryStorage.updateSession(currentSessionId, { chatMessages, chatTitle, chatUpdatedAt: new Date() });

    // 长期记忆：异步从本轮用户消息中提取值得记住的事实（不阻塞回复）
    const memUserId = quotaUserId;
    if (memUserId && msg) {
      extractMemoryFacts(memUserId, msg, 'xiaoyu', '小愈', reqTz).then(facts => {
        if (facts && facts.length > 0) longMemoryStore.addFacts(memUserId, facts, quotaStore.getMaxMemoryFacts(memUserId));
      }).catch(() => { /* 记忆提取失败不影响主流程 */ });
      // 同上（流式端点）：异步预热「今天的小事」，本条不注入、下一条起可用
      ensureDailyLife(memUserId, 'xiaoyu', '小愈', {
        dateKey: todayKeyIn(reqTz || ''),
        tz: reqTz,
        // 语言取**本轮输出语言**（跟随用户这条消息），不是界面语言：
        // 线上实测过一次错配（界面英文 + 用户打中文 → 生成英文小事塞进中文对话）
        lang: chatOutputLang(history, memUserId) === 'en' ? 'en' : 'zh',
      }).catch(() => { /* 忽略 */ });
      /**
       * 会话状态层（B 档，2026-09-21）：把这一轮沉淀成"我此刻的状态"（scene/mood/grudge/joke）。
       * 纯规则、零额外调用、同步落盘，本轮回复已经结束，所以状态**下一轮立刻生效**，
       * 不像 `ensureDailyLife` 那样需要预热。失败只影响"连续性"，不影响对话，故静默。
       */
      try {
        const prevState = chatCharacterGrowthStore.getState(memUserId, 'xiaoyu');
        chatCharacterGrowthStore.setState(memUserId, 'xiaoyu', updateChatState(prevState, {
          userText: msg,
          aiReply: finalReply,
          scene: pickChatScene(msg, history),
          aiName: '小愈',
          history,
        }));
      } catch { /* 忽略 */ }
    }

    // 行为追踪：聊一聊成功回复一轮
    if (quotaUserId && !isTestRequest(getClientIp(req), String(req.headers['x-device-id'] || ''))) activityStore.trackFeature(quotaUserId, 'chat', { ip: getClientIp(req), country: getClientCountry(req) });

    res.json({
      success: true,
      data: {
        sessionId: currentSessionId,
        reply: finalReply,
        title: chatTitle,
        /**
         * 「小愈自己把话说到了剧情 + 无限制模式」→ 配一个直达按键（2026-09-25）。
         * 与规则层的 hint 区别：这里小愈**已经用她自己的话解释过了**，所以前端只渲染一个按钮，
         * 不再重复整张说明卡（hintCompact=true）。用户原话：「要有一个直达的按键而不只是信息说明」。
         */
        ...(attachAdultHint ? { hint: 'adultRoleplay' as const, hintCompact: true } : {}),
        ...(sources.length ? { sources } : {}),
        ...(sourceSegments ? { sourceSegments } : {}),
        ...(revised ? { revised: true } : {}),
        messages: chatMessages.slice(-ctxWindow)
      }
    });
  } catch (error) {
    rollbackQuota();
    console.error('Chat reply error:', error);
    res.status(500).json({
      success: false,
      error: safeError('ai', error)
    });
  }
});

/**
 * 聊一聊流式回复（SSE 打字机效果）
 * POST /api/analysis/chat/stream { sessionId?, message }
 * 与 /chat 共用配额与上下文逻辑；边生成边推送 delta，结束时推送 done（含 sessionId/title/reply）
 */
router.post('/chat/stream', async (req: Request, res: Response): Promise<void> => {
  let quotaUserId: string | null = null;
  let quotaConsumed = 0; // 已扣减的对话条数（图片消息按多条计）
  let creditToken: string | null = null; // 统一点数（credit）预留令牌；开启 CREDIT_QUOTA_ENABLED 后使用
  const rollbackQuota = () => {
    if (quotaConsumed > 0 && quotaUserId) {
      for (let i = 0; i < quotaConsumed; i++) quotaStore.rollbackChat(quotaUserId);
      quotaConsumed = 0;
    }
    if (creditToken && quotaUserId) {
      quotaStore.rollbackCredit(quotaUserId, creditToken);
      creditToken = null;
    }
  };
  const send = (obj: unknown) => {
    try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch { /* 客户端可能已断开 */ }
  };

  try {
    const { sessionId, message, image, audio, characterId, region, intensity, chatInnerMonologueEnabled, thinkingLevel } = req.body || {};
    const isRetry = req.body?.retry === true; // 重试上一回合：不重复写入同一条用户消息
    const editAt = parseEditAt(req.body?.editAt); // 编辑重发：把历史回到被改写的那条（2A：只认最后一条）
    const replyTo = parseReplyTo(req.body?.replyTo); // 引用回复：这条消息在回复哪一句
    // 切地区后让下一句立即生效：请求里带的 region/intensity 优先于偏好存储
    const reqRegion: Region | undefined = typeof region === 'string' ? (region as Region) : undefined;
    const reqIntensity: Intensity | undefined = typeof intensity === 'string' ? (intensity as Intensity) : undefined;
    // 聊一聊括号开关：旧窗口切换后下一句立即生效，请求值优先于偏好存储
    const reqChatInner: boolean | undefined = typeof chatInnerMonologueEnabled === 'boolean' ? chatInnerMonologueEnabled : undefined;
    // 深度思考档位：请求值优先；resolveThinkingLevel 会做合法性回退
    const reqThinking: any = typeof thinkingLevel === 'string' ? thinkingLevel : undefined;
    const msg = typeof message === 'string' ? message.trim().slice(0, 1000) : '';
    const img = typeof image === 'string' && image.startsWith('data:image/') ? image.slice(0, 2000000) : undefined;
    // 微信式语音气泡：audio 为录音 data URL，仅用于前端展示/播放，不喂给模型（模型靠 transcribe 出的 text 理解）
    const audioData = typeof audio === 'string' && audio.startsWith('data:audio/') ? audio.slice(0, 3000000) : undefined;
    if (!msg && !img) {
      res.status(400).json({ success: false, error: '请说点什么吧，或发一张图片' });
      return;
    }

    // 聊一聊自定义角色解析：内置小愈无需登录；自定义角色需登录且归本人所有
    const wantedCharId = String(characterId || '').trim();
    let chatCharacter: ChatCharacter | undefined;
    if (wantedCharId && wantedCharId !== XIAOYU_CHARACTER.id) {
      const authUser = getAuthUser(req);
      if (!authUser) {
        res.status(401).json({ success: false, error: '请先登录后使用自定义角色', code: 'LOGIN_REQUIRED' });
        return;
      }
      chatCharacter = chatCharacterStore.get(authUser.userId, wantedCharId);
      if (!chatCharacter) {
        res.status(404).json({ success: false, error: '角色不存在' });
        return;
      }
    }

    // 聊一聊配额：免费→共用免费次数；Plus→每日限额；Pro→无限；图片消息按 CHAT_IMAGE_COST 条计
    quotaUserId = resolveUserId(req);
    syncLang(req, quotaUserId);
    // 先做会话归属校验（防 IDOR），再扣配额
    const currentSessionId = sessionId || uuidv4();
    let session = memoryStorage.getSession(currentSessionId);
    if (session && !isRecordOwner(req, session)) {
      res.status(404).json({ success: false, error: '未找到会话' });
      return;
    }
    // 无主遗留会话：首个调用者认领（写入 userId，防止他人继续写入，P1-01 复查 F1）
    if (session && !session.userId && quotaUserId) {
      memoryStorage.updateSession(currentSessionId, { userId: quotaUserId });
    }

    // 内容安全（P1-07）：高危/违规输入 → 降级引导（SSE done 事件返回，不调用 AI、不扣配额）
    if (msg) {
      const inputCheck = checkContentSafety(msg);
      if (!inputCheck.safe) {
        const lang = pickLang(req);
        const guide = pickGuide(lang, isSelfHarmContent(msg));
        if (!session) {
          session = memoryStorage.createSession(currentSessionId);
          if (quotaUserId) memoryStorage.updateSession(currentSessionId, { userId: quotaUserId, characterId: wantedCharId || undefined });
        }
        const msgs = session.chatMessages || [];
        // 编辑重发：改写后的内容落在「内容安全引导」分支时，历史同样要先回到那条之前（否则会话里会出现两遍）
        const editIdx = rewindForEdit(msgs, editAt);
        if (editIdx >= 0 || !(isRetry && isRetryOfPendingTurn(msgs, msg, img))) {
          msgs.push({ role: 'user', content: msg, timestamp: new Date(), image: img, audio: audioData, ...(replyTo ? { replyTo } : {}) });
        }
        msgs.push({ role: 'assistant', content: guide, timestamp: new Date() });
        memoryStorage.updateSession(currentSessionId, { chatMessages: msgs, chatTitle: session.chatTitle || msg.slice(0, 30), chatUpdatedAt: new Date(), characterId: wantedCharId || undefined });
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        send({ type: 'done', data: { sessionId: currentSessionId, title: session.chatTitle || msg.slice(0, 30), reply: guide } });
        res.end();
        return;
      }
    }

    // 角色扮演指令分流（2026-09-12）：不调 AI、不扣额度，done 事件带 hint 供前端渲染「一键直达」卡片
    if (msg) {
      const redirect = detectChatRedirect(msg);
      if (redirect) {
        const guide = pickChatRedirectGuide(pickLang(req), redirect);
        if (!session) {
          session = memoryStorage.createSession(currentSessionId);
          if (quotaUserId) memoryStorage.updateSession(currentSessionId, { userId: quotaUserId, characterId: wantedCharId || undefined });
        }
        const msgs = session.chatMessages || [];
        // 编辑重发：改写后的内容落在「角色扮演分流」分支时同样先回到那条之前（见上）
        const editIdx = rewindForEdit(msgs, editAt);
        if (editIdx >= 0 || !(isRetry && isRetryOfPendingTurn(msgs, msg, img))) {
          msgs.push({ role: 'user', content: msg, timestamp: new Date(), image: img, audio: audioData, ...(replyTo ? { replyTo } : {}) });
        }
        msgs.push({ role: 'assistant', content: guide, timestamp: new Date() });
        memoryStorage.updateSession(currentSessionId, { chatMessages: msgs, chatTitle: session.chatTitle || msg.slice(0, 30), chatUpdatedAt: new Date(), characterId: wantedCharId || undefined });
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        send({ type: 'done', data: { sessionId: currentSessionId, title: session.chatTitle || msg.slice(0, 30), reply: guide, hint: redirect } });
        res.end();
        return;
      }
    }
    const quotaCost = img ? CHAT_IMAGE_COST : 1;
    // 【统一点数（credit）：开启后按预计 token 折算预扣，真实 usage 结算校正（渐进式，默认关）】
    if (isCreditQuotaEnabled()) {
      const creditQuota = quotaStore.getCreditQuota(quotaUserId);
      const est = { credit: actionPricePoints('chat') }; // 整数价目表：一条 = 1 条（含图不再加价）
      const reserve = quotaStore.reserveCredit(quotaUserId, 'chat', est);
      if (!reserve.ok) {
        res.status(402).json({
          success: false,
          // Pro 的「无限」有个内部公平使用阀：触发时不能再说"额度已用完"（用户会问"无限怎么会用完"）
          error: reserve.reason === 'fair-use'
            ? '今日用量异常（已达保护上限），为保护服务稳定已暂停，明日恢复；如属正常使用请联系我们'
            : '今日额度点数已用完，明天再来，或升级解锁更多',
          code: 'CHAT_QUOTA_EXCEEDED',
          data: { quota: quotaStore.getQuota(quotaUserId), chatQuota: quotaStore.getChatQuota(quotaUserId), creditQuota }
        });
        return;
      }
      creditToken = reserve.token!;
    } else {
      const chatQuota = quotaStore.getChatQuota(quotaUserId);
      if (chatQuota.remainToday !== null && (chatQuota.remainToday ?? 0) < quotaCost) {
        res.status(402).json({
          success: false,
          error: chatQuota.plan === 'plus'
            ? '今天的聊天额度用完啦，明天再来聊；或升级 Pro 无限畅聊'
            : '图片消息会消耗更多额度，免费次数不够啦；可以发文字，或解锁后继续',
          code: 'CHAT_QUOTA_EXCEEDED',
          data: { quota: quotaStore.getQuota(quotaUserId), chatQuota }
        });
        return;
      }
      quotaConsumed = quotaCost;
      for (let i = 0; i < quotaCost; i++) {
        if (!quotaStore.consumeChat(quotaUserId)) {
          for (let j = 0; j < i; j++) quotaStore.rollbackChat(quotaUserId);
          quotaConsumed = 0;
          res.status(402).json({ success: false, error: '聊天额度不足', code: 'CHAT_QUOTA_EXCEEDED', data: { quota: quotaStore.getQuota(quotaUserId), chatQuota } });
          return;
        }
      }
    }

    // 生成或复用会话（归属校验已在配额前完成；不存在则新建）
    if (!session) {
      session = memoryStorage.createSession(currentSessionId);
      if (quotaUserId) {
        memoryStorage.updateSession(currentSessionId, { userId: quotaUserId, characterId: wantedCharId || undefined });
      }
      session = memoryStorage.getSession(currentSessionId)!;
    }

    const chatMessages = session.chatMessages || [];
    // 编辑重发（2026-09）：与 /chat 同一份判据，命中的话历史已回到那条之前，改写后的内容照样要写进去。
    const editedIdx = rewindForEdit(chatMessages, editAt);
    if (editedIdx >= 0) {
      console.log('[chat/stream] 编辑重发：历史截到第 ' + editedIdx + ' 条之前 · session=' + currentSessionId.slice(0, 8));
    }
    if (editedIdx >= 0 || !(isRetry && isRetryOfPendingTurn(chatMessages, msg, img))) {
      chatMessages.push({ role: 'user', content: msg, timestamp: new Date(), image: img, audio: audioData, ...(replyTo ? { replyTo } : {}) });
    }

    let chatTitle = session.chatTitle;
    if (!chatTitle) {
      const firstUser = chatMessages.find(m => m.role === 'user');
      if (firstUser) chatTitle = firstUser.content.slice(0, 30) || (firstUser.image ? '[图片]' : '');
    }

    let context = '';
    if (chatMessages.length <= 1 && session.emotionAnalysis) {
      context = '用户刚完成一次情绪梳理：主要情绪=' + session.emotionAnalysis.emotion + '，分析摘要=' + (session.emotionAnalysis.analysis || '').slice(0, 200);
    }

    const ctxWindow = quotaStore.getContextWindow(quotaUserId || '');
    // 同非流式端点：读历史时剔掉失败兜底气泡（红线 6），别把它当"小愈说过的话"回灌给模型
    const history = chatMessages
      .filter(m => !(m.role === 'assistant' && isFallbackBubble(m.content)))
      .slice(-ctxWindow)
      .map(m => ({ role: m.role, content: m.image ? (m.content ? '[图片] ' + m.content : '[图片]') : m.content }));
    const images = collectImages(chatMessages, ctxWindow, img);

    // 请求头时区（X-Timezone）→ 用户那边的「今天/现在」：night hint、时间锚、记忆提取共用同一份
    const reqTz = resolveUserTimezone(req, quotaUserId || undefined);
    // 成长彩蛋提示（仅登录用户；按聊天轮数/连续天数/深夜时段注入，让角色自然流露）
    const growthHints: { night?: string; milestone?: string; day?: string } = {};
    if (quotaUserId && getAuthUser(req)) {
      const charId = chatCharacter?.id || 'xiaoyu';
      const growth = chatCharacterGrowthStore.get(quotaUserId, charId);
      // 深夜判断按**用户所在时区**（2026-09-19）：此前用服务器本地时间，海外用户的"深夜"会判反
      const hour = nowParts(reqTz).hour;
      if (hour >= 22 || hour < 6) growthHints.night = '深夜';
      const nextCount = growth.exchangeCount + 1;
      const milestone = chatCharacterGrowthStore.milestoneAtCount(nextCount);
      if (milestone && !chatCharacterGrowthStore.milestoneClaimed(growth, milestone)) growthHints.milestone = String(milestone);
      const streak = chatCharacterGrowthStore.streakDays(growth, true);
      if (streak === 7 || streak === 30) growthHints.day = String(streak);
    }

    // 进入 SSE 流式响应
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // 客户端断开（关页/切走）时中止上游生成，避免继续耗量/计费与资源占用
    // 用 res 'close' + writableEnded 判断：仅在真正断开时 abort，避免 req 'close' 在请求体读完时误伤
    const streamAbort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) streamAbort.abort(); });

    // SSE 心跳：模型思考/拉资讯/搜索期间存在长静默期，移动网络可能把连接当死链断开 → 定时发注释行保活
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 客户端已断开 */ } }, 12000);
    try {
      const handoffFilter = createChatHandoffFilter();
      // 本轮来源收集器（同非流式端点）：工具轮命中什么就留下什么
      const turnSources: { title: string; url: string; host?: string }[] = [];
      // 按段的来源（段下标＝气泡下标）：见 collectSourceSegments
      const turnSourceSegments: SegmentedSources = [];
      let revised = false;
      const reply = await chatReplyStream(history, {
        userId: quotaUserId,
        timezone: reqTz,
        context,
        character: chatCharacter,
        growthHints,
        replyTo: lastUserReplyTo(chatMessages), // 引用回复：让模型知道用户在回复哪一句（重试也自动带上）
        // 交接标记可能被切成好几个 delta，所以在**下发前**过一道过滤器（扣住可能是标记开头的尾部）
        onToken: (delta) => { const safe = handoffFilter.feed(delta); if (safe) send({ type: 'delta', content: safe }); },
        onSearch: () => send({ type: 'search' }),
        onSources: (list) => turnSources.push(...list),
        onSourceSegments: (segs) => collectSourceSegments(turnSourceSegments, segs),
        // 输出卫生闸改过正文 → 前端按最终正文重建气泡（流式已经把原文发出去过）
        onRevised: () => { revised = true; },
        images,
        signal: streamAbort.signal,
        region: reqRegion,
        intensity: reqIntensity,
        chatInnerMonologueEnabled: reqChatInner,
        thinkingLevel: reqThinking,
        toolCtx: buildToolCtx(req),
        ...(creditToken ? { onUsage: (_u: any) => { if (creditToken && quotaUserId) { quotaStore.settleCredit(quotaUserId, creditToken, actionPricePoints('chat')); creditToken = null; } } } : {}),
      });
      // 收尾：把过滤器扣住的尾巴吐出去（标记本身仍然剥掉），否则末尾几个字永远到不了前端
      const tailSafe = handoffFilter.flush();
      if (tailSafe) send({ type: 'delta', content: tailSafe });
      // 剥掉交接标记（落盘/下发都用剥好的正文），标记出现过＝模型自己判定"这次交接了"
      const handoff = extractChatHandoff(reply);
      const attachAdultHint = handoff.handoff || handoffFilter.handoff || replySuggestsAdultHandoff(handoff.text);
      // 输出安全（P1-07）：指令式高危内容替换为危机引导（已流出的 token 无法撤回，属已知取舍；持久化与 done 用引导）
      const finalReply = checkAiOutputSafety(handoff.text).safe ? handoff.text : pickGuide(pickLang(req), true);

      // 来源随消息落盘（同非流式端点）：刷新/换设备重进时气泡下的来源行还在；
      // 没有搜索就**不写这个字段**，让「这轮没搜索」与「搜了但没结果」在数据上分得开
      const sources = collectTurnSources(turnSources);
      const sourceSegments = turnSourceSegments.some(Boolean) ? turnSourceSegments : null;
      chatMessages.push({ role: 'assistant', content: finalReply, timestamp: new Date(), ...(sources.length ? { sources } : {}), ...(sourceSegments ? { sourceSegments } : {}) });
      memoryStorage.updateSession(currentSessionId, { chatMessages, chatTitle, chatUpdatedAt: new Date(), characterId: wantedCharId || undefined });

      const memUserId = quotaUserId;
      if (memUserId && msg) {
        const memCharId = chatCharacter?.id || 'xiaoyu';
        const memCharName = chatCharacter?.name || '小愈';
        extractMemoryFacts(memUserId, msg, memCharId, memCharName, reqTz).then(facts => {
          if (facts && facts.length > 0) longMemoryStore.addFacts(memUserId, facts, quotaStore.getMaxMemoryFacts(memUserId), memCharId);
        }).catch(() => { /* 忽略 */ });
        /**
         * 小愈/角色自己的「今天的小事」：**异步预热**（每个用户×角色每天最多 1 次小调用）。
         * 为什么不在对话链路上 await：那会给当天第一条消息平白加几秒延迟；
         * 代价是本条消息里还没有它、**从下一条起可用**，如实记录在 CHANGELOG，不假装即时。
         */
        ensureDailyLife(memUserId, memCharId, memCharName, {
          dateKey: todayKeyIn(reqTz || ''),
          tz: reqTz,
          // 同非流式端点：语言跟本轮输出语言，不跟界面语言
          lang: chatOutputLang(history, memUserId) === 'en' ? 'en' : 'zh',
        }).catch(() => { /* 生成失败不影响流程（服务内部已退化到静态兜底池） */ });
        /**
         * 会话状态层（B 档，2026-09-21）：同非流式端点：纯规则、零额外调用、同步落盘，
         * 本轮回复已结束 ⇒ 下一轮立刻带着"我手上正在做的事 / 我的心情 / 我们没算完的账 / 我们之间的梗"说话。
         */
        try {
          const prevState = chatCharacterGrowthStore.getState(memUserId, memCharId);
          chatCharacterGrowthStore.setState(memUserId, memCharId, updateChatState(prevState, {
            userText: msg,
            aiReply: finalReply,
            scene: pickChatScene(msg, history),
            aiName: memCharName,
            history,
          }));
        } catch { /* 忽略 */ }
        // 纯质性养成：小愈与自定义角色都沉淀「关系记忆 + 反思 + 日记 + 自画像」，异步、失败静默；仅登录用户（避免游客额外调用与不可见的成长）
        if (getAuthUser(req)) {
          const growthIdentity = chatCharacter || ({ id: 'xiaoyu', name: '小愈' } as ChatCharacter);
          const transcript = chatMessages.slice(-8).map(m => (m.role === 'user' ? '用户：' : growthIdentity.name + '：') + (m.content || '')).join('\n');
          runCharacterGrowthTick(memUserId, growthIdentity, transcript).catch(() => { /* 忽略 */ });
        }
      }

      // 行为追踪：聊一聊流式回复完成
      if (quotaUserId && !isTestRequest(getClientIp(req), String(req.headers['x-device-id'] || ''))) activityStore.trackFeature(quotaUserId, 'chat', { ip: getClientIp(req), country: getClientCountry(req) });

      send({ type: 'done', data: {
        sessionId: currentSessionId, title: chatTitle, reply: finalReply,
        // 来源（结构化）：前端把它渲染成气泡下方的「来源」行，用户不必先知道「可以要链接」
        //  · sources：整轮（web_search 工具命中的）→ 挂在本轮最后一条气泡；
        //  · sourceSegments：**按段**（段下标＝气泡下标），让「讲这条新闻的那条气泡」自己挂出处
        ...(sources.length ? { sources } : {}),
        ...(sourceSegments ? { sourceSegments } : {}),
        // 输出卫生闸改过正文：前端要用这条最终正文**重建本轮气泡**（流式已把原文发出去过）
        ...(revised ? { revised: true } : {}),
        // 同上（非流式端点）：模型自己标了交接（或兜底判据命中）→ 给一个直达按键，不重复说明卡
        ...(attachAdultHint ? { hint: 'adultRoleplay' as const, hintCompact: true } : {}),
      } });
      res.end();
    } finally {
      clearInterval(heartbeat);
    }
  } catch (error) {
    rollbackQuota();
    console.error('Chat stream error:', error);
    if (res.headersSent) {
      send({ type: 'error', error: safeError('ai', error) });
      res.end();
    } else {
      res.status(500).json({ success: false, error: safeError('ai', error) });
    }
  }
});

/**
 * 生成深入问题
 * POST /api/analysis/questions
 */
router.post('/questions', async (req: Request, res: Response): Promise<void> => {
  let quotaUserId: string | null = null;
  let creditToken: string | null = null;
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      res.status(400).json({
        success: false,
        error: '请提供会话ID'
      });
      return;
    }

    const session = memoryStorage.getSession(sessionId);
    if (!session || !isRecordOwner(req, session) || !session.emotionAnalysis) {
      res.status(404).json({
        success: false,
        error: '未找到情感分析结果，请先进行情感分析'
      });
      return;
    }

    // 同步界面语言（AI 输出跟随）
    syncLang(req, session.userId);

    // 理一理按触发它的角色来梳理（人设 + 该角色维度记忆）；缺省回落小愈
    const structureCharacter = resolveStructureCharacter(session);

    // 幂等：同一会话已生成过问题则直接返回，避免重复调 LLM 刷成本
    if (session.questions && session.questions.length > 0) {
      res.json({ success: true, data: { questions: session.questions } });
      return;
    }

    // 统一点数：生成问题也计费（此前这一步免费，属成本泄漏）；失败回滚
    if (isCreditQuotaEnabled() && session.userId) {
      quotaUserId = session.userId;
      const creditQuota = quotaStore.getCreditQuota(quotaUserId);
      const est = { credit: actionPricePoints('questions') }; // 整数价目表
      const reserve = quotaStore.reserveCredit(quotaUserId, 'structure', est);
      if (!reserve.ok) {
        res.status(402).json({ success: false, error: '今日额度点数已用完，明天再来，或升级解锁更多', code: 'QUOTA_EXCEEDED', data: { quota: quotaStore.getQuota(quotaUserId), creditQuota } });
        return;
      }
      creditToken = reserve.token!;
    }

    // 生成问题
    const questionResult = await generateQuestions(session.emotionAnalysis, session.userId, session.rawInput, structureCharacter);
    
    // 将问题保存到会话
    const questions = questionResult.questions.map(q => ({
      id: uuidv4(),
      question: q,
      timestamp: new Date()
    }));

    memoryStorage.updateSession(sessionId, {
      questions
    });

    if (creditToken && quotaUserId) { quotaStore.commitCredit(quotaUserId, creditToken); creditToken = null; }
    res.json({
      success: true,
      data: {
        questions
      }
    });
  } catch (error) {
    if (creditToken && quotaUserId) { quotaStore.rollbackCredit(quotaUserId, creditToken); creditToken = null; }
    console.error('Question generation error:', error);
    res.status(500).json({
      success: false,
      error: safeError('ai', error)
    });
  }
});

/**
 * 提交问题答案
 * POST /api/analysis/answers
 */
router.post('/answers', async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId, answers } = req.body;

    if (!sessionId || !answers || !Array.isArray(answers)) {
      res.status(400).json({
        success: false,
        error: '请提供有效的会话ID和答案'
      });
      return;
    }

    const session = memoryStorage.getSession(sessionId);
    if (!session || !isRecordOwner(req, session)) {
      res.status(404).json({
        success: false,
        error: '未找到会话'
      });
      return;
    }

    // 更新问题答案
    const updatedQuestions = session.questions.map(q => {
      const answer = answers.find((a: { questionId: string; answer: string }) => a.questionId === q.id);
      return answer ? { ...q, answer: answer.answer } : q;
    });

    memoryStorage.updateSession(sessionId, {
      questions: updatedQuestions
    });

    res.json({
      success: true,
      data: {
        message: '答案已保存'
      }
    });
  } catch (error) {
    console.error('Answer submission error:', error);
    res.status(500).json({
      success: false,
      error: '答案提交失败'
    });
  }
});

/**
 * 生成详细分析
 * POST /api/analysis/detailed-analysis
 */
router.post('/detailed-analysis', async (req: Request, res: Response): Promise<void> => {
  let quotaUserId: string | null = null;
  let creditToken: string | null = null;
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      res.status(400).json({
        success: false,
        error: '请提供会话ID'
      });
      return;
    }

    const session = memoryStorage.getSession(sessionId);
    if (!session || !isRecordOwner(req, session) || !session.emotionAnalysis) {
      res.status(404).json({
        success: false,
        error: '未找到情感分析结果'
      });
      return;
    }

    // 幂等：同一会话已生成过详细分析则直接返回，避免重复调 LLM 刷成本
    if (session.detailedAnalysis) {
      res.json({ success: true, data: { analysis: session.detailedAnalysis } });
      return;
    }

    // 检查是否有已回答的问题
    const answeredQuestions = session.questions.filter(q => q.answer);
    if (answeredQuestions.length === 0) {
      res.status(400).json({
        success: false,
        error: '请先回答问题'
      });
      return;
    }

    // 同步界面语言（AI 输出跟随）
    syncLang(req, session.userId);

    // 理一理按触发它的角色来梳理（人设 + 该角色维度记忆）；缺省回落小愈
    const structureCharacter = resolveStructureCharacter(session);

    // 统一点数：生成详细分析也计费（此前免费，属成本泄漏）；失败回滚
    if (isCreditQuotaEnabled() && session.userId) {
      quotaUserId = session.userId;
      const creditQuota = quotaStore.getCreditQuota(quotaUserId);
      const est = { credit: actionPricePoints('detailedAnalysis') }; // 整数价目表
      const reserve = quotaStore.reserveCredit(quotaUserId, 'structure', est);
      if (!reserve.ok) {
        res.status(402).json({ success: false, error: '今日额度点数已用完，明天再来，或升级解锁更多', code: 'QUOTA_EXCEEDED', data: { quota: quotaStore.getQuota(quotaUserId), creditQuota } });
        return;
      }
      creditToken = reserve.token!;
    }

    // 生成详细分析
    const analysisResult = await generateDetailedAnalysis(
      session.emotionAnalysis,
      answeredQuestions.map(q => ({ question: q.question, answer: q.answer! })),
      session.userId,
      structureCharacter
    );
    
    const detailedAnalysis = {
      id: uuidv4(),
      category: analysisResult.category,
      valence: analysisResult.valence,
      emotionalState: analysisResult.emotionalState,
      triggers: analysisResult.triggers,
      coreIssues: analysisResult.coreIssues,
      recommendations: analysisResult.recommendations,
      positiveFactors: analysisResult.positiveFactors,
      timestamp: new Date()
    };

    memoryStorage.updateSession(sessionId, {
      detailedAnalysis
    });

    if (creditToken && quotaUserId) { quotaStore.commitCredit(quotaUserId, creditToken); creditToken = null; }
    res.json({
      success: true,
      data: {
        analysis: detailedAnalysis
      }
    });
  } catch (error) {
    if (creditToken && quotaUserId) { quotaStore.rollbackCredit(quotaUserId, creditToken); creditToken = null; }
    console.error('Detailed analysis error:', error);
    res.status(500).json({
      success: false,
      error: safeError('ai', error)
    });
  }
});

/**
 * 生成疗愈故事
 * POST /api/analysis/story
 */
router.post('/story', async (req: Request, res: Response): Promise<void> => {
  let quotaUserId: string | null = null;
  let creditToken: string | null = null;
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      res.status(400).json({
        success: false,
        error: '请提供会话ID'
      });
      return;
    }

    const session = memoryStorage.getSession(sessionId);
    if (!session || !isRecordOwner(req, session)) {
      res.status(404).json({
        success: false,
        error: '未找到会话'
      });
      return;
    }

    // 同步界面语言（AI 输出跟随）
    syncLang(req, session.userId);

    // 理一理按触发它的角色来梳理（人设 + 该角色维度记忆）；缺省回落小愈
    const structureCharacter = resolveStructureCharacter(session);

    // 幂等：同一会话已生成过故事则直接返回，避免重复调 LLM 刷成本
    if (session.healingStory) {
      res.json({ success: true, data: { story: session.healingStory } });
      return;
    }

    // 支持直接从"情绪理解"跳到故事生成（跳过问答与详细分析）
    let storyBase = session.detailedAnalysis;
    if (!storyBase) {
      if (!session.emotionAnalysis) {
        res.status(404).json({
          success: false,
          error: '未找到情绪理解结果，请先进行一次情绪分析'
        });
        return;
      }
      const ea = session.emotionAnalysis;
      storyBase = {
        id: uuidv4(),
        category: ea.category,
        emotionalState: ea.analysis,
        triggers: [ea.category || '此刻的感受'],
        coreIssues: [],
        recommendations: ea.suggestions || [],
        positiveFactors: [],
        timestamp: new Date(),
      };
    }

    // 生成疗愈故事（语言跟随：传用户最近的输入，问答答案优先，否则原始情绪输入）
    const answersText = (session.questions || []).filter(q => q.answer).map(q => q.answer).join('\n');
    // 统一点数：生成故事也计费（此前免费，属成本泄漏）；失败回滚
    if (isCreditQuotaEnabled() && session.userId) {
      quotaUserId = session.userId;
      const creditQuota = quotaStore.getCreditQuota(quotaUserId);
      const est = { credit: actionPricePoints('healingStory') }; // 整数价目表
      const reserve = quotaStore.reserveCredit(quotaUserId, 'structure', est);
      if (!reserve.ok) {
        res.status(402).json({ success: false, error: '今日额度点数已用完，明天再来，或升级解锁更多', code: 'QUOTA_EXCEEDED', data: { quota: quotaStore.getQuota(quotaUserId), creditQuota } });
        return;
      }
      creditToken = reserve.token!;
    }
    const storyResult = await generateHealingStory(storyBase, session.userId, answersText || session.rawInput, structureCharacter);
    
    const healingStory = {
      id: uuidv4(),
      title: storyResult.title,
      content: storyResult.content,
      mood: storyResult.mood,
      timestamp: new Date()
    };

    memoryStorage.updateSession(sessionId, {
      healingStory
    });

    if (creditToken && quotaUserId) { quotaStore.commitCredit(quotaUserId, creditToken); creditToken = null; }
    res.json({
      success: true,
      data: {
        story: healingStory
      }
    });
  } catch (error) {
    if (creditToken && quotaUserId) { quotaStore.rollbackCredit(quotaUserId, creditToken); creditToken = null; }
    console.error('Healing story generation error:', error);
    res.status(500).json({
      success: false,
      error: safeError('ai', error)
    });
  }
});

/**
 * 上报网站访问（独立访客统计，按设备指纹去重；v5 起顺带记录 IP 地理快照供地区分布统计）
 * POST /api/analysis/visit
 */
router.post('/visit', async (req: Request, res: Response): Promise<void> => {
  const deviceId = String(req.headers['x-device-id'] || '');
  // 离线解析 IP 地区（国家头优先，ip2region 兜底大陆细分；IP 不外发）
  const ip = getClientIp(req);
  let geo: { ip: string; country: string; region: string; city: string; isp: string } | undefined;
  if (ip) {
    const info = lookupIp(ip, getClientCountry(req));
    geo = { ip, country: info.country, region: info.region, city: info.city, isp: info.isp };
  }
  const count = visitStore.recordVisit(deviceId, geo);
  // 来源归因：同一请求顺手记下该匿名设备的触点（first-touch + 触点路径）。
  // 只存渠道维度（source/medium/campaign/referrer 主机/落地路径），不存 IP 与任何用户输入；
  // 注册时按同一个 `X-Device-Id` 把 first-touch 落到账号上（见 services/attribution.ts 与 routes/auth.ts）
  try {
    const { attributionStore } = await import('../services/attribution.js');
    const attr = (req.body || {}).attr || {};
    attributionStore.recordTouch(deviceId, attr.current || attr.first);
  } catch { /* 归因失败不影响访问统计 */ }
  res.json({ success: true, data: { visits: count } });
});

/**
 * 查询当前用户的历史疗愈记录
 * GET /api/analysis/history
 */
router.get('/history', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);

    const sessions = memoryStorage.getActiveSessions()
      .filter(s => s.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const records = sessions.map(s => ({
      sessionId: s.sessionId,
      createdAt: s.createdAt,
      emotion: s.emotionAnalysis?.emotion,
      intensity: s.emotionAnalysis?.intensity,
      analysis: s.emotionAnalysis?.analysis,
      suggestions: s.emotionAnalysis?.suggestions,
      questionsCount: s.questions?.length || 0,
      answeredCount: (s.questions || []).filter(q => q.answer).length,
      detailedState: s.detailedAnalysis?.emotionalState,
      storyTitle: s.healingStory?.title,
      storyMood: s.healingStory?.mood,
      storyContent: s.healingStory?.content,
    }));

    res.json({ success: true, data: records });
  } catch (error) {
    console.error('History query error:', error);
    res.status(500).json({ success: false, error: '获取历史记录失败' });
  }
});

/**
 * AI 多轮追问：用户对分析/建议继续提问
 * POST /api/analysis/followup { sessionId, question }
 */

/**
 * 查询当前用户的聊一聊历史记录（跨会话聚合，按时间正序）
 * GET /api/analysis/chat-history
 * 返回该用户所有会话里的 chatMessages，让聊一聊模式能看到过去聊过的内容
 */
router.get('/chat-history', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    const sessions = memoryStorage.getActiveSessions().filter(s => s.userId === userId);
    const messages: { role: string; content: string; timestamp: Date; image?: string; audio?: string }[] = [];
    for (const s of sessions) {
      if (s.chatMessages) {
        for (const m of s.chatMessages) {
          messages.push({ role: m.role, content: m.content, timestamp: m.timestamp, image: m.image, audio: m.audio });
        }
      }
    }
    messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    res.json({ success: true, data: messages.slice(-200) });
  } catch (error) {
    console.error('Chat history query error:', error);
    res.status(500).json({ success: false, error: '获取聊天历史失败' });
  }
});

/**
 * 列出当前用户的所有聊一聊对话（多对话会话列表）
 * GET /api/analysis/chats
 * 仅返回包含聊天消息的会话，按最近更新倒序；每条含标题/预览/条数
 */
router.get('/chats', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    const sessions = memoryStorage.getActiveSessions()
      .filter(s => s.userId === userId && s.chatMessages && s.chatMessages.length > 0);

    const chats = sessions.map(s => {
      const msgs = s.chatMessages!;
      const firstUser = msgs.find(m => m.role === 'user');
      const last = msgs[msgs.length - 1];
      return {
        sessionId: s.sessionId,
        title: s.chatTitle || (firstUser ? firstUser.content.slice(0, 30) : ''),
        preview: last ? last.content.slice(0, 60) : '',
        messageCount: msgs.length,
        createdAt: s.createdAt,
        updatedAt: s.chatUpdatedAt || s.updatedAt,
        pinned: !!s.chatPinned,
        characterId: s.characterId || 'xiaoyu',
        // 每条会话自己的未读（第二层"多对话"抽屉要能指出来"是哪一条还有未读"，否则角标就说不清）
        unread: countUnread(s),
      };
    }).sort((a, b) =>
      // 置顶会话排最前，其余按最近更新倒序
      (Number(b.pinned) - Number(a.pinned)) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );

    res.json({ success: true, data: chats });
  } catch (error) {
    console.error('Chat list error:', error);
    res.status(500).json({ success: false, error: '获取对话列表失败' });
  }
});

/**
 * 微信式消息列表（方案 A2）：**一个角色一行**：最后一条、时间、未读数（跨该角色的多条会话求和）。
 * GET /api/analysis/chat/inbox
 *
 * 为什么单独一条接口而不是塞进 GET /chats：列表要按「角色」聚合（一个角色可能有多条会话，
 * 且用户想看的是"谁给我发了消息"），而 /chats 是「会话」维度、抽屉里那一层用。
 */
router.get('/chat/inbox', (req: Request, res: Response): void => {
  try {
    const userId = resolveUserId(req);
    const sessions = memoryStorage.getActiveSessions()
      .filter((s) => s.userId === userId && s.chatMessages && s.chatMessages.length > 0);
    const rows = new Map<string, {
      characterId: string; sessionId: string; title: string; preview: string; lastRole: 'user' | 'assistant';
      updatedAt: number; unread: number; pinned: boolean; messageCount: number;
      /** 该角色**真正有未读**的那条会话（取最近的一条）；没有未读时为空串 */
      unreadSessionId: string;
    }>();
    for (const s of sessions) {
      const cid = s.characterId || 'xiaoyu';
      const msgs = s.chatMessages!;
      const firstUser = msgs.find((m) => m.role === 'user');
      const last = msgs[msgs.length - 1];
      const updatedAt = new Date(s.chatUpdatedAt || s.updatedAt).getTime();
      const unread = countUnread(s);
      const exists = rows.get(cid);
      if (!exists) {
        rows.set(cid, {
          characterId: cid,
          sessionId: s.sessionId,
          title: s.chatTitle || (firstUser ? firstUser.content.slice(0, 30) : ''),
          preview: last ? last.content.slice(0, 60) : '',
          // 最后一条是谁说的：列表里要能区分"TA 发来的"和"我自己说的"（微信的「我: …」）
          lastRole: last?.role === 'assistant' ? 'assistant' : 'user',
          updatedAt,
          unread,
          pinned: !!s.chatPinned,
          messageCount: msgs.length,
          unreadSessionId: unread > 0 ? s.sessionId : '',
        });
        continue;
      }
      exists.unread += unread;
      // 有未读的那条会话：取**最近**的一条（列表点进去要打开它，否则角标会变成点不掉的红点）
      if (unread > 0 && (!exists.unreadSessionId || updatedAt >= exists.updatedAt)) exists.unreadSessionId = s.sessionId;
      // 行上的"最后一条/时间"取该角色**最近活跃**的那条会话
      if (updatedAt > exists.updatedAt) {
        exists.sessionId = s.sessionId;
        exists.title = s.chatTitle || (firstUser ? firstUser.content.slice(0, 30) : '');
        exists.preview = last ? last.content.slice(0, 60) : '';
        exists.lastRole = last?.role === 'assistant' ? 'assistant' : 'user';
        exists.updatedAt = updatedAt;
        exists.pinned = !!s.chatPinned;
        exists.messageCount = msgs.length;
      }
    }
    const list = Array.from(rows.values()).sort((a, b) =>
      (Number(b.pinned) - Number(a.pinned)) || (b.updatedAt - a.updatedAt));
    res.json({ success: true, data: list });
  } catch (error) {
    console.error('Chat inbox error:', error);
    res.status(500).json({ success: false, error: '获取消息列表失败' });
  }
});

/**
 * 标记已读（在会话里持续收发时调用；打开会话那条路径由 GET /chats/:sessionId 自己清）
 * POST /api/analysis/chat/read  body: { sessionId } 或 { characterId }（后者清该角色全部会话）
 */
router.post('/chat/read', (req: Request, res: Response): void => {
  try {
    const userId = resolveUserId(req);
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
    const characterId = typeof req.body?.characterId === 'string' ? req.body.characterId : '';
    if (!sessionId && !characterId) {
      res.status(400).json({ success: false, error: '缺少 sessionId 或 characterId' });
      return;
    }
    const now = Date.now();
    /**
     * `upTo`（可选）= 客户端**屏幕上最后一条消息的时间戳**。
     *
     * 🚨 为什么必须有它（2026-09-20 用户报的 bug：发完消息退出，「有红点，进去却看不到新消息」）：
     * 客户端在**流式过程中**（用户消息入列、助手消息还是占位）就会触发一次已读；那时服务端**还没**
     * 把回复落库，若按 `now` 记已读，随后落库的回复时间戳会**晚于**这个 now ⇒ 刚看过的回复被算成未读。
     * 现在改成"已读到客户端真正看到的那一条为止"（仍不超过 now，避免客户端时钟跑偏把未来的消息吞掉）。
     */
    const upToRaw = typeof req.body?.upTo === 'number' && Number.isFinite(req.body.upTo) ? req.body.upTo : undefined;
    const target = Math.min(now, upToRaw !== undefined ? Math.max(0, upToRaw) : now);
    let marked = 0;
    const mine = memoryStorage.getActiveSessions().filter((s) => s.userId === userId);
    for (const s of mine) {
      const hit = sessionId ? s.sessionId === sessionId : (s.characterId || 'xiaoyu') === characterId;
      if (!hit) continue;
      const prev = typeof s.chatLastReadAt === 'number' ? s.chatLastReadAt : 0;
      // 只前移、不回退：晚到的旧请求不该把已经读过的消息重新变成未读
      if (target > prev) memoryStorage.updateSession(s.sessionId, { chatLastReadAt: target });
      marked++;
    }
    res.json({ success: true, data: { marked } });
  } catch (error) {
    console.error('Chat read error:', error);
    res.status(500).json({ success: false, error: '标记已读失败' });
  }
});

/**
 * 获取单个聊一聊对话的消息
 * GET /api/analysis/chats/:sessionId
 */
router.get('/chats/:sessionId', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    const session = memoryStorage.getSession(req.params.sessionId);
    if (!session || session.userId !== userId) {
      res.status(404).json({ success: false, error: '对话不存在或已过期' });
      return;
    }
    const messages = (session.chatMessages || []).map(m => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      image: m.image,
      audio: m.audio,
      // 引用回复落库后回传：刷新/换设备重进，用户消息里的引用卡还在
      replyTo: m.replyTo,
    }));
    // ⚠️ 这里**刻意不**把未读清掉（2026-09-20 端到端实测抓到的坑）：
    // 聊一聊挂载时就会 GET 最近一条会话（把消息先铺在界面后面），若 GET 顺手标已读，
    // 未读角标会在用户看到列表**之前**就被抹掉，角标等于白做。
    // 已读改由客户端在「用户真的进了/正在看这个窗口」时调 POST /chat/read。
    res.json({
      success: true,
      data: { sessionId: session.sessionId, title: session.chatTitle || '', characterId: session.characterId || 'xiaoyu', messages },
    });
  } catch (error) {
    console.error('Chat session query error:', error);
    res.status(500).json({ success: false, error: '获取对话失败' });
  }
});

/**
 * 删除单个聊一聊对话
 * DELETE /api/analysis/chats/:sessionId
 * 若该会话还承载「理一理」结构化数据，仅清空聊天部分；否则删除整个会话
 */
router.delete('/chats/:sessionId', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    const session = memoryStorage.getSession(req.params.sessionId);
    if (!session || session.userId !== userId) {
      res.status(404).json({ success: false, error: '对话不存在或已过期' });
      return;
    }
    const hasStructure = !!(
      session.emotionAnalysis ||
      session.detailedAnalysis ||
      session.healingStory ||
      (session.questions && session.questions.length > 0)
    );
    if (hasStructure) {
      memoryStorage.updateSession(session.sessionId, { chatMessages: [], chatTitle: undefined, chatUpdatedAt: undefined });
    } else {
      memoryStorage.deleteSession(session.sessionId);
    }
    res.json({ success: true, data: { message: '已删除' } });
  } catch (error) {
    console.error('Chat delete error:', error);
    res.status(500).json({ success: false, error: '删除对话失败' });
  }
});

/**
 * 更新聊一聊对话（重命名 / 置顶）
 * PATCH /api/analysis/chats/:sessionId { title?, pinned? }
 */
router.patch('/chats/:sessionId', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = resolveUserId(req);
    const session = memoryStorage.getSession(req.params.sessionId);
    if (!session || session.userId !== userId) {
      res.status(404).json({ success: false, error: '对话不存在或已过期' });
      return;
    }
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 60) : '';
    const pinned = req.body?.pinned;
    const hasTitle = !!title;
    const hasPinned = pinned === true || pinned === false;
    if (!hasTitle && !hasPinned) {
      res.status(400).json({ success: false, error: '没有可更新的内容' });
      return;
    }
    const updates: Parameters<typeof memoryStorage.updateSession>[1] = {
      chatUpdatedAt: session.chatUpdatedAt || new Date(), // 保持聊天更新时间不变（置顶不应改变「最近活跃」排序）
    };
    if (hasTitle) updates.chatTitle = title;
    if (hasPinned) updates.chatPinned = !!pinned;
    memoryStorage.updateSession(session.sessionId, updates);
    const data: Record<string, unknown> = { sessionId: session.sessionId };
    if (hasTitle) data.title = title;
    if (hasPinned) data.pinned = !!pinned;
    res.json({ success: true, data });
  } catch (error) {
    console.error('Chat rename error:', error);
    res.status(500).json({ success: false, error: '更新对话失败' });
  }
});

router.post('/followup', async (req: Request, res: Response): Promise<void> => {
  let quotaUserId: string | null = null;
  let quotaConsumed = false;
  let creditToken: string | null = null;
  const rollbackQuota = () => {
    if (quotaConsumed && quotaUserId) {
      quotaStore.rollback(quotaUserId);
      quotaConsumed = false;
    }
    if (creditToken && quotaUserId) {
      quotaStore.rollbackCredit(quotaUserId, creditToken);
      creditToken = null;
    }
  };
  try {
    const { sessionId, question } = req.body || {};
    if (!sessionId || !question || typeof question !== 'string') {
      res.status(400).json({ success: false, error: '缺少会话ID或问题' });
      return;
    }
    const session = memoryStorage.getSession(sessionId);
    if (!session || !isRecordOwner(req, session)) {
      res.status(404).json({ success: false, error: '未找到会话' });
      return;
    }
    syncLang(req, session.userId);
    const structureCharacter = resolveStructureCharacter(session);
    quotaUserId = session.userId || null;
    // 计费：点数模式按预估 token 预留；计数模式消耗 1 次理一理额度（追问是持续性额外对话，此前免费属成本泄漏）
    if (quotaUserId) {
      if (isCreditQuotaEnabled()) {
        const creditQuota = quotaStore.getCreditQuota(quotaUserId);
        const est = { credit: actionPricePoints('followup') }; // 整数价目表
        const reserve = quotaStore.reserveCredit(quotaUserId, 'structure', est);
        if (!reserve.ok) {
          res.status(402).json({ success: false, error: '今日额度点数已用完，明天再来，或升级解锁更多', code: 'QUOTA_EXCEEDED', data: { quota: quotaStore.getQuota(quotaUserId), creditQuota } });
          return;
        }
        creditToken = reserve.token!;
      } else {
        const quota = quotaStore.getQuota(quotaUserId);
        if (!quota.canUse) {
          res.status(402).json({ success: false, error: '免费次数已用完，请付费解锁后继续使用', code: 'QUOTA_EXCEEDED', data: { quota } });
          return;
        }
        quotaConsumed = quotaStore.consume(quotaUserId);
      }
    }
    const answer = await followUp(
      {
        analysis: session.emotionAnalysis?.analysis,
        suggestions: session.emotionAnalysis?.suggestions,
        detailed: session.detailedAnalysis?.emotionalState,
        story: session.healingStory?.content,
      },
      String(question).slice(0, 500),
      session.userId,
      structureCharacter
    );
    // 输出安全（P1-07）：指令式高危内容替换为危机引导
    const finalAnswer = checkAiOutputSafety(answer).safe ? answer : pickGuide(pickLang(req), true);
    if (creditToken && quotaUserId) { quotaStore.commitCredit(quotaUserId, creditToken); creditToken = null; }
    res.json({ success: true, data: { answer: finalAnswer } });
  } catch (error) {
    rollbackQuota();
    console.error('Follow-up error:', error);
    res.status(500).json({ success: false, error: '回答失败，请稍后重试' });
  }
});

/**
 * 获取会话信息
 * GET /api/analysis/session/:sessionId
 */
router.get('/session/:sessionId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;

    const session = memoryStorage.getSession(sessionId);
    if (!session || !isRecordOwner(req, session)) {
      res.status(404).json({
        success: false,
        error: '未找到会话'
      });
      return;
    }

    res.json({
      success: true,
      data: {
        session
      }
    });
  } catch (error) {
    console.error('Session retrieval error:', error);
    res.status(500).json({
      success: false,
      error: '获取会话信息失败'
    });
  }
});

// 【自定义角色头像：允许站内图片路径或压缩后的 data:image 小图】
const MAX_AVATAR = 300000;
const AVATAR_DATA_RE = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const AVATAR_PATH_RE = /^\/img\/[A-Za-z0-9-]+\.(jpg|jpeg|png|webp)$/;
function isValidAvatar(v: string): boolean {
  if (!v) return true;
  return AVATAR_PATH_RE.test(v) || AVATAR_DATA_RE.test(v);
}

/**
 * 聊一聊角色（灵魂框架）CRUD
 * GET    /api/analysis/chat/characters            → [内置小愈, ...用户自建]
 * POST   /api/analysis/chat/characters            → 创建（需登录，内容安全过滤）
 * PATCH  /api/analysis/chat/characters/:id        → 更新（需登录）
 * DELETE /api/analysis/chat/characters/:id        → 删除（需登录；内置小愈不可删）
 */
router.get('/chat/characters', (req: Request, res: Response): void => {
  const user = getAuthUser(req);
  if (!user) {
    // 未登录：仅内置小愈
    res.json({ success: true, data: [XIAOYU_CHARACTER] });
    return;
  }
  res.json({ success: true, data: chatCharacterStore.listForUser(user.userId) });
});

router.post('/chat/characters', (req: Request, res: Response): void => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '请先登录', code: 'LOGIN_REQUIRED' });
    return;
  }
  const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const name = clean(req.body?.name);
  const identity = clean(req.body?.identity);
  const boundaries = clean(req.body?.boundaries);
  const voice = clean(req.body?.voice);
  const avatar = clean(req.body?.avatar);
  const opening = clean(req.body?.opening);
  const ttsVoice = clean(req.body?.ttsVoice); // 该角色的 TTS 音色（JSON；可选）
  // 关系档（可选）：四档白名单，非法值当没传（回落 friend）
  const relation = String(req.body?.relation ?? '').trim();
  if (!name || !identity || !boundaries || !voice) {
    res.status(400).json({ success: false, error: '名字、他是谁、底线、口吻均为必填' });
    return;
  }
  for (const v of [name, identity, boundaries, voice, opening]) {
    if (v && v.length > 2000) {
      res.status(400).json({ success: false, error: '内容过长' });
      return;
    }
  }
  if (avatar && avatar.length > MAX_AVATAR) {
    res.status(400).json({ success: false, error: '头像过大，请换一张更小的图片' });
    return;
  }
  if (!isValidAvatar(avatar)) {
    res.status(400).json({ success: false, error: '头像格式不支持' });
    return;
  }
  // 内容安全（红线 #5）：自建角色的人设/开场必须过过滤，命中即拒
  const safety = checkCustomScenario({
    title: name,
    aiName: name,
    aiPersona: [identity, boundaries, voice, opening].filter(Boolean).join('\n'),
  });
  if (!safety.safe) {
    res.status(400).json({ success: false, error: '内容包含不当信息，无法创建', code: 'CONTENT_REJECTED' });
    return;
  }
  if (chatCharacterStore.nameExists(user.userId, name)) {
    res.status(400).json({ success: false, error: '已有同名角色' });
    return;
  }
  const rec = chatCharacterStore.create(user.userId, { name, avatar, identity, boundaries, voice, ttsVoice, opening, ...(isRelationKind(relation) ? { relation } : {}) });
  // 新手创作礼：首次创建自建对象送 1 次 AI 剧本生成额度（只送一次）
  const gifted = quotaStore.grantFirstCharCreationGift(user.userId);
  res.json({ success: true, data: { ...rec, gift: gifted ? { type: 'char-gift', genCredit: 1 } : null } });
});

/**
 * 剧情角色 → 聊一聊角色（方案 A1，见 `剧情角色接入聊一聊-方案.md`）
 * POST /api/analysis/chat/characters/import-story
 * body: { scenarioId, aiName?, userName?, storyMode? }
 *
 * 做三件事（一次请求内）：① 物化角色（幂等：同一剧本重复调用 = 刷新）② 提炼共同经历摘要写进记忆
 * ③ 把剧情切块存进 storyArchive（供话题碰得到时按需召回）。
 *
 * ⚠️ 红线 5（自建剧本内容安全）：导入前先对**源头剧本文本**再过一次过滤，剧本创建时已经审过一次，
 * 这里复检的理由是「剧本可能被作者改过」「导入是另一条进入业务数据的路径」，两条路都要有闸门。
 */
router.post('/chat/characters/import-story', async (req: Request, res: Response): Promise<void> => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '请先登录', code: 'LOGIN_REQUIRED' });
    return;
  }
  const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const scenarioId = clean(req.body?.scenarioId).slice(0, 120);
  if (!scenarioId) {
    res.status(400).json({ success: false, error: '缺少剧本 id' });
    return;
  }
  // 名字上限与剧情模式同一口径（`api/routes/roleplay.ts` 里也是 slice(0,20)）
  const aiName = clean(req.body?.aiName).slice(0, 20);
  const userName = clean(req.body?.userName).slice(0, 20);
  const rawMode = clean(req.body?.storyMode);
  const storyMode: StoryMode | undefined = rawMode === 'out' ? 'out' : rawMode === 'in' ? 'in' : undefined;

  // ① 源头复检（红线 5）：拿不到剧本就直接拒（不建半成品角色）
  const brief = resolveScenarioBrief(scenarioId);
  if (!brief) {
    res.status(404).json({ success: false, error: '剧本不存在或已删除' });
    return;
  }
  const safety = checkCustomScenario({
    title: brief.title,
    aiName: brief.aiName,
    aiPersona: [brief.aiPersonality, brief.background, brief.openingScene].filter(Boolean).join('\n'),
  });
  if (!safety.safe) {
    res.status(400).json({ success: false, error: '内容包含不当信息，无法导入', code: 'CONTENT_REJECTED' });
    return;
  }

  try {
    const result = await importStoryCharacter({ userId: user.userId, scenarioId, aiName, userName, storyMode });
    res.json({
      success: true,
      data: {
        character: result.character,
        created: result.created,
        msgCount: result.msgCount,
        blockCount: result.blockCount,
        // false = 模型不可用，已用规则抽取降级（用户仍拿到结构化记忆，界面不必提示失败）
        digestByModel: result.digestByModel,
      },
    });
  } catch (error) {
    if (error instanceof StoryBridgeError) {
      const code = error.code === 'NO_STORY' ? 400 : 404;
      res.status(code).json({ success: false, error: error.message, code: error.code });
      return;
    }
    console.error('❌ [chat/import-story] 导入失败:', safeError('server', error));
    res.status(500).json({ success: false, error: '导入失败，请稍后再试' });
  }
});

/**
 * 增量同步一段新剧情（用户又回去玩了几轮）
 * POST /api/analysis/chat/characters/:id/story-sync → { added, syncedMsgCount }
 */
router.post('/chat/characters/:id/story-sync', async (req: Request, res: Response): Promise<void> => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '请先登录', code: 'LOGIN_REQUIRED' });
    return;
  }
  try {
    const r = await syncStoryCharacter(user.userId, String(req.params.id));
    res.json({ success: true, data: r });
  } catch (error) {
    if (error instanceof StoryBridgeError) {
      res.status(error.code === 'NOT_STORY_CHARACTER' ? 400 : 404).json({ success: false, error: error.message, code: error.code });
      return;
    }
    console.error('❌ [chat/story-sync] 同步失败:', safeError('server', error));
    res.status(500).json({ success: false, error: '同步失败，请稍后再试' });
  }
});

/**
 * 「TA 记得的这段剧情」（只读回看：摘要 + 场面块 + 剧情那边的新进度）
 * GET /api/analysis/chat/characters/:id/story
 */
router.get('/chat/characters/:id/story', (req: Request, res: Response): void => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '请先登录', code: 'LOGIN_REQUIRED' });
    return;
  }
  const view = getStoryView(user.userId, String(req.params.id));
  if (!view) {
    res.status(404).json({ success: false, error: '这不是剧情角色' });
    return;
  }
  res.json({ success: true, data: view });
});

router.patch('/chat/characters/:id', (req: Request, res: Response): void => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '请先登录', code: 'LOGIN_REQUIRED' });
    return;
  }
  const rec = chatCharacterStore.get(user.userId, String(req.params.id));
  if (!rec) {
    res.status(404).json({ success: false, error: '角色不存在' });
    return;
  }
  const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const updates: Partial<Pick<ChatCharacter, 'name' | 'avatar' | 'identity' | 'boundaries' | 'voice' | 'ttsVoice' | 'opening' | 'storyMode' | 'relation'>> = {};
  for (const k of ['name', 'avatar', 'identity', 'boundaries', 'voice', 'ttsVoice', 'opening'] as const) {
    if (req.body?.[k] !== undefined) updates[k] = clean(req.body[k]);
  }
  // 双态开关（剧情角色专用；入戏 / 出戏），只认这两个取值，其它一律忽略
  const rawMode = clean(req.body?.storyMode);
  if (rawMode === 'in' || rawMode === 'out') updates.storyMode = rawMode;
  // 关系档（每角色一档）：同样只认四档白名单；非法值/未传 = 不改
  const rawRelation = clean(req.body?.relation);
  if (isRelationKind(rawRelation)) updates.relation = rawRelation;
  for (const v of Object.values(updates)) {
    if (v && v.length > 2000 && v !== updates.avatar) {
      res.status(400).json({ success: false, error: '内容过长' });
      return;
    }
  }
  if (updates.avatar && updates.avatar.length > MAX_AVATAR) {
    res.status(400).json({ success: false, error: '头像过大，请换一张更小的图片' });
    return;
  }
  if (updates.avatar !== undefined && !isValidAvatar(updates.avatar)) {
    res.status(400).json({ success: false, error: '头像格式不支持' });
    return;
  }
  const safety = checkCustomScenario({
    title: updates.name || rec.name,
    aiName: updates.name || rec.name,
    aiPersona: [
      updates.identity ?? rec.identity,
      updates.boundaries ?? rec.boundaries,
      updates.voice ?? rec.voice,
      updates.opening ?? rec.opening,
    ].filter(Boolean).join('\n'),
  });
  if (!safety.safe) {
    res.status(400).json({ success: false, error: '内容包含不当信息，无法更新', code: 'CONTENT_REJECTED' });
    return;
  }
  const updated = chatCharacterStore.update(user.userId, rec.id, updates);
  res.json({ success: true, data: updated });
});

router.get('/chat/characters/:id/growth', (req: Request, res: Response): void => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '请先登录', code: 'LOGIN_REQUIRED' });
    return;
  }
  const id = String(req.params.id);
  const rec = chatCharacterStore.get(user.userId, id);
  if (!rec) {
    res.status(404).json({ success: false, error: '角色不存在' });
    return;
  }
  const growth = chatCharacterGrowthStore.get(user.userId, id);
  // 观景窗：统一展示「成长记忆」+「长期记忆（TA 记得的你）」；日记/反思/关系记忆按最新在前
  const latestFirst = (a: { at: number }, b: { at: number }) => b.at - a.at;
  // 长期记忆带时间轴（2026-09-17）：每条附 kind/at/dateKey/stale，前端显示「记住于 X」
  const todayKey = todayKeyIn(resolveUserTimezone(req, user.userId) || '');
  const factEntries = longMemoryStore.getEntries(user.userId, id).map((e) => toEntryView(e, todayKey));
  res.json({
    success: true,
    data: {
      ...growth,
      userFacts: factEntries.map((e) => e.text),
      userFactEntries: factEntries,
      relationship: [...growth.relationship].sort(latestFirst),
      diary: [...growth.diary].sort(latestFirst),
      reflections: [...growth.reflections].sort(latestFirst),
    },
  });
});

router.delete('/chat/characters/:id', (req: Request, res: Response): void => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '请先登录', code: 'LOGIN_REQUIRED' });
    return;
  }
  const ok = chatCharacterStore.delete(user.userId, String(req.params.id));
  if (ok) {
    chatCharacterGrowthStore.deleteByCharacter(user.userId, String(req.params.id));
    // 剧情档案（从剧情迁移过来的场面块/摘要副本）随角色一起清掉：删角色就该删掉这份副本。
    // ⚠️ 边界：longMemory 里该角色维度的条目**目前不随删角色清除**（既有行为，普通自建角色也一样），
    //    不在本次范围内顺手改（会把无关行为一起改了）；需要时单独排期。
    storyArchiveStore.deleteByCharacter(user.userId, String(req.params.id));
  }
  res.json({ success: ok, data: ok });
});

export default router;
