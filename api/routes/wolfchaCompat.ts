/**
 * wolfcha 兼容层：`POST /api/chat`
 *
 * 上游 `src/wolfcha/lib/llm.ts` 把每一次模型调用都打到**它自己服务端**的 `/api/chat`
 * （由那边代理 Bailian / Dashscope / TokenDance 并持有密钥）。小愈不使用它的密钥通道，
 * 因此这里按**上游完全相同的契约**实现这条路由，统一转发到小愈自己的 DeepSeek——
 * 密钥只存在于服务端（`DEEPSEEK_API_KEY`），前端拿不到。
 *
 * 契约（来自 `vendor/wolfcha/src/lib/llm.ts` 与 `src/types/game.ts` 的 `ChatCompletionResponse`）：
 *   请求：{ model, messages: [{role, content}], temperature?, max_tokens?, reasoning?, reasoning_effort? }
 *   响应：{ choices: [{ message: { content, reasoning_details? } }], usage: { prompt_tokens,
 *           completion_tokens, prompt_cache_hit_tokens?, prompt_cache_miss_tokens?,
 *           prompt_tokens_details?: { cached_tokens } } }
 *
 * DeepSeek 的 `/chat/completions` 本身就是这个形状（且会返回 `prompt_cache_hit_tokens`，
 * 上游正是靠它统计前缀缓存命中），所以直接把上游响应透传即可，不做二次加工。
 *
 * ⚠️ 说明：请求里的 `model` 字段被**有意忽略**——上游让每个 AI 玩家用不同模型，
 * 而小愈统一走自己的模型；差异由角色人格承担，不由模型承担。
 */

import { Router, type Request, type Response } from 'express';
import { safeError } from '../services/safeError.js';
import { resolveUserId } from '../services/session.js';
import { checkContentSafety } from '../services/safety.js';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import {
  WEREWOLF_DAILY_LIMIT,
  WEREWOLF_FREE_DAILY_LIMIT,
  WEREWOLF_PLUS_DAILY_LIMIT,
  UNIT_CREDIT,
  FREE_DAILY_CREDIT,
  GUEST_DAILY_CREDIT,
  REGISTER_CHAT_BONUS_COUNT,
  estimateCreditFromTokens,
  estimateTextTokens,
  quotaStore,
  WEREWOLF_GAME_TIAO,
  roundCreditToTiao,
  floorCreditToTiao,
} from '../services/quota.js';
import { werewolfCounters } from '../services/werewolf.js';
import { werewolfLedger } from '../services/werewolfLedger.js';
import { usageStore } from '../services/usage.js';
import { activityStore, isTestRequest } from '../services/activity.js';
import { getClientCountry, getClientIp } from '../services/geo.js';

const router = Router();

// ---------------------------------------------------------------------------
// 计费与用量（接入小愈既有的 quota 口径，替换掉 A 方案的「旁路」）
// ---------------------------------------------------------------------------

/**
 * 每用户每日开局次数（按小愈档位：免费 / Plus / Pro）。
 * 与自研引擎同一套常量（`WEREWOLF_*_DAILY_LIMIT`），保证两种实现口径一致。
 */
interface DailyGames {
  day: string;
  games: number;
}
/**
 * 一局狼人杀的**预估**消耗（用于开局准入与顶栏展示；实际扣费按真实 token 逐次结算）。
 *
 * 依据**实测数据**得出的 20 次 / 40 点，而不是拍脑袋：
 *  - 每次模型调用实测 ≈ 342 输入 + 359 输出 token（66 次真实调用统计）；
 *  - 按小愈定价（输入 2 元/百万、输出 8 元/百万）成本 ≈ 0.0036 元 = 0.36 点，
 *    但 `estimateCreditFromTokens` 有「最低 1 点」规则 → **实际计 1 点/调用**
 *    （与实测锚点吻合：1 次调用使 creditUsedToday +1）；
 *  - 一局调用次数：开局生成 10 个人设 4 次（实测）+ 每夜约 4 次 + 每天约 10 次，
 *    通常 2~3 个昼夜 → ≈32~46 次，取中位 40 次；
 *  - 故 40 × 1 点 = **40 点 ≈ 20 次**。
 *
 * 为什么不用「5 次」：那只有真实消耗的 1/4，用户会被放进来、玩到一半点数耗尽卡在对局中，
 * 比开局就拦住更糟。
 */
const CREDIT_PER_GAME_ESTIMATE = WEREWOLF_GAME_TIAO * UNIT_CREDIT; // 单源：quota.ts 的 WEREWOLF_GAME_TIAO

/**
 * 开局**最低**要求：只够发 1 条消息（1 次 = UNIT_CREDIT 点）。
 *
 * 计费口径按用户要求改为「**按平均局数摊到每条消息**」：
 *   一局 ≈ 40 条消息 ≈ 40 点 ≈ 20 次 → **每条消息 ≈ 1 点**
 * 因此开局**不做任何预扣**（下面只是 reserve→rollback 的探测，立刻归还），
 * 真正的扣费发生在每条消息上（见 chargeUsage，按真实 token 逐次结算）。
 * 门槛设成「至少 1 条消息的钱」即可，不再要求"攒够一整局"——那会让免费用户
 * （每日 30 点）被挡在门外，也违背"逐条计费"的本意。
 */
/**
 * 开局准入 = **一局的预估消耗**，但对免费档只要求「够预扣他今天剩下的额度」。
 *
 * 口径（统一账本 §4.3④）：额度在**开局时**做准入，**局内不打断**——
 * 以前的准入只有 1 条（`1 × UNIT_CREDIT`），于是免费档会出现"开得起来、打到一半没额度"
 * （虽然 `chargeUsage` 扣不动不中断，但用户以为还能再开一局，体验与口径都对不上）。
 */
const MIN_START_CREDIT = Math.min(CREDIT_PER_GAME_ESTIMATE, FREE_DAILY_CREDIT);

/**
 * ── A′ 计费模型（2026-09-17 用户拍板）：**按局预扣 → 局内余额不动 → 局终/退出按真实消耗结算** ──
 *
 * 为什么不是「每次模型调用扣一次」（旧行为，已废弃）：
 *  - 一局里 90%+ 的调用是 **AI 侧**产生的（10 个 AI 每轮各说一句 + 夜间结算 + 投票），
 *    用户**没说话的时候余额也在往下掉** → 必然收到「我没发消息为什么扣我钱」；
 *  - 用户也无法预知要花多少，玩完才发现今天额度没了。
 *
 * A′ 的规则（**余额只在两个时点变动**）：
 *  1. **开局**预扣 `min(一局价 40 条, 当前可用额度)`；不够 `MIN_START_CREDIT` 就直接拦住并说明；
 *     —— 免费档照旧放行（可用 20 条即可开局），差额由平台吸收，这是刻意的引流成本。
 *  2. **局内**只把真实消耗记到本局账上（`usedCredit`），**不碰余额**；页面显示「本局已用约 X 条」。
 *  3. **结算**（局终、中途退出、或 10 分钟无调用、或下一局开局时）按 `min(真实消耗, 预扣)` 结算：
 *     真实 < 预扣 → **退回差额**；真实 > 预扣 → **不再补收**（平台吸收）。
 *     结算结果写进 `lastSettlement`，由 `/credits/balance` 回给前端提示「本局实际 X 条，已退回 Y 条」。
 *
 * 进程重启会让内存里的预留令牌消失（`creditReservations` 是内存态）：此时退款走 `addCreditBonus`
 * 兜底——金额一致，只是退回点数进「赠送」而非「当日」，用户不吃亏。
 */
const GAME_CHARGE_FILE = dataFile('werewolf-game-charge.json');
const SETTLE_IDLE_MS = 10 * 60 * 1000; // 10 分钟没有模型调用 = 这局结束了（或用户退出了）

interface ActiveGameCharge {
  token: string | null;   // quotaStore 的预留令牌（重启后为 null）
  reserved: number;       // 开局预扣的点数（0 = 额度不足一局价，改为局后结算）
  used: number;           // 本局真实消耗（累计）
  cap: number;            // 局后结算的扣除上限（= 开局时的可用额度；预扣模式下等于 reserved）
  startedAt: number;
  lastAt: number;
}
interface GameChargeState {
  active: Record<string, ActiveGameCharge>;
  lastSettlement: Record<string, { used: number; reserved: number; refunded: number; at: number }>;
}
const chargeState: GameChargeState = readJson<GameChargeState>(GAME_CHARGE_FILE, { active: {}, lastSettlement: {} }) || { active: {}, lastSettlement: {} };
chargeState.active = chargeState.active || {};
chargeState.lastSettlement = chargeState.lastSettlement || {};
let lastPersistAt = 0;
function persistCharge(force = false): void {
  const now = Date.now();
  if (!force && now - lastPersistAt < 3000) return; // 局内每次调用都写盘太重，3 秒节流
  lastPersistAt = now;
  try { writeJson(GAME_CHARGE_FILE, chargeState); } catch (e) { console.warn('[wolfcha-compat] 局账持久化失败：', (e as Error)?.message); }
}

/** 结算某一局（幂等）：退回 min(真实,预扣) 与预扣之间的差额 */
function settleGame(userId: string, reason: string): void {
  const g = chargeState.active[userId];
  if (!g) return;
  delete chargeState.active[userId];
  // 真实消耗**四舍五入到整条**再扣：多退少补照旧，但账本只认整条（余量恒为整数条 → 前端不必再写「≈」）
  const charge = Math.max(0, Math.min(roundCreditToTiao(g.used), g.reserved));
  const refund = Math.max(0, g.reserved - charge);
  if (g.token) {
    quotaStore.settleCredit(userId, g.token, charge); // 预扣模式：多退少补（这里只会退差额）
  } else if (g.reserved > 0) {
    // ⚠️ 用 refundCreditBonus 而**不是** addCreditBonus：这是退款，不是发放。
    // `addCreditBonus` 会计入「累计获得」，而控制台的「赠送已用 = 累计 − 余额」——
    // 退款算成发放会让累计虚高、已用虚低（2026-09-29 修，见 quota.ts 两个方法的注释）。
    quotaStore.refundCreditBonus(userId, refund, 'werewolf-refund'); // 重启兜底：预留令牌已随内存丢失
  } else {
    /**
     * **局后结算模式**（免费档：可用额度不足一局价 → 开局不预扣，余额在局内保持不动）：
     * 结算时按真实消耗扣，**上限 = 开局时的可用额度**（超出的部分平台吸收），且不超过"此刻还剩多少"
     * （用户可能在对局期间又去聊了几句）。
     */
    const nowRemain = Math.max(0, quotaStore.getCreditQuota(userId).creditRemain ?? 0);
    // 上限也一律向下对齐到整条（cap = 开局时的可用额度；历史残差也一并取整，绝不超扣）
    const toCharge = Math.min(roundCreditToTiao(g.used), floorCreditToTiao(g.cap), floorCreditToTiao(nowRemain));
    if (toCharge > 0) {
      const r = quotaStore.reserveCredit(userId, 'werewolf', { credit: toCharge });
      if (r.ok && r.token) quotaStore.settleCredit(userId, r.token, toCharge);
    }
    chargeState.lastSettlement[userId] = { used: toCharge, reserved: 0, refunded: 0, at: Date.now() };
    persistCharge(true);
    console.log(`[wolfcha-compat] 结算(${reason}) user=${userId.slice(0, 8)} 局后结算 实耗${toCharge}点（上限${g.cap}点）`);
    return;
  }
  chargeState.lastSettlement[userId] = { used: charge, reserved: g.reserved, refunded: refund, at: Date.now() };
  persistCharge(true);
  console.log(`[wolfcha-compat] 结算(${reason}) user=${userId.slice(0, 8)} 预扣${g.reserved}点/实耗${charge}点/退回${refund}点`);
}

/** 懒结算：超过 SETTLE_IDLE_MS 没有调用，认为这局已结束 */
function settleIfIdle(userId: string): void {
  const g = chargeState.active[userId];
  if (g && Date.now() - g.lastAt > SETTLE_IDLE_MS) settleGame(userId, 'idle');
}

const GAMES_FILE = dataFile('wolfcha-games.json');
const dailyGames = readJson<Record<string, DailyGames>>(GAMES_FILE, {}) || {};

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function _dailyLimitFor(userId: string): number {
  const plan = quotaStore.planOf(userId);
  if (plan === 'pro') return WEREWOLF_DAILY_LIMIT;
  if (plan === 'plus') return WEREWOLF_PLUS_DAILY_LIMIT;
  return WEREWOLF_FREE_DAILY_LIMIT;
}

/** 剩余点数折算成「次数」（1 次 = UNIT_CREDIT 点） */
/**
 * 余额换算成「条」。**返回 `null` = 无限档（Pro）**。
 *
 * ⚠️ 2026-09-17 修的坑：`getCreditQuota()` 对 Pro 返回 `creditRemain: null`（无限不能用 Infinity
 * 表达——JSON 会变 null、前端 `?? 0` 会当成「剩余 0」）。这里原来把 null 直接当 0，
 * 于是 **Pro 用户在狼人杀顶栏看到「剩余 0 条」**，以为没额度了。现在把无限单独表达出来。
 */
function creditsToUses(userId: string): number | null {
  try {
    const q = quotaStore.getCreditQuota(userId) as { creditRemain?: number | null; unlimited?: boolean } | undefined;
    if (q?.unlimited) return null; // 无限档
    const remain = typeof q?.creditRemain === 'number' ? q.creditRemain : 0;
    return Math.max(0, Math.floor(remain / UNIT_CREDIT));
  } catch {
    return 0;
  }
}

function _gamesToday(userId: string): number {
  const rec = dailyGames[userId];
  return rec && rec.day === todayKey() ? rec.games : 0;
}

function _countGameStart(userId: string): void {
  const day = todayKey();
  const rec = dailyGames[userId];
  dailyGames[userId] = rec && rec.day === day ? { day, games: rec.games + 1 } : { day, games: 1 };
  try {
    writeJson(GAMES_FILE, dailyGames);
  } catch {
    /* 计数落盘失败不阻断开局 */
  }
}

/** 从 OpenAI 兼容响应里取 usage（流式为最后一帧，非流式在顶层） */
function usageOf(json: unknown): { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens: number } } | null {
  if (!json || typeof json !== 'object') return null;
  const u = (json as {
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
      prompt_cache_hit_tokens?: number; // DeepSeek 原生字段（老式回传）
    };
  }).usage;
  if (!u || typeof u.prompt_tokens !== 'number') return null;
  const cached = Number(u.prompt_tokens_details?.cached_tokens || u.prompt_cache_hit_tokens || 0);
  return {
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens || 0,
    // 缓存命中价只有输入价的约 3%：带上它，否则命中部分会被按全价记账（成本虚高）
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  };
}

/**
 * 把这次调用的成本记进「API 成本」账本（运营端可见）。
 *
 * 为什么需要：这条路由是**自己 fetch DeepSeek** 的旁路（移植版狼人杀走这里），
 * 以前只扣用户点数 + 进 werewolfCounters，**从不写 usageStore** →
 * 一局 10 人局几十次调用（max_tokens ≥ 8192）在控制台的 API 成本里显示为 0 元。
 * 自研引擎（api/services/werewolf.ts）走 client.models.generateContent 已自带记账，
 * 两边各记**自己真实发生的调用**，不存在重复计费。
 */
function recordCost(userId: string, u: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens: number } } | null): void {
  if (!u || (!u.prompt_tokens && !u.completion_tokens)) return;
  try {
    usageStore.record(userId, u, 'werewolf');
  } catch (e) {
    console.warn('[wolfcha-compat] 成本记账失败:', (e as Error)?.message);
  }
}

/**
 * 按**真实用量**扣点：reserve 后立刻 settle 同额（等于一次净扣款）。
 * 与自研引擎同一个换算函数（`estimateCreditFromTokens`），所以两边的「点数」含义一致。
 * 扣不动（余额不足）时不阻断本次调用——对局已在进行，中断体验更差；只记日志，由开局闸门控总量。
 */
/**
 * `preToken` = 无对局时由准入闸门预留的点数令牌（见 /chat handler）。
 * 有令牌就按**真实用量**结算它（多退少补），避免「先预扣一次、再逐次扣一次」的重复计费。
 * @returns true 表示令牌已被消费（调用方不必再回滚）
 */
function chargeUsage(userId: string, prompt: number, completion: number, preToken?: string | null): boolean {
  if (process.env.WEREWOLF_COUNTERS_DISABLED === '1') return false;
  const credit = Math.max(1, estimateCreditFromTokens(prompt, completion));
  // A′：有在进行的局 → 只记账，**不动余额**（局终/退出时统一结算）
  settleIfIdle(userId);
  const g = chargeState.active[userId];
  if (g) {
    g.used += credit;
    g.lastAt = Date.now();
    persistCharge();
    return false;
  }
  // 无对局：优先结算准入闸门预留的令牌（按真实用量，多退少补）
  if (preToken) {
    quotaStore.settleCredit(userId, preToken, credit);
    return true;
  }
  // 没有开局记录且没有令牌（历史遗留调用）→ 退回逐次扣费，保证不漏收
  const r = quotaStore.reserveCredit(userId, 'werewolf', { credit });
  if (r.ok && r.token) quotaStore.settleCredit(userId, r.token, credit);
  else console.warn('[wolfcha-compat] 扣点失败（余额不足？）userId=', userId, 'credit=', credit, r.reason);
  return false;
}

const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const MAX_TOKENS = Number(process.env.DEEPSEEK_MAX_TOKENS || 8192);
const TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS || 60000);
/**
 * 无对局直连 `/api/chat` 的准入下限（单位：点；1 条 = UNIT_CREDIT 点）。
 * 只负责拦住「余额为 0 也能无限调用」，不承担精确计费（精确计费在 chargeUsage）。
 */
const DIRECT_CALL_MIN_CREDIT = Math.max(1, UNIT_CREDIT);

router.post('/chat', async (req: Request, res: Response): Promise<void> => {
  const body = (req.body || {}) as {
    messages?: Array<{ role: string; content: unknown }>;
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
    /** 决定模型必须输出 JSON —— 漏转发它，上游的 generateCharacters 就会拿到散文并报 invalid JSON */
    response_format?: { type: string; json_schema?: unknown };
    /** 推理强度（DeepSeek 支持 minimal|low|medium|high） */
    reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
    /** 仅供上游服务端做前缀缓存分区，我们不需要 */
    prompt_scope?: string;
  };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  // 上游对局里部分调用（如开局生成 AI 玩家）是**流式**的，必须原样支持：
  // 写死 stream:false 会让它的解析器收不到 [DONE]，报「模型流式响应在 [DONE] 前意外结束」。
  const wantStream = body.stream === true;

  /**
   * DeepSeek 的硬性要求：使用 `response_format: {type:'json_object'}` 时，
   * **提示词里必须出现 "json" 这个词**，否则直接 400：
   *   "Prompt must contain the word 'json' in some form to use 'response_format' of type 'json_object'."
   * 上游的提示词是给它自己那些 provider（Bailian/Dashscope/TokenDance）写的，不保证含该词，
   * 所以适配责任在我们这一侧：缺了就补一条明确的 JSON 指令（同时也强化了输出契约）。
   */
  const outMessages = messages.slice();

  /**
   * `response_format` 的等价降级（实测踩坑）：
   *  - 上游**几乎每个游戏决策**都用 `{type:'json_schema', json_schema:{...}}`（结构化输出，
   *    见其 `structuredResponseFormat` / `seatSelectionResponseFormat`）；
   *  - 而 DeepSeek **不支持 json_schema**，直接 400：`This response_format type is unavailable now`；
   *  - DeepSeek 支持的是 `{type:'json_object'}`（且要求提示词里出现 "json" 一词）。
   *
   * 因此把 json_schema **降级**为 json_object，并把 schema 原文作为指令注入提示词——
   * 既保住「API 强制合法 JSON」，又把字段形状交代给模型（上游的解析器再兜一层容错）。
   */
  const rf = body.response_format;
  let effectiveResponseFormat: { type: string } | undefined;
  if (rf?.type === 'json_schema') {
    effectiveResponseFormat = { type: 'json_object' };
    const schemaText =
      typeof rf.json_schema === 'object' && rf.json_schema
        ? JSON.stringify(rf.json_schema)
        : String(rf.json_schema ?? '');
    outMessages.unshift({
      role: 'system',
      content:
        'You must reply with ONE valid JSON object only — no prose, no markdown fences.\n' +
        'It must match this JSON Schema exactly (same field names):\n' +
        schemaText.slice(0, 4000),
    });
  } else if (rf?.type === 'json_object') {
    effectiveResponseFormat = { type: 'json_object' };
  } else if (rf?.type) {
    console.warn('[wolfcha-compat] 无法识别的 response_format 类型，已忽略：', rf.type);
  }

  // DeepSeek 的硬性要求：用 json_object 时提示词里必须出现 "json"，否则 400。
  if (effectiveResponseFormat?.type === 'json_object') {
    const hasJsonWord = outMessages.some((m) => typeof m.content === 'string' && /json/i.test(m.content));
    if (!hasJsonWord) {
      outMessages.unshift({
        role: 'system',
        content: 'Reply with one valid JSON object only. 只输出一个合法的 JSON 对象。',
      });
    }
  }

  if (messages.length === 0) {
    // 🔍 常驻诊断（仅在异常路径打印，噪音极低）：对局中偶发过空 messages 请求（400），复现不稳定，保留线索供下次自动定位。
    console.warn('[ww-diag] 空 messages 请求:', JSON.stringify({
      max_tokens: body.max_tokens,
      hasResponseFormat: !!body.response_format,
      keys: Object.keys(body),
      stream: body.stream,
    }));
    res.status(400).json({ success: false, error: 'messages 不能为空' });
    return;
  }
  // 身份由小愈的适配层注入（X-Device-Id / Authorization），与自研引擎同一套认人逻辑
  const userId = resolveUserId(req);

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    res.status(500).json({ success: false, error: 'DEEPSEEK_API_KEY 未配置' });
    return;
  }

  /**
   * 准入闸门（2026-09-28 审查 B1）：`/api/chat` 挂在裸 `/api` 上、**无需登录**（游客按设备身份即可），
   * 而 chargeUsage 的设计是「扣不动也不阻断本次调用」——这对**局内**调用是合理的（开局闸门已按局预扣），
   * 但对「没有进行中的局」的直连调用就等于：余额为 0 也能无限消耗 DeepSeek（平台白送成本）。
   * 所以：没有进行中的局时，先按单次最低成本**原子预留**点数；扣不动直接 402，根本不发上游请求。
   * 令牌交给 chargeUsage 按真实用量结算（多退少补）；任何提前返回/异常都在 finally 里回滚。
   */
  let gateToken: string | null = null;
  if (!chargeState.active[userId] && process.env.WEREWOLF_COUNTERS_DISABLED !== '1') {
    const pre = quotaStore.reserveCredit(userId, 'werewolf', { credit: DIRECT_CALL_MIN_CREDIT });
    if (!pre.ok || !pre.token) {
      res.status(402).json({
        success: false,
        error: '点数不足，无法继续本局',
        code: 'QUOTA_EXCEEDED',
        data: { quota: quotaStore.getCreditQuota(userId) },
      });
      return;
    }
    gateToken = pre.token;
  }

  const payload: Record<string, unknown> = {
    model: MODEL,
    messages: outMessages,
    stream: wantStream,
    /**
     * token 预算：取「上游值」与「我们的下限」的较大者（下限 = DEEPSEEK_MAX_TOKENS，默认 8192）。
     *
     * 实测教训（两个方向都试过）：
     *  - 抬到 8192：模型写更多、更慢（8192→2216 token/9.8s vs 3750→1459/6.2s）；
     *  - 只尊重上游值 3750：**人设批次被截断** → JSON 不合法 → 上游报
     *    `Character batch N returned invalid schema` / `invalid persona` → **开局直接失败**。
     * 正确性优先：给足余量。而自从 `reasoning_effort='none'` 生效后，
     * 预算不再被推理挤占，所以同样 8192 的预算下，内容质量与耗时都优于当初。
     */
    max_tokens: Math.max(typeof body.max_tokens === 'number' ? body.max_tokens : 0, MAX_TOKENS),
  };
  if (typeof body.temperature === 'number') payload.temperature = body.temperature;
  // ⚠️ 这两个字段**必须**转发（血泪教训）：
  //   - response_format=json_object：上游开局生成 AI 玩家/角色时要求模型输出 JSON，
  //     丢掉它模型会返回散文，上游 `Character batch 0 returned invalid JSON` 直接中止开局；
  //   - reasoning_effort：控制推理强度，影响耗时与成本。
  if (effectiveResponseFormat) payload.response_format = effectiveResponseFormat;
  /**
   * 🔴 **流式也必须带回 usage**（2026-09-17 实测发现的口子）：
   * OpenAI 兼容协议里，流式响应**默认不回传 usage**——必须显式请求
   * `stream_options: { include_usage: true }`，上游才会在最后一帧带上 `usage`。
   *
   * 不加的后果（实测）：一局狼人杀里**拦截到 34 次 `/api/chat`，只有 15 次产生计费**
   * （`chargeUsage` 只在解析到 usage 时才扣）→ 约一半调用**没向用户收费**、成本由平台吸收，
   * 而狼人杀绝大多数调用恰恰是 AI 发言这类**流式**请求。
   */
  if (wantStream) payload.stream_options = { include_usage: true };
  /**
   * 推理开销默认压到最低（可被上游显式值覆盖）。
   *
   * 原因：DeepSeek 是推理模型，默认会先长篇推理再输出；而狼人杀每一轮都要等一句
   * 「发言/投票/夜间动作」，推理既拖慢首字（会撞上客户端 45 秒的流式空闲超时）
   * 又推高成本。上游的提示词已经把要什么写得很死（JSON schema + 规则），
   * 所以这里默认 `minimal`，需要更高质量时可用 `reasoning_effort` 显式覆盖。
   */
  /**
   * 推理默认**关闭**（用户可显式覆盖）。
   *
   * 实测数据（同一个角色生成请求）：
   *   reasoning_effort='minimal' → 6.2s，reasoning 2847 字符（**该参数被忽略**）
   *   reasoning_effort='none'    → 2.0s，reasoning **0** 字符，输出仍是合法 JSON
   * 狼人杀每一轮只等一句发言/一个动作，推理纯属延迟与成本；上游的提示词已把要什么写得很死。
   * 关掉后：开局"准备开始"从 ~24 秒降到几秒，而且 token 预算不再被推理挤占（截断问题一并消失）。
   */
  /**
   * 推理开关：**按请求类型分别处理**（有实测依据的取舍）
   *
   *  - 带 `response_format` 的请求 = 上游的**结构化生成**（角色人设批次、投票等），
   *    要求严格遵循 JSON Schema。实测关掉推理后这类请求会偶发返回坏结构：
   *    `Character batch N returned invalid schema` / `invalid persona` / `length mismatch`
   *    —— 表现为**偶发开局失败**，对用户不可接受 → 这类**保留推理**（宁慢不错）。
   *  - 其余请求 = 对局内的单句发言/单个动作，输出短、Schema 宽松。
   *    实测 `reasoning_effort: 'none'` 把单次从 6.2s 降到 2.0s 且输出仍是合法 JSON → **关推理**。
   *
   * 档位实测定论（同一开局，四次对照）：
   *   structured='none'    → 23.7s 但**偶发坏 JSON**（Character batch N invalid schema → 开局失败）
   *   structured='minimal' → 36.9s 稳定 ✓（当前采用）
   *   structured='low'     → 40.9s（**并不更快**，实测排除）
   *   上游传进来的 reasoning_effort 一律忽略（它的配置来自自家模型目录，对我们不适用）。
   *
   * 结论：推理档位这条路的收益只来自 'none'，而它牺牲的是开局可靠性 —— 不值。
   * 真正的加速点在于**少生成人设**（已选角色应跳过对应座位），已记入待办。
   */
  payload.reasoning_effort = 'none';
  if (body.reasoning_effort) payload.reasoning_effort = body.reasoning_effort;

  try {
    const upstream = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!upstream.ok) {
      // 不把上游原文直接抛给前端（可能含敏感信息），只留短摘要便于排查
      const errText = await upstream.text();
      res.status(502).json({
        success: false,
        error: `模型上游返回 ${upstream.status}`,
        detail: errText.slice(0, 300),
      });
      return;
    }

    // —— 流式：上游要求 SSE（`data: {...}` 分块 + `data: [DONE]` 结尾），必须原样直通 ——
    // 否则它的解析器收不到 [DONE]，会报「模型流式响应在 [DONE] 前意外结束」而中止开局。
    if (wantStream) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // 让 nginx/CF 不缓冲，保证逐块下发
      const anyRes = res as unknown as { flushHeaders?: () => void };
      if (typeof anyRes.flushHeaders === 'function') anyRes.flushHeaders();

      /**
       * SSE 心跳：上游客户端有 `STREAM_IDLE_TIMEOUT_MS = 45_000`（流式空闲 45 秒即中止）。
       * DeepSeek 是推理模型，大上下文（夜间行动要带上整局上下文）下**首字延迟可能超过 45 秒**，
       * 客户端就会主动断流，表现为 `ERR_CONNECTION_RESET`、对局卡在夜里不再推进。
       * 因此先立刻发一帧、之后每 10 秒补一帧 SSE 注释行（`: ...`），让客户端始终认为连接是活的。
       */
      res.write(': keep-alive\n\n');
      const keepAlive = setInterval(() => {
        try {
          res.write(': keep-alive\n\n');
        } catch {
          /* 连接已断，忽略 */
        }
      }, 10_000);

      const reader = upstream.body?.getReader();
      if (!reader) {
        clearInterval(keepAlive);
        res.end();
        return;
      }
      let streamTail = ''; // 保留尾部文本用于解析流式 usage
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            const chunk = Buffer.from(value);
            // 顺带留一份尾部文本：流式的 usage 在最后一帧（`data: {...usage...}`）
            streamTail = (streamTail + chunk.toString('utf8')).slice(-4000);
            res.write(chunk);
          }
        }
      } finally {
        clearInterval(keepAlive);
        res.end();
      }
      // 流式同样计费 + 计入运营端（usage 只在末尾帧出现，所以放到流结束后处理）
      if (streamTail) {
        const m = streamTail.match(/"usage"\s*:\s*\{[^}]*\}/g);
        let u: ReturnType<typeof usageOf> = null;
        if (m && m.length) {
          try {
            u = usageOf(JSON.parse(`{${m[m.length - 1]}}`));
          } catch {
            u = null;
          }
        }
        /**
         * 兜底（2026-09-17）：上游若仍未回传 usage（换模型、代理降级、被截断），
         * **按文本长度估算**后照扣——宁可估得粗，也不能静默不计费（那是平台白送成本）。
         * 估算口径与主链路一致（`estimateTextTokens`）。
         */
        if (!u) {
          const promptEst = estimateTextTokens(outMessages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''))).join(' '));
          const completionEst = estimateTextTokens(streamTail.replace(/\s+/g, ' ').slice(-4000));
          u = { prompt_tokens: promptEst, completion_tokens: completionEst };
          console.warn('[wolfcha-compat] 流式响应没有 usage，按估算计费：prompt≈' + promptEst + ' completion≈' + completionEst);
        }
        if (u && chargeUsage(userId, u.prompt_tokens, u.completion_tokens, gateToken)) gateToken = null;
        recordCost(userId, u); // 运营端 API 成本（此前这条旁路完全不入账）
        werewolfCounters.recordUsage({
          calls: 1,
          promptTokens: u?.prompt_tokens ?? 0,
          completionTokens: u?.completion_tokens ?? 0,
          fallbackEvents: 0,
        });
      }
      return;
    }

    // —— 非流式：透传上游 OpenAI 兼容响应（choices + usage，含缓存命中字段） ——
    const text = await upstream.text();
    // 计费与运营端计数都按**真实 usage**（与自研引擎同一换算口径）
    let u: ReturnType<typeof usageOf> = null;
    try {
      u = usageOf(JSON.parse(text));
    } catch {
      u = null;
    }
    if (u && chargeUsage(userId, u.prompt_tokens, u.completion_tokens, gateToken)) gateToken = null;
    recordCost(userId, u); // 运营端 API 成本（此前这条旁路完全不入账）
    werewolfCounters.recordUsage({
      calls: 1,
      promptTokens: u?.prompt_tokens ?? 0,
      completionTokens: u?.completion_tokens ?? 0,
      fallbackEvents: 0,
    });
    res.type('application/json').send(text);
  } catch (error) {
    if (res.headersSent) {
      // 流已经开始下发，只能断流（前端会按「提前结束」处理）
      res.end();
      return;
    }
    const aborted = error instanceof Error && error.name === 'TimeoutError';
    res.status(aborted ? 504 : 502).json({
      success: false,
      error: aborted ? '模型响应超时' : safeError('ai', error),
    });
  } finally {
    // 准入令牌没被 chargeUsage 消费掉（提前返回 / 上游报错 / 客户端断开）→ 必须回滚，
    // 否则一次失败调用会把用户额度白扣掉（2026-09-28 审查 B1）。
    if (gateToken) {
      try { quotaStore.rollbackCredit(userId, gateToken); } catch { /* 忽略 */ }
    }
  }
});

/**
 * Watcha Pay（韩国第三方支付通道）—— 小愈不使用它。
 *
 * 上游会在进入计费相关界面时探测 `access`，用来决定是否展示 Watcha 购买入口。
 * 我们既不接该通道，就返回 200 + `access:'unavailable'`，让它走**自己已有的**
 * 「不可用」分支 —— 比 404 干净（404 会在 console 里留下报错，也会误导排查）。
 */
router.get('/watcha-pay/access', (_req: Request, res: Response): void => {
  res.json({ access: 'unavailable', purchaseUrl: null });
});

/**
 * 余量查询（口径 = 今日还可开的局数，与开局闸门完全一致）。
 *
 * 上游客户端本来用 **Supabase 直查** `user_credits` 拿这个数；小愈不使用 Supabase，
 * 因此客户端 `fetchCredits` 已改为调这条路由（见 hooks/useCredits.ts 的移植注释）。
 * 不实现它的话，顶栏会一直显示「0 games remaining」，让用户误以为没额度了。
 */
router.get('/credits/balance', (req: Request, res: Response): void => {
  const userId = resolveUserId(req);
  res.json({
    success: true,
    // 展示**次数**（与用户口径一致）：免费档 30 点 = 15 次。
    // 不用「局数」是因为免费档只有 0.75 局，取整会显示 0，反而误导"没额度了"。
    credits: creditsToUses(userId), // null = 无限（Pro）
    unlimited: !!quotaStore.getCreditQuota(userId)?.unlimited,
    plan: quotaStore.planOf(userId),
    perGameCredit: CREDIT_PER_GAME_ESTIMATE,
    unitCredit: UNIT_CREDIT,
    // A′：一局价（条）+ 本局进行中的已用量 + 上一局结算回执（前端据此提示）
    // 进行中的已用量仍给一位小数（"已经用了 12.4 条"是过程读数，不落账本）；结算回执已是整条
    gameEstimateTiao: Math.round(CREDIT_PER_GAME_ESTIMATE / UNIT_CREDIT),
    /**
     * 开局**准入下限**（条）= `MIN_START_CREDIT`（= min(一局价, 免费档日额度)）。
     * 前端据此**提前**判断"这局开不了"并走统一额度门控（游客→注册 / 已注册→获取额度 / Plus→升级），
     * 而不是先发一个注定 402 的请求再弹通用失败提示（2026-09-27 用户拍板 B）。
     */
    minStartTiao: Math.round(MIN_START_CREDIT / UNIT_CREDIT),
    activeGameTiao: chargeState.active[userId]
      ? Math.round((chargeState.active[userId].used / UNIT_CREDIT) * 10) / 10 // 一位小数：小额也看得见
      : null,
    lastSettlementTiao: chargeState.lastSettlement[userId]
      ? {
        used: Math.round(chargeState.lastSettlement[userId].used / UNIT_CREDIT),
        refunded: Math.round(chargeState.lastSettlement[userId].refunded / UNIT_CREDIT),
        at: chargeState.lastSettlement[userId].at,
      }
      : null,
  });
});

router.post('/credits/consume', (req: Request, res: Response): void => {
  const userId = resolveUserId(req);

  /**
   * ⚠️ 计费口径（A′，2026-09-17 用户拍板）：**开局预扣一局价 → 局内余额不动 → 局终/退出结算**。
   * 预扣额 = `min(一局价 40 条, 当前可用额度)`：免费档可用 20 条即可开局（照旧放行），差额平台吸收；
   * 局内每次调用只累加到本局账上（见 chargeUsage），余额只在开局与结算两个时点变动。
   */
  settleIfIdle(userId);
  if (chargeState.active[userId]) settleGame(userId, 'new-game'); // 上一局没结算就开新的 → 先结掉
  const cq = quotaStore.getCreditQuota(userId);
  const isUnlimited = !!cq.unlimited;
  const avail = isUnlimited ? CREDIT_PER_GAME_ESTIMATE : Math.max(0, cq.creditRemain ?? 0);
  /**
   * 开局被拦时的**可执行**回应（2026-09-27 用户拍板 B：「注册才能玩」+ 拦截改成注册引导）。
   *
   * 分两种人说清两件不同的事——这不是文案口味问题，而是**用户要采取的动作完全不同**：
   *  - 游客（非注册账号）：额度档位本身不够开一局（游客 5 条 < 准入 20 条）⇒ 出路是**注册**；
   *  - 注册账号：今天用完了 ⇒ 出路是**等明天自动恢复 / 获取更多额度 / 升级会员**。
   * 前端据 `reason` / `registerHint` 走统一额度门控（`xiaoyu:quota-exhausted`，Home 决定弹哪个）。
   */
  const gateBlock = (detail: string) => {
    const isGuest = !quotaStore.isRegisteredAccount(userId);
    const needTiao = Math.round(MIN_START_CREDIT / UNIT_CREDIT);
    const haveTiao = Math.floor(avail / UNIT_CREDIT);
    // 档位数字**全部从 quota.ts 的常量取**，不在这里写死 5 / 20（改 .env 文案自动跟着变）
    const guestTiao = Math.round(GUEST_DAILY_CREDIT / UNIT_CREDIT);
    const freeTiao = Math.round(FREE_DAILY_CREDIT / UNIT_CREDIT);
    const bonusTiao = Math.max(0, REGISTER_CHAT_BONUS_COUNT);
    return {
      success: false,
      error: isGuest
        ? `游客每天 ${guestTiao} 条，开一局狼人杀至少要 ${needTiao} 条可用额度（当前 ${haveTiao} 条）→ 注册后每天 ${freeTiao} 条${bonusTiao > 0 ? `、还能再送 ${bonusTiao} 条` : ''}。${detail}`
        : `今天的额度不够开一局（至少要 ${needTiao} 条可用，当前 ${haveTiao} 条），明早自动恢复；也可以获取更多额度或升级会员。${detail}`,
      code: 'QUOTA_EXCEEDED',
      reason: isGuest ? 'guest' : 'insufficient',
      registerHint: isGuest,
      needed: MIN_START_CREDIT,
      neededTiao: needTiao,
      gameEstimate: CREDIT_PER_GAME_ESTIMATE,
    };
  };
  if (!isUnlimited && avail < MIN_START_CREDIT) {
    res.status(402).json(gateBlock(''));
    return;
  }
  /**
   * 预扣策略（两档，各自避免一个坑）：
   *  - **额度够一局价**（Plus/Pro/攒够的免费用户）→ **开局预扣一局价**，局终按真实消耗多退少补。
   *  - **额度不够一局价但够准入**（典型：免费档 20 条 < 一局 40 条）→ **不预扣**，改为**局后按真实消耗扣**，
   *    上限 = 开局时的可用额度。否则免费用户一开局余额就归零（显示"剩余 0 条"），体验比旧行为还差。
   * 两种模式下**局内余额都不动**——余额只在开局或结算时变一次。
   */
  const reserveFull = isUnlimited || avail >= CREDIT_PER_GAME_ESTIMATE;
  // 预扣金额也只取整条（avail 正常就是整条；历史/异常残差向下取整，别把非整条写进账本）
  const preCharge = isUnlimited ? CREDIT_PER_GAME_ESTIMATE : Math.min(CREDIT_PER_GAME_ESTIMATE, floorCreditToTiao(avail));
  let token: string | null = null;
  let reserved = 0;
  if (reserveFull) {
    const probe = quotaStore.reserveCredit(userId, 'werewolf', { credit: preCharge });
    if (!probe.ok || !probe.token) {
      // 预扣被拒：公平使用阀（Pro 用量异常）与「额度不足」要分开说，别都说成"不够"
      res.status(402).json(probe.reason === 'fair-use'
        ? {
          success: false,
          error: '今日用量异常，已进入保护模式（Pro 公平使用阀）。明天恢复，或联系我们。',
          code: 'QUOTA_EXCEEDED',
          reason: 'fair-use',
          registerHint: false,
          needed: MIN_START_CREDIT,
          gameEstimate: CREDIT_PER_GAME_ESTIMATE,
        }
        : gateBlock('（预扣阶段被拒）'));
      return;
    }
    token = probe.token;
    reserved = floorCreditToTiao(probe.reserved ?? preCharge);
  }
  chargeState.active[userId] = {
    token,
    reserved,
    used: 0,
    cap: reserveFull ? reserved : floorCreditToTiao(avail),
    startedAt: Date.now(),
    lastAt: Date.now(),
  };
  persistCharge(true);

  const plan = quotaStore.planOf(userId);
  werewolfCounters.recordStart(10, plan); // 移植版固定 10 人局
  // 统一口径：与自研引擎写**同一份台账**，运营端的「累计」与「最近明细」因此同源
  werewolfLedger.record({ userId, size: 10, plan, source: 'wolfcha' });
  /**
   * 行为埋点：狼人杀**按局**计入「剧情演绎」使用记录（mode:'werewolf'）。
   * 位置刻意贴着台账那一行——控制台「用户行为」里的狼人杀局数与本页签「累计开局」
   * 因此**同源**，不会出现两个页面数字对不上（这个坑项目里已经踩过一次）。
   * 与 roleplay/textgame 一致：测试请求（test- 设备指纹 / RFC 5737 网段）不计。
   */
  if (!isTestRequest(getClientIp(req), String(req.headers['x-device-id'] || ''))) {
    activityStore.trackFeature(userId, 'roleplay', {
      detail: '10 人局',
      mode: 'werewolf',
      ip: getClientIp(req),
      country: getClientCountry(req),
    });
  }
  res.json({
    success: true,
    sessionId: `xiaoyu-${userId}-${Date.now()}`,
    startRequestId: String(req.headers['idempotency-key'] || ''),
    // A′ 回执：前端可据此提示「本局已预扣 X 条（一局约 Y 条）」
    preChargeCredit: chargeState.active[userId]?.reserved ?? 0,
    preChargeTiao: Math.round((chargeState.active[userId]?.reserved ?? 0) / UNIT_CREDIT),
    gameEstimateTiao: Math.round(CREDIT_PER_GAME_ESTIMATE / UNIT_CREDIT),
    // 上游客户端会读 payload.credits 来刷新顶栏额度显示（单位=次数）
    credits: creditsToUses(userId),
  });
});

/**
 * 自建角色内容安全校验（红线⑤，2026-09-28 审查 P1-4）。
 * wolfcha 的自建角色只存在浏览器 localStorage（不像自建剧本走服务端），但它的人设会被注入
 * 系统提示词并进入发言路径，所以创建/编辑/批量导入都必须过服务端**同一张**过滤词表。
 * 命中即拒（CONTENT_REJECTED）；调用方 fail-closed（校验不可达也不放行）。
 */
router.post('/wolfcha-compat/custom-character/check', (req: Request, res: Response): void => {
  const body = (req.body || {}) as { fields?: unknown };
  const fields = Array.isArray(body.fields) ? body.fields : [];
  const text = fields.filter((f): f is string => typeof f === 'string' && f.trim().length > 0).join('\n');
  const check = checkContentSafety(text);
  if (!check.safe) {
    res.json({ success: true, data: { safe: false, code: 'CONTENT_REJECTED' } });
    return;
  }
  res.json({ success: true, data: { safe: true } });
});

export default router;
