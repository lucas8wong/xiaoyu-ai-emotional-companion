/**
 * 按日行为日志（运营端「用户行为」区间统计的数据源）
 *
 * 背景：运营端此前只有「累计值」计数（聊一聊/理一理/剧情/登录/安装/点赞），
 * 无法回答「近 7 天聊了多少轮」这类区间问题。本模块从上线起把每个功能事件按
 * 「日 × 用户/游客」落一份明细，供 `GET /api/payment/admin/activity?from&to`
 * 做区间汇总与区间行展示。
 *
 * 口径：
 * - 与 usageTime 一致：日期键 = 服务端本地日期 YYYY-MM-DD。
 * - 事件类型：chat(聊一聊) / structure(理一理) / roleplay(剧情演绎·**合计**，含千世书与狼人杀) /
 *   wenyou(AI 文游) / werewolf(AI 狼人杀，**按局**计) / login(登录+注册) /
 *   install(下载/安装 Xiaoyu) / likes(剧情点赞成功事件)。
 * - **roleplay 恒等于 wenyou + werewolf + 剧情扮演**：写 wenyou/werewolf 桶时 addEvent 会同步给
 *   roleplay 也 +1，所以「剧情总轮次」在区间视图里同样是合计、老数据不断层。
 * - 注销删除与「游客并入账号」都要同步本日志（见 activityStore 的 remove/mergeFrom）。
 * - 自部署起累计；早于部署日期的历史区间无可回算，前端标注起点。
 * - 模式明细（wenyou/werewolf）自 2026-09-16 起累计，早于该日的区间为 0（不回溯）。
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import type { RoleplayMode } from './activity.js';

const FILE = dataFile('behavior-daily.json');

export type BehaviorEventType = 'chat' | 'structure' | 'roleplay' | 'wenyou' | 'werewolf' | 'login' | 'install' | 'likes';

export const BEHAVIOR_TYPES: BehaviorEventType[] = ['chat', 'structure', 'roleplay', 'wenyou', 'werewolf', 'login', 'install', 'likes'];

/** 需要「同时给 roleplay 合计 +1」的模式桶（roleplay 自己就是合计桶，故不在其中） */
const MODE_BUCKETS: RoleplayMode[] = ['wenyou', 'werewolf'];

/** 某用户某一天的各类型事件计数 + 当日最后事件时间戳 */
export interface BehaviorDayCell {
  chat: number;
  structure: number;
  /** 剧情演绎**合计**（含剧情扮演 / AI 文游 / AI 狼人杀） */
  roleplay: number;
  /** AI 文游回合数（模式明细，自 2026-09-16 起） */
  wenyou: number;
  /** AI 狼人杀**局数**（模式明细，自 2026-09-16 起） */
  werewolf: number;
  login: number;
  install: number;
  likes: number;
  /** 当日最后一次写入行为事件的时间戳（ms），供区间「最后活跃」排序/展示 */
  lastAt: number;
}

export interface BehaviorDailyEntry {
  userId: string;
  /** key = YYYY-MM-DD（服务端本地日期） */
  daily: Record<string, BehaviorDayCell>;
}

export interface BehaviorRangeUser {
  userId: string;
  chat: number;
  structure: number;
  roleplay: number;
  wenyou: number;
  werewolf: number;
  login: number;
  install: number;
  likes: number;
  /** 区间内最后一次行为事件时间戳（ms）；无则 0 */
  lastAt: number;
}

export interface BehaviorRangeSummary {
  totalUsers: number;
  users: BehaviorRangeUser[];
  totals: { chat: number; structure: number; roleplay: number; wenyou: number; werewolf: number; login: number; install: number; likes: number };
}

const zeroCell = (): BehaviorDayCell => ({ chat: 0, structure: 0, roleplay: 0, wenyou: 0, werewolf: 0, login: 0, install: 0, likes: 0, lastAt: 0 });

/** 服务端本地日期键（YYYY-MM-DD），与 usageTime 保持一致 */
function localKeyOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function _todayLocalKey(): string {
  return localKeyOf(Date.now());
}

class BehaviorDailyStore {
  private map: Map<string, Record<string, BehaviorDayCell>> = new Map();

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const parsed = readJson<BehaviorDailyEntry[]>(FILE, []);
    if (Array.isArray(parsed)) {
      for (const e of parsed) {
        if (e?.userId && e.daily && typeof e.daily === 'object') {
          // 兼容磁盘旧 cell 缺字段（防御：写入后再读回时字段可能不齐）
          const clean: Record<string, BehaviorDayCell> = {};
          for (const [date, cell] of Object.entries(e.daily)) {
            if (!date || !cell || typeof cell !== 'object') continue;
            clean[date] = {
              chat: Number(cell.chat) || 0,
              structure: Number(cell.structure) || 0,
              roleplay: Number(cell.roleplay) || 0,
              wenyou: Number(cell.wenyou) || 0,
              werewolf: Number(cell.werewolf) || 0,
              login: Number(cell.login) || 0,
              install: Number(cell.install) || 0,
              likes: Number(cell.likes) || 0,
              lastAt: Number(cell.lastAt) || 0,
            };
          }
          this.map.set(e.userId, clean);
        }
      }
    }
  }

  private saveToDisk(): void {
    try {
      const out: BehaviorDailyEntry[] = Array.from(this.map.entries()).map(([userId, daily]) => ({ userId, daily }));
      writeJson(FILE, out);
    } catch (e) {
      console.warn('⚠️ [BehaviorDaily] 保存行为日志失败:', (e as Error)?.message);
    }
  }

  /**
   * 记录一次行为事件（按服务端本地日期入桶）。
   * `mode` 仅对 type === 'roleplay' 有意义：写「AI 文游 / AI 狼人杀」桶时**同时**给 roleplay 合计桶 +1，
   * 这样「剧情总轮次」在按日与区间口径里都恒等于三模式之和（老数据不断层）。
   */
  addEvent(userId: string, type: BehaviorEventType, at = Date.now(), mode?: RoleplayMode): void {
    if (!userId || !BEHAVIOR_TYPES.includes(type)) return;
    const date = localKeyOf(at);
    const daily = this.map.get(userId) || {};
    const cell = daily[date] || zeroCell();
    cell[type] += 1;
    if (type === 'roleplay' && mode && MODE_BUCKETS.includes(mode)) cell[mode] += 1;
    if (at > cell.lastAt) cell.lastAt = at;
    daily[date] = cell;
    this.map.set(userId, daily);
    this.saveToDisk();
  }

  /** 直接设置某用户某一天某类事件的次数（测试/数据修正用；覆盖累加） */
  setDayCounts(
    userId: string,
    date: string,
    partial: Partial<Pick<BehaviorDayCell, BehaviorEventType>>,
    lastAt = 0
  ): void {
    if (!userId || !date) return;
    const daily = this.map.get(userId) || {};
    const cell = daily[date] || zeroCell();
    for (const k of BEHAVIOR_TYPES) {
      if (typeof partial[k] === 'number') (cell[k] as number) = Math.max(0, Math.floor(partial[k] as number));
    }
    if (lastAt > cell.lastAt) cell.lastAt = lastAt;
    daily[date] = cell;
    this.map.set(userId, daily);
    this.saveToDisk();
  }

  /** 区间汇总（含首尾；字符串字典序比较即按日期）。区间内无数据返回空。 */
  getRangeSummary(from: string, to: string): BehaviorRangeSummary {
    let start = from;
    let end = to;
    if (start > end) { const t = start; start = end; end = t; }

    const users: BehaviorRangeUser[] = [];
    const totals = { chat: 0, structure: 0, roleplay: 0, wenyou: 0, werewolf: 0, login: 0, install: 0, likes: 0 };

    for (const [userId, daily] of this.map.entries()) {
      const acc = zeroCell();
      let inRange = false;
      for (const [date, cell] of Object.entries(daily)) {
        if (date < start || date > end) continue;
        inRange = true;
        for (const k of BEHAVIOR_TYPES) {
          acc[k] += cell[k] || 0;
          totals[k] += cell[k] || 0;
        }
        if (cell.lastAt > acc.lastAt) acc.lastAt = cell.lastAt;
      }
      if (!inRange) continue;
      users.push({ userId, chat: acc.chat, structure: acc.structure, roleplay: acc.roleplay, wenyou: acc.wenyou, werewolf: acc.werewolf, login: acc.login, install: acc.install, likes: acc.likes, lastAt: acc.lastAt });
    }

    users.sort((a, b) => b.lastAt - a.lastAt);
    return { totalUsers: users.length, users, totals };
  }

  /** 某用户在区间内的合计（无记录返回 null） */
  getUserRange(userId: string, from: string, to: string): BehaviorRangeUser | null {
    let start = from;
    let end = to;
    if (start > end) { const t = start; start = end; end = t; }
    const daily = this.map.get(userId);
    if (!daily) return null;
    const acc = zeroCell();
    let inRange = false;
    for (const [date, cell] of Object.entries(daily)) {
      if (date < start || date > end) continue;
      inRange = true;
      for (const k of BEHAVIOR_TYPES) {
        acc[k] += cell[k] || 0;
      }
      if (cell.lastAt > acc.lastAt) acc.lastAt = cell.lastAt;
    }
    if (!inRange) return null;
    return { userId, chat: acc.chat, structure: acc.structure, roleplay: acc.roleplay, wenyou: acc.wenyou, werewolf: acc.werewolf, login: acc.login, install: acc.install, likes: acc.likes, lastAt: acc.lastAt };
  }

  /** 某用户全量累计（所有日期，调试/注销审计用） */
  getUserLifetimeCounts(userId: string): { [K in BehaviorEventType]: number } {
    const out = { chat: 0, structure: 0, roleplay: 0, wenyou: 0, werewolf: 0, login: 0, install: 0, likes: 0 };
    const daily = this.map.get(userId);
    if (!daily) return out;
    for (const cell of Object.values(daily)) {
      for (const k of BEHAVIOR_TYPES) out[k] += cell[k] || 0;
    }
    return out;
  }

  /** 游客并入账号：把 from 的全部按日记录并入 to（同类同日相加），随后删除 from */
  mergeUsers(fromId: string, toId: string): void {
    if (!fromId || !toId || fromId === toId) return;
    const from = this.map.get(fromId);
    if (!from) return;
    const to = this.map.get(toId) || {};
    for (const [date, cell] of Object.entries(from)) {
      const tc = to[date] || zeroCell();
      for (const k of BEHAVIOR_TYPES) {
        tc[k] += cell[k] || 0;
      }
      if (cell.lastAt > tc.lastAt) tc.lastAt = cell.lastAt;
      to[date] = tc;
    }
    this.map.set(toId, to);
    this.map.delete(fromId);
    this.saveToDisk();
  }

  /** 删除某用户全部日志（账号注销/合规删除） */
  deleteUser(userId: string): void {
    if (this.map.delete(userId)) this.saveToDisk();
  }

  /** 列出全部记录（测试用） */
  listAll(): BehaviorDailyEntry[] {
    return Array.from(this.map.entries()).map(([userId, daily]) => ({ userId, daily }));
  }
}

export const behaviorDailyStore = new BehaviorDailyStore();
export default behaviorDailyStore;
