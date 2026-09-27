/**
 * 管理员操作审计日志
 * 持久化到 data/audit.json，最多保留 200 条
 */

import 'dotenv/config';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const FILE = dataFile('audit.json');

export interface AuditEntry {
  id: string;
  action: string; // confirm_order / manual_unlock / export_csv / set_announcement / ...
  detail: string;
  ip: string;
  createdAt: number;
}

class AuditStore {
  private items: AuditEntry[] = [];

  constructor() { this.loadFromDisk(); }

  private loadFromDisk(): void {
    const parsed = readJson<AuditEntry[]>(FILE, []);
    if (Array.isArray(parsed)) this.items = parsed;
  }

  private saveToDisk(): void {
    try {
      writeJson(FILE, this.items);
    } catch { /* 忽略 */ }
  }

  log(action: string, detail: string, ip: string = ''): void {
    this.items.push({
      id: 'au' + Date.now() + Math.random().toString(36).slice(2, 6),
      action: String(action).slice(0, 40),
      detail: String(detail).slice(0, 200),
      ip: String(ip).slice(0, 50),
      // 时间戳单调递增：避免同毫秒写入导致 listAll「最新在前」排序不稳定
      createdAt: Math.max(Date.now(), (this.items[this.items.length - 1]?.createdAt || 0) + 1),
    });
    if (this.items.length > 200) this.items = this.items.slice(-200);
    this.saveToDisk();
  }

  listAll(): AuditEntry[] {
    return this.items.slice().sort((a, b) => b.createdAt - a.createdAt);
  }
}

export const auditStore = new AuditStore();
export default auditStore;
