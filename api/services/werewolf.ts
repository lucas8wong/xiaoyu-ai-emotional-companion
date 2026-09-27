/**
 * AI 狼人杀 · 服务端编排
 *
 * 职责（**权威在这里，模型只是玩家之一**）：
 *  1. 开局：把「聊一聊」角色 + 内置陪玩拼成一桌，洗牌发牌；
 *  2. 驱动：反复 `runSystemSteps` → 找 `actorsNeeded` → 让 AI 说话/决策（发言串行、其余并发）；
 *     轮到真人就落盘返回，等前端提交；
 *  3. 兜底：模型输出解析失败 / 输出不安全 / 调用报错，一律退化为**合法动作**，
 *     **绝不让一局因为一个模型抽风而卡死**；
 *  4. 成本：整局预留点数（`reserveCredit`）→ 累计真实 usage → 收尾结算校正 / 失败全额回滚。
 *
 * 与陪伴安全的关系（红线）：真人输入在**推进游戏之前**过 `safety.ts`；
 * 命中自伤类关键词时中断游戏并交由上层走危机响应，绝不当作一句「游戏发言」继续玩。
 */

import crypto from 'node:crypto';

import { createDeepSeekClient } from './deepseek.js';
import { werewolfLedger, type LedgerEntry, type WerewolfUserSummary } from './werewolfLedger.js';
import { dataFile, readJson, writeJson } from '../storage/persistence.js';
import { chatCharacterStore, type ChatCharacter } from './chatCharacter.js';
import { longMemoryStore } from './longMemory.js';
import { chatCharacterGrowthStore } from './chatCharacterGrowth.js';
import {
  estimateCreditFromTokens,
  ceilCreditToTiao,
  roundCreditToTiao,
  quotaStore,
  WEREWOLF_DAILY_LIMIT,
  WEREWOLF_FREE_DAILY_LIMIT,
  WEREWOLF_PLUS_DAILY_LIMIT,
} from './quota.js';
import { checkAiOutputSafety, isSelfHarmContent } from './safety.js';

import type { GameSize, PendingAction, SeatInput, WerewolfState } from '../../src/werewolf/engine/types.js';
import { GAME_SIZES, playerAt, roleCamp } from '../../src/werewolf/engine/types.js';
import {
  abstain,
  actorsNeeded,
  applyBoom,
  applyBoomTarget,
  applyFailedTurn,
  applyGuard,
  applyHunterShoot,
  applyLastWords,
  applySeerCheck,
  applySpeech,
  applyVote,
  applyWitchAction,
  applyWolfVote,
  createGame,
  runSystemSteps,
  skipWitch,
  witchBriefing,
} from '../../src/werewolf/engine/rules.js';
import type { WerewolfView } from '../../src/werewolf/engine/view.js';
import { viewFor } from '../../src/werewolf/engine/view.js';
import {
  BUILTIN_PLAYERS,
  type AgentPersona,
  type OutputLang,
  buildAgentMessages,
  parseDecision,
} from '../../src/werewolf/ai/prompt.js';

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

const FILE = dataFile('werewolf-games.json');
/** 每个用户保留最近多少局（对局带全部发言，不能无限长） */
const MAX_GAMES_PER_USER = 10;

class WerewolfStore {
  private items: WerewolfState[] = [];

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    const parsed = readJson<WerewolfState[]>(FILE, []);
    if (Array.isArray(parsed)) {
      this.items = parsed.filter((g) => g && typeof g.id === 'string' && Array.isArray(g.players));
    }
  }

  private saveToDisk(): void {
    try {
      writeJson(FILE, this.items);
    } catch {
      /* 落盘失败不阻断对局（内存里仍可继续） */
    }
  }

  get(id: string): WerewolfState | undefined {
    return this.items.find((g) => g.id === id);
  }

  /** 写入/更新一局，并把该用户的历史裁剪到上限 */
  save(state: WerewolfState): void {
    const idx = this.items.findIndex((g) => g.id === state.id);
    state.updatedAt = Date.now();
    if (idx >= 0) this.items[idx] = state;
    else this.items.push(state);

    const mine = this.items
      .filter((g) => g.userId === state.userId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (mine.length > MAX_GAMES_PER_USER) {
      const drop = new Set(mine.slice(MAX_GAMES_PER_USER).map((g) => g.id));
      this.items = this.items.filter((g) => !drop.has(g.id));
    }
    this.saveToDisk();
  }

  /** 最近的对局（新的在前），只回概要 */
  listForUser(userId: string, limit = 10): WerewolfState[] {
    return this.items
      .filter((g) => g.userId === userId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  /** 今天已开几局（每日局数上限按真实对局数派生，不引入新的用户计数字段） */
  countToday(userId: string, now = new Date()): number {
    const y = now.getFullYear();
    const m = now.getMonth();
    const d = now.getDate();
    return this.items.filter((g) => {
      if (g.userId !== userId) return false;
      const t = new Date(g.createdAt);
      return t.getFullYear() === y && t.getMonth() === m && t.getDate() === d;
    }).length;
  }

  /** 全量（运营端统计用；注意每用户只保留最近 10 局，历史会被裁剪） */
  all(): WerewolfState[] {
    return this.items.slice();
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((g) => g.id !== id);
    if (this.items.length !== before) {
      this.saveToDisk();
      return true;
    }
    return false;
  }
}

export const werewolfStore = new WerewolfStore();

// ---------------------------------------------------------------------------
// 累计计数（运营端用）
// 为什么要单独记：对局历史每用户只留 10 局、删了就没了，所以「一共开了多少局 / 花了多少 token」
// 这类累计量必须另存一份，不能从对局列表反推。
// ---------------------------------------------------------------------------

const STATS_FILE = dataFile('werewolf-stats.json');

export interface WerewolfCounters {
  started: number;
  ended: number;
  endByWinner: Record<string, number>;
  bySize: Record<string, number>;
  byPlan: Record<string, number>;
  /** 累计 AI 调用次数与 token（成本观测） */
  calls: number;
  promptTokens: number;
  completionTokens: number;
  /** 模型报错 / 解析失败 / 兜底 的累计次数（质量信号，不是业务量） */
  fallbackEvents: number;
}

const EMPTY_COUNTERS: WerewolfCounters = {
  started: 0,
  ended: 0,
  endByWinner: {},
  bySize: {},
  byPlan: {},
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  fallbackEvents: 0,
};

class WerewolfCounterStore {
  private data: WerewolfCounters = { ...EMPTY_COUNTERS };

  constructor() {
    const parsed = readJson<WerewolfCounters>(STATS_FILE, EMPTY_COUNTERS);
    if (parsed && typeof parsed === 'object') this.data = { ...EMPTY_COUNTERS, ...parsed };
  }

  private bump(map: Record<string, number>, key: string, n = 1): void {
    map[key] = (map[key] || 0) + n;
  }

  private save(): void {
    try {
      writeJson(STATS_FILE, this.data);
    } catch {
      /* 落盘失败不阻断对局 */
    }
  }

  /**
   * 测试 / 核实脚本可在调用前设 `WEREWOLF_COUNTERS_DISABLED=1`，
   * 避免把测试与打桩运行的数据算进运营口径（每轮复核都应得到同一份真实数字）。
   * 刻意在**调用时**读 env，而不是模块加载时——脚本没法在 import 之后改一个已固化的常量。
   */
  private disabled(): boolean {
    return process.env.WEREWOLF_COUNTERS_DISABLED === '1';
  }

  recordStart(size: GameSize, plan: string): void {
    if (this.disabled()) return;
    this.data.started += 1;
    this.bump(this.data.bySize, String(size));
    this.bump(this.data.byPlan, plan);
    this.save();
  }

  recordEnd(winner?: string): void {
    if (this.disabled()) return;
    this.data.ended += 1;
    if (winner) this.bump(this.data.endByWinner, winner);
    this.save();
  }

  recordUsage(u: { calls: number; promptTokens: number; completionTokens: number; fallbackEvents: number }): void {
    if (this.disabled()) return;
    this.data.calls += Math.max(0, u.calls);
    this.data.promptTokens += Math.max(0, u.promptTokens);
    this.data.completionTokens += Math.max(0, u.completionTokens);
    this.data.fallbackEvents += Math.max(0, u.fallbackEvents);
    this.save();
  }

  snapshot(): WerewolfCounters {
    return JSON.parse(JSON.stringify(this.data)) as WerewolfCounters;
  }
}

export const werewolfCounters = new WerewolfCounterStore();

export interface WerewolfAdminStats {
  counters: WerewolfCounters;
  /** 台账里的开局总数（与 `counters.started` 同源：都来自同一个开局动作） */
  retainedGames: number;
  /** 今日开局（台账口径） */
  todayStarted: number;
  /** 累计预估消耗点数（按累计 token 折算，与用户账单同源单价） */
  estimatedCreditTotal: number;
  /** 最近开局明细（与上面**同源**：此前读自研引擎存档，导致两者对不上） */
  recent: LedgerEntry[];
  /** 按用户汇总（运营端「谁在玩狼人杀」表；由同一份台账现算，与累计开局同源） */
  byUser: WerewolfUserSummary[];
}

/** 运营端「🐺 AI 狼人杀」页签的数据 */
export function werewolfAdminStats(): WerewolfAdminStats {
  const c = werewolfCounters.snapshot();
  return {
    counters: c,
    // 统一口径：自研引擎与 wolfcha 移植版都写同一份台账，累计卡片与最近明细因此同源
    retainedGames: werewolfLedger.total(),
    todayStarted: werewolfLedger.todayCount(),
    estimatedCreditTotal: estimateCreditFromTokens(c.promptTokens, c.completionTokens),
    recent: werewolfLedger.recent(20),
    byUser: werewolfLedger.userSummaries(),
  };
}

// ---------------------------------------------------------------------------
// 席位与人设
// ---------------------------------------------------------------------------

/** 一局开始前给用户的「可拉入角色」清单 */
export interface RosterCharacter {
  id: string;
  name: string;
  avatar?: string;
  /** 是不是内置小愈 */
  isDefault: boolean;
  /** 与用户的关系条数（有记忆的角色在局里更「认识你」） */
  memoryCount: number;
}

export function listRosterCharacters(userId: string): RosterCharacter[] {
  return chatCharacterStore.listForUser(userId).map((c) => ({
    id: c.id,
    name: c.name,
    avatar: c.avatar,
    isDefault: c.isDefault === true,
    memoryCount: longMemoryStore.getFacts(userId, c.id).length,
  }));
}

function growthRelationTexts(userId: string, characterId: string): string[] {
  try {
    const rec = chatCharacterGrowthStore.get(userId, characterId) as unknown as {
      relationship?: Array<{ text?: string }>;
    };
    return (rec?.relationship || [])
      .map((r) => String(r?.text || '').trim())
      .filter(Boolean)
      .slice(-4);
  } catch {
    return [];
  }
}

/** 把角色变成局内的 AI 玩家人设（人格 + 关系记忆） */
function personaFromCharacter(userId: string, seat: number, c: ChatCharacter): AgentPersona {
  return {
    seat,
    name: c.name,
    character: {
      id: c.id,
      name: c.name,
      identity: c.identity,
      boundaries: c.boundaries,
      voice: c.voice,
      opening: c.opening,
    },
    memories: longMemoryStore.getFacts(userId, c.id).slice(-6),
    relationship: growthRelationTexts(userId, c.id),
  };
}

export interface BuiltSeats {
  seats: SeatInput[];
  personas: Map<number, AgentPersona>;
}

/**
 * 组一桌：座位 1 永远是真人；
 * 用户拉进来的「聊一聊」角色依序坐下；不足的人数用内置陪玩补齐（重名自动加后缀）。
 */
export function buildSeats(userId: string, size: GameSize, characterIds: string[] = []): BuiltSeats {
  const seats: SeatInput[] = [{ id: 'user', kind: 'human', name: '你' }];
  const personas = new Map<number, AgentPersona>();
  const taken = new Set<string>();

  const all = chatCharacterStore.listForUser(userId);
  const byId = new Map(all.map((c) => [c.id, c]));
  const picked: ChatCharacter[] = [];
  for (const id of characterIds) {
    const c = byId.get(String(id));
    if (!c) continue;
    if (picked.some((p) => p.id === c.id)) continue;
    if (picked.length >= size - 1) break;
    picked.push(c);
  }

  let seatNo = 2;
  for (const c of picked) {
    let name = c.name;
    let n = 2;
    while (taken.has(name)) name = `${c.name}·${n++}`;
    taken.add(name);
    seats.push({ id: `ai:chat:${c.id}`, kind: 'ai', name, avatar: c.avatar, characterId: c.id });
    const p = personaFromCharacter(userId, seatNo, c);
    p.name = name;
    personas.set(seatNo, p);
    seatNo += 1;
  }

  // 内置陪玩补齐（用户一个都不拉时，整桌都是内置角色）
  let cycle = 0;
  while (seatNo <= size) {
    const b = BUILTIN_PLAYERS[cycle % BUILTIN_PLAYERS.length];
    const round = Math.floor(cycle / BUILTIN_PLAYERS.length);
    let name = round === 0 ? b.name : `${b.name}·${round + 1}`;
    let n = 2;
    while (taken.has(name)) name = `${b.name}(陪玩${n++})`;
    taken.add(name);
    seats.push({
      id: `ai:builtin:${b.id}${round ? `-${round + 1}` : ''}`,
      kind: 'ai',
      name,
      builtin: true,
    });
    personas.set(seatNo, {
      seat: seatNo,
      name,
      builtinPersona: { identity: b.identity, voice: b.voice },
    });
    seatNo += 1;
    cycle += 1;
  }

  return { seats, personas };
}

// ---------------------------------------------------------------------------
// 模型调用
// ---------------------------------------------------------------------------

type GenerateFn = (req: {
  contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  userId?: string;
  jsonMode?: boolean;
  thinkingLevel?: string;
  signal?: AbortSignal;
  /** 成本归属（运营端「API 成本构成」）：狼人杀的所有调用都记 'werewolf' */
  feature?: string;
}) => Promise<{
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  finishReason?: string;
}>;

export interface WerewolfDeps {
  /** 可注入的 LLM 调用（单测/真机脚本用，缺省走 DeepSeek） */
  generateContent?: GenerateFn;
  /** 可注入的时钟（测试用） */
  now?: () => number;
}

/** 驱动循环的运行上下文（导出供 `temp/verify-werewolf-pipeline.mts` 用打桩模型跑真机核实） */
export interface RunCtx {
  userId: string;
  lang: OutputLang;
  personas: Map<number, AgentPersona>;
  gen: GenerateFn;
  usage: { promptTokens: number; completionTokens: number; calls: number };
  errors: string[];
}

function textOf(result: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }): string {
  return result?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
}

/**
 * ⚠️ 这里曾经有一组「兜底发言」常量，用来在模型失败时替角色说一句无关痛痒的话。
 * **已删除**：依据项目红线（见 `src/lib/fallbackBubbles.ts`），失败绝不能伪装成角色台词——
 * 它会显示成「这个角色说过的话」、落盘、并回灌给其他玩家当上下文。
 * 现在统一走 `applyFailedTurn()`：只记「这一轮没能开口」，不编任何台词。
 */

// ---------------------------------------------------------------------------
// 让一个 AI 玩家行动
// ---------------------------------------------------------------------------

async function runAiActor(state: WerewolfState, seat: number, action: PendingAction, ctx: RunCtx): Promise<void> {
  const me = playerAt(state, seat);
  if (!me) return;
  const persona: AgentPersona = ctx.personas.get(seat) || { seat, name: me.name };

  let raw = '';
  try {
    const witch = action === 'witch' ? witchBriefing(state, seat) : undefined;
    const msgs = buildAgentMessages(state, persona, action, ctx.lang, { witch });
    const result = await ctx.gen({
      contents: [
        { role: 'system', parts: [{ text: msgs.system }] },
        { role: 'user', parts: [{ text: msgs.user }] },
      ],
      userId: ctx.userId,
      jsonMode: true,
      thinkingLevel: 'low', // 一局几十次调用，思考档统一压低（成本与延迟）
      feature: 'werewolf', // 成本归属：AI 狼人杀（自研引擎侧；移植版旁路在 wolfchaCompat.ts 记账）
    });
    raw = textOf(result);
    ctx.usage.calls += 1;
    ctx.usage.promptTokens += Number(result?.usage?.prompt_tokens || 0);
    ctx.usage.completionTokens += Number(result?.usage?.completion_tokens || 0);
  } catch (err) {
    ctx.errors.push(`seat${seat}:${action}: ${String((err as Error)?.message || err).slice(0, 120)}`);
    raw = '';
  }

  applyAiDecision(state, seat, action, raw, ctx.lang);
}

/**
 * 把模型输出落成合法动作。**任何异常都退化为合法动作**——宁可用兜底发言，也不能卡死一局。
 */
export function applyAiDecision(
  state: WerewolfState,
  seat: number,
  action: PendingAction,
  raw: string,
  _lang: OutputLang,
): void {
  const d = parseDecision(raw, action);

  switch (action) {
    case 'wolf-kill': {
      const target = pickLivingTarget(state, seat, d.ok ? d.target : undefined);
      if (target) applyWolfVote(state, seat, target);
      return;
    }
    case 'seer-check': {
      const target = pickLivingTarget(state, seat, d.ok ? d.target : undefined);
      if (target) applySeerCheck(state, seat, target);
      return;
    }
    case 'witch': {
      if (d.ok && (d.heal || d.poison != null)) {
        const r = applyWitchAction(state, seat, { heal: d.heal, poison: d.poison });
        if (r.ok) return;
      }
      skipWitch(state, seat); // 不表态就明确「不用药」，否则夜会永远停在这
      return;
    }
    case 'vote': {
      // 投票：解析不出就弃票（合法且不吃亏，符合真人也会弃票的行为）
      if (d.ok && d.target) {
        const r = applyVote(state, seat, d.target);
        if (r.ok) return;
      }
      abstain(state, seat);
      return;
    }
    case 'hunter-shoot': {
      const target = confirmDeadTarget(state, d.ok ? d.target : undefined);
      const r = applyHunterShoot(state, seat, target ?? null);
      if (!r.ok) applyHunterShoot(state, seat, null);
      return;
    }
    case 'guard': {
      // 兜底要避开「昨晚守过的人」（规则不允许连守）
      let target = d.ok ? d.target : undefined;
      const legal = (s?: number): s is number =>
        !!s && !!playerAt(state, s)?.alive && state.lastGuardTarget !== s;
      if (!legal(target)) {
        target = state.players.find((p) => p.alive && p.seat !== state.lastGuardTarget)?.seat;
      }
      if (legal(target)) applyGuard(state, seat, target);
      return;
    }
    case 'last-words': {
      const text = d.ok && d.speak ? d.speak.trim() : '';
      if (!text) {
        // 🚫 不替角色编遗言（项目红线）：模型没给出可用输出就只记「没能开口」
        applyFailedTurn(state, seat);
        return;
      }
      applyLastWords(state, seat, text);
      return;
    }
    case 'boom': {
      const target = pickLivingTarget(state, seat, d.ok ? d.target : undefined);
      applyBoomTarget(state, seat, target ?? null);
      return;
    }
    case 'speak':
    default: {
      // 白狼王可以在发言回合选择自爆（不额外多花一次调用）
      if (d.ok && d.boom) {
        const r = applyBoom(state, seat);
        if (r.ok) {
          applyBoomTarget(state, seat, d.boomTarget ?? null);
          return;
        }
      }
      let text = d.ok && d.speak ? d.speak : '';
      if (text) {
        const safe = checkAiOutputSafety(text);
        if (!safe.safe) text = ''; // 输出不安全 → 不能当作角色台词
      }
      if (!text) {
        // 🚫 模型报错 / 解析失败 / 输出不安全，都**不伪装成角色台词**（项目红线，见 src/lib/fallbackBubbles.ts）：
        // 只记「这一轮没能开口」，对局继续推进。
        applyFailedTurn(state, seat);
        return;
      }
      const r = applySpeech(state, seat, text);
      if (!r.ok && r.reason === 'not-your-turn') return; // 顺序已变（人类抢先发言等）
      return;
    }
  }
}

/** 挑一个存活的合法目标（自刀允许；打牌桌上的自己=狼人自刀，是合法策略） */
function pickLivingTarget(state: WerewolfState, seat: number, wanted?: number): number | undefined {
  if (wanted) {
    const p = playerAt(state, wanted);
    if (p && p.alive) return wanted;
  }
  const other = state.players.find((p) => p.alive && p.seat !== seat);
  if (other) return other.seat;
  const self = playerAt(state, seat);
  return self && self.alive ? seat : undefined;
}

/** 开枪目标必须是「别人且还活着」 */
function confirmDeadTarget(state: WerewolfState, wanted?: number): number | undefined {
  if (!wanted) return undefined;
  const p = playerAt(state, wanted);
  return p && p.alive ? wanted : undefined;
}

// ---------------------------------------------------------------------------
// 驱动循环
// ---------------------------------------------------------------------------

/** 廉价的进度指纹：任何真实推进都会改变它（用于识别「有人反复行动但状态不动」） */
function progressSignature(state: WerewolfState): string {
  return [
    state.phase,
    state.round,
    state.speakIndex,
    state.events.length,
    Object.keys(state.votes).length,
    state.night.wolfTarget ?? '-',
    state.witchDecided ? 1 : 0,
    state.pendingHunterSeat ?? '-',
  ].join('|');
}

/**
 * 推进到「轮到真人」或「对局结束」。
 * 白天发言必须串行（后说的要听得到先说的）；夜晚决策与投票互不依赖，可以并发。
 */
async function driveInner(
  state: WerewolfState,
  ctx: RunCtx,
  _deps: WerewolfDeps = {},
  opts: { maxCalls?: number } = {},
): Promise<void> {
  const maxCalls = opts.maxCalls || 0;
  const startCalls = ctx.usage.calls;
  let lastSignature = '';
  let stalled = 0;

  for (let guard = 0; guard < 400; guard++) {
    runSystemSteps(state);
    if (state.status === 'ended') {
      state.pendingSeat = undefined;
      state.pendingAction = undefined;
      return;
    }

    const actors = actorsNeeded(state);
    if (!actors.length) return;

    const mine = actors.find((a) => a.seat === state.humanSeat);
    if (mine) {
      state.pendingSeat = mine.seat;
      state.pendingAction = mine.action;
      return;
    }

    state.pendingSeat = undefined;
    state.pendingAction = undefined;

    // 单请求调用量上限：一次 HTTP 请求不要连续跑掉一整局——Cloudflare 边缘约 100s 无数据即回 524，
    // 这个坑项目历史上踩过（见 2026-09-11 的 AI 文游 524 根治）。超限就先返回，
    // 由客户端再发一次 `POST /:id/advance` 接着推（P1 再换 SSE 进度流）。
    if (maxCalls && ctx.usage.calls - startCalls >= maxCalls) return;

    const before = progressSignature(state);
    if (actors.every((a) => a.action === 'speak')) {
      for (const a of actors) await runAiActor(state, a.seat, a.action, ctx);
    } else {
      await Promise.all(actors.map((a) => runAiActor(state, a.seat, a.action, ctx)));
    }

    // 进度检测：连着几轮状态毫无变化 = 有座位反复行动但无效。
    // 此时宁可把对局停下并记录，也不要空转把用户的点数烧光。
    const after = progressSignature(state);
    if (after === before && after === lastSignature) {
      stalled += 1;
      ctx.errors.push(`stalled:${state.phase}`);
      if (stalled >= 3) {
        ctx.errors.push('drive-stalled-abort');
        return;
      }
    } else {
      stalled = 0;
    }
    lastSignature = after;
  }
  // guard 用尽：同样停下来，不无限耗钱
  ctx.errors.push('drive-guard-exhausted');
}

/**
 * 对外入口：包在 `driveInner` 外面只做一件事——**把本次请求的用量与兜底次数计入累计计数**。
 * 放在这里而不是三个调用点，是为了让「一次请求记一次」只有一个实现，避免漏记或重复记。
 */
export async function drive(
  state: WerewolfState,
  ctx: RunCtx,
  deps: WerewolfDeps = {},
  opts: { maxCalls?: number } = {},
): Promise<void> {
  const before = {
    calls: ctx.usage.calls,
    promptTokens: ctx.usage.promptTokens,
    completionTokens: ctx.usage.completionTokens,
  };
  try {
    await driveInner(state, ctx, deps, opts);
  } finally {
    werewolfCounters.recordUsage({
      calls: ctx.usage.calls - before.calls,
      promptTokens: ctx.usage.promptTokens - before.promptTokens,
      completionTokens: ctx.usage.completionTokens - before.completionTokens,
      fallbackEvents: ctx.errors.length,
    });
  }
}

// ---------------------------------------------------------------------------
// 成本
// ---------------------------------------------------------------------------

/** 整局预估（一局 6 人局约 50~90 次调用；9 人局翻倍） */
export function estimateGameCredit(size: GameSize, rounds = 3): {
  credit: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
} {
  const callsPerRound = size * 2 + 4;
  const calls = callsPerRound * rounds + 4;
  const promptTokens = calls * 1400;
  const completionTokens = calls * 260;
  return {
    credit: Math.max(1, estimateCreditFromTokens(promptTokens, completionTokens)),
    calls,
    promptTokens,
    completionTokens,
  };
}

/** 整局预留令牌（内存态：与 quota 的 creditReservations 同生命周期） */
const pendingCredits = new Map<string, { userId: string; token: string }>();

function settleIfEnded(state: WerewolfState): void {
  const pending = pendingCredits.get(state.id);
  if (!pending) return;
  if (state.status !== 'ended') return;
  pendingCredits.delete(state.id);
  // 先删令牌再记数：保证同一局只记一次「结束」
  werewolfCounters.recordEnd(state.winner);
  const actual = estimateCreditFromTokens(state.usage.promptTokens, state.usage.completionTokens);
  // 多退少补照旧，但**结算金额四舍五入到整条**（账本只认整条，见 quota.ts roundCreditToTiao）
  quotaStore.settleCredit(pending.userId, pending.token, roundCreditToTiao(actual));
}

function rollbackCredit(stateId: string): void {
  const pending = pendingCredits.get(stateId);
  if (!pending) return;
  pendingCredits.delete(stateId);
  quotaStore.rollbackCredit(pending.userId, pending.token);
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

export interface GameQuotaInfo {
  plan: 'free' | 'plus' | 'pro';
  remainToday: number;
  limitToday: number;
}

/** 每日局数上限（按 plan 分档；用真实对局数派生，不引入新的用户计数字段） */
export function werewolfQuota(userId: string): GameQuotaInfo {
  const plan = quotaStore.planOf(userId);
  const limitToday =
    plan === 'pro' ? WEREWOLF_DAILY_LIMIT : plan === 'plus' ? WEREWOLF_PLUS_DAILY_LIMIT : WEREWOLF_FREE_DAILY_LIMIT;
  const used = werewolfStore.countToday(userId);
  return { plan, limitToday, remainToday: Math.max(0, limitToday - used) };
}

export interface StartGameInput {
  userId: string;
  size: GameSize;
  /** 从「聊一聊」拉进来的角色 id（空 = 全用内置陪玩） */
  characterIds?: string[];
  lang?: OutputLang;
  seed?: number;
}

export interface GameEnvelope {
  gameId: string;
  view: WerewolfView;
  /** 本局预计消耗点数（整局预留） */
  estimatedCredit: number;
  quota: GameQuotaInfo;
  fallbackCount: number;
}

export class WerewolfError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.code = code;
  }
}

export async function startGame(input: StartGameInput, deps: WerewolfDeps = {}): Promise<GameEnvelope> {
  const { userId, size } = input;
  const lang: OutputLang = input.lang === 'en' ? 'en' : input.lang === 'zh-TW' ? 'zh-TW' : 'zh';
  if (!GAME_SIZES.includes(size)) throw new WerewolfError('BAD_SIZE');

  const quota = werewolfQuota(userId);
  if (quota.remainToday <= 0) throw new WerewolfError('WEREWOLF_DAILY_LIMIT');

  const { seats, personas } = buildSeats(userId, size, input.characterIds || []);
  const gameId = `ww_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const state = createGame({ id: gameId, userId, size, seats, seed: input.seed });

  // 整局预留一次（多调用流程的正确口径：一次预留、真实 usage 结算校正）
  // 预扣向上对齐到整条：账本硬性规则是「余量恒为整条」，局中显示才不会出现小数
  const est = estimateGameCredit(size);
  const reserved = quotaStore.reserveCredit(userId, 'werewolf', { credit: ceilCreditToTiao(est.credit) });
  if (!reserved.ok || !reserved.token) throw new WerewolfError('CHAT_QUOTA_EXCEEDED');
  pendingCredits.set(gameId, { userId, token: reserved.token });
  werewolfCounters.recordStart(size, quota.plan);

  const ctx: RunCtx = {
    userId,
    lang,
    personas,
    gen: deps.generateContent || (createDeepSeekClient().models.generateContent as GenerateFn),
    usage: state.usage,
    errors: [],
  };

  try {
    await drive(state, ctx, deps, { maxCalls: MAX_AI_CALLS_PER_REQUEST });
  } catch (err) {
    rollbackCredit(gameId);
    throw err;
  }

  state.usage = ctx.usage;
  settleIfEnded(state);
  werewolfStore.save(state);

  return {
    gameId,
    view: viewFor(state, state.humanSeat),
    estimatedCredit: reserved.reserved || est.credit,
    quota: werewolfQuota(userId),
    fallbackCount: ctx.errors.length,
  };
}

export interface SubmitActionInput {
  userId: string;
  gameId: string;
  /** 真人本轮的发言文本（speak 时必填） */
  text?: string;
  /** 目标座位（wolf-kill / seer-check / vote / hunter-shoot） */
  target?: number | null;
  /** 女巫决策 */
  heal?: boolean;
  poison?: number | null;
}

export interface SubmitResult {
  /** 命中危机内容 → 游戏中断，交由上层走陪伴/危机响应 */
  crisis?: boolean;
  code?: string;
  gameId: string;
  view?: WerewolfView;
  quota?: GameQuotaInfo;
}

export async function submitHumanAction(
  input: SubmitActionInput,
  deps: WerewolfDeps = {},
): Promise<SubmitResult> {
  const state = werewolfStore.get(input.gameId);
  if (!state) throw new WerewolfError('GAME_NOT_FOUND');
  if (state.userId !== input.userId) throw new WerewolfError('FORBIDDEN');
  if (state.status === 'ended') throw new WerewolfError('GAME_ENDED');

  const action = state.pendingAction;
  if (!action || state.pendingSeat !== state.humanSeat) throw new WerewolfError('NOT_YOUR_TURN');
  const seat = state.humanSeat;

  // ---- 红线：真人输入先过安全检查，命中自伤即中断游戏 ----
  const text = String(input.text || '').trim();
  if (text && isSelfHarmContent(text)) {
    // 刻意**不写入**这条发言、不推进对局：这一局停在这里，用户被带去陪伴路径
    return { crisis: true, code: 'SELF_HARM_INTERRUPT', gameId: state.id };
  }

  const lang: OutputLang = 'zh'; // 用户动作不需要语言参数（发言原文即用户所写）
  const personas = rebuildPersonas(state);
  const ctx: RunCtx = {
    userId: input.userId,
    lang,
    personas,
    gen: deps.generateContent || (createDeepSeekClient().models.generateContent as GenerateFn),
    usage: state.usage,
    errors: [],
  };

  switch (action) {
    case 'speak': {
      // 真人这一轮必须自己说点什么；**不替他编话**（红线：不把假台词写进事件流）
      if (!text) throw new WerewolfError('BAD_SPEECH');
      const r = applySpeech(state, seat, text);
      if (!r.ok) throw new WerewolfError('BAD_SPEECH');
      break;
    }
    case 'wolf-kill':
    case 'seer-check': {
      const target = pickLivingTarget(state, seat, input.target ?? undefined);
      if (!target) throw new WerewolfError('NO_TARGET');
      const r = action === 'wolf-kill' ? applyWolfVote(state, seat, target) : applySeerCheck(state, seat, target);
      if (!r.ok) throw new WerewolfError('BAD_ACTION');
      break;
    }
    case 'vote': {
      const target = input.target == null ? 0 : Number(input.target);
      const r = applyVote(state, seat, target);
      if (!r.ok) throw new WerewolfError('BAD_VOTE');
      break;
    }
    case 'witch': {
      if (input.heal || input.poison != null) {
        const r = applyWitchAction(state, seat, { heal: input.heal, poison: input.poison ?? null });
        if (!r.ok) skipWitch(state, seat);
      } else {
        skipWitch(state, seat);
      }
      break;
    }
    case 'hunter-shoot': {
      const target = confirmDeadTarget(state, input.target ?? undefined);
      applyHunterShoot(state, seat, target ?? null);
      break;
    }
    default:
      throw new WerewolfError('NOT_YOUR_TURN');
  }

  await drive(state, ctx, deps, { maxCalls: MAX_AI_CALLS_PER_REQUEST });
  state.usage = ctx.usage;
  settleIfEnded(state);
  werewolfStore.save(state);

  return {
    gameId: state.id,
    view: viewFor(state, state.humanSeat),
    quota: werewolfQuota(input.userId),
  };
}

/** 从已落盘的对局恢复 AI 人设（进程重启后仍能继续玩） */
function rebuildPersonas(state: WerewolfState): Map<number, AgentPersona> {
  const personas = new Map<number, AgentPersona>();
  const all = chatCharacterStore.listForUser(state.userId);
  const byId = new Map(all.map((c) => [c.id, c]));
  let builtinIdx = 0;
  for (const p of state.players) {
    if (p.kind !== 'ai') continue;
    if (p.characterId && byId.get(p.characterId)) {
      const persona = personaFromCharacter(state.userId, p.seat, byId.get(p.characterId)!);
      persona.name = p.name;
      personas.set(p.seat, persona);
    } else {
      const b = BUILTIN_PLAYERS[builtinIdx % BUILTIN_PLAYERS.length];
      builtinIdx += 1;
      personas.set(p.seat, {
        seat: p.seat,
        name: p.name,
        builtinPersona: { identity: b.identity, voice: b.voice },
      });
    }
  }
  return personas;
}

/** 取一局的视图（**必过视角过滤**） */
export function getGameView(userId: string, gameId: string): WerewolfView {
  const state = werewolfStore.get(gameId);
  if (!state) throw new WerewolfError('GAME_NOT_FOUND');
  if (state.userId !== userId) throw new WerewolfError('FORBIDDEN');
  return viewFor(state, state.humanSeat);
}

/** 单次请求允许跑掉多少次 AI 调用（超限由客户端再发 /advance 续推，避免 Cloudflare 524） */
export const MAX_AI_CALLS_PER_REQUEST = 22;

/**
 * 接着推进一段（客户端在「既没轮到我、也没结束」时循环调用）。
 * 拆成小段是为了让**每个请求的耗时可控**：一局 6 人局有 50+ 次模型调用，
 * 一次跑完必然越过边缘超时门槛。
 */
export async function advanceGame(
  userId: string,
  gameId: string,
  lang: OutputLang = 'zh',
  deps: WerewolfDeps = {},
): Promise<{ view: WerewolfView; quota: GameQuotaInfo; done: boolean }> {
  const state = werewolfStore.get(gameId);
  if (!state) throw new WerewolfError('GAME_NOT_FOUND');
  if (state.userId !== userId) throw new WerewolfError('FORBIDDEN');

  if (state.status === 'ended') {
    return { view: viewFor(state, state.humanSeat), quota: werewolfQuota(userId), done: true };
  }

  const ctx: RunCtx = {
    userId,
    lang,
    personas: rebuildPersonas(state),
    gen: deps.generateContent || (createDeepSeekClient().models.generateContent as GenerateFn),
    usage: state.usage,
    errors: [],
  };

  await drive(state, ctx, deps, { maxCalls: MAX_AI_CALLS_PER_REQUEST });
  state.usage = ctx.usage;
  settleIfEnded(state);
  werewolfStore.save(state);

  const view = viewFor(state, state.humanSeat);
  // 用 view 判定（而不是再读 state.status）：上面已对 state.status 做过窄化，
  // 而 drive() 会改它，TS 的窄化在这里是过期的。
  return { view, quota: werewolfQuota(userId), done: view.status === 'ended' || view.isMyTurn };
}

export interface GameSummary {
  id: string;
  size: GameSize;
  status: 'playing' | 'ended';
  winner?: 'wolf' | 'village';
  round: number;
  createdAt: number;
  updatedAt: number;
  seats: Array<{ seat: number; name: string; isYou: boolean; role?: string; builtin?: boolean }>;
}

export function listGames(userId: string): GameSummary[] {
  return werewolfStore.listForUser(userId).map((g) => ({
    id: g.id,
    size: g.size,
    status: g.status,
    winner: g.winner,
    round: g.round,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    seats: g.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      isYou: p.seat === g.humanSeat,
      role: g.status === 'ended' ? p.role : p.seat === g.humanSeat ? p.role : undefined,
      builtin: p.builtin,
    })),
  }));
}

/** 放弃一局（用户主动退出）：回滚未结算的预留点数 */
export function abandonGame(userId: string, gameId: string): boolean {
  const state = werewolfStore.get(gameId);
  if (!state) return false;
  if (state.userId !== userId) throw new WerewolfError('FORBIDDEN');
  rollbackCredit(gameId);
  return werewolfStore.remove(gameId);
}

export { roleCamp };
