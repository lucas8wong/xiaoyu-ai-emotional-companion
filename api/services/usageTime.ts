/**
 * 用户真实使用时长统计模块
 *
 * 从用户端「活跃时长埋点」接收心跳（页面前台且聚焦时），按「日 × 用户/游客」
 * 累计活跃秒数，持久化到 data/usage-time.json。
 * 供控制台「用户行为」页查看每位用户的累计使用时长，并按日期范围汇总总数。
 *
 * 口径：
 * - 只累计用户端上报的活跃时长（页面可见 + 窗口聚焦），不含后台标签/最小化时间。
 * - 该功能自上线起开始累计，早于上线的时间无历史数据。
 * - 日期键使用服务端本地日期 YYYY-MM-DD（与 api/services/usage.ts 一致）。
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const USAGE_TIME_FILE = dataFile('usage-time.json');

/** 单次上报秒数上限（防异常/滥用；前端每次约 30s 提交一次 + 离开兜底） */
const MAX_TICK_SECONDS = 3600;
/** 单人单日秒数上限（24h，防异常上报把某人刷成天文数字） */
const MAX_DAY_SECONDS = 86400;

export interface UsageTimeEntry {
  userId: string;
  /** 按天累计的活跃秒数，key = YYYY-MM-DD（服务端本地日期） */
  daily: Record<string, number>;
}

export interface RangeSummary {
  /** 区间内全部用户/游客活跃总秒数 */
  totalSeconds: number;
  /** 区间内有活跃时长的用户/游客数量 */
  activeUsers: number;
  /** 全量累计（所有日期）活跃总秒数 */
  lifetimeTotal: number;
  /** 区间内按日合计：date → 全体用户当日活跃秒数之和 */
  daily: { date: string; seconds: number }[];
  /** 区间内按用户合计（降序）：seconds 为区间内秒数，lifetimeSeconds 为全量累计 */
  users: { userId: string; seconds: number; lifetimeSeconds: number; daily: Record<string, number> }[];
}

/** 本地日期键（YYYY-MM-DD）——与 usage.ts 的 getDailyTrend 口径保持一致 */
function todayLocalKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

class UsageTimeStore {
  private map: Map<string, Record<string, number>> = new Map();

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const parsed = readJson<UsageTimeEntry[]>(USAGE_TIME_FILE, []);
    if (Array.isArray(parsed)) {
      for (const e of parsed) {
        if (e?.userId && e.daily && typeof e.daily === 'object') {
          this.map.set(e.userId, e.daily);
        }
      }
    }
  }

  private saveToDisk(): void {
    try {
      const out: UsageTimeEntry[] = Array.from(this.map.entries()).map(([userId, daily]) => ({ userId, daily }));
      writeJson(USAGE_TIME_FILE, out);
    } catch (e) {
      console.warn('⚠️ [UsageTime] 保存使用时长数据失败:', (e as Error)?.message);
    }
  }

  /**
   * 记录一次活跃时长（秒），加到当天 bucket。
   * @param userId 用户唯一标识（登录账号 userId 或游客设备指纹）
   * @param seconds 本次上报的活跃秒数（取整，范围 1–MAX_TICK_SECONDS）
   */
  addActiveTime(userId: string, seconds: number): void {
    if (!userId) return;
    const sec = Math.floor(Number(seconds) || 0);
    if (sec <= 0) return;
    const capped = Math.min(sec, MAX_TICK_SECONDS);
    const date = todayLocalKey();
    const daily = this.map.get(userId) || {};
    daily[date] = (daily[date] || 0) + capped;
    this.map.set(userId, daily);
    this.saveToDisk();
  }

  /**
   * 直接设置某用户某一天的活跃秒数（覆盖旧值）。
   * 主要用于测试与数据修正/回填；正常上报走 addActiveTime。
   */
  setDailySeconds(userId: string, date: string, seconds: number): void {
    if (!userId || !date) return;
    const daily = this.map.get(userId) || {};
    daily[date] = Math.min(Math.max(Math.floor(Number(seconds) || 0), 0), MAX_TICK_SECONDS);
    this.map.set(userId, daily);
    this.saveToDisk();
  }

  /** 某用户全量累计活跃秒数（所有日期） */
  getUserLifetime(userId: string): number {
    const daily = this.map.get(userId);
    if (!daily) return 0;
    let total = 0;
    for (const s of Object.values(daily)) total += s;
    return total;
  }

  /**
   * 游客并入账号：把 from 的按日秒数按天累加进 to，随后删除 from。
   * 为什么需要：注册时 `mergeGuestData` 会把配额/会话/剧情/行为日志都带过去，
   * 唯独漏了使用时长 → 游客期记到的时长留在游客身份下，账号侧看起来「一注册就没有时长」。
   */
  mergeUsers(fromId: string, toId: string): void {
    if (!fromId || !toId || fromId === toId) return;
    const from = this.map.get(fromId);
    if (!from) return;
    const to = this.map.get(toId) || {};
    for (const [date, sec] of Object.entries(from)) {
      to[date] = Math.min((to[date] || 0) + (Number(sec) || 0), MAX_DAY_SECONDS);
    }
    this.map.set(toId, to);
    this.map.delete(fromId);
    this.saveToDisk();
  }

  /** 账户注销时清理（合规：个人数据删除） */
  deleteUser(userId: string): void {
    if (!userId) return;
    if (this.map.delete(userId)) this.saveToDisk();
  }

  /**
   * 区间汇总（日期键为 YYYY-MM-DD，区间含首尾，字符串字典序比较即按日期）。
   * @param from 起始日期（含）
   * @param to 结束日期（含）；若 from > to 自动交换
   */
  getRangeSummaries(from: string, to: string): RangeSummary {
    let start = from;
    let end = to;
    if (start > end) { const t = start; start = end; end = t; }

    const dailyTotals = new Map<string, number>();
    const users: RangeSummary['users'] = [];
    let totalSeconds = 0;
    let activeUsers = 0;
    let lifetimeTotal = 0;

    for (const [userId, daily] of this.map.entries()) {
      let rangeSec = 0;
      let lifetimeSec = 0;
      const inRangeDaily: Record<string, number> = {};
      for (const [date, sec] of Object.entries(daily)) {
        lifetimeSec += sec;
        if (date >= start && date <= end) {
          rangeSec += sec;
          inRangeDaily[date] = sec;
          dailyTotals.set(date, (dailyTotals.get(date) || 0) + sec);
        }
      }
      lifetimeTotal += lifetimeSec;
      if (rangeSec > 0) {
        activeUsers += 1;
        totalSeconds += rangeSec;
        users.push({ userId, seconds: rangeSec, lifetimeSeconds: lifetimeSec, daily: inRangeDaily });
      }
    }

    users.sort((a, b) => b.seconds - a.seconds || b.lifetimeSeconds - a.lifetimeSeconds);

    const daily = Array.from(dailyTotals.entries())
      .map(([date, seconds]) => ({ date, seconds }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return { totalSeconds, activeUsers, lifetimeTotal, daily, users };
  }

  /** 列出全部记录（调试/测试用） */
  listAll(): UsageTimeEntry[] {
    return Array.from(this.map.entries()).map(([userId, daily]) => ({ userId, daily }));
  }
}

/**
 * 心跳诊断计数（2026-09-18 新增，配合「区间使用=0 秒」排查）
 *
 * 背景：控制台里大量游客「区间使用」是 0 秒，排查发现两类成因无法从现有账本分辨：
 *   ① 兜底 flush（`navigator.sendBeacon`）**带不上自定义请求头** → 身份丢失，时长记到「无设备身份」幽灵 id 上；
 *   ② 客户端活跃门要求 `document.hasFocus()`，而内嵌浏览器/WebView（WKWebView 等）里它可能恒为 false
 *      → 整段访问一秒都不计，而且因为 accum=0 连一次上报都没有，线上完全看不见。
 * 所以这里加一组**只计数、不带任何内容**的诊断：每次上报附带 vis/focus/interaction 三个布尔，
 * 以及「0 秒兜底诊断」（diagOnly）——让「门是不是一直关着」在数据里可见。
 *
 * 测试/内网/运营自查流量一律不计数（与主账本同一道门，见 routes/usageTime.ts）。
 */
export interface UsageDiagSnapshot extends Record<string, number> {
  /** 带诊断字段的上报次数（含 0 秒兜底诊断） */
  reports: number;
  /** 真正记到秒数的上报次数 */
  withSeconds: number;
  /** 0 秒兜底诊断次数（= 这一整段活跃时间没计到任何秒数） */
  diagOnly: number;
  /** 最后更新时间戳（ms） */
  updatedAt: number;
}

/** 固定诊断计数键（快照里缺省补 0，控制台不必判空） */
const DIAG_KEYS = [
  'reports', 'withSeconds', 'diagOnly', 'beacon', 'fetch',
  'identityHeader', 'identityBody', 'identityAccount', 'identityGuest',
  'visible', 'focused', 'interacted', 'focusFalseVisible', 'gateClosedVisible', 'autoLike',
] as const;

class UsageDiagStore {
  private counters: Record<string, number> = {};
  private updatedAt = 0;
  private readonly file = dataFile('usage-time-diag.json');

  constructor() { this.loadFromDisk(); }

  private loadFromDisk(): void {
    const parsed = readJson<{ counters?: Record<string, number>; updatedAt?: number }>(this.file, {});
    if (parsed && typeof parsed === 'object') {
      if (parsed.counters && typeof parsed.counters === 'object') {
        for (const [k, v] of Object.entries(parsed.counters)) {
          if (typeof v === 'number' && Number.isFinite(v)) this.counters[k] = v;
        }
      }
      this.updatedAt = Number(parsed.updatedAt) || 0;
    }
  }

  private saveToDisk(): void {
    try {
      writeJson(this.file, { version: 1, updatedAt: this.updatedAt, counters: this.counters });
    } catch (e) {
      console.warn('⚠️ [UsageTime] 保存心跳诊断计数失败:', (e as Error)?.message);
    }
  }

  /** 累加若干计数（false / undefined 自动跳过；数字按值累加） */
  bump(fields: Record<string, boolean | number | undefined>): void {
    let changed = false;
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === false) continue;
      this.counters[k] = (this.counters[k] || 0) + (typeof v === 'number' ? v : 1);
      changed = true;
    }
    if (!changed) return;
    this.updatedAt = Date.now();
    this.saveToDisk();
  }

  /** 快照（读接口用；不带任何用户内容）。固定键缺省补 0，避免控制台读到 undefined。 */
  snapshot(): UsageDiagSnapshot {
    const out: Record<string, number> = { ...this.counters };
    for (const k of DIAG_KEYS) out[k] = out[k] || 0;
    out.updatedAt = this.updatedAt;
    return out as UsageDiagSnapshot;
  }

  /** 仅供测试：清空计数（不落盘） */
  reset(): void {
    this.counters = {};
    this.updatedAt = 0;
  }
}

export const usageTimeStore = new UsageTimeStore();
export const usageDiagStore = new UsageDiagStore();
export default usageTimeStore;
