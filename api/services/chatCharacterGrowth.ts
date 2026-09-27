/**
 * 聊一聊 · 自定义角色成长档案（纯质性，无数值/进度条）
 * 每个角色独立积累：关系记忆（你俩共同经历/它对这段关系的看法）、私人日记、对话反思、周期性自画像。
 * 数据持久化到 data/chat-character-growth.json，进程重启不丢失。
 *
 * 设计参考 Everthine「养成」：不做好感度/等级/进度条/每日任务，
 * 成长靠「发生过的痕迹」——日记、反思、自画像沉淀下来，再自然影响角色的口吻与表达。
 * 「程度」是质性的：通过角色的自画像/日记与说话方式让人感受到，而不是 0–100 的刻度。
 */

import { dataFile, readJson, writeJson } from '../storage/persistence.js';
// 会话状态层（B 档，2026-09-21）：此刻在做什么 / 当下的心情 / 未消的账 / 你们之间的梗。
// 挂在成长档案上而不是另开一个 store —— 它天然是「这一对（用户×角色）」的属性，与关系记忆同生命周期。
import type { ChatState } from './chatState.js';

export interface GrowthEntry {
  text: string;
  at: number;
}

export interface CharacterGrowthRecord {
  userId: string;
  characterId: string;
  /** 关系记忆：关于你俩共同经历 / 它对这段关系、对你的看法（注入 prompt，让角色按关系说话） */
  relationship: GrowthEntry[];
  /** 该角色的私人日记（低频生成） */
  diary: GrowthEntry[];
  /** 对话反思（简短，每次反思追加一条） */
  reflections: GrowthEntry[];
  /** 最新自画像（周期性更新，轻量影响角色成长感） */
  selfPortrait?: GrowthEntry;
  /** 自画像成长历史（每次更新追加一次，供观景窗「自画像成长对比」查看） */
  portraitHistory?: GrowthEntry[];
  /** 首次聊天时间戳（认识天数彩蛋用） */
  firstChatAt?: number;
  /** 有聊天记录的所有日期 YYYY-MM-DD（用于连续聊天天数） */
  chatDays?: string[];
  /** 已触发过的里程碑（30/100/300 轮），避免重复触发 */
  milestones?: Record<string, boolean>;
  /** 自上次反思以来的对话轮数 */
  exchangeCount: number;
  lastReflectAt: number;
  lastPortraitAt: number;
  /**
   * 会话状态层（B 档，2026-09-21）：**"此刻"的状态**，与上面那些"档案"性质不同——
   * 它带 TTL（scene 6h / mood 12h / grudge 24h / joke 7d），过期即消失，不做长期沉淀。
   * 之所以还放在这里：它天然属于「这一对（用户 × 角色）」，另开 store 只会多一份要同步的生命周期。
   */
  state?: ChatState;
  updatedAt: number;
}

const FILE = dataFile('chat-character-growth.json');

// 阈值（纯质性：用于决定何时沉淀一次「反思/自画像」，本身不对外暴露）
const REFLECT_EVERY = 6; // 每 6 轮对话触发一次反思
const PORTRAIT_EVERY = 3; // 每 3 次反思触发一次自画像
const MAX_RELATIONSHIP = 40;
const MAX_DIARY = 30;
const MAX_REFLECTIONS = 40;

function dayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

class ChatCharacterGrowthStore {
  private items: Map<string, CharacterGrowthRecord> = new Map();

  constructor() { this.loadFromDisk(); }

  private key(userId: string, characterId: string): string { return userId + '::' + characterId; }

  private loadFromDisk(): void {
    const parsed = readJson<CharacterGrowthRecord[]>(FILE, []);
    if (Array.isArray(parsed)) {
      parsed.forEach((r) => {
        if (r?.userId && r.characterId) this.items.set(this.key(r.userId, r.characterId), r);
      });
    }
    console.log(`💾 [Growth] 已从磁盘加载 ${this.items.size} 条角色成长档案`);
  }

  private saveToDisk(): void {
    try {
      writeJson(FILE, Array.from(this.items.values()));
    } catch { /* 忽略 */ }
  }

  get(userId: string, characterId: string): CharacterGrowthRecord {
    const k = this.key(userId, characterId);
    return this.items.get(k) || {
      userId, characterId,
      relationship: [], diary: [], reflections: [],
      exchangeCount: 0, lastReflectAt: 0, lastPortraitAt: 0, updatedAt: 0,
    };
  }

  private touch(rec: CharacterGrowthRecord): CharacterGrowthRecord {
    rec.updatedAt = Date.now();
    this.items.set(this.key(rec.userId, rec.characterId), rec);
    this.saveToDisk();
    return rec;
  }

  /**
   * 追加关系记忆（去重、裁剪）。
   *
   * `sourceAt`（可选）：这条关系记忆**发生的时间**——剧情角色导入时，共同经历发生在剧情里，
   * 用导入时刻当时间会让"我们那时候…"全都变成今天（2026-09-19 记忆时间轴的同类问题）。
   * 缺省 = 现在（普通对话沉淀，行为与改动前完全一致）。
   */
  addRelationship(userId: string, characterId: string, texts: string[], sourceAt?: number): CharacterGrowthRecord {
    const rec = this.get(userId, characterId);
    const existing = new Set(rec.relationship.map(r => r.text));
    const at = Number.isFinite(sourceAt) && (sourceAt as number) > 0 ? Math.floor(sourceAt as number) : Date.now();
    for (const t of (texts || [])) {
      const s = String(t).trim();
      if (s && s.length <= 120 && !existing.has(s)) {
        rec.relationship.push({ text: s, at });
        existing.add(s);
      }
    }
    rec.relationship = rec.relationship.slice(-MAX_RELATIONSHIP);
    return this.touch(rec);
  }

  /**
   * 读会话状态（B 档）。`buildChatPromptParts` 每轮**同步**读它 —— 所以这里只做一次 Map 取、
   * 不做任何计算或 IO（对话链路上多一次 await 就是多几秒延迟，同 `chatDailyLife.ts` 的教训）。
   */
  getState(userId: string, characterId: string): ChatState | undefined {
    return this.get(userId, characterId).state;
  }

  /**
   * 写会话状态（每轮回复之后调用）。状态由 `chatState.updateChatState` 这个**纯函数**整块算好，
   * 这里只负责落盘 —— 好处是过期清理与去重逻辑可以脱离 store 单测。
   */
  setState(userId: string, characterId: string, state: ChatState): CharacterGrowthRecord {
    const rec = this.get(userId, characterId);
    rec.state = state;
    return this.touch(rec);
  }

  /** 追加私人日记 */
  addDiary(userId: string, characterId: string, text: string): CharacterGrowthRecord {
    const rec = this.get(userId, characterId);
    const s = String(text || '').trim();
    if (s) rec.diary.push({ text: s, at: Date.now() });
    rec.diary = rec.diary.slice(-MAX_DIARY);
    return this.touch(rec);
  }

  /** 追加反思 */
  addReflection(userId: string, characterId: string, text: string): CharacterGrowthRecord {
    const rec = this.get(userId, characterId);
    const s = String(text || '').trim();
    if (s) rec.reflections.push({ text: s, at: Date.now() });
    rec.reflections = rec.reflections.slice(-MAX_REFLECTIONS);
    rec.exchangeCount = 0;
    rec.lastReflectAt = Date.now();
    return this.touch(rec);
  }

  /** 更新自画像（同时记录成长历史，供「自画像成长对比」查看） */
  setSelfPortrait(userId: string, characterId: string, text: string): CharacterGrowthRecord {
    const rec = this.get(userId, characterId);
    const s = String(text || '').trim();
    if (s) {
      const entry = { text: s, at: Date.now() };
      rec.selfPortrait = entry;
      rec.portraitHistory = [...(rec.portraitHistory || []), entry].slice(-10);
    }
    rec.lastPortraitAt = Date.now();
    return this.touch(rec);
  }

  /** 每轮对话自增计数 */
  bumpExchange(userId: string, characterId: string): CharacterGrowthRecord {
    const rec = this.get(userId, characterId);
    rec.exchangeCount += 1;
    this.recordDay(rec);
    return this.touch(rec);
  }

  /** 记录本次聊天日期（认识天数彩蛋） */
  private recordDay(rec: CharacterGrowthRecord): void {
    const today = dayKey();
    if (!rec.firstChatAt) rec.firstChatAt = Date.now();
    if (!rec.chatDays) rec.chatDays = [];
    if (!rec.chatDays.includes(today)) rec.chatDays.push(today);
  }

  /** 连续聊天天数：从今天（无则昨天）往前数连续的天数 */
  streakDays(rec: CharacterGrowthRecord, includeToday = false): number {
    const days = new Set(rec.chatDays || []);
    if (includeToday) days.add(dayKey()); // 计算「今天也要聊」的连续天数（彩蛋提示用，不持久化）
    if (days.size === 0) return 0;
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cursor = new Date();
    if (!days.has(fmt(cursor))) {
      cursor.setDate(cursor.getDate() - 1);
      if (!days.has(fmt(cursor))) return 0;
    }
    let count = 0;
    while (days.has(fmt(cursor))) {
      count += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return count;
  }

  /** 下一轮对话是否会命中里程碑（30/100/300），返回里程碑值或 null */
  milestoneAtCount(count: number): number | null {
    return [30, 100, 300].includes(count) ? count : null;
  }

  /** 是否已按对话轮数触发过里程碑（只提示一次） */
  milestoneClaimed(rec: CharacterGrowthRecord, level: number): boolean {
    return !!rec.milestones?.[String(level)];
  }

  /** 标记里程碑已触发 */
  claimMilestone(rec: CharacterGrowthRecord, level: number): void {
    rec.milestones = { ...(rec.milestones || {}), [String(level)]: true };
  }

  /** 是否该触发一次反思（达到轮数阈值） */
  reflectionDue(rec: CharacterGrowthRecord): boolean {
    return rec.exchangeCount >= REFLECT_EVERY;
  }

  /** 是否该更新自画像（达到反思次数阈值） */
  portraitDue(rec: CharacterGrowthRecord): boolean {
    return rec.reflections.length > 0 && rec.reflections.length % PORTRAIT_EVERY === 0 && (!rec.selfPortrait || Date.now() - (rec.lastPortraitAt || 0) > 6 * 60 * 60 * 1000);
  }

  /** 取出注入 prompt 的关系记忆（最近 N 条） */
  relationshipForPrompt(rec: CharacterGrowthRecord, n = 6): string[] {
    return rec.relationship.slice(-n).map(r => r.text);
  }

  /** 删除某角色（删除角色时清理成长档案） */
  deleteByCharacter(userId: string, characterId: string): void {
    if (this.items.delete(this.key(userId, characterId))) this.saveToDisk();
  }

  deleteByUser(userId: string): void {
    let changed = false;
    const prefix = userId + '::';
    for (const k of Array.from(this.items.keys())) {
      if (k.startsWith(prefix)) { this.items.delete(k); changed = true; }
    }
    if (changed) this.saveToDisk();
  }
}

export const chatCharacterGrowthStore = new ChatCharacterGrowthStore();
export default chatCharacterGrowthStore;
