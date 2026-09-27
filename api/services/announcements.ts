/**
 * 公告模块（支持最多 3 条，滚动展示）
 * 每条公告包含 简中/繁中/英文 三语标题与正文，前端按用户语言选择显示
 * 持久化到 data/announcements.json
 */

import 'dotenv/config';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const FILE = dataFile('announcements.json');
const MAX_ANNOUNCEMENTS = 3;

export interface LangPair {
  title: string;
  content: string;
}

export interface Announcement {
  id: string;
  titleZh: string;
  contentZh: string;
  titleTw: string;
  contentTw: string;
  titleEn: string;
  contentEn: string;
  createdAt: number;
}

class AnnouncementStore {
  private items: Announcement[] = [];

  constructor() { this.loadFromDisk(); }

  private migrate(item: any): Announcement {
    // 旧格式：只有 title/content → 三语同值
    const title = String(item?.titleZh ?? item?.title ?? '公告');
    const content = String(item?.contentZh ?? item?.content ?? '');
    return {
      id: String(item?.id || 'legacy'),
      titleZh: String(item?.titleZh ?? title).slice(0, 50),
      contentZh: String(item?.contentZh ?? content).slice(0, 500),
      titleTw: String(item?.titleTw ?? title).slice(0, 50),
      contentTw: String(item?.contentTw ?? content).slice(0, 500),
      titleEn: String(item?.titleEn ?? title).slice(0, 50),
      contentEn: String(item?.contentEn ?? content).slice(0, 500),
      createdAt: Number(item?.createdAt || Date.now()),
    };
  }

  private loadFromDisk(): void {
    const parsed = readJson<any>(FILE, []);
    if (Array.isArray(parsed)) {
      this.items = parsed.slice(0, MAX_ANNOUNCEMENTS).map(this.migrate);
    } else if (parsed && parsed.active !== undefined) {
      // 兼容旧格式（单条）
      if (parsed.active) {
        this.items = [this.migrate({ id: 'legacy', title: parsed.title || '公告', content: parsed.content || '', createdAt: parsed.updatedAt || Date.now() })];
      }
    }
  }

  private saveToDisk(): void {
    try {
      writeJson(FILE, this.items);
    } catch { /* 忽略 */ }
  }

  private addItem(item: Announcement): Announcement {
    this.items.unshift(item);
    if (this.items.length > MAX_ANNOUNCEMENTS) this.items = this.items.slice(0, MAX_ANNOUNCEMENTS);
    this.saveToDisk();
    return item;
  }

  /**
   * 新增公告（兼容旧调用：仅单语时三语同值）
   */
  add(title: string, content: string): Announcement {
    const t = String(title).slice(0, 50);
    const c = String(content).slice(0, 500);
    return this.addItem({
      id: 'ann' + Date.now() + Math.random().toString(36).slice(2, 5),
      titleZh: t, contentZh: c,
      titleTw: t, contentTw: c,
      titleEn: t, contentEn: c,
      createdAt: Date.now(),
    });
  }

  /**
   * 新增三语公告（缺省语言回退到中文，中文缺省回退到任一可用语言）
   */
  addLangs(langs: { zhCN?: LangPair; zhTW?: LangPair; en?: LangPair }): Announcement {
    const z: LangPair = langs.zhCN || { title: '', content: '' };
    const t: LangPair = langs.zhTW || { title: '', content: '' };
    const e: LangPair = langs.en || { title: '', content: '' };
    const baseT = String(z.title || t.title || e.title || '公告').slice(0, 50);
    const baseC = String(z.content || t.content || e.content || '').slice(0, 500);
    return this.addItem({
      id: 'ann' + Date.now() + Math.random().toString(36).slice(2, 5),
      titleZh: String(z.title || baseT).slice(0, 50), contentZh: String(z.content || baseC).slice(0, 500),
      titleTw: String(t.title || z.title || baseT).slice(0, 50), contentTw: String(t.content || z.content || baseC).slice(0, 500),
      titleEn: String(e.title || z.title || baseT).slice(0, 50), contentEn: String(e.content || z.content || baseC).slice(0, 500),
      createdAt: Date.now(),
    });
  }

  /**
   * 更新已发布的公告（保留 id 与 createdAt，只更新三语内容）
   * 语言缺省/留空时回退：繁体→保留原值→简体；英文→保留原值→简体（编辑场景下未编辑语言不被覆盖）
   * 找不到返回 null
   */
  update(id: string, langs: { zhCN?: LangPair; zhTW?: LangPair; en?: LangPair }): Announcement | null {
    const idx = this.items.findIndex(a => a.id === id);
    if (idx < 0) return null;
    const cur = this.items[idx];
    const z: LangPair = langs.zhCN || { title: '', content: '' };
    const t: LangPair = langs.zhTW || { title: '', content: '' };
    const e: LangPair = langs.en || { title: '', content: '' };
    const baseT = String(z.title || cur.titleZh || '公告').slice(0, 50);
    const baseC = String(z.content || cur.contentZh || '').slice(0, 500);
    const updated: Announcement = {
      ...cur,
      titleZh: String(z.title || cur.titleZh || baseT).slice(0, 50),
      contentZh: String(z.content || cur.contentZh || baseC).slice(0, 500),
      titleTw: String(t.title || cur.titleTw || z.title || baseT).slice(0, 50),
      contentTw: String(t.content || cur.contentTw || z.content || baseC).slice(0, 500),
      titleEn: String(e.title || cur.titleEn || z.title || baseT).slice(0, 50),
      contentEn: String(e.content || cur.contentEn || z.content || baseC).slice(0, 500),
    };
    this.items[idx] = updated;
    this.saveToDisk();
    return updated;
  }

  /**
   * 删除公告
   */
  remove(id: string): void {
    const before = this.items.length;
    this.items = this.items.filter(a => a.id !== id);
    if (this.items.length !== before) this.saveToDisk();
  }

  /**
   * 当前所有公告（新在前）
   */
  list(): Announcement[] {
    return this.items.slice();
  }
}

export const announcementStore = new AnnouncementStore();
export const MAX_ANNOUNCEMENTS_COUNT = MAX_ANNOUNCEMENTS;
export default announcementStore;
