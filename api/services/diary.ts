/**
 * 心情日记模块
 * 每日记录心情（情绪 emoji + 一句话），统计连续打卡天数
 * 持久化到 data/diaries.json
 */

import 'dotenv/config';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { quotaStore } from './quota.js';

const DIARIES_FILE = dataFile('diaries.json');

// 打卡奖励：每天首次记录心情即奖励 5 次免费体验（全局应用）
const DAILY_CHECKIN_BONUS = 5;

export interface DiaryEntry {
  userId: string;
  date: string; // YYYY-MM-DD（本地日期）
  mood: string; // emoji key
  note: string;
  createdAt: number;
}

export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

class DiaryStore {
  private entries: DiaryEntry[] = [];

  constructor() {
    this.loadFromDisk();
  }

  /**
   * 删除某用户的全部日记记录（账户注销时）
   */
  removeByUser(userId: string): void {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.userId !== userId);
    if (this.entries.length !== before) this.saveToDisk();
  }

  private loadFromDisk(): void {
    const parsed = readJson<DiaryEntry[]>(DIARIES_FILE, []);
    if (Array.isArray(parsed)) this.entries = parsed;
  }

  private saveToDisk(): void {
    try {
      writeJson(DIARIES_FILE, this.entries);
    } catch { /* 忽略 */ }
  }

  /**
   * 记录/更新当日心情（同一天重复提交则覆盖），并发放每日打卡奖励
   * @returns { entry, streak, reward }
   */
  save(userId: string, mood: string, note: string): { entry: DiaryEntry; streak: number; reward: { bonus: number } | null } {
    const date = todayStr();
    const idx = this.entries.findIndex(e => e.userId === userId && e.date === date);
    if (idx >= 0) {
      // 同一天重复提交：仅覆盖内容，不重复发奖
      this.entries[idx] = { ...this.entries[idx], mood, note, createdAt: Date.now() };
    } else {
      this.entries.push({ userId, date, mood, note, createdAt: Date.now() });
    }
    this.saveToDisk();

    const streak = this.streak(userId);
    let reward: { bonus: number } | null = null;
    if (idx < 0) {
      // 当天首次打卡 → 奖励 DAILY_CHECKIN_BONUS 次免费体验（全局应用）
      quotaStore.addBonus(userId, DAILY_CHECKIN_BONUS, 'checkin');
      reward = { bonus: DAILY_CHECKIN_BONUS };
      console.log(`🎁 [Diary] 用户 ${userId.slice(0, 8)} 今日打卡，奖励 ${DAILY_CHECKIN_BONUS} 次免费`);
    }
    return { entry: this.entries[idx] || this.entries[this.entries.length - 1], streak, reward };
  }

  /**
   * 打卡统计：统计 [from, to] 日期范围内（含端点；YYYY-MM-DD，缺省不限）的去重打卡用户数与打卡总次数。
   * 可选传入 excluded（如测试/开发者账号 id）将其排除，使口径与「用户行为」主表一致。
   */
  checkinStats(from?: string, to?: string, excluded?: Set<string>): { users: number; count: number } {
    const seen = new Set<string>();
    let count = 0;
    for (const e of this.entries) {
      if (from && e.date < from) continue;
      if (to && e.date > to) continue;
      if (excluded && excluded.has(e.userId)) continue;
      seen.add(e.userId);
      count += 1;
    }
    return { users: seen.size, count };
  }

  /**
   * 逐用户打卡统计：返回 userId → { count, lastAt }（count=区间内打卡次数，lastAt=区间内最近一次打卡时间戳）。
   * [from, to] 为 YYYY-MM-DD 日期（含端点，缺省不限）；excluded 为需排除的 userId 集合。
   */
  checkinByUser(from?: string, to?: string, excluded?: Set<string>): Map<string, { count: number; lastAt: number }> {
    const m = new Map<string, { count: number; lastAt: number }>();
    for (const e of this.entries) {
      if (from && e.date < from) continue;
      if (to && e.date > to) continue;
      if (excluded && excluded.has(e.userId)) continue;
      const cur = m.get(e.userId);
      if (cur) {
        cur.count += 1;
        if (e.createdAt && e.createdAt > cur.lastAt) cur.lastAt = e.createdAt;
      } else {
        m.set(e.userId, { count: 1, lastAt: e.createdAt || 0 });
      }
    }
    return m;
  }

  /**
   * 逐用户打卡日期列表：返回 userId → 按日期升序的打卡日期数组（YYYY-MM-DD）。
   * 供「打卡次数」统计卡下钻逐条展示（同一用户多天打卡 → 多条记录，与「打卡用户」区分）。
   */
  checkinDatesByUser(from?: string, to?: string, excluded?: Set<string>): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const e of this.entries) {
      if (from && e.date < from) continue;
      if (to && e.date > to) continue;
      if (excluded && excluded.has(e.userId)) continue;
      const cur = m.get(e.userId);
      if (cur) cur.push(e.date);
      else m.set(e.userId, [e.date]);
    }
    for (const arr of m.values()) arr.sort();
    return m;
  }

  /**
   * 用户全部日记（按日期倒序）
   */
  list(userId: string): DiaryEntry[] {
    return this.entries.filter(e => e.userId === userId).sort((a, b) => b.date.localeCompare(a.date));
  }

  /**
   * 连续打卡天数（从今天或昨天开始往前数）
   */
  streak(userId: string): number {    const dates = new Set(this.list(userId).map(e => e.date));
    if (dates.size === 0) return 0;
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cursor = new Date();
    // 今天没记录则从昨天开始算
    if (!dates.has(fmt(cursor))) {
      cursor.setDate(cursor.getDate() - 1);
      if (!dates.has(fmt(cursor))) return 0;
    }
    let count = 0;
    while (dates.has(fmt(cursor))) {
      count += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return count;
  }
}

export const diaryStore = new DiaryStore();
export default diaryStore;
