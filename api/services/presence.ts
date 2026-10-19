/**
 * 在线人数（运营控制台「🟢 当前在线」）· 2026-10-08
 *
 * 口径
 *  - 「在线」= 某身份在 `PRESENCE_TTL_SEC`（默认 90 秒）内有过一次**真实心跳**。
 *  - 心跳来源是既有的「使用时长」上报（`POST /api/usage-time/hit`，客户端在页面可见 +
 *    窗口聚焦（或近 10 分钟内有交互）时每约 30 秒上报一次），并**复用时长账本那一整道免计门**：
 *    测试设备（deviceId 以 test- 开头）、RFC5737 测试网段、内网/本地 IP、运营自查 IP 一律不计。
 *    因此这里只能确认前台心跳，包含挂机；运行 JS 的自动化也可能上报，不能据此确认真人或成功互动。
 *  - 身份口径与配额一致：登录 → 账号 userId（跨设备去重）；游客 → 纯设备标识去重（无设备标识才退回游客身份）。
 *    同一身份的多个标签页只算一个人。
 *
 * 落盘边界（2026-10-09 修「1 小时峰值不准」）
 *  - **身份表只在内存**：落盘会把「谁在什么时刻在线」变成长留存数据，与 `data/` 最小化相冲突；
 *    进程重启后归零是可接受的。
 *  - **只有聚合峰值 `{count, at}` 落盘**（`data/presence-peak.json`，一个数字 + 一个时刻，**不含任何身份**）：
 *    原先峰值纯内存，一次发版重启就把「最近 1 小时最高在线」清零，运营看到的 0 与实际不符；
 *    存了它，重启后 1 小时窗口内的峰值仍在，窗口过后自然按当前值重算。
 *  - `snapshot()` **只返回计数**（在线总数 / 登录数 / 访客数 / 近 1 小时峰值）；
 *    `list()` 额外给出**身份明细**，只由**已鉴权的运营接口**拼进响应，控制台据此回答
 *    「现在在线的是哪个用户」。身份明细同样只在内存、不落盘、进程重启即清零，
 *    因此并不新增任何持久化 PII（2026-10-09 用户口径：「这要看到是哪个用户」）。
 *
 * 可调：`PRESENCE_TTL_SEC`（30–3600，默认 90）。TTL 取 3 倍心跳间隔，容忍两次丢包/卡顿不抖动。
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { CLIENT_KINDS, type ClientKind, type ClientSource } from './clientSource.js';

/** 默认在线判定窗口（秒）：客户端约每 30s 一次心跳，3 倍间隔容忍偶发丢包 */
const TTL_SEC_DEFAULT = 90;
const TTL_SEC_MIN = 30;
const TTL_SEC_MAX = 3600;
/** 内存表硬上限（防异常流量把 Map 撑爆）；超出按 lastSeen 淘汰最旧 */
const MAX_ENTRIES = 20000;
/** 近 1 小时峰值窗口 */
const PEAK_WINDOW_MS = 3600_000;
/** 峰值落盘文件（只含 {count, at}，无身份；见文件头「落盘边界」） */
const PEAK_FILE = dataFile('presence-peak.json');
/** 全表清理的最小间隔（避免每次心跳都 O(n) 扫全表） */
const PRUNE_MIN_INTERVAL_MS = 5000;

export interface PresenceSnapshot {
  /** 当前在线身份数（登录用户 + 访客，已去重） */
  online: number;
  /** 其中登录用户 */
  accounts: number;
  /** 其中访客/设备（无注册账号） */
  guests: number;
  /** 在线判定窗口（秒），用于在控制台解释口径 */
  ttlSec: number;
  /** 近 1 小时在线峰值（每次心跳即采样；计数+时刻落盘，跨重启保留 1 小时窗口，不含身份） */
  peak1h: number;
  /** 快照生成时刻（ms） */
  updatedAt: number;
  clients: Record<ClientKind, { online: number; accounts: number; guests: number }>;
}

interface PresenceEntry {
  id: string;
  lastSeen: number;
  account: boolean;
  /** 这一轮连续在线的起点（ms）；中间断过一次（超过 TTL）会重新起算 */
  firstSeen: number;
  clients: Partial<Record<ClientKind, { lastSeen: number; version?: string }>>;
}

/** 一个在线身份（控制台「查看在线的是谁」用；只在已鉴权的运营接口返回） */
export interface PresenceUser {
  /** 身份键：登录用户 = userId；访客 = 设备指纹 + IP 哈希 */
  id: string;
  /** true = 登录账号，false = 访客设备 */
  account: boolean;
  /** 最近一次真实心跳（ms） */
  lastSeen: number;
  /** 这一轮连续在线的起点（ms） */
  firstSeen: number;
  clients: Array<ClientSource & { lastSeen: number }>;
}

/** 生效的在线判定窗口（ms）：读 PRESENCE_TTL_SEC，越界或非法回退默认 90s */
export function presenceTtlMs(): number {
  const raw = Number(process.env.PRESENCE_TTL_SEC);
  const sec = Number.isFinite(raw) && raw >= TTL_SEC_MIN && raw <= TTL_SEC_MAX ? Math.floor(raw) : TTL_SEC_DEFAULT;
  return sec * 1000;
}

export class PresenceStore {
  private map = new Map<string, PresenceEntry>();
  private peak: { count: number; at: number } = { count: 0, at: 0 };
  private lastPrune = 0;

  constructor() {
    // 只恢复聚合峰值（数字 + 时刻）；身份表永不落盘（见文件头「落盘边界」）。
    // 窗口过后由 observePeak 按当前在线重算，所以恢复一个过期值不会被当真。
    const saved = readJson<{ count?: number; at?: number } | null>(PEAK_FILE, null);
    const count = Math.floor(Number(saved?.count));
    const at = Number(saved?.at);
    if (Number.isFinite(count) && count > 0 && Number.isFinite(at) && at > 0) this.peak = { count, at };
  }

  /**
   * 记一次前台心跳；不代表成功功能使用或真人验证。
   * `at` 可注入，供单测做确定性时间推进。
   */
  touch(userId: string, opts: { account?: boolean; deviceKey?: string; source?: ClientSource } = {}, at: number = Date.now()): void {
    if (!userId) return;
    const key = !opts.account && opts.deviceKey ? `device:${opts.deviceKey}` : `identity:${userId}`;
    // 连续在线：上一次心跳仍在 TTL 内 → 沿用这一轮起点；否则视为新的一轮（用户离开又回来了）
    const prev = this.map.get(key);
    const firstSeen = prev && at - prev.lastSeen <= presenceTtlMs() ? (prev.firstSeen || prev.lastSeen || at) : at;
    const source = opts.source || { kind: 'unknown' as const };
    const clients = prev && at - prev.lastSeen <= presenceTtlMs() ? { ...prev.clients } : {};
    clients[source.kind] = { lastSeen: at, ...(source.version ? { version: source.version } : {}) };
    this.map.set(key, { id: userId, lastSeen: at, account: !!opts.account, firstSeen, clients });
    // 清理节流：正常情况下表里只有最近 90s 的心跳身份，扫表代价可忽略
    if (at - this.lastPrune >= PRUNE_MIN_INTERVAL_MS) {
      this.prune(at);
      this.lastPrune = at;
    }
    if (this.map.size > MAX_ENTRIES) this.evictOldest(this.map.size - MAX_ENTRIES);
    // 每次心跳都采样峰值：旧实现只在控制台轮询 snapshot() 时采样，运营没开控制台时
    // 「刚才有人在线」根本不会被记进峰值（2026-10-09 修「1 小时峰值不准」）。
    this.observePeak(at, this.countAt(at).online);
  }

  /** 当前快照（只含计数；顺带做一次过期清理与峰值维护） */
  snapshot(now: number = Date.now()): PresenceSnapshot {
    this.prune(now);
    const c = this.countAt(now);
    this.observePeak(now, c.online);
    return {
      online: c.online,
      accounts: c.accounts,
      guests: c.online - c.accounts,
      ttlSec: Math.round(presenceTtlMs() / 1000),
      peak1h: this.peak.count,
      updatedAt: now,
      clients: this.clientCounts(now),
    };
  }

  /** 清空（仅测试用；生产不调用） */
  clear(): void {
    this.map.clear();
    this.peak = { count: 0, at: 0 };
    this.lastPrune = 0;
  }

  /** 表内条数（含尚未过期的；仅测试用） */
  size(): number {
    return this.map.size;
  }

  /**
   * 当前在线身份的明细（按最近心跳倒序）。
   *
   * 与 `snapshot()` 的分工：`snapshot()` 仍是**纯计数**；身份明细只由已鉴权的运营接口取用。
   * `now` 可注入，供单测做确定性时间推进。
   */
  list(now: number = Date.now()): PresenceUser[] {
    this.prune(now);
    const ttl = presenceTtlMs();
    const out: PresenceUser[] = [];
    for (const v of this.map.values()) {
      if (now - v.lastSeen > ttl) continue;
      out.push({ id: v.id, account: v.account, lastSeen: v.lastSeen, firstSeen: v.firstSeen || v.lastSeen,
        clients: CLIENT_KINDS.flatMap(kind => { const client = v.clients[kind];
          return client && now - client.lastSeen <= ttl ? [{ kind, ...client }] : []; }) });
    }
    out.sort((a, b) => b.lastSeen - a.lastSeen);
    return out;
  }

  /**
   * 维护「近 1 小时峰值」：窗口内取更大值，窗口过后按当前在线重算。
   * 只有峰值**数值**变化时才落盘（新高峰 / 窗口切换后的回落），避免每次轮询都写文件。
   */
  private observePeak(now: number, online: number): void {
    let next = this.peak;
    if (!this.peak.at || now - this.peak.at > PEAK_WINDOW_MS) next = { count: online, at: now };
    else if (online > this.peak.count) next = { count: online, at: now };
    if (next === this.peak) return;
    const countChanged = next.count !== this.peak.count;
    this.peak = next;
    if (countChanged) this.savePeak();
  }

  private savePeak(): void {
    try {
      writeJson(PEAK_FILE, { count: this.peak.count, at: this.peak.at });
    } catch (e) {
      console.warn('⚠️ [Presence] 峰值落盘失败(不影响在线统计):', (e as Error)?.message);
    }
  }

  private prune(at: number): void {
    const ttl = presenceTtlMs();
    for (const [k, v] of this.map) if (at - v.lastSeen > ttl) this.map.delete(k);
  }

  private countAt(now: number): { online: number; accounts: number } {
    const ttl = presenceTtlMs();
    let online = 0;
    let accounts = 0;
    for (const v of this.map.values()) {
      if (now - v.lastSeen > ttl) continue;
      online += 1;
      if (v.account) accounts += 1;
    }
    return { online, accounts };
  }

  private clientCounts(now: number): PresenceSnapshot['clients'] {
    const result = Object.fromEntries(CLIENT_KINDS.map(kind => [kind, { online: 0, accounts: 0, guests: 0 }])) as PresenceSnapshot['clients'];
    for (const user of this.list(now)) for (const source of user.clients) {
      result[source.kind].online += 1;
      result[source.kind][user.account ? 'accounts' : 'guests'] += 1;
    }
    return result;
  }

  private evictOldest(need: number): void {
    const sorted = [...this.map.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (let i = 0; i < need && i < sorted.length; i += 1) this.map.delete(sorted[i][0]);
  }
}

export const presenceStore = new PresenceStore();
export default presenceStore;
