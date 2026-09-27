/**
 * 用户反馈收集模块
 * 持久化到 data/feedback.json
 */

import 'dotenv/config';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const FILE = dataFile('feedback.json');

export interface Feedback {
  id: string;
  userId: string;
  type: string; // 建议 | 问题 | 夸奖 | 其他
  content: string;
  contact?: string; // 联系方式（选填）
  context?: string; // 附带上下文（AI 回答 / 最近对话，便于定位问题）
  createdAt: number;
  status: 'pending' | 'accepted' | 'rejected'; // 处理状态
  reward: number; // 被采纳后奖励的消息条数（0 = 无）
}

class FeedbackStore {
  private items: Feedback[] = [];

  constructor() { this.loadFromDisk(); }

  private loadFromDisk(): void {
    const parsed = readJson<Feedback[]>(FILE, []);
    if (Array.isArray(parsed)) this.items = parsed;
  }

  private saveToDisk(): void {
    try {
      writeJson(FILE, this.items);
    } catch { /* 忽略 */ }
  }

  add(userId: string, type: string, content: string, contact?: string, context?: string): Feedback {
    const item: Feedback = {
      id: 'fb' + Date.now() + Math.random().toString(36).slice(2, 6),
      userId,
      type: String(type || '其他').slice(0, 10),
      content: String(content || '').slice(0, 1000),
      contact: contact ? String(contact).slice(0, 100) : undefined,
      context: context ? String(context).slice(0, 2000) : undefined,
      createdAt: Date.now(),
      status: 'pending',
      reward: 0,
    };
    this.items.push(item);
    this.saveToDisk();
    return item;
  }

  listAll(): Feedback[] {
    return this.items.slice().sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Feedback | undefined {
    return this.items.find(f => f.id === id);
  }

  /**
   * 采纳反馈并发放奖励（消息条数），状态置为 accepted
   */
  setReward(id: string, reward: number): boolean {
    const f = this.items.find(x => x.id === id);
    if (!f) return false;
    f.status = 'accepted';
    f.reward = reward;
    this.saveToDisk();
    return true;
  }

  /**
   * 删除某用户的反馈（账户注销时）
   */
  removeByUser(userId: string): void {
    const before = this.items.length;
    this.items = this.items.filter(f => f.userId !== userId);
    if (this.items.length !== before) this.saveToDisk();
  }
}

export const feedbackStore = new FeedbackStore();
export default feedbackStore;
