/**
 * API 用量与费用统计模块
 * 按「用户 × 功能」记录调用次数、token 消耗、估算费用，持久化到 data/usage.json（按天聚合在 usage-daily.json）
 * 计费单价（元/百万 token）从 .env 读取，默认参考 DeepSeek 官方定价
 *
 * ── 口径（2026-09-17 扩充「功能细分」）───────────────────────────────
 * 1. token 渠道：只统计**能拿到真实 usage**的调用（deepseek.ts 两处 record）。
 * 2. 按张计费渠道（出图等）：走 `recordImageCost`，与 token 记在同一个账本里，
 *    否则控制台只看得见 token 钱、看不见真金白银的图片钱（此前就是漏的）。
 * 3. `feature` 回答「这笔钱是谁花的」：与 behaviorDaily 的功能键对齐
 *    （chat / structure / roleplay / wenyou / werewolf），另有 image / memory / reengage / internal / unknown。
 * 4. 旧数据（升级前写入的）没有 byFeature → 查询时按 `unknown` 兜底合成，
 *    **总额（totalCost）与趋势图（getDailyTrend）口径完全不变**，磁盘上不迁移。
 * 5. 无 userId 的内部调用（运营 AI/皮肤风格等）记到 `SYSTEM_USER_ID`，不再静默丢弃。
 */

import 'dotenv/config';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const USAGE_FILE = dataFile('usage.json');
const DAILY_FILE = dataFile('usage-daily.json');

// 计费（元 / 百万 token）
export const INPUT_PRICE = Number(process.env.INPUT_PRICE_PER_M || 2);   // 输入（含缓存命中按 0.25 折算）
export const OUTPUT_PRICE = Number(process.env.OUTPUT_PRICE_PER_M || 8); // 输出
export const CACHE_DISCOUNT = Number(process.env.CACHE_PRICE_RATIO || 0.25); // 缓存命中单价 = 输入价 × 比例

// ── 分时定价（peak / off-peak）────────────────────────────────────────
/**
 * DeepSeek 官方分时价：**peak 是 off-peak 的 2 倍**（输入/缓存命中/输出三档同倍），
 * peak 时段 = **周一至周五 01:00–04:00 与 06:00–10:00 UTC**（= 香港时间工作日上午 09–12 点、下午 14–18 点）。
 *
 * 为什么必须做：`.env` 填的是 **off-peak 单价**（1.58 / 4.75 元/M）→ 落在 peak 时段的调用会被**低估一半**，
 * 而港澳用户白天的活跃时段正好压在 peak 窗口里（实测项目文档 docs/deepseek-v4-thinking-eval.md §0）。
 *
 * 口径边界（重要）：
 *  - **只影响成本记账**（运营端看到的钱）。用户点数（credit）**故意不随时段波动** ——
 *    `quota.ts` 调 `costFromUsage` 时不传 `at`，否则同一个动作在白天要多扣一倍额度，
 *    是产品体验决策而不是账单口径（Pro 的每日点数安全阀也会因此提前触发）。
 *  - 出图（按张计费）不分时段，不走这里。
 *  - env **在调用时读**（不是模块加载时固化）：单测/脚本可以在同一进程里切换开关，
 *    与 `werewolf.ts` 的计数器同一套约定。
 */
export const PEAK_DEFAULT_HOURS_UTC = '1-4,6-10';
export const PEAK_DEFAULT_DAYS = '1-5'; // ISO 星期：1=周一 … 7=周日

function peakEnabled(): boolean {
  return process.env.PRICE_PEAK_ENABLED !== '0';
}
function peakMultiplierValue(): number {
  const n = Number(process.env.PRICE_PEAK_MULTIPLIER || 2);
  return Number.isFinite(n) && n >= 1 ? n : 2;
}
/** 解析 "1-4,6-10" → [[1,4],[6,10]]（左闭右开；非法片段直接忽略，不抛错） */
function parseHourRanges(spec: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const part of String(spec || '').split(',')) {
    const m = part.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a >= 0 && a <= 23 && b >= 1 && b <= 24 && b > a) out.push([a, b]);
  }
  return out;
}
/** 解析 "1-5" / "1,3,5" → Set{1..5}（ISO 星期） */
function parseDaySet(spec: string): Set<number> {
  const set = new Set<number>();
  for (const part of String(spec || '').split(',')) {
    const t = part.trim();
    const range = t.match(/^(\d)\s*-\s*(\d)$/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      for (let d = Math.min(a, b); d <= Math.max(a, b); d++) if (d >= 1 && d <= 7) set.add(d);
      continue;
    }
    const one = Number(t);
    if (one >= 1 && one <= 7) set.add(one);
  }
  return set;
}
/** 该时刻是否落在 peak 时段（UTC 判定） */
export function isPeakAt(at: number): boolean {
  if (!peakEnabled()) return false;
  const d = new Date(at);
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  if (!parseDaySet(process.env.PRICE_PEAK_DAYS || PEAK_DEFAULT_DAYS).has(isoDay)) return false;
  const h = d.getUTCHours();
  return parseHourRanges(process.env.PRICE_PEAK_UTC_HOURS || PEAK_DEFAULT_HOURS_UTC).some(([a, b]) => h >= a && h < b);
}
/** 该时刻的单价倍率（peak=multiplier，其余=1） */
export function priceMultiplierAt(at: number): number {
  return isPeakAt(at) ? peakMultiplierValue() : 1;
}
/** 控制台展示用：当前分时定价配置 + 此刻是否 peak */
export function peakPricingInfo(): { enabled: boolean; multiplier: number; hoursUtc: string; daysUtc: string; activeNow: boolean } {
  return {
    enabled: peakEnabled(),
    multiplier: peakMultiplierValue(),
    hoursUtc: process.env.PRICE_PEAK_UTC_HOURS || PEAK_DEFAULT_HOURS_UTC,
    daysUtc: process.env.PRICE_PEAK_DAYS || PEAK_DEFAULT_DAYS,
    activeNow: isPeakAt(Date.now()),
  };
}


/** 无 userId 的内部/运营调用（运营 AI、皮肤风格、Instagram 文案…）落在这一行，运营后台可见 */
export const SYSTEM_USER_ID = '__system__';

/**
 * 功能键（成本归属）。前 5 个与 `behaviorDaily.ts` 的功能键**同名**，
 * 目的：控制台可以把「用了多少次」与「花了多少钱」并排放在同一行，不会两套叫法。
 */
export type UsageFeature =
  | 'chat'        // 聊一聊
  | 'structure'   // 理一理（情绪笔记/问题/详细分析/暖心故事/追问）
  | 'roleplay'    // 剧情扮演（回合 + 候选建议 + AI 剧本生成/改写）
  | 'wenyou'      // 千世书（AI 文游：回合 + 生成剧本）
  | 'werewolf'    // AI 狼人杀（自研引擎 + 移植版旁路）
  | 'image'       // 出图（按张计费，与 token 无关）
  | 'memory'      // 长期记忆（后台事实提取/角色成长，真实花钱）
  | 'dailyLife'   // 小愈的日常·今天自己这边的小事（后台，每用户每天 1 次）
  | 'reengage'    // 流失挽回（后台邮件文案）
  | 'internal'    // 运营内部（Instagram 文案、皮肤风格、运营 AI 分析）
  | 'unknown';    // 历史数据（升级前没有功能标记）/ 未标注

export const USAGE_FEATURES: UsageFeature[] = [
  'chat', 'structure', 'roleplay', 'wenyou', 'werewolf', 'image', 'memory', 'dailyLife', 'reengage', 'internal', 'unknown',
];

/** 功能中文名（控制台直接显示；后端也返回，避免前后端两套叫法漂移） */
export const FEATURE_LABELS: Record<string, string> = {
  chat: '聊一聊',
  structure: '理一理',
  roleplay: '剧情扮演',
  wenyou: '千世书（文游）',
  werewolf: 'AI 狼人杀',
  image: '出图（按张计费）',
  memory: '长期记忆（后台）',
  dailyLife: '小愈的日常（后台）',
  reengage: '流失挽回（后台）',
  internal: '运营内部',
  unknown: '历史未分类',
};

/** 归一化功能键：未知字符串一律落 'unknown'，避免脏 key 把控制台表格撑开 */
export function normalizeFeature(feature?: string): UsageFeature {
  const f = String(feature || '').trim();
  return (USAGE_FEATURES as string[]).includes(f) ? (f as UsageFeature) : 'unknown';
}

/** 调用方传进来的 usage 形状（各家字段略有差异，见 cachedTokensOf） */
export interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** DeepSeek / OpenAI 风格 */
  prompt_tokens_details?: { cached_tokens?: number };
  /** DeepSeek 原生字段 */
  prompt_cache_hit_tokens?: number;
  /** 部分第三方托管（如 Featherless）把缓存命中直接放在顶层 */
  cached_tokens?: number;
}

/**
 * 取「缓存命中 token 数」——三家字段名不一样，统一在这里认，避免各自漏读导致缓存命中被按全价记账：
 *  - `prompt_tokens_details.cached_tokens`（DeepSeek / OpenAI 官方形态）
 *  - `prompt_cache_hit_tokens`（DeepSeek 原生形态）
 *  - `cached_tokens`（Featherless 等第三方在顶层回传，2026-09-17 实测确认）
 */
export function cachedTokensOf(usage: UsageLike | undefined): number {
  if (!usage) return 0;
  const n = Number(
    usage.prompt_tokens_details?.cached_tokens
    ?? usage.prompt_cache_hit_tokens
    ?? usage.cached_tokens
    ?? 0,
  );
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 把一次模型调用的真实/预估 token 用量换算成成本（元）。
 * 与 usageStore.record 同口径（含缓存命中折扣）。
 *
 * @param at 调用**发起**时刻（ms）。传了就按分时定价算（peak 时段 × 倍率）；
 *           **不传 = 按 off-peak 基准价**——额度层（quota.ts）刻意不传，用户点数不随时段波动。
 */
export function costFromUsage(usage: UsageLike | undefined, at?: number): number {
  if (!usage) return 0;
  const cached = cachedTokensOf(usage);
  const prompt = Math.max(0, (usage.prompt_tokens || 0) - cached);
  const completion = usage.completion_tokens || 0;
  const base = (prompt / 1e6) * INPUT_PRICE + (cached / 1e6) * INPUT_PRICE * CACHE_DISCOUNT + (completion / 1e6) * OUTPUT_PRICE;
  return at == null ? base : base * priceMultiplierAt(at);
}

/** 单个功能的用量桶（token 渠道与按张渠道共用一套结构，便于控制台一张表渲染） */
export interface FeatureBucket {
  requests: number;         // 调用次数（出图 = 出图请求数）
  promptTokens: number;     // 输入 tokens（不含缓存命中）
  cachedTokens: number;     // 缓存命中 tokens
  completionTokens: number; // 输出 tokens
  cost: number;             // 该功能累计成本（元，含图片成本）
  images: number;           // 出图张数（token 渠道恒为 0）
  imageCost: number;        // 出图成本（元）
  estimated: number;        // 其中「按生成量估算入账」的调用次数（拿不到真实 usage 时的兜底）
}

export interface UsageRecord {
  userId: string;
  requests: number;        // 调用次数
  promptTokens: number;    // 输入 tokens（不含缓存命中）
  cachedTokens: number;    // 缓存命中 tokens
  completionTokens: number; // 输出 tokens
  cost: number;            // 估算费用（元）
  lastUsed: number;        // 最近使用时间
  /** 按功能分桶（升级前写入的记录没有这个字段，查询时按 unknown 兜底合成） */
  byFeature?: Record<string, FeatureBucket>;
}

interface DailyUsage {
  date: string; // YYYY-MM-DD
  requests: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  cost: number;
  byFeature?: Record<string, FeatureBucket>;
}

/** 功能细分汇总 */
export interface FeatureTotals {
  cost: number;
  requests: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  images: number;
  imageCost: number;
  estimated: number;
  byFeature: Record<string, FeatureBucket>;
}

/** 本地日期键（YYYY-MM-DD）——与 getDailyTrend 的本地日期口径保持一致 */
function todayLocalKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 展示精度：金额一律**累加时保留原值、只在读取/展示时四舍五入**，否则误差会被放大。
 * 教训（2026-09-17 实测）：单次调用成本量级约 1e-4 元，若每笔记账都 round 到 4 位小数，
 * 累加一次就丢 ~1e-5，实测同一段流式成本 0.00117 被记成 0.0012（偏差 8%）。
 *  - `round4`：元级展示（用户行、分桶、每日趋势）
 *  - `round6`：分币级展示（单笔量级更小，保留 6 位才能看清）
 */
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

function emptyBucket(): FeatureBucket {
  return { requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0, images: 0, imageCost: 0, estimated: 0 };
}

/** 取（或建）byFeature 里的桶 */
function bucketOf(map: Record<string, FeatureBucket> | undefined, feature: string): FeatureBucket {
  const key = normalizeFeature(feature);
  const b = map?.[key];
  if (b && typeof b === 'object') return b;
  const fresh = emptyBucket();
  if (map) map[key] = fresh;
  return fresh;
}

/** 累加一次 token 调用 */
function addTokenCall(b: FeatureBucket, prompt: number, cached: number, completion: number, cost: number, estimated: boolean): void {
  b.requests += 1;
  b.promptTokens += prompt;
  b.cachedTokens += cached;
  b.completionTokens += completion;
  b.cost += cost;
  if (estimated) b.estimated += 1;
}

/** 累加一次按张计费（出图） */
function addImageCall(b: FeatureBucket, count: number, yuan: number): void {
  b.requests += 1;
  b.images += Math.max(0, count);
  b.imageCost += yuan;
  b.cost += yuan;
}

/**
 * 把一条记录的 byFeature 归一化成「**一定存在、且合计与总额完全对得上**」的表格。
 *
 * 两种缺口都要补齐，否则控制台会出现「分桶之和 < 当天合计 / 该用户合计」这种对不上的账：
 *  ① 升级前的记录**没有** byFeature → 用总额合成一个 'unknown' 桶；
 *  ② **升级当天**的混装记录（上午旧代码写、下午新代码写）→ byFeature 只盖住新代码那部分，
 *     残差按 'unknown' 补上（实测：上线当天 207 次里 5 次带功能标记，残差 202 次必须显式可见）。
 * 只影响读取视图，不写回磁盘、不改动 totalCost 口径。
 */
function bucketsOf(rec: { byFeature?: Record<string, FeatureBucket>; requests: number; promptTokens: number; cachedTokens: number; completionTokens: number; cost: number }): Record<string, FeatureBucket> {
  const src = (rec.byFeature && Object.keys(rec.byFeature).length) ? rec.byFeature : null;
  if (src) {
    let reqSum = 0, costSum = 0, promptSum = 0, cachedSum = 0, completionSum = 0;
    for (const b of Object.values(src)) {
      reqSum += b.requests || 0;
      costSum += b.cost || 0;
      promptSum += b.promptTokens || 0;
      cachedSum += b.cachedTokens || 0;
      completionSum += b.completionTokens || 0;
    }
    const restReq = (rec.requests || 0) - reqSum;
    const restCost = (rec.cost || 0) - costSum;
    // 残差极小（浮点误差）就忽略；只要次数或金额有明显缺口，就补一个「历史未分类」桶
    if (restReq > 0 || restCost > 1e-9) {
      const merged: Record<string, FeatureBucket> = { ...src };
      const prev = merged.unknown || emptyBucket();
      merged.unknown = {
        ...prev,
        requests: prev.requests + Math.max(0, restReq),
        promptTokens: prev.promptTokens + Math.max(0, (rec.promptTokens || 0) - promptSum),
        cachedTokens: prev.cachedTokens + Math.max(0, (rec.cachedTokens || 0) - cachedSum),
        completionTokens: prev.completionTokens + Math.max(0, (rec.completionTokens || 0) - completionSum),
        cost: prev.cost + Math.max(0, restCost),
      };
      return merged;
    }
    return src;
  }
  const legacy: FeatureBucket = {
    requests: rec.requests || 0,
    promptTokens: rec.promptTokens || 0,
    cachedTokens: rec.cachedTokens || 0,
    completionTokens: rec.completionTokens || 0,
    cost: rec.cost || 0,
    images: 0,
    imageCost: 0,
    estimated: 0,
  };
  return { unknown: legacy };
}

/** 把分桶金额按展示精度取整（读接口用；写入路径一律保留原值） */
function roundBuckets(map: Record<string, FeatureBucket>): Record<string, FeatureBucket> {
  const out: Record<string, FeatureBucket> = {};
  for (const [k, b] of Object.entries(map)) {
    out[k] = { ...b, cost: round6(b.cost), imageCost: round6(b.imageCost) };
  }
  return out;
}

/** 桶相加（聚合多天/多用户时用） */
function mergeBucket(into: FeatureBucket, from: FeatureBucket): void {
  into.requests += from.requests || 0;
  into.promptTokens += from.promptTokens || 0;
  into.cachedTokens += from.cachedTokens || 0;
  into.completionTokens += from.completionTokens || 0;
  into.cost += from.cost || 0;
  into.images += from.images || 0;
  into.imageCost += from.imageCost || 0;
  into.estimated += from.estimated || 0;
}

/**
 * 用量账本（导出类是为了单测能「用一份老格式数据新建实例」验证向后兼容，
 * 线上只用文件末尾那个单例 `usageStore`）。
 */
export class UsageStore {
  private records: Map<string, UsageRecord> = new Map();
  private daily: Map<string, DailyUsage> = new Map();

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const parsed = readJson<UsageRecord[]>(USAGE_FILE, []);
    if (Array.isArray(parsed)) parsed.forEach((r: UsageRecord) => { if (r?.userId) this.records.set(r.userId, r); });
    const parsedDaily = readJson<DailyUsage[]>(DAILY_FILE, []);
    if (Array.isArray(parsedDaily)) parsedDaily.forEach((d: DailyUsage) => { if (d?.date) this.daily.set(d.date, d); });
  }

  private saveToDisk(): void {
    try {
      writeJson(USAGE_FILE, Array.from(this.records.values()));
      writeJson(DAILY_FILE, Array.from(this.daily.values()));
    } catch (e) {
      console.warn('⚠️ [Usage] 保存用量数据失败:', (e as Error)?.message);
    }
  }

  /**
   * 记录一次模型调用（token 渠道）
   * @param feature 成本归属功能（默认 unknown；各调用点显式传，见 deepseek.ts 的 feature 透传）
   * @param opts.estimated 这次成本是「按生成量估算」的（上游没给真实 usage 时的兜底），控制台会标出来
   * @param opts.at 调用**发起**时刻（ms）——按分时定价算成本（peak × 倍率）。不传 = 用当前时间。
   *               长流式跨过 peak 边界时，用「发起时刻」才与实际计费口径一致。
   */
  record(
    userId: string,
    usage: UsageLike | undefined,
    feature: UsageFeature | string = 'unknown',
    opts: { estimated?: boolean; at?: number } = {},
  ): void {
    if (!userId) return;
    const cached = cachedTokensOf(usage);
    const prompt = Math.max(0, (usage?.prompt_tokens || 0) - cached);
    const completion = usage?.completion_tokens || 0;
    const at = Number.isFinite(opts.at) ? Number(opts.at) : Date.now();
    const cost = costFromUsage(usage, at);

    // 用户累计
    const u = this.records.get(userId) || { userId, requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0, lastUsed: 0 };
    u.requests += 1;
    u.promptTokens += prompt;
    u.cachedTokens += cached;
    u.completionTokens += completion;
    u.cost += cost;
    u.lastUsed = Date.now();
    if (!u.byFeature) u.byFeature = {};
    addTokenCall(bucketOf(u.byFeature, feature), prompt, cached, completion, cost, !!opts.estimated);
    this.records.set(userId, u);

    // 按天累计（趋势图）：用本地日期，与 getDailyTrend 一致（toISOString 是 UTC，会导致跨时区日界错位）
    const date = todayLocalKey();
    const d = this.daily.get(date) || { date, requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0 };
    d.requests += 1;
    d.promptTokens += prompt;
    d.cachedTokens += cached;
    d.completionTokens += completion;
    d.cost += cost;
    if (!d.byFeature) d.byFeature = {};
    addTokenCall(bucketOf(d.byFeature, feature), prompt, cached, completion, cost, !!opts.estimated);
    this.daily.set(date, d);

    this.saveToDisk();
  }

  /**
   * 记录一笔「按张计费」的成本（出图等非 token 渠道）——真金白银，必须入账。
   * 调用方在**出图成功后**记账（失败/降级不计费，与厂商计费口径一致）。
   *
   * 口径：`requests`（调用次数）按**计费调用**计——一次出图请求算 1 次，
   * 张数记在 `images`、金额记在 `imageCost`；这样「当天调用次数 = 当天分桶次数之和」恒成立。
   */
  recordImageCost(
    userId: string,
    input: { provider?: string; count?: number; yuan: number; feature?: UsageFeature | string },
  ): void {
    if (!userId) return;
    const count = Math.max(1, Math.floor(input.count || 1));
    const yuan = Math.max(0, input.yuan || 0);

    const u = this.records.get(userId) || { userId, requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0, lastUsed: 0 };
    u.requests += 1;
    u.cost += yuan;
    u.lastUsed = Date.now();
    if (!u.byFeature) u.byFeature = {};
    addImageCall(bucketOf(u.byFeature, input.feature || 'image'), count, yuan);
    this.records.set(userId, u);

    const date = todayLocalKey();
    const d = this.daily.get(date) || { date, requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0 };
    d.requests += 1;
    d.cost += yuan;
    if (!d.byFeature) d.byFeature = {};
    addImageCall(bucketOf(d.byFeature, input.feature || 'image'), count, yuan);
    this.daily.set(date, d);

    this.saveToDisk();
  }

  /**
   * 某用户的用量记录（金额按展示精度四舍五入；内部累加保留原值）。
   * 返回浅拷贝 + 拷贝后的分桶，避免调用方直接把展示用的取整值写回账本。
   */
  get(userId: string): UsageRecord | undefined {
    const rec = this.records.get(userId);
    if (!rec) return undefined;
    return {
      ...rec,
      cost: round4(rec.cost),
      byFeature: rec.byFeature ? roundBuckets(rec.byFeature) : undefined,
    };
  }

  /** 某用户的功能细分（旧数据归 'unknown'）。注意：与区间版的 `getFeatureBreakdown(days)` 是两个方法，别混用。 */
  getUserFeatureBreakdown(userId: string): Record<string, FeatureBucket> {
    const rec = this.records.get(userId);
    if (!rec) return {};
    const out: Record<string, FeatureBucket> = {};
    const src = bucketsOf(rec);
    for (const [k, b] of Object.entries(src)) mergeBucket((out[k] ||= emptyBucket()), b);
    return roundBuckets(out);
  }

  /**
   * 删除某用户的用量记录（账户注销时调用，P1-03）
   * usage-daily.json 为按天聚合（无 per-user 数据），无需清理。
   */
  deleteByUser(userId: string): void {
    if (this.records.delete(userId)) this.saveToDisk();
  }

  listAll(): UsageRecord[] {
    return Array.from(this.records.values());
  }

  /**
   * 全部 API 成本（元）—— 口径不变：所有用户（含游客/系统行）的 token 成本 + 图片成本
   */
  totalCost(): number {
    let c = 0;
    for (const r of this.records.values()) c += r.cost;
    return Math.round(c * 100) / 100;
  }

  /**
   * 最近 N 天每日成本趋势（空的天补 0）
   */
  getDailyTrend(days: number): { date: string; cost: number; requests: number }[] {
    const out: { date: string; cost: number; requests: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const rec = this.daily.get(key);
      out.push({ date: key.slice(5), cost: rec ? round4(rec.cost) : 0, requests: rec ? rec.requests : 0 });
    }
    return out;
  }

  /**
   * 「谁花的钱」——最近 N 天的功能细分（区间合计 + 按天），空的天补 0。
   * 控制台用它渲染「API 成本构成」表：功能 × 调用数 × token × 金额 × 占比。
   */
  getFeatureBreakdown(days: number): {
    range: { days: number; from: string; to: string };
    totals: FeatureTotals;
    daily: { date: string; cost: number; requests: number; byFeature: Record<string, FeatureBucket> }[];
  } {
    const n = Math.max(1, Math.min(90, Math.floor(days) || 30));
    const totals: FeatureTotals = {
      cost: 0, requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0,
      images: 0, imageCost: 0, estimated: 0, byFeature: {},
    };
    const daily: { date: string; cost: number; requests: number; byFeature: Record<string, FeatureBucket> }[] = [];
    const keys: string[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    for (const key of keys) {
      const rec = this.daily.get(key);
      const byFeature: Record<string, FeatureBucket> = {};
      if (rec) {
        for (const [k, b] of Object.entries(bucketsOf(rec))) {
          mergeBucket((byFeature[k] ||= emptyBucket()), b);
          mergeBucket((totals.byFeature[k] ||= emptyBucket()), b);
        }
      }
      const dayCost = rec ? rec.cost : 0;
      const dayReq = rec ? rec.requests : 0;
      totals.cost = round4(totals.cost + dayCost);
      totals.requests += dayReq;
      daily.push({ date: key.slice(5), cost: dayCost, requests: dayReq, byFeature });
    }
    for (const b of Object.values(totals.byFeature)) {
      totals.promptTokens += b.promptTokens;
      totals.cachedTokens += b.cachedTokens;
      totals.completionTokens += b.completionTokens;
      totals.images += b.images;
      totals.imageCost = round4(totals.imageCost + b.imageCost);
      totals.estimated += b.estimated;
    }
    return {
      range: { days: n, from: keys[0], to: keys[keys.length - 1] },
      totals: { ...totals, cost: round4(totals.cost), imageCost: round6(totals.imageCost), byFeature: roundBuckets(totals.byFeature) },
      daily: daily.map(d => ({ ...d, cost: round4(d.cost), byFeature: roundBuckets(d.byFeature) })),
    };
  }
}

export const usageStore = new UsageStore();
export default usageStore;
