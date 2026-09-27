/**
 * 千世书「进度」后端持久化（登录用户跨设备跟随）
 * 存用户在千世书里的：进行中局(games，scenarioId→SaveGame 每回合自动保存)、命名存档位(slots)、结局图鉴(endings)、全局统计(stats)。
 * 注意：AI 配置（含用户自定义 API key）仍是前端本地，不上传。
 * 数据经 persistence → 落到 data/wenyou-saves.json（/ 或 SQLite）。
 *
 * 向前兼容：旧版把「当前存档」存成单条 save；读取时若记录里只有 save 而无 games，
 * 自动迁移为 games[save.scenario.id]（旧字段不再保留）。
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const FILE = dataFile('wenyou-saves.json');

export interface WenyouProgress {
  games: Record<string, unknown>; // scenarioId -> SaveGame（进行中局）
  slots: unknown[];                 // SaveSlot[]
  endings: Record<string, string[]>; // scenarioId -> tones
  stats: unknown;                  // RunStats
  updatedAt: number;
}

export interface WenyouSaveRecord extends WenyouProgress {
  userId: string;
}

const MAX_SLOTS = 50;

/** 把旧版单条 save 迁移为 games 映射（games 已存在则保留 games）。导出供单测直接验证迁移逻辑。 */
export function migrateRecord(r: any): WenyouSaveRecord {
  const hasGames = r?.games && typeof r.games === 'object' && !Array.isArray(r.games);
  const games: Record<string, unknown> = hasGames
    ? r.games
    : r?.save
      ? { [(r.save?.scenario?.id) ?? 'save']: r.save }
      : {};
  return {
    userId: r.userId,
    games,
    slots: Array.isArray(r.slots) ? r.slots : [],
    endings: r.endings && typeof r.endings === 'object' ? r.endings : {},
    stats: r.stats ?? {},
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
  };
}

/** 进行中局条数上限（防止滥用）；按对象键截断 */
function limitGames(games: unknown): Record<string, unknown> {
  if (!games || typeof games !== 'object' || Array.isArray(games)) return {};
  const entries = Object.entries(games as Record<string, unknown>);
  return Object.fromEntries(entries.slice(-MAX_SLOTS)) as Record<string, unknown>;
}

class WenyouSavesStore {
  private items: Map<string, WenyouSaveRecord> = new Map();

  constructor() {
    const parsed = readJson<WenyouSaveRecord[]>(FILE, []);
    if (Array.isArray(parsed)) {
      parsed.forEach((r) => {
        if (r?.userId) this.items.set(r.userId, migrateRecord(r));
      });
    }
    console.log(`💾 [WenyouSaves] 已加载 ${this.items.size} 个千世书进度`);
  }

  private saveToDisk(): void {
    try {
      writeJson(FILE, Array.from(this.items.values()));
    } catch { /* 忽略 */ }
  }

  get(userId: string): WenyouProgress | null {
    const r = this.items.get(userId);
    if (!r) return null;
    const { userId: _u, ...rest } = r;
    return rest;
  }

  set(userId: string, progress: Omit<WenyouProgress, 'updatedAt'>): WenyouProgress {
    const rec: WenyouSaveRecord = {
      userId,
      games: limitGames(progress.games),
      slots: Array.isArray(progress.slots) ? progress.slots.slice(-MAX_SLOTS) : [],
      endings: progress.endings && typeof progress.endings === 'object' ? progress.endings : {},
      stats: progress.stats ?? {},
      updatedAt: Date.now(),
    };
    this.items.set(userId, rec);
    this.saveToDisk();
    const { userId: _u, ...rest } = rec;
    return rest;
  }

  deleteByUser(userId: string): void {
    if (this.items.delete(userId)) this.saveToDisk();
  }
}

export const wenyouSavesStore = new WenyouSavesStore();
export default wenyouSavesStore;
