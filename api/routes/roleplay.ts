/**
 * 角色剧情扮演 API
 * GET  /api/roleplay/scenarios  剧本列表（含设定 + 点赞数）
 * POST /api/roleplay/chat       { scenarioId, messages } → 剧情回复
 * POST /api/roleplay/like       { scenarioId } → 点赞/取消点赞
 * GET  /api/roleplay/likes/stream  剧本点赞实时广播（SSE，跨端即时同步）
 */

import 'dotenv/config';
import { Router, type Request, type Response } from 'express';
import { safeError } from '../services/safeError.js';
import { listScenarios, getScenario, getScenarioInfo, roleplayReply, roleplayReplyCustom, roleplayReplyWithContinuation, roleplaySuggestions, roleplaySuggestionsCustom, searchScenarios, listTagGroups, getDisplayLikes, roleplayDraftCustom, roleplayReviseCustom, isCompleteCustomDraft, normalizeCustomIdea, unlimitedActiveFor, unlimitedForScenario, roleplayTurnLengthBand, roleplayContinuationBudget, type CustomDraftFields, type RoleplayMessage, type RPLang, type RoleplayNarrativeStyle } from '../services/roleplay.js';
import { parseRoleplayMode, type RoleplayMode } from '../../src/lib/roleplayMode.js';
import { preferenceStore } from '../services/preferences.js';
import { mergeContinuationGuarded, trimAdditionToBudget } from '../../src/lib/replyCompleteness.js';
import { toZhTw, toOutputLang } from '../services/zhConvert.js';
import { resolveUserId, getAuthUser } from '../services/session.js';
import { getClientCountry, getClientIp } from '../services/geo.js';
import { quotaStore, isCreditQuotaEnabled, actionPricePoints} from '../services/quota.js';
import { activityStore, isTestRequest } from '../services/activity.js';
import { roleplaySessionStore } from '../services/roleplaySessions.js';
import { aiFailureStore } from '../services/aiFailure.js';
import { roleplayLikeStore } from '../services/roleplayLikes.js';
import { bgmPrefStore } from '../services/bgmPrefs.js';
import { validateSceneArtRequest, generateSceneArt, findCachedSceneArt, findMasterSceneArt, findOwnThemeArt, listOwnThemeUrls, sceneArtQuota, sceneArtBackendInfo } from '../services/sceneArt.js';
import { customRoleplayStore, type CustomScenario } from '../services/customRoleplay.js';
import { creationPromptLog } from '../services/creationPromptLog.js';
import { resolveRoleplayTitle } from '../services/scenarioTitle.js';
import { checkCustomScenario, checkContentSafety, isSelfHarmContent, checkAiOutputSafety } from '../services/safety.js';
import { pickGuide } from '../services/prompts.js';
import { accountStore } from '../services/accounts.js';
import { notifyNewUgcSubmission } from '../services/adminNotifier.js';
import { roleplayUnlimitedAvailable, roleplayRoutingSummary } from '../services/roleplayModel.js';
import { isAdultConfirmed } from '../services/adultConfirm.js';
import { runRepeatGate, repeatGateEnabled } from '../services/repeatGate.js';
import { assessReplyRepeat, assessSuggestionsRepeat } from '../services/repeatRefund.js';
import { createBeatPlanFilter } from '../../src/lib/beatPlan.js';

/** 校验用户上传的图片 data URL：仅允许 JPEG/PNG/WebP 的 base64，且总长度受限（避免超大 Blob 撑爆 JSON） */
function isImageDataUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/.test(v)) return false;
  if (v.length > 1_500_000) return false;
  return true;
}

const router = Router();

// 剧情扮演（角色扮演）回合：成本约为短聊的 1.4 倍，计数模式下按 1 条聊天额度计（与聊一聊同价，鼓励体验）
const ROLEPLAY_TURN_CHAT_COST = 1;
// 剧情扮演「AI 帮我写剧本 / 改稿」：单次 AI 生成，成本≈1.1 倍短聊 → 1 条
const ROLEPLAY_GEN_CHAT_COST = 1;

/** SSE 在线客户端集合：任意用户点赞/取消后向所有在线会话广播最新计数 */
const likeStreamClients = new Set<Response>();

/** 向所有订阅者广播某个剧本的最新点赞数 */
function broadcastLike(scenarioId: string, count: number): void {
  const payload = JSON.stringify({ scenarioId, count });
  for (const client of likeStreamClients) {
    try {
      client.write('data: ' + payload + '\n\n');
    } catch {
      likeStreamClients.delete(client);
    }
  }
}

/**
 * 剧本点赞实时广播（SSE）：在线客户端订阅后，任何用户点赞/取消都会推送最新计数
 * GET /api/roleplay/likes/stream
 */
router.get('/likes/stream', (req: Request, res: Response): void => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write('retry: 3000\n\n');
  likeStreamClients.add(res);
  // 心跳保活：移动网络可能把长静默连接当死链断开
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* 客户端已断开 */ }
  }, 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    likeStreamClients.delete(res);
  });
});

/**
 * 剧本列表（附带点赞数 likes 与当前用户点赞状态 likedByMe）
 */
/**
 * 剧情模型配置（供前端决定是否展示「无限制模式」开关）
 * GET /api/roleplay/model-config → { available, zh, en, adultConfirmed, unlimitedActive, routing }
 *
 * available=false 表示第三方模型未配置或被运维开关（RP_PROVIDER=deepseek）强制切回，
 * 此时前端应把开关置灰并说明原因——避免用户选了却静默用不上。
 * adultConfirmed=false 表示该用户还没做过 18+ 成年确认（services/adultConfirm.ts）：
 * 前端点开「无限制模式」时必须先弹确认、确认成功后重试，否则服务端不会真的放行。
 * unlimitedActive = 该用户此刻**真的会**走上去限制模型（= 偏好为 true 且已成年确认），
 * 供排查「开了却没生效」。不返回任何密钥信息。
 *
 * 注：成人档**思考模式已移除**（2026-09-25，见 roleplayModel 文件头与 CHANGELOG），
 * 因此这里不再下发任何 thinking 状态；成人档请求体的 enable_thinking 恒为 false。
 */
router.get('/model-config', (req: Request, res: Response): void => {
  const availability = roleplayUnlimitedAvailable();
  const routing = roleplayRoutingSummary();
  const userId = resolveUserId(req);
  res.json({ success: true, data: { ...availability, adultConfirmed: isAdultConfirmed(userId), unlimitedActive: unlimitedActiveFor(userId), routing } });
});

router.get('/scenarios', async (req: Request, res: Response): Promise<void> => {
  const ql = String(req.query?.lang || '');
  const lang: RPLang = ql === 'en' ? 'en' : ql === 'zh-TW' ? 'zh-TW' : 'zh';
  res.json({ success: true, data: listScenarios(lang, resolveUserId(req)) });
});

/**
 * 单个剧本详情（深链/直达用：只取目标剧本，避免拉全列表）
 * GET /api/roleplay/scenario/:id?lang=zh
 */
router.get('/scenario/:id', async (req: Request, res: Response): Promise<void> => {
  const ql = String(req.query?.lang || '');
  const lang: RPLang = ql === 'en' ? 'en' : ql === 'zh-TW' ? 'zh-TW' : 'zh';
  const info = getScenarioInfo(String(req.params.id || ''), lang, resolveUserId(req));
  if (!info) {
    res.status(404).json({ success: false, error: '剧本不存在' });
    return;
  }
  res.json({ success: true, data: info });
});

/**
 * 搜索剧本（tag 命中优先，加权排序）
 * GET /api/roleplay/search?q=年上&lang=en
 */
router.get('/search', async (req: Request, res: Response): Promise<void> => {
  const q = String(req.query?.q || '').trim().slice(0, 50);
  const ql = String(req.query?.lang || '');
  const lang: RPLang = ql === 'en' ? 'en' : ql === 'zh-TW' ? 'zh-TW' : 'zh';
  if (!q) {
    res.json({ success: true, data: [] });
    return;
  }
  res.json({ success: true, data: searchScenarios(q, lang, resolveUserId(req)) });
});

/**
 * 全部标签（去重），供「标签浏览」主入口
 * GET /api/roleplay/tags?lang=en
 */
router.get('/tags', async (req: Request, res: Response): Promise<void> => {
  const ql = String(req.query?.lang || '');
  const lang: RPLang = ql === 'en' ? 'en' : ql === 'zh-TW' ? 'zh-TW' : 'zh';
  res.json({ success: true, data: listTagGroups(lang) });
});

/**
 * 剧情对话：前端传入完整历史（含开场 assistant），后端拼 system prompt 后生成回复
 */
router.post('/chat', async (req: Request, res: Response): Promise<void> => {
  let quotaUserId: string | null = null;
  let quotaConsumed = 0;
  let creditToken: string | null = null;
  try {
    const { scenarioId, messages, lang, aiName, userName, userPreference, narrativeStyle, innerMonologueEnabled, thinkingLevel, continueTurn, replacedReply, mode } = req.body || {};
    /**
     * 本回合演的是哪条线（solo = 只有主角；multi = cast 同场）。
     * ⚠️ 这是**生成侧**的开关：单角色线**绝不能**注入群像块 —— 否则用户演 solo 时会莫名多出配角。
     * 缺省 solo，与「老数据/老客户端 = 单存档」同一口径。
     */
    const rpMode: RoleplayMode = parseRoleplayMode(mode);
    /** 重新生成时前端回传的「被替换掉的那一版」：判重退费要拿它当「上一段」（服务端 history 里没有它） */
    const prevVersion = typeof replacedReply === 'string' ? replacedReply.slice(0, 4000) : '';
    const sid = String(scenarioId || '');
    const userId = resolveUserId(req);
    quotaUserId = userId;
    const scenario = getScenario(sid);
    let customScenario: CustomScenario | undefined;
    if (!scenario) {
      // 本人自建，或「已投稿公开」的剧本（任何玩家可游玩）
      customScenario = customRoleplayStore.get(userId, sid) || customRoleplayStore.getPublished(sid);
    }
    if (!scenario && !customScenario) {
      res.status(400).json({ success: false, error: '剧本不存在' });
      return;
    }
    /**
     * 无限制模式的服务端决策（含「本人用无限制模型创建的剧本 → 该剧本默认开」，见 unlimitedForScenario）。
     * 无 userId（未登录/内部调用）时**不传 override**，保持改造前「配置齐全即用」的行为不变。
     */
    const unlimitedOverride = userId ? unlimitedForScenario(userId, sid, customScenario) : undefined;
    if (!Array.isArray(messages)) {
      res.status(400).json({ success: false, error: '缺少对话内容' });
      return;
    }

    // 规范化历史：只保留 role/content，最多 24 条
    const history: RoleplayMessage[] = messages
      .filter((m: RoleplayMessage) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-24)
      .map((m: RoleplayMessage) => ({ role: m.role, content: m.content.slice(0, 2000) }));

    /**
     * 手动续写（B/C 方案的前端入口）：用户看到「这条回复没写完」后点「续写」，
     * 前端把**同一条历史原样带回来**并置 `continueTurn: true` —— 最后一条 assistant 就是断点。
     * 语义与自动续写完全一致（同一段文字继续往下长），只是由用户点出来、并且**算作新的一回合**
     * （与「重新生成」同口径：各扣一次额度）。
     */
    const manualPartial = continueTurn === true && history.length > 0 && history[history.length - 1].role === 'assistant'
      ? history[history.length - 1].content
      : '';
    const manualContinue = manualPartial.trim().length > 0;
    /** 续写时最后一轮的用户输入在倒数第二条之前；普通回合就是最后一条 */
    const turnHistory: RoleplayMessage[] = manualContinue ? history.slice(0, -1) : history;

    if (!manualContinue && (history.length === 0 || history[history.length - 1].role !== 'user')) {
      res.status(400).json({ success: false, error: '请先输入你想说的话' });
      return;
    }

    // 内容安全（P1-07）：用户消息命中高危/违规 → 降级引导回复（不调用 AI、不扣配额）
    // 续写回合没有新的用户输入 → 取最近一条用户消息（没有就空串，安全判定直接通过）
    const lastUserMsg = manualContinue
      ? ([...turnHistory].reverse().find((m) => m.role === 'user')?.content || '')
      : history[history.length - 1].content;
    const langKey = toOutputLang(lang);
    const inputCheck = checkContentSafety(lastUserMsg);
    if (!inputCheck.safe) {
      const guide = pickGuide(langKey, isSelfHarmContent(lastUserMsg));
      res.json({ success: true, data: { reply: guide } });
      return;
    }

    // 角色扮演同样消耗 AI 调用额度：免费次数 / Plus 每日 / Pro 无限（剧本本身免费）；开启点数按预计 token 折算
    if (isCreditQuotaEnabled()) {
      const creditQuota = quotaStore.getCreditQuota(userId);
      const est = { credit: actionPricePoints('roleplayTurn') }; // 整数价目表
      const reserve = quotaStore.reserveCredit(userId, 'roleplay', est);
      if (!reserve.ok) {
        res.status(402).json({
          success: false,
          error: '今日额度点数已用完，明天再来，或升级解锁更多',
          code: 'CHAT_QUOTA_EXCEEDED',
          data: { quota: quotaStore.getQuota(userId), chatQuota: quotaStore.getChatQuota(userId), creditQuota }
        });
        return;
      }
      creditToken = reserve.token!;
    } else {
      const chatQuota = quotaStore.getChatQuota(userId);
      if (!chatQuota.canChat) {
        res.status(402).json({
          success: false,
          error: chatQuota.plan === 'plus'
            ? '今天的聊天额度用完啦，明天再来聊；或升级 Pro 无限畅聊'
            : '免费次数已用完，请付费解锁后继续使用',
          code: 'CHAT_QUOTA_EXCEEDED',
          data: { quota: quotaStore.getQuota(userId), chatQuota }
        });
        return;
      }
      // 剧情扮演回合更贵：每回合消耗 ROLEPLAY_TURN_CHAT_COST 条聊天额度
      quotaConsumed = ROLEPLAY_TURN_CHAT_COST;
      for (let i = 0; i < ROLEPLAY_TURN_CHAT_COST; i++) {
        if (!quotaStore.consumeChat(userId)) {
          for (let j = 0; j < i; j++) quotaStore.rollbackChat(userId);
          quotaConsumed = 0;
          res.status(402).json({ success: false, error: '聊天额度不足', code: 'CHAT_QUOTA_EXCEEDED', data: { quota: quotaStore.getQuota(userId), chatQuota } });
          return;
        }
      }
    }

    // 流式模式（前端传 stream=1）：逐 token 下发；缺省仍返回整段 JSON，兼容旧调用
    const streamMode = String(req.query?.stream || '') === '1';

    const rpLang: RPLang = String(lang || '') === 'en' ? 'en' : String(lang || '') === 'zh-TW' ? 'zh-TW' : 'zh';
    const rpStyle: RoleplayNarrativeStyle = String(narrativeStyle || '') === 'classic' ? 'classic' : 'immersive';
    const nameOpts = { userId, lang: rpLang, aiName: String(aiName || '').slice(0, 20), userName: String(userName || '').slice(0, 20), userPreference: String(userPreference || '').slice(0, 2000), narrativeStyle: rpStyle, innerMonologueEnabled: typeof innerMonologueEnabled === 'boolean' ? innerMonologueEnabled : undefined, thinkingLevel: typeof thinkingLevel === 'string' ? (thinkingLevel as any) : undefined, unlimited: unlimitedOverride, mode: rpMode };

    /**
     * 跑一轮生成（含 C 方案自动续写）。
     *
     * 抽成一个函数是为了让「流式」与「非流式」两条分支共用**同一套完整性逻辑**——
     * 否则旧客户端会看到和网页端不同的收尾（一边自动补齐、一边留半截）。
     */
    /**
     * 本轮是否**真的**路由到了第三方去限制模型（由生成链路的 onMeta 回报）。
     * 生成后重复闸默认只在这一档生效（见 repeatGate 的 scope）——退化是那台 abliterated 模型的特性，
     * 官方 DeepSeek 链路不该为它多花一次调用与等待。
     */
    let viaUnlimited = false;
    const runTurn = async (hooks: {
      onToken?: (delta: string) => void;
      onQueue?: (info: { ahead: number; waiting: number; running: number; maxConcurrent: number }) => void;
      onMeta?: (m: { unlimited: boolean; model: string }) => void;
      signal?: AbortSignal;
      onContinue?: (attempt: number) => void;
    }, extraAvoid?: readonly string[]) => {
      const generateTurn = async (cont?: { partial: string }): Promise<{ text: string; finishReason: string }> => {
        let finishReason = '';
        const opts = {
          ...nameOpts,
          // 重写轮专属禁项（A 方案 · 生成后重复闸）；普通轮为 undefined，行为与改造前一致
          extraAvoid,
          onToken: hooks.onToken,
          onQueue: hooks.onQueue,
          onMeta: hooks.onMeta,
          signal: hooks.signal,
          onFinish: (info: { finishReason: string }) => { finishReason = info.finishReason || ''; },
        } as NonNullable<Parameters<typeof roleplayReply>[2]>;
        if (cont) opts.continuation = cont;
        const text = customScenario
          ? await roleplayReplyCustom(customScenario, turnHistory, opts)
          : await roleplayReply(scenario!, turnHistory, opts);
        return { text, finishReason };
      };
      // 用户点的「续写」：首轮本身就是带断点的续写；其后再按上限自动补（点一次，能接几次接几次）
      // 篇幅预算（2026-09-19 用户口径「续写只是满足一次的字数量」）：按叙事模式给本轮目标篇幅，
      // 自动续写"没写到目标才续、每次只补差额"，手动那一档不受"已达目标"限制但仍只补 topUp。
      const lengthBand = roleplayTurnLengthBand(rpLang, rpStyle);
      const first = manualContinue ? { partial: manualPartial } : undefined;
      return roleplayReplyWithContinuation(async (cont) => {
        const effective = cont ?? first;
        const out = await generateTurn(effective);
        /**
         * ⚠️ 手动续写的**首轮**产出的只是"接着往下写的那一段"，不是完整回复：
         * 必须把断点正文拼回去，否则接口返回的就只是后半截（前端拿 r.data.reply 覆盖整条 →
         * 用户点一次「续写」，前半截反而没了）。自动续写的拼接在 roleplayReplyWithContinuation 里做。
         */
        if (!cont && first) {
          // 重讲闸（2026-09-19）：手动续写的首轮若是在重讲同一拍，同样丢弃（否则点一次「续写」就多一遍剧情）
          const g = mergeContinuationGuarded(first.partial, out.text);
          if (g.retell) console.warn(`⚠️ [Roleplay] 手动续写被判为重讲同一拍（逐字抄写 ${g.copied} 字），已丢弃该段`);
          // 篇幅预算兜底：手动续写的首轮同样只补 topUp（点一次＝补齐这一轮，而不是再加一整条）
          const legBudget = roleplayContinuationBudget(lengthBand, first.partial.length);
          const limited = trimAdditionToBudget(g.added, legBudget);
          if (limited.trimmed) console.warn(`⚠️ [Roleplay] 手动续写超预算（${g.added.length} > ${legBudget} 字）→ 按句界裁到 ${limited.text.length} 字`);
          return { ...out, text: first.partial + limited.text };
        }
        return out;
      }, { onContinue: hooks.onContinue, manualContinue: !!manualContinue, band: lengthBand });
    };


    /**
     * 生成后重复闸（A 方案，2026-09-24）——判据与采纳策略全在 services/repeatGate.ts，这里只负责接线。
     *
     * 为什么重写那一版**不带 onToken**：第一版已经逐 token 流出去了，再流一遍会让用户看到两段。
     * 所以重写期间只下发 {type:'rewrite'} 让前端显示"正在重写"，最终由 done.reply 一次性覆盖
     * （前端本来就以 done.reply 定稿，见 RoleplayPage 的 attemptTurn）。
     */
    const applyRepeatGate = async (
      first: Awaited<ReturnType<typeof runTurn>>,
      emitRewrite: boolean,
      signal?: AbortSignal,
      quietHooks?: { onQueue?: (info: { ahead: number; waiting: number; running: number; maxConcurrent: number }) => void; onContinue?: (attempt: number) => void },
    ): Promise<Awaited<ReturnType<typeof runTurn>>> => {
      if (!repeatGateEnabled()) return first;
      const gate = await runRepeatGate({
        reply: first.reply,
        history: turnHistory,
        lang: rpLang,
        adult: viaUnlimited,
        onRewrite: () => {
          if (!emitRewrite) return;
          try { res.write('data: ' + JSON.stringify({ type: 'rewrite' }) + '\n\n'); } catch { /* 客户端已断开 */ }
        },
        regenerate: async (ban) => {
          const second = await runTurn({ onQueue: quietHooks?.onQueue, onMeta: (m) => { viaUnlimited = m.unlimited; }, signal, onContinue: quietHooks?.onContinue }, ban);
          return { reply: second.reply, payload: second };
        },
      });
      return gate.accepted && gate.outcome.payload ? gate.outcome.payload : first;
    };

    /**
     * 判重退费（2026-10-01）：把本轮**最终**回复与「上一段回复」比。
     * 比较对象优先用前端回传的被替换版本（重新生成），再补 history 里最后几条 AI 回复。
     * 判重失败/超时一律按「不重复」处理，绝不让判重把主流程拖坏。
     */
    const assessFinalRepeat = async (finalReply: string): Promise<{ free: boolean; degree: number }> => {
      try {
        const prevList: string[] = [];
        if (prevVersion.trim()) prevList.push(prevVersion);
        for (let i = turnHistory.length - 1; i >= 0 && prevList.length < 4; i--) {
          const m = turnHistory[i];
          if (m.role === 'assistant' && String(m.content || '').trim()) prevList.push(String(m.content));
        }
        const a = await assessReplyRepeat(finalReply, prevList, rpLang, { userId });
        if (a.duplicate) console.log('[RepeatRefund] 剧情回合判重：' + a.source + ' degree=' + a.degree.toFixed(2) + ' ' + a.detail);
        return { free: a.duplicate, degree: a.degree };
      } catch (e) {
        console.warn('⚠️ [RepeatRefund] 剧情回合判重异常（按不重复处理，照常扣费）：' + ((e as Error)?.message || e));
        return { free: false, degree: 0 };
      }
    };

    if (streamMode) {
      // 流式：逐 token 下发，不让用户对着 spinner 空等整段回复
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      const streamAbort = new AbortController();
      /**
       * 心跳保活（2026-09-25 补）：长静默期（上游排队、长上下文生成、一次续写两段拼接）
       * 上游一个字节都不吐，而前端 `roleplayChatStream` 的空闲看门狗是 **90s**
       *（api.ts 的 createIdleGuard）——这条链路此前**没有心跳**（只有 likes/stream 有），
       * 静默超过 90s 就会被前端判成 TIMEOUT 掐断；Cloudflare 回源也有「长时间无数据」的耐心上限。
       * 注释行（': ping'）不是 `data:` 前缀，客户端解析器天然忽略，不会污染正文。
       */
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* 客户端已断开 */ }
      }, 15000);
      const stopHeartbeat = () => clearInterval(heartbeat);
      // 只在实际客户端断开时才中止上游（res 'close' + 未正常结束才触发；避免 req 'close' 在请求体读完时误杀流式）
      res.on('close', () => { stopHeartbeat(); if (!res.writableEnded) streamAbort.abort(); });
      /**
       * 「一拍计划」行（B 方案）在正文之前、且**玩家不该看到** → 流式下必须缓冲开头几个字符判定：
       * 判定为计划行就整行丢掉；拿不准/模型没遵守一律原样放行（见 src/lib/beatPlan.ts 的状态机，
       * 两种错的代价不对称：多泄漏一行 vs 把正文吞掉）。
       */
      const beatFilter = createBeatPlanFilter((delta: string) => {
        try { res.write('data: ' + JSON.stringify({ type: 'delta', content: delta }) + '\n\n'); } catch { /* 客户端已断开 */ }
      });
      const onToken = (delta: string) => beatFilter.push(delta);
      /**
       * 排队状态：托管档位按「并发单元」计价（27B 每请求扣 2 单元、账号共 4 单元 → 约 2 路），
       * 超出就得在本地闸门里等。没有这个事件时，用户看到的只是一个不动 spinner，像卡死；
       * 有了它前端能明确显示「前面还有 N 个正在生成」。入队那一刻就发一次（不轮询、不刷屏）。
       */
      const onQueue = (info: { ahead: number; waiting: number; running: number; maxConcurrent: number }) => {
        try { res.write('data: ' + JSON.stringify({ type: 'queue', ...info }) + '\n\n'); } catch { /* 客户端已断开 */ }
      };
      /**
       * 审计元信息（方案 A2）：本轮**实际**走了哪个 provider（无限制模型还是 DeepSeek）。
       *
       * 为什么要下发：保存会话是客户端发起的（POST /api/roleplay/session），服务端在保存时
       * 根本无从得知每条回复是谁写的。所以由生成这边告知前端，前端保存时随消息回传，
       * 服务端再落到 RoleplayMessage.viaUnlimited / model 上，供管理端「用户行为」核对。
       *
       * 性质：**客户端自述**，用于监控足够，不作为取证。
       */
      const onMeta = (m: { unlimited: boolean; model: string }) => {
        viaUnlimited = m.unlimited;
        try { res.write('data: ' + JSON.stringify({ type: 'meta', adult: m.unlimited, model: m.model }) + '\n\n'); } catch { /* 客户端已断开 */ }
      };
      /**
       * 自动续写开始（C 方案）：明确告诉前端「这是接着上面那句往下写」，前端据此显示"正在续写"，
       * 而不是让用户以为新的一段突然冒出来（尤其是断点在括号动作中间时）。
       */
      const onContinue = (attempt: number) => {
        try { res.write('data: ' + JSON.stringify({ type: 'continue', attempt }) + '\n\n'); } catch { /* 客户端已断开 */ }
      };
      const first = await runTurn({ onToken, onQueue, onMeta, signal: streamAbort.signal, onContinue });
      // 生成结束 → 把缓冲里剩下的补发（绝不吞正文；若只产出了计划行则原样吐出）
      beatFilter.flush();
      if (beatFilter.sawPlan()) console.log('🥁 [Roleplay] 流式已过滤「本拍计划」行');
      const outcome = await applyRepeatGate(first, true, streamAbort.signal, { onQueue, onContinue });
      const reply = outcome.reply;
      const outputSafe = checkAiOutputSafety(reply).safe;
      const finalReply = outputSafe ? reply : pickGuide(langKey, true);
      // 被安全兜底替换掉的回复不再是"剧情的半截"（整段换成了引导语）→ 不下发 incomplete
      const incomplete = outputSafe ? outcome.incomplete : null;
      // 行为追踪：剧情扮演成功回复一轮（测试请求不计）；带剧本标题供 AI 行为感知；mode 标明是三种剧情模式里的哪一种
      if (userId && !isTestRequest(getClientIp(req), String(req.headers['x-device-id'] || ''))) {
        const rpTitle = customScenario
          ? (customScenario.title || (rpLang === 'en' ? 'Custom story' : '自建剧情'))
          : rpLang === 'en' ? (scenario?.en?.title || '') : (scenario?.zh?.title || '');
        activityStore.trackFeature(userId, 'roleplay', { detail: rpTitle, mode: 'roleplay', ip: getClientIp(req), country: getClientCountry(req) });
      }
      const repeat = outputSafe ? await assessFinalRepeat(finalReply) : { free: false, degree: 0 };
      if (repeat.free) {
        // 判为重复：不 commit、改回滚 —— 本次不消耗额度
        if (creditToken && quotaUserId) { quotaStore.rollbackCredit(quotaUserId, creditToken); creditToken = null; }
        for (let i = 0; i < quotaConsumed; i++) { if (quotaUserId) quotaStore.rollbackChat(quotaUserId); }
        quotaConsumed = 0;
      } else if (creditToken && quotaUserId) { quotaStore.commitCredit(quotaUserId, creditToken); creditToken = null; }
      /**
       * B 方案：done 里带上「本轮写完没有」——`finishReason` 是上游原值（`length` = 撞上 max_tokens），
       * `incomplete` 是服务端的文本判据结果（见 src/lib/replyCompleteness.ts），`continued` 是自动续写次数。
       * 前端据此：仍不完整时给「没写完 + 续写」入口；埋点区分 PARTIAL_LENGTH / PARTIAL_UNCLOSED / PARTIAL_MID_SENTENCE。
       * 老前端不认识这几个字段 → 行为与改造前完全一致（兼容）。
       */
      res.write('data: ' + JSON.stringify({ type: 'done', data: { reply: finalReply, incomplete, finishReason: outcome.finishReason, continued: outcome.continued, free: repeat.free, repeated: repeat.free, repeatDegree: repeat.degree } }) + '\n\n');
      stopHeartbeat();
      res.end();
      return;
    }

    const firstPass = await runTurn({ onMeta: (m) => { viaUnlimited = m.unlimited; } });
    const outcome = await applyRepeatGate(firstPass, false);
    const reply = outcome.reply;
    const outputSafe = checkAiOutputSafety(reply).safe;
    const finalReply = outputSafe ? reply : pickGuide(langKey, true);
    const incomplete = outputSafe ? outcome.incomplete : null;

    // 行为追踪：剧情扮演成功回复一轮（测试请求不计）；带剧本标题供 AI 行为感知；mode 标明是三种剧情模式里的哪一种
    if (userId && !isTestRequest(getClientIp(req), String(req.headers['x-device-id'] || ''))) {
      const rpTitle = customScenario
        ? (customScenario.title || (rpLang === 'en' ? 'Custom story' : '自定义剧情'))
        : rpLang === 'en' ? (scenario?.en?.title || '') : (scenario?.zh?.title || '');
      activityStore.trackFeature(userId, 'roleplay', { detail: rpTitle, mode: 'roleplay', ip: getClientIp(req), country: getClientCountry(req) });
    }

    const repeat = outputSafe ? await assessFinalRepeat(finalReply) : { free: false, degree: 0 };
    if (repeat.free) {
      // 判为重复：不 commit、改回滚 —— 本次不消耗额度
      if (creditToken && quotaUserId) { quotaStore.rollbackCredit(quotaUserId, creditToken); creditToken = null; }
      for (let i = 0; i < quotaConsumed; i++) { if (quotaUserId) quotaStore.rollbackChat(quotaUserId); }
      quotaConsumed = 0;
    } else if (creditToken && quotaUserId) { quotaStore.commitCredit(quotaUserId, creditToken); creditToken = null; }
    res.json({ success: true, data: { reply: finalReply, incomplete, finishReason: outcome.finishReason, continued: outcome.continued, free: repeat.free, repeated: repeat.free, repeatDegree: repeat.degree } });
  } catch (error) {
    // AI 调用失败时回滚已扣减的额度（与理一理/聊一聊保持一致，避免失败也扣费）
    for (let i = 0; i < quotaConsumed; i++) { if (quotaUserId) quotaStore.rollbackChat(quotaUserId); }
    if (creditToken && quotaUserId) { quotaStore.rollbackCredit(quotaUserId, creditToken); creditToken = null; }
    console.error('Roleplay chat error:', error);
    const msg = safeError('ai', error);
    if (res.headersSent) {
      // 流式已开始（可能因客户端断开/上游中断）：不再尝试 JSON 响应，只尽力写一条 error 并收尾
      try { res.write('data: ' + JSON.stringify({ type: 'error', error: msg }) + '\n\n'); } catch { /* 客户端已断开 */ }
      try { res.end(); } catch { /* 忽略 */ }
    } else {
      res.status(500).json({ success: false, error: msg });
    }
  }
});

/**
 * POST /api/roleplay/unlimited  { scenarioId, unlimited }
 *
 * 只服务一种剧本：**本人用无限制模型创建的自建剧本**（createdWithUnlimited === true）。
 * 这种剧本进聊天时成人模式默认开（见 services/roleplay.ts 的 unlimitedForScenario），
 * 所以用户需要一条「只关掉这个剧本」的路——否则他只能去关全局偏好，
 * 而那一下会把他**所有**剧本的成人模式一起关掉。
 *
 * 为什么不复用 POST /api/user/preferences 写 roleplayUnlimitedByScenario：
 * 那张偏好是按字段整体覆盖的；客户端只要漏带半张表，别的剧本的选择就被无声还原了。
 * 合并只能由服务端做（preferenceStore.setUnlimitedForScenario）。
 *
 * 权限与红线：
 *   - 必须登录（自建剧本按 userId 私有）；
 *   - 必须是**本人**的自建剧本，且创建时确实用了无限制模型——资格剧本之外一律拒绝（400），
 *     免得这条接口变成绕过全局开关的第二条入口；
 *   - 要「开」必须先过 18+ 成年确认：没确认就**降级为 false 落盘**并回传 adultConfirmed，
 *     与 /api/user/preferences 的写入闸同口径（悄悄拒绝会让前端显示成「开着但服务端不用」）。
 */
router.post('/unlimited', (req: Request, res: Response): void => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '请先登录', code: 'LOGIN_REQUIRED' });
    return;
  }
  const scenarioId = String(req.body?.scenarioId || '').trim().slice(0, 64);
  const wanted = req.body?.unlimited === true;
  const rec = scenarioId ? customRoleplayStore.get(user.userId, scenarioId) : undefined;
  if (!rec || rec.createdWithUnlimited !== true) {
    res.status(400).json({ success: false, error: '该剧本不支持单独设置成人模式', code: 'SCENARIO_NOT_ADULT_DEFAULT' });
    return;
  }
  const adultConfirmed = isAdultConfirmed(user.userId);
  const stored = wanted && adultConfirmed ? true : false;
  const prefs = preferenceStore.setUnlimitedForScenario(user.userId, scenarioId, stored);
  res.json({
    success: true,
    data: {
      scenarioId,
      // 落盘后的**真实**值（不是请求值）：未过成年确认时这里会是 false
      unlimited: stored,
      roleplayUnlimitedByScenario: prefs.roleplayUnlimitedByScenario,
      adultConfirmed,
    },
  });
});

/**
 * AI 辅助聊天：根据当前对话 + 剧本场景/人设/背景，为玩家生成 4 条候选「下一句」。
 * 计费：每生成一批消耗 1 条聊天额度（与 /chat 同池）；选中某条后由前端走 /chat 再消耗 1 条。
 * POST /api/roleplay/suggestions
 */
router.post('/suggestions', async (req: Request, res: Response): Promise<void> => {
  let quotaUserId: string | null = null;
  let quotaConsumed = false;
  let creditToken: string | null = null;
  try {
    const { scenarioId, messages, lang, aiName, userName, userPreference, narrativeStyle, previousSuggestions } = req.body || {};
    const sid = String(scenarioId || '');
    const userId = resolveUserId(req);
    quotaUserId = userId;
    const scenario = getScenario(sid);
    let customScenario: CustomScenario | undefined;
    if (!scenario) {
      // 本人自建，或「已投稿公开」的剧本（任何玩家可游玩）
      customScenario = customRoleplayStore.get(userId, sid) || customRoleplayStore.getPublished(sid);
    }
    if (!scenario && !customScenario) {
      res.status(400).json({ success: false, error: '剧本不存在' });
      return;
    }
    if (!Array.isArray(messages)) {
      res.status(400).json({ success: false, error: '缺少对话内容' });
      return;
    }
    /** 前端上一批建议：本轮判重退费的比较对象（缺省=首次生成，无可比对象） */
    const prevSuggestions: string[] = Array.isArray(previousSuggestions) ? previousSuggestions.map((x: unknown) => String(x || '')).filter(Boolean) : [];

    // 规范化历史：只保留 role/content，最多 24 条
    const history: RoleplayMessage[] = messages
      .filter((m: RoleplayMessage) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-24)
      .map((m: RoleplayMessage) => ({ role: m.role, content: m.content.slice(0, 2000) }));

    // 角色扮演同样消耗 AI 调用额度：免费次数 / Plus 每日 / Pro 无限
    if (isCreditQuotaEnabled()) {
      const creditQuota = quotaStore.getCreditQuota(userId);
      const est = { credit: actionPricePoints('roleplaySuggestions') }; // 整数价目表
      const reserve = quotaStore.reserveCredit(userId, 'roleplay', est);
      if (!reserve.ok) {
        res.status(402).json({ success: false, error: '今日额度点数已用完，明天再来，或升级解锁更多', code: 'CHAT_QUOTA_EXCEEDED', data: { quota: quotaStore.getQuota(userId), chatQuota: quotaStore.getChatQuota(userId), creditQuota } });
        return;
      }
      creditToken = reserve.token!;
    } else {
      const chatQuota = quotaStore.getChatQuota(userId);
      if (!chatQuota.canChat) {
        res.status(402).json({
          success: false,
          error: chatQuota.plan === 'plus'
            ? '今天的聊天额度用完啦，明天再来聊；或升级 Pro 无限畅聊'
            : '免费次数已用完，请付费解锁后继续使用',
          code: 'CHAT_QUOTA_EXCEEDED',
          data: { quota: quotaStore.getQuota(userId), chatQuota },
        });
        return;
      }
      quotaConsumed = quotaStore.consumeChat(userId);
    }

    const rpLang: RPLang = String(lang || '') === 'en' ? 'en' : String(lang || '') === 'zh-TW' ? 'zh-TW' : 'zh';
    const rpStyle: RoleplayNarrativeStyle = String(narrativeStyle || '') === 'classic' ? 'classic' : 'immersive';
    const nameOpts = { userId, lang: rpLang, aiName: String(aiName || '').slice(0, 20), userName: String(userName || '').slice(0, 20), userPreference: String(userPreference || '').slice(0, 2000), narrativeStyle: rpStyle };

    const suggestions = customScenario
      ? await roleplaySuggestionsCustom(customScenario, history, nameOpts)
      : await roleplaySuggestions(scenario!, history, nameOpts);

    // 输出安全（P1-07）：过滤指令式高危内容；只保留安全条目，最多取 4 条
    const safe = suggestions.filter(s => checkAiOutputSafety(s).safe).slice(0, 4);
    if (safe.length === 0) {
      if (creditToken && quotaUserId) { quotaStore.rollbackCredit(quotaUserId, creditToken); creditToken = null; }
      if (quotaConsumed && quotaUserId) quotaStore.rollbackChat(quotaUserId);
      quotaConsumed = false;
      res.status(500).json({ success: false, error: '暂无可用的建议，请稍后重试' });
      return;
    }

    /**
     * 判重退费（2026-10-01）：新一批建议与**上一批建议**比。
     * 判到重复就**不 commit、改回滚**——本次不消耗额度，并把 duplicate/free 回执前端，
     * 由前端保留上一批建议并提示「这次的建议和上次一样，本次未扣额度」。
     * 注意：判重失败/超时一律按「不重复」处理（照常扣费），绝不让判重把主流程拖坏。
     */
    let duplicate = false;
    let repeatDegree = 0;
    try {
      const a = await assessSuggestionsRepeat(safe, prevSuggestions, rpLang, { userId });
      repeatDegree = a.degree;
      if (a.duplicate) {
        duplicate = true;
        console.log('[RepeatRefund] 建议批次判重：' + a.source + ' degree=' + a.degree.toFixed(2) + ' ' + a.detail);
        if (creditToken && quotaUserId) { quotaStore.rollbackCredit(quotaUserId, creditToken); creditToken = null; }
        if (quotaConsumed && quotaUserId) quotaStore.rollbackChat(quotaUserId);
        quotaConsumed = false;
      }
    } catch (e) {
      console.warn('⚠️ [RepeatRefund] 建议判重异常（按不重复处理，照常扣费）：' + ((e as Error)?.message || e));
    }

    if (creditToken && quotaUserId) { quotaStore.commitCredit(quotaUserId, creditToken); creditToken = null; }
    res.json({ success: true, data: { suggestions: safe, duplicate, free: duplicate, repeatDegree, quota: quotaStore.getQuota(userId), chatQuota: quotaStore.getChatQuota(userId) } });
  } catch (error) {
    if (creditToken && quotaUserId) { quotaStore.rollbackCredit(quotaUserId, creditToken); creditToken = null; }
    if (quotaConsumed && quotaUserId) quotaStore.rollbackChat(quotaUserId);
    console.error('Roleplay suggestions error:', error);
    const msg = safeError('ai', error);
    res.status(500).json({ success: false, error: msg });
  }
});

/**
 * 会话持久化（跨设备）：登录用户按账号保存，游客按设备指纹保存
 * GET    /api/roleplay/session?scenarioId=&mode=   → { messages: [...] | null, mode }
 * POST   /api/roleplay/session               { scenarioId, messages, mode }
 * DELETE /api/roleplay/session?scenarioId=&mode=
 *
 * `mode`：solo（单角色线）/ multi（多角色线）。**每部剧本每条线各一份存档**。
 * 缺省 solo —— 老客户端（只会传 scenarioId）读到的仍是它当年那一份，不会因为多出多角色线而串档。
 */
router.get('/session', (req: Request, res: Response): void => {
  const scenarioId = String(req.query?.scenarioId || '');
  if (!scenarioId) {
    res.status(400).json({ success: false, error: '缺少剧本ID' });
    return;
  }
  const userId = resolveUserId(req);
  const mode = parseRoleplayMode(req.query?.mode);
  const record = roleplaySessionStore.getRecord(userId, scenarioId, mode);
  res.json({ success: true, data: { messages: record.messages, userPreference: record.userPreference || '', mode } });
});

router.post('/session', (req: Request, res: Response): void => {
  const { scenarioId, messages, userPreference, mode } = req.body || {};
  if (!scenarioId) {
    res.status(400).json({ success: false, error: '参数错误' });
    return;
  }
  const userId = resolveUserId(req);
  const rpMode = parseRoleplayMode(mode);
  let blocked: string | null = null;
  if (Array.isArray(messages)) {
    const sid = String(scenarioId);
    // 剧名快照（自建剧本尤其重要）：剧本被创作者删除后就再也解析不到标题，
    // 「与你的旅程 / 运营控制台」会退化成 custom_xxx 内部 id。这里在保存那一刻把剧名落在会话上，
    // 之后读取仍优先取实时标题（改名即时生效），快照只在解析不到时兜底。
    const snapTitle = resolveRoleplayTitle(sid, userId, 'zh').title;
    const result = roleplaySessionStore.save(userId, sid, messages, typeof userPreference === 'string' ? userPreference.slice(0, 4000) : undefined, snapTitle || undefined, rpMode);
    /**
     * 🚨 未完成回合护栏命中（2026-09-18，见 src/lib/rpWriteGuard.ts 的 dropsSavedReply）：
     * 客户端想把「还没有回复的这一轮」截断保存 —— 以前这一步会**静默抹掉已生成的回复**，
     * 会话永久停在那条没人回的用户消息上。现在拒写并在这里记一条运营埋点：
     * 「今天有多少轮剧情是本该有回复、却没落上盘」，不再只靠用户投诉才知道。
     *
     * ⚠️ 口径（2026-09-18 第二版）：命中**不等于**「用户看到了失败提示」——它多半正是「重新生成」的
     * 正常截断（前端 2026-09-18 起已在源头不写这一笔，见 RoleplayPage.saveSession）。所以运营端
     * `aiFailureStore` 把 `UNANSWERED_TURN` 归为**护栏类**，不计入「用户实际看到失败提示」。
     */
    if (result.blocked) {
      /**
       * 测试设备不计（与 `POST /api/ai-failure` 同口径）：验证脚本（headless 真机跑）也会做「重新生成」
       * 之类的操作，护栏命中不该在运营卡上留下假失败 —— 那会让「今天有多少次 AI 真没接上」被自测污染。
       */
      if (!isTestRequest(getClientIp(req), String(req.headers['x-device-id'] || ''))) {
        aiFailureStore.record('roleplay', result.blocked, false);
      }
      blocked = result.blocked;
    }
  } else if (typeof userPreference === 'string') {
    roleplaySessionStore.savePreference(userId, String(scenarioId), userPreference.slice(0, 4000), rpMode);
  } else {
    res.status(400).json({ success: false, error: '参数错误' });
    return;
  }
  // `blocked` 不是错误：客户端照常继续（它下一次保存会带上新回复），只是这一笔没落盘 + 已记埋点
  res.json({ success: true, ...(blocked ? { blocked } : {}) });
});

router.delete('/session', (req: Request, res: Response): void => {
  const scenarioId = String(req.query?.scenarioId || '');
  if (!scenarioId) {
    res.status(400).json({ success: false, error: '缺少剧本ID' });
    return;
  }
  const userId = resolveUserId(req);
  roleplaySessionStore.delete(userId, scenarioId, parseRoleplayMode(req.query?.mode));
  res.json({ success: true });
});

/**
 * 剧本点赞（社区型指标：每个用户每剧本一赞，可取消）
 * POST /api/roleplay/like  { scenarioId } → { liked, count }
 */
router.post('/like', (req: Request, res: Response): void => {
  const scenarioId = String(req.body?.scenarioId || '').trim();
  if (!scenarioId) {
    res.status(400).json({ success: false, error: '缺少剧本ID' });
    return;
  }
  const userId = resolveUserId(req);
  // 官方剧本或本人自建剧本均可点赞；不存在的剧本拒绝
  if (!getScenario(scenarioId) && !customRoleplayStore.get(userId, scenarioId)) {
    res.status(400).json({ success: false, error: '剧本不存在' });
    return;
  }
  const data = roleplayLikeStore.toggle(userId, scenarioId);
  // 展示用点赞数 = 真实点赞数（已移除基础热度）
  const displayCount = getDisplayLikes(scenarioId);
  broadcastLike(scenarioId, displayCount);
  res.json({ success: true, data: { ...data, count: displayCount } });
});

/**
 * 自建剧本（Phase 1：仅登录用户私有，不公开）
 * POST   /api/roleplay/custom      { title?, aiName?, aiPersona, background, opening } → 创建
 * GET    /api/roleplay/custom      → 我的自建剧本列表
 * DELETE /api/roleplay/custom/:id  → 删除
 */
router.post('/custom', (req: Request, res: Response): void => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '请先登录', code: 'LOGIN_REQUIRED' });
    return;
  }
  const { title, aiName, aiPersona, background, opening, avatar, chatBackground, createdWithUnlimited, createdWithModel, creationPrompt } = req.body || {};
  const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  if (!clean(aiPersona) || !clean(background) || !clean(opening)) {
    res.status(400).json({ success: false, error: '人设、背景、开场均为必填' });
    return;
  }
  for (const v of [title, aiName, aiPersona, background, opening]) {
    if (typeof v === 'string' && v.length > 2000) {
      res.status(400).json({ success: false, error: '内容过长' });
      return;
    }
  }
  if (avatar && !isImageDataUrl(avatar)) {
    res.status(400).json({ success: false, error: '头像图片格式不正确或过大' });
    return;
  }
  if (chatBackground && !isImageDataUrl(chatBackground)) {
    res.status(400).json({ success: false, error: '聊天背景图格式不正确或过大' });
    return;
  }
  const safety = checkCustomScenario({ title, aiName, aiPersona, background, opening });
  if (!safety.safe) {
    res.status(400).json({ success: false, error: '内容包含不当信息，无法创建', code: 'CONTENT_REJECTED' });
    return;
  }
  const rec = customRoleplayStore.create(user.userId, { title, aiName, aiPersona, background, opening, avatar: avatar || undefined, chatBackground: chatBackground || undefined,
    // 审计标记（方案 A2·客户端自述）：创建这条路用的是「剧本生成」开关，服务端不掌握，由前端上报。
    // 只采信 boolean / 字符串——传 'true'、1、对象之类的畸形值一律忽略（宁可记为未记录，也不要错数据）。
    createdWithUnlimited: typeof createdWithUnlimited === 'boolean' ? createdWithUnlimited : undefined,
    createdWithModel: typeof createdWithModel === 'string' ? createdWithModel : undefined,
    // AI 建剧提示词（前端保存时回传「AI 帮我写剧本」用过的灵感）——控制台据此看到用户是拿什么描述生成的
    creationPrompt: typeof creationPrompt === 'string' ? creationPrompt : undefined });
  res.json({ success: true, data: rec });
});


/**
 * AI 辅助创建剧本：根据一句话灵感生成整份自建剧本草稿（标题/角色名/人设/背景/开场），
 * 供「自建剧本」创建页回填表单、逐字段修改后再创建。
 * 计费：每次生成消耗 1 条聊天额度（与 /suggestions 同池）；AI 调用失败/输出安全不过时自动回滚，不扣费。
 * 红线：灵感与生成草稿都做内容安全过滤；最终创建/投稿时仍会再过 checkCustomScenario（本接口不落库）。
 * POST /api/roleplay/custom/draft  { idea, lang? }
 */
router.post('/custom/draft', async (req: Request, res: Response): Promise<void> => {
  let quotaUserId: string | null = null;
  let quotaConsumed = 0;
  let creditToken: string | null = null;
  try {
    const user = getAuthUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: '请先登录', code: 'LOGIN_REQUIRED' });
      return;
    }
    // 灵感/整份剧本：**不做字数截断**（用户可能直接贴整份剧本）——只 trim，安全审核与模型各自见全量
    const idea = normalizeCustomIdea(req.body?.idea);
    const rpLang: RPLang = String(req.body?.lang || '') === 'en' ? 'en' : String(req.body?.lang || '') === 'zh-TW' ? 'zh-TW' : 'zh';
    const langKey = toOutputLang(rpLang);
    if (!idea) {
      res.status(400).json({ success: false, error: langKey === 'en' ? 'Please tell me your story idea first' : '请先写下你的剧本灵感', code: 'MISSING_IDEA' });
      return;
    }
    // 灵感红线：命中高危/违规直接拒绝（不调用 AI、不扣额度）
    const inputCheck = checkContentSafety(idea);
    if (!inputCheck.safe) {
      creationPromptLog.add({ userId: user.userId, kind: 'roleplay-draft', prompt: idea, outcome: 'blocked', lang: rpLang });
      res.status(400).json({ success: false, error: langKey === 'en' ? 'This idea contains content we cannot work with. Please try another.' : '这个灵感包含不当内容，无法生成，请换一个描述', code: 'CONTENT_REJECTED' });
      return;
    }

    // 与角色扮演对话同池消耗聊天额度：免费次数 / Plus 每日 / Pro 无限；开启点数按预计 token 折算
    quotaUserId = user.userId;
    if (isCreditQuotaEnabled()) {
      const creditQuota = quotaStore.getCreditQuota(user.userId);
      const est = { credit: actionPricePoints('customDraft') }; // 整数价目表
      const reserve = quotaStore.reserveCredit(user.userId, 'roleplay', est);
      if (!reserve.ok) {
        res.status(402).json({ success: false, error: '今日额度点数已用完，明天再来，或升级解锁更多', code: 'CHAT_QUOTA_EXCEEDED', data: { quota: quotaStore.getQuota(user.userId), chatQuota: quotaStore.getChatQuota(user.userId), creditQuota } });
        return;
      }
      creditToken = reserve.token!;
    } else {
      const chatQuota = quotaStore.getChatQuota(user.userId);
      if (!chatQuota.canChat) {
        res.status(402).json({
          success: false,
          error: chatQuota.plan === 'plus'
            ? '今天的聊天额度用完啦，明天再来聊；或升级 Pro 无限畅聊'
            : '免费次数已用完，请付费解锁后继续使用',
          code: 'CHAT_QUOTA_EXCEEDED',
          data: { quota: quotaStore.getQuota(user.userId), chatQuota }
        });
        return;
      }
      // AI 帮我写剧本：单次生成扣 1 条（常量 ROLEPLAY_GEN_CHAT_COST；注释里曾写「扣 2 条」是过期说法）
      quotaConsumed = ROLEPLAY_GEN_CHAT_COST;
      for (let i = 0; i < ROLEPLAY_GEN_CHAT_COST; i++) {
        if (!quotaStore.consumeChat(user.userId)) {
          for (let j = 0; j < i; j++) quotaStore.rollbackChat(user.userId);
          quotaConsumed = 0;
          res.status(402).json({ success: false, error: '聊天额度不足', code: 'CHAT_QUOTA_EXCEEDED', data: { quota: quotaStore.getQuota(user.userId), chatQuota } });
          return;
        }
      }
    }

    const draft = await roleplayDraftCustom(idea, { userId: user.userId, lang: rpLang });

    // 输出安全：草稿属于用户自建内容，需过安全过滤（合规底线，不因「可玩性」放松）
    const joined = [draft.title, draft.aiName, draft.aiPersona, draft.background, draft.opening].filter(Boolean).join('\n');
    const scenarioCheck = checkCustomScenario({ title: draft.title, aiName: draft.aiName, aiPersona: draft.aiPersona, background: draft.background, opening: draft.opening });
    const outputCheck = checkAiOutputSafety(joined);
    /**
     * ⚠️ 两类失败必须**分开报**（2026-09-20 修）：
     *  · 内容/安全不过（scenarioCheck / outputCheck）→ `CONTENT_REJECTED`：这是红线，用户该改灵感；
     *  · **草稿不完整**（模型把 JSON 写坏/写漏）→ `DRAFT_FORMAT`：与内容无关，用户只需再点一次。
     *  以前两者共用 CONTENT_REJECTED，前端文案是"这个灵感暂时无法生成，请换一种描述再试" ——
     *  会让人误以为**自己的想法被判定违规**（用户报的"AI 创剧本有时会出错"多数就是这一类格式抖动）。
     */
    const unsafe = !scenarioCheck.safe || !outputCheck.safe;
    const incomplete = !isCompleteCustomDraft(draft);
    if (unsafe || incomplete) {
      creationPromptLog.add({ userId: user.userId, kind: 'roleplay-draft', prompt: idea, outcome: incomplete && !unsafe ? 'format' : 'rejected', lang: rpLang, resultTitle: draft?.title });
      if (creditToken && user.userId) { quotaStore.rollbackCredit(user.userId, creditToken); creditToken = null; }
      quotaStore.rollbackChat(user.userId); quotaConsumed = 0;
      if (incomplete && !unsafe) {
        res.status(400).json({
          success: false,
          code: 'DRAFT_FORMAT',
          error: langKey === 'en'
            ? 'The draft did not come back properly this time. Please tap generate again — nothing was charged.'
            : '这次没能生成成功（不是内容问题），再点一次就好——本次没有扣额度',
        });
        return;
      }
      res.status(400).json({ success: false, error: langKey === 'en' ? 'The draft came back incomplete or unsafe. Please try again with another idea.' : '生成的草稿不完整或包含不当内容，请换个描述再试', code: 'CONTENT_REJECTED' });
      return;
    }

    // 行为追踪：AI 辅助创建剧本为一次性生成、非对话回合，与 AI 文游「AI 生成剧本」口径一致，不计入剧情轮次
    if (creditToken && user.userId) { quotaStore.commitCredit(user.userId, creditToken); creditToken = null; }
    creationPromptLog.add({ userId: user.userId, kind: 'roleplay-draft', prompt: idea, outcome: 'ok', lang: rpLang, resultTitle: draft.title });
    console.log('✨ [Roleplay] AI 辅助创建剧本草稿成功: ' + (draft.title || '') + ' · user=' + user.userId.slice(0, 8));
    res.json({ success: true, data: { draft: draft as CustomDraftFields, quota: quotaStore.getQuota(user.userId), chatQuota: quotaStore.getChatQuota(user.userId) } });
  } catch (error) {
    // AI 调用失败时回滚已扣减的额度（与聊一聊/理一理/角色扮演一致，避免失败也扣费）
    if (creditToken && quotaUserId) { quotaStore.rollbackCredit(quotaUserId, creditToken); creditToken = null; }
    for (let i = 0; i < quotaConsumed; i++) { if (quotaUserId) quotaStore.rollbackChat(quotaUserId); }
    console.error('Roleplay custom draft error:', error);
    if (quotaUserId) creationPromptLog.add({ userId: quotaUserId, kind: 'roleplay-draft', prompt: req.body?.idea, outcome: 'error' });
    const msg = safeError('ai', error);
    res.status(500).json({ success: false, error: msg });
  }
});

router.get('/custom', (req: Request, res: Response): void => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '请先登录', code: 'LOGIN_REQUIRED' });
    return;
  }
  const ql = String(req.query?.lang || '');
  let list = customRoleplayStore.listByUser(user.userId);
  if (ql === 'zh-TW') {
    list = list.map(s => ({ ...s, title: toZhTw(s.title), aiName: toZhTw(s.aiName), aiPersona: toZhTw(s.aiPersona), background: toZhTw(s.background), opening: toZhTw(s.opening) }));
  }
  // 自建剧本也带点赞指标（基础热度为 0，只显示真实点赞；通常只有自己点过）
  const data = list.map(s => ({
    ...s,
    likes: getDisplayLikes(s.id),
    likedByMe: roleplayLikeStore.isLiked(user.userId, s.id),
  }));
  res.json({ success: true, data });
});

/**
 * 用户投稿/取消投稿自建剧本（UGC 精选：投稿后由运营人工挑选，而非自动公开）
 * POST /api/roleplay/custom/:id/publish  { published }
 */
router.post('/custom/:id/publish', (req: Request, res: Response): void => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '请先登录', code: 'LOGIN_REQUIRED' });
    return;
  }
  const id = String(req.params.id);
  const rec = customRoleplayStore.get(user.userId, id);
  if (!rec) {
    res.status(404).json({ success: false, error: '剧本不存在' });
    return;
  }
  const published = !!req.body?.published;
  // 投稿即进入「待审核」（不公开，由运营挑为一般/精选），再次过一遍内容安全红线（创作者视角不变，仍是同一人设）
  const safety = checkCustomScenario(rec);
  if (!safety.safe) {
    res.status(400).json({ success: false, error: '内容包含不当信息，无法投稿', code: 'CONTENT_REJECTED' });
    return;
  }
  const wasPublished = !!rec.published;
  const updated = customRoleplayStore.setPublished(user.userId, id, published);
  // 新投稿（未投稿 → 已投稿）时通知运营去「UGC 精选」挑为精选；重复投稿不重复提醒
  if (published && !wasPublished && updated) {
    const author = accountStore.getById(user.userId);
    void notifyNewUgcSubmission(updated, author ? { username: author.username, email: author.email } : undefined);
  }
  res.json({ success: true, data: updated });
});

/**
 * 运营精选的公开自建剧本（玩家共创区块；登录用户可带点赞状态）
 * GET /api/roleplay/featured?lang=
 */
router.get('/featured', (req: Request, res: Response): void => {
  const ql = String(req.query?.lang || '');
  const userId = resolveUserId(req) || '';
  const list = customRoleplayStore.listFeatured().map((s) => {
    const flat: Record<string, unknown> = {
      id: s.id,
      source: 'custom',
      featured: true,
      likes: getDisplayLikes(s.id),
      likedByMe: userId ? roleplayLikeStore.isLiked(userId, s.id) : false,
    };
    if (ql === 'zh-TW') {
      flat.title = toZhTw(s.title); flat.aiName = toZhTw(s.aiName);
      flat.aiPersona = toZhTw(s.aiPersona); flat.background = toZhTw(s.background); flat.opening = toZhTw(s.opening);
    } else {
      flat.title = s.title; flat.aiName = s.aiName;
      flat.aiPersona = s.aiPersona; flat.background = s.background; flat.opening = s.opening;
    }
    flat.avatar = s.avatar;
    flat.chatBackground = s.chatBackground;
    return flat;
  });
  res.json({ success: true, data: list });
});

/**
 * 运营已通过·一般公开的自建剧本（「玩家共创」一般区块；登录用户可带点赞状态）
 * GET /api/roleplay/community?lang=
 */
router.get('/community', (req: Request, res: Response): void => {
  const ql = String(req.query?.lang || '');
  const userId = resolveUserId(req) || '';
  const list = customRoleplayStore.listApproved().map((s) => {
    const flat: Record<string, unknown> = {
      id: s.id,
      source: 'custom',
      featured: false,
      status: 'approved',
      likes: getDisplayLikes(s.id),
      likedByMe: userId ? roleplayLikeStore.isLiked(userId, s.id) : false,
    };
    if (ql === 'zh-TW') {
      flat.title = toZhTw(s.title); flat.aiName = toZhTw(s.aiName);
      flat.aiPersona = toZhTw(s.aiPersona); flat.background = toZhTw(s.background); flat.opening = toZhTw(s.opening);
    } else {
      flat.title = s.title; flat.aiName = s.aiName;
      flat.aiPersona = s.aiPersona; flat.background = s.background; flat.opening = s.opening;
    }
    flat.avatar = s.avatar;
    flat.chatBackground = s.chatBackground;
    return flat;
  });
  res.json({ success: true, data: list });
});


/**
 * 编辑保存自建剧本（仅本人；内容变更后投稿/精选状态复位，需重新投稿才可再公开）
 * PUT /api/roleplay/custom/:id  { title?, aiName?, aiPersona?, background?, opening?, avatar?, chatBackground? }
 */
router.put('/custom/:id', (req: Request, res: Response): void => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '请先登录', code: 'LOGIN_REQUIRED' });
    return;
  }
  const id = String(req.params.id);
  const rec = customRoleplayStore.get(user.userId, id);
  if (!rec) {
    res.status(404).json({ success: false, error: '剧本不存在' });
    return;
  }
  const { title, aiName, aiPersona, background, opening, avatar, chatBackground } = req.body || {};
  const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  // 编辑允许逐项改：至少保留一个可玩字段（人设/背景/开场任一非空即算有效），不强制三项全填
  if (!clean(aiPersona) && !clean(background) && !clean(opening)) {
    res.status(400).json({ success: false, error: '请至少保留人设、背景或开场中的一项' });
    return;
  }
  for (const v of [title, aiName, aiPersona, background, opening]) {
    if (typeof v === 'string' && v.length > 2000) {
      res.status(400).json({ success: false, error: '内容过长' });
      return;
    }
  }
  if (avatar && !isImageDataUrl(avatar)) {
    res.status(400).json({ success: false, error: '头像图片格式不正确或过大' });
    return;
  }
  if (chatBackground && !isImageDataUrl(chatBackground)) {
    res.status(400).json({ success: false, error: '聊天背景图格式不正确或过大' });
    return;
  }
  const safety = checkCustomScenario({ title, aiName, aiPersona, background, opening });
  if (!safety.safe) {
    res.status(400).json({ success: false, error: '内容包含不当信息，无法保存修改', code: 'CONTENT_REJECTED' });
    return;
  }
  const updated = customRoleplayStore.update(user.userId, id, { title, aiName, aiPersona, background, opening, avatar: avatar || undefined, chatBackground: chatBackground || undefined });
  if (!updated) {
    res.status(404).json({ success: false, error: '剧本不存在' });
    return;
  }
  res.json({ success: true, data: updated });
});

/**
 * AI 按修改要求改动自建剧本：给出现有剧本 + 一句话修改要求，返回改动后的完整草稿（不落库，前端回填表单再保存）。
 * 计费：每次生成消耗 1 条聊天额度（与 /custom/draft 同池）；AI 调用失败/输出不安全/草稿不完整自动回滚不扣费。
 * POST /api/roleplay/custom/:id/revise  { instruction, lang? }
 */
router.post('/custom/:id/revise', async (req: Request, res: Response): Promise<void> => {
  let quotaUserId: string | null = null;
  let quotaConsumed = 0;
  let creditToken: string | null = null;
  try {
    const user = getAuthUser(req);
    if (!user) {
      res.status(401).json({ success: false, error: '请先登录', code: 'LOGIN_REQUIRED' });
      return;
    }
    const id = String(req.params.id);
    const rec = customRoleplayStore.get(user.userId, id);
    if (!rec) {
      res.status(404).json({ success: false, error: '剧本不存在' });
      return;
    }
    // 修改要求同样**不截断**（可能是一大段要求或直接贴上来的一版新剧本）
    const instruction = normalizeCustomIdea(req.body?.instruction);
    const rpLang: RPLang = String(req.body?.lang || '') === 'en' ? 'en' : String(req.body?.lang || '') === 'zh-TW' ? 'zh-TW' : 'zh';
    const langKey = toOutputLang(rpLang);
    if (!instruction) {
      res.status(400).json({ success: false, error: langKey === 'en' ? 'Please tell me how you want to change it first' : '请先写下你想怎么改', code: 'MISSING_IDEA' });
      return;
    }
    // 修改要求红线：命中高危/违规直接拒绝（不调用 AI、不扣额度）
    const inputCheck = checkContentSafety(instruction);
    if (!inputCheck.safe) {
      creationPromptLog.add({ userId: user.userId, kind: 'roleplay-revise', prompt: instruction, outcome: 'blocked', lang: rpLang, scenarioId: id });
      res.status(400).json({ success: false, error: langKey === 'en' ? 'This request contains content we cannot work with. Please try another.' : '这个要求包含不当内容，无法执行，请换一种说法', code: 'CONTENT_REJECTED' });
      return;
    }

    // 与草稿生成同池消耗聊天额度：免费次数 / Plus 每日 / Pro 无限；开启点数按预计 token 折算
    quotaUserId = user.userId;
    if (isCreditQuotaEnabled()) {
      const creditQuota = quotaStore.getCreditQuota(user.userId);
      const est = { credit: actionPricePoints('customRevise') }; // 整数价目表
      const reserve = quotaStore.reserveCredit(user.userId, 'roleplay', est);
      if (!reserve.ok) {
        res.status(402).json({ success: false, error: '今日额度点数已用完，明天再来，或升级解锁更多', code: 'CHAT_QUOTA_EXCEEDED', data: { quota: quotaStore.getQuota(user.userId), chatQuota: quotaStore.getChatQuota(user.userId), creditQuota } });
        return;
      }
      creditToken = reserve.token!;
    } else {
      const chatQuota = quotaStore.getChatQuota(user.userId);
      if (!chatQuota.canChat) {
        res.status(402).json({
          success: false,
          error: chatQuota.plan === 'plus'
            ? '今天的聊天额度用完啦，明天再来聊；或升级 Pro 无限畅聊'
            : '免费次数已用完，请付费解锁后继续使用',
          code: 'CHAT_QUOTA_EXCEEDED',
          data: { quota: quotaStore.getQuota(user.userId), chatQuota }
        });
        return;
      }
      // AI 改稿：单次生成扣 1 条（常量 ROLEPLAY_GEN_CHAT_COST）
      quotaConsumed = ROLEPLAY_GEN_CHAT_COST;
      for (let i = 0; i < ROLEPLAY_GEN_CHAT_COST; i++) {
        if (!quotaStore.consumeChat(user.userId)) {
          for (let j = 0; j < i; j++) quotaStore.rollbackChat(user.userId);
          quotaConsumed = 0;
          res.status(402).json({ success: false, error: '聊天额度不足', code: 'CHAT_QUOTA_EXCEEDED', data: { quota: quotaStore.getQuota(user.userId), chatQuota } });
          return;
        }
      }
    }

    // 基准用「表单当前内容」（含用户手改），未提供/为空时回退已存剧本
    const c = (req.body?.current && typeof req.body.current === 'object') ? req.body.current : {};
    const cv = (v: unknown, fb: string) => (typeof v === 'string' && v.trim() ? v.trim() : fb);
    const base = {
      title: cv(c.title, rec.title), aiName: cv(c.aiName, rec.aiName), aiPersona: cv(c.aiPersona, rec.aiPersona),
      background: cv(c.background, rec.background), opening: cv(c.opening, rec.opening),
    };
    const draft = await roleplayReviseCustom(base, instruction, { userId: user.userId, lang: rpLang });

    // 输出安全：改动后草稿属于用户自建内容，需过安全过滤；命中禁项/不完整 → 静默拒绝并回滚
    const scenarioCheck = checkCustomScenario({ title: draft.title, aiName: draft.aiName, aiPersona: draft.aiPersona, background: draft.background, opening: draft.opening });
    const outputCheck = checkAiOutputSafety([draft.title, draft.aiName, draft.aiPersona, draft.background, draft.opening].filter(Boolean).join('\n'));
    // 同上：内容不过 vs 格式抖动分开报（后者只需再点一次）
    const unsafeRev = !scenarioCheck.safe || !outputCheck.safe;
    const incompleteRev = !isCompleteCustomDraft(draft);
    if (unsafeRev || incompleteRev) {
      creationPromptLog.add({ userId: user.userId, kind: 'roleplay-revise', prompt: instruction, outcome: incompleteRev && !unsafeRev ? 'format' : 'rejected', lang: rpLang, scenarioId: id, resultTitle: draft?.title });
      if (creditToken && user.userId) { quotaStore.rollbackCredit(user.userId, creditToken); creditToken = null; }
      quotaStore.rollbackChat(user.userId); quotaConsumed = 0;
      if (incompleteRev && !unsafeRev) {
        res.status(400).json({
          success: false,
          code: 'DRAFT_FORMAT',
          error: langKey === 'en'
            ? 'The change did not come back properly this time. Please tap it again — nothing was charged.'
            : '这次没能改成功（不是内容问题），再点一次就好——本次没有扣额度',
        });
        return;
      }
      res.status(400).json({ success: false, error: langKey === 'en' ? "That change can't be made. Please try a different request." : '这个修改暂时无法完成，请换个说法再试', code: 'CONTENT_REJECTED' });
      return;
    }
    if (creditToken && user.userId) { quotaStore.commitCredit(user.userId, creditToken); creditToken = null; }
    creationPromptLog.add({ userId: user.userId, kind: 'roleplay-revise', prompt: instruction, outcome: 'ok', lang: rpLang, scenarioId: id, resultTitle: draft.title });
    res.json({ success: true, data: { draft: draft as CustomDraftFields, quota: quotaStore.getQuota(user.userId), chatQuota: quotaStore.getChatQuota(user.userId) } });
  } catch (error) {
    if (creditToken && quotaUserId) { quotaStore.rollbackCredit(quotaUserId, creditToken); creditToken = null; }
    for (let i = 0; i < quotaConsumed; i++) { if (quotaUserId) quotaStore.rollbackChat(quotaUserId); }
    console.error('Roleplay custom revise error:', error);
    if (quotaUserId) creationPromptLog.add({ userId: quotaUserId, kind: 'roleplay-revise', prompt: req.body?.instruction, outcome: 'error', scenarioId: String(req.params.id) });
    res.status(500).json({ success: false, error: safeError('ai', error) });
  }
});

router.delete('/custom/:id', (req: Request, res: Response): void => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '请先登录', code: 'LOGIN_REQUIRED' });
    return;
  }
  const ok = customRoleplayStore.delete(user.userId, String(req.params.id));
  res.json({ success: ok, data: ok });
});

/**
 * 剧情配乐偏好（登录用户跨设备同步）
 * GET /api/roleplay/bgm/prefs  → { bgmByScenario: { scenarioId: trackId } }
 * PUT /api/roleplay/bgm/prefs  { scenarioId, trackId }  → 最新整表；trackId='' 恢复默认
 */
router.get('/bgm/prefs', (req: Request, res: Response): void => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '请先登录', code: 'LOGIN_REQUIRED' });
    return;
  }
  res.json({ success: true, data: { bgmByScenario: bgmPrefStore.getByUser(user.userId) } });
});

router.put('/bgm/prefs', (req: Request, res: Response): void => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '请先登录', code: 'LOGIN_REQUIRED' });
    return;
  }
  const scenarioId = String(req.body?.scenarioId ?? '').trim();
  const rawTrack = req.body?.trackId == null ? '' : String(req.body.trackId).trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(scenarioId)) {
    res.status(400).json({ success: false, error: '剧本ID不合法' });
    return;
  }
  if (rawTrack !== '' && !/^[A-Za-z0-9._-]{1,128}$/.test(rawTrack)) {
    res.status(400).json({ success: false, error: '配乐ID不合法' });
    return;
  }
  res.json({ success: true, data: { bgmByScenario: bgmPrefStore.set(user.userId, scenarioId, rawTrack) } });
});

/**
 * 按需出图（S5）：给某剧本生成该「主题」的专属场景图（共享主题池之外的一层）。
 * POST /api/roleplay/scene/art { scenarioId, theme }
 * 🔴 红线：prompt 只由白名单表拼（见 services/sceneArt.ts），**用户文本一律不进 prompt**；只支持内置剧本。
 * 降级：侧车不可用/显存不足 → 200 + success:false + degraded:true（前端继续用共享图库，不打扰用户）。
 * 单卡保护：每用户每日上限（默认 8，SCENE_ART_DAILY_CAP 可调）→ 超限 429。
 */
router.post('/scene/art', async (req: Request, res: Response): Promise<void> => {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ success: false, error: '请先登录', code: 'LOGIN_REQUIRED' });
    return;
  }
  const v = validateSceneArtRequest((req.body || {}) as { scenarioId?: unknown; theme?: unknown });
  if (!v.ok) {
    res.status(400).json({ success: false, error: v.message, code: v.code });
    return;
  }
  const auto = (req.body as { auto?: unknown })?.auto === true;
  const result = await generateSceneArt(user.userId, v.scenarioId, v.theme, auto ? { auto: true } : {});
  if (result.ok) {
    res.json({ success: true, data: result });
    return;
  }
  // 自动出图失败一律**静默**（200 + success:false）：前端不该为"关键时刻自动补一张图"弹错误
  if (auto) {
    res.status(200).json({ success: false, code: result.code, error: result.message, data: { used: result.used, cap: result.cap, plan: result.plan } });
    return;
  }
  if (result.degraded) {
    res.status(200).json({ success: false, degraded: true, error: result.message, code: result.code, data: { used: result.used, cap: result.cap, plan: result.plan } });
    return;
  }
  res.status(result.code === 'DAILY_CAP' ? 429 : 400).json({ success: false, error: result.message, code: result.code, data: { used: result.used, cap: result.cap, plan: result.plan } });
});

/** 已缓存的专属画面（不发算力、不校验额度，供前端预判按钮态） */
router.get('/scene/art', (req: Request, res: Response): void => {
  const scenarioId = String(req.query?.scenarioId ?? '').trim();
  const theme = String(req.query?.theme ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(scenarioId) || !theme) {
    res.status(400).json({ success: false, error: '参数不合法' });
    return;
  }
  const user = getAuthUser(req);
  res.json({
    success: true,
    data: {
      url: findCachedSceneArt(scenarioId, theme),
      // 该剧本的「主场景图」（每部内置剧本一张）——前端优先用它，让整部剧在自己的空间里
      masterUrl: findMasterSceneArt(scenarioId),
      // C 方案：该剧本**这一幕的批量专属图**（云 API 跑批预生成，确定存在时优先于上面两者）
      ownUrl: findOwnThemeArt(scenarioId, theme),
      // 该剧本已有哪些幕的专属图（前端预热用 → 换幕即命中缓存，画面不迟到）
      ownUrls: listOwnThemeUrls(scenarioId),
      // 当前出图后端（排查用：用了哪家、有没有配 key、支持不支持负向词）
      backend: sceneArtBackendInfo(),
      quota: user ? sceneArtQuota(user.userId) : null,
    },
  });
});

export default router;
