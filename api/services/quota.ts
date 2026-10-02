/**
 * 用户配额模块（免费3次 + 付费解锁）
 * 通过 设备指纹 + IP 识别用户，服务端计数，数据持久化到 data/users.json
 */

// 必须先于本模块静态 import 链加载 .env（ESM import 提升，避免读取到默认值）
import 'dotenv/config';

import crypto from 'crypto';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { accountStore } from './accounts.js';
import { costFromUsage } from './usage.js';
import { referralEventStore } from './referralEvents.js';

const USERS_FILE = dataFile('users.json');

const FREE_QUOTA = Number(process.env.FREE_QUOTA || 5); // 兼容旧字段
// —— 分池额度：理一理(结构化深度分析)按「次」，对话(聊一聊+角色扮演)共用按「条」 ——
const FREE_STRUCT = Number(process.env.FREE_STRUCT || 3); // 理一理 免费次数
const FREE_CHAT = Number(process.env.FREE_CHAT || 5);     // 对话 免费条数（聊一聊/角色扮演共用）
const UNLOCK_DAYS = Number(process.env.UNLOCK_DAYS || 30);
const INVITE_BONUS = Number(process.env.INVITE_BONUS || 50); // 邀请人每成功邀请 1 人得的额外额度（次）
export const INVITE_MAX = Number(process.env.INVITE_MAX || 20); // 单个邀请码最多可成功邀请人数（防刷）
// —— 引荐（referral）推广规则：买一送一 + 被邀人加赠 ——
/**
 * 邀请人须注册满 N 天（防「新号自邀」套利）。**默认 0 = 不设年龄门槛**（2026-09-19 用户拍板 B 方案）。
 * 为什么取消：门槛挡在最愿意分享的新用户身上，而业内普遍把门槛装在被邀人侧（完成激活/消费）；
 * 防刷改由「被邀人首次真实使用才结算」+ 设备/IP 差异 + 每人上限共同承担。
 * 想恢复旧行为：`.env` 设 `INVITE_INVITER_MIN_DAYS=7`。
 */
export const REFERRAL_INVITER_MIN_DAYS = Number(process.env.INVITE_INVITER_MIN_DAYS || 0);
/**
 * 新账号加成：邀请人注册 ≤ INVITE_NEW_ACCOUNT_BOOST_DAYS 天时，邀请成功奖励 ×INVITE_NEW_ACCOUNT_BOOST
 * （2026-09-19 用户拍板：把「7 天」从门槛改成**加成窗口**——同一笔防刷预算，奖励早期口碑传播者）。
 * 只作用于**邀请人**那一侧；被邀人（朋友）的额度不变。
 */
export const REFERRAL_NEW_ACCOUNT_BOOST = Number(process.env.INVITE_NEW_ACCOUNT_BOOST || 1.5);
export const REFERRAL_NEW_ACCOUNT_BOOST_DAYS = Number(process.env.INVITE_NEW_ACCOUNT_BOOST_DAYS || 7);
export const REFERRAL_YEARLY_CAP_DAYS = Number(process.env.INVITE_REWARD_YEARLY_CAP_DAYS || 365); // 邀请人同档会员封顶「年付」天数（Lifetime 也封顶此值）
export const REFERRAL_MONTHLY_BONUS_DAYS = Number(process.env.INVITE_MONTHLY_BONUS_DAYS || 15); // 被邀人月付「送半月」（30 → 45 天）
const REGISTER_BONUS = Number(process.env.REGISTER_BONUS || 3); // 注册即送额外免费次数（游客注册后变多）
const REGISTER_CHAT_BONUS = Number(process.env.REGISTER_CHAT_BONUS || 20); // 注册即送对话额度（条）
const FEEDBACK_REWARD_CHAT = Number(process.env.FEEDBACK_REWARD_CHAT || 3); // 已注册用户「提交反馈」每日一次获得的对话额度（条），用于「额度用完可反馈获得额度」
const CHAT_BONUS_START = process.env.CHAT_BONUS_START || ''; // 活动开始日期 YYYY-MM-DD（空=不限）
const CHAT_BONUS_END = process.env.CHAT_BONUS_END || '';     // 活动结束日期 YYYY-MM-DD（空=不限）
// —— 预设邀请码（注册时输入，匹配即额外送对话额度）：格式 "CODE:bonus,CODE2:bonus2"，小写匹配 ——
const PRESET_INVITE_CODES: Record<string, number> = (() => {
  const raw = process.env.INVITE_CODES || '';
  const out: Record<string, number> = {};
  for (const part of raw.split(',')) {
    const t = part.trim();
    if (!t) continue;
    const idx = t.indexOf(':');
    if (idx <= 0) continue;
    const code = t.slice(0, idx).trim().toLowerCase();
    const bonus = Number(t.slice(idx + 1).trim());
    if (code && bonus > 0) out[code] = bonus;
  }
  return out;
})();
export const PRESET_INVITE_CODES_MAP: Record<string, number> = PRESET_INVITE_CODES;
/** 读取预设邀请码的额外对话额度；未匹配返回 0 */
export function getPresetInviteBonus(code: string): number {
  if (!code) return 0;
  return PRESET_INVITE_CODES[code.trim().toLowerCase()] || 0;
}
// 聊一聊每日额度（Plus 会员）：理一理不限额，聊一聊每天限 CHAT_DAILY_LIMIT 条；Pro 会员不限额
const CHAT_DAILY_LIMIT = Number(process.env.CHAT_DAILY_LIMIT || 40);
// 千世书「AI 托管」每日回合上限（仅 Pro/Lifetime 可用）：托管是唯一「AI 自我循环、无用户努力」的功能，成本需封顶
const AUTO_PLAY_DAILY_LIMIT = Number(process.env.AUTO_PLAY_DAILY_LIMIT || 60);
// 千世书「AI 生成剧本」每日次数上限（仅 Pro/Lifetime 可用）：单次生成深度调用多次 LLM，
// 是除 AI 托管外的又一处高成本点，按天封顶（方案第 4 章）。
const GEN_DAILY_LIMIT = Number(process.env.GEN_DAILY_LIMIT || 3);
// 聊一聊上下文窗口（条）：Pro 更长上下文（档位权益）
const CONTEXT_FREE = Number(process.env.CONTEXT_FREE || 10);
const CONTEXT_PLUS = Number(process.env.CONTEXT_PLUS || 30);
const CONTEXT_PRO = Number(process.env.CONTEXT_PRO || 60);
// 长期记忆事实条数上限（按档位分级，.env 可调）
const MEMORY_FREE = Number(process.env.MEMORY_FREE || 20);
const MEMORY_PLUS = Number(process.env.MEMORY_PLUS || 60);
const MEMORY_PRO = Number(process.env.MEMORY_PRO || 120);
// 配额落盘去抖窗口（ms）：额度消耗（consume/consumeChat/consumeGenerate 等）是最高频写路径，
// 合并为批量异步写，避免每个 AI 请求都同步整表序列化 + 原子写盘；内存 Map 始终是权威（最终一致）。
const QUOTA_SAVE_DEBOUNCE_MS = 300;

// —— 统一点数（credit）：按预计/真实 token 成本折算的额度，1 credit ≈ 1/CREDIT_PER_YUAN 元 ——
// 覆盖所有要用 AI 额度的功能（聊一聊/理一理/角色扮演/文游回合/托管/AI生成剧本/自定义草稿）。
// 后端记账用点数；前端换算成用户熟悉的「≈ 约还能聊 N 条」（见 UNIT_CREDIT）。
/**
 * AI 狼人杀每日局数上限（成本保护）。一局 6 人局约 50~90 次 LLM 调用，必须按「局」而不是按「条」控量。
 * 免费档给 1 局（体验钩子），Plus 3 局，Pro 走 WEREWOLF_DAILY_LIMIT（默认 6）。
 */
export const WEREWOLF_FREE_DAILY_LIMIT = Number(process.env.WEREWOLF_FREE_DAILY_LIMIT || 1);
export const WEREWOLF_PLUS_DAILY_LIMIT = Number(process.env.WEREWOLF_PLUS_DAILY_LIMIT || 3);
export const WEREWOLF_DAILY_LIMIT = Number(process.env.WEREWOLF_DAILY_LIMIT || 6);

export const CREDIT_PER_YUAN = Number(process.env.CREDIT_PER_YUAN || 100); // 1 credit ≈ 0.01 元
export const FREE_DAILY_CREDIT = Number(process.env.FREE_DAILY_CREDIT || 30);
export const PLUS_DAILY_CREDIT = Number(process.env.PLUS_DAILY_CREDIT || 300);
export const PRO_DAILY_CREDIT = Number(process.env.PRO_DAILY_CREDIT || 1500); // 旧口径下 Pro 的兜底上限（统一口径下不再用）


export const UNIT_CREDIT = Number(process.env.UNIT_CREDIT || 2); // 1 标准单次 ≈ 普通聊一聊短消息的平均点数（前端「≈ N 条」换算锚点）

/**
 * 「累计获得赠送点数」这个字段从哪天开始记（运营端口径说明用）。
 * 之前只存余额、不存累计，所以**老记录算不出「赠送已用」**——控制台对老记录显示「—」并标注这个起点，
 * 不用 0 冒充（0 会被读成「一次都没用过」，是错的）。改口径只改这一行。
 */
export const CREDIT_GRANT_TRACKING_SINCE = '2026-09-29';

/**
 * ── 游客（未注册）每日点数上限（2026-09-27 用户拍板）────────────────────────────
 *
 * 口径：**游客 5 条/天；注册账号免费档 20 条/天，且注册再一次性赠送 20 条**
 * （`REGISTER_CHAT_BONUS`，活动期内由注册流程 `addChatBonus` 发到 `creditBonus`）。
 *
 * 为什么必须把游客单列一档：游客身份 = `sha256(设备指纹 :: IP)`（见 `identify()`），
 * **换 IP 就等于换一个全新的人**、重新领一份满额日额度——线上真实案例：同一台设备两天里出现
 * 3 个游客身份、各领 200 点（= 每天 20 条），控制台看到"游客一直能玩下去"。
 * 把游客档压到 5 条，让「注册」成为拿到 20 条/天与赠送额度的唯一途径（IP 轮换仍能重置，
 * 但每次重置只值 5 条；彻底堵住需要按 `deviceKey` 合并计数，见 quota.ts 的 identify/listByDeviceKey）。
 *
 * 数值用 `.env` 的 `GUEST_DAILY_TIAO`（**条**）调，写账本时换算成点数，
 * 保证 `creditRemain / UNIT_CREDIT` 仍是整数（账本硬性规则，见 roundCreditToTiao）。
 */
export const GUEST_DAILY_CREDIT = Number(process.env.GUEST_DAILY_TIAO || 5) * UNIT_CREDIT;

/**
 * ── Pro「无限」的内部公平使用阀（2026-09-17 加，用真实数据定的）────────────────
 *
 * 为什么必须有：校准报告（`temp/quota-calibration.mjs`）显示 Pro 的 **P90 = 280 条/天**（≈ ¥2.8/天），
 * 而 Pro 月费 $9.99 ≈ **¥2.4/天** —— 一个重度用户**一天就能吃掉一个月的收入**。这是「无限」唯一真实的成本敞口。
 *
 * 设计原则（与方案文档 §4.4「内部安全阀不对外展示」一致）：
 *  - **不改变对外的「无限」承诺**：`getCreditQuota()` 仍返回 `unlimited: true`、界面仍显示「无限」；
 *    阀值只在 `reserveCredit` 内部生效，且设在**正常用户永远碰不到**的高度（默认 200 条/天 = 免费档的 10 倍、
 *    实测 Pro 中位数 10 条的 20 倍）；
 *  - 触发时**明确告知**（不是静默失败），文案说清"今日用量异常，已进入保护模式"；
 *  - 数值可用 `.env` 调整：`PRO_FAIR_USE_TIAO`（默认 200 条/天）。
 */
export const PRO_FAIR_USE_CREDIT = Number(process.env.PRO_FAIR_USE_TIAO || 200) * UNIT_CREDIT;

/**
 * 重度用量**告警线**（只告警、不拦截）：单日用到这个量就在运营端留一条审计 + 服务端 warn，
 * 便于有人为判断"是不是被脚本刷了 / 要不要联系用户"，而不是月底看账单才发现。
 */
export const HEAVY_USAGE_ALERT_CREDIT = Number(process.env.HEAVY_USAGE_ALERT_TIAO || 100) * UNIT_CREDIT;

/** 是否开启「按预计 token 折算点数」计费。默认关闭（回退到「次数/条数」模式）；显式设 `CREDIT_QUOTA_ENABLED=1/true` 才开启。 */
export function isCreditQuotaEnabled(): boolean {
  const v = (process.env.CREDIT_QUOTA_ENABLED || '').toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  return false;
}

/** 把文本粗略折算成 token（中文≈1 token/字，英文≈0.3 token/char，加少量安全垫） */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (
      (c >= 0x4e00 && c <= 0x9fff) ||   // CJK 统一表意文字
      (c >= 0x3400 && c <= 0x4dbf) ||   // CJK 扩展 A
      (c >= 0xf900 && c <= 0xfaff) ||   // CJK 兼容表意文字
      (c >= 0x3000 && c <= 0x303f) ||   // CJK 标点/符号
      (c >= 0xff00 && c <= 0xffef)      // 全角符号
    ) cjk++;
  }
  const other = text.length - cjk;
  return Math.ceil(cjk * 1.0 + other * 0.30) + 8;
}

/** 深度思考档位 → 输出 token 放大系数（对照 docs/deepseek-v4-thinking-eval.md） */
function thinkingFactor(level?: string): number {
  switch (level) {
    case 'off': return 1.0;
    case 'low': return 1.3;
    case 'medium': return 1.8;
    case 'high': return 2.0;
    case 'max': return 2.5;
    default: return 1.8; // 缺省按 high 计
  }
}

/** 从预估 token 折算 credit（用全价输入价、不含缓存折扣，偏保守；结算会校正） */
export function estimateCreditFromTokens(promptTokens: number, completionTokens: number): number {
  // ⚠️ 刻意**不传** `at`：点数按 off-peak 基准价折算，**不随时段波动**。
  // 分时定价（peak ×2）只作用于运营端的成本记账（usage.ts 的 record 会传调用发起时刻），
  // 否则同一个动作在港澳白天（正好是 UTC peak 窗口）要多扣一倍额度——
  // 那是产品体验决策，不是账单口径（还会让 Pro 的每日点数安全阀提前触发）。
  const cost = costFromUsage({ prompt_tokens: promptTokens, completion_tokens: completionTokens });
  return Math.max(1, Math.round(cost * CREDIT_PER_YUAN));
}

/** 聊一聊单次预估：system 基值 + 历史/上下文/图片 + 输出×深度思考系数 */
export function estimateChatCredit(opts: { historyText?: string; imageCount?: number; contextText?: string; thinkingLevel?: string }): { credit: number; promptTokens: number; completionTokens: number } {
  const baseSystemTokens = 2400; // persona + 记忆 + news + 工具 schema 的粗略基值（KVCache 后实际便宜，预扣取全价保守）
  const historyTokens = estimateTextTokens(opts.historyText || '');
  const contextTokens = estimateTextTokens(opts.contextText || '');
  const imageTokens = (opts.imageCount || 0) * 900; // 每张视觉图估算 token
  const promptTokens = baseSystemTokens + historyTokens + contextTokens + imageTokens;
  const completionTokens = Math.round(320 * thinkingFactor(opts.thinkingLevel));
  return { credit: estimateCreditFromTokens(promptTokens, completionTokens), promptTokens, completionTokens };
}

/** 各功能 prompt 基值（system/persona/约束的粗略 token）：理一理子步骤 / 角色扮演 / 文游 / 生成剧本 */
const FEATURE_PROMPT_BASE: Record<string, number> = {
  analyzeEmotion: 1800, questions: 1200, detailedAnalysis: 1500, healingStory: 1600, followup: 1300,
  roleplayTurn: 1600, roleplaySuggestions: 1500, customDraft: 1500, customRevise: 1500,
  textgameTurn: 1800, generateScenario: 2600,
};
/** 各功能输出 token 基值（×深度思考系数） */
const FEATURE_OUTPUT_BASE: Record<string, number> = {
  analyzeEmotion: 360, questions: 240, detailedAnalysis: 450, healingStory: 900, followup: 320,
  roleplayTurn: 520, roleplaySuggestions: 300, customDraft: 380, customRevise: 380,
  textgameTurn: 700, generateScenario: 1200,
};

/**
 * 通用「按预计 token 折算」预估：理一理子步骤 / 角色扮演 / 文游 / AI 生成剧本等。
 * 按 feature 的 prompt/输出基值 + 用户输入长度 + 图片数 + 深度思考档位估算。
 * Phase 2 先用估算值预扣并结算为该值（不逐一 usages 校正）；聊一聊已按真实 usage 结算。
 */
export function estimateFeatureCredit(feature: string, opts: { inputText?: string; thinkingLevel?: string; imageCount?: number }): { credit: number; promptTokens: number; completionTokens: number } {
  const base = FEATURE_PROMPT_BASE[feature] ?? 1600;
  const output = FEATURE_OUTPUT_BASE[feature] ?? 420;
  const prompt = base + estimateTextTokens(opts.inputText || '') + ((opts.imageCount || 0) * 900);
  const completion = Math.round(output * thinkingFactor(opts.thinkingLevel));
  return { credit: estimateCreditFromTokens(prompt, completion), promptTokens: prompt, completionTokens: completion };
}

/**
 * ── 整数价目表（2026-09-17 用户拍板）────────────────────────────────────
 *
 * 口径：**账本、显示、价目表全是整数**，一个动作 = 固定 N 条，不再按 token 逐次折算。
 * 为什么：按 token 折算会让「剩余条数」出现小数（用户看不到，但推荐器/后台/对账都要换算），
 * 而且用户无法预期"发一条会掉多少"。**不同功能单价不同**（越耗 token 越贵）这条仍然成立——
 * 只是价格**事前定好**，不再逐次估算。
 *
 * 定价依据（2026-09-17 真实路由实测，详见 `统一点数账本…doc` §4.5）：
 *   聊一聊一条 10 点(实测) · 带图 8 点 · 剧情一回合 ≈7–10 点 · 文游一回合 ≈9–13 点(偏贵→2 条)
 *   理一理单步 4–18 点(整条 5 步 ≈45 点 → 每步 2 条) · 一局狼人杀 ≈290 点 → 40 条（在 wolfchaCompat 里）
 *   AI 生成剧本 6 次调用 ≈163 点 → 20 条（Pro 专属 + 每天 3 部封顶）
 *
 * ⚠️ 单位是**点**（= 条 × `UNIT_CREDIT`），这样 `creditRemain / UNIT_CREDIT` 恒为整数，
 *    显示层不需要任何取整/小数处理。
 */
export const ACTION_PRICE_POINTS: Record<string, number> = {
  chat: 1 * UNIT_CREDIT,            // 聊一聊一条（含图片消息，不再单独加价）
  roleplayTurn: 1 * UNIT_CREDIT,    // 剧情扮演一回合
  roleplaySuggestions: 1 * UNIT_CREDIT,
  customDraft: 1 * UNIT_CREDIT,     // 自建角色 AI 起草
  customRevise: 1 * UNIT_CREDIT,    // 自建角色 AI 改稿
  textgameTurn: 2 * UNIT_CREDIT,    // 文游一回合（输出更长，实测最贵）
  analyzeEmotion: 2 * UNIT_CREDIT,  // 理一理五步：每步 2 条（整条流程 10 条）
  questions: 2 * UNIT_CREDIT,
  detailedAnalysis: 2 * UNIT_CREDIT,
  healingStory: 2 * UNIT_CREDIT,
  followup: 2 * UNIT_CREDIT,
  generateScenario: 20 * UNIT_CREDIT, // AI 生成剧本（文游，Pro 专属）：实测 6 次调用 ≈ 163 点
};

/**
 * 取某个动作的**整数价**（点）。未知动作回落到 1 条——宁可少收也不要把用户挡在门外，
 * 同时 `console.warn` 提醒补价目表（防止新增功能悄悄免费）。
 */
/** AI 狼人杀一局价（条）。放在这里做**单源**：狼人杀路由与会员页推荐器都读它。 */
export const WEREWOLF_GAME_TIAO = 40;

/**
 * 推荐器用的「每模式一次动作 = 多少条」（全部整数，来源就是上面的价目表）。
 * 前端**不写死**任何数字——改价目表/改单价，会员页的推荐器自动跟随。
 *  - chat：聊天或剧情扮演一句/一回合（同价，合并成一条滑块）
 *  - textgame：AI 文游一回合
 *  - structure：理一理**一整条流程**（分析→问题→详细→故事→追问，五步各自 2 条）
 *  - werewolf：AI 狼人杀一局
 */
export function featureCostTiao(): Record<string, number> {
  const p = (a: string) => Math.round(actionPricePoints(a) / UNIT_CREDIT);
  return {
    chat: p('chat'),
    textgame: p('textgameTurn'),
    structure: p('analyzeEmotion') + p('questions') + p('detailedAnalysis') + p('healingStory') + p('followup'),
    werewolf: WEREWOLF_GAME_TIAO,
  };
}

export function actionPricePoints(action: string): number {
  const p = ACTION_PRICE_POINTS[action];
  if (typeof p === 'number' && p > 0) return p;
  console.warn('[Quota] 价目表缺少动作「' + action + '」，按 1 条计费——请补 ACTION_PRICE_POINTS');
  return UNIT_CREDIT;
}

/**
 * ── 账本硬性规则：**任何进出账本的点数都必须是 `UNIT_CREDIT` 的整数倍**（2026-09-17 用户拍板）──
 *
 * 为什么：用户可见单位是「条」，`剩余条数 = 剩余点数 / UNIT_CREDIT`。只要有一个入口写进非整倍数的点数，
 * 那一刻起「剩余条数」就是小数，前端只能 `floor` 并把文案写成「**≈** 还能聊 N 条」
 * （2026-09-17 那次「還能聊 Infinity 條」就是同一类显示层裂缝）。
 *
 * 少数动作（狼人杀）仍然**按真实 token 用量多退少补**，但**结算金额四舍五入到整条**——
 * 这样既保留"用得多扣得多、用得少退得多"，又保证余量恒为整条。
 */
export function roundCreditToTiao(points: number): number {
  if (!Number.isFinite(points)) return 0;
  return Math.max(0, Math.round(points / UNIT_CREDIT) * UNIT_CREDIT);
}

/** 预扣用：**向上**对齐到整条（宁可先多扣一点，也不要局中穿底）；结算请用 `roundCreditToTiao` */
export function ceilCreditToTiao(points: number): number {
  if (!Number.isFinite(points)) return 0;
  return Math.max(0, Math.ceil(points / UNIT_CREDIT) * UNIT_CREDIT);
}

/** **向下**对齐到整条：用于「扣除上限不得超过某余额」这类封顶（绝不超扣） */
export function floorCreditToTiao(points: number): number {
  if (!Number.isFinite(points)) return 0;
  return Math.max(0, Math.floor(points / UNIT_CREDIT) * UNIT_CREDIT);
}

export interface UserRecord {
  userId: string;
  freeUsed: number; // 理一理(结构化)已用次数
  chatFreeUsed?: number; // 对话(聊一聊/角色扮演)免费已用条数
  unlockUntil: number | null; // 时间戳(ms)，null 表示从未付费
  bonusFree?: number; // 邀请等获得的额外免费次数（理一理池）
  chatBonusFree?: number; // 对话池额外额度（注册奖励等，加到 FREE_CHAT 之上）
  inviteCount?: number; // 该用户作为邀请人成功邀请的人数
  deviceKey?: string; // 纯设备指纹哈希（不掺 IP）：注册时据此归并「同设备不同 IP」的历史游客记录（孤儿归因），**并且游客日额度按它合并**（2026-09-27：换 IP 不再重置额度）
  plan?: 'plus' | 'pro' | 'lifetime'; // 会员等级：plus（理一理无限+聊一聊每日限额）/ pro（两模式都无限）/ lifetime（买断=pro 级+长有效期）
  chatDate?: string;     // 聊一聊每日额度记录日期 YYYY-MM-DD（仅 plus 记账）
  chatCount?: number;    // 当日已用聊一聊条数（仅 plus 记账）
  feedbackRewardDate?: string; // 已注册用户「提交反馈」奖励发放日期 YYYY-MM-DD（每日一次）
  autoPlayDate?: string; // 千世书 AI 托管按天记账日期 YYYY-MM-DD（仅 pro/lifetime）
  autoPlayUsed?: number; // 当日已用托管回合数
  genDate?: string; // 千世书 AI 生成剧本按天记账日期 YYYY-MM-DD（仅 pro/lifetime）
  genUsed?: number; // 当日已用 AI 生成剧本次数
  // 待通知的奖励（用户下次登录/刷新时恭喜提示后清除）。
  // note = 运营者随奖励写给用户的话（目前仅反馈奖励会带）：弹窗据此展示，
  // 同时那封信已落进「小愈信箱」（api/services/inbox.ts），ack 只清弹窗、不清信。
  pendingReward?: { count: number; reason: string; at: number; note?: string };
  invitedBy?: string;               // 邀请归属：注册时经 ?ref= 记录的邀请人 userId
  inviteDeviceKey?: string;         // 被邀人注册时的设备指纹哈希（供「设备/IP 不同」反套利）
  inviteIp?: string;                // 被邀人注册时的 IP（供「设备/IP 不同」反套利）
  inviteeRewardedInviter?: boolean; // 该用户首次付费后是否已奖励过邀请人（只奖一次）
  // —— 邀请结算状态（2026-09-19 B 方案：门槛装在被邀人侧）——
  invitePending?: boolean;          // 该用户经推广链接注册且已通过注册期反套利，正在等「首次真实使用」结算
  invitePendingAt?: number;         // 进入待激活的时间（审计/区间统计用）
  inviteQualifiedAt?: number;       // 首次真实使用触发了结算的时间（幂等标记：结算过就不再重试）
  inviteGrantedCredits?: number;    // 结算时发给邀请人的额度（条，含新账号加成后的值；0=未发/被拦）
  inviteGrantedBoost?: number;      // 结算时使用的加成倍数（1.5=新账号窗口内）
  lastDeviceKey?: string;           // 该用户最近一次设备指纹哈希（邀请人比较用）
  lastIp?: string;                  // 该用户最近一次 IP（邀请人比较用）
  inviteCodeUsed?: string;          // 注册时使用的预设邀请码（小写），用于控制台按码统计
  expiryRemindedAt?: number;        // 到期前 3 天提醒已发送标记
  trialProUntil?: number;           // 老用户 7 天 Pro 体验到期时间戳(ms)；未到=体验中
  trialProGrantedAt?: number;       // 体验授予时间（审计）
  genCredit?: number;               // 额外「AI 生成剧本」额度（新手创作礼等，可绕过 pro 门槛）
  charGiftGranted?: boolean;        // 是否已发过「首次创建角色的 AI 剧本额度」
  /**
   * 运营账号功能覆盖（2026-09-18，控制台「🛠 运营账号」面板）：**只对该账号自身生效**。
   * 开启后 `getPlan()` 直接返回 `opsPlan`、`isUnlocked()` 视为会员中——即「档位锁定 + 永不到期」，
   * 因此不受 `unlockUntil` 到期影响，也不需要反复手动续费；关闭即恢复账号原本的 plan/unlockUntil 记录。
   * 只由控制台 `POST /api/payment/admin/ops-account` 写入（其它路径一律不碰这两个字段）。
   */
  opsMode?: boolean;                // 是否开启「全功能开放（不过期）」
  opsPlan?: 'free' | 'plus' | 'pro'; // 覆盖档位（默认 pro）
  opsSince?: number;                // 开启时间（审计）
  // —— 统一点数（credit）账本：按预计/真实 token 折算，跨所有 AI 功能 ——
  creditDate?: string;              // 每日记账日期 YYYY-MM-DD
  creditUsedToday?: number;         // 今日已用点数（对每日上限）
  creditBonus?: number;             // 持久赠送点数（注册/邀请/反馈/打卡），先于每日上限消耗
  /**
   * **累计获得**的赠送点数（只统计、不参与扣减）。为什么要单独一个字段：`creditBonus` 是**余额**，
   * 扣减直接做减法，账本里既没有「累计获得」也没有「累计已用」——运营端想问「他赠送的额度用了多少」
   * 就算不出来（2026-09-29 用户提问：「赠送余额为什么没用已用的记录？」）。
   * 从现在起每次发放都累加，`已用 = 累计获得 − 当前余额`。
   * ⚠️ 历史发放无法回算 → 老记录该字段为 `undefined`，运营端显示「—」并标注起点。
   */
  creditGrantedTotal?: number;
  createdAt: number;
}

class QuotaStore {
  private users: Map<string, UserRecord> = new Map();
  // 记录最近一次「AI 生成剧本」消耗的来源，用于失败回滚时与消耗对称（genCredit vs 每日限额）
  private lastGenSource: Map<string, 'credit' | 'daily'> = new Map();
  // 统一点数（credit）的进行中预留令牌：预扣 → 调用 → 结算/回滚。进程内存 Map（参考 lastGenSource 模式），不落盘。
  private creditReservations: Map<string, { userId: string; reserved: number; bonusUsed: number; dailyUsed: number; feature: string; at: number }> = new Map();
  // 合并落盘去抖定时器：额度消耗是最高频写路径，避免每个请求都同步整表序列化写盘
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const parsed = readJson<UserRecord[]>(USERS_FILE, []);
    if (Array.isArray(parsed)) {
      parsed.forEach((u: UserRecord) => {
        if (u && u.userId) this.users.set(u.userId, u);
      });
    }
    console.log(`💾 [Quota] 已从磁盘加载 ${this.users.size} 个用户`);
  }

  private saveToDisk(): void {
    // 合并延时落盘：窗口内多次修改合并为一次全量写（读快照时取当前 Map，天然捕获窗口内改动）。
    if (this.saveTimer) return; // 已有一个待写的全量快照，等待触发即可
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushNow();
    }, QUOTA_SAVE_DEBOUNCE_MS);
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
  }

  /** 立即落盘（去抖窗口内缓冲的改动 + 进程退出时强制写出，确保不丢额度记账） */
  flushNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      writeJson(USERS_FILE, Array.from(this.users.values()));
    } catch (error) {
      console.warn('⚠️ [Quota] 保存用户数据失败:', (error as Error)?.message);
    }
  }

  /**
   * 根据设备指纹 + IP 生成稳定的用户标识
   */
  identify(deviceId: string, ip: string): string {
    const raw = `${deviceId || 'anon'}::${ip || 'unknown'}`;
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  }

  /** 纯设备指纹哈希（不掺 IP，跨 IP 稳定）：用于邀请归因 / 孤儿归并 */
  identifyByDevice(deviceId: string): string {
    return crypto.createHash('sha256').update('dev:' + (deviceId || 'anon')).digest('hex').slice(0, 32);
  }

  /**
   * **是否注册账号**（`accounts.json` 里有记录）。
   *
   * 这是「免费档分两档」的**唯一判据**，被三处共用，别再各写各的：
   *  - `creditDailyCap()`：注册 = 20 条/天，游客 = 5 条/天；
   *  - `dailyPoolRecords()`：账号不并入游客的按设备额度池；
   *  - `wolfchaCompat` 的开局拦截文案：区分「注册才能玩」与「今天用完了」。
   * ⚠️ 不能用 ID 形状猜（游客 ID 是 32 位 hex、账号是 UUID，但不该靠形状判定）。
   */
  isRegisteredAccount(userId: string): boolean {
    return !!accountStore.getById(userId);
  }

  /**
   * 给游客记录打上纯设备指纹标签（供注册时孤儿归并 + **日额度按设备合并**）。
   *
   * ⚠️ `deviceId` 为空时**不打标签**（2026-09-27）：`identifyByDevice('')` 恒等于 `sha256('dev:anon')`，
   * 若照打标签，**所有没带 `X-Device-Id` 的客户端会共用同一个「设备」桶**（心跳 `sendBeacon` 就打不了
   * 自定义头，线上历史上有 259 个这种身份）——那等于把全站这些人并成一个额度池，真人反而被饿死。
   * 不打标签 = 这条记录不参与设备合并，退化为原来的「设备指纹 + IP」口径（与改造前一致）。
   */
  setDeviceKey(userId: string, deviceId: string): void {
    if (!deviceId) return;
    const dk = this.identifyByDevice(deviceId);
    const u = this.ensureUser(userId);
    if (u.deviceKey !== dk) {
      u.deviceKey = dk;
      this.saveToDisk();
    }
  }

  /** 返回同一设备指纹下的其它游客记录 id（排除某 id） */
  listByDeviceKey(deviceKey: string, excludeUserId?: string): string[] {
    const out: string[] = [];
    for (const [id, u] of this.users) {
      if (excludeUserId && id === excludeUserId) continue;
      if (u.deviceKey === deviceKey) out.push(id);
    }
    return out;
  }

  /**
   * 「共用同一份日额度」的记录集合（2026-09-27 设备维度合并）。
   *
   * 为什么必须合并：游客身份 = `sha256(设备指纹 :: IP)`（见 `identify()`）⇒ 同一台手机换网络
   * （wifi→4G、IPv6 轮换、VPN 换出口）就是**一个全新的人**、重新领一份满额日额度。线上真实案例：
   * 同一 `deviceKey` 两天里出现 3 个身份、各领 200/70/200 点（一个设备两天 51 次 AI 调用）。
   * 所以游客档的**上限判定与「剩余 N 条」显示**按 `deviceKey` 汇总：同一台设备的所有游客身份共用一份日额度。
   *
   * 边界（写死在这里，别被后人"顺手简化"）：
   *  - **注册账号不参与**：账号按 `userId` 记账（跨设备稳定），同一台电脑上两个人的账号互不影响；
   *    只有「不是账号」的记录才进集合（判据与 `creditDailyCap()` 同源 = `accountStore.getById`）。
   *  - **没有 `deviceKey` 的记录只算自己**（空设备号 / 历史数据）→ 退化为改造前的口径。
   *  - **`dev:anon` 桶永不合并**（历史数据里可能存在）：否则所有无设备号客户端会并成一个池。
   *  - 性能：一次全表扫描（当前 ~3.7k 条记录，量级可忽略）；`listByDeviceKey()` 本来就是同样的扫描。
   */
  private dailyPoolRecords(user: UserRecord): UserRecord[] {
    if (this.isRegisteredAccount(user.userId)) return [user]; // 账号：只算自己
    const dk = user.deviceKey;
    if (!dk || dk === this.identifyByDevice('')) return [user]; // 无设备号 / anon 桶：只算自己
    const out: UserRecord[] = [];
    for (const u of this.users.values()) {
      if (u.deviceKey !== dk) continue;
      if (this.isRegisteredAccount(u.userId)) continue; // 账号记录不并入游客额度
      out.push(u);
    }
    return out.some((u) => u.userId === user.userId) ? out : [...out, user];
  }

  /** 上述集合在**今天**已用的点数合计（= 这一档当天真正消耗掉的量） */
  private poolUsedToday(user: UserRecord, today: string): number {
    let sum = 0;
    for (const u of this.dailyPoolRecords(user)) {
      if (u.creditDate === today) sum += u.creditUsedToday || 0;
    }
    return sum;
  }

  private ensureUser(userId: string): UserRecord {
    let u = this.users.get(userId);
    if (!u) {
      u = { userId, freeUsed: 0, unlockUntil: null, createdAt: Date.now() };
      this.users.set(userId, u);
      this.saveToDisk();
    }
    return u;
  }

  /**
   * 是否处于解锁期内。
   * 运营账号覆盖开启且档位不是 free 时一律视为会员中（「不过期」）。
   */
  isUnlocked(user: UserRecord): boolean {
    if (user.opsMode) return user.opsPlan !== 'free';
    return !!user.unlockUntil && user.unlockUntil > Date.now();
  }

  /**
   * 会员等级：pro > plus > free（lifetime 视为 pro 级）
   * 老用户（已有解锁但未记录 plan）按 plus 处理
   * 运营账号覆盖（opsMode）优先：档位锁定为 opsPlan，且**不看到期时间**（详见 UserRecord.opsMode）
   */
  getPlan(user: UserRecord): 'free' | 'plus' | 'pro' {
    if (user.opsMode) {
      if (user.opsPlan === 'plus') return 'plus';
      if (user.opsPlan === 'free') return 'free';
      return 'pro'; // 默认 pro（控件里「默认 Pro」）
    }
    if (user.plan === 'pro' || user.plan === 'lifetime') return 'pro';
    // 老用户 7 天 Pro 体验：体验期内按完整 Pro 权益（无限畅聊 + 更长上下文 + AI 生成剧本）
    if (user.trialProUntil && user.trialProUntil > Date.now()) return 'pro';
    if (user.plan === 'plus') return 'plus';
    return this.isUnlocked(user) ? 'plus' : 'free';
  }

  /**
   * 运营账号覆盖：读取当前状态（供控制台「🛠 运营账号」面板）。
   */
  getOpsState(userId: string): { enabled: boolean; plan: 'free' | 'plus' | 'pro'; since: number | null } {
    const u = this.users.get(userId);
    return {
      enabled: !!u?.opsMode,
      plan: u?.opsPlan === 'plus' ? 'plus' : u?.opsPlan === 'free' ? 'free' : 'pro',
      since: u?.opsSince || null,
    };
  }

  /**
   * 运营账号覆盖：开启/关闭 + 选择档位（free | plus | pro，默认 pro）。
   * 只应由控制台「🛠 运营账号」面板调用；**不动**账号原本的 plan / unlockUntil 记录，
   * 所以关掉之后能原样回到普通账号（不会丢失历史档位与到期时间）。
   */
  setOpsMode(userId: string, enabled: boolean, plan: 'free' | 'plus' | 'pro' = 'pro'): UserRecord {
    const user = this.ensureUser(userId);
    if (enabled) {
      user.opsMode = true;
      user.opsPlan = plan;
      user.opsSince = user.opsSince || Date.now();
    } else {
      delete user.opsMode;
      delete user.opsPlan;
      delete user.opsSince;
    }
    this.saveToDisk();
    return user;
  }

  /**
   * 节日礼：赠送 N 天完整 Pro（与老用户 7 天体验共用 `trialProUntil` 字段，但**不写**
   * `trialProGrantedAt`）。
   *
   * 为什么不写 trialProGrantedAt：那个标记是「新人 7 天试用已领」的判据（`isNewcomerEligible`）；
   * 节日礼通常只有 1 天，若也打上该标记，会把当天新注册的用户**永久排除**在之后的 7 天新人礼之外
   * ——小礼吃掉大礼。故节日礼只加时间、不打标记；谁领过由节日礼自己的 marker 记（见 holidayGift.ts）。
   * 与 `grantProTrial` 一致：从「当前更晚的日期」起算，可叠加/延长。
   */
  grantProGift(userId: string, days: number): UserRecord {
    const user = this.ensureUser(userId);
    const base = (user.trialProUntil && user.trialProUntil > Date.now()) ? user.trialProUntil : Date.now();
    user.trialProUntil = base + days * 24 * 60 * 60 * 1000;
    this.saveToDisk();
    return user;
  }

  /** 是否处于 7 天 Pro 老用户体验期内 */
  isProTrialActive(user: UserRecord): boolean {
    return !!user.trialProUntil && user.trialProUntil > Date.now();
  }

  /**
   * 授予老用户 7 天 Pro 体验（完整 Pro 权益）。体验期从「当前已更晚的日期」起算，可叠加/延长。
   */
  grantProTrial(userId: string, days: number): UserRecord {
    const user = this.ensureUser(userId);
    const base = (user.trialProUntil && user.trialProUntil > Date.now()) ? user.trialProUntil : Date.now();
    user.trialProUntil = base + days * 24 * 60 * 60 * 1000;
    user.trialProGrantedAt = Date.now();
    this.saveToDisk();
    return user;
  }

  /**
   * 新手创作礼：用户首次创建聊一聊自定义角色时送 1 次 AI 剧本生成额度（只送一次）。
   * @returns 本次是否真的发出奖励
   */
  grantFirstCharCreationGift(userId: string): boolean {
    const user = this.ensureUser(userId);
    if (user.charGiftGranted) return false;
    user.charGiftGranted = true;
    user.genCredit = (user.genCredit || 0) + 1;
    // 站内恭喜提示（前端拉到配额后消费）
    const prev = user.pendingReward?.count || 0;
    user.pendingReward = { count: prev + 1, reason: 'char-gift', at: Date.now() };
    this.saveToDisk();
    return true;
  }

  /**
   * 聊一聊上下文窗口（条数）：Pro > Plus > Free
   */
  getContextWindow(userId: string): number {
    const user = this.ensureUser(userId);
    const plan = this.getPlan(user);
    if (plan === 'pro') return CONTEXT_PRO;
    if (plan === 'plus') return CONTEXT_PLUS;
    return CONTEXT_FREE;
  }

  /**
   * 长期记忆事实条数上限（按会员档位分级）：Free / Plus / Pro（.env 可调）
   */
  getMaxMemoryFacts(userId: string): number {
    const plan = this.getPlan(this.ensureUser(userId));
    return plan === 'pro' ? MEMORY_PRO : plan === 'plus' ? MEMORY_PLUS : MEMORY_FREE;
  }

  /**
   * 今天的日期键（本地时区 YYYY-MM-DD）
   */
  private todayKey(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /**
   * 获取配额状态（含会员等级与聊一聊额度）
   */
  getQuota(userId: string) {
    const user = this.ensureUser(userId);
    const unlocked = this.isUnlocked(user);
    const plan = this.getPlan(user);
    // 理一理池
    const structTotal = FREE_STRUCT + (user.bonusFree || 0);
    const remainStruct = Math.max(0, structTotal - user.freeUsed);
    // 对话池（聊一聊/角色扮演共用）：基础 + 注册奖励
    const chatTotal = FREE_CHAT + (user.chatBonusFree || 0);
    const remainChat = Math.max(0, chatTotal - (user.chatFreeUsed || 0));
    const today = this.todayKey();
    const chatUsedToday = user.chatDate === today ? (user.chatCount || 0) : 0;
    // 新人 Pro 限时活动：注册即送 Pro（无限使用）N 天；活动未开启/未配置天数 → 不提示
    const proPromoActive = isProTrialPromoActive();
    const proPromoDays = proPromoActive ? (Number(process.env.PRO_TRIAL_DAYS || 0) > 0 ? Number(process.env.PRO_TRIAL_DAYS) : 7) : 0;
    // 点数状态只取一次（原实现连续调 4 次，且下面要读 unlimited 标记）
    const cq = this.getCreditQuota(userId);
    return {
      freeTotal: structTotal,
      freeUsed: user.freeUsed,
      bonusFree: user.bonusFree || 0,
      remainFree: remainStruct,       // 理一理剩余次数
      chatFreeRemain: remainChat,     // 对话剩余条数（聊一聊/角色扮演共用）
      chatBonusFree: user.chatBonusFree || 0, // 对话池已获得的注册奖励
      registerChatBonus: this.isChatBonusActive() ? REGISTER_CHAT_BONUS : 0, // 活动期内注册可送的对话额度（前端提示用）
      registerProPromoActive: proPromoActive, // 新人 Pro 限时活动是否进行中（前端注册页优先提示用）
      registerProDays: proPromoDays,          // 新人注册即送的 Pro 天数（0=未开启）
      // 运营账号覆盖：对外表现得像「永久会员」——否则接口返回 unlocked=true 而 App 侧仍可能显示「已过期」
      // （opsMode 只对运营账号自身生效，且关掉即恢复原样，见 UserRecord.opsMode）
      unlockUntil: (user.opsMode && plan !== 'free')
        ? Math.max(Number(user.unlockUntil) || 0, Date.now() + 3650 * 24 * 60 * 60 * 1000)
        : user.unlockUntil,
      unlocked,
      canUse: plan === 'pro' || unlocked || remainStruct > 0 || remainChat > 0,
      plan,
      lifetime: user.plan === 'lifetime' || (!!user.opsMode && plan === 'pro'), // 买断·终身标记（前端展示「永久会员」）
      trialProActive: this.isProTrialActive(user),
      trialProUntil: user.trialProUntil || null,
      genCredit: user.genCredit || 0,
      chatUsedToday,
      chatLimitPerDay: plan === 'pro' ? null : plan === 'plus' ? CHAT_DAILY_LIMIT : 0,
      // 统一点数（credit）状态：前端可用 creditRemain / unitCredit 换算成「≈ 还能聊 N 条」（Phase 3 展示用）
      creditEnabled: isCreditQuotaEnabled(), // 是否开启点数计费（决定前端显示「旧条数」还是「≈ N 条」）
      creditUnlimited: cq.unlimited,          // 统一口径下的 Pro：无限（前端据此显示「无限」，而不是把 null 当成 0）
      creditRemain: cq.creditRemain,
      creditDailyCap: cq.dailyCap,
      // 分档日额度（点数）：前端文案的**唯一来源**——「游客 N 条 / 注册 M 条」的数字都从这里取，
      // 前端任何地方都不许写死 5 / 20（改 .env 就全局跟着变）。
      guestDailyCredit: GUEST_DAILY_CREDIT,
      freeDailyCredit: FREE_DAILY_CREDIT,
      creditUsedToday: cq.usedToday,
      creditBonus: cq.bonus,
      unitCredit: UNIT_CREDIT,
      pendingReward: user.pendingReward || null,
    };
  }

  /**
   * 聊一聊配额：
   * free → 共用免费次数；plus → 每日 CHAT_DAILY_LIMIT 条；pro → 无限
   */
  getChatQuota(userId: string) {
    const user = this.ensureUser(userId);
    const plan = this.getPlan(user);
    const today = this.todayKey();
    const usedToday = user.chatDate === today ? (user.chatCount || 0) : 0;

    if (plan === 'pro') {
      return { plan, canChat: true, limitPerDay: null, usedToday: 0, remainToday: null, unlocked: true };
    }
    if (plan === 'plus') {
      const remainToday = Math.max(0, CHAT_DAILY_LIMIT - usedToday);
      return { plan, canChat: remainToday > 0, limitPerDay: CHAT_DAILY_LIMIT, usedToday, remainToday, unlocked: true };
    }
    // free：独立对话池（聊一聊/角色扮演共用，含注册奖励）
    const remainChat = Math.max(0, FREE_CHAT + (user.chatBonusFree || 0) - (user.chatFreeUsed || 0));
    return { plan: 'free', canChat: remainChat > 0, limitPerDay: null, usedToday: 0, remainToday: remainChat, unlocked: false };
  }

  /**
   * 运营端「额度总览」（2026-09-25 用户口径：「控制台要能看到每个人的可用已用额度以及所有额度」）。
   *
   * 把该用户的**所有额度池**归一成同一形状、一次给全，控制台不再各处自己拼口径：
   *  - `struct`：理一理池（免费 3 + 邀请/打卡等奖励）
   *  - `chat`：对话池（聊一聊/角色扮演共用，旧「条」口径）
   *  - `credit`：统一点数池（点数制开启时**这才是真正的可用额度**）—— 点数已按 `unitCredit` 换算成「条」
   *  - `plus`：Plus 每日额度（仅 plus 档；旧口径表）
   *  - `genCredit`：AI 生成额度（文游/剧本生成）
   *  - `pendingReward`：还没弹给用户看的奖励
   *
   * ⚠️ 无限档（Pro）的 `credit` 数值一律 `null`，另用 `unlimited: true` 表达（`Infinity` 编不出 JSON）。
   */
  describeQuota(userId: string) {
    const user = this.ensureUser(userId);
    const plan = this.getPlan(user);
    const cq = this.getCreditQuota(userId);
    const unit = UNIT_CREDIT;
    /** 点数 → 「条」（账本硬性规则保证是整数倍，round 只为防御） */
    const toTiao = (points: number | null): number | null =>
      points === null || !Number.isFinite(points) ? null : Math.round(points / unit);
    // 理一理池
    const structTotal = FREE_STRUCT + (user.bonusFree || 0);
    const structUsed = user.freeUsed || 0;
    // 对话池（旧「条」口径）
    const chatTotal = FREE_CHAT + (user.chatBonusFree || 0);
    const chatUsed = user.chatFreeUsed || 0;
    const today = this.todayKey();
    const chatUsedToday = user.chatDate === today ? (user.chatCount || 0) : 0;
    /**
     * 赠送余额的「累计获得 / 已用」：余额是实打实的，累计只有 2026-09-29 起有记录。
     * 老记录（undefined）→ 已用返回 null（前端显示「—」），**不能用 0 冒充**。
     * `已用 = 累计获得 − 当前余额`，下限 0（防止人工调账/历史迁移让余额高于累计时出现负数）。
     */
    const bonusGranted = typeof user.creditGrantedTotal === 'number' ? user.creditGrantedTotal : null;
    return {
      plan,
      creditEnabled: isCreditQuotaEnabled(),
      unitCredit: unit,
      unlimited: cq.unlimited,
      struct: { total: structTotal, used: structUsed, remain: Math.max(0, structTotal - structUsed) },
      chat: { total: chatTotal, used: chatUsed, remain: Math.max(0, chatTotal - chatUsed) },
      credit: {
        bonusTiao: toTiao(cq.bonus),
        bonusGrantedTiao: toTiao(bonusGranted),
        bonusUsedTiao: bonusGranted === null ? null : toTiao(Math.max(0, bonusGranted - (cq.bonus || 0))),
        grantSince: CREDIT_GRANT_TRACKING_SINCE,
        remainTodayTiao: toTiao(cq.remainToday),
        usedTodayTiao: toTiao(cq.usedToday),
        dailyCapTiao: toTiao(cq.dailyCap),
        remainTiao: toTiao(cq.creditRemain),
      },
      plus: plan === 'plus'
        ? { limit: CHAT_DAILY_LIMIT, usedToday: chatUsedToday, remainToday: Math.max(0, CHAT_DAILY_LIMIT - chatUsedToday) }
        : null,
      genCredit: user.genCredit || 0,
      pendingReward: user.pendingReward ? { count: user.pendingReward.count, reason: user.pendingReward.reason } : null,
    };
  }

  /**
   * 每日点数上限。**两种口径，靠 `CREDIT_QUOTA_ENABLED` 切换**：
   * - 统一口径（开关打开）：Pro = **无限**（`Infinity`）——「无限」就写无限，不再"有的无限、有的上限"；
   *   成本靠内部安全阀兜（AI 托管 / 生成剧本硬顶 + 异常用量告警），不占对外权益行。
   * - 旧口径（开关关闭）：Pro 仍按 `PRO_DAILY_CREDIT` 兜底——**线上狼人杀旁路此刻在用这套值**，
   *   保持原样，避免在正式切换前改变线上行为。
   */
  private creditDailyCap(user: UserRecord): number {
    const plan = this.getPlan(user);
    if (isCreditQuotaEnabled() && plan === 'pro') return Infinity;
    if (plan === 'pro') return PRO_DAILY_CREDIT;
    if (plan === 'plus') return PLUS_DAILY_CREDIT;
    // 免费档再分两种（2026-09-27 用户拍板）：**注册账号 20 条/天；游客 5 条/天**。
    // 判据 = 是否在账号表里（accounts.json），唯一实现见 isRegisteredAccount()。
    return this.isRegisteredAccount(user.userId) ? FREE_DAILY_CREDIT : GUEST_DAILY_CREDIT;
  }

  /**
   * 统一点数（credit）配额状态。前端可用 creditRemain 换算成「≈ 还能聊 N 条」。
   *
   * ⚠️ 无限档（统一口径的 Pro）**不能**返回 `Infinity`：`JSON.stringify(Infinity)` 会变成 `null`，
   *    前端 `?? 0` 会当成「剩余 0」。因此用 `unlimited: true` 表达，数值字段一律 `null`。
   */
  getCreditQuota(userId: string) {
    const user = this.ensureUser(userId);
    const plan = this.getPlan(user);
    const dailyCap = this.creditDailyCap(user);
    const unlimited = !Number.isFinite(dailyCap);
    const today = this.todayKey();
    // ⚠️ 已用量取「**共用这一份日额度**的记录集合」的合计（2026-09-27 设备维度）：
    //    游客换 IP 只是换了个身份 id，额度必须跟着**设备**走，否则换网络就再领一份 5 条。
    //    账号 / 无设备号记录 → 集合只有自己，与改造前逐字等价。
    const usedToday = this.poolUsedToday(user, today);
    const bonus = user.creditBonus || 0;
    const remainToday = unlimited ? null : Math.max(0, dailyCap - usedToday);
    const creditRemain = unlimited ? null : bonus + (remainToday as number);
    return {
      plan,
      dailyCap: unlimited ? null : dailyCap,
      unlimited,
      usedToday,
      remainToday,
      bonus,
      creditRemain,
      canUse: unlimited || (creditRemain as number) > 0,
    };
  }

  /**
   * 预扣统一点数（调用前）。按预估 credit 预扣，返回预留令牌供结算/回滚。
   * 先扣持久赠送（creditBonus），再扣每日上限；余额/上限不足 → 拒绝。
   */
  reserveCredit(userId: string, feature: string, estimate: { credit: number }): { ok: boolean; token?: string; reserved?: number; reason?: 'no-credit' | 'fair-use' } {
    const user = this.ensureUser(userId);
    const dailyCap = this.creditDailyCap(user);
    const today = this.todayKey();
    if (user.creditDate !== today) { user.creditDate = today; user.creditUsedToday = 0; }
    const ownUsedToday = user.creditUsedToday || 0;
    const bonus = user.creditBonus || 0;
    /**
     * ⚠️ 两笔量必须分清楚（2026-09-27 设备维度合并，写错就是重复扣或漏扣）：
     *  - `poolUsedToday`：**这一档今天总共用了多少**（游客 = 同设备所有身份的合计）→ 只用于判上限；
     *  - `ownUsedToday`：**这条记录自己用了多少** → 只用于写回自己的账（`user.creditUsedToday`）。
     * 若拿合计去写回单条记录，兄弟身份的用量会被重复计入这条记录（换 IP 一次就多扣一次）。
     */
    const poolUsedToday = this.poolUsedToday(user, today);
    const remainToday = Math.max(0, dailyCap - poolUsedToday);
    const reserved = Math.max(1, Math.round(estimate?.credit || 0));
    this.warnIfNotTiao(reserved, 'reserveCredit');
    // 无限档（Pro）：只看**真实消耗**这一侧，超过公平使用阀就拒绝（bonus 是用户自己攒的，不参与封顶）
    if (!Number.isFinite(dailyCap) && ownUsedToday + reserved > PRO_FAIR_USE_CREDIT) {
      return { ok: false, reason: 'fair-use' };
    }
    if (reserved > bonus + remainToday) return { ok: false, reason: 'no-credit' };
    const fromBonus = Math.min(bonus, reserved);
    const fromDaily = reserved - fromBonus;
    user.creditBonus = bonus - fromBonus;
    user.creditUsedToday = ownUsedToday + fromDaily;
    const token = crypto.randomUUID();
    this.creditReservations.set(token, { userId, reserved, bonusUsed: fromBonus, dailyUsed: fromDaily, feature, at: Date.now() });
    this.saveToDisk();
    // 预扣即已落账 → 这里是**每一笔真实消耗**的必经之路（settle 在 diff=0 时会提前返回，不能只挂那边）
    this.checkHeavyUsageAlert(user);
    return { ok: true, token, reserved };
  }

  /**
   * 结算（多退少补）：用真实 usage 折算的 actualCredit 与预扣 reserved 比较，
   * 少扣则退还，多扣补收。失败/内容被拒时走 rollbackCredit 全额退还。
   */
  /** 告警去重：`${userId}:${date}` —— 当天只报一次，避免刷日志 */
  private heavyUsageAlerted = new Set<string>();

  /**
   * 重度用量告警（只告警、不拦截）：越过 `HEAVY_USAGE_ALERT_CREDIT` 时写一条运营审计 + 服务端 warn。
   * 目的：让"有人一天烧掉一个月收入"这件事**当天可见**，而不是月底对账才发现。
   */
  private checkHeavyUsageAlert(user: { userId: string; creditUsedToday?: number; creditDate?: string }): void {
    const used = user.creditUsedToday || 0;
    if (used < HEAVY_USAGE_ALERT_CREDIT) return;
    const key = `${user.userId}:${user.creditDate || this.todayKey()}`;
    if (this.heavyUsageAlerted.has(key)) return;
    this.heavyUsageAlerted.add(key);
    const tiao = Math.round(used / UNIT_CREDIT);
    console.warn(`⚠️ [Quota] 重度用量：user=${user.userId.slice(0, 8)} 今日 ${used} 点（≈${tiao} 条）已越过告警线 ${HEAVY_USAGE_ALERT_CREDIT} 点`);
    void import('./audit.js')
      .then(({ auditStore }) => auditStore.log('heavy_usage', `重度用量告警：${user.userId.slice(0, 8)} 今日 ${used} 点（≈${tiao} 条），档位 ${this.getPlan(user as never)}`))
      .catch(() => { /* 审计失败不影响计费 */ });
  }

  settleCredit(userId: string, token: string, actualCredit: number): void {
    const res = this.creditReservations.get(token);
    if (!res) return;
    this.creditReservations.delete(token);
    const user = this.users.get(userId);
    if (!user) return;
    const actual = Math.max(0, Math.round(actualCredit || 0));
    this.warnIfNotTiao(actual, 'settleCredit');
    const diff = actual - res.reserved;
    if (diff === 0) return;
    if (diff < 0) {
      // 退还预扣差额：先退回 bonus 部分，多出的退回每日
      let refund = -diff;
      const toBonus = Math.min(refund, res.bonusUsed);
      user.creditBonus = (user.creditBonus || 0) + toBonus;
      refund -= toBonus;
      if (refund > 0) {
        user.creditUsedToday = Math.max(0, (user.creditUsedToday || 0) - refund);
      }
    } else {
      // 实际比预估更贵：从当前结余补收（先 bonus 后每日）
      const charge = diff;
      const bonusAvail = user.creditBonus || 0;
      if (bonusAvail >= charge) {
        user.creditBonus = bonusAvail - charge;
      } else {
        user.creditBonus = 0;
        user.creditUsedToday = (user.creditUsedToday || 0) + (charge - bonusAvail);
      }
    }
    this.checkHeavyUsageAlert(user);
    this.saveToDisk();
  }

  /** 结算：保留预扣的点数（按预计值计费，不校正）——适用于「估算值足够」的功能，清理预留令牌即可 */
  commitCredit(userId: string, token: string): void {
    const res = this.creditReservations.get(token);
    if (!res) return;
    this.creditReservations.delete(token);
  }

  /** 回滚预扣（AI 调用失败 / 内容被拒：全额退还预留） */
  rollbackCredit(userId: string, token: string): void {
    const res = this.creditReservations.get(token);
    if (!res) return;
    this.creditReservations.delete(token);
    const user = this.users.get(userId);
    if (!user) return;
    user.creditBonus = (user.creditBonus || 0) + res.bonusUsed;
    user.creditUsedToday = Math.max(0, (user.creditUsedToday || 0) - res.dailyUsed);
    this.checkHeavyUsageAlert(user);
    this.saveToDisk();
  }

  /**
   * 账本硬性规则的**哨兵**（只告警、不抛错）：进出账本的点数必须是 `UNIT_CREDIT` 的整数倍。
   * 为什么只告警：线上宁可先记一笔（便于立刻发现下一个漏点），也不要因为一次记账把用户的对话打断。
   * 出现这条 warn = 有新代码绕过了 `round/ceil/floorCreditToTiao`，请顺手对齐。
   */
  private warnIfNotTiao(points: number, where: string): void {
    if (!Number.isFinite(points) || points % UNIT_CREDIT === 0) return;
    console.warn(`⚠️ [Quota] 非整条点数进出账本：${where} ${points} 点（UNIT_CREDIT=${UNIT_CREDIT}）——请用 roundCreditToTiao / ceilCreditToTiao / floorCreditToTiao 对齐`);
  }

  /** 给用户增加持久点数（注册/邀请/反馈/打卡），先于每日上限消耗 */
  addCreditBonus(userId: string, count: number, reason: string = 'reward'): void {
    const user = this.ensureUser(userId);
    const n = Math.max(0, Math.round(count));
    if (n <= 0) return;
    this.warnIfNotTiao(n, 'addCreditBonus');
    user.creditBonus = (user.creditBonus || 0) + n;
    // 累计获得（只统计；退款/结算补收**不算**发放，见 settleCredit / rollbackCredit 不动它）
    user.creditGrantedTotal = (user.creditGrantedTotal || 0) + n;
    const prev = user.pendingReward?.count || 0;
    user.pendingReward = { count: prev + n, reason, at: Date.now() };
    this.saveToDisk();
  }

  /**
   * 只把点数退回余额、**不计入「累计获得」**（退款 / 补偿专用）。
   *
   * 为什么必须与 `addCreditBonus` 分开：控制台的「赠送已用」= 累计获得 − 余额。
   * 退款若被当成「发放」，累计就虚高、已用虚低 —— 运营端会以为用户几乎没消耗（2026-09-29 修）。
   * 典型场景：狼人杀局账的预留令牌随进程重启丢失，结算时只能直接退余额（`wolfchaCompat`）。
   * 另外它**不写 pendingReward**：退款不是奖励，不该给用户弹「恭喜获得额度」。
   */
  refundCreditBonus(userId: string, points: number, _reason: string = 'refund'): void {
    const user = this.ensureUser(userId);
    const n = Math.max(0, Math.round(points));
    if (n <= 0) return;
    this.warnIfNotTiao(n, 'refundCreditBonus');
    user.creditBonus = (user.creditBonus || 0) + n;
    this.saveToDisk();
  }

  /** 把真实 usage 折算成点数（含缓存折扣；结算用） */
  creditFromUsage(usage: unknown): number {
    return Math.max(0, Math.round(costFromUsage(usage as any) * CREDIT_PER_YUAN));
  }

  /**
   * 消耗一次聊一聊额度（AI 调用失败时用 rollbackChat 回滚）
   */
  consumeChat(userId: string): boolean {
    const user = this.ensureUser(userId);
    const plan = this.getPlan(user);
    if (plan === 'pro') return true;
    if (plan === 'plus') {
      const today = this.todayKey();
      if (user.chatDate !== today) { user.chatDate = today; user.chatCount = 0; }
      if ((user.chatCount || 0) >= CHAT_DAILY_LIMIT) return false;
      user.chatCount = (user.chatCount || 0) + 1;
      this.saveToDisk();
      return true;
    }
    // free：独立对话池（含注册奖励）
    const chatTotal = FREE_CHAT + (user.chatBonusFree || 0);
    if ((user.chatFreeUsed || 0) >= chatTotal) return false;
    user.chatFreeUsed = (user.chatFreeUsed || 0) + 1;
    this.saveToDisk();
    return true;
  }

  /**
   * 回滚一次聊一聊扣减（AI 调用失败时）
   */
  rollbackChat(userId: string): void {
    const user = this.users.get(userId);
    if (!user) return;
    const plan = this.getPlan(user);
    if (plan === 'plus') {
      if ((user.chatCount || 0) > 0) {
        user.chatCount = (user.chatCount || 0) - 1;
        this.saveToDisk();
      }
    } else if (plan === 'free') {
      if ((user.chatFreeUsed || 0) > 0) {
        user.chatFreeUsed = (user.chatFreeUsed || 0) - 1;
        this.saveToDisk();
      }
    }
    // pro：无扣减
  }

  /**
   * 设置会员等级（运营端：授予/调整 plus / pro / lifetime）
   */
  setPlan(userId: string, plan: 'plus' | 'pro' | 'lifetime' | 'free'): UserRecord {
    const user = this.ensureUser(userId);
    if (plan === 'pro') user.plan = 'pro';
    else if (plan === 'plus') user.plan = 'plus';
    else if (plan === 'lifetime') user.plan = 'lifetime';
    else delete user.plan;
    this.saveToDisk();
    return user;
  }

  /**
   * 游客数据并入账号（注册/登录成功后调用）：把游客期间的配额使用/奖励带到账号，避免额度清零
   * 保留游客记录不删除（防止登出后游客端"刷新"出全新额度刷羊毛）
   */
  mergeFrom(guestId: string, accountId: string): void {
    if (!guestId || !accountId || guestId === accountId) return;
    const g = this.ensureUser(guestId);
    const a = this.ensureUser(accountId);
    a.freeUsed = Math.max(a.freeUsed || 0, g.freeUsed || 0);
    a.chatFreeUsed = Math.max(a.chatFreeUsed || 0, g.chatFreeUsed || 0);
    a.bonusFree = Math.max(a.bonusFree || 0, g.bonusFree || 0);
    a.chatBonusFree = Math.max(a.chatBonusFree || 0, g.chatBonusFree || 0);
    a.inviteCount = Math.max(a.inviteCount || 0, g.inviteCount || 0);
    if ((g.unlockUntil || 0) > (a.unlockUntil || 0)) a.unlockUntil = g.unlockUntil;
    if (g.plan === 'lifetime' || g.plan === 'pro') a.plan = g.plan;
    else if (g.plan === 'plus' && a.plan !== 'pro' && a.plan !== 'lifetime') a.plan = 'plus';
    if (g.invitedBy && !a.invitedBy) a.invitedBy = g.invitedBy;
    if (g.inviteeRewardedInviter) a.inviteeRewardedInviter = true;
    // 邀请结算状态（B 方案）：待激活标记与结算结果都要跟着走，否则并号后要么重复发奖、要么永远发不出
    if (g.invitePending && !a.inviteQualifiedAt) {
      a.invitePending = true;
      a.invitePendingAt = a.invitePendingAt || g.invitePendingAt;
    }
    if (g.inviteQualifiedAt && !a.inviteQualifiedAt) {
      a.inviteQualifiedAt = g.inviteQualifiedAt;
      a.invitePending = false;
      a.inviteGrantedCredits = g.inviteGrantedCredits || 0;
      a.inviteGrantedBoost = g.inviteGrantedBoost;
    }
    if (!a.inviteDeviceKey && g.inviteDeviceKey) a.inviteDeviceKey = g.inviteDeviceKey;
    if (!a.inviteIp && g.inviteIp) a.inviteIp = g.inviteIp;
    if (!a.lastDeviceKey && g.lastDeviceKey) a.lastDeviceKey = g.lastDeviceKey;
    if (!a.lastIp && g.lastIp) a.lastIp = g.lastIp;
    this.saveToDisk();
    console.log(`🔀 [Quota] 游客配额并入账号: guest=${guestId.slice(0, 8)} -> account=${accountId.slice(0, 8)}`);
  }

  /**
   * 消耗一次免费额度（占位扣减）。解锁期内不扣。
   * @returns 是否允许使用
   */
  consume(userId: string): boolean {
    const user = this.ensureUser(userId);
    if (this.isUnlocked(user)) return true;
    if (this.getPlan(user) === 'pro') return true; // Pro（含 7 天体验）：理一理不限量
    const totalFree = FREE_STRUCT + (user.bonusFree || 0); // 理一理池
    if (user.freeUsed >= totalFree) return false;
    user.freeUsed += 1;
    this.saveToDisk();
    return true;
  }

  /**
   * 奖励入账的唯一出口（注册 / 邀请 / 反馈 / 打卡）。
   *
   * **统一口径下只发点数**（`creditBonus`），不再往「条」池里加——否则同一个用户会同时持有
   * 点数余额与旧的条数余额，正是本次要消灭的两套账。
   * `count` 的口径始终是「条」：换算 = `count × UNIT_CREDIT`，用户拿到的当量不变。
   */
  private grantReward(user: UserRecord, count: number, reason: string, pool: 'structure' | 'chat', note?: string): void {
    if (count > 0 && isCreditQuotaEnabled()) {
      const pts = Math.max(0, Math.round(count * UNIT_CREDIT));
      user.creditBonus = (user.creditBonus || 0) + pts;
      // 累计获得（只统计；与 addCreditBonus 同一口径，两处都必须记，否则「已用」会虚高）
      user.creditGrantedTotal = (user.creditGrantedTotal || 0) + pts;
    } else if (pool === 'structure') {
      user.bonusFree = (user.bonusFree || 0) + count;
    } else {
      user.chatBonusFree = (user.chatBonusFree || 0) + count;
    }
    // 记录待通知奖励：用户下次登录/刷新时，前端拉配额看到 pendingReward 后恭喜提示并消费
    const prev = user.pendingReward?.count || 0;
    // note 只在本条奖励**带了附言**时覆盖（后到的无附言奖励不清掉上一条还没读的附言）
    const keptNote = note ? String(note).slice(0, 500) : user.pendingReward?.note;
    user.pendingReward = {
      count: prev + count,
      reason,
      at: Date.now(),
      ...(keptNote ? { note: keptNote } : {}),
    };
    this.saveToDisk();
  }

  /**
   * 给用户增加额外免费次数（注册/邀请/反馈/打卡奖励）
   * @param reason 奖励原因（用于邮件与站内恭喜提示）
   * @param note 运营者随奖励写给用户的话（可选）：会进 pendingReward，供站内弹窗展示
   */
  addBonus(userId: string, count: number = INVITE_BONUS, reason: string = 'reward', note?: string): void {
    this.grantReward(this.ensureUser(userId), count, reason, 'structure', note);
  }


  /**
   * 给用户增加对话池额度（限时活动：注册即送 chat credit）
   * @param reason 奖励原因（用于邮件与站内恭喜提示）
   */
  addChatBonus(userId: string, count: number, reason: string = 'reward'): void {
    this.grantReward(this.ensureUser(userId), count, reason, 'chat');
  }

  /**
   * 「提交反馈」奖励：已注册用户每天可领一次对话额度（反馈奖励，用于额度用尽后继续免费使用）。
   * 与邀请/注册奖励同池（chatBonusFree），并向 pendingReward 记一条待通知奖励。
   * @returns 本次是否真的发放（今天已领过返回 granted=false）
   */
  grantFeedbackReward(userId: string): { granted: boolean; count: number } {
    const user = this.ensureUser(userId);
    const today = this.todayKey();
    if (user.feedbackRewardDate === today) return { granted: false, count: 0 };
    const count = FEEDBACK_REWARD_CHAT;
    if (count <= 0) return { granted: false, count: 0 };
    user.feedbackRewardDate = today;
    this.grantReward(user, count, 'feedback', 'chat');
    return { granted: true, count };
  }

  /**
   * 限时注册活动是否进行中（基于 .env 的起止日期，含当天）
   */
  isChatBonusActive(): boolean {
    const now = new Date();
    if (CHAT_BONUS_START) {
      const start = new Date(CHAT_BONUS_START + 'T00:00:00');
      if (now < start) return false;
    }
    if (CHAT_BONUS_END) {
      const end = new Date(CHAT_BONUS_END + 'T23:59:59');
      if (now > end) return false;
    }
    return true;
  }

  /**
   * 消费（清除）待通知的奖励：前端展示恭喜提示后调用，避免重复弹出
   */
  consumeReward(userId: string): void {
    const user = this.users.get(userId);
    if (user && user.pendingReward) {
      delete user.pendingReward;
      this.saveToDisk();
    }
  }

  /**
   * 邀请人是否还能成功邀请（防刷上限）
   */
  canInviteMore(userId: string): boolean {
    const user = this.users.get(userId);
    return (user?.inviteCount || 0) < INVITE_MAX;
  }

  /**
   * 邀请人本单应得的加成倍数（B 方案·2026-09-19）：邀请人账号注册 ≤ N 天 → ×BOOST。
   * 把「7 天」从门槛改成**加成窗口**：同一笔防刷预算，用来奖励早期口碑传播者。
   */
  inviteBoostFor(inviterId: string): number {
    const acc = accountStore.getById(inviterId);
    if (!acc || !(REFERRAL_NEW_ACCOUNT_BOOST > 1) || REFERRAL_NEW_ACCOUNT_BOOST_DAYS <= 0) return 1;
    const ageDays = (Date.now() - (acc.createdAt || 0)) / 86400000;
    return ageDays <= REFERRAL_NEW_ACCOUNT_BOOST_DAYS ? REFERRAL_NEW_ACCOUNT_BOOST : 1;
  }

  /**
   * 注册期反套利通过 → 进入「待激活」（**不发邀请人奖励**，等被邀人首次真实使用）。
   * 被邀人（朋友）自己那一份在注册时就发（`auth.ts` 走 addChatBonus），
   * 这里只记状态 + 台账（`signup_pending`），供控制台显示「人来了、还没开口」。
   */
  markInvitePending(inviteeId: string, inviteeCredits: number = 0): void {
    const invitee = this.ensureUser(inviteeId);
    const inviterId = invitee.invitedBy;
    if (!inviterId || inviterId === inviteeId) return;
    invitee.invitePending = true;
    invitee.invitePendingAt = Date.now();
    this.saveToDisk();
    try {
      referralEventStore.log({
        at: Date.now(),
        kind: 'signup_pending',
        inviterId,
        inviteeId,
        inviteeCredits,
        reason: 'awaiting-first-use',
        note: 'register',
      });
    } catch (e) {
      console.warn('⚠️ [Invite] 台账记录失败:', (e as Error)?.message);
    }
  }

  /**
   * 被邀人**首次真实使用**（任一功能第一次跑通）→ 结算邀请奖励（B 方案的核心：门槛装在被邀人侧）。
   *
   * - 幂等：`inviteQualifiedAt` 一落就不再重试（无论成功还是被拦）。
   * - 复查的是「时间无关」的条件（邀请人是否还是账号、上限是否还有余位）；
   *   设备/IP 反套利在**注册当刻**已判过（那时才拿得到双方真实环境，事后邀请人的 lastDeviceKey/lastIp 会漂移）。
   * - 加成：邀请人注册 ≤ REFERRAL_NEW_ACCOUNT_BOOST_DAYS 天 → 额度 ×REFERRAL_NEW_ACCOUNT_BOOST（四舍五入到整条）。
   * - 发放走 `grantReward`（会写 pendingReward，邀请人下次打开就看到恭喜提示）。
   * @returns 结算结果（`settled=false` 表示这次调用没触发结算）
   */
  qualifyInvite(inviteeId: string): { settled: boolean; inviter: string | null; inviterCredits: number; boost: number; reason?: string } {
    const invitee = this.users.get(inviteeId);
    if (!invitee || !invitee.invitePending || invitee.inviteQualifiedAt) {
      return { settled: false, inviter: null, inviterCredits: 0, boost: 1, reason: 'not-pending' };
    }
    const inviterId = invitee.invitedBy;
    const settle = (reason?: string, inviterCredits = 0, boost = 1, inviter: string | null = null) => {
      invitee.inviteQualifiedAt = Date.now();
      invitee.invitePending = false;
      invitee.inviteGrantedCredits = inviterCredits;
      invitee.inviteGrantedBoost = boost;
      this.saveToDisk();
      if (reason) this.logSignupRejected(inviterId!, inviteeId, reason);
      return { settled: true, inviter, inviterCredits, boost, reason };
    };

    if (!inviterId || inviterId === inviteeId) return settle('no-inviter');
    if (!accountStore.getById(inviterId)) return settle('inviter-not-account');
    if (!this.canInviteMore(inviterId)) return settle('inviter-cap-reached');

    const boost = this.inviteBoostFor(inviterId);
    const credits = Math.max(1, Math.round(INVITE_BONUS * boost));
    this.addBonus(inviterId, credits, 'invite'); // 发放（含 pendingReward 恭喜提示）
    this.recordInvite(inviterId);
    console.log(`🎁 [Invite] 被邀人首次使用 → 结算: inviter=${inviterId.slice(0, 8)} +${credits}条${boost > 1 ? `（新账号加成 ×${boost}）` : ''}`);
    try {
      referralEventStore.log({
        at: Date.now(),
        kind: 'signup',
        inviterId,
        inviteeId,
        credits,
        boost,
        reason: 'qualified',
        note: 'first-use',
      });
    } catch (e) {
      console.warn('⚠️ [Invite] 台账记录失败:', (e as Error)?.message);
    }
    return settle(undefined, credits, boost, inviterId);
  }

  /**
   * 邀请人邀请人数 +1（只统计**已结算**的邀请：被邀人开口后）
   */
  recordInvite(userId: string): void {
    const user = this.ensureUser(userId);
    user.inviteCount = (user.inviteCount || 0) + 1;
    this.saveToDisk();
  }

  /**
   * 记一条「推广链接注册但**没发奖励**」的台账（只记录，不发放）。
   * 用途：控制台「📣 邀请推广」下钻明细要能回答「人来了为什么没给邀请人算奖励」——
   * 这个判定依赖**当时**的设备/IP 环境，事后无法可靠还原，所以必须在判定当刻留痕。
   * @param reason same-device / same-ip / inviter-too-new / inviter-not-account / inviter-cap-reached / self-invite
   */
  logSignupRejected(inviterId: string, inviteeId: string, reason: string): void {
    if (!inviterId || !inviteeId || !reason) return;
    try {
      referralEventStore.log({
        at: Date.now(),
        kind: 'signup_rejected',
        inviterId,
        inviteeId,
        reason,
        note: 'register',
      });
    } catch (e) {
      console.warn('⚠️ [Invite] 台账记录失败:', (e as Error)?.message);
    }
  }

  /**
   * 记一条「注册即邀请成功」的推广台账（**只记录，不发放**）：
   * 供控制台「用户行为 → 📣 邀请推广」按区间统计「谁的链接被用了、拉了多少人、赚了多少额度」。
   * 发放本身仍由调用方（auth.ts）走 addBonus/recordInvite，台账写失败不影响用户拿到的奖励。
   */
  logSignupInvite(inviterId: string, inviteeId: string, credits: number, inviteeCredits: number = 0, boost: number = 1, note: string = 'register'): void {
    try {
      referralEventStore.log({
        at: Date.now(),
        kind: 'signup',
        inviterId,
        inviteeId,
        credits,
        inviteeCredits,
        ...(boost > 1 ? { boost } : {}),
        reason: 'valid',
        note,
      });
    } catch (e) {
      console.warn('⚠️ [Invite] 台账记录失败:', (e as Error)?.message);
    }
  }

  /**
   * 记一条「预设邀请码被使用」的推广台账（**只记录，不发放**）：
   * 与 `logSignupInvite` 同源，供控制台「用户行为 → 📣 邀请推广」把邀请码也按区间统计
   * （哪个码被用了几次、区间内发出多少额度）。码没有推广人，`inviterId` 用 `'code:' + 码` 占位。
   */
  logInviteCodeUse(code: string, inviteeId: string, credits: number): void {
    const c = String(code || '').trim().toLowerCase();
    if (!c || !inviteeId || !(credits > 0)) return;
    try {
      referralEventStore.log({
        at: Date.now(),
        kind: 'code',
        inviterId: 'code:' + c,
        inviteeId,
        code: c,
        credits,
        note: 'invite_code',
      });
    } catch (e) {
      console.warn('⚠️ [InviteCode] 台账记录失败:', (e as Error)?.message);
    }
  }

  /** 记录注册时使用的预设邀请码（小写），供控制台按码统计注册人数 */
  setInviteCodeUsed(userId: string, code: string): void {
    const c = String(code || '').trim().toLowerCase();
    if (!c) return;
    const user = this.ensureUser(userId);
    if (user.inviteCodeUsed !== c) {
      user.inviteCodeUsed = c;
      this.saveToDisk();
    }
  }
  /**
   * 注册后**补填**预设邀请码（2026-09 补填入口）。
   * 与注册链路**同源的发放逻辑集中在这里**，避免「注册发放」和「补填发放」两处各写一遍导致口径漂移
   * （额度口径 / 台账 referral-events / inviteCodeUsed 三者必须一致）。
   * 规则：一人一次（已填过直接拒），码必须命中预设表（INVITE_CODES）。
   */
  applyInviteCode(userId: string, code: string): { ok: true; bonus: number } | { ok: false; reason: 'invalid-code' | 'already-used' } {
    const c = String(code || '').trim().toLowerCase();
    const bonus = getPresetInviteBonus(c);
    if (!c || !(bonus > 0)) return { ok: false, reason: 'invalid-code' };
    const user = this.ensureUser(userId);
    if (user.inviteCodeUsed) return { ok: false, reason: 'already-used' };
    this.addChatBonus(userId, bonus, 'invite_code');
    this.setInviteCodeUsed(userId, c);
    this.logInviteCodeUse(c, userId, bonus);
    return { ok: true, bonus };
  }

  /** 按预设邀请码统计注册人数：{ code: count } */
  countByInviteCode(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const u of this.users.values()) {
      if (u.inviteCodeUsed) out[u.inviteCodeUsed] = (out[u.inviteCodeUsed] || 0) + 1;
    }
    return out;
  }

  /**
   * 回滚一次扣减（AI 调用失败时）
   */
  rollback(userId: string): void {
    const user = this.users.get(userId);
    if (user && user.freeUsed > 0) {
      user.freeUsed -= 1;
      this.saveToDisk();
    }
  }

  /**
   * 列出所有用户记录（用于管理端）
   */
  listAll(): UserRecord[] {
    return Array.from(this.users.values());
  }

  /**
   * 删除用户记录（账户注销时）
   */
  removeUser(userId: string): void {
    if (this.users.delete(userId)) this.saveToDisk();
  }

  /**
   * 解锁用户（付费确认后调用）
   * @param plan 会员等级：默认 plus；运营端可传 pro 授予完整开放
   */
  unlock(userId: string, days: number = UNLOCK_DAYS, plan: 'plus' | 'pro' = 'plus'): number {
    const user = this.ensureUser(userId);
    const base = user.unlockUntil && user.unlockUntil > Date.now() ? user.unlockUntil : Date.now();
    user.unlockUntil = base + days * 24 * 60 * 60 * 1000;
    // 续费不降级：当前已是更高档时保持原档（如 pro 续 plus 仍保持 pro）
    const rank: Record<string, number> = { free: 0, plus: 1, pro: 2, lifetime: 3 };
    const current = rank[user.plan || 'free'] ?? 0;
    const next = rank[plan] ?? 1;
    user.plan = next >= current ? plan : (user.plan || 'plus');
    this.saveToDisk();
    return user.unlockUntil;
  }

  /**
   * 买断（终身）：置 lifetime 档 + 远期有效期（≈10 年，前端按 >3650 天展示「永久会员」）
   */
  unlockLifetime(userId: string, plan: 'plus' | 'pro' = 'pro'): number {
    const user = this.ensureUser(userId);
    const until = Date.now() + 3650 * 24 * 60 * 60 * 1000;
    if ((user.unlockUntil || 0) < until) user.unlockUntil = until;
    if (plan === 'pro') user.plan = 'lifetime';
    else if (plan === 'plus' && user.plan !== 'lifetime') user.plan = 'plus';
    this.saveToDisk();
    return user.unlockUntil ?? 0;
  }

  /** 读取用户记录（邀请奖励/运营用） */
  getRecord(userId: string): UserRecord | undefined {
    return this.users.get(userId);
  }

  /** 设备指纹哈希（纯设备，跨 IP 稳定） */
  private devKey(deviceId: string): string {
    return this.identifyByDevice(deviceId || '');
  }

  /**
   * 记录用户最近一次设备/IP（供引荐「设备/IP 不同」反套利比较）。
   * 在用户常出现的路径（/api/payment/quota、注册/登录）调用，廉价幂等。
   */
  noteDevice(userId: string, deviceId: string, ip?: string): void {
    const u = this.ensureUser(userId);
    if (deviceId) u.lastDeviceKey = this.devKey(deviceId);
    if (ip) u.lastIp = ip;
    this.saveToDisk();
  }

  /** 注册时记录邀请归属（被邀人 → 邀请人）+ 记录被邀人注册设备/IP，供「设备/IP 不同」反套利 */
  setInvitedBy(userId: string, inviterId: string, deviceId?: string, ip?: string): void {
    if (!userId || !inviterId || userId === inviterId) return;
    const u = this.ensureUser(userId);
    if (!u.invitedBy) {
      u.invitedBy = inviterId;
      if (deviceId) u.inviteDeviceKey = this.devKey(deviceId);
      if (ip) u.inviteIp = ip;
      this.saveToDisk();
    }
  }

  /** 给用户延长会员天数（邀请人奖励：+7 天同档；不降级） */
  addMemberDays(userId: string, days: number, plan: 'plus' | 'pro' = 'plus'): number {
    const user = this.ensureUser(userId);
    const base = user.unlockUntil && user.unlockUntil > Date.now() ? user.unlockUntil : Date.now();
    user.unlockUntil = base + days * 24 * 60 * 60 * 1000;
    const rank: Record<string, number> = { free: 0, plus: 1, pro: 2, lifetime: 3 };
    const current = rank[user.plan || 'free'] ?? 0;
    const next = rank[plan] ?? 1;
    if (user.plan !== 'lifetime' && next > current) user.plan = plan;
    this.saveToDisk();
    return user.unlockUntil;
  }

  /**
   * 引荐是否有效（反套利）。每次处理时实时校验，`now` 可注入便于测试。
   * 1) 邀请人 ≠ 被邀人（有邀请归属）
   * 2) 邀请人须为注册账号（游客分享的链接不计）
   * 3) 邀请人注册满 REFERRAL_INVITER_MIN_DAYS 天——**默认 0 = 不设年龄门槛**（2026-09-19 B 方案改由被邀人侧门槛承担防刷）
   * 4) 设备/IP 不同：被邀人注册设备/IP 不得与邀请人最近设备/IP 相同（任一相同即视为自邀）
   */
  isReferralValid(inviteeUserId: string, now: number = Date.now()): { valid: boolean; reason?: string } {
    const invitee = this.users.get(inviteeUserId);
    const inviterId = invitee?.invitedBy;
    if (!inviterId || inviterId === inviteeUserId) return { valid: false, reason: 'no-inviter' };
    const acc = accountStore.getById(inviterId);
    if (!acc) return { valid: false, reason: 'inviter-not-account' };
    const ageDays = (now - (acc.createdAt || 0)) / 86400000;
    if (ageDays < REFERRAL_INVITER_MIN_DAYS) return { valid: false, reason: 'inviter-too-new' };
    const inviter = this.users.get(inviterId);
    const sameDevice = !!inviter?.lastDeviceKey && !!invitee?.inviteDeviceKey && inviter.lastDeviceKey === invitee.inviteDeviceKey;
    if (sameDevice) return { valid: false, reason: 'same-device' };
    const sameIp = !!inviter?.lastIp && !!invitee?.inviteIp && inviter.lastIp === invitee.inviteIp;
    if (sameIp) return { valid: false, reason: 'same-ip' };
    return { valid: true };
  }

  /**
   * 被邀人付费 → 引荐奖励（买一送一 + 被邀人月付送半月）。副作用 + 返回值。
   * - 邀请人：得同档会员，时长 = 被邀人购买天数，封顶「年付」(REFERRAL_YEARLY_CAP_DAYS)；
   *   仅被邀人「首购」奖一次（inviteeRewardedInviter）；Lifetime 档也封顶为年付天数。
   * - 被邀人：月付(monthly) 且引荐有效 → 返回 friendBonusDays（默认 +15 天）供调用方在解锁时加算。
   * - 首购但引荐无效：也标记已处理，避免「等邀请人满 N 天再买」的延迟套利。
   */
  rewardInviterForPurchase(
    inviteeId: string,
    plan: 'plus' | 'pro' = 'plus',
    purchase: 'monthly' | 'yearly' | 'lifetime' = 'monthly',
    days: number = UNLOCK_DAYS,
  ): { inviter: string | null; inviterDays: number; friendBonusDays: number; valid: boolean; reason?: string } {
    const invitee = this.users.get(inviteeId);
    const inviterId = invitee?.invitedBy;
    if (!inviterId) return { inviter: null, inviterDays: 0, friendBonusDays: 0, valid: false, reason: 'no-inviter' };
    const v = this.isReferralValid(inviteeId);
    const valid = v.valid;

    let inviter: string | null = null;
    let inviterDays = 0;
    if (valid && inviterId !== inviteeId && !invitee!.inviteeRewardedInviter) {
      const grantDays = Math.max(0, Math.min(days || 0, REFERRAL_YEARLY_CAP_DAYS));
      if (grantDays > 0) {
        this.addMemberDays(inviterId, grantDays, plan);
        inviter = inviterId;
        inviterDays = grantDays;
      }
      invitee!.inviteeRewardedInviter = true;
      this.saveToDisk();
    } else if (!invitee!.inviteeRewardedInviter && !valid) {
      // 首购但引荐无效：标记已处理，避免延迟套利
      invitee!.inviteeRewardedInviter = true;
      this.saveToDisk();
    }

    // 被邀人月付：引荐有效 → 送半月
    const friendBonusDays = valid && purchase === 'monthly' ? REFERRAL_MONTHLY_BONUS_DAYS : 0;

    // —— 推广台账（只记录，不发放）：邀请人获得的会员天数 + 被邀人月付加赠天数 ——
    // 放在这里而不是各个调用点（Stripe 单次/订阅、微信人工确认），保证「谁发的奖励谁记账」，
    // 将来新增第三条支付路径也不会漏记。
    if (inviter || friendBonusDays > 0) {
      try {
        referralEventStore.log({
          at: Date.now(),
          kind: 'purchase',
          inviterId,
          inviteeId,
          ...(inviter && inviterDays > 0 ? { days: inviterDays } : {}),
          ...(friendBonusDays > 0 ? { friendBonusDays } : {}),
          plan,
          purchase,
        });
      } catch (e) {
        console.warn('⚠️ [Invite] 台账记录失败:', (e as Error)?.message);
      }
    }

    return { inviter, inviterDays, friendBonusDays, valid, reason: v.reason };
  }

  /** 到期前 3 天提醒：已解锁且剩余天数 ∈ (0,3] 且未提醒过才返回 true */
  shouldRemindExpiry(userId: string, daysLeft: number): boolean {
    const user = this.users.get(userId);
    if (!user || !this.isUnlocked(user)) return false;
    return daysLeft > 0 && daysLeft <= 3 && !user.expiryRemindedAt;
  }

  markExpiryReminded(userId: string): void {
    const user = this.users.get(userId);
    if (user && !user.expiryRemindedAt) {
      user.expiryRemindedAt = Date.now();
      this.saveToDisk();
    }
  }

  /** 当前档位（AI 狼人杀的每日局数上限分档用；ensureUser/getPlan 都是私有的，这里开一个公开入口） */
  planOf(userId: string): 'free' | 'plus' | 'pro' {
    return this.getPlan(this.ensureUser(userId));
  }

  /**
   * 千世书「AI 托管」可用性：仅 pro/lifetime 允许，且每日有回合上限（成本保护，见方案第 8 章）
   */
  canAutoPlay(userId: string): { allowed: boolean; plan: 'free' | 'plus' | 'pro'; remainToday: number } {
    const user = this.ensureUser(userId);
    const plan = this.getPlan(user);
    if (plan !== 'pro') return { allowed: false, plan, remainToday: 0 };
    const today = this.todayKey();
    const usedToday = user.autoPlayDate === today ? (user.autoPlayUsed || 0) : 0;
    return { allowed: true, plan, remainToday: Math.max(0, AUTO_PLAY_DAILY_LIMIT - usedToday) };
  }

  /** 消耗一次「AI 托管」回合（调用成功后记账；失败由 rollbackAutoPlay 回滚） */
  consumeAutoPlay(userId: string): void {
    const user = this.ensureUser(userId);
    const today = this.todayKey();
    if (user.autoPlayDate !== today) { user.autoPlayDate = today; user.autoPlayUsed = 0; }
    user.autoPlayUsed = (user.autoPlayUsed || 0) + 1;
    this.saveToDisk();
  }

  /** 回滚一次「AI 托管」回合（AI 调用失败时，与 rollbackChat 同路径） */
  rollbackAutoPlay(userId: string): void {
    const user = this.users.get(userId);
    if (user && (user.autoPlayUsed || 0) > 0) {
      user.autoPlayUsed = (user.autoPlayUsed || 0) - 1;
      this.saveToDisk();
    }
  }

  /**
   * 千世书「AI 生成剧本」可用性：仅 pro/lifetime 允许，且每日有次数上限（成本保护，见方案第 4 章）
   */
  canGenerate(userId: string): { allowed: boolean; plan: 'free' | 'plus' | 'pro'; remainToday: number } {
    const user = this.ensureUser(userId);
    const plan = this.getPlan(user);
    const credit = user.genCredit || 0;
    if (plan !== 'pro' && credit <= 0) return { allowed: false, plan, remainToday: 0 };
    const today = this.todayKey();
    const usedToday = user.genDate === today ? (user.genUsed || 0) : 0;
    const dailyRemain = plan === 'pro' ? Math.max(0, GEN_DAILY_LIMIT - usedToday) : 0;
    return { allowed: true, plan, remainToday: dailyRemain + credit };
  }

  /** 消耗一次「AI 生成剧本」（调用成功后记账；失败由 rollbackGenerate 回滚） */
  consumeGenerate(userId: string): void {
    const user = this.ensureUser(userId);
    // 防泄漏：回滚只在「消耗后立即失败」时才用到，保留最近一批即可（成功生成后不再需要）
    if (this.lastGenSource.size >= 5000) this.lastGenSource.clear();
    // 优先消耗「额外额度」（新手创作礼等），其次才计入 Pro 每日限额
    if ((user.genCredit || 0) > 0) {
      user.genCredit = (user.genCredit || 0) - 1;
      this.lastGenSource.set(userId, 'credit');
      this.saveToDisk();
      return;
    }
    const today = this.todayKey();
    if (user.genDate !== today) { user.genDate = today; user.genUsed = 0; }
    user.genUsed = (user.genUsed || 0) + 1;
    this.lastGenSource.set(userId, 'daily');
    this.saveToDisk();
  }

  /** 回滚一次「AI 生成剧本」（调用失败时，与 rollbackAutoPlay 同路径） */
  rollbackGenerate(userId: string): void {
    const user = this.users.get(userId);
    if (!user) return;
    // 回滚必须与消耗对称：若刚才扣的是「额外额度」（genCredit）则原样恢复，否则才回滚每日计数
    const src = this.lastGenSource.get(userId);
    this.lastGenSource.delete(userId);
    if (src === 'credit') {
      user.genCredit = (user.genCredit || 0) + 1;
      this.saveToDisk();
      return;
    }
    if ((user.genUsed || 0) > 0) {
      user.genUsed = (user.genUsed || 0) - 1;
      this.saveToDisk();
    }
  }
}

export const quotaStore = new QuotaStore();

/**
 * 新人 Pro 限时活动是否进行中：
 * 需配置 PRO_TRIAL_PROMO_START（YYYY-MM-DD），且当前时间落在 [START, START + PRO_TRIAL_PROMO_DAYS) 内。
 * 未配置/天数<=0 → false（不开启，防止误发）。
 */
export function isProTrialPromoActive(now: Date = new Date()): boolean {
  const startStr = process.env.PRO_TRIAL_PROMO_START || '';
  const days = Number(process.env.PRO_TRIAL_PROMO_DAYS || 15);
  if (!startStr || days <= 0) return false;
  const start = new Date(startStr + 'T00:00:00');
  if (Number.isNaN(start.getTime())) return false;
  if (now < start) return false;
  const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
  return now < end;
}

export const FREE_QUOTA_COUNT = FREE_QUOTA;
export const FREE_STRUCT_COUNT = FREE_STRUCT;
export const FREE_CHAT_COUNT = FREE_CHAT;
export const UNLOCK_DAYS_COUNT = UNLOCK_DAYS;
export const INVITE_BONUS_COUNT = INVITE_BONUS;
export const REGISTER_BONUS_COUNT = REGISTER_BONUS;
export const REGISTER_CHAT_BONUS_COUNT = REGISTER_CHAT_BONUS;
export const FEEDBACK_REWARD_CHAT_COUNT = FEEDBACK_REWARD_CHAT;
export const CHAT_DAILY_LIMIT_COUNT = CHAT_DAILY_LIMIT;
export const AUTO_PLAY_DAILY_LIMIT_COUNT = AUTO_PLAY_DAILY_LIMIT;
export const GEN_DAILY_LIMIT_COUNT = GEN_DAILY_LIMIT;
export const CONTEXT_FREE_COUNT = CONTEXT_FREE;
export const CONTEXT_PLUS_COUNT = CONTEXT_PLUS;
export const CONTEXT_PRO_COUNT = CONTEXT_PRO;
export const MEMORY_FREE_COUNT = MEMORY_FREE;
export const MEMORY_PLUS_COUNT = MEMORY_PLUS;
export const MEMORY_PRO_COUNT = MEMORY_PRO;
export const REFERRAL_INVITER_MIN_DAYS_COUNT = REFERRAL_INVITER_MIN_DAYS;
export const REFERRAL_YEARLY_CAP_DAYS_COUNT = REFERRAL_YEARLY_CAP_DAYS;
export const REFERRAL_MONTHLY_BONUS_DAYS_COUNT = REFERRAL_MONTHLY_BONUS_DAYS;
export const REFERRAL_NEW_ACCOUNT_BOOST_COUNT = REFERRAL_NEW_ACCOUNT_BOOST;
export const REFERRAL_NEW_ACCOUNT_BOOST_DAYS_COUNT = REFERRAL_NEW_ACCOUNT_BOOST_DAYS;
export const CREDIT_PER_YUAN_COUNT = CREDIT_PER_YUAN;
export const FREE_DAILY_CREDIT_COUNT = FREE_DAILY_CREDIT;
export const GUEST_DAILY_CREDIT_COUNT = GUEST_DAILY_CREDIT; // 游客档（未注册）：默认 5 条/天
export const PLUS_DAILY_CREDIT_COUNT = PLUS_DAILY_CREDIT;
export const PRO_DAILY_CREDIT_COUNT = PRO_DAILY_CREDIT;
export const UNIT_CREDIT_COUNT = UNIT_CREDIT;
export default quotaStore;
