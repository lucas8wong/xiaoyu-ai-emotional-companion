/**
 * 订阅存储（连续包月 · Stripe 通道）
 * 持久化到 data/subscriptions.json
 * 生命周期：active(有效) → 到期前 cancel_at_period_end=true(当期仍有效) → canceled(周期结束)
 * 每次扣款成功(invoice.paid)续期 30 天；扣款失败 payment_failed 标记，宽限期内重试
 */

import 'dotenv/config';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const FILE = dataFile('subscriptions.json');

export interface Subscription {
  id: string;                    // 本地主键（sub_ 前缀取 Stripe 的 id）
  userId: string;
  stripeCustomerId?: string;
  plan: 'plus' | 'pro';          // 订阅档位
  status: 'active' | 'past_due' | 'canceled' | 'incomplete'; // Stripe 订阅状态
  currentPeriodEnd: number;      // 当前已付周期结束时间戳(ms)
  cancelAtPeriodEnd: boolean;    // 是否已申请取消(当期仍有效)
  createdAt: number;
  updatedAt: number;
}

class SubscriptionStore {
  private items: Map<string, Subscription> = new Map();

  constructor() { this.loadFromDisk(); }

  private loadFromDisk(): void {
    const parsed = readJson<Subscription[]>(FILE, []);
    if (Array.isArray(parsed)) parsed.forEach((s: Subscription) => { if (s && s.id) this.items.set(s.id, s); });
    console.log(`💾 [Subscription] 已从磁盘加载 ${this.items.size} 个订阅`);
  }

  private saveToDisk(): void {
    try {
      writeJson(FILE, Array.from(this.items.values()));
    } catch { /* 忽略 */ }
  }

  /** 新建订阅 */
  upsert(sub: Subscription): void {
    this.items.set(sub.id, sub);
    this.saveToDisk();
  }

  get(id: string): Subscription | undefined {
    return this.items.get(id);
  }

  /** 按用户查活跃订阅 */
  getByUser(userId: string): Subscription | undefined {
    for (const s of this.items.values()) {
      if (s.userId === userId && s.status !== 'canceled') return s;
    }
    return undefined;
  }

  /** 全部订阅（运营端） */
  listAll(): Subscription[] {
    return Array.from(this.items.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 注销时匿名化订阅记录（P1-03）：清空 userId / stripeCustomerId（支付关联 PII），
   * 保留 plan/status/period 等财务审计字段。
   */
  anonymizeByUser(userId: string): void {
    let changed = false;
    for (const s of this.items.values()) {
      if (s.userId === userId) {
        s.userId = 'DELETED_USER';
        s.stripeCustomerId = '';
        changed = true;
      }
    }
    if (changed) this.saveToDisk();
  }
}

export const subscriptionStore = new SubscriptionStore();
export default subscriptionStore;
