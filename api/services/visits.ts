/**
 * 网站访客统计模块
 * 记录访问过网站的独立访客（按设备指纹去重），持久化到 data/visits.json
 *
 * 数据结构 v5：
 * {
 *   "version": 5,
 *   "visitors": [ { "id": "deviceId", "firstDate": "YYYY-MM-DD" } ],  // 累计独立访客（首次访问日期）
 *   "daily": { "YYYY-MM-DD": ["deviceId", ...] },                      // 每日访问的设备（当天去重）
 *   "hourly": { "YYYY-MM-DD": { "0"-"23": ["deviceId", ...] } },       // 按天按小时访问设备
 *   "geoDaily": { "YYYY-MM-DD": { deviceId: { ip, country, region, city, isp } } } // v5：访问 IP 地理快照（按设备当天）
 * }
 *
 * 兼容旧数据：
 * - v1 纯字符串数组 / v2 {version:2, visits:[{id,date}]}：旧数据无真实访问时间，迁移时归入迁移当天
 * - 自迁移起，每次访问都会记录到当天集合，每日访问量从此正确积累
 * - v3/v4 → v5：仅新增 geoDaily 字段，历史 daily/hourly 原样保留
 */

import 'dotenv/config';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { isTestRequest } from './activity.js';
import { isPrivateIp } from './geo.js';
import { isSelfExcludedIp } from './selfExclude.js';

const VISITS_FILE = dataFile('visits.json');

interface VisitorRecord {
  id: string;
  /** 首次访问日期 YYYY-MM-DD（本地时区） */
  firstDate: string;
}

/** 一次访问的地理信息（v5：记录在 geoDaily，按设备当天快照） */
export interface GeoVisitEntry {
  ip: string;
  country: string;
  region: string;
  city: string;
  isp: string;
}

/** 香港时区（UTC+8，无夏令时）偏移后的本地时间视图 */
function hkTime(d: Date = new Date()): Date {
  return new Date(d.getTime() + 8 * 3600 * 1000);
}

/** 香港时区 YYYY-MM-DD（访问统计统一以香港时间为准） */
function todayKey(d: Date = new Date()): string {
  const t = hkTime(d);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const day = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 香港时区的小时（0-23） */
function hkHour(d: Date = new Date()): number {
  return hkTime(d).getUTCHours();
}

export class VisitStore {
  private visitors: VisitorRecord[] = [];
  private daily: Map<string, Set<string>> = new Map();
  /** v4：按天按小时的访问设备（date → hour("0"-"23") → deviceIds 去重） */
  private hourly: Map<string, Map<string, Set<string>>> = new Map();
  /** v5：按天按设备的访问 IP 地理快照（date → deviceId → GeoVisitEntry） */
  private geoDaily: Map<string, Map<string, GeoVisitEntry>> = new Map();
  /** 数据文件路径（可注入以便测试） */
  private readonly file: string;

  constructor(file: string = VISITS_FILE) {
    this.file = file;
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      const parsed = readJson<any>(this.file, null) as any;
      if (!parsed) return;
      const fallback = todayKey();

      // 提取旧访客记录（兼容 v1 数组 / v2 {visits:[]} / v3 {visitors:[]}）
      const rawList: any[] = [];
      if (Array.isArray(parsed)) rawList.push(...parsed);
      else if (Array.isArray(parsed.visits)) rawList.push(...parsed.visits);
      else if (Array.isArray(parsed.visitors)) rawList.push(...parsed.visitors);

      // 旧格式（v1/v2，无每日记录）迁移时才把历史访客并入迁移当天；
      // v3/v4 已有 daily 历史，绝不能把历史访客灌进「启动当天」的集合——
      // 否则每次重启服务器都会把当天「每日访问量」虚增到累计总数
      const hasDailyHistory = !!(parsed && parsed.daily && typeof parsed.daily === 'object'
        && !Array.isArray(parsed.daily) && Object.keys(parsed.daily).length > 0);
      for (const v of rawList) {
        if (typeof v === 'string' && v) {
          this.addVisitor({ id: v, firstDate: fallback });
          if (!hasDailyHistory) this.addDaily(fallback, v);
        } else if (v && typeof v === 'object' && typeof v.id === 'string' && v.id) {
          const d = typeof v.firstDate === 'string' && v.firstDate ? v.firstDate
            : (typeof v.date === 'string' && v.date ? v.date : fallback);
          this.addVisitor({ id: v.id, firstDate: d });
          // v1/v2 旧数据无每日记录：并入迁移当天；v3/v4 有历史 daily，不并入
          if (!hasDailyHistory) this.addDaily(fallback, v.id);
        }
      }

      // v3 daily 反序列化（数组 → Set）
      if (parsed && parsed.daily && typeof parsed.daily === 'object' && !Array.isArray(parsed.daily)) {
        for (const date of Object.keys(parsed.daily)) {
          const ids = parsed.daily[date];
          if (Array.isArray(ids)) this.daily.set(date, new Set(ids.filter((x: unknown) => typeof x === 'string')));
        }
      }

      // v4 hourly 反序列化（date → hour → 数组 → Set）
      if (parsed && parsed.hourly && typeof parsed.hourly === 'object' && !Array.isArray(parsed.hourly)) {
        for (const date of Object.keys(parsed.hourly)) {
          const hours = parsed.hourly[date];
          if (hours && typeof hours === 'object' && !Array.isArray(hours)) {
            const hMap = new Map<string, Set<string>>();
            for (const h of Object.keys(hours)) {
              const ids = hours[h];
              if (Array.isArray(ids)) hMap.set(h, new Set(ids.filter((x: unknown) => typeof x === 'string')));
            }
            this.hourly.set(date, hMap);
          }
        }
      }

      // v5 geoDaily 反序列化（date → deviceId → entry）
      if (parsed && parsed.geoDaily && typeof parsed.geoDaily === 'object' && !Array.isArray(parsed.geoDaily)) {
        for (const date of Object.keys(parsed.geoDaily)) {
          const devices = parsed.geoDaily[date];
          if (devices && typeof devices === 'object' && !Array.isArray(devices)) {
            const m = new Map<string, GeoVisitEntry>();
            for (const deviceId of Object.keys(devices)) {
              const e = devices[deviceId];
              if (e && typeof e === 'object' && typeof e.ip === 'string' && e.ip) {
                m.set(deviceId, {
                  ip: e.ip,
                  country: String(e.country || ''),
                  region: String(e.region || ''),
                  city: String(e.city || ''),
                  isp: String(e.isp || ''),
                });
              }
            }
            if (m.size) this.geoDaily.set(date, m);
          }
        }
      }

      console.log(`💾 [Visits] 已从磁盘加载：${this.visitors.length} 个访客，${this.daily.size} 天记录`);
    } catch (e) {
      console.warn('⚠️ [Visits] 加载访客数据失败:', (e as Error)?.message);
    }
  }

  private addVisitor(v: VisitorRecord): void {
    if (!this.visitors.some(x => x.id === v.id)) this.visitors.push(v);
  }

  private addDaily(date: string, deviceId: string): void {
    let set = this.daily.get(date);
    if (!set) { set = new Set(); this.daily.set(date, set); }
    set.add(deviceId);
  }

  private addHourly(date: string, hour: string, deviceId: string): void {
    let hMap = this.hourly.get(date);
    if (!hMap) { hMap = new Map(); this.hourly.set(date, hMap); }
    let set = hMap.get(hour);
    if (!set) { set = new Set(); hMap.set(hour, set); }
    set.add(deviceId);
  }

  private saveToDisk(): void {
    try {
      const dailyObj: Record<string, string[]> = {};
      for (const [date, set] of this.daily) dailyObj[date] = Array.from(set);
      const hourlyObj: Record<string, Record<string, string[]>> = {};
      for (const [date, hMap] of this.hourly) {
        const hours: Record<string, string[]> = {};
        for (const [h, set] of hMap) hours[h] = Array.from(set);
        hourlyObj[date] = hours;
      }
      const geoDailyObj: Record<string, Record<string, GeoVisitEntry>> = {};
      for (const [date, m] of this.geoDaily) {
        const devices: Record<string, GeoVisitEntry> = {};
        for (const [deviceId, e] of m) devices[deviceId] = e;
        geoDailyObj[date] = devices;
      }
      writeJson(this.file, { version: 5, visitors: this.visitors, daily: dailyObj, hourly: hourlyObj, geoDaily: geoDailyObj });
    } catch (e) {
      console.warn('⚠️ [Visits] 保存访客数据失败:', (e as Error)?.message);
    }
  }

  /**
   * 记录一次访问：累计独立访客（首次） + 当天去重集合 + 当天 IP 地理快照（v5）
   * @param deviceId 设备指纹
   * @param geo 本次访问的 IP 地理信息（可为空：无 IP 时不落 geoDaily）
   * @returns 累计独立访客数
   */
  recordVisit(deviceId: string, geo?: GeoVisitEntry): number {
    if (!deviceId) return this.visitors.length;
    // 测试/内网请求不计入访客统计（与 activity.ts 口径一致）：deviceId 以 test- 开头、
    // IP 落 RFC5737 203.0.113.x，或 IP 为内网/本地/保留地址（::1/127.x/10.x/192.168.x/172.16-31.x/169.254.x/0.x，含 ::ffff: 归一）
    const ip = geo?.ip;
    if (isTestRequest(ip, deviceId) || (ip && isPrivateIp(ip)) || (ip && isSelfExcludedIp(ip))) {
      return this.visitors.length;
    }
    const now = new Date();
    const today = todayKey(now);
    if (!this.visitors.some(v => v.id === deviceId)) {
      this.visitors.push({ id: deviceId, firstDate: today });
    }
    this.addDaily(today, deviceId);
    this.addHourly(today, String(hkHour(now)), deviceId);
    if (geo && geo.ip) {
      let m = this.geoDaily.get(today);
      if (!m) { m = new Map(); this.geoDaily.set(today, m); }
      m.set(deviceId, geo);
    }
    this.saveToDisk();
    return this.visitors.length;
  }

  /**
   * 累计独立访客数
   */
  getVisitCount(): number {
    return this.visitors.length;
  }

  /**
   * 最近 N 天的每日访问用户量（按当天去重设备数）
   * @param days 返回最近多少天（含今天），默认 30
   */
  getDailyVisits(days: number): { date: string; count: number }[] {
    const out: { date: string; count: number }[] = [];
    const nowTs = Date.now();
    for (let i = days - 1; i >= 0; i--) {
      const key = todayKey(new Date(nowTs - i * 86400000));
      out.push({ date: key, count: this.daily.get(key)?.size || 0 });
    }
    return out;
  }

  /**
   * 最近 N 天的访问时段分布（0-23 时，跨天按独立设备去重）
   * @param days 返回最近多少天（含今天）的聚合，默认 30
   */
  getHourlyVisits(days: number): { hour: number; count: number }[] {
    const sets: Set<string>[] = Array.from({ length: 24 }, () => new Set<string>());
    const startKey = todayKey(new Date(Date.now() - (days - 1) * 86400000));
    for (const [date, hMap] of this.hourly) {
      if (date < startKey) continue;
      for (const [h, ids] of hMap) {
        const hi = Number(h);
        if (hi >= 0 && hi < 24) {
          for (const id of ids) sets[hi].add(id);
        }
      }
    }
    return sets.map((s, hour) => ({ hour, count: s.size }));
  }

  /**
   * 区间访问地区统计（v5）：区间内按「设备」去重，取该设备最近一天的 IP/地区快照
   * 桶内合计 = 区间独立设备数（与「今日访问/近N天访问」的设备口径一致，可直接对账）
   * @param days 区间天数（含今天），默认 30
   * @returns 每台设备一行 { deviceId, ip, country, region, city, isp }
   */
  getGeoVisits(days: number): { deviceId: string; ip: string; country: string; region: string; city: string; isp: string }[] {
    const startKey = todayKey(new Date(Date.now() - (days - 1) * 86400000));
    const latest = new Map<string, GeoVisitEntry>();
    const dates: string[] = [];
    for (const date of this.geoDaily.keys()) if (date >= startKey) dates.push(date);
    dates.sort(); // 升序：后写入的日期覆盖更早，保证「最近一天」胜出
    for (const date of dates) {
      for (const [deviceId, e] of this.geoDaily.get(date)!) latest.set(deviceId, e);
    }
    return [...latest.entries()].map(([deviceId, e]) => ({
      deviceId,
      ip: e.ip,
      country: e.country,
      region: e.region,
      city: e.city,
      isp: e.isp,
    }));
  }
}

export const visitStore = new VisitStore();
export default visitStore;
