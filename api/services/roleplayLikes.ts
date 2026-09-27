/**
 * 角色剧情剧本点赞（社区型指标）
 * 每个用户（登录账号 userId 或游客设备指纹）对每个剧本最多一赞，可取消；
 * 点赞数 = 全体用户去重后的累计，持久化到 data/roleplay-likes.json，进程重启不丢失。
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { behaviorDailyStore } from './behaviorDaily.js';

export interface RoleplayLikeRecord {
  userId: string;
  scenarioId: string;
  createdAt: number;
}

const DEFAULT_FILE = dataFile('roleplay-likes.json');

export class RoleplayLikeStore {
  private items: RoleplayLikeRecord[] = [];
  private readonly file: string;

  /** file 参数供测试注入临时文件；默认 data/roleplay-likes.json */
  constructor(file: string = DEFAULT_FILE) {
    this.file = file;
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const parsed = readJson<RoleplayLikeRecord[]>(this.file, []);
    if (Array.isArray(parsed)) {
      this.items = parsed.filter((r: RoleplayLikeRecord) => r && r.userId && r.scenarioId);
    }
  }

  private saveToDisk(): void {
    try {
      writeJson(this.file, this.items);
    } catch { /* 忽略 */ }
  }

  /** 某个剧本的点赞数 */
  getCount(scenarioId: string): number {
    return this.items.filter(r => r.scenarioId === scenarioId).length;
  }

  /** 全部剧本点赞数（前端列表一次取齐） */
  getCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.items) out[r.scenarioId] = (out[r.scenarioId] || 0) + 1;
    return out;
  }

  /** 某用户是否点过某剧本 */
  isLiked(userId: string, scenarioId: string): boolean {
    return this.items.some(r => r.userId === userId && r.scenarioId === scenarioId);
  }

  /** 某用户点赞的剧本数（供控制台「是否点赞」展示，含多次切换后仍保持的点赞） */
  getUserLikeCount(userId: string): number {
    return this.items.filter(r => r.userId === userId).length;
  }

  /** 某用户点赞过的所有剧本 id（去重） */
  getUserLikeScenarioIds(userId: string): string[] {
    const set = new Set<string>();
    for (const r of this.items) if (r.userId === userId) set.add(r.scenarioId);
    return Array.from(set);
  }

  /** 某用户点赞记录（含时间戳，供「与你的旅程」按时间排序） */
  getUserLikes(userId: string): { scenarioId: string; createdAt: number }[] {
    return this.items
      .filter((r) => r.userId === userId)
      .map((r) => ({ scenarioId: r.scenarioId, createdAt: r.createdAt }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 点赞/取消点赞（toggle），返回最新状态与点赞数；点赞成功事件写入按日行为日志（区间「点赞次数」口径） */
  toggle(userId: string, scenarioId: string): { liked: boolean; count: number } {
    const idx = this.items.findIndex(r => r.userId === userId && r.scenarioId === scenarioId);
    if (idx >= 0) {
      this.items.splice(idx, 1);
    } else {
      const at = Date.now();
      this.items.push({ userId, scenarioId, createdAt: at });
      behaviorDailyStore.addEvent(userId, 'likes', at);
    }
    this.saveToDisk();
    return { liked: idx < 0, count: this.getCount(scenarioId) };
  }

  /** 删除某用户的全部点赞（账户注销时） */
  deleteByUser(userId: string): void {
    const before = this.items.length;
    this.items = this.items.filter(r => r.userId !== userId);
    if (this.items.length !== before) this.saveToDisk();
  }

  /** 游客点赞并入账号（去重：账号已有同剧本点赞则丢弃游客记录） */
  reassignUser(oldId: string, newId: string): void {
    if (!oldId || !newId || oldId === newId) return;
    const newLiked = new Set(this.items.filter(r => r.userId === newId).map(r => r.scenarioId));
    let changed = false;
    const next: RoleplayLikeRecord[] = [];
    for (const r of this.items) {
      if (r.userId === oldId) {
        if (!newLiked.has(r.scenarioId)) {
          next.push({ ...r, userId: newId });
          newLiked.add(r.scenarioId);
        }
        changed = true;
      } else {
        next.push(r);
      }
    }
    if (changed) {
      this.items = next;
      this.saveToDisk();
    }
  }
}

export const roleplayLikeStore = new RoleplayLikeStore();
export default roleplayLikeStore;
