/**
 * 审阅档案的**查询层**：分页 / 日期范围 / 筛选 / 搜索 —— 纯函数、零 I/O、可单测。
 *
 * 为什么从浏览器搬到服务端（2026-09-25）：
 *   · 档案改成增量累积之后条目会到几百上千条，列表接口**不可能**再把全部条目的正文
 *     推给手机（原来 50 条就 800KB）；于是列表只给「当前页的摘要」。
 *   · 一旦列表只给当前页，原来那种「前端过滤 + 前端统计本页」就必然算错：
 *     计数会变成「本页有几条未读」而不是「这个范围内还有几条没审」——那正是这次要修的病。
 *   · 搜索同理：只搜当前页等于没搜。放到服务端才能搜到整个档案。
 *
 * 设置项标签（REVIEW_LABELS）也搬到这里，接口随列表下发（前端直接用服务端给的这份）：
 * 同义词表最怕两处各存一份、改一处漏一处。前端仍保留一份兜底（老接口/断网时用）。
 */

import { summarizeItem, type ReviewItem, type ReviewItemSummary } from './reviewQueue.js';
import type { ReviewReadState } from './reviewReads.js';

/** 设置项的人类可读标签（口径与 src/i18n 一致，别在这里另起一套词） */
export const REVIEW_LABELS: Record<string, Record<string, string>> = {
  mode: { hug: '接住我', ally: '挺我一下', clarify: '帮我理清', light: '轻一点看', objective: '客观看看' },
  tone: { warm: '温柔', direct: '直接' },
  storyStyle: { poetic: '诗意', concise: '简洁', warm: '温暖', abstract: '抽象' },
  region: {
    putonghua: '普通话', dongbei: '东北', jingjin: '京津', chuanyu: '川渝', yuegang: '粤港',
    jiangnan: '江南', guanzhong: '关中', minnan: '闽南', mindong: '闽东', taiwan: '台湾腔',
    neutral: '标准', us: '美式', uk: '英式',
  },
  intensity: { natural: '自然', obvious: '明显', strong: '很强' },
  // 布尔开关也进标签表：搜索时「智能贴合」「无限制」「主动找我」都要能搜到（值会被转成 'true'/'false' 键）
  // 「无限制」这个词要指向**真的用了无限制模型**的样本：关着的条目不要再带这个关键词，
  // 否则搜「无限制」会把整页都捞回来（等于没筛）
  roleplayUnlimited: { true: '开 无限制模式', false: '关' },
  smartFit: { true: '开 智能贴合', false: '关 智能贴合' },
  chatInnerMonologue: { true: '开 括号心理', false: '关 括号心理' },
  roleplayInnerMonologue: { true: '开 括号心理', false: '关 括号心理' },
  proactivePush: { true: '开 主动找我', false: '关 主动找我' },
  language: { 'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English' },
  thinkingLevel: { off: '关闭', low: '低', medium: '中', high: '高', max: '最大 MAX' },
  proactiveFrequency: { random: '随机', frequent: '常来', occasional: '偶尔', intense: '高频' },
  style: { classic: '小说叙事', immersive: '对话叙事' },
};

function labelOf(group: string, val: unknown): string {
  if (val === undefined || val === null || val === '') return '';
  const m = REVIEW_LABELS[group] || {};
  return m[String(val)] || '';
}

/** 本地日（服务端时区）：YYYY-MM-DD。「最近的记录」这类筛选必须按用户看到的日期，不是 UTC */
export function localDayOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 'YYYY-MM-DD' → 当天 00:00:00.000（本地）。格式不对**或日历上不存在**返回 null */
export function dayStartMs(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || '').trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(y, mo - 1, d, 0, 0, 0, 0);
  // 回读校验：'2026-13-99' 这种 Date 会悄悄滚成别的日子（不报 NaN），会让筛选区间莫名其妙变宽
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt.getTime();
}

/** 'YYYY-MM-DD' → 当天 23:59:59.999（本地） */
export function dayEndMs(day: string): number | null {
  const s = dayStartMs(day);
  return s === null ? null : s + 24 * 60 * 60 * 1000 - 1;
}

export type ReviewReadFilter = 'all' | 'unread' | 'read' | 'star' | 'flagged';

export interface ReviewQueryParams {
  kind?: string;
  read?: string;
  from?: string;
  to?: string;
  q?: string;
  order?: string;
  page?: number;
  pageSize?: number;
}

export interface ReviewQueryResult {
  items: ReviewItemSummary[];
  /** 整个档案的条数（未过滤） */
  total: number;
  /** 应用了「类型 / 日期 / 搜索」之后的条数（**不含**已读筛选——胶囊计数就取这一档） */
  scoped: number;
  /** 应用了全部筛选之后的条数 */
  filtered: number;
  page: number;
  pageSize: number;
  pageCount: number;
  counts: { total: number; unread: number; read: number; starred: number; flagged: number; noted: number };
  filters: { kind: string; read: ReviewReadFilter; from: string; to: string; q: string; order: 'new' | 'old' };
}

const READ_FILTERS: readonly ReviewReadFilter[] = ['all', 'unread', 'read', 'star', 'flagged'];

/** 归一化查询参数（非法值一律退回缺省，别让一次手改 URL 把接口打崩） */
export function normalizeQuery(params: ReviewQueryParams = {}): ReviewQueryResult['filters'] & { page: number; pageSize: number } {
  const kind = params.kind === 'chat' || params.kind === 'roleplay' ? params.kind : '';
  const read = READ_FILTERS.includes(String(params.read) as ReviewReadFilter)
    ? (String(params.read) as ReviewReadFilter)
    : 'all';
  const from = dayStartMs(String(params.from || '')) === null ? '' : String(params.from).trim();
  const to = dayEndMs(String(params.to || '')) === null ? '' : String(params.to).trim();
  const q = String(params.q || '').trim().slice(0, 100);
  const order: 'new' | 'old' = String(params.order) === 'old' ? 'old' : 'new';
  const pageRaw = Number(params.page);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
  const sizeRaw = Number(params.pageSize);
  const pageSize = Number.isFinite(sizeRaw) && sizeRaw >= 1 ? Math.min(100, Math.floor(sizeRaw)) : 20;
  return { kind, read, from, to, q, order, page, pageSize };
}

/** 一条样本的搜索用字符串（正文也进——搜索要能搜到整个档案，不是只搜本页） */
export function haystackOf(item: ReviewItem, read?: ReviewReadState | null): string {
  const parts: string[] = [
    String(item.reviewId || ''), String(item.sampleKey || ''), String(item.date || ''),
    localDayOf(item.startedAt || item.lastAt || 0),
    item.kind === 'roleplay' ? 'roleplay 剧情' : 'chat 聊一聊',
    String(item.preview || ''),
  ];
  const st = (item.settings || {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(st)) {
    parts.push(`${k} ${String(v)}`, labelOf(k, v));
  }
  const meta = item.meta || ({} as ReviewItem['meta']);
  if (meta.title) parts.push(String(meta.title));
  if (meta.model) parts.push(String(meta.model));
  for (const [k, n] of Object.entries(meta.styleCounts || {})) parts.push(`${k} ${labelOf('style', k)} ×${n}`);
  // ⚠️ 别 push 一个「半截 问句 慢」这样的固定词串——那会让每次搜索都命中全部样本（2026-09-20 踩过）
  for (const s of item.signals || []) parts.push(s.t);
  if (item.kind === 'roleplay') {
    if (meta.viaUnlimited === true) parts.push('无限制模式 无限制');
    else if (meta.viaUnlimited === false) parts.push('保守模型');
    else parts.push('未标记 老数据');
    /**
     * ⚠️ 只有在**真的走过无限制模型**时才把「无限制标记 N 轮」放进搜索串。
     * 原来不分情况都放，于是搜「无限制」会把「带标记但全程保守」的样本一起捞回来——
     * 那正好违反了「搜无限制要指向真的用了无限制模型的样本」这条口径（等于筛了个寂寞）。
     */
    if (meta.markedTurns && meta.viaUnlimited === true) parts.push(`无限制标记 ${meta.markedTurns} 轮`);
  }
  if (item.scrubbed?.length) parts.push(item.scrubbed.join(' '));
  if (item.droppedAttachments) parts.push(`附件 ${item.droppedAttachments}`);
  if (read?.note) parts.push(String(read.note));
  for (const m of item.messages || []) parts.push(String(m.content || ''));
  return parts.join(' ').toLowerCase();
}

function isUnread(read: ReviewReadState | null | undefined): boolean {
  return !(read && read.readAt);
}

/**
 * 筛选 + 统计 + 排序 + 分页。
 *
 * 顺序很重要：先做「类型 / 日期 / 搜索」得到 scoped（胶囊计数取这一档，所以
 * 「所选范围内还有几条没审」是准的），再套已读筛选，最后排序分页。
 */
export function queryArchive(
  items: readonly ReviewItem[],
  params: ReviewQueryParams,
  reads: Record<string, ReviewReadState> = {},
): ReviewQueryResult {
  const f = normalizeQuery(params);
  const fromMs = f.from ? dayStartMs(f.from) : null;
  const toMs = f.to ? dayEndMs(f.to) : null;
  const q = f.q.toLowerCase();

  const scoped: ReviewItem[] = [];
  for (const it of items) {
    if (f.kind && it.kind !== f.kind) continue;
    const at = it.lastAt || it.startedAt || 0;
    if (fromMs !== null && at < fromMs) continue;
    if (toMs !== null && at > toMs) continue;
    if (q) {
      const read = reads[it.sampleKey] || null;
      if (haystackOf(it, read).indexOf(q) < 0) continue;
    }
    scoped.push(it);
  }

  const counts = { total: items.length, unread: 0, read: 0, starred: 0, flagged: 0, noted: 0 };
  for (const it of scoped) {
    const read = reads[it.sampleKey] || null;
    if (isUnread(read)) counts.unread += 1; else counts.read += 1;
    if (read?.starred) counts.starred += 1;
    if (read?.note) counts.noted += 1;
    if ((it.signals || []).length) counts.flagged += 1;
  }

  const filtered = scoped.filter((it) => {
    const read = reads[it.sampleKey] || null;
    if (f.read === 'unread') return isUnread(read);
    if (f.read === 'read') return !isUnread(read);
    if (f.read === 'star') return read?.starred === true;
    if (f.read === 'flagged') return (it.signals || []).length > 0;
    return true;
  });

  filtered.sort((a, b) => {
    const d = (b.lastAt || 0) - (a.lastAt || 0);
    return f.order === 'old' ? -d : d;
  });

  const pageCount = Math.max(1, Math.ceil(filtered.length / f.pageSize));
  const page = Math.min(f.page, pageCount);
  const start = (page - 1) * f.pageSize;
  const pageItems = filtered.slice(start, start + f.pageSize).map(summarizeItem);

  return {
    items: pageItems,
    total: items.length,
    scoped: scoped.length,
    filtered: filtered.length,
    page,
    pageSize: f.pageSize,
    pageCount,
    counts,
    filters: { kind: f.kind, read: f.read, from: f.from, to: f.to, q: f.q, order: f.order },
  };
}

/** 档案里所有条目的身份键（供已读状态 prune 用） */
export function archiveKeys(items: readonly ReviewItem[]): Set<string> {
  return new Set(items.map((it) => it.sampleKey).filter((k): k is string => typeof k === 'string' && !!k));
}
