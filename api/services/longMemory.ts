/**
 * 长期记忆模块（带时间轴 · 2026-09-17 起）
 * 按用户（userId）+ 角色（characterId）持久化"小愈"对用户的长期记忆。
 * 数据持久化到 data/long-memory.json，进程重启不丢失。
 *
 * 用途：
 * 1. 聊天时把记忆注入 prompt，让 AI 记得用户是谁、聊过什么，跨会话不"失忆"
 * 2. 记忆由 AI 在对话后异步提取（见 gemini.ts extractMemoryFacts），这里只负责存取
 *
 * ⚠️ 为什么每条记忆都要带时间（本次改造的核心）：
 * 旧实现里 facts 是**裸字符串数组**，整条记录只有一个 updatedAt（每次新增事实都会被刷成"现在"），
 * 于是「这段记忆是什么时候的事」在写入那一刻就被抹掉了 —— 模型会把很早以前的
 * 「用户在云南腾冲旅游」当成今天正在发生，问出「芒市那边今天怎么样」。
 * 现在每条记忆是一个 MemoryEntry：带 at（时间锚）、kind（类型）、dateKey（绝对日期）、
 * status（是否已被新信息取代）。时间信息缺失时**标 atApprox 承认不知道**，绝不编造时间。
 *
 * 旧数据（facts: string[]）在加载时一次性迁移（幂等、不删任何条目、不改正文一字）：
 * 时间未知 → at=旧的 updatedAt 且 atApprox=true（只当作"不晚于此刻"，不当准确时间）。
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { checkContentSafety } from './safety.js';

/** 记忆类型：决定它会不会过期、过期后该怎么被提起 */
export type MemoryKind =
  /** 长期不变：称呼/身份/长期偏好/重要的人 */
  | 'durable'
  /** 当前状态：正在经历的事（工作压力、失眠、正在旅行）——会过期 */
  | 'state'
  /** 已发生的事（有时间点） */
  | 'event'
  /** 还没发生的安排（面试、出行、考试）——到了那天就过期 */
  | 'plan';

export interface MemoryEntry {
  /** 条目 id（取代关系用；进程内单调，跨重启可能重号，仅作回溯线索） */
  id: string;
  text: string;
  /** 时间锚（ms）：event=发生时间；plan=原定时间；state=观察到的时刻；durable=记下的时刻 */
  at: number;
  /**
   * at 是否为推断值。为 true 时**不得**把它当作准确时间：
   * 旧数据迁移（时间信息已丢失）、以及拿不到日期的 durable/event 都是推断值。
   */
  atApprox?: boolean;
  kind: MemoryKind;
  /** 绝对日期 YYYY-MM-DD（用户本地日历）；计划类用它判「那天是不是已经过去了」 */
  dateKey?: string;
  /** 已被更新的记忆取代：保留可回溯，但不再注入、不再召回 */
  status?: 'active' | 'superseded';
  supersededAt?: number;
  supersededBy?: string;
  source?: 'llm' | 'legacy';
}

export interface LongMemoryRecord {
  userId: string;
  /** 该记忆归属的角色（聊一聊自定义角色 id；缺省/内置默认视为「小愈」） */
  characterId?: string;
  /** 关键事实列表，每条一句话（旧字段：始终与 entries 里的**有效**条目同步，供历史读取方兼容） */
  facts: string[];
  /** 结构化记忆条目（带时间轴） */
  entries?: MemoryEntry[];
  updatedAt: number;
}

/** 新增记忆的入参（LLM 提取结果 / 调用方构造） */
export interface MemoryInput {
  text: string;
  kind?: MemoryKind;
  /** 绝对日期 YYYY-MM-DD（计划/事件的时间点） */
  date?: string;
  /** 这条新信息推翻的旧记忆原文（旧条目会被标记「已被更新」，不删除） */
  replaces?: string[];
}

/** 默认记忆维度 = 小愈（兼容旧数据：旧记录无 characterId，视为小愈） */
export const DEFAULT_CHARACTER_ID = 'xiaoyu';

const FILE = dataFile('long-memory.json');

/** 单个用户最多记住的事实条数（防止无限膨胀） */
const MAX_FACTS = 60;
/** 「已被更新」的旧条目最多保留几条（留痕用，超出先被裁掉） */
const SUPERSEDED_KEEP = 10;

const DAY = 24 * 60 * 60 * 1000;
/** 「当前状态」类记忆多久后算可能已过期（不再主动提，只等话题碰到时召回） */
const STATE_STALE_DAYS = Number(process.env.MEMORY_STATE_STALE_DAYS || 30);
/** 没写日期的「计划」多久后算过期 */
const PLAN_STALE_DAYS = Number(process.env.MEMORY_PLAN_STALE_DAYS || 30);

/**
 * 指令类特征（P1-09）：疑似注入/指令的记忆条目不入库（如"从现在起忽略规则"）。
 * 已知取舍（启发式，复查 F4）：含「忘记/记住/不要提起」等词的正常叙事句可能被误拦；
 * 后续如需放宽，可改为「指令+祈使结构」双条件。
 */
const INSTRUCTION_PATTERN = /记住[:：]|从现在起|忽略.{0,8}(规则|设定|指令)|你是[一个]?(系统|助手|AI|机器人|小愈)|忘掉|忘记|不要(再)?(遵守|提起|说|执行)|(改为|变成).{0,6}(模式|人设|规则)/i;

/**
 * 旧数据迁移时的类型推断（**只用于分类，不用于删除**）：
 * 线上旧记忆绝大多数是"状态快照"（"用户正在经历工作压力""用户在云南芒市旅游""明天有面试""计划去香港"），
 * 这类记忆若被当成"长期不变"，就会被永久当成现在 —— 正是本次要修的问题。
 * 命中状态/计划特征的判为 state（会过期、不主动提），其余判为 durable（身份/偏好）。
 *
 * 该启发式对 `source: 'legacy'` 的条目**每次加载都会重算**（见 normalizeRecord）：
 * 这样以后想放宽/收紧词表，重启即生效，不必写一次性数据迁移脚本。
 */
const LEGACY_STATE_RE = /正在|当前|此刻|此时|目前|暂时|最近|近期|近段|这阵子|这几天|这两天|近日|当天|当晚|今天|昨天|明天|上周|上个月|马上|即将|刚刚|刚|计划|打算|准备去|要去|坐标|位于|所在地|情绪|压力|焦虑|难过|低落|失眠|加班|忙|生病|感冒|发烧|旅行|旅游|出差|面试|考试|找工作|换工作|搬家|装修|减肥|戒烟|分手|住院|手术|怀孕/;

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const KINDS: MemoryKind[] = ['durable', 'state', 'event', 'plan'];

class LongMemoryStore {
  private items: Map<string, LongMemoryRecord> = new Map();
  private seq = 0;

  constructor() { this.loadFromDisk(); }

  /** 复合主键：用户 + 角色维度（旧数据无 characterId → 视为小愈） */
  private key(userId: string, characterId: string = DEFAULT_CHARACTER_ID): string {
    return userId + '::' + (characterId || DEFAULT_CHARACTER_ID);
  }

  private newId(at: number): string {
    this.seq = (this.seq + 1) % 1296;
    return 'm' + at.toString(36) + this.seq.toString(36);
  }

  /** 旧记录（facts: string[]）→ 带时间轴记录；已有 entries 的原样规范化 */
  private normalizeRecord(raw: any): { rec: LongMemoryRecord; migrated: boolean } {
    const userId = String(raw.userId);
    const characterId = raw.characterId ? String(raw.characterId) : undefined;
    const updatedAt = Number(raw.updatedAt) || 0;
    let entries: MemoryEntry[] = [];
    const rawEntries: any[] = Array.isArray(raw.entries) ? raw.entries : [];
    if (rawEntries.length > 0) {
      entries = rawEntries
        .map((e: any): MemoryEntry | null => {
          const text = String(e?.text ?? '').trim();
          if (!text) return null;
          const at = Number(e?.at) || updatedAt || Date.now();
          const kind: MemoryKind = KINDS.includes(e?.kind) ? e.kind : 'durable';
          return {
            id: String(e?.id || ''),
            text,
            at,
            ...(e?.atApprox ? { atApprox: true } : {}),
            kind,
            ...(e?.dateKey ? { dateKey: String(e.dateKey) } : {}),
            ...(e?.status === 'superseded' ? { status: 'superseded' as const } : {}),
            ...(Number(e?.supersededAt) ? { supersededAt: Number(e.supersededAt) } : {}),
            ...(e?.supersededBy ? { supersededBy: String(e.supersededBy) } : {}),
            ...(e?.source ? { source: e.source } : {}),
          };
        })
        .filter((e): e is MemoryEntry => !!e);
      for (const e of entries) if (!e.id) e.id = 'L-' + djb2(e.text);
    }
    const migrated = entries.length === 0 && Array.isArray(raw.facts) && raw.facts.length > 0;
    if (migrated) {
      // 旧数据迁移：正文一字不改；时间信息已丢失 → atApprox 承认"不知道"，不当准确时间
      const fallbackAt = updatedAt || Date.now();
      entries = (raw.facts as unknown[])
        .map((f) => String(f).trim())
        .filter((f) => f.length > 0)
        .map((f) => {
          const kind: MemoryKind = LEGACY_STATE_RE.test(f) ? 'state' : 'durable';
          return { id: 'L-' + djb2(f), text: f, at: fallbackAt, atApprox: true, kind, source: 'legacy' as const };
        });
    }
    const usedIds = new Set<string>();
    for (const e of entries) {
      if (usedIds.has(e.id)) e.id = e.id + '-' + djb2(e.text);
      usedIds.add(e.id);
      // 旧数据（无时间信息）的类型每次加载按当前词表重算：改词表重启即生效，不必写迁移脚本
      if (e.source === 'legacy') e.kind = LEGACY_STATE_RE.test(e.text) ? 'state' : 'durable';
    }
    const rec: LongMemoryRecord = {
      userId,
      characterId,
      facts: entries.filter((e) => e.status !== 'superseded').map((e) => e.text),
      entries,
      updatedAt: updatedAt || Date.now(),
    };
    return { rec, migrated };
  }

  private loadFromDisk(): void {
    const parsed = readJson<any[]>(FILE, []);
    let migrated = 0;
    if (Array.isArray(parsed)) {
      parsed.forEach((r: any) => {
        if (!r?.userId) return;
        const { rec, migrated: m } = this.normalizeRecord(r);
        if (m) migrated++;
        this.items.set(this.key(rec.userId, rec.characterId), rec);
      });
    }
    console.log(`💾 [Memory] 已从磁盘加载 ${this.items.size} 条用户/角色长期记忆`);
    if (migrated > 0) {
      // 迁移幂等：写回一次后 entries 已就位，下次启动不再迁移；正文一字未改、未删任何条目
      this.saveToDisk();
      console.log(`🕰️ [Memory] 已为 ${migrated} 条旧记忆补上时间轴（时间信息缺失的标为「时间不详」，正文未改、未删条目）`);
    }
  }

  private saveToDisk(): void {
    try {
      writeJson(FILE, Array.from(this.items.values()));
    } catch { /* 忽略 */ }
  }

  get(userId: string, characterId: string = DEFAULT_CHARACTER_ID): LongMemoryRecord {
    const k = this.key(userId, characterId);
    return this.items.get(k) || { userId, characterId, facts: [], entries: [], updatedAt: 0 };
  }

  /**
   * 结构化记忆条目（写入顺序＝时间升序）。
   * includeSuperseded=true 时连「已被更新」的旧条目一起返回（管理端/回溯用）。
   */
  getEntries(userId: string, characterId: string = DEFAULT_CHARACTER_ID, includeSuperseded = false): MemoryEntry[] {
    const all = this.get(userId, characterId).entries || [];
    return includeSuperseded ? all.filter((e) => e.text) : all.filter((e) => e.text && e.status !== 'superseded');
  }

  /** 只读取出该用户在某角色维度下的关键事实列表（**有效**条目，写入顺序；旧签名保持兼容） */
  getFacts(userId: string, characterId: string = DEFAULT_CHARACTER_ID): string[] {
    const rec = this.get(userId, characterId);
    if (rec.entries && rec.entries.length) return rec.entries.filter((e) => e.text && e.status !== 'superseded').map((e) => e.text);
    return rec.facts;
  }

  /**
   * 注入「最近窗口」用的条目。排除三类**不能当成现在说**的记忆（Q2C：降权 + 不主动提）：
   *  - 已被更新（superseded）的条目；
   *  - 过期的计划 / 状态（计划那天已过去；状态超过 STATE_STALE_DAYS）；
   *  - **时间不详的旧状态/计划**（旧数据迁移来的当前状态快照，且没有准确时间）——
   *    不确定它是否还成立，就不主动提；等用户话题碰到时由语义召回带时间标记提起。
   */
  getPromptEntries(userId: string, characterId: string = DEFAULT_CHARACTER_ID, todayKey?: string, max: number = MAX_FACTS): MemoryEntry[] {
    return this.getEntries(userId, characterId)
      .filter((e) => !isMemoryStale(e, todayKey))
      .filter((e) => !(e.atApprox && (e.kind === 'state' || e.kind === 'plan')))
      .slice(-max);
  }

  /** 合并新事实（去重、处理取代关系、裁剪到上限），返回最新记录；maxFacts 按档位分级（默认 60）
   *  P1-09：入库前过滤——内容安全（自伤/违规）不入库；指令类特征（注入）不入库 */
  addFacts(userId: string, items: (string | MemoryInput)[], maxFacts: number = MAX_FACTS, characterId: string = DEFAULT_CHARACTER_ID): LongMemoryRecord {
    const cur = this.get(userId, characterId);
    const now = Date.now();
    const inputs: MemoryInput[] = (items || []).map((it) => (typeof it === 'string' ? { text: it } : it));
    const clean = inputs
      .map((it) => ({ ...it, text: String(it?.text ?? '').trim() }))
      .filter((it) => it.text.length > 0 && it.text.length <= 80)
      .filter((it) => checkContentSafety(it.text).safe && !INSTRUCTION_PATTERN.test(it.text));

    const entries: MemoryEntry[] = [...(cur.entries || [])];

    // 1) 先落新条目（去重：只与当前**有效**条目比较；被取代的旧条目不算重复源）
    const applied: { input: MemoryInput; entry: MemoryEntry }[] = [];
    const createdIds = new Set<string>();
    for (const it of clean) {
      const existing = entries.find((e) => e.status !== 'superseded' && !createdIds.has(e.id)
        && (e.text === it.text || e.text.includes(it.text) || it.text.includes(e.text)));
      if (existing) { applied.push({ input: it, entry: existing }); continue; }
      const dateKey = normalizeDateKey(it.date);
      const kind: MemoryKind = it.kind && KINDS.includes(it.kind) ? it.kind : 'durable';
      const at = dateKey ? dateKeyToTs(dateKey) : now;
      const entry: MemoryEntry = {
        id: this.newId(at),
        text: it.text,
        at,
        // 时间精度：有明确日期 → 准确；state/plan 是"此刻听到的" → 准确；durable/event 无日期 → 推断值
        ...(!dateKey && (kind === 'durable' || kind === 'event') ? { atApprox: true } : {}),
        ...(dateKey ? { dateKey } : {}),
        kind,
        source: 'llm',
      };
      entries.push(entry);
      createdIds.add(entry.id);
      applied.push({ input: it, entry });
    }

    // 2) 取代关系：新信息推翻旧记忆 → 旧条目标「已被更新」（保留、不删、不再注入）
    for (const { input, entry } of applied) {
      for (const r of input.replaces || []) {
        const target = String(r || '').replace(/^[\s"'「『【\[]+|[\s"'」』】\]]+$/g, '').trim();
        if (target.length < 4) continue;
        for (const e of entries) {
          if (e.id === entry.id || createdIds.has(e.id) || e.status === 'superseded') continue;
          const hit = e.text === target
            || (target.length >= 6 && (e.text.includes(target) || target.includes(e.text)));
          if (!hit) continue;
          e.status = 'superseded';
          e.supersededAt = now;
          e.supersededBy = entry.id;
        }
      }
    }

    const kept = this.trimEntries(entries, maxFacts);
    const record: LongMemoryRecord = {
      userId,
      characterId,
      facts: kept.filter((e) => e.status !== 'superseded').map((e) => e.text),
      entries: kept,
      updatedAt: now,
    };
    this.items.set(this.key(userId, characterId), record);
    this.saveToDisk();
    return record;
  }

  /** 裁剪到上限：先丢「已被更新」的旧条目（只保留最近 SUPERSEDED_KEEP 条留痕），再丢最旧的 */
  private trimEntries(entries: MemoryEntry[], maxFacts: number): MemoryEntry[] {
    if (entries.length <= maxFacts) return entries;
    const superseded = entries.filter((e) => e.status === 'superseded');
    const keepSuper = new Set(superseded.slice(-SUPERSEDED_KEEP).map((e) => e.id));
    const dropSet = new Set(entries.filter((e) => e.status === 'superseded' && !keepSuper.has(e.id)).map((e) => e.id));
    const rest = entries.filter((e) => !dropSet.has(e.id));
    const need = rest.length - maxFacts;
    if (need > 0) for (const e of rest.slice(0, need)) dropSet.add(e.id);
    return entries.filter((e) => !dropSet.has(e.id));
  }

  /** 删除某用户全部记忆（账户注销时，含所有角色维度） */
  deleteByUser(userId: string): void {
    let changed = false;
    const prefix = userId + '::';
    for (const k of Array.from(this.items.keys())) {
      if (k.startsWith(prefix)) { this.items.delete(k); changed = true; }
    }
    if (changed) this.saveToDisk();
  }

  /** 删除单条记忆（按索引，索引口径 = getFacts() 的**有效**条目顺序，供用户记忆管理 P1-09b）；返回是否删除 */
  removeFact(userId: string, index: number, characterId: string = DEFAULT_CHARACTER_ID): boolean {
    const rec = this.items.get(this.key(userId, characterId));
    if (!rec || !Number.isInteger(index) || index < 0) return false;
    const entries = rec.entries || [];
    const active = entries.filter((e) => e.text && e.status !== 'superseded');
    if (index >= active.length) return false;
    const pos = entries.indexOf(active[index]);
    if (pos < 0) return false;
    entries.splice(pos, 1);
    rec.facts = entries.filter((e) => e.status !== 'superseded').map((e) => e.text);
    rec.updatedAt = Date.now();
    this.saveToDisk();
    return true;
  }

  /** 游客长期记忆并入账号（去重、按上限裁剪；小愈与各角色维度分别归并，时间轴一并带走） */
  reassignUser(oldId: string, newId: string, maxFacts: number = MAX_FACTS): void {
    if (!oldId || !newId || oldId === newId) return;
    const oldPrefix = oldId + '::';
    for (const [k, g] of this.items.entries()) {
      if (!k.startsWith(oldPrefix)) continue;
      const entries = (g.entries || []).filter((e) => e.status !== 'superseded');
      if (entries.length === 0) continue;
      // 保留原有 kind / 绝对日期（不因归并丢失时间轴；无日期的按新写入规则处理）
      this.addFacts(newId, entries.map((e) => ({ text: e.text, kind: e.kind, date: e.dateKey })), maxFacts, g.characterId || DEFAULT_CHARACTER_ID);
    }
  }

  /** 全部记忆（管理端统计/排查） */
  listAll(): LongMemoryRecord[] {
    return Array.from(this.items.values());
  }
}

/** YYYY-MM-DD → ms（当天 00:00，服务器本地日历；只做天级判断，够用） */
export function dateKeyToTs(dateKey: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return Date.now();
  const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
  return Number.isFinite(ts) ? ts : Date.now();
}

/** 宽松接受 LLM 可能给出的 YYYY-M-D / YYYY/MM/DD；不合法返回 undefined（宁可不写，也不编日期） */
export function normalizeDateKey(date?: string | null): string | undefined {
  if (!date) return undefined;
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(String(date).trim());
  if (!m) return undefined;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 这条记忆是否"已经不能当现在说"：
 * 已被更新 / 计划那天已过去（或没日期的计划放太久）/ 状态超过 STATE_STALE_DAYS。
 * 注意：**只影响"怎么说"，不影响"存不存"**——任何记忆都不会因为过期而被删除。
 */
export function isMemoryStale(e: MemoryEntry, todayKey?: string, now: number = Date.now()): boolean {
  if (e.status === 'superseded') return true;
  const ageDays = (now - (e.at || 0)) / DAY;
  if (e.kind === 'plan') {
    if (e.dateKey) return todayKey ? e.dateKey < todayKey : false;
    return ageDays > PLAN_STALE_DAYS;
  }
  if (e.kind === 'state') return ageDays > STATE_STALE_DAYS;
  return false;
}

export { STATE_STALE_DAYS, PLAN_STALE_DAYS, MAX_FACTS };

/** 前端展示用的记忆条目（带上"是否已过期/时间不详"，供「TA 记得的你」显示记住时间与状态） */
export interface MemoryEntryView {
  text: string;
  at: number;
  kind: MemoryKind;
  atApprox?: boolean;
  dateKey?: string;
  stale?: boolean;
}

export function toEntryView(e: MemoryEntry, todayKey?: string, now: number = Date.now()): MemoryEntryView {
  return {
    text: e.text,
    at: e.at,
    kind: e.kind,
    ...(e.atApprox ? { atApprox: true } : {}),
    ...(e.dateKey ? { dateKey: e.dateKey } : {}),
    ...(isMemoryStale(e, todayKey, now) ? { stale: true } : {}),
  };
}

export const longMemoryStore = new LongMemoryStore();
export default longMemoryStore;
