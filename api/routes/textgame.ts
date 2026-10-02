/**
 * AI 文游（人生模拟器）API，千世书引擎回合代理
 * POST /api/textgame/chat  { messages: [{role:'user'|'assistant', content}], lang?, json? } → { reply }
 * POST /api/textgame/generate-scenario  { theme, target?, existingIds?, lang? } → { scenario }
 *   ?stream=1 → SSE：进度事件（骨架完成 / 支线 n/total）+ 每 10s `: ping` 心跳 + 收尾 done/error。
 *   为什么要流式：整份剧本要多次高思考 DeepSeek 调用（总耗时远超 100s），线上经 Cloudflare 回源时
 *   单请求约 100s 无数据即回 524；持续有数据即不会 524（旧同步路径保留，行为不变）。
 * 复用角色扮演的安全过滤 / 聊天额度 / DeepSeek 调用链路；剧本本身免费，每回合消耗 1 次聊天额度。
 *
 * json=true（文游回合）时：
 *   · 强制 DeepSeek 输出合法 JSON 对象（response_format），从源头消除「输出中没有完整的 JSON 对象」
 *   · 若返回仍缺完整 JSON，在同一请求内带纠错消息重试一次，重试不重复扣额度，
 *     避免客户端解析失败再发一次请求造成的双倍/三倍扣费
 * json 缺省/为 false（结局生成等纯文本场景）时按普通文本回复。
 *
 * generate-scenario：从主题生成整份剧本（多段 DeepSeek 调用），仅 Pro/Lifetime 可用，每日限量。
 */

import 'dotenv/config';
import { Router, type Request, type Response } from 'express';
import { safeError } from '../services/safeError.js';
import { resolveUserId } from '../services/session.js';
import { getClientCountry, getClientIp } from '../services/geo.js';
import { activityStore, isTestRequest } from '../services/activity.js';
import { quotaStore, isCreditQuotaEnabled, actionPricePoints} from '../services/quota.js';
import { checkContentSafety, isSelfHarmContent, checkAiOutputSafety } from '../services/safety.js';
import { pickGuide } from '../services/prompts.js';
import { createDeepSeekClient } from '../services/deepseek.js';
import { preferenceStore, resolveThinkingLevelFor } from '../services/preferences.js';
import { generateScenario } from '../services/scenarioGenerator.js';
// 文游回合的提示词片段（2026-09-26 搬去服务层，路由不再自己藏提示词；控制台「提示词」页读同一份）
import { textgameLangDirective, textgameGmBase, textgameJsonDirective } from '../services/textgamePrompts.js';
import { creationPromptLog } from '../services/creationPromptLog.js';
import { normalizeScriptText, toOutputLang } from '../services/zhConvert.js';

const router = Router();

// 文游（千世书）回合（json 回合走 low 思考、成本≈短聊 1.4 倍），计数模式下按 1 条聊天额度计（AI 托管同价）
const WENYOU_TURN_CHAT_COST = 1;

interface TextGameMsg {
  role: 'user' | 'assistant';
  content: string;
}

/** 从 start（必须是 '{'）起做字符串感知的花括号配对，返回最外层闭合 '}' 的下标，找不到返回 -1。
 *  与前端 src/wenyou/ai/json.ts 的 scanBalanced 同逻辑（服务端侧校验用，不重复造轮子）。 */
function scanBalanced(text: string, start: number): number {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (esc) { esc = false; continue }
    if (inStr) {
      if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 文本里是否存在一个可完整解析的 JSON 对象（扫描预算防止病态超长输入卡住主线程）。 */
function hasCompleteJson(text: string): boolean {
  const SCAN_BUDGET = 2_000_000
  let scanned = 0
  let start = text.indexOf('{')
  while (start >= 0) {
    const end = scanBalanced(text, start)
    scanned += (end >= 0 ? end - start + 1 : text.length - start)
    if (end >= 0) {
      try {
        JSON.parse(text.slice(start, end + 1))
        return true
      } catch {
        // 该起点的平衡片段不是合法 JSON，尝试下一个 '{'
      }
    }
    if (scanned > SCAN_BUDGET) break
    start = text.indexOf('{', start + 1)
  }
  return false
}

/** 「AI 托管」门控提示（三语） */
function autoMsg(lang: string, kind: 'pro' | 'limit'): string {
  if (kind === 'pro') {
    if (lang === 'en') return 'Auto-play is a Pro exclusive. Upgrade to Pro to let the AI play for you.';
    if (lang === 'zh-TW') return '「AI 托管」是 Pro 會員專屬功能，升級 Pro 後即可讓 AI 替你自動演進';
    return '「AI 托管」是 Pro 会员专属功能，升级 Pro 后即可让 AI 为你自动演进';
  }
  if (lang === 'en') return "Today's auto-play turns are used up. Continue manually, or come back tomorrow.";
  if (lang === 'zh-TW') return '今日「AI 托管」回合已用完，請手動繼續或明天再來';
  return '今日「AI 托管」回合已用完，请手动继续或明天再来';
}

/** 「AI 生成剧本」门控/安全提示（三语） */
function genMsg(lang: string, kind: 'pro' | 'limit' | 'rejected'): string {
  if (kind === 'pro') {
    if (lang === 'en') return 'AI scenario generation is a Pro exclusive. Upgrade to Pro to use it.';
    if (lang === 'zh-TW') return '「AI 生成劇本」是 Pro 會員專屬功能，升級 Pro 後即可使用';
    return '「AI 生成剧本」是 Pro 会员专属功能，升级 Pro 后即可使用';
  }
  if (kind === 'limit') {
    if (lang === 'en') return "Today's scenario generations are used up. Come back tomorrow.";
    if (lang === 'zh-TW') return '今日「AI 生成劇本」次數已用完，請明天再來';
    return '今日「AI 生成剧本」次数已用完，请明天再来';
  }
  if (lang === 'en') return 'This theme contains content we cannot generate. Please try another.';
  if (lang === 'zh-TW') return '這個主題包含不當內容，無法生成，請換一個主題';
  return '这个主题包含不当内容，无法生成，请换一个主题';
}

router.post('/chat', async (req: Request, res: Response): Promise<void> => {
  let quotaUserId: string | null = null;
  let quotaConsumed = 0;
  let autoConsumed = false;
  let creditToken: string | null = null;
  try {
    const { messages, lang, json } = req.body || {};
    const jsonMode = json === true;
    const streamMode = String(req.query?.stream || '') === '1';
    const userId = resolveUserId(req);
    quotaUserId = userId;
    // 深度思考：按用户偏好（默认 high）；max 仅 Pro。
    // 文游回合（json=true，需要快速吐出生成剧情+选项）用更轻的 low，避免高推理档把大量时间耗在“思考”上；
    // 非 json（如结局叙事）仍按用户偏好。流式（SSE）同样走 json 回合，用 low。
    const thinkingLevel = resolveThinkingLevelFor(
      userId,
      (jsonMode || streamMode) ? 'low' : (userId ? preferenceStore.get(userId).thinkingLevel : 'high'),
    );

    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ success: false, error: '缺少对话内容' });
      return;
    }
    const history: TextGameMsg[] = messages
      .filter((m: TextGameMsg) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-24)
      .map((m: TextGameMsg) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
    if (history.length === 0) {
      res.status(400).json({ success: false, error: '缺少对话内容' });
      return;
    }

    // 内容安全（与角色扮演一致）：用户消息命中高危/违规 → 降级引导回复（不调用 AI、不扣额度）
    const lastUserMsg = [...history].reverse().find(m => m.role === 'user')?.content || '';
    const langKey = toOutputLang(lang);
    const inputCheck = checkContentSafety(lastUserMsg);
    if (!inputCheck.safe) {
      const guide = pickGuide(langKey, isSelfHarmContent(lastUserMsg));
      res.json({ success: true, data: { reply: guide } });
      return;
    }

    // 文游回合同样消耗 AI 额度：免费次数 / Plus 每日 / Pro 无限（剧本本身免费）；开启点数则按预计 token 折算
    const isCredit = isCreditQuotaEnabled();
    if (isCredit) {
      const creditQuota = quotaStore.getCreditQuota(userId);
      const est = { credit: actionPricePoints('textgameTurn') }; // 整数价目表
      const reserve = quotaStore.reserveCredit(userId, 'textgame', est);
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
      // 文游回合更贵：每回合消耗 WENYOU_TURN_CHAT_COST 条聊天额度（AI 托管同价）
      quotaConsumed = WENYOU_TURN_CHAT_COST;
      for (let i = 0; i < WENYOU_TURN_CHAT_COST; i++) {
        if (!quotaStore.consumeChat(userId)) {
          for (let j = 0; j < i; j++) quotaStore.rollbackChat(userId);
          quotaConsumed = 0;
          res.status(402).json({ success: false, error: '聊天额度不足', code: 'CHAT_QUOTA_EXCEEDED', data: { quota: quotaStore.getQuota(userId), chatQuota } });
          return;
        }
      }
    }

    // 千世书「AI 托管」：仅 pro/lifetime 允许 + 每日回合上限（成本保护，见方案第 8 章）
    const auto = req.body?.auto === true;
    if (auto) {
      const ap = quotaStore.canAutoPlay(userId);
      if (!ap.allowed) {
        res.status(402).json({ success: false, error: '[AUTO] ' + autoMsg(langKey, 'pro'), code: 'AUTO_PRO_ONLY', data: { quota: quotaStore.getQuota(userId), autoPlay: ap } });
        return;
      }
      if (ap.remainToday <= 0) {
        res.status(402).json({ success: false, error: '[AUTO] ' + autoMsg(langKey, 'limit'), code: 'AUTO_LIMIT', data: { quota: quotaStore.getQuota(userId), autoPlay: ap } });
        return;
      }
    }
    if (auto) { quotaStore.consumeAutoPlay(userId); autoConsumed = true; }

    // 输出语言跟随界面语言（剧本/事件池为中文数据，由模型按用户语言实时转写叙事）
    const langDirective = textgameLangDirective(langKey);

    const gmBase = textgameGmBase(langKey);

    // 文游回合：强制单 JSON 对象输出（narrative 也放进 JSON），并要求 JSON 前后无任何附加文字。
    // 与前端 parseTurnResult 的「完整单 JSON 格式」契约一致，避免两段式拼接歧义。
    // 流式（SSE）改用「正文先行 + 尾部 JSON」两段式，正文可逐 token 展示。
    const jsonDirective = textgameJsonDirective(jsonMode, streamMode);

    const client = createDeepSeekClient();
    const historyMsgs = history.map(m => ({
      role: (m.role === 'assistant' ? 'model' : 'user') as 'user' | 'model',
      parts: [{ text: m.content }],
    }));
    // 语言/JSON 指令同时追加到最后一条消息（模型对最新指令权重最高），避免被整段中文 GM 提示盖过
    if (historyMsgs.length > 0) {
      const last = historyMsgs[historyMsgs.length - 1];
      last.parts = [{ text: last.parts[0].text + langDirective + jsonDirective }];
    }
    const contents = [
      { role: 'system' as const, parts: [{ text: gmBase + langDirective }] },
      ...historyMsgs,
    ];

    // 流式（SSE）：正文逐 token 下发；选项/摘要等最终 JSON 在 done 事件的 reply 里给，前端 parseTurnResult 收尾解析。
    if (streamMode) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      const streamAbort = new AbortController();
      res.on('close', () => { if (!res.writableEnded) streamAbort.abort(); });
      let full = '';
      const onToken = (delta: string) => { const d = normalizeScriptText(delta, langKey); full += d; try { res.write('data: ' + JSON.stringify({ type: 'delta', content: d }) + '\n\n'); } catch { /* 客户端已断开 */ } };
      console.log('🚀 [TextGame] 发送文游回合请求（SSE）, messages=' + history.length + ', lang=' + langKey + ', json=on');
      try {
        // 流式用「正文先行 + 尾部 JSON」两段式，因此不强制 json_object（jsonMode:false）
        await client.models.generateContentStream({ contents, userId, jsonMode: false, thinkingLevel, feature: 'wenyou' }, onToken, streamAbort.signal);
      } catch (e) {
        const msg = safeError('ai', e);
        // 记录真实失败原因，便于定位「剧情写一半/无选项/AI 服务端错误」的根因
        console.error('[TextGame] SSE 回合生成失败:', msg);
        // 失败必须退费（2026-09-29 审查 A6-P2-4）：这里过去直接 return，**跳过了外层 catch 的回滚**，
        // 而前端把「流失败」当成「本回合失败」并给「重试本回合」→ 一次故障按重试次数重复扣费。
        for (let i = 0; i < quotaConsumed; i++) { if (quotaUserId) quotaStore.rollbackChat(quotaUserId); }
        if (autoConsumed && quotaUserId) quotaStore.rollbackAutoPlay(quotaUserId);
        if (creditToken && quotaUserId) { quotaStore.rollbackCredit(quotaUserId, creditToken); creditToken = null; }
        if (res.headersSent) {
          try { res.write('data: ' + JSON.stringify({ type: 'error', error: msg }) + '\n\n'); } catch { /* */ }
          try { res.end(); } catch { /* */ }
        } else {
          res.status(500).json({ success: false, error: msg });
        }
        return;
      }
      const finalReply = checkAiOutputSafety(full).safe ? normalizeScriptText(full, langKey) : pickGuide(langKey, true);
      // 行为追踪：文游（千世书）成功回合一并计入「剧情模式」使用记录（与角色扮演口径一致），
      // mode:'wenyou' 让运营端能把它与「角色剧情扮演」拆开看（合计口径不变）；测试请求不计
      if (userId && !isTestRequest(getClientIp(req), String(req.headers['x-device-id'] || ''))) {
        const wyDetail = langKey === 'en' ? 'AI Story Game' : langKey === 'zh-TW' ? 'AI 文遊' : 'AI 文游';
        activityStore.trackFeature(userId, 'roleplay', { detail: wyDetail, mode: 'wenyou', ip: getClientIp(req), country: getClientCountry(req) });
      }
      console.log('✅ [TextGame] 回合回复长度(SSE): ' + full.length);
      if (creditToken && quotaUserId) { quotaStore.commitCredit(quotaUserId, creditToken); creditToken = null; }
      try { res.write('data: ' + JSON.stringify({ type: 'done', data: { reply: finalReply } }) + '\n\n'); } catch { /* */ }
      try { res.end(); } catch { /* */ }
      return;
    }

    // 非流式（缺省/旧调用）：返回整段 JSON
    // 请求一次；若 json 回合返回的文本不含完整 JSON，在同一请求内带纠错消息重试一次
    // （重试不重复 consumeChat，只在调用真正失败时回滚，见 catch）。
    const runOnce = async (msgs: typeof contents) => {
      const result = await client.models.generateContent({ contents: msgs, userId, jsonMode, thinkingLevel, feature: 'wenyou' });
      return result.candidates?.[0]?.content?.parts?.[0]?.text || '';
    };
    console.log('🚀 [TextGame] 发送文游回合请求, messages=' + history.length + ', lang=' + langKey + (jsonMode ? ', json=on' : ''));
    let text = await runOnce(contents);
    if (jsonMode && text && !hasCompleteJson(text)) {
      console.warn('⚠️ [TextGame] 回合输出缺完整 JSON，同一请求内带纠错重试（不重复扣额）');
      const corrected: typeof contents = [
        ...contents,
        { role: 'model' as const, parts: [{ text }] },
        {
          role: 'user' as const,
          parts: [{
            text: '你上一条输出格式不对：没有完整的 JSON 对象。请重新输出：整段回复必须且只能是【一个】完整 JSON 对象，包含 narrative、choices、summary 等字段，JSON 前后不要围栏或任何其他文字。'
              + langDirective,
          }],
        },
      ];
      text = await runOnce(corrected);
    }
    console.log('✅ [TextGame] 回合回复长度: ' + text.length);

    // 输出安全（与角色扮演一致）：指令式高危内容替换为危机引导
    const finalReply = checkAiOutputSafety(text).safe ? normalizeScriptText(text, langKey) : pickGuide(langKey, true);
    // 行为追踪：文游（千世书）成功回合一并计入「剧情模式」使用记录（与角色扮演口径一致），
    // mode:'wenyou' 让运营端能把它与「角色剧情扮演」拆开看（合计口径不变）；测试请求不计
    if (userId && !isTestRequest(getClientIp(req), String(req.headers['x-device-id'] || ''))) {
      const wyDetail = langKey === 'en' ? 'AI Story Game' : langKey === 'zh-TW' ? 'AI 文遊' : 'AI 文游';
      activityStore.trackFeature(userId, 'roleplay', { detail: wyDetail, mode: 'wenyou', ip: getClientIp(req), country: getClientCountry(req) });
    }
    if (creditToken && quotaUserId) { quotaStore.commitCredit(quotaUserId, creditToken); creditToken = null; }
    res.json({ success: true, data: { reply: finalReply } });
  } catch (error) {
    // AI 调用失败时回滚已扣减的额度（与理一理/聊一聊/角色扮演一致，避免失败也扣费）
    for (let i = 0; i < quotaConsumed; i++) { if (quotaUserId) quotaStore.rollbackChat(quotaUserId); }
    if (autoConsumed && quotaUserId) quotaStore.rollbackAutoPlay(quotaUserId);
    if (creditToken && quotaUserId) { quotaStore.rollbackCredit(quotaUserId, creditToken); creditToken = null; }
    res.status(500).json({ success: false, error: safeError('ai', error) });
  }
});

/**
 * AI 生成剧本：从主题生成整份文游剧本（骨架 + 本地事件池），仅 Pro/Lifetime 可用，每日限量。
 * 单次请求内调用多次 DeepSeek；成功后消耗 1 个生成名额，失败不消耗。
 */
router.post('/generate-scenario', async (req: Request, res: Response): Promise<void> => {
  let userId: string | null = null;
  let creditToken: string | null = null;
  // SSE（?stream=1）状态：声明在 handler 作用域，catch 里也要用（开流后出错改以 error 事件下发）
  const streamMode = String(req.query.stream || '') === '1';
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const streamAbort = new AbortController();
  const sseSend = (payload: unknown): void => {
    if (!streamMode) return;
    try { res.write('data: ' + JSON.stringify(payload) + '\n\n'); } catch { /* 客户端已断开 */ }
  };
  const sseEnd = (): void => {
    if (!streamMode) return;
    try { res.end(); } catch { /* 忽略 */ }
  };
  try {
    const { theme, target, existingIds, lang } = req.body || {};
    const cleanTheme = typeof theme === 'string' ? theme.trim() : '';
    if (!cleanTheme) {
      res.status(400).json({ success: false, error: '缺少剧本主题' });
      return;
    }
    if (cleanTheme.length > 200) {
      res.status(400).json({ success: false, error: '主题过长' });
      return;
    }
    let targetNum = Number(target);
    if (!Number.isInteger(targetNum)) targetNum = 40;
    targetNum = Math.max(20, Math.min(100, targetNum));
    const ids = Array.isArray(existingIds) ? existingIds.filter((id: unknown) => typeof id === 'string') : [];

    const langKey = toOutputLang(lang);
    userId = resolveUserId(req);
    if (!userId) {
      res.status(401).json({ success: false, error: genMsg(langKey, 'pro'), code: 'LOGIN_REQUIRED' });
      return;
    }

    // 内容安全：主题命中高危/违规 → 直接拒绝（不调用 AI）
    const inputCheck = checkContentSafety(cleanTheme);
    if (!inputCheck.safe) {
      res.status(400).json({ success: false, error: genMsg(langKey, 'rejected'), code: 'CONTENT_REJECTED' });
      return;
    }

    // Pro 专属 + 每日限量（成本保护，见方案第 4 章）
    const gen = quotaStore.canGenerate(userId);
    if (!gen.allowed) {
      res.status(402).json({ success: false, error: genMsg(langKey, 'pro'), code: 'GEN_PRO_ONLY', data: { quota: quotaStore.getQuota(userId), gen } });
      return;
    }
    if (gen.remainToday <= 0) {
      res.status(402).json({ success: false, error: genMsg(langKey, 'limit'), code: 'GEN_LIMIT', data: { quota: quotaStore.getQuota(userId), gen } });
      return;
    }

    // 统一点数：AI 生成剧本是多调用流程（骨架 + 多批支线），按预估预留一次，失败回滚
    if (isCreditQuotaEnabled()) {
      const creditQuota = quotaStore.getCreditQuota(userId);
      const est = { credit: actionPricePoints('generateScenario') }; // 整数价目表
      const reserve = quotaStore.reserveCredit(userId, 'generateScenario', est);
      if (!reserve.ok) {
        res.status(402).json({ success: false, error: '今日额度点数已用完，明天再来，或升级解锁更多', code: 'CHAT_QUOTA_EXCEEDED', data: { quota: quotaStore.getQuota(userId), gen, creditQuota } });
        return;
      }
      creditToken = reserve.token!;
    }

    // SSE 开流（?stream=1）：放在全部校验/门控之后，因此 401/400/402 仍是普通 JSON
    // （前端靠 code 精确识别 LOGIN_REQUIRED / CONTENT_REJECTED / GEN_PRO_ONLY / GEN_LIMIT / 额度不足）。
    // 为什么要流式：整份剧本是多段高思考 DeepSeek 调用，总耗时远超 100s；线上经 Cloudflare 回源，
    // 单请求约 100s 无数据即回 524（用户侧「HTTP错误: 524」）。一直有数据就不会 524。
    if (streamMode) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      // 立刻下发一帧：让边缘（Cloudflare）马上看到「已有响应」，而不是干等上游 LLM
      sseSend({ type: 'progress', step: 'skeleton', done: 0, total: targetNum });
      // 心跳保活：单批高思考可能静默数十秒（与 roleplay / analysis 的 SSE 同一策略）
      heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 客户端已断开 */ } }, 10000);
      // 客户端断开（关弹窗/关页面）→ 中止上游，不白烧剩余的多次生成
      res.on('close', () => { if (!res.writableEnded) streamAbort.abort(); });
    }

    const scenario = await generateScenario({
      theme: cleanTheme, target: targetNum, existingIds: ids, userId, lang: langKey,
      onProgress: (p) => sseSend({ type: 'progress', step: p.step, done: p.done, total: p.total }),
      signal: streamMode ? streamAbort.signal : undefined,
    });

    // 输出安全：生成剧本属于用户自建内容，需过安全过滤（合规底线，不因可玩性放松）
    const visible = [
      scenario.title,
      scenario.intro,
      scenario.systemPrompt,
      ...(scenario.ambitions ?? []),
      ...(scenario.localEvents ?? []).flatMap((e) => [e.narrative, ...e.choices.map((c) => c.text)]),
    ].join(' ');
    if (!checkAiOutputSafety(visible).safe) {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      if (creditToken && userId) { quotaStore.rollbackCredit(userId, creditToken); creditToken = null; }
      if (streamMode) {
        if (userId) creationPromptLog.add({ userId, kind: 'wenyou-generate', prompt: cleanTheme, outcome: 'rejected', lang: langKey, resultTitle: scenario.title });
        sseSend({ type: 'error', error: genMsg(langKey, 'rejected'), code: 'CONTENT_REJECTED' });
        sseEnd();
      } else {
        if (userId) creationPromptLog.add({ userId, kind: 'wenyou-generate', prompt: cleanTheme, outcome: 'rejected', lang: langKey, resultTitle: scenario.title });
        res.status(400).json({ success: false, error: genMsg(langKey, 'rejected'), code: 'CONTENT_REJECTED' });
      }
      return;
    }

    // 成功后记账（失败路径不消耗）：点数保留（commit）+ 每日生成名额 +1
    quotaStore.consumeGenerate(userId);
    if (creditToken && userId) { quotaStore.commitCredit(userId, creditToken); creditToken = null; }
    if (userId) creationPromptLog.add({ userId, kind: 'wenyou-generate', prompt: cleanTheme, outcome: 'ok', lang: langKey, resultTitle: scenario.title });
    console.log('✨ [TextGame] AI 生成剧本成功: ' + scenario.title + ' · 事件=' + (scenario.localEvents ?? []).length + ' · user=' + userId.slice(0, 8) + (streamMode ? ' · SSE' : ''));
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (streamMode) {
      sseSend({ type: 'done', data: { scenario } });
      sseEnd();
    } else {
      res.json({ success: true, data: { scenario } });
    }
  } catch (error) {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (creditToken && userId) { quotaStore.rollbackCredit(userId, creditToken); creditToken = null; }
    console.error('⚠️ [TextGame] AI 生成剧本失败:', (error as Error)?.message);
    if (userId) creationPromptLog.add({ userId, kind: 'wenyou-generate', prompt: req.body?.theme, outcome: 'error', lang: typeof req.body?.lang === 'string' ? req.body.lang : undefined });
    // 已开流（SSE）：错误也以 error 事件下发，前端据此给出真实原因而不是笼统的「生成失败」
    if (streamMode && res.headersSent && !res.writableEnded) {
      sseSend({ type: 'error', error: safeError('ai', error) });
      sseEnd();
    } else if (!res.headersSent) {
      res.status(500).json({ success: false, error: safeError('ai', error) });
    }
  }
});

export default router;
