/**
 * Stripe Webhook 已处理事件去重（幂等）
 * 持久化到 data/stripe-events.json；进程内 Set + 同步落盘，重启不丢。
 * Stripe 官方对未确认成功的 webhook 会重试投递（最长约 3 天）——重复事件必须跳过，
 * 否则会重复解锁/重复建单。
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const EVENTS_FILE = dataFile('stripe-events.json');

class StripeEventStore {
  private processed: Set<string> = new Set();

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const parsed = readJson<string[]>(EVENTS_FILE, []);
    if (Array.isArray(parsed)) {
      parsed.forEach((id) => { if (id) this.processed.add(id); });
    }
  }

  private saveToDisk(): void {
    try {
      writeJson(EVENTS_FILE, Array.from(this.processed));
    } catch { /* 忽略 */ }
  }

  /** 该事件是否已处理过 */
  has(eventId: string): boolean {
    return this.processed.has(eventId);
  }

  /** 标记已处理并落盘（幂等） */
  mark(eventId: string): void {
    if (this.processed.has(eventId)) return;
    this.processed.add(eventId);
    this.saveToDisk();
  }
}

export const stripeEventStore = new StripeEventStore();
export default stripeEventStore;
