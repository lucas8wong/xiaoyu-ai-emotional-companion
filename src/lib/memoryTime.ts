/**
 * 记忆时间标签（前端 · 2026-09-17）
 * 与服务端 api/services/timeAnchor.ts 的渲染口径保持一致（那边渲染进 prompt，这边渲染给用户看）：
 * 「TA 记得的你」不再只列一句话，而是把**这条记忆是什么时候的**一并显示出来——
 * 用户才能判断它过没过期，也不会再出现"把很久以前的事当成今天"的错位。
 *
 * 时间语义（与后端一致）：
 *  - 有计划日期 → 「原定 2026-09-15（已过去）」
 *  - 时间不详（旧数据迁移 / LLM 拿不到日期）→ 明确写「时间不详」，不假装知道是哪天
 *  - 其余 → 「记住于 2026-09-14（3 天前）」
 */

import { getLang } from '@/i18n';

export interface MemoryTimeEntry {
  text: string;
  at: number;
  kind: string;
  atApprox?: boolean;
  dateKey?: string;
  stale?: boolean;
}

const KIND_ZH: Record<string, string> = {
  durable: '长期', state: '状态', event: '事件', plan: '计划',
  diary: '日记', reflection: '反思', relationship: '相处', portrait: '自画像',
};
const KIND_EN: Record<string, string> = {
  durable: 'long-term', state: 'state', event: 'event', plan: 'plan',
  diary: 'diary', reflection: 'reflection', relationship: 'bond', portrait: 'self-portrait',
};

export function kindText(kind: string): string {
  const en = getLang() === 'en';
  return (en ? KIND_EN[kind] : KIND_ZH[kind]) || (en ? 'memory' : '记忆');
}

/** 本地日历日期 YYYY-MM-DD */
export function dateText(at: number): string {
  const d = new Date(at);
  if (isNaN(d.getTime())) return '';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 本地时间点文本：当天带分钟（2026-09-19 07:12），更早只到天（2026-09-14） */
export function stampText(at: number): string {
  const d = new Date(at);
  if (isNaN(d.getTime())) return '';
  const day = dateText(at);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (!sameDay) return day;
  return `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 相对时间：刚刚 / n 分钟前 / n 小时前 / n 天前 / n 个月前 / n 年前 */
export function relText(at: number, now: number = Date.now()): string {
  const en = getLang() === 'en';
  const mins = Math.floor((now - at) / 60000);
  if (mins < 2) return en ? 'just now' : '刚刚';
  if (mins < 60) return en ? `${mins} min ago` : `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return en ? `${hours} h ago` : `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return en ? `${days} d ago` : `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return en ? `${months} mo ago` : `${months} 个月前`;
  const years = Math.floor(days / 365);
  return en ? `${years} yr ago` : `${years} 年前`;
}

/** 相差天数（按日历天） */
function dayDiff(dateKey: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return 0;
  const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}

/**
 * 一条记忆的时间说明（给用户看的完整句）：
 *  「记住于 2026-09-14（3 天前）」「原定 2026-09-15（2 天前，已过去）」「时间不详（约 2026-08-20 之前记下）」
 */
export function memoryWhenText(e: MemoryTimeEntry): string {
  const en = getLang() === 'en';
  if (e.dateKey) {
    const diff = dayDiff(e.dateKey);
    // 「原定」只属于计划；已经发生的事说「发生在」，否则读起来像"这件事还没办"
    const isPlan = e.kind === 'plan';
    if (diff > 0) {
      return isPlan
        ? (en ? `planned for ${e.dateKey} (in ${diff} days)` : `原定 ${e.dateKey}（还有 ${diff} 天）`)
        : (en ? `scheduled ${e.dateKey} (in ${diff} days)` : `定在 ${e.dateKey}（还有 ${diff} 天）`);
    }
    if (diff === 0) {
      return isPlan
        ? (en ? `planned for today (${e.dateKey})` : `定在今天（${e.dateKey}）`)
        : (en ? `today (${e.dateKey})` : `就在今天（${e.dateKey}）`);
    }
    return isPlan
      ? (en ? `was planned for ${e.dateKey} (${-diff} days ago, past)` : `原定 ${e.dateKey}（${-diff} 天前，已过去）`)
      : (en ? `happened on ${e.dateKey} (${-diff} days ago)` : `发生在 ${e.dateKey}（${-diff} 天前）`);
  }
  const stale = e.stale ? (en ? ' · may have changed' : ' · 可能已经变了') : '';
  if (e.atApprox) {
    const d = dateText(e.at);
    return en
      ? `time unknown (recorded no later than ${d})${stale}`
      : `时间不详（约 ${d} 之前记下）${stale}`;
  }
  return en
    ? `remembered ${stampText(e.at)} (${relText(e.at)})${stale}`
    : `记住于 ${stampText(e.at)}（${relText(e.at)}）${stale}`;
}

/** 成长档案条目（日记/反思/相处/自画像）的说明：`日记 · 2026-09-14（3 天前）` */
export function growthWhenText(at: number, kind: string): string {
  const en = getLang() === 'en';
  return en ? `${kindText(kind)} · ${stampText(at)} (${relText(at)})` : `${kindText(kind)} · ${stampText(at)}（${relText(at)}）`;
}
