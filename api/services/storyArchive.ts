/**
 * 剧情档案（聊一聊 · 剧情角色的「原文/细节」语料）
 *
 * 为什么单独立一个 store，而不是塞进 `longMemory`：
 * `longMemoryStore.addFacts` 有两条**硬约束**（`longMemory.ts:262,254`）：单条 text ≤ 80 字、每维度上限 60 条，
 * 而且它同时是「注入最近窗口」的来源。把剧情原文/细节塞进去会两头坏：既被静默截断，
 * 又把真实用户记忆挤出窗口。所以记忆分层：
 *   - **摘要**（≤80 字/条，带日期）→ `longMemory`（进最近窗口，随时在场）
 *   - **细节**（场面/台词，≤400 字/块）→ 本 store（只在话题碰得到时由语义召回取 top-K）
 *
 * 归属维度与 `longMemory`/`growth` 一致：`(userId, characterId)`，characterId 就是聊一聊角色 id，
 * 因此**每个剧情角色各自一份档案**，互不串味。
 *
 * 数据持久化到 data/story-archives.json，进程重启不丢失。
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';

export interface StoryBlock {
  id: string;
  /** 这一幕在剧情里的时间（取块内首条有时间的消息；都缺失时退化为写入时刻） */
  at: number;
  /** 覆盖的消息下标区间（闭区间，便于「回看这一段」与增量同步去重） */
  from: number;
  to: number;
  /** ≤400 字：这一幕发生了什么 + 关键台词/细节 */
  text: string;
}

export interface StoryArchiveRecord {
  userId: string;
  characterId: string;
  scenarioId: string;
  blocks: StoryBlock[];
  updatedAt: number;
}

const FILE = dataFile('story-archives.json');

/** 单块文本上限（与方案文档一致：够召回、不炸 prompt） */
export const MAX_BLOCK_TEXT = 400;
/**
 * 单角色最多保留的块数。
 * 为什么要有上限：一个剧本最多 200 条消息 → 每 12 条一块 ≈ 17 块；40 块足够覆盖 2 个满长剧本，
 * 又不至于让单角色的召回池无限膨胀（召回要 embed 整个池，成本与延迟都在这里）。
 */
const MAX_BLOCKS = 40;

function blockId(at: number, i: number): string {
  return 'sb_' + at.toString(36) + '_' + i.toString(36);
}

class StoryArchiveStore {
  private items: Map<string, StoryArchiveRecord> = new Map();

  constructor() { this.loadFromDisk(); }

  private key(userId: string, characterId: string): string { return userId + '::' + characterId; }

  private loadFromDisk(): void {
    const parsed = readJson<StoryArchiveRecord[]>(FILE, []);
    if (Array.isArray(parsed)) {
      parsed.forEach((r) => {
        if (r?.userId && r.characterId && Array.isArray(r.blocks)) this.items.set(this.key(r.userId, r.characterId), r);
      });
    }
    console.log(`💾 [StoryArchive] 已从磁盘加载 ${this.items.size} 份剧情档案`);
  }

  private saveToDisk(): void {
    try {
      writeJson(FILE, Array.from(this.items.values()));
    } catch { /* 忽略 */ }
  }

  /** 取该角色的剧情档案（无则 null，不要造空记录） */
  get(userId: string, characterId: string): StoryArchiveRecord | null {
    return this.items.get(this.key(userId, characterId)) || null;
  }

  listBlocks(userId: string, characterId: string): StoryBlock[] {
    return this.items.get(this.key(userId, characterId))?.blocks || [];
  }

  /** 覆盖式写入（导入时用；重复导入 = 重算档案，不叠加） */
  replaceBlocks(userId: string, characterId: string, scenarioId: string, blocks: StoryBlock[]): StoryArchiveRecord {
    const clean = this.normalize(blocks);
    const rec: StoryArchiveRecord = { userId, characterId, scenarioId, blocks: clean, updatedAt: Date.now() };
    this.items.set(this.key(userId, characterId), rec);
    this.saveToDisk();
    return rec;
  }

  /**
   * 追加式写入（增量同步用）。按 `(from,to)` 去重，同一段剧情被同步两次不会产生两块重复档案。
   * 返回**实际新增**的块。
   */
  appendBlocks(userId: string, characterId: string, scenarioId: string, blocks: StoryBlock[]): StoryBlock[] {
    const rec = this.items.get(this.key(userId, characterId))
      || { userId, characterId, scenarioId, blocks: [], updatedAt: Date.now() };
    const seen = new Set(rec.blocks.map((b) => b.from + '-' + b.to));
    const added = this.normalize(blocks).filter((b) => !seen.has(b.from + '-' + b.to));
    if (!added.length) return [];
    rec.scenarioId = scenarioId || rec.scenarioId;
    rec.blocks = [...rec.blocks, ...added].slice(-MAX_BLOCKS);
    rec.updatedAt = Date.now();
    this.items.set(this.key(userId, characterId), rec);
    this.saveToDisk();
    return added;
  }

  private normalize(blocks: StoryBlock[]): StoryBlock[] {
    const out: StoryBlock[] = [];
    (blocks || []).forEach((b, i) => {
      const text = String(b?.text ?? '').trim().slice(0, MAX_BLOCK_TEXT);
      if (!text) return;
      const at = Number.isFinite(b?.at) ? Math.floor(b.at) : Date.now();
      out.push({
        id: typeof b?.id === 'string' && b.id ? b.id : blockId(at, i),
        at,
        from: Number.isFinite(b?.from) ? Math.max(0, Math.floor(b.from)) : 0,
        to: Number.isFinite(b?.to) ? Math.max(0, Math.floor(b.to)) : 0,
        text,
      });
    });
    return out.slice(-MAX_BLOCKS);
  }

  /** 删除某角色的剧情档案（删角色时调用：迁移过来的剧情副本随之清掉） */
  deleteByCharacter(userId: string, characterId: string): void {
    if (this.items.delete(this.key(userId, characterId))) this.saveToDisk();
  }

  deleteByUser(userId: string): void {
    let changed = false;
    for (const k of Array.from(this.items.keys())) {
      if (k.startsWith(userId + '::')) { this.items.delete(k); changed = true; }
    }
    if (changed) this.saveToDisk();
  }

  /** 游客档案并入账号（与其它 store 同口径） */
  reassignUser(oldId: string, newId: string): void {
    if (!oldId || !newId || oldId === newId) return;
    let changed = false;
    for (const [k, r] of Array.from(this.items.entries())) {
      if (r.userId !== oldId) continue;
      const nk = this.key(newId, r.characterId);
      const existing = this.items.get(nk);
      this.items.set(nk, existing
        ? { ...existing, blocks: [...existing.blocks, ...r.blocks].slice(-MAX_BLOCKS), updatedAt: Math.max(existing.updatedAt, r.updatedAt) }
        : { ...r, userId: newId });
      this.items.delete(k);
      changed = true;
    }
    if (changed) this.saveToDisk();
  }

  /** 测试/排查用：当前记录数 */
  size(): number { return this.items.size; }
}

export const storyArchiveStore = new StoryArchiveStore();
export default storyArchiveStore;
