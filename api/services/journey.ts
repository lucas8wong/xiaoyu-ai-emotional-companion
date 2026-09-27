/**
 * «与你的旅程»聚合器（纯代码数据可视化，不生成任何图片）
 *
 * 把散落在各处的「陪伴证据」串成一幅可回访的关系地图：
 *   - 初次相遇（每角色的 firstChatAt / 最早打卡）
 *   - 心情打卡（diary）
 *   - 关系记忆（chatCharacterGrowth.relationship）
 *   - 自画像（chatCharacterGrowth.selfPortrait / portraitHistory）
 *   - 它记得的关于你（longMemory.facts）
 *   - 你喜欢的剧情（roleplayLikes，按语言本地化标题）
 *
 * buildJourney 为纯函数（便于单测注入数据）；getJourney 从持久化 Store 读真实数据。
 */

import { diaryStore } from './diary.js';
import { chatCharacterStore } from './chatCharacter.js';
import { chatCharacterGrowthStore } from './chatCharacterGrowth.js';
import { longMemoryStore, toEntryView } from './longMemory.js';
import { preferenceStore } from './preferences.js';
import { todayKeyIn } from './timeAnchor.js';
import { roleplayLikeStore } from './roleplayLikes.js';
import { roleplaySessionStore } from './roleplaySessions.js';
import { resolveRoleplayTitle, resolveWenyouTitle } from './scenarioTitle.js';
import { wenyouSavesStore } from './wenyouSaves.js';

export type JourneyMomentType = 'first' | 'mood' | 'memory' | 'portrait' | 'like';

export interface JourneyMoment {
  at: number;
  date: string; // YYYY-MM-DD
  type: JourneyMomentType;
  characterId: string;
  characterName: string;
  text?: string; // memory / portrait 的原文，或 like 的剧情标题
  mood?: string; // mood 的 emoji key
  note?: string; // mood 的一句话
  /** like 类：该剧情是用户自建 → 前端在剧名旁渲染「自建」标志 */
  custom?: boolean;
  /** like 类：该自建剧本已被创作者删除 → 前端另加「已删」标志 */
  deleted?: boolean;
}

export interface JourneyCharacter {
  id: string;
  name: string;
  isDefault: boolean;
  /** 聊一聊该角色的头像（自定义角色为用户上传/设置；内置小愈为空，由前端按皮肤解析） */
  avatar?: string;
  daysKnown: number;
  streak: number;
  firstChatAt?: number;
  chatDays: number;
  /** 已达成对话轮数里程碑（30/100/300） */
  milestones: number[];
  relationMemories: { text: string; at: number }[];
  selfPortrait?: { text: string; at: number };
  portraitHistory: { text: string; at: number }[];
  facts: string[]; // 它记得的关于你
  /** 同上，但带时间轴（kind/at/dateKey/stale），前端显示「记住于 X」（2026-09-17） */
  factEntries?: { text: string; at: number; kind: string; atApprox?: boolean; dateKey?: string; stale?: boolean }[];
}

export interface JourneySummary {
  daysKnown: number;
  checkins: number;
  characters: number;
  memories: number;
  portraits: number;
  likes: number;
  moodStreak: number;
}

export interface JourneyStory {
  scenarioId: string;
  title: string; // 真实剧名（本地化）；自建剧本解析不到真名时为空串，由前端用兜底文案
  at: number; // 最后游玩时间
  kind?: 'roleplay' | 'wenyou'; // roleplay=角色扮演足迹, wenyou=AI 文游(千世书)
  /** 用户自建（角色扮演自建剧本 / 千世书自建书）→ 前端渲染「自建」标志，不再显示内部 id */
  custom?: boolean;
  /** 自建剧本已被删除（标题快照都没留下 → 只剩兜底文案）→ 前端另加「已删」标志 */
  deleted?: boolean;
}

export interface JourneyData {
  summary: JourneySummary;
  characters: JourneyCharacter[];
  /** 时间倒序的「重要瞬间」时间线 */
  moments: JourneyMoment[];
  /** 你去过的剧情（角色扮演足迹，用户级 = 所有角色都知晓），时间倒序 */
  stories: JourneyStory[];
}

interface JourneyInputCharacter {
  id: string;
  name: string;
  isDefault: boolean;
  avatar?: string;
  firstChatAt?: number;
  chatDays: string[];
  milestones?: Record<string, boolean>;
  relationship: { text: string; at: number }[];
  selfPortrait?: { text: string; at: number };
  portraitHistory: { text: string; at: number }[];
  facts: string[];
  factEntries?: { text: string; at: number; kind: string; atApprox?: boolean; dateKey?: string; stale?: boolean }[];
}

interface JourneyInput {
  characters: JourneyInputCharacter[];
  diaries: { date: string; mood: string; note: string; createdAt: number }[];
  /** 已解析标题的点赞剧情（at=点赞时间，title=真实剧名，custom=用户自建，deleted=剧本已被删） */
  likes: { at: number; title: string; custom?: boolean; deleted?: boolean }[];
  /** 已解析标题的游玩剧情足迹（at=最后游玩时间，title=真实剧名，custom=用户自建，deleted=剧本已被删） */
  stories: { scenarioId: string; title: string; at: number; kind?: 'roleplay' | 'wenyou'; custom?: boolean; deleted?: boolean }[];
  moodStreak: number;
}

const DAY_MS = 86_400_000;

function dateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 认识天数（含当天，n=1 起点）；负数/无 → 0 */
function daysKnown(ms?: number): number {
  if (!ms) return 0;
  const diff = Date.now() - ms;
  return diff >= 0 ? Math.floor(diff / DAY_MS) + 1 : 1;
}

/** 连续聊天天数（从今天或昨天往前数） */
function computeStreak(chatDays: string[]): number {
  const days = new Set(chatDays || []);
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

/** 纯函数聚合：入参即数据，便于单测 / 与存储解耦 */
export function buildJourney(input: JourneyInput): JourneyData {
  const moments: JourneyMoment[] = [];
  let earliest = 0;
  const push = (m: JourneyMoment) => {
    moments.push(m);
    if (!earliest || m.at < earliest) earliest = m.at;
  };

  for (const c of input.characters) {
    if (c.firstChatAt) {
      push({ at: c.firstChatAt, date: dateKey(c.firstChatAt), type: 'first', characterId: c.id, characterName: c.name });
    }
    for (const r of c.relationship) {
      if (r.at) push({ at: r.at, date: dateKey(r.at), type: 'memory', characterId: c.id, characterName: c.name, text: r.text });
    }
    if (c.selfPortrait?.at) {
      push({ at: c.selfPortrait.at, date: dateKey(c.selfPortrait.at), type: 'portrait', characterId: c.id, characterName: c.name, text: c.selfPortrait.text });
    }
  }

  for (const d of input.diaries) {
    if (d.createdAt) {
      push({ at: d.createdAt, date: d.date, type: 'mood', characterId: '', characterName: '', mood: d.mood, note: d.note });
    }
  }

  for (const l of input.likes) {
    if (l.at) push({ at: l.at, date: dateKey(l.at), type: 'like', characterId: '', characterName: '', text: l.title, custom: l.custom, deleted: l.deleted });
  }

  moments.sort((a, b) => b.at - a.at);

  const characters: JourneyCharacter[] = input.characters.map((c) => ({
    id: c.id,
    name: c.name,
    isDefault: c.isDefault,
    avatar: c.avatar || undefined,
    daysKnown: daysKnown(c.firstChatAt),
    streak: computeStreak(c.chatDays),
    firstChatAt: c.firstChatAt,
    chatDays: (c.chatDays || []).length,
    milestones: Object.keys(c.milestones || {})
      .filter((k) => c.milestones![k])
      .map(Number)
      .sort((a, b) => a - b),
    relationMemories: c.relationship || [],
    selfPortrait: c.selfPortrait,
    portraitHistory: c.portraitHistory || [],
    facts: c.facts || [],
    ...(c.factEntries ? { factEntries: c.factEntries } : {}),
  }));

  const stories: JourneyStory[] = [...(input.stories || [])].sort((a, b) => b.at - a.at);

  const summary: JourneySummary = {
    daysKnown: earliest ? daysKnown(earliest) : 0,
    checkins: (input.diaries || []).length,
    characters: input.characters.length,
    memories: input.characters.reduce((n, c) => n + (c.relationship || []).length, 0),
    portraits: input.characters.filter((c) => c.selfPortrait).length,
    likes: (input.likes || []).length,
    moodStreak: input.moodStreak || 0,
  };

  return { summary, characters, moments, stories };
}

/** 界面语言 → roleplay 语言码（zh-CN → zh） */
function normLang(lang?: string): 'zh' | 'zh-TW' | 'en' {
  return lang === 'zh-TW' ? 'zh-TW' : lang === 'en' ? 'en' : 'zh';
}

/**
 * 从持久化 Store 读出用户旅程；lang 用于剧情标题本地化。
 *
 * 剧情标题一律走 `scenarioTitle.ts` 的统一解析（自建剧本显示用户自己起的剧名 + custom 标志，
 * 不再露出 `custom_xxx` 内部 id 或「自定义剧情」占位）。
 */
export function getJourney(userId: string, lang?: string, tzOverride?: string): JourneyData {
  const chars = chatCharacterStore.listForUser(userId);
  // 同一套「现在」口径（用户时区）用于判断记忆是否过期/时间不详；请求头时区优先
  const tz = tzOverride || (() => { try { return preferenceStore.get(userId).timezone; } catch { return undefined; } })();
  const todayKey = todayKeyIn(tz || '');
  const inputChars: JourneyInputCharacter[] = chars.map((c) => {
    const g = chatCharacterGrowthStore.get(userId, c.id);
    const entries = longMemoryStore.getEntries(userId, c.id);
    return {
      id: c.id,
      name: c.name,
      isDefault: c.isDefault,
      avatar: c.avatar || undefined,
      firstChatAt: g.firstChatAt,
      chatDays: g.chatDays || [],
      milestones: g.milestones,
      relationship: g.relationship,
      selfPortrait: g.selfPortrait,
      portraitHistory: g.portraitHistory || [],
      facts: entries.map((e) => e.text),
      factEntries: entries.map((e) => toEntryView(e, todayKey)),
    };
  });
  const diaries = diaryStore.list(userId).map((d) => ({ date: d.date, mood: d.mood, note: d.note, createdAt: d.createdAt }));
  const rpLang = normLang(lang);
  const likes = roleplayLikeStore.getUserLikes(userId).map((l) => {
    const r = resolveRoleplayTitle(l.scenarioId, userId, rpLang);
    return { at: l.createdAt, title: r.title, custom: r.custom, deleted: r.deleted };
  });
  const roleplayStories = roleplaySessionStore.listByUser(userId)
    .map((s) => {
      // 会话里存了标题快照：剧本被创作者删除后，这里仍能显示玩家当初看到的剧名
      const r = resolveRoleplayTitle(s.scenarioId, userId, rpLang, s.scenarioTitle);
      return { scenarioId: s.scenarioId, at: s.updatedAt, title: r.title, custom: r.custom, deleted: r.deleted, kind: 'roleplay' as const };
    })
    .filter((s) => s.at > 0);
  // 文游（千世书）：进行中局 games + 已达成结局 endings 的剧本
  const wyProgress = wenyouSavesStore.get(userId);
  const wyIds = new Set<string>([
    ...Object.keys(wyProgress?.games || {}),
    ...Object.keys(wyProgress?.endings || {}),
  ]);
  const wenyouStories = Array.from(wyIds)
    .map((id) => {
      const r = resolveWenyouTitle(id, userId);
      return { scenarioId: id, at: wyProgress?.updatedAt || 0, title: r.title, custom: r.custom, deleted: r.deleted, kind: 'wenyou' as const };
    })
    .filter((s) => s.at > 0);
  const stories = [...roleplayStories, ...wenyouStories].sort((a, b) => b.at - a.at);
  return buildJourney({ characters: inputChars, diaries, likes, stories, moodStreak: diaryStore.streak(userId) });
}
