/**
 * 全量记忆召回（语义检索 + 时间衰减，方案三/本地 embedding）
 * 从「全量」记忆中（用户事实 / 关系记忆 / 对话反思 / 私人日记）按与当前查询的语义相关度取 top-K，
 * 注入 prompt，从而召回**旧的但相关**的记忆，而不是只带最近几条。
 * 若 embedding 不可用（模型未加载/失败）或没相关内容，返回 null，调用方回退到「最近窗口」逻辑。
 *
 * 2026-09-17（记忆时间轴）：
 *  - 召回结果**带上每条记忆自己的时间**（at/kind/stale），由调用方渲染成时间标签
 *    否则召回块又会变成一堆"没有时间的旧事"，正是「把几个月前当成今天」的入口；
 *  - 排序从「纯语义相似度」改为「相似度 × 时间新鲜度」：语义相近但很旧的记忆不再稳稳压过刚发生的事；
 *  - 已过期的计划/状态仍可被召回（用户话题碰得到），但标 stale，让模型带时间问、而不是当现在断言。
 */

import { longMemoryStore, isMemoryStale, type MemoryKind } from './longMemory.js';
import { chatCharacterGrowthStore } from './chatCharacterGrowth.js';
import { storyArchiveStore } from './storyArchive.js';
import { embedOne, embedBatch, cosine, isEmbeddingReady } from './embedding.js';

const TOP_FACTS = 4;
const TOP_REL = 4;
const TOP_REFLECTIONS = 2;
const TOP_DIARY = 2;
/**
 * 剧情档案（场面块）的召回条数。
 * 为什么是 2：块本身 ≤400 字、信息密度高（含原句台词），2 块 ≈ 800 字已经足够"想起那一段"；
 * 给多了会盖过当下的现实话题（剧情角色在聊现实生活时，旧剧情不该抢戏）。
 */
const TOP_STORY = 2;
/**
 * 语义相似度阈值（低于视为不相关，不注入）。
 *
 * 为什么分两档（2026-09-17 真机实测）：
 * 拿线上真实记忆扫了一遍相似度，「话题明确相关」的查询大量落在 0.30–0.45，而「话题无关」的
 * 偶尔也会到 0.4+（"今天好累" 撞上"用户工作累/失眠"其实是相关，但 "明天要早起" 撞上一条旧行程
 * 就是噪声），**单一阈值分不开这两类**。而 durable 事实本来就在最近窗口里，召回只是补漏，
 * 卡严一点没损失；state/event/plan 这类**带时间**的记忆如果卡在 0.45，就等于永远回不来
 * （实测「腾冲冷不冷」对「用户当前在腾冲旅游」只有 0.419 → 旧记忆等于被藏起来），
 * 所以放宽到 0.32，改由**时间标签 + 规则**来保证它只被当旧事提，而不是靠不让它出现。
 */
const MIN_SCORE = 0.45;
const MIN_SCORE_TIMED = Number(process.env.MEMORY_RECALL_MIN_SCORE_TIMED || 0.32);

/** 放宽阈值只针对「带时间的事实」：状态 / 事件 / 计划（关系·反思·日记仍按严阈值）
 *  2026-09-20：剧情场面块（story）同属"带时间的具体经历"，也走放宽档，否则「你上次说的那把伞」
 *  这种细节在 0.45 阈值下基本回不来（与 state/event 实测 0.419 的同类问题）。 */
function isTimedFact(kind: string): boolean {
  return kind === 'state' || kind === 'event' || kind === 'plan' || kind === 'story';
}
// 时间衰减半衰期（天）：越旧的"状态/事件/计划"越难被主动翻出来；长期事实不衰减
const HALF_LIFE_DAYS = 45;
// 已过期/可能已变的条目再乘一个折扣（能召回，但要让位给新鲜的）
const STALE_FACTOR = 0.6;

const DAY = 24 * 60 * 60 * 1000;

export interface RecalledItem {
  text: string;
  /** 时间锚（ms） */
  at: number;
  atApprox?: boolean;
  /** durable / state / event / plan / relationship / reflection / diary / story（剧情场面块） */
  kind: MemoryKind | 'relationship' | 'reflection' | 'diary' | 'story';
  /** 绝对日期（计划类） */
  dateKey?: string;
  /** 已过期 / 时间不详的旧状态：可以说，但必须带时间、不能当现在 */
  stale?: boolean;
}

export interface RecalledMemories {
  facts: RecalledItem[];
  relationship: RecalledItem[];
  reflections: RecalledItem[];
  diary: RecalledItem[];
  /** 剧情场面块（只有剧情角色有；来自 storyArchive，按话题召回的"细节层"） */
  story: RecalledItem[];
  /** 是否含"已经过时"的条目（调用方据此追加一句提醒） */
  hasStale: boolean;
}

/** 时间新鲜度系数：1（刚发生）→ 0（很远）；durable 不衰减 */
function recencyFactor(item: { at: number; kind: string; stale?: boolean }, now: number): number {
  let f = 1;
  if (item.kind !== 'durable') {
    const ageDays = Math.max(0, (now - item.at) / DAY);
    f = 1 / (1 + ageDays / HALF_LIFE_DAYS);
  }
  if (item.stale) f *= STALE_FACTOR;
  return f;
}

export async function recallMemories(userId: string, characterId: string, query: string, todayKey?: string): Promise<RecalledMemories | null> {
  if (!userId || !query || !isEmbeddingReady()) return null;
  try {
    const now = Date.now();
    const factEntries = longMemoryStore.getEntries(userId, characterId);
    const g = chatCharacterGrowthStore.get(userId, characterId);
    const relAll = g.relationship;
    const reflAll = g.reflections;
    const diaryAll = g.diary;
    // 剧情场面块（只有剧情出身的角色有；普通角色这条恒为空数组，行为与改动前一致）
    const storyBlocks = storyArchiveStore.listBlocks(userId, characterId);
    if (factEntries.length + relAll.length + reflAll.length + diaryAll.length + storyBlocks.length === 0) return null;

    // 最近窗口（已经在 prompt 里、且带时间标签），剔除以免重复
    const windowFacts = new Set(longMemoryStore.getPromptEntries(userId, characterId, todayKey, 16).map(e => e.text));
    const recentRel = new Set(relAll.slice(-6).map(r => r.text));
    const recentRefl = new Set(reflAll.slice(-3).map(r => r.text));
    const recentDiary = new Set(diaryAll.slice(-2).map(d => d.text));

    const factPool: RecalledItem[] = factEntries
      .filter(e => !windowFacts.has(e.text))
      .map(e => ({
        text: e.text,
        at: e.at,
        ...(e.atApprox ? { atApprox: true } : {}),
        kind: e.kind,
        ...(e.dateKey ? { dateKey: e.dateKey } : {}),
        // 时间不详的旧状态：可召回但必须标「可能已经变了」
        ...(isMemoryStale(e, todayKey) || (e.atApprox && (e.kind === 'state' || e.kind === 'plan')) ? { stale: true } : {}),
      }));
    const toItems = (list: { text: string; at: number }[], kind: RecalledItem['kind'], skip: Set<string>): RecalledItem[] =>
      list.filter(x => !skip.has(x.text)).map(x => ({ text: x.text, at: x.at, kind }));

    const pools: Record<string, RecalledItem[]> = {
      facts: factPool,
      relationship: toItems(relAll, 'relationship', recentRel),
      reflections: toItems(reflAll, 'reflection', recentRefl),
      diary: toItems(diaryAll, 'diary', recentDiary),
      story: storyBlocks.map(b => ({ text: b.text, at: b.at, kind: 'story' as const })),
    };

    const queryVec = await embedOne(query);
    if (!queryVec) return null;
    // 闭包内不保留控制流窄化，这里显式收窄为 number[]，供嵌套 topK 使用
    const qv: number[] = queryVec;

    async function topK(pool: RecalledItem[], k: number): Promise<RecalledItem[]> {
      if (pool.length === 0) return [];
      const vecs = await embedBatch(pool.map(p => p.text));
      return pool
        .map((item, i) => {
          const sim = cosine(qv, vecs[i] ?? []);
          return { item, sim, score: sim * recencyFactor(item, now) };
        })
        // 放宽带时间的**事实**（state/event/plan）；关系/反思/日记这类"底色"仍按严阈值，
        // 否则它们会把每一轮的召回块都填满（实测：放宽后连"在吗"都会捞回 7 条旧相处记忆）
        .filter(x => x.sim > (isTimedFact(x.item.kind) ? MIN_SCORE_TIMED : MIN_SCORE))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map(x => x.item);
    }

    const [facts, relationship, reflections, diary, story] = await Promise.all([
      topK(pools.facts, TOP_FACTS),
      topK(pools.relationship, TOP_REL),
      topK(pools.reflections, TOP_REFLECTIONS),
      topK(pools.diary, TOP_DIARY),
      topK(pools.story, TOP_STORY),
    ]);

    if (facts.length === 0 && relationship.length === 0 && reflections.length === 0 && diary.length === 0 && story.length === 0) return null;
    const hasStale = [...facts, ...relationship, ...reflections, ...diary].some(i => i.stale);
    return { facts, relationship, reflections, diary, story, hasStale };
  } catch {
    return null;
  }
}
