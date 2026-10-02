/**
 * 运营自查 IP 自排除清单
 *
 * 需求（2026-09-02）：控制台「今日访问 / 累计访客 / 时段 / 地区」被运营自己反复查看
 * （尤其开无痕窗口，无痕只换 deviceId，不换公网 IP）污染，导致访问量虚高。
 * 方案：在服务端维护一份「公网 IP 排除清单」；`recordVisit` 命中即跳过，
 * 从而根治自查污染。因为按 IP 判断，无痕窗口同样生效。
 *
 * 持久化到 data/self-exclude-ips.json（gitignored）。只影响之后的访问，不回改历史。
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const SELF_EXCLUDE_FILE = dataFile('self-exclude-ips.json');

export interface SelfExcludeEntry {
  /** 规范化后的 IP（去 ::ffff: 前缀 / 首尾空白） */
  ip: string;
  addedAt: number;
  note?: string;
}

/** 规范化 IP：去首尾空白、去 IPv4-mapped 前缀（::ffff:），与 geo.ts 口径一致 */
export function normalizeIp(raw: string): string {
  return String(raw || '').trim().replace(/^::ffff:/i, '').trim();
}

export class SelfExcludeStore {
  /** key = 规范化 IP */
  private entries = new Map<string, SelfExcludeEntry>();
  private readonly file: string;

  constructor(file: string = SELF_EXCLUDE_FILE) {
    this.file = file;
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      const parsed = readJson<any>(this.file, null);
      if (parsed && Array.isArray(parsed.ips)) {
        for (const e of parsed.ips) {
          if (e && typeof e.ip === 'string' && e.ip) {
            const ip = normalizeIp(e.ip);
            if (!ip) continue;
            this.entries.set(ip, {
              ip,
              addedAt: Number(e.addedAt) || Date.now(),
              note: e.note ? String(e.note) : undefined,
            });
          }
        }
      }
    } catch (e) {
      console.warn('⚠️ [SelfExclude] 加载自排除清单失败:', (e as Error)?.message);
    }
  }

  private saveToDisk(): void {
    try {
      const ips = Array.from(this.entries.values()).sort((a, b) => b.addedAt - a.addedAt);
      writeJson(this.file, { version: 1, ips });
    } catch (e) {
      console.warn('⚠️ [SelfExclude] 保存自排除清单失败:', (e as Error)?.message);
    }
  }

  /** 是否命中自排除（不落盘） */
  isExcluded(ip: string): boolean {
    const n = normalizeIp(ip);
    return !!n && this.entries.has(n);
  }

  /** 加入清单（只改内存，不落盘）；返回是否新增 */
  add(ip: string, note?: string): boolean {
    const n = normalizeIp(ip);
    if (!n) return false;
    if (this.entries.has(n)) return false;
    this.entries.set(n, { ip: n, addedAt: Date.now(), note });
    return true;
  }

  /** 加入并落盘；返回是否新增 */
  addAndSave(ip: string, note?: string): boolean {
    const added = this.add(ip, note);
    if (added) this.saveToDisk();
    return added;
  }

  /** 移除；返回是否移除成功 */
  remove(ip: string): boolean {
    const n = normalizeIp(ip);
    const had = this.entries.delete(n);
    if (had) this.saveToDisk();
    return had;
  }

  /** 清单（按 addedAt 倒序） */
  list(): SelfExcludeEntry[] {
    return Array.from(this.entries.values()).sort((a, b) => b.addedAt - a.addedAt);
  }

  /** 仅供测试：清空内存（不落盘） */
  reset(): void {
    this.entries.clear();
  }
}

export const selfExcludeStore = new SelfExcludeStore();

/** 便捷判断：ip 是否命中自排除清单（供 visits/analysis 等采集点使用） */
export function isSelfExcludedIp(ip: string): boolean {
  return selfExcludeStore.isExcluded(ip);
}

export default selfExcludeStore;
