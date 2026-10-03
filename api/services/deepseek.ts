/**
 * DeepSeek AI 服务模块（OpenAI 兼容接口）
 *
 * 以与 @google/genai 的 generateContent 相同的调用形态暴露 DeepSeek API，
 * 使 api/services/gemini.ts 无需改动业务逻辑即可切换模型后端。
 *
 * 环境变量：
 *  - DEEPSEEK_API_KEY   必填，DeepSeek API Key
 *  - DEEPSEEK_BASE_URL  可选，默认 https://api.deepseek.com
 *  - DEEPSEEK_MODEL     可选，默认 deepseek-v4-flash（**图片/视觉输入也走它**：2026-09-18 实测该模型
 *                        直接接受 image_url 内容块并能正确读图，探针 temp/probe-vision-model.mjs）
 *  - DEEPSEEK_MAX_TOKENS 可选，默认 8192（推理模型需要足够 token 先思考再输出）
 */

import type { UsageLike } from './usage.js';

const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const DEEPSEEK_MAX_TOKENS = Number(process.env.DEEPSEEK_MAX_TOKENS || 8192);
// 单次请求超时（ms）：防止 DeepSeek 慢响应导致用户聊天无限转圈
const DEEPSEEK_TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS || 60000);
// 429/5xx/网络/超时 的重试次数（指数退避），4xx 业务错误不重试
const DEEPSEEK_MAX_RETRIES = Number(process.env.DEEPSEEK_MAX_RETRIES || 2);

/**
 * Provider 配置（双分支模型路由）
 *
 * 背景：角色扮演链路需要「肯如实写成人向剧情」的模型，官方 DeepSeek 会自我净化，
 * 因此剧情链路可按语言指向不同的 OpenAI 兼容第三方后端（中文/英文各一套模型），
 * 其余链路（情感对话 / 文游 / 狼人杀 / 视觉）继续用默认 DeepSeek。
 *
 * 关键：`isDeepSeek` 为 false 时**不得**注入 DeepSeek 专有字段，否则第三方托管会直接 400：
 *  - thinking / reasoning_effort
 *  - user_id
 *  - stream_options
 */
export interface ProviderConfig {
  /** 日志与报错文案里的名字 */
  name: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  maxRetries: number;
  /** true = DeepSeek 官方（才注入 thinking/reasoning_effort/user_id 等专有字段） */
  isDeepSeek: boolean;
  /**
   * true = 该上游按**订阅制**（固定月费 / 并发单元）计费，token 不产生按量费用。
   *
   * 影响：usage 账本把它的调用按 **cost 0** 记（token 照记，另存 notionalCost 参考价）。
   * 不这么做的话，运营端会把「其实没花的 token 钱」算进 API 成本，利润被系统性低估
   * （剧情成人档的第三方托管就是这种：按并发单元订阅，不按 token）。
   *
   * 缺省：createCompatClient 设为 true（第三方托管基本都是订阅制）；
   * 若某天指向**按量计费**的第三方（OpenRouter 等），配「RP_*_FLAT_RATE=0」关掉。
   */
  flatRate?: boolean;
  /** 流式最后一帧是否回传 usage；第三方托管不一定支持，不支持就别发，否则可能 400 */
  streamUsage: boolean;
  /**
   * 额外合并进请求体的字段（第三方托管专有能力的逃生口，避免把某家的私有字段写死进业务代码）。
   * 典型用途：Featherless 的 { chat_template_kwargs: { enable_thinking: false } }
   * Qwen3.5 系默认开启思考，不关掉会白烧几百到上千输出 token。
   *
   * 注：**成人档禁止思考模式**（2026-09-25 产品决定）由 roleplayModel 的 enforceNoThinking
   * 强制保证，那道不变量会把这里的 enable_thinking 覆盖成 false，所以本层不需要知道这条业务规则。
   */
  extraBody?: Record<string, unknown>;
  /** 显式 API Key；不填则回落到 process.env.DEEPSEEK_API_KEY（保持改造前行为） */
  apiKey?: string;
}

/** 默认 provider：DeepSeek 官方（配置与改造前逐字一致，行为零变化） */
export const DEEPSEEK_PROVIDER: ProviderConfig = {
  name: 'DeepSeek',
  baseUrl: DEEPSEEK_BASE_URL,
  model: DEEPSEEK_MODEL,
  maxTokens: DEEPSEEK_MAX_TOKENS,
  timeoutMs: DEEPSEEK_TIMEOUT_MS,
  maxRetries: DEEPSEEK_MAX_RETRIES,
  isDeepSeek: true,
  streamUsage: true,
};

/** user_id 清洗：仅保留 [a-zA-Z0-9-_]，最长 512（DeepSeek 约束，用于内容安全/KVCache/调度隔离） */
function sanitizeUserId(id?: string): string | undefined {
  if (!id) return undefined;
  const clean = id.replace(/[^a-zA-Z0-9\-_]/g, '').slice(0, 512);
  return clean || undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 没有真实 usage 时的保守 token 估算（只用于兜底，会以 `estimated` 标记入账）。
 *
 * 什么时候用：① 第三方托管不支持 `stream_options.include_usage`，流式拿不到 usage；
 * ② 流式中途被中断（用户点停止/断线），上游已经生成的 token 是真花钱的，
 * 但末尾那帧 usage 永远不会到，此前这类调用**一分钱都不记账**（成本盲区）。
 *
 * 系数：中文 ≈ 1 token / 1.5 字符；其余（英文/标点/数字/emoji）≈ 1 token / 4 字符。
 * 刻意取偏保守的值（宁可略低不虚高），并全程标记 estimated，运营端可单独识别。
 */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
  const other = Math.max(0, text.length - cjk);
  return Math.round(cjk / 1.5 + other / 4);
}

/** 把「请求 messages + 已生成的正文/思考」折算成一份 usage 形状（供兜底记账） */
function estimateUsageFromMessages(
  messages: Array<{ role: string; content: unknown }>,
  outputText: string,
  reasoningText: string,
): { prompt_tokens: number; completion_tokens: number } {
  let promptChars = 0;
  for (const m of messages) {
    const c = m?.content;
    if (typeof c === 'string') promptChars += c.length;
    else if (Array.isArray(c)) for (const part of c) promptChars += String((part as { text?: string })?.text || '').length;
  }
  return {
    // 请求侧（系统提示词 + 对话历史）几乎全是中文 → 按中文密度折算，对混合内容偏保守
    prompt_tokens: Math.round(promptChars / 1.5),
    completion_tokens: estimateTokensFromText(outputText + reasoningText),
  };
}

export interface DeepSeekPart {
  text?: string;
  image?: string; // base64 data URL（视觉输入）
  image_url?: { url: string; detail?: 'low' | 'high' | 'original' | 'auto' };
}
export interface DeepSeekToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface GenerateContentRequest {
  model?: string; // 可覆盖默认模型（'gemini-2.5-flash' 为兼容占位符＝用默认模型）
  contents?: Array<{
    role: 'system' | 'user' | 'model' | 'tool';
    parts?: DeepSeekPart[];
    toolCalls?: DeepSeekToolCall[]; // assistant（model）消息携带的工具调用
    toolCallId?: string;            // tool 消息携带，对应 assistant 的 tool_call.id
    reasoningContent?: string;      // assistant 在思考模式下产生的 reasoning_content（带 tools 时必须回传）
  }>;
  userId?: string; // 用于 API 用量与费用统计
  /**
   * 成本归属功能（聊一聊/剧情扮演/文游/狼人杀…），用于运营端「API 成本构成」细分。
   * 取值见 api/services/usage.ts 的 UsageFeature；不传 = 'unknown'（控制台显示为「历史未分类」）。
   * 每个调用点都应显式标注，控制台靠这一个字段回答「这笔钱是谁花的」。
   */
  feature?: string;
  tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: any } }>; // 函数调用工具
  // 强制模型只输出合法 JSON 对象（OpenAI 兼容 response_format），用于文游回合的结构化输出，
  // 从源头避免「输出中没有完整的 JSON 对象」导致客户端重试、重复扣额
  jsonMode?: boolean;
  // 单次调用的输出上限覆盖；不传则用 provider 配置的 maxTokens。
  // 用途：剧情回复（prompt 限定 300-600 字）用较小值以降低撑爆小窗口模型的风险，
  // 而剧本生成要输出 5 个长字段 JSON，需要更大值。
  maxTokens?: number;
  // 深度思考档位：off / low / medium / high / max。不传 = 关闭（维持旧行为）；由调用方按用户偏好决定。
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'max';
  // 每次调用拿到真实 usage 时回调（供额度层做「预扣 → 真实结算」校正）。后台辅助调用请勿传，避免重复计费。
  onUsage?: (usage: UsageLike) => void;
  // 外部中断信号：客户端断开（如关闭「AI 生成剧本」弹窗）时中止上游调用，避免白烧一次多段生成。
  // 外部取消不重试、也不当作「响应超时」，它是一次明确的放弃。
  signal?: AbortSignal;
}

/**
 * 把 parts 转成 OpenAI messages.content：
 * 纯文本 → string；含图片 → 内容块数组（text + image_url）
 */
function buildMessageContent(parts?: DeepSeekPart[]): string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> {
  const list = parts || [];
  if (!list.some(p => p.image || p.image_url)) {
    return list.map(p => p.text || '').join('');
  }
  const blocks: Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> = [];
  for (const p of list) {
    if (p.text) blocks.push({ type: 'text', text: p.text });
    if (p.image) blocks.push({ type: 'image_url', image_url: { url: p.image } });
    if (p.image_url) blocks.push({ type: 'image_url', image_url: p.image_url });
  }
  return blocks;
}

/** 把 contents 转成 OpenAI messages（支持 system/user/model(assistant)/tool 角色与工具调用，P1-08） */
export function buildMessages(contents?: GenerateContentRequest['contents']): any[] {
  return (contents || []).map((c) => {
    if (c.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: c.toolCallId,
        content: (c.parts || []).map((p) => p.text || '').join('')
      };
    }
    const msg: any = {
      role: c.role === 'model' ? 'assistant' : c.role === 'system' ? 'system' : 'user',
      content: buildMessageContent(c.parts)
    };
    if (c.toolCalls && c.toolCalls.length) msg.tool_calls = c.toolCalls;
    // 思考模式下带 tools 的请求必须回传 reasoning_content，否则 400（官方规则）
    if (c.reasoningContent) msg.reasoning_content = c.reasoningContent;
    return msg;
  });
}

/**
 * 深度思考档位 → DeepSeek 请求体合并的字段。
 * 官方映射：low→low、medium→high、xhigh→high、max→max；off→disabled。未传默认关闭（维持旧行为）。
 */
function thinkingWireForLevel(level?: GenerateContentRequest['thinkingLevel']): Record<string, unknown> {
  switch (level) {
    case 'low': return { thinking: { type: 'enabled' }, reasoning_effort: 'low' };
    case 'medium': return { thinking: { type: 'enabled' }, reasoning_effort: 'high' }; // medium → high
    case 'high': return { thinking: { type: 'enabled' }, reasoning_effort: 'high' };
    case 'max': return { thinking: { type: 'enabled' }, reasoning_effort: 'max' };
    case 'off': return { thinking: { type: 'disabled' } };
    default: return { thinking: { type: 'disabled' } };
  }
}

/**
 * 调用 DeepSeek chat/completions，返回与 @google/genai generateContent 相同的结构
 */
async function generateContent(req: GenerateContentRequest, cfg: ProviderConfig = DEEPSEEK_PROVIDER): Promise<any> {
  const tag = '[' + cfg.name + ']';
  const apiKey = cfg.apiKey || process.env.DEEPSEEK_API_KEY || '';
  if (!apiKey) {
    throw new Error(cfg.name + ' API Key 未配置，请在 .env 中补上对应环境变量');
  }

  const messages = buildMessages(req.contents);

  // gemini.ts 传 'gemini-2.5-flash' 是 @google/genai 兼容占位符，等价于"用默认模型"（文本与图片同一模型）；
  // 传其它模型名（如剧情链路的第三方模型）才是真正的模型覆盖
  const useModel = (req.model && req.model !== 'gemini-2.5-flash') ? req.model : cfg.model;
  const body: any = {
    model: useModel,
    messages,
    max_tokens: req.maxTokens || cfg.maxTokens
  };
  // thinking / reasoning_effort 为 DeepSeek 专有；第三方托管收到未知字段会 400
  if (cfg.isDeepSeek) Object.assign(body, thinkingWireForLevel(req.thinkingLevel));
  if (req.tools && req.tools.length) body.tools = req.tools;
  // 结构化输出：强制 JSON 对象（与 thinking disabled 配合，文游回合直接可用）
  if (req.jsonMode) body.response_format = { type: 'json_object' };
  // user_id 为 DeepSeek 专有（内容安全 / KVCache / 调度隔离 + 更细粒度用量统计），第三方不认
  const uid = sanitizeUserId(req.userId);
  if (uid && cfg.isDeepSeek) body.user_id = uid;
  // 托管专有扩展（如关闭 Qwen 思考）：显式配置才注入，最后合并以便覆盖默认值
  if (cfg.extraBody) Object.assign(body, cfg.extraBody);

  let lastError: Error = new Error(cfg.name + ' API 请求失败');
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (attempt > 0) {
      const backoff = 500 * Math.pow(2, attempt - 1);
      console.log(`⚠️ ${tag} 第 ${attempt} 次重试（上限 ${cfg.maxRetries} 次），${backoff}ms 后…`);
      await sleep(backoff);
    }
    // 分时定价要按「调用发起时刻」判 peak（长请求可能跨过 peak 边界）
    const startedAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    // 外部中断（客户端断开）合并进同一条 abort 通道；调用前已取消则立刻放弃
    const onExternalAbort = () => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) { clearTimeout(timer); lastError = new Error('请求已取消'); break; }
      req.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    try {
      const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const errText = await response.text();
        const status = response.status;
        const retryable = status === 429 || status >= 500;
        // 上游原文只进日志，不拼进对外 error message（避免泄露上游服务内部信息）；剥离图片 base64 防用户内容进日志
        console.error(tag + ' upstream error', status, errText.replace(/data:image\/[^,]+;base64,[A-Za-z0-9+/=]+/gi, '[image]').slice(0, 500));
        lastError = new Error(cfg.name + ' API 请求失败');
        if (!retryable) break; // 4xx（除 429）为永久错误，不重试
        continue;
      }

      const data = await response.json();
      const choice = data?.choices?.[0];
      const text = choice?.message?.content || '';
      const reasoningContent = choice?.message?.reasoning_content || '';
      const toolCalls: DeepSeekToolCall[] = choice?.message?.tool_calls || [];
      const finishReason: string = choice?.finish_reason || '';
      const usage = data?.usage;

      console.log(`✅ ${tag} 响应成功, content长度=${text.length}, toolCalls=${toolCalls.length}, usage=${JSON.stringify(usage)}`);

      // 记录该用户的 API 用量与费用（按 feature 归到「聊一聊/剧情扮演/文游/狼人杀…」，按发起时刻分时计价）
      if (req.userId) {
        try {
          const { usageStore } = await import('./usage.js');
          usageStore.record(req.userId, usage, req.feature, { at: startedAt, flatRate: cfg.flatRate === true });
        } catch (e) {
          console.warn(`⚠️ ${tag} 用量记录失败:`, (e as Error)?.message);
        }
      }
      // 额度层「预扣 → 真实结算」需要真实 usage
      if (req.onUsage && usage) req.onUsage(usage);

      // 与 @google/genai generateContent 返回结构保持一致
      return {
        candidates: [
          {
            content: {
              parts: [{ text }]
            }
          }
        ],
        toolCalls,
        reasoningContent,
        finishReason,
        usage,
      };
    } catch (e) {
      const isTimeout = e instanceof Error && e.name === 'AbortError';
      const isNetwork = e instanceof Error && e.name === 'TypeError';
      // 外部主动取消（客户端已断开）：不重试也不当超时，直接结束
      if (req.signal?.aborted) {
        lastError = new Error('请求已取消');
        break;
      }
      lastError = isTimeout
        ? new Error(cfg.name + ' API 响应超时，请稍后重试')
        : (e instanceof Error ? e : new Error(String(e)));
      // 超时/网络错误可重试；其它异常不重试
      if (!isTimeout && !isNetwork) break;
      if (attempt === cfg.maxRetries) break;
    } finally {
      clearTimeout(timer);
      if (req.signal) req.signal.removeEventListener('abort', onExternalAbort);
    }
  }
  throw lastError;
}

/**
 * 流式调用 DeepSeek chat/completions（SSE），边生成边回调 onToken(delta)
 * 返回与 generateContent 相同的结构；不自动重试（避免中途重试导致 token 重复）
 */
async function generateContentStream(
  req: GenerateContentRequest,
  onToken?: (delta: string) => void,
  signal?: AbortSignal,
  cfg: ProviderConfig = DEEPSEEK_PROVIDER
): Promise<any> {
  const tag = '[' + cfg.name + ']';
  const apiKey = cfg.apiKey || process.env.DEEPSEEK_API_KEY || '';
  if (!apiKey) {
    throw new Error(cfg.name + ' API Key 未配置，请在 .env 中补上对应环境变量');
  }

  const messages = buildMessages(req.contents);

  // 同上：'gemini-2.5-flash' 为兼容占位符，其它模型名才是覆盖
  const useModel = (req.model && req.model !== 'gemini-2.5-flash') ? req.model : cfg.model;
  const body: any = {
    model: useModel,
    messages,
    max_tokens: req.maxTokens || cfg.maxTokens,
    stream: true
  };
  // 让流式响应的最后一帧携带 usage，真正计入 API 成本（此前流式路径不记账，成本盲区）
  // 第三方托管不一定支持 stream_options，不支持时不发（否则可能 400）
  if (cfg.streamUsage) body.stream_options = { include_usage: true };
  // thinking / reasoning_effort 为 DeepSeek 专有；第三方托管收到未知字段会 400
  if (cfg.isDeepSeek) Object.assign(body, thinkingWireForLevel(req.thinkingLevel));
  if (req.tools && req.tools.length) body.tools = req.tools;
  // user_id 为 DeepSeek 专有，第三方不认
  const uid = sanitizeUserId(req.userId);
  if (uid && cfg.isDeepSeek) body.user_id = uid;
  // 托管专有扩展（如关闭 Qwen 思考）：显式配置才注入
  if (cfg.extraBody) Object.assign(body, cfg.extraBody);

  // 分时定价按「调用发起时刻」判 peak（长流式可能跨过 peak 边界）
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onExternalAbort, { once: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  // 提到 try 之外：流式中途被中断时，也要能按「已经流出来的内容」估算入账（见 finally）
  let full = '';
  let reasoningFull = '';
  let usage: any = null;
  let recorded = false;
  /** 幂等记账：拿到真实 usage 就按真实值记，不然在 finally 里按估算值记一次，绝不重复 */
  const recordOnce = async (usageObj: any, estimated: boolean): Promise<void> => {
    if (recorded || !req.userId) return;
    recorded = true;
    try {
      const { usageStore } = await import('./usage.js');
      usageStore.record(req.userId, usageObj, req.feature, { estimated, at: startedAt, flatRate: cfg.flatRate === true });
    } catch (e) {
      console.warn(`⚠️ ${tag} 用量记录失败:`, (e as Error)?.message);
    }
  };
  try {
    const response = await fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(tag + ' stream upstream error', response.status, errText.replace(/data:image\/[^,]+;base64,[A-Za-z0-9+/=]+/gi, '[image]').slice(0, 500));
      throw new Error(cfg.name + ' API 请求失败');
    }
    if (!response.body) throw new Error(cfg.name + ' 流式响应无 body');

    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    // full / reasoningFull / usage 声明在 try 之外（中断时 finally 要用）
    let buffer = '';
    let finishReason = '';
    const toolCalls: DeepSeekToolCall[] = [];

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
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const choice = json?.choices?.[0];
          const delta = choice?.delta || {};
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (json?.usage) usage = json.usage;
          const content = delta?.content || '';
          const reason = delta?.reasoning_content || '';
          if (content) {
            full += content;
            if (onToken) onToken(content);
          }
          if (reason) reasoningFull += reason;
          if (Array.isArray(delta?.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx2 = tc.index ?? 0;
              if (!toolCalls[idx2]) toolCalls[idx2] = { id: '', type: 'function', function: { name: '', arguments: '' } };
              if (tc.id) toolCalls[idx2].id = tc.id;
              if (tc.function?.name) toolCalls[idx2].function.name += tc.function.name;
              if (tc.function?.arguments) toolCalls[idx2].function.arguments += tc.function.arguments;
            }
          }
        } catch { /* 忽略无法解析的行 */ }
      }
    }

    if (usage) await recordOnce(usage, false);
    if (req.onUsage && usage) req.onUsage(usage);

    return {
      candidates: [{ content: { parts: [{ text: full }] } }],
      toolCalls: toolCalls.filter(Boolean),
      reasoningContent: reasoningFull,
      finishReason,
      usage,
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
    try { if (reader) await reader.cancel(); } catch { /* 忽略 */ }
    /**
     * 兜底记账（此前这里是成本盲区）：流式已流出内容、但**始终没拿到 usage** 时按生成量估算入账。
     * 两种典型场景：① 第三方托管不支持 stream_options.include_usage；
     * ② 用户点了停止/断线，末尾的 usage 帧永远不会到（上游已经生成的 token 照样计费）。
     * 估算值带 estimated 标记，控制台对「含估算」的行单独提示，不会被当成真实账单。
     */
    if (req.userId && !recorded && (full.length >= 20 || reasoningFull.length >= 20)) {
      await recordOnce(estimateUsageFromMessages(messages, full, reasoningFull), true);
    }
  }
}

/**
 * 创建「任意 OpenAI 兼容后端」客户端（双分支模型路由用：中文 / 英文各一套第三方模型）。
 * 强制 isDeepSeek=false，第三方托管不认 DeepSeek 专有字段（thinking / user_id / stream_options），
 * 必须走条件化分支，否则会直接 400。
 */
export function createCompatClient(cfg: Omit<ProviderConfig, 'isDeepSeek'>): any {
  // flatRate 缺省 true：第三方托管基本都按订阅制（并发单元 / 月费）卖，token 不单独出账。
  // 只有显式传 false 才按量计费（roleplayModel 会按该分支的 *_FLAT_RATE 决定）。
  const resolved: ProviderConfig = { ...cfg, isDeepSeek: false, flatRate: cfg.flatRate !== false };
  return {
    models: {
      generateContent: (req: GenerateContentRequest) => generateContent(req, resolved),
      generateContentStream: (req: GenerateContentRequest, onToken?: (delta: string) => void, signal?: AbortSignal) =>
        generateContentStream(req, onToken, signal, resolved)
    }
  };
}

/**
 * 创建 DeepSeek 客户端（兼容 @google/genai 的调用形态）
 * 保持无参签名不变：现有调用方（gemini / textgame / werewolf / scenarioGenerator 等）行为零变化。
 */
export function createDeepSeekClient(): any {
  return {
    models: {
      generateContent,
      generateContentStream
    }
  };
}
