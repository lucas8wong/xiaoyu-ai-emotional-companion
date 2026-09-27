/**
 * 审阅**档案**层 —— 「增量」的那一层（2026-09-25 新增）。
 *
 * 为什么要有它（真实踩的坑）：
 *   原来 `data/review-queue.jsonl` 是「一次生成、整体覆盖」的快照，于是
 *     ① 快照一旦不重生成，新记录永远进不来（用户 09-25 看到的是 09-20 生成的旧快照，
 *        队列里最新只到 09-19 —— 那不是筛选掉了，是压根没扫过）；
 *     ② 每次生成按「最近优先」截断到 limit 条，**有资格的记录会被挤出窗口**：
 *        09-20 那次 386 条候选里筛出 105 条有资格，只留下 50 条，另外 55 条从此消失；
 *     ③ 想「重建看新的」就得拿旧的换 —— 重建一次，09-17 之前那批就从视图里没了。
 *
 * 现在改成**增量档案**：每次生成把新条目**并进档案**（按「对话身份键」`sampleKey` 去重），
 * 已有条目不会被后一次生成挤掉，页面再用「分页 + 日期范围 + 筛选」去取。
 *
 * 三条硬约束：
 *   ① 去重的键必须是**对话身份**而不是「本次内容」——否则同一段对话续写两句就会变成两条
 *      （见 reviewQueue.sampleKey 的 v2 说明）。
 *   ② 老快照（无 keyVersion / v1 含尾条指纹）要能**无损迁移**：读取时按 v1 口径反推旧键，
 *      返回 keyMap 让路由把 `review-reads.json` 里的已读标记搬到新键上——
 *      迁移做漏了的表现就是「用户之前标过的已读全变回未读」。
 *   ③ 身份键锚在「首条用户发言」上，而剧情只留最近 200 条消息 —— 长会话继续写会把**开头挤掉**，
 *      键就变了。所以撞不上键时还要用「用户发言重叠」兜底（见 findOverlapKey），
 *      否则同一段长剧情会每隔一阵就在档案里多出一条。
 *   ④ 档案会一直长：设 MAX_ARCHIVE 上限，超了按 lastAt 从旧到新丢，并把丢弃数记进 meta，
 *      **不静默丢**。
 *
 * 与「用户数据」的关系：档案里装的是**已脱敏的审阅副本**（无 userId/sessionId/scenarioId），
 * 它不是任何用户数据的真源，删掉只影响审阅。**写入前必须过 `assertDeidentified()`**（由调用方做）。
 */

import fs from 'node:fs';
import { dataFile } from '../storage/persistence.js';
import { itemSampleKey, previewOf, signalsOf, SAMPLE_KEY_VERSION, type ReviewItem } from './reviewQueue.js';

/** 档案格式版本：2 = 增量档案（1 = 单次快照，只有元信息行 + 条目行） */
export const ARCHIVE_VERSION = 2;

/**
 * 档案条目上限。现状参考：线上有资格进队列的对话约 110 条（源头本身还受保留期约束），
 * 2000 条足够长期累积；每条平均十几 KB，2000 条约 30MB —— 超过就按最旧的丢。
 */
export const MAX_ARCHIVE = 2000;

export interface ArchiveMeta {
  version: number;
  generatedAt: string;
  /** 本次生成的条数（合并前） */
  itemCount: number;
  /** 合并后的档案总条数 */
  archivedTotal: number;
  /** 本次新入档条数 */
  added: number;
  /** 本次「同一段对话又出现」的条数（正文刷新，或保留更全的旧正文） */
  refreshed: number;
  /** 因超过 MAX_ARCHIVE 被丢弃的条数（>0 时页面要显示出来） */
  dropped: number;
  /** 档案覆盖的 lastAt 区间（毫秒） */
  range: { from: number; to: number };
  /** 本次扫描统计（沿用 buildReviewQueue 的 stats 口径） */
  stats: unknown;
  note: string;
}

export interface Archive {
  meta: ArchiveMeta | Record<string, unknown> | null;
  items: ReviewItem[];
  /** true = 文件里存在 2026-09-25 之前生成的条目（没有 keyVersion 或用 v1 指纹） */
  legacy: boolean;
}

export const ARCHIVE_NOTE =
  '去除账号关联后的审阅**档案**（增量累积，不再整体覆盖）：无 userId/sessionId/scenarioId/邮箱/手机号；'
  + '绝对时间只到分钟（不含秒），条内节奏为相对偏移；随条目带用户基础设置快照（白名单键）；'
  + '同一段对话按「对话身份键」去重（续写会刷新正文，不新增一条）。默认已排除测试/开发身份。';

export function archiveFilePath(): string {
  return dataFile('review-queue.jsonl');
}

/** 一行是不是元信息行（老格式把元信息放第一行；条目行一定有 kind / sampleKey） */
function looksLikeMeta(o: Record<string, unknown>): boolean {
  return typeof o.generatedAt === 'string' && o.kind === undefined && o.sampleKey === undefined;
}

/** 一条记录是不是能用的条目（脏行宁可跳过，也不能让整个档案读不出来） */
function usableItem(o: unknown): o is ReviewItem {
  if (!o || typeof o !== 'object') return false;
  const it = o as Record<string, unknown>;
  if (it.kind !== 'chat' && it.kind !== 'roleplay') return false;
  if (!Array.isArray(it.messages)) return false;
  if (typeof it.startedAt !== 'number' || typeof it.lastAt !== 'number') return false;
  return true;
}

/** 解析档案文本（纯函数，便于单测：不碰磁盘） */
export function parseArchive(raw: string): Archive {
  const lines = String(raw || '').split('\n').filter((l) => l.trim().length > 0);
  let meta: Archive['meta'] = null;
  const items: ReviewItem[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    const o = parsed as Record<string, unknown>;
    if (looksLikeMeta(o)) { meta = o as Archive['meta']; continue; }
    if (!usableItem(o)) continue;
    // 给老条目补上「口径版本」以外的缺省字段（signals/preview 是老格式没有的）
    const it = o as ReviewItem;
    if (!Array.isArray(it.signals)) it.signals = [];
    if (typeof it.preview !== 'string') it.preview = '';
    /**
     * 老条目（2026-09-25 之前生成）没有 signals / preview，而且**不会**每条都在下次生成时
     * 被刷新（比如用户关掉了「允许用于改进服务」、或源头会话已过保留期），所以这里当场
     * 从已存的正文重算一遍——纯函数、确定性的，和构建期算出来的完全一致。
     */
    if (it.keyVersion !== SAMPLE_KEY_VERSION) {
      it.signals = signalsOf(it.messages);
      it.preview = previewOf(it.messages);
    }
    items.push(it);
  }
  const legacy = items.some((it) => it.keyVersion !== SAMPLE_KEY_VERSION);
  return { meta, items, legacy };
}

/** 序列化档案（meta 一行 + 条目各一行）；条目不保证内部顺序，调用方按 lastAt 排好 */
export function serializeArchive(meta: ArchiveMeta | Record<string, unknown> | null, items: readonly ReviewItem[]): string {
  const head = JSON.stringify(meta ?? { version: ARCHIVE_VERSION, note: ARCHIVE_NOTE });
  return [head, ...items.map((it) => JSON.stringify(it))].join('\n') + '\n';
}

/** 档案覆盖的时间区间（按 lastAt） */
export function archiveRange(items: readonly ReviewItem[]): { from: number; to: number } {
  let from = 0, to = 0;
  for (const it of items) {
    const t = it.lastAt || it.startedAt || 0;
    if (!t) continue;
    if (!from || t < from) from = t;
    if (t > to) to = t;
  }
  return { from, to };
}

/** 用户发言的「锚」（做重叠判定用）：只取**足够长**的（≥8 字），免得「你好」这种短句把整档串成一桶 */
function userAnchors(item: ReviewItem): string[] {
  const out: string[] = [];
  for (const m of item.messages || []) {
    if (m.role !== 'user') continue;
    const s = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (s.length >= 8) out.push(s);
  }
  return out;
}

/** 共享 ≥3 条用户发言、且占较短一方 ≥60% 才算「同一段对话」——两个不同对话共享一两句寒暄不会被并掉 */
const OVERLAP_MIN_SHARED = 3;
const OVERLAP_MIN_RATIO = 0.6;

/**
 * 头部被裁掉时的兜底匹配。
 *
 * 为什么需要：剧情会话只保留最近 `MAX_MSGS`（200）条消息，**长会话继续写就会把开头挤掉**。
 * 而身份键锚在「首条用户发言」上 → 头一被挤掉键就变了，同一段对话会被记成第二条
 * （线上已有正好 200 条消息的会话，所以这不是假想情况）。
 * 判据：同类型 + 共享的长用户发言 ≥3 条 + 占较短一方 ≥60%；命中就按「同一条」刷新，
 * 并把旧键 → 新键记进 keyMap，让已读标记跟着走。
 */
function findOverlapKey(
  map: ReadonlyMap<string, ReviewItem>,
  index: ReadonlyMap<string, Set<string>>,
  incoming: ReviewItem,
): string | null {
  const anchors = userAnchors(incoming);
  if (anchors.length < OVERLAP_MIN_SHARED) return null;
  const tally = new Map<string, number>();
  for (const a of anchors) {
    for (const key of index.get(a) || []) {
      const other = map.get(key);
      if (!other || other.kind !== incoming.kind) continue;
      tally.set(key, (tally.get(key) || 0) + 1);
    }
  }
  let best: string | null = null;
  let bestScore = 0;
  for (const [key, score] of tally) {
    if (score < OVERLAP_MIN_SHARED) continue;
    const other = map.get(key);
    if (!other) continue;
    const otherCount = userAnchors(other).length;
    if (otherCount === 0) continue;
    if (score / Math.min(anchors.length, otherCount) < OVERLAP_MIN_RATIO) continue;
    if (score > bestScore) { best = key; bestScore = score; }
  }
  return best;
}

/** 锚索引：anchor → 条目键集合 */
function buildAnchorIndex(items: Iterable<[string, ReviewItem]>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const [key, item] of items) {
    for (const a of userAnchors(item)) {
      const set = index.get(a);
      if (set) set.add(key); else index.set(a, new Set([key]));
    }
  }
  return index;
}

/**
 * 合并：把本次生成的条目并进已有档案。
 *
 * 去重键 = `itemSampleKey()`（对话身份键）；键对不上时再用「用户发言重叠」兜底
 * （头部被裁掉的长会话，见 findOverlapKey）。撞上时正文的取舍：
 *   · 新版本正文**不更短** → 用新版本刷新（archivedAt 保留 = 「什么时候第一次看到的」不变）
 *   · 新版本反而更短 → **保留更全的旧正文**，只记刷新时间与新的身份键
 * 纯函数，不碰磁盘，便于单测。
 */
export function mergeArchive(
  existing: readonly ReviewItem[],
  incoming: readonly ReviewItem[],
  opts: { now?: number; cap?: number } = {},
): { items: ReviewItem[]; added: number; refreshed: number; dropped: number; keyMap: Record<string, string> } {
  const now = Number.isFinite(opts.now) ? (opts.now as number) : Date.now();
  const cap = Math.max(1, opts.cap ?? MAX_ARCHIVE);
  const map = new Map<string, ReviewItem>();
  const keyMap: Record<string, string> = {};

  for (const it of existing) {
    const key = itemSampleKey(it);
    // v1 键 → v2 键：调用方据此把已读标记搬过去（漏了就会「已读全变回未读」）
    if (typeof it.sampleKey === 'string' && it.sampleKey && it.sampleKey !== key) keyMap[it.sampleKey] = key;
    const prev = map.get(key);
    if (!prev || (it.messages?.length || 0) > (prev.messages?.length || 0)) map.set(key, it);
  }
  const index = buildAnchorIndex(map.entries());

  let added = 0, refreshed = 0;
  for (const inc of incoming) {
    const newKey = itemSampleKey(inc);
    let prevKey: string | null = map.has(newKey) ? newKey : null;
    if (!prevKey) {
      const overlap = findOverlapKey(map, index, inc);
      if (overlap && overlap !== newKey && map.has(overlap)) prevKey = overlap;
    }

    if (!prevKey) {
      const item: ReviewItem = {
        ...inc,
        sampleKey: newKey,
        keyVersion: SAMPLE_KEY_VERSION,
        archivedAt: typeof inc.archivedAt === 'number' ? inc.archivedAt : now,
        refreshedAt: now,
      };
      map.set(newKey, item);
      for (const a of userAnchors(item)) {
        const set = index.get(a);
        if (set) set.add(newKey); else index.set(a, new Set([newKey]));
      }
      added += 1;
      continue;
    }

    const prev = map.get(prevKey)!;
    const prevCount = prev.messages?.length || 0;
    const incCount = inc.messages?.length || 0;
    const content = incCount >= prevCount ? inc : prev;
    const archivedAt = typeof prev.archivedAt === 'number' ? prev.archivedAt : now;
    if (prevKey !== newKey) {
      // 身份键变了（头部被裁掉 / 老口径）：旧键要清掉并把映射交给调用方去迁已读标记
      map.delete(prevKey);
      for (const a of userAnchors(prev)) index.get(a)?.delete(prevKey);
      keyMap[prevKey] = newKey;
    }
    const merged: ReviewItem = {
      ...content,
      sampleKey: newKey,
      keyVersion: SAMPLE_KEY_VERSION,
      archivedAt,
      refreshedAt: now,
    };
    map.set(newKey, merged);
    for (const a of userAnchors(merged)) {
      const set = index.get(a);
      if (set) set.add(newKey); else index.set(a, new Set([newKey]));
    }
    refreshed += 1;
  }

  let items = Array.from(map.values()).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  let dropped = 0;
  if (items.length > cap) {
    dropped = items.length - cap;
    items = items.slice(0, cap);
  }
  return { items, added, refreshed, dropped, keyMap };
}

// —— 磁盘读写（带 mtime+size 缓存：列表接口每次都要读，几百条 × 十几 KB 不该每请求解一遍）——
let cache: { stamp: string; archive: Archive } | null = null;

function stampOf(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

/** 读档案（不存在返回空档案；坏行跳过；结果按 mtime+size 缓存） */
export function loadArchive(file: string = archiveFilePath()): Archive {
  const stamp = stampOf(file);
  if (!stamp) return { meta: null, items: [], legacy: false };
  if (cache && cache.stamp === stamp) return cache.archive;
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { raw = ''; }
  const archive = parseArchive(raw);
  cache = { stamp, archive };
  return archive;
}

/** 清缓存（写完档案或单测里换了文件时调用） */
export function invalidateArchiveCache(): void { cache = null; }

/** 原子写档案（先 .tmp 再 rename：不会留下半截文件）；写失败抛给调用方 */
export function writeArchive(
  items: readonly ReviewItem[],
  meta: ArchiveMeta | Record<string, unknown> | null,
  file: string = archiveFilePath(),
): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, serializeArchive(meta, items), 'utf8');
  fs.renameSync(tmp, file);
  invalidateArchiveCache();
}

export default { loadArchive, mergeArchive, writeArchive, parseArchive, serializeArchive, archiveRange, MAX_ARCHIVE, ARCHIVE_VERSION, ARCHIVE_NOTE };
