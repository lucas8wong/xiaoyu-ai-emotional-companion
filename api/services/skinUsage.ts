/**
 * 用户当前皮肤统计模块
 *
 * 用户端在「首次加载 + 切换皮肤」时上报当前皮肤一次；本模块按用户/设备身份
 * 记录「最近一次选择的皮肤」（last-write-wins），持久化到 data/skin-usage.json。
 * 供控制台「用户行为」页每行展示该用户当前皮肤。
 *
 * 口径：
 * - 身份与 activity/usageTime 一致：登录用户用账号 userId，游客用设备指纹+IP 哈希
 *   （见 services/session.ts 的 resolveUserId）。
 * - 该功能自上报上线起开始统计；早于上线的历史无数据（此前皮肤只存浏览器 localStorage）。
 * - 只记录「最近一次」皮肤，不保留切换历史，避免重复计数（切换皮肤不新增用户数）。
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const SKIN_USAGE_FILE = dataFile('skin-usage.json');

export interface SkinUsageRecord {
  userId: string;
  skin: string;
  updatedAt: number;
}

export class SkinUsageStore {
  private map: Map<string, SkinUsageRecord> = new Map();
  private readonly file: string;

  /** file 参数供测试注入临时文件；默认 data/skin-usage.json */
  constructor(file: string = SKIN_USAGE_FILE) {
    this.file = file;
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const parsed = readJson<SkinUsageRecord[]>(this.file, []);
    if (Array.isArray(parsed)) {
      for (const r of parsed) {
        if (r?.userId && typeof r.skin === 'string' && r.skin.trim()) {
          this.map.set(r.userId, r);
        }
      }
    }
  }

  private saveToDisk(): void {
    try {
      const out: SkinUsageRecord[] = Array.from(this.map.values());
      writeJson(this.file, out);
    } catch (e) {
      console.warn('⚠️ [SkinUsage] 保存皮肤使用数据失败:', (e as Error)?.message);
    }
  }

  /** 记录某用户/设备当前皮肤（last-write-wins）。userId/skin 为空时忽略。 */
  setSkin(userId: string, skin: string): SkinUsageRecord | null {
    const id = (userId || '').trim();
    const sk = (skin || '').trim();
    if (!id || !sk) return null;
    const rec: SkinUsageRecord = { userId: id, skin: sk, updatedAt: Date.now() };
    this.map.set(id, rec);
    this.saveToDisk();
    return rec;
  }

  /** 获取某用户/设备最近一次记录的皮肤 */
  get(userId: string): SkinUsageRecord | undefined {
    return this.map.get(userId);
  }

  /** 注销清理（2026-09-28 审查 P1-8）：删除该用户/设备的皮肤记录 */
  removeByUser(userId: string): void {
    if (this.map.delete(userId)) this.saveToDisk();
  }

  /** 列出全部记录（调试/测试用） */
  listAll(): SkinUsageRecord[] {
    return Array.from(this.map.values());
  }

  /** 按皮肤聚合（供总览/测试用） */
  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.map.values()) out[r.skin] = (out[r.skin] || 0) + 1;
    return out;
  }
}

export const skinUsageStore = new SkinUsageStore();
export default skinUsageStore;
