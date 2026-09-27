/**
 * 狼人杀 · 对局台账（**两种实现共用一份**）
 *
 * 为什么需要这份东西：
 *  - `werewolf-stats.json`（累计计数）只记数量，运营端还要看「最近对局」明细；
 *  - 自研引擎把对局存在 `werewolf-games.json`（完整状态机快照），而**移植版不写那份**；
 *  - 结果就是页签上「累计开局 N」与「最近对局表」来自两个不同来源、口径对不上（实测过）。
 *
 * 这里改为**双方都往同一份轻量台账写一条开局记录**，运营端只读它 —— 累计与明细自然同源。
 * 只记「开局」，不记整局状态：运营端要看的是用量与分布，不是回放。
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';

export interface LedgerEntry {
  id: string;
  /** 毫秒时间戳 */
  at: number;
  userId: string;
  /** 局型人数 */
  size: number;
  /** 档位 free | plus | pro */
  plan: string;
  /** 哪个实现开的局：wolfcha = 移植版（现网） / engine = 自研引擎（保留） */
  source: 'wolfcha' | 'engine';
}

const FILE = dataFile('werewolf-ledger.json');
const MAX_ENTRIES = 1000;

/** 按用户聚合的结果（运营端「谁在玩狼人杀」表用；全部由台账现算，无独立存储） */
export interface WerewolfUserSummary {
  userId: string;
  /** 台账内开局局数 */
  games: number;
  firstAt: number;
  lastAt: number;
  /** 最近一局的局型人数 */
  lastSize: number;
  /** 最近一局的档位 free | plus | pro */
  lastPlan: string;
  /** 最近一局来自哪个实现 */
  lastSource: 'wolfcha' | 'engine';
  /** 局型分布：人数 → 局数 */
  sizes: Record<string, number>;
}

class WerewolfLedger {
  private items: LedgerEntry[] = readJson<LedgerEntry[]>(FILE, []) || [];

  record(entry: Omit<LedgerEntry, 'id' | 'at'>): void {
    this.items.push({
      ...entry,
      id: `ww_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
    });
    if (this.items.length > MAX_ENTRIES) this.items = this.items.slice(-MAX_ENTRIES);
    try {
      writeJson(FILE, this.items);
    } catch {
      /* 台账落盘失败不阻断开局 */
    }
  }

  /** 最近 N 条（新的在前） */
  recent(limit = 20): LedgerEntry[] {
    return this.items.slice(-limit).reverse();
  }

  /** 台账里记录的开局总数（与累计计数同源口径：都从同一个动作 +1） */
  total(): number {
    return this.items.length;
  }

  /** 今日开局数 */
  todayCount(): number {
    const d = new Date();
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    return this.items.filter((e) => {
      const t = new Date(e.at);
      return `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}` === key;
    }).length;
  }

  /**
   * 按用户聚合（运营端「谁在玩狼人杀」）。
   * 直接从台账现算，**不新增文件、不新增写入**——因此与「累计开局」同源，两处数字不会打架。
   */
  userSummaries(): WerewolfUserSummary[] {
    const byUser = new Map<string, WerewolfUserSummary>();
    for (const e of this.items) {
      if (!e.userId) continue;
      const cur = byUser.get(e.userId);
      if (!cur) {
        byUser.set(e.userId, {
          userId: e.userId,
          games: 1,
          firstAt: e.at,
          lastAt: e.at,
          lastSize: e.size,
          lastPlan: e.plan,
          lastSource: e.source,
          sizes: { [e.size]: 1 },
        });
      } else {
        cur.games += 1;
        if (e.at < cur.firstAt) cur.firstAt = e.at;
        if (e.at >= cur.lastAt) {
          cur.lastAt = e.at;
          cur.lastSize = e.size;
          cur.lastPlan = e.plan;
          cur.lastSource = e.source;
        }
        cur.sizes[e.size] = (cur.sizes[e.size] || 0) + 1;
      }
    }
    return Array.from(byUser.values()).sort((a, b) => b.games - a.games || b.lastAt - a.lastAt);
  }

  /** 单个用户在台账里的开局明细（新的在前）——运营端用户详情用 */
  byUser(userId: string, limit = 20): LedgerEntry[] {
    if (!userId) return [];
    return this.items.filter((e) => e.userId === userId).slice(-limit).reverse();
  }

  /** 单个用户在台账里的开局总数 */
  countForUser(userId: string): number {
    if (!userId) return 0;
    return this.items.reduce((n, e) => (e.userId === userId ? n + 1 : n), 0);
  }
}

export const werewolfLedger = new WerewolfLedger();
