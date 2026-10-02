/**
 * 订单存储模块（Stripe 收 USD，付款即自动解锁；另保留运营侧人工确认/开通的订单记录）
 * 订单持久化到 data/orders.json
 * 注：2026-09-23 起产品内**没有自动的**微信支付通道（用户侧自动到账只有 Stripe）；
 *     2026-09-26 起**微信收款码作为人工兜底回到用户侧**（付费弹窗折叠块展示 + 人工确认，
 *     见 getPayQrUrl() / getConfig().payQrUrl），本模块的订单/人工确认接口同时也给运营后台用。
 *
 * 定价（港澳/海外为主，页面按 USD → HKD → CNY 顺序展示）：
 *  - Plus：PLUS_PRICE_USD（Stripe USD）· PLUS_PRICE_CNY（人民币，仅作价格参照）
 *  - Pro ：PRO_PRICE_USD（Stripe USD） · PRO_PRICE_CNY（人民币，仅作价格参照）
 *  - HKD 仅作展示：USD × FX_USD_HKD
 *  - 开业优惠：现价 = 折扣价，原价（划线）默认 2×现价，DISCOUNT_PCT 默认 50
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import {
  FREE_STRUCT_COUNT, FREE_CHAT_COUNT, CHAT_DAILY_LIMIT_COUNT, UNLOCK_DAYS_COUNT,
  CONTEXT_FREE_COUNT, CONTEXT_PLUS_COUNT, CONTEXT_PRO_COUNT,
  MEMORY_FREE_COUNT, MEMORY_PLUS_COUNT, MEMORY_PRO_COUNT, AUTO_PLAY_DAILY_LIMIT_COUNT,
  FREE_DAILY_CREDIT_COUNT, GUEST_DAILY_CREDIT_COUNT, PLUS_DAILY_CREDIT_COUNT, PRO_DAILY_CREDIT_COUNT, UNIT_CREDIT_COUNT,
  isCreditQuotaEnabled,
  featureCostTiao,
} from './quota.js';
import { CAP_BY_PLAN as SCENE_ART_CAP_BY_PLAN } from './sceneArt.js';

/** 专属画面每日上限（免费 / Plus），与 sceneArt.ts 的 CAP_BY_PLAN 同源，避免两处各写一份数字 */
const SCENE_ART_CAP_FREE = SCENE_ART_CAP_BY_PLAN.free;
const SCENE_ART_CAP_PLUS = SCENE_ART_CAP_BY_PLAN.plus;

// 【收款码静态文件候选目录（解析顺序与 api/app.ts 静态托管一致：dist 优先，其次 public）】
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const QR_CANDIDATE_DIRS = [path.join(PROJECT_ROOT, 'dist'), path.join(PROJECT_ROOT, 'public')];

const ORDERS_FILE = dataFile('orders.json');

// 【会员档位价格（可经 .env 覆盖）】
export const PLAN_KEYS = ['plus', 'pro'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

// Stripe 收 USD（海外/港澳主币种）
export const PLUS_PRICE_USD = Number(process.env.PLUS_PRICE_USD || 4.99);
export const PRO_PRICE_USD = Number(process.env.PRO_PRICE_USD || 9.99);
// 连续包月订阅价（USD，默认 8 折；首月试用价可选）
export const PLUS_PRICE_USD_SUB = Number(process.env.PLUS_PRICE_USD_SUB || 3.99);
export const PRO_PRICE_USD_SUB = Number(process.env.PRO_PRICE_USD_SUB || 7.99);
export const PLUS_PRICE_USD_TRIAL = Number(process.env.PLUS_PRICE_USD_TRIAL || 1.99);
export const PRO_PRICE_USD_TRIAL = Number(process.env.PRO_PRICE_USD_TRIAL || 3.99);
export const SUB_TRIAL_ENABLED = String(process.env.SUB_TRIAL_ENABLED || 'false') === 'true'; // 首月试用价开关
// 人民币标价（页面价格参照；产品内无人民币支付通道）
export const PLUS_PRICE_CNY = Number(process.env.PLUS_PRICE_CNY || 35);
export const PRO_PRICE_CNY = Number(process.env.PRO_PRICE_CNY || 71);
// HKD 展示汇率
export const FX_USD_HKD = Number(process.env.FX_USD_HKD || 7.8);
// 开业优惠：原价（划线价），现价为开业折扣价，默认 5 折（原价 = 现价 × 2），可经 .env 覆盖
export const PLUS_PRICE_USD_ORIG = Number(process.env.PLUS_PRICE_USD_ORIG || 9.99);
export const PRO_PRICE_USD_ORIG = Number(process.env.PRO_PRICE_USD_ORIG || 19.99);
export const PLUS_PRICE_CNY_ORIG = Number(process.env.PLUS_PRICE_CNY_ORIG || 70);
export const PRO_PRICE_CNY_ORIG = Number(process.env.PRO_PRICE_CNY_ORIG || 142);
export const DISCOUNT_PCT = Number(process.env.DISCOUNT_PCT || 50); // 开业优惠折扣（%）
// 开业 5 折限期（YYYY-MM-DD，空=常开）：到期后 launchOffer 自动关闭（仿 CHAT_BONUS_START/END）
const DISCOUNT_START = process.env.DISCOUNT_START || '';
const DISCOUNT_END = process.env.DISCOUNT_END || '';

// 【年付（≈省 3 个月）与买断·终身（限量）价格】
// USD（Stripe）· CNY（标价参照）；HKD 按 FX_USD_HKD 展示
export const PLUS_PRICE_USD_YEARLY = Number(process.env.PLUS_PRICE_USD_YEARLY || 39.99);
export const PRO_PRICE_USD_YEARLY = Number(process.env.PRO_PRICE_USD_YEARLY || 79.99);
export const PLUS_PRICE_USD_LIFETIME = Number(process.env.PLUS_PRICE_USD_LIFETIME || 99);
export const PRO_PRICE_USD_LIFETIME = Number(process.env.PRO_PRICE_USD_LIFETIME || 199);
export const PLUS_PRICE_CNY_YEARLY = Number(process.env.PLUS_PRICE_CNY_YEARLY || 299);
export const PRO_PRICE_CNY_YEARLY = Number(process.env.PRO_PRICE_CNY_YEARLY || 599);
export const PLUS_PRICE_CNY_LIFETIME = Number(process.env.PLUS_PRICE_CNY_LIFETIME || 699);
export const PRO_PRICE_CNY_LIFETIME = Number(process.env.PRO_PRICE_CNY_LIFETIME || 1399);

/** 买断语义：unlockUntil ≈ 10 年（前端按 >3650 天展示「永久会员」） */
export const LIFETIME_DAYS = 3650;

export type Purchase = 'monthly' | 'yearly' | 'lifetime';

/** 开业优惠是否生效（配置了起止日期则限期内生效，否则常开） */
export function isLaunchOfferActive(): boolean {
  const now = new Date();
  if (DISCOUNT_START) {
    const s = new Date(DISCOUNT_START + 'T00:00:00');
    if (now < s) return false;
  }
  if (DISCOUNT_END) {
    const e = new Date(DISCOUNT_END + 'T23:59:59');
    if (now > e) return false;
  }
  return true;
}

/** 优惠截止日期（YYYY-MM-DD，前端倒计时用；常开/未设则 null） */
export function getOfferEndsAt(): string | null {
  return DISCOUNT_END || null;
}

export function isPurchase(v: unknown): v is Purchase {
  return v === 'monthly' || v === 'yearly' || v === 'lifetime';
}

/** 购买方式 → 解锁天数：月付默认 UNLOCK_DAYS_COUNT（通常 30）/ 年付 365 / 买断 3650 */
export function getDaysFor(purchase: Purchase): number {
  return purchase === 'lifetime' ? LIFETIME_DAYS : purchase === 'yearly' ? 365 : UNLOCK_DAYS_COUNT;
}

/** 购买方式 → 三币种价格（月付 = 现行月价；年付/买断 = 对应固定价） */
export function getPriceFor(plan: PlanKey, purchase: Purchase = 'monthly'): { usd: number; cny: number; hkd: number } {
  if (purchase === 'yearly') {
    const usd = plan === 'pro' ? PRO_PRICE_USD_YEARLY : PLUS_PRICE_USD_YEARLY;
    const cny = plan === 'pro' ? PRO_PRICE_CNY_YEARLY : PLUS_PRICE_CNY_YEARLY;
    return { usd, cny, hkd: Math.round(usd * FX_USD_HKD * 100) / 100 };
  }
  if (purchase === 'lifetime') {
    const usd = plan === 'pro' ? PRO_PRICE_USD_LIFETIME : PLUS_PRICE_USD_LIFETIME;
    const cny = plan === 'pro' ? PRO_PRICE_CNY_LIFETIME : PLUS_PRICE_CNY_LIFETIME;
    return { usd, cny, hkd: Math.round(usd * FX_USD_HKD * 100) / 100 };
  }
  return { usd: getUsdPrice(plan), cny: getCnyPrice(plan), hkd: getHkdPrice(plan) };
}

// 微信收款码地址：默认 /pay-qr.jpg（与仓库 public/pay-qr.jpg 一致，可由 .env 覆盖）
// 2026-09-26：作为 Stripe 走不通时的**备用通道**回到用户侧（付费弹窗折叠块里展示，人工确认后开通）。
const PAY_QR_URL = process.env.PAY_QR_URL || '/pay-qr.jpg';
// 手动版本号（可选）：兜底用；正常情况下由 getPayQrUrl() 按图片内容哈希自动生成
const PAY_QR_VERSION = (process.env.PAY_QR_VERSION || '').trim();

let payQrUrlCache: string | null = null;

/**
 * 收款码 URL 版本化：按实际图片内容哈希加 ?v=（如 /pay-qr.jpg?v=ab12cd34ef56）。
 * 换图即换 URL → 自动击穿浏览器/CDN 对静态资源的 7 天缓存（maxAge '7d'），
 * 避免「收款码已更换、用户仍看到旧二维码」，这是真金白银的坑（2026-08-26 踩过）。
 * 文件解析顺序与 api/app.ts 一致：dist → public。
 * 仅对站内相对路径生效；外链 URL 或文件读取失败时退化为原样（可用 PAY_QR_VERSION 手动兜底）。
 */
export function getPayQrUrl(): string {
  if (payQrUrlCache) return payQrUrlCache;
  let version = PAY_QR_VERSION;
  if (!version && PAY_QR_URL.startsWith('/')) {
    const fileName = path.basename(PAY_QR_URL.split(/[?#]/)[0]);
    for (const dir of QR_CANDIDATE_DIRS) {
      try {
        const buf = fs.readFileSync(path.join(dir, fileName));
        version = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
        break;
      } catch {
        // 该目录没有此文件，尝试下一个候选目录
      }
    }
  }
  payQrUrlCache = version ? PAY_QR_URL + (PAY_QR_URL.includes('?') ? '&' : '?') + 'v=' + version : PAY_QR_URL;
  return payQrUrlCache;
}

const ORDER_EXPIRE_MS = 2 * 60 * 60 * 1000; // 订单2小时有效

export function getUsdPrice(plan: PlanKey): number {
  return plan === 'pro' ? PRO_PRICE_USD : PLUS_PRICE_USD;
}
export function getCnyPrice(plan: PlanKey): number {
  return plan === 'pro' ? PRO_PRICE_CNY : PLUS_PRICE_CNY;
}
export function getHkdPrice(plan: PlanKey): number {
  return Math.round(getUsdPrice(plan) * FX_USD_HKD * 100) / 100;
}
export function isPlanKey(v: unknown): v is PlanKey {
  return v === 'plus' || v === 'pro';
}

/* ──────────────────────────────────────────────────────────────
 * 结算币种（2026-09-24 起按访客地区分流）
 *   港澳（香港/澳门）→ HKD · 中国大陆 → CNY · 其余海外 → USD
 * 为什么必须按地区换币种（实测，不是偏好）：Stripe 账户为香港主体，
 * 微信支付在这类账户下**只支持 hkd / cny 计价的 Checkout Session**
 * （显式用 usd 会报 `Sessions with wechat_pay support the following currencies: hkd, cny`），
 * 所以港澳/内地访客若继续用 USD 结账，微信支付根本不会出现在结账页。
 * 币种由**服务端按 IP 判定**（前端只展示），保证「页面显示价 = Stripe 实扣价」。
 * ────────────────────────────────────────────────────────────── */
export type PayCurrency = 'usd' | 'hkd' | 'cny';

/** 展示用币种代码（大写）：HKD / CNY / USD */
export const PAY_CURRENCY_CODE: Record<PayCurrency, string> = { usd: 'USD', hkd: 'HKD', cny: 'CNY' };

/** 国家/地区名（geo.ts 的中文口径）→ 结算币种 */
export function currencyForCountry(country: string): PayCurrency {
  if (country === '香港' || country === '澳门') return 'hkd';
  if (country === '中国大陆') return 'cny';
  return 'usd';
}

/** 指定币种下、指定购买方式的单价（月付 = 月价；年付/买断 = 固定价） */
export function getPriceIn(plan: PlanKey, purchase: Purchase, currency: PayCurrency): number {
  return getPriceFor(plan, purchase)[currency];
}

/**
 * 连续包月（订阅）单价：USD 用独立 8 折订阅价，HKD 按汇率折算，
 * CNY 按与 USD 相同的折扣比例（subUsd / 月价）折算并取整到元。
 */
export function getSubPriceIn(plan: PlanKey, currency: PayCurrency): number {
  const subUsd = plan === 'pro' ? PRO_PRICE_USD_SUB : PLUS_PRICE_USD_SUB;
  if (currency === 'usd') return subUsd;
  if (currency === 'hkd') return Math.round(subUsd * FX_USD_HKD * 100) / 100;
  const baseUsd = plan === 'pro' ? PRO_PRICE_USD : PLUS_PRICE_USD;
  const baseCny = plan === 'pro' ? PRO_PRICE_CNY : PLUS_PRICE_CNY;
  return Math.round(baseCny * (subUsd / baseUsd));
}

export interface Order {
  orderId: string;
  userId: string;
  plan: PlanKey; // 会员档位：plus / pro
  days?: number; // 解锁天数（月付续费 30/60/90…；年付 365；买断 3650）
  purchase?: Purchase; // 购买方式：monthly / yearly / lifetime
  price: number; // 人民币实收金额（CNY；可在控制台按实际到账修正）
  status: 'pending' | 'paid' | 'unlocked' | 'expired';
  source: 'paid' | 'free'; // paid=用户付费；free=管理员免费开通（试用/赠送，不计收入）
  remark?: string;
  createdAt: number;
  confirmedAt?: number;
  unlockUntil?: number;
}

class PaymentStore {
  private orders: Map<string, Order> = new Map();

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const parsed = readJson<any[]>(ORDERS_FILE, []);
    if (Array.isArray(parsed)) {
      parsed.forEach((o: any) => {
        if (o && o.orderId) {
          // 兼容旧订单：无 plan 字段的按 plus 处理
          if (!isPlanKey(o.plan)) o.plan = 'plus';
          this.orders.set(o.orderId, o as Order);
        }
      });
    }
    console.log(`💾 [Payment] 已从磁盘加载 ${this.orders.size} 个订单`);
  }

  private saveToDisk(): void {
    try {
      writeJson(ORDERS_FILE, Array.from(this.orders.values()));
    } catch (error) {
      console.warn('⚠️ [Payment] 保存订单数据失败:', (error as Error)?.message);
    }
  }

  private genOrderId(): string {
    // 8位数字，避免0开头
    for (let i = 0; i < 20; i++) {
      const id = String(crypto.randomInt(10000000, 99999999));
      if (!this.orders.has(id)) return id;
    }
    return String(Date.now()).slice(-8);
  }

  private isExpired(order: Order): boolean {
    return Date.now() - order.createdAt > ORDER_EXPIRE_MS;
  }

  /**
   * 为用户创建订单（复用未过期的 pending 订单；同一用户不同档位各记一笔）
   * @param purchase 购买方式：monthly（默认，days 可自定义 30/60/90…）/ yearly / lifetime
   */
  createOrder(userId: string, plan: PlanKey = 'plus', days?: number, purchase: Purchase = 'monthly'): Order {
    // 月付：days 上限 365（30/60/90 续费档）；年付/买断：固定天数
    const d = purchase === 'monthly' ? Math.max(1, Math.min(365, days || UNLOCK_DAYS_COUNT)) : getDaysFor(purchase);
    // 复用未过期且未确认的 pending 订单（同档位同天数同购买方式）
    for (const o of this.orders.values()) {
      if (o.userId === userId && o.plan === plan && (o.days || UNLOCK_DAYS_COUNT) === d && (o.purchase || 'monthly') === purchase && o.status === 'pending' && !this.isExpired(o)) {
        return o;
      }
    }
    const order: Order = {
      orderId: this.genOrderId(),
      userId,
      plan,
      days: d,
      purchase,
      // 人民币标价：月付按天比例（月价 × days/UNLOCK_DAYS）；年付/买断按固定价
      price: purchase === 'monthly'
        ? Math.round(getCnyPrice(plan) * (d / UNLOCK_DAYS_COUNT) * 100) / 100
        : getPriceFor(plan, purchase).cny,
      status: 'pending',
      source: 'paid',
      createdAt: Date.now(),
    };
    this.orders.set(order.orderId, order);
    this.saveToDisk();
    return order;
  }

  /**
   * 用户标记已付款（记录备注便于核对）
   */
  confirmPaid(orderId: string, remark?: string): Order | null {
    const order = this.orders.get(orderId);
    if (!order || order.status !== 'pending' || this.isExpired(order)) return null;
    order.status = 'paid';
    order.remark = remark?.trim() || undefined;
    this.saveToDisk();
    return order;
  }

  /**
   * 运营端确认到账并解锁
   */
  markUnlocked(orderId: string, unlockUntil: number): Order | null {
    const order = this.orders.get(orderId);
    if (!order) return null;
    order.status = 'unlocked';
    order.unlockUntil = unlockUntil;
    order.confirmedAt = Date.now();
    this.saveToDisk();
    return order;
  }

  /**
   * 将订单标记为免费开通（管理员手动开通 / 运营自测单，不计入收入）
   * @param remark 可选原因（写进备注，便于日后对账；重复内容不会叠加）
   * @returns 是否真的改动了（幂等：已是 free 且备注没变则返回 false）
   */
  markFree(orderId: string, remark?: string): boolean {
    const o = this.orders.get(orderId);
    if (!o) return false;
    let changed = false;
    if (o.source !== 'free') {
      o.source = 'free';
      changed = true;
    }
    const note = remark?.trim();
    if (note && !(o.remark || '').includes(note)) {
      o.remark = (o.remark ? o.remark + ' | ' : '') + note;
      changed = true;
    }
    if (changed) this.saveToDisk();
    return changed;
  }

  /**
   * 运营端：修正订单的实收金额（离线转账、折扣、按实际到账对账）
   * 只改 price 并追加备注，不动 status / source（解锁与「改记免费」仍走各自接口）。
   * @returns 变更前后金额；订单不存在返回 null
   */
  setPrice(orderId: string, price: number, remark?: string): { from: number; to: number } | null {
    const o = this.orders.get(orderId);
    if (!o) return null;
    const from = o.price;
    o.price = price;
    const note = remark?.trim();
    if (note && !(o.remark || '').includes(note)) {
      o.remark = (o.remark ? o.remark + ' | ' : '') + note;
    }
    this.saveToDisk();
    return { from, to: price };
  }

  getOrder(orderId: string): Order | null {
    const order = this.orders.get(orderId);
    if (!order) return null;
    if (order.status === 'pending' && this.isExpired(order)) {
      order.status = 'expired';
      this.saveToDisk();
    }
    return order;
  }

  /** 待确认：用户已点「我已付款」、等管理员核实到账（status = paid） */
  listPending(): Order[] {
    return Array.from(this.orders.values()).filter(o => o.status === 'paid');
  }

  /** 未付款：已创建订单但用户还没点「我已付款」（status = pending，可能已放弃） */
  listUnpaid(): Order[] {
    return Array.from(this.orders.values()).filter(o => o.status === 'pending');
  }

  /**
   * 全部订单
   */
  listAll(): Order[] {
    return Array.from(this.orders.values());
  }

  /**
   * 收入统计（已确认解锁的订单）
   * ordersCount = 已解锁**且真实付费**（source !== 'free'），即"真订单"笔数，别拿来当"会员人数"
   * freeOrdersCount = 已解锁但由运营免费开通（试用/赠送）的笔数，单列出来，避免被当订单读
   */
  revenueStats() {
    // 仅统计付费订单（source === 'paid'），免费开通（试用/赠送）不计入收入
    const unlocked = Array.from(this.orders.values()).filter(o => o.status === 'unlocked' && o.source !== 'free');
    const freeUnlocked = Array.from(this.orders.values()).filter(o => o.status === 'unlocked' && o.source === 'free');
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
    const startOfWeek = startOfToday - (now.getDay() || 7) * 24 * 60 * 60 * 1000;
    let total = 0, today = 0, yesterday = 0, week = 0;
    for (const o of unlocked) {
      const t = o.confirmedAt || o.createdAt;
      total += o.price;
      if (t >= startOfToday) today += o.price;
      else if (t >= startOfYesterday) yesterday += o.price;
      if (t >= startOfWeek) week += o.price;
    }
    return {
      total: Math.round(total * 100) / 100,
      today: Math.round(today * 100) / 100,
      yesterday: Math.round(yesterday * 100) / 100,
      week: Math.round(week * 100) / 100,
      ordersCount: unlocked.length,
      freeOrdersCount: freeUnlocked.length,
    };
  }

  /**
   * 三币种定价配置（供前端展示，顺序 USD → HKD → CNY）
   */
  getConfig() {
    const origHkd = (usd: number) => Math.round(usd * FX_USD_HKD * 100) / 100;
    const withYearlyLifetime = (plan: PlanKey, usd: number, cny: number, origUsd: number, origCny: number, subUsd: number, trialUsd: number | undefined) => {
      const yearly = getPriceFor(plan, 'yearly');
      const lifetime = getPriceFor(plan, 'lifetime');
      return {
        usd,
        hkd: Math.round(usd * FX_USD_HKD * 100) / 100,
        cny,
        originalUsd: origUsd,
        originalHkd: origHkd(origUsd),
        originalCny: origCny,
        discountPct: DISCOUNT_PCT,
        subUsd,       // 连续包月价（USD）
        subHkd: Math.round(subUsd * FX_USD_HKD * 100) / 100,
        subCny: Math.round(cny * (subUsd / usd)), // 连续包月价（CNY，同折扣比例取整到元）
        trialUsd: SUB_TRIAL_ENABLED ? trialUsd : undefined, // 首月试用价（可选）
        yearlyUsd: yearly.usd,
        yearlyHkd: yearly.hkd,
        yearlyCny: yearly.cny,
        lifetimeUsd: lifetime.usd,
        lifetimeHkd: lifetime.hkd,
        lifetimeCny: lifetime.cny,
      };
    };
    const launchActive = isLaunchOfferActive();
    const plans = {
      plus: withYearlyLifetime('plus', PLUS_PRICE_USD, PLUS_PRICE_CNY, PLUS_PRICE_USD_ORIG, PLUS_PRICE_CNY_ORIG, PLUS_PRICE_USD_SUB, PLUS_PRICE_USD_TRIAL),
      pro: withYearlyLifetime('pro', PRO_PRICE_USD, PRO_PRICE_CNY, PRO_PRICE_USD_ORIG, PRO_PRICE_CNY_ORIG, PRO_PRICE_USD_SUB, PRO_PRICE_USD_TRIAL),
    };
    return {
      unlockDays: UNLOCK_DAYS_COUNT,
      // 微信收款码（备用通道）：前端在付费弹窗里展示；URL 带内容哈希版本号，换图自动失效缓存
      payQrUrl: getPayQrUrl(),
      currencyOrder: ['USD', 'HKD', 'CNY'] as const,
      fxUsdHkd: FX_USD_HKD,
      discountPct: DISCOUNT_PCT,
      launchOffer: launchActive,
      offerEndsAt: getOfferEndsAt(), // 优惠截止日期（YYYY-MM-DD，可倒计时）
      plans,
      // 会员权益数值：前端对比表/推荐逻辑据此实时展示，避免 .env 改了、页面文案不同步
      quota: {
        freeStruct: FREE_STRUCT_COUNT,       // 理一理免费次数
        freeChat: FREE_CHAT_COUNT,           // 对话免费条数（聊一聊/角色扮演共用）
        chatDailyLimit: CHAT_DAILY_LIMIT_COUNT, // Plus 每日聊一聊条数
        contextFree: CONTEXT_FREE_COUNT,
        contextPlus: CONTEXT_PLUS_COUNT,
        contextPro: CONTEXT_PRO_COUNT,
        memoryFree: MEMORY_FREE_COUNT,
        memoryPlus: MEMORY_PLUS_COUNT,
        memoryPro: MEMORY_PRO_COUNT,
        autoPlayDailyLimit: AUTO_PLAY_DAILY_LIMIT_COUNT,
        // 专属画面（剧本场景图）：免费/Plus 每日新图上限，Pro 无限（见 sceneArt 的 CAP_BY_PLAN）
        // 推荐器权重：每模式一次动作 = 多少条（单源 = quota.ts 的价目表，前端不写死）
        featureCostTiao: featureCostTiao(),
        sceneArtFree: SCENE_ART_CAP_FREE,
        sceneArtPlus: SCENE_ART_CAP_PLUS,
        // 统一点数（credit）：后端按预计/实际 token 折算，前端可换算成「≈ 还能聊 N 条」
        creditEnabled: isCreditQuotaEnabled(), // 统一口径是否已开：前端据此把「条数」行换成「AI 额度（共用一个池）」
        freeDailyCredit: FREE_DAILY_CREDIT_COUNT,      // 注册免费档：20 条/天
        guestDailyCredit: GUEST_DAILY_CREDIT_COUNT,    // 游客档：5 条/天（对比表/引导文案据此显示，不写死）
        plusDailyCredit: PLUS_DAILY_CREDIT_COUNT,
        proDailyCredit: PRO_DAILY_CREDIT_COUNT,
        unitCredit: UNIT_CREDIT_COUNT,
      },
    };
  }

  /**
   * 匿名化某用户的订单（账户注销时：保留财务记录，清除用户关联）
   */
  anonymizeOrders(userId: string): void {
    let changed = false;
    for (const o of this.orders.values()) {
      if (o.userId === userId) {
        o.userId = 'DELETED_USER';
        o.remark = (o.remark ? o.remark + ' | ' : '') + '[账号已注销]';
        changed = true;
      }
    }
    if (changed) this.saveToDisk();
  }
}

export const paymentStore = new PaymentStore();
export default paymentStore;
