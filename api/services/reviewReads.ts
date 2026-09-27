/**
 * 审阅队列的「已读 / 未读」状态 —— 让运营知道**哪几条自己已经审过、哪几条还没**。
 *
 * 为什么要单独存一份（而不是塞进 review-queue.jsonl）：
 *   · 队列文件是**审阅副本档案**（2026-09-25 起增量累积，之前是一次生成整体覆盖）；
 *     把阅读状态写进去，等于把「运营的操作痕迹」混进「用户对话副本」这一份文件里
 *     （混在一起还会让 `assertDeidentified` 那套护栏多出一类无关的字段要照顾）。
 *
 * 键是 `ReviewItem.sampleKey`（**对话身份指纹**），**不是** reviewId —— 代号每次重建都重新随机，
 * 拿它当键的话重建一次全部样本都会变回未读（详见 reviewQueue.ts 里 sampleKey 的注释）。
 * 指纹口径变更时用 `rename()` 迁移旧键，别让已读进度凭空消失。
 *
 * 隐私：这里**只存键 + 时间 + 星标 + 备注**，不存任何对话内容，也不存 userId。
 */

import 'dotenv/config';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';

const FILE = dataFile('review-reads.json');

/** 单条样本的阅读状态 */
export interface ReviewReadState {
  /** 第一次标记为已读的时刻（毫秒）；未读时不存在 */
  readAt?: number;
  /** 最近一次打开的时刻（毫秒）——「读过但不记得」时靠它回忆 */
  lastOpenAt?: number;
  /** 打开次数（自动标记也会 +1）：>1 说明这条例看过多遍，通常是可疑样本 */
  opens: number;
  /** 星标：值得回头再看的样本 */
  starred?: boolean;
  /** 审阅备注（如「AI 结尾又问想不想多说」），最多 500 字 */
  note?: string;
}

interface FileShape {
  version?: number;
  updatedAt?: number;
  keys?: Record<string, ReviewReadState>;
}

/** 备注长度上限（审阅备注是给人写结论的，500 字够用；同时防止文件被无界写大） */
const NOTE_MAX = 500;
/** 键数量上限：正常队列一次最多 500 条，留足重建历史（超限丢最旧的） */
const MAX_KEYS = 3000;

class ReviewReadStore {
  private keys: Map<string, ReviewReadState> = new Map();
  private updatedAt = 0;

  constructor() { this.loadFromDisk(); }

  private loadFromDisk(): void {
    const parsed = readJson<FileShape>(FILE, {});
    const src = parsed && typeof parsed === 'object' ? parsed.keys : null;
    if (src && typeof src === 'object') {
      for (const [k, v] of Object.entries(src)) {
        if (!k || typeof v !== 'object' || !v) continue;
        this.keys.set(k, this.normalizeState(v as ReviewReadState));
      }
    }
    this.updatedAt = typeof parsed?.updatedAt === 'number' ? parsed.updatedAt : 0;
  }

  private normalizeState(v: ReviewReadState): ReviewReadState {
    const out: ReviewReadState = { opens: Math.max(0, Math.min(9999, Number(v.opens) || 0)) };
    if (typeof v.readAt === 'number' && v.readAt > 0) out.readAt = v.readAt;
    if (typeof v.lastOpenAt === 'number' && v.lastOpenAt > 0) out.lastOpenAt = v.lastOpenAt;
    if (v.starred === true) out.starred = true;
    if (typeof v.note === 'string' && v.note.trim()) out.note = v.note.trim().slice(0, NOTE_MAX);
    return out;
  }

  private saveToDisk(): void {
    try {
      writeJson(FILE, {
        version: 1,
        updatedAt: this.updatedAt,
        keys: Object.fromEntries(this.keys),
      } satisfies FileShape);
      this.trim();
    } catch { /* 写失败不该影响审阅：状态丢了顶多再标一次 */ }
  }

  /** 超上限时丢掉最久没动过的键（保住最近在读的） */
  private trim(): void {
    if (this.keys.size <= MAX_KEYS) return;
    const sorted = Array.from(this.keys.entries()).sort((a, b) =>
      (b[1].lastOpenAt || b[1].readAt || 0) - (a[1].lastOpenAt || a[1].readAt || 0));
    this.keys = new Map(sorted.slice(0, MAX_KEYS));
  }

  /** 单条状态（没有则返回 null） */
  get(key: string): ReviewReadState | null {
    return this.keys.get(key) || null;
  }

  /**
   * 迁移：把**老键**上的标记搬到**新键**（指纹口径变更时用：v1 含尾条 → v2 只锚开头）。
   *
   * 为什么要专门做这件事：2026-09-25 换了指纹口径，直接上线会让「之前标过的已读」
   * 全部对不上号、集体变回未读 —— 对审阅者来说就是进度凭空消失。新键若已有状态则合并：
   * readAt 取更早的（第一次读到的时刻），opens 取更大，lastOpenAt 取更晚，星标/备注取有值的。
   */
  rename(from: string, to: string): boolean {
    const f = String(from || '').trim();
    const t = String(to || '').trim();
    if (!f || !t || f === t) return false;
    const cur = this.keys.get(f);
    if (!cur) return false;
    const target = this.keys.get(t);
    const a = cur, b = target;
    const next: ReviewReadState = { opens: Math.max(a.opens || 0, b?.opens || 0) };
    const readAt = Math.min(...[a.readAt, b?.readAt].filter((v): v is number => typeof v === 'number' && v > 0));
    if (Number.isFinite(readAt) && readAt > 0) next.readAt = readAt;
    const lastOpenAt = Math.max(a.lastOpenAt || 0, b?.lastOpenAt || 0);
    if (lastOpenAt > 0) next.lastOpenAt = lastOpenAt;
    const starred = a.starred === true || b?.starred === true;
    if (starred) next.starred = true;
    const note = b?.note || a.note;
    if (note) next.note = note;
    this.keys.delete(f);
    this.keys.set(t, next);
    this.updatedAt = Date.now();
    this.saveToDisk();
    return true;
  }

  /**
   * 清掉**不在档案里**的键（增量档案里被上限丢弃、或指纹迁移后遗留的旧键）。
   * 不做这一步的话这份文件会随着重建次数单调变大（每次改口径/丢条目都留一批死键）。
   */
  prune(valid: ReadonlySet<string>): number {
    let removed = 0;
    for (const k of Array.from(this.keys.keys())) {
      if (valid.has(k)) continue;
      this.keys.delete(k);
      removed += 1;
    }
    if (removed > 0) { this.updatedAt = Date.now(); this.saveToDisk(); }
    return removed;
  }

  /** 全表（供路由与队列合并；返回的是一份快照，调用方改不动内部状态） */
  all(): Record<string, ReviewReadState> {
    return Object.fromEntries(this.keys);
  }

  /**
   * 批量改状态。
   *   · read: true  → 标记已读（已读过则只更新 lastOpenAt / opens）
   *   · read: false → 退回未读（保留 opens 与备注，只清 readAt）
   *   · open: true  → 记一次「打开」（不改 readAt，交给 read 决定）
   */
  mark(
    keys: readonly string[],
    patch: { read?: boolean; open?: boolean; starred?: boolean; note?: string },
    now: number = Date.now(),
  ): { updated: number } {
    let updated = 0;
    for (const key of keys) {
      const k = String(key || '').trim();
      if (!k || k.length > 64) continue;
      const cur = this.keys.get(k) || { opens: 0 };
      const next: ReviewReadState = { ...cur };
      if (patch.open) { next.opens = Math.min(9999, (next.opens || 0) + 1); next.lastOpenAt = now; }
      if (patch.read === true) { next.readAt = next.readAt || now; next.lastOpenAt = now; }
      if (patch.read === false) { delete next.readAt; }
      if (patch.starred === true) next.starred = true;
      if (patch.starred === false) delete next.starred;
      if (typeof patch.note === 'string') {
        const n = patch.note.trim().slice(0, NOTE_MAX);
        if (n) next.note = n; else delete next.note;
      }
      // 全空的条目（退未读 + 无星标 + 无备注 + 从没打开过）不留垃圾
      if (!next.readAt && !next.starred && !next.note && !next.opens) { this.keys.delete(k); updated += 1; continue; }
      this.keys.set(k, next);
      updated += 1;
    }
    if (updated > 0) { this.updatedAt = now; this.saveToDisk(); }
    return { updated };
  }

  /** 汇总：已读几条（配合队列 total 算进度） */
  stats(): { tracked: number; read: number; starred: number; noted: number; updatedAt: number } {
    let read = 0, starred = 0, noted = 0;
    for (const v of this.keys.values()) {
      if (v.readAt) read += 1;
      if (v.starred) starred += 1;
      if (v.note) noted += 1;
    }
    return { tracked: this.keys.size, read, starred, noted, updatedAt: this.updatedAt };
  }

  /** 仅供测试：清空内存态（不落盘） */
  reset(): void { this.keys.clear(); this.updatedAt = 0; }
}

export const reviewReadStore = new ReviewReadStore();
export default reviewReadStore;
