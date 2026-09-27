/**
 * 千世书自建剧本（用户自定义文游剧本）账号级存储
 * 按登录用户（userId）持久化到 data/custom-wenyou-scenarios.json，私人可见、跨设备同步，进程重启不丢失。
 * 表结构：{ [userId]: Scenario[] }（Scenario 结构见 src/wenyou/scenarios/schema.ts）
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const FILE = dataFile('custom-wenyou-scenarios.json');
/** 单用户剧本数量上限（防止滥用） */
const MAX_SCENARIOS_PER_USER = 50;

class WenyouScenariosStore {
  private byUser: Record<string, unknown[]> = {};

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const parsed = readJson<Record<string, unknown[]>>(FILE, {});
    if (parsed && typeof parsed === 'object') this.byUser = parsed;
  }

  private saveToDisk(): void {
    try {
      writeJson(FILE, this.byUser);
    } catch { /* 忽略 */ }
  }

  get(userId: string): unknown[] {
    return Array.isArray(this.byUser[userId]) ? this.byUser[userId] : [];
  }

  /**
   * 按 id 跨所有用户找剧本（**仅用于标题解析兜底**，绝不用于权限/游玩判定）。
   * 为什么需要：剧本列表是前端整表推送的，游客期建的书写在 guest userId 下，
   * 注册后若前端没再推一次，账号名下就查不到 → 「与你的旅程 / 控制台」只能显示 `custom-xxxx` 内部 id。
   */
  findById(id: string): { title?: string } | undefined {
    if (!id) return undefined;
    for (const list of Object.values(this.byUser)) {
      if (!Array.isArray(list)) continue;
      for (const s of list) {
        const rec = s as { id?: string; title?: string } | undefined;
        if (rec && rec.id === id) return rec;
      }
    }
    return undefined;
  }

  /** 整表替换（前端负责本地与服务端合并）；超限截断 */
  set(userId: string, list: unknown[]): unknown[] {
    const trimmed = Array.isArray(list) ? list.slice(0, MAX_SCENARIOS_PER_USER) : [];
    this.byUser[userId] = trimmed;
    this.saveToDisk();
    return trimmed;
  }

  /** 删除某用户的全部千世书剧本（账户注销时） */
  deleteByUser(userId: string): void {
    if (this.byUser[userId]) {
      delete this.byUser[userId];
      this.saveToDisk();
    }
  }
}

export const wenyouScenariosStore = new WenyouScenariosStore();
