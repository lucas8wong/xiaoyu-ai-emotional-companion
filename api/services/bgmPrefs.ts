/**
 * 剧情配乐偏好（登录用户跨设备同步）
 * 结构：{ [userId]: { [scenarioId]: trackId } }，trackId 为空串表示"未自定义（用默认）"。
 * 持久化到 data/bgm-prefs.json；游客不走这里（前端 localStorage）。
 */
import { dataFile, readJson, writeJson } from '../storage/persistence.js';

type BgmPrefsData = Record<string, Record<string, string>>;

const DEFAULT_FILE = dataFile('bgm-prefs.json');

export class BgmPrefStore {
  private data: BgmPrefsData = {};
  private readonly file: string;

  constructor(file: string = DEFAULT_FILE) {
    this.file = file;
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const parsed = readJson<BgmPrefsData>(this.file, {});
    if (parsed && typeof parsed === 'object') this.data = parsed;
  }

  private saveToDisk(): void {
    try { writeJson(this.file, this.data); } catch { /* 忽略 */ }
  }

  /** 某用户的全部剧情配乐选择 */
  getByUser(userId: string): Record<string, string> {
    const m = this.data[userId];
    if (!m || typeof m !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(m)) {
      if (typeof v === 'string' && v.length <= 128) out[k] = v;
    }
    return out;
  }

  /** 记录某剧本的选择；trackId 为空串表示恢复默认（删除该记录） */
  set(userId: string, scenarioId: string, trackId: string): Record<string, string> {
    const m = this.data[userId] || (this.data[userId] = {});
    if (!trackId) delete m[scenarioId];
    else m[scenarioId] = trackId;
    this.saveToDisk();
    return this.getByUser(userId);
  }
}

export const bgmPrefStore = new BgmPrefStore();
