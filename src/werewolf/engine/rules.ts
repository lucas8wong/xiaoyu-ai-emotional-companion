/**
 * AI 狼人杀 · 规则与状态机（纯函数，**服务端唯一权威**）
 *
 * 分工（关键设计）：
 *  - 本文件裁决一切：谁死了、谁出局、谁赢。**绝不把输赢判定交给 LLM。**
 *  - LLM 只负责「发言」与「决策倾向」（刀谁 / 验谁 / 用药 / 投谁），由 `api/services/werewolf.ts`
 *    收集后调用这里的 `apply*` 写回状态。
 *  - 每次状态变动都要能被 `tickOnce` 推动：`runSystemSteps()` 反复调用 `tickOnce`，
 *    直到「没有可自动推进的步骤」（返回 false）——此时 `actorsNeeded()` 告诉编排层该问谁。
 *
 * 规则简化（已写进《AI狼人杀-调研与实施方案.md》，不是遗漏）：
 *  - 女巫解药不能自救；同一夜只能用一瓶药（解药或毒药）。
 *  - 猎人被毒杀不能开枪；被刀/被放逐可以开枪。
 *  - 投票平票 = 无人出局（不做 PK 加赛）。
 *  - 达到 `MAX_ROUNDS` 仍未屠城 = 好人守住（判好人胜）。
 */

import type {
  Camp,
  GameEvent,
  GameSize,
  NightState,
  PendingAction,
  Phase,
  SeatInput,
  WerewolfPlayer,
  WerewolfRole,
  WerewolfState,
} from './types.js';
import {
  aliveVillageCount,
  aliveWolfCount,
  isWolfRole,
  livingSeats,
  MAX_ROUNDS,
  playerAt,
  ROSTERS,
} from './types.js';

// ---------------------------------------------------------------------------
// 随机与洗牌（可复现：同一 seed 同一局身份，便于复盘与排障）
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(input: T[], rnd: () => number): T[] {
  const a = input.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

/** 按局型生成身份牌堆（顺序未洗） */
export function buildRoleDeck(size: GameSize): WerewolfRole[] {
  const roster = ROSTERS[size];
  if (!roster) throw new Error(`unsupported size ${size}`);
  const order: WerewolfRole[] = ['werewolf', 'whiteWolfKing', 'seer', 'witch', 'hunter', 'guard', 'idiot', 'villager'];
  const deck: WerewolfRole[] = [];
  for (const role of order) {
    for (let i = 0; i < (roster[role] || 0); i++) deck.push(role);
  }
  return deck;
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

function emit(state: WerewolfState, e: Omit<GameEvent, 'round' | 'at'>): GameEvent {
  const ev: GameEvent = { ...e, round: state.round, at: Date.now() };
  state.events.push(ev);
  state.updatedAt = ev.at;
  return ev;
}

// ---------------------------------------------------------------------------
// 开局
// ---------------------------------------------------------------------------

export interface CreateGameOptions {
  id: string;
  userId: string;
  size: GameSize;
  /** 座位输入，数组下标 i 对应座位号 i+1；长度必须等于 size */
  seats: SeatInput[];
  seed?: number;
  now?: number;
}

export function createGame(opts: CreateGameOptions): WerewolfState {
  const { id, userId, size, seats } = opts;
  if (!ROSTERS[size]) throw new Error(`unsupported size ${size}`);
  if (!Array.isArray(seats) || seats.length !== size) {
    throw new Error(`seats length ${seats?.length} != size ${size}`);
  }
  const seed = opts.seed ?? (Math.floor(Math.random() * 2 ** 31) || 1);
  const now = opts.now ?? Date.now();
  const deck = shuffle(buildRoleDeck(size), mulberry32(seed));

  const players: WerewolfPlayer[] = seats.map((s, i) => {
    const role = deck[i];
    const p: WerewolfPlayer = {
      seat: i + 1,
      id: s.id,
      kind: s.kind,
      name: s.name,
      avatar: s.avatar,
      characterId: s.characterId,
      builtin: s.builtin,
      role,
      alive: true,
    };
    if (role === 'witch') {
      p.antidoteUsed = false;
      p.poisonUsed = false;
    }
    if (role === 'hunter') p.canShoot = true;
    if (role === 'whiteWolfKing') p.boomed = false;
    // 所有人开局都有投票权；白痴被票出翻牌后才失去
    p.canVote = true;
    return p;
  });

  const humanSeat = players.find((p) => p.kind === 'human')?.seat ?? 1;

  const state: WerewolfState = {
    id,
    userId,
    size,
    createdAt: now,
    updatedAt: now,
    status: 'playing',
    round: 1,
    phase: 'night-wolf',
    players,
    humanSeat,
    events: [],
    night: {},
    votes: {},
    speakOrder: [],
    speakIndex: 0,
    usage: { promptTokens: 0, completionTokens: 0, calls: 0 },
    seed,
  };

  emit(state, { t: 'game-start', audience: 'public', count: size });
  // 身份只发给本人（硬隔离：前端拿不到别人的这一条）
  for (const p of players) {
    emit(state, { t: 'role-assigned', audience: p.seat, seat: p.seat, role: p.role });
  }
  // 狼队互认
  const wolves = players.filter((p) => isWolfRole(p.role)).map((p) => p.seat);
  if (wolves.length) {
    emit(state, { t: 'wolf-teammates', audience: 'wolf', count: wolves.length });
  }

  beginNight(state);
  return state;
}

// ---------------------------------------------------------------------------
// 夜晚
// ---------------------------------------------------------------------------

/** 进入新的一夜：清空本夜与白天的一切暂存 */
export function beginNight(state: WerewolfState): void {
  state.phase = 'night-guard'; // 夜晚第一步是守卫（阶段序沿用 wolfcha）
  state.night = {};
  state.votes = {};
  state.speakOrder = [];
  state.speakIndex = 0;
  state.exiledSeat = undefined;
  state.witchDecided = false;
  state.pendingHunterSeat = undefined;
  state.returnPhase = undefined;
  state.pendingSeat = undefined;
  state.pendingAction = undefined;
  // 白天的一次性状态（PK / 遗言 / 自爆）每轮重置
  state.pkSeats = undefined;
  state.pkUsed = false;
  state.pkRound = 0;
  state.boomSeat = undefined;
  state.lastWordsSeat = undefined;
  // ⚠️ 刻意**不**重置 `lastGuardTarget`：守卫「不能连续两晚守同一人」是跨夜约束
  emit(state, { t: 'night-fall', audience: 'public' });
}

function livingWolves(state: WerewolfState): number[] {
  return state.players.filter((p) => p.alive && isWolfRole(p.role)).map((p) => p.seat);
}

/** 本日**有投票权**且还活着的座位（白痴翻牌后仍在场但不投票） */
function eligibleVoters(state: WerewolfState): number[] {
  return state.players
    .filter((p) => p.alive && p.canVote !== false)
    .map((p) => p.seat)
    .sort((a, b) => a - b);
}

/** 存活的女巫 / 预言家 */
function livingRole(state: WerewolfState, role: WerewolfRole): WerewolfPlayer | undefined {
  return state.players.find((p) => p.alive && p.role === role);
}

/** 狼队投票完毕 → 结算出本夜刀口（多数决；平票 = 狼队没谈拢，空刀） */
function finalizeWolfTarget(state: WerewolfState): void {
  const votes = state.night.wolfVotes || {};
  const counts: Record<number, number> = {};
  for (const target of Object.values(votes)) {
    if (!target) continue;
    counts[target] = (counts[target] || 0) + 1;
  }
  const entries = Object.entries(counts).map(([seat, n]) => ({ seat: Number(seat), n }));
  let best: number[] = [];
  let max = 0;
  for (const e of entries) {
    if (e.n > max) {
      max = e.n;
      best = [e.seat];
    } else if (e.n === max) {
      best.push(e.seat);
    }
  }
  if (best.length === 1 && max > 0 && playerAt(state, best[0])?.alive) {
    state.night.wolfTarget = best[0];
    emit(state, { t: 'wolf-kill', audience: 'wolf', target: best[0] });
  } else {
    state.night.wolfTarget = undefined;
    emit(state, { t: 'wolf-consensus-fail', audience: 'wolf' });
  }
}

/** 夜晚结算：守卫 + 刀 + 毒 一起算，落死讯（真实死因不外泄） */
export function resolveNight(state: WerewolfState): void {
  const deaths: number[] = [];
  const poison = state.night.witchPoison;
  const victim = state.night.wolfTarget;
  const guarded = state.night.guardTarget;
  const healed = state.night.witchHeal === true;

  // 狼刀与「守卫 / 女巫」的交互（经典规则）：
  //  - 只被守 或 只被救 → 活下来
  //  - 被守**又**被救 → **同守同救死**（守救相冲，依然出局）
  //  - 都没管 → 出局
  if (victim != null) {
    const p = playerAt(state, victim);
    const wasGuarded = guarded === victim;
    const dies = wasGuarded === healed; // 同真（都被管）或同假（都没管）都死
    if (p && p.alive && dies) deaths.push(victim);
  }
  if (poison != null && !deaths.includes(poison)) {
    const p = playerAt(state, poison);
    if (p && p.alive) deaths.push(poison);
  }

  for (const seat of deaths) {
    const p = playerAt(state, seat);
    if (!p) continue;
    p.alive = false;
    if (p.role === 'hunter') {
      // 被毒杀不能开枪
      p.canShoot = seat !== poison;
      if (p.canShoot) state.pendingHunterSeat = seat;
    }
  }

  if (deaths.length === 0) {
    emit(state, { t: 'peaceful-night', audience: 'public' });
  } else {
    emit(state, { t: 'night-result', audience: 'public', count: deaths.length });
    for (const seat of deaths) emit(state, { t: 'death-announced', audience: 'public', seat });
  }

  // 交给 day-announce 继续（可能先插猎人开枪）
  state.phase = 'day-announce';
}

/** 女巫决策所需的私密简报（今晚死的是谁 / 还剩什么药） */
export function witchBriefing(state: WerewolfState, seat: number): {
  victim?: number;
  antidoteLeft: boolean;
  poisonLeft: boolean;
  canHeal: boolean;
} {
  const w = playerAt(state, seat);
  const victim = state.night.wolfTarget;
  return {
    victim,
    antidoteLeft: !w?.antidoteUsed,
    poisonLeft: !w?.poisonUsed,
    // 解药不能自救，也不能救一个没被刀的人
    canHeal: !!victim && victim !== seat && !w?.antidoteUsed,
  };
}

// ---------------------------------------------------------------------------
// 白天推进
// ---------------------------------------------------------------------------

/** 发言顺序：从 startAfterSeat 顺时针起（通常是被刀者的下一位），只含存活玩家 */
function buildSpeakOrder(state: WerewolfState, startAfterSeat?: number): number[] {
  const living = livingSeats(state);
  if (!living.length) return [];
  if (startAfterSeat == null) return living;
  const all = state.players.map((p) => p.seat).sort((a, b) => a - b);
  const startIdx = all.indexOf(startAfterSeat);
  if (startIdx < 0) return living;
  const order: number[] = [];
  for (let i = 1; i <= all.length; i++) {
    const s = all[(startIdx + i) % all.length];
    if (living.includes(s)) order.push(s);
  }
  return order;
}

/** 本夜死讯（用于决定发言起点） */
function nightDeathsOfThisRound(state: WerewolfState): number[] {
  return state.events
    .filter((e) => e.t === 'death-announced' && e.round === state.round)
    .map((e) => e.seat as number);
}

function startDay(state: WerewolfState): void {
  state.phase = 'day-speak';
  const deaths = nightDeathsOfThisRound(state);
  state.speakOrder = buildSpeakOrder(state, deaths[0]);
  state.speakIndex = 0;
  emit(state, { t: 'day-break', audience: 'public', count: state.speakOrder.length });
}

/** 投票统计（只计存活玩家的票，且只投存活目标；0 = 弃票） */
export function tallyVotes(state: WerewolfState): {
  counts: Record<number, number>;
  top: number[];
  abstain: number;
} {
  const counts: Record<number, number> = {};
  let abstain = 0;
  for (const p of state.players) {
    if (!p.alive) continue;
    if (p.canVote === false) continue; // 白痴翻牌后没有投票权
    const to = state.votes[p.seat];
    if (to == null) continue;
    if (!to) {
      abstain += 1;
      continue;
    }
    const t = playerAt(state, to);
    if (!t || !t.alive) continue;
    counts[to] = (counts[to] || 0) + 1;
  }
  let max = 0;
  for (const n of Object.values(counts)) if (n > max) max = n;
  const top = max > 0 ? Object.entries(counts).filter(([, n]) => n === max).map(([s]) => Number(s)) : [];
  return { counts, top, abstain };
}

/**
 * 把本轮所有已投出的票补写成**公开**事件。
 * 只在 `resolveVote()` 里调用——本轮投票在结算前对所有人保密（理由见 `applyVote` 的注释）。
 */
function emitVoteRecord(state: WerewolfState): void {
  for (const p of state.players) {
    const to = state.votes[p.seat];
    if (to == null || !to) continue; // 弃票不写事件（票型统计里仍算弃票）
    emit(state, { t: 'vote', audience: 'public', seat: p.seat, to });
  }
}

/**
 * 结算投票 → 放逐。
 *  - 唯一最高票 → 放逐；若被放逐者是**白痴且未翻牌** → 翻牌不死但失去投票权；
 *  - 平票 → 先给**一次 PK 加赛**（平票者发言后只能投他们），再加赛仍平票则无人出局（含全弃票）。
 */
export function resolveVote(state: WerewolfState): { exiled?: number; tie: boolean; pk?: boolean } {
  emitVoteRecord(state); // 到这一步才公开票型
  const { counts, top } = tallyVotes(state);

  if (top.length === 1) {
    const seat = top[0];
    const p = playerAt(state, seat);
    if (p && p.alive) {
      // 白痴：被票出局时翻牌，不死，但从此失去投票权
      if (p.role === 'idiot' && !p.idiotRevealed) {
        p.idiotRevealed = true;
        p.canVote = false;
        state.exiledSeat = undefined;
        state.pkSeats = undefined;
        emit(state, { t: 'vote-result', audience: 'public', target: seat, count: counts[seat] || 0 });
        emit(state, { t: 'idiot-revealed', audience: 'public', seat });
        state.phase = 'day-exile';
        return { tie: false };
      }
      p.alive = false;
      state.exiledSeat = seat;
      state.pkSeats = undefined;
      emit(state, { t: 'vote-result', audience: 'public', target: seat, count: counts[seat] || 0 });
      emit(state, { t: 'exile', audience: 'public', seat });
      if (p.role === 'hunter' && p.canShoot) state.pendingHunterSeat = seat;
      state.phase = 'day-exile';
      return { exiled: seat, tie: false };
    }
  }

  // 平票：先给一次 PK 加赛（仅一次，避免无限加赛）
  if (!state.pkUsed && top.length >= 2) {
    state.pkUsed = true;
    state.pkRound = (state.pkRound || 0) + 1;
    state.pkSeats = top.slice();
    state.votes = {};
    state.speakOrder = top.filter((s) => playerAt(state, s)?.alive);
    state.speakIndex = 0;
    emit(state, { t: 'pk-start', audience: 'public', count: top.length });
    state.phase = 'day-pk';
    return { tie: true, pk: true };
  }

  // 加赛仍平票（或全弃票）→ 无人出局
  state.exiledSeat = undefined;
  state.pkSeats = undefined;
  emit(state, { t: 'vote-tie', audience: 'public', count: top.length ? counts[top[0]] || 0 : 0 });
  state.phase = 'day-exile';
  return { tie: true };
}

/**
 * 某一轮模型失败 / 输出不可用：**不替角色编话**，只把这一轮记为「没能开口」并推进进度。
 *
 * 依据项目红线（见 `src/lib/fallbackBubbles.ts`）：失败兜底文案绝不能变成角色台词——
 * 一旦写进对局事件流，它会被当成「这个角色说过的话」显示、落盘，并回灌给其他玩家当上下文。
 * 所以这里**只发一个中性事件、不带任何台词**；对局该推进照样推进，不能因为模型抽风停住。
 */
export function applyFailedTurn(state: WerewolfState, seat: number): ApplyResult {
  const me = playerAt(state, seat);
  if (!me) return { ok: false, reason: 'no-such-seat' };
  emit(state, { t: 'turn-failed', audience: 'public', seat });
  // 发言 / PK 轮要推进进度
  if (state.phase === 'day-speak' || state.phase === 'day-pk') {
    if (state.speakOrder[state.speakIndex] === seat) state.speakIndex += 1;
  }
  // 遗言轮要标记「已处理」，否则会永远停在等遗言
  if (state.exiledSeat === seat) state.lastWordsSeat = seat;
  return { ok: true };
}

/**
 * 出局者遗言（规则上不影响胜负，但它是狼人杀的一部分体验） */
export function applyLastWords(state: WerewolfState, seat: number, text: string): void {
  const clean = String(text || '').trim();
  if (!clean) return;
  emit(state, { t: 'last-words', audience: 'public', seat, text: clean });
  state.lastWordsSeat = seat;
}

// ---------------------------------------------------------------------------
// 胜负
// ---------------------------------------------------------------------------

/** 判定当前是否已分胜负（不改变状态） */
export function checkWin(state: WerewolfState): Camp | undefined {
  const wolves = aliveWolfCount(state);
  const village = aliveVillageCount(state);
  if (wolves === 0) return 'village';
  if (wolves >= village) return 'wolf';
  return undefined;
}

export function endGame(state: WerewolfState, winner: Camp): void {
  state.status = 'ended';
  state.winner = winner;
  state.phase = 'ended';
  state.pendingSeat = undefined;
  state.pendingAction = undefined;
  emit(state, { t: 'game-end', audience: 'public', camp: winner });
}

/** 进入下一轮（回到夜晚）；超过轮数上限则判好人守住 */
function nextRound(state: WerewolfState): void {
  if (state.round >= MAX_ROUNDS) {
    endGame(state, 'village');
    return;
  }
  state.round += 1;
  beginNight(state);
}

// ---------------------------------------------------------------------------
// 系统推进：tickOnce / runSystemSteps
// ---------------------------------------------------------------------------

/**
 * 尝试推进一步「不需要外部输入」的状态转移。
 * @returns 是否真的推进了（false = 卡在等待输入，或已结束）
 */
export function tickOnce(state: WerewolfState): boolean {
  if (state.status === 'ended') return false;

  switch (state.phase) {
    case 'night-guard': {
      const guard = livingRole(state, 'guard');
      // 「无守卫」或「没有合法目标」（只剩自己且昨晚守过自己）都要能推进，否则夜会卡死
      const hasLegalTarget = state.players.some((p) => p.alive && p.seat !== state.lastGuardTarget);
      if (!guard || state.night.guardTarget != null || !hasLegalTarget) {
        state.phase = 'night-wolf';
        return true;
      }
      return false;
    }

    case 'night-wolf': {
      const wolves = livingWolves(state);
      if (wolves.length === 0) {
        state.phase = 'night-witch';
        return true;
      }
      const votes = state.night.wolfVotes || {};
      const allVoted = wolves.every((s) => {
        const to = votes[s];
        return to != null && !!playerAt(state, to)?.alive;
      });
      if (!allVoted) return false;
      finalizeWolfTarget(state);
      state.phase = 'night-witch';
      return true;
    }

    case 'night-witch': {
      const witch = livingRole(state, 'witch');
      if (!witch || state.witchDecided) {
        state.phase = 'night-seer';
        return true;
      }
      return false;
    }

    case 'night-seer': {
      const seer = livingRole(state, 'seer');
      if (!seer || state.night.seerTarget != null) {
        resolveNight(state);
        return true;
      }
      return false;
    }

    case 'day-announce': {
      // 猎人夜里被带走（非毒杀）→ 先让他开一枪再继续
      if (state.pendingHunterSeat != null) {
        state.returnPhase = 'day-announce';
        state.phase = 'hunter-shoot';
        return true;
      }
      const w = checkWin(state);
      if (w) {
        endGame(state, w);
        return true;
      }
      startDay(state);
      return true;
    }

    case 'day-speak': {
      // 跳过已出局/无效的发言位
      while (state.speakIndex < state.speakOrder.length) {
        const seat = state.speakOrder[state.speakIndex];
        const p = playerAt(state, seat);
        if (p && p.alive) return false; // 等这个人发言
        state.speakIndex += 1;
      }
      state.phase = 'day-vote';
      state.votes = {};
      return true;
    }

    case 'day-vote': {
      // ⚠️ 必须与 actorsNeeded 用同一套「有投票权的座位」，
      // 否则白痴翻牌后（活着但无票）会让这里永远等不到「全员已投」→ 卡死
      const voters = eligibleVoters(state);
      const allVoted = voters.every((s) => state.votes[s] != null);
      if (!allVoted) return false;
      resolveVote(state);
      return true;
    }

    case 'day-pk': {
      // PK 加赛发言：只有平票的候选位发言，发完直接重投（票只认 PK 上的两人）
      while (state.speakIndex < state.speakOrder.length) {
        const seat = state.speakOrder[state.speakIndex];
        const p = playerAt(state, seat);
        if (p && p.alive && p.canVote !== false) return false;
        state.speakIndex += 1;
      }
      state.phase = 'day-vote';
      state.votes = {};
      return true;
    }

    case 'day-exile': {
      if (state.pendingHunterSeat != null) {
        state.returnPhase = 'day-exile';
        state.phase = 'hunter-shoot';
        return true;
      }
      // 被放逐者的遗言：给完才继续（编排层负责问这一次）
      if (state.exiledSeat != null && state.lastWordsSeat !== state.exiledSeat) return false;
      const w = checkWin(state);
      if (w) {
        endGame(state, w);
        return true;
      }
      nextRound(state);
      return true;
    }

    case 'white-wolf-boom': {
      if (state.boomSeat != null) return false; // 等自爆者选带走谁
      const w = checkWin(state);
      if (w) {
        endGame(state, w);
        return true;
      }
      nextRound(state);
      return true;
    }

    case 'hunter-shoot': {
      if (state.pendingHunterSeat != null) return false; // 等开枪决定
      const back = state.returnPhase;
      const w = checkWin(state);
      if (w) {
        endGame(state, w);
        return true;
      }
      state.returnPhase = undefined;
      if (back === 'day-announce') {
        startDay(state);
        return true;
      }
      nextRound(state);
      return true;
    }

    case 'ended':
    default:
      return false;
  }
}

/** 连续推进，直到需要外部输入或已结束（guard 防死循环） */
export function runSystemSteps(state: WerewolfState, guard = 40): void {
  for (let i = 0; i < guard; i++) {
    if (!tickOnce(state)) return;
  }
}

// ---------------------------------------------------------------------------
// 需要谁行动
// ---------------------------------------------------------------------------

export interface ActorNeeded {
  seat: number;
  action: PendingAction;
}

/** 当前阶段还差谁的输入（编排层据此找 AI 发问 / 找真人等待） */
export function actorsNeeded(state: WerewolfState): ActorNeeded[] {
  if (state.status === 'ended') return [];
  const out: ActorNeeded[] = [];

  switch (state.phase) {
    case 'night-guard': {
      const guard = livingRole(state, 'guard');
      if (guard && state.night.guardTarget == null) out.push({ seat: guard.seat, action: 'guard' });
      return out;
    }
    case 'night-wolf': {
      const votes = state.night.wolfVotes || {};
      for (const seat of livingWolves(state)) {
        const to = votes[seat];
        if (to == null || !playerAt(state, to)?.alive) out.push({ seat, action: 'wolf-kill' });
      }
      return out;
    }
    case 'night-witch': {
      const witch = livingRole(state, 'witch');
      if (witch && !state.witchDecided) out.push({ seat: witch.seat, action: 'witch' });
      return out;
    }
    case 'night-seer': {
      const seer = livingRole(state, 'seer');
      if (seer && state.night.seerTarget == null) out.push({ seat: seer.seat, action: 'seer-check' });
      return out;
    }
    case 'day-speak':
    case 'day-pk': {
      const seat = state.speakOrder[state.speakIndex];
      const p = seat != null ? playerAt(state, seat) : undefined;
      // PK 台上已经翻牌的白痴仍可发言
      if (p && p.alive) out.push({ seat: p.seat, action: 'speak' });
      return out;
    }
    case 'day-vote': {
      for (const seat of eligibleVoters(state)) {
        if (state.votes[seat] == null) out.push({ seat, action: 'vote' });
      }
      return out;
    }
    case 'day-exile': {
      if (state.pendingHunterSeat != null) {
        out.push({ seat: state.pendingHunterSeat, action: 'hunter-shoot' });
      } else if (state.exiledSeat != null && state.lastWordsSeat !== state.exiledSeat) {
        out.push({ seat: state.exiledSeat, action: 'last-words' });
      }
      return out;
    }
    case 'white-wolf-boom': {
      if (state.boomSeat != null) out.push({ seat: state.boomSeat, action: 'boom' });
      return out;
    }
    case 'hunter-shoot': {
      if (state.pendingHunterSeat != null) out.push({ seat: state.pendingHunterSeat, action: 'hunter-shoot' });
      return out;
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// 写入玩家决策
// ---------------------------------------------------------------------------

export interface ApplyResult {
  ok: boolean;
  reason?: string;
}

/**
 * 守卫守人（夜里第一步）。规则：可以守自己；**不能连续两晚守同一人**。
 * 与女巫解药同时作用于同一人时触发「同守同救死」（见 `resolveNight`）。
 */
export function applyGuard(state: WerewolfState, seat: number, target: number): ApplyResult {
  if (state.phase !== 'night-guard') return { ok: false, reason: 'not-night' };
  const me = playerAt(state, seat);
  if (!me || !me.alive || me.role !== 'guard') return { ok: false, reason: 'not-guard' };
  if (state.night.guardTarget != null) return { ok: false, reason: 'already-acted' };
  const t = playerAt(state, target);
  if (!t || !t.alive) return { ok: false, reason: 'bad-target' };
  if (state.lastGuardTarget === target) return { ok: false, reason: 'cannot-guard-twice' };
  state.night.guardTarget = target;
  state.lastGuardTarget = target;
  emit(state, { t: 'guard-protect', audience: seat, target });
  return { ok: true };
}

/**
 * 白狼王自爆（只能在自己白天的发言回合做）。
 * 自爆立即出局，随后进入 `white-wolf-boom` 等它选带走谁，然后**当天直接结束入夜**。
 */
export function applyBoom(state: WerewolfState, seat: number): ApplyResult {
  if (state.phase !== 'day-speak') return { ok: false, reason: 'not-day-speak' };
  const me = playerAt(state, seat);
  if (!me || !me.alive || me.role !== 'whiteWolfKing' || me.boomed) {
    return { ok: false, reason: 'not-white-wolf-king' };
  }
  const current = state.speakOrder[state.speakIndex];
  if (current !== seat) return { ok: false, reason: 'not-your-turn' };
  me.alive = false;
  me.boomed = true;
  state.boomSeat = seat;
  state.phase = 'white-wolf-boom';
  emit(state, { t: 'white-wolf-boom', audience: 'public', seat });
  return { ok: true };
}

/** 自爆带走谁（target = null 表示谁都不带） */
export function applyBoomTarget(state: WerewolfState, seat: number, target: number | null): ApplyResult {
  if (state.phase !== 'white-wolf-boom' || state.boomSeat !== seat) {
    return { ok: false, reason: 'not-booming' };
  }
  if (target != null) {
    const t = playerAt(state, target);
    if (!t || !t.alive) return { ok: false, reason: 'bad-target' };
    t.alive = false;
    emit(state, { t: 'death-announced', audience: 'public', seat: target });
    if (t.role === 'hunter' && t.canShoot) state.pendingHunterSeat = target;
  }
  state.boomSeat = undefined;
  // 自爆后当天直接结束：交给 day-exile 的推进逻辑（它只做「猎人开枪 → 判胜负 → 入夜」）
  state.exiledSeat = undefined;
  state.phase = 'day-exile';
  return { ok: true };
}

/** 狼人刀人（可以自刀；只记票，不立刻生效） */
export function applyWolfVote(state: WerewolfState, seat: number, target: number): ApplyResult {
  if (state.phase !== 'night-wolf') return { ok: false, reason: 'not-night' };
  const me = playerAt(state, seat);
  if (!me || !me.alive || !isWolfRole(me.role)) return { ok: false, reason: 'not-wolf' };
  const t = playerAt(state, target);
  if (!t || !t.alive) return { ok: false, reason: 'bad-target' };
  state.night.wolfVotes = state.night.wolfVotes || {};
  state.night.wolfVotes[seat] = target;
  return { ok: true };
}

/** 预言家验人（结果只写给预言家本人） */
export function applySeerCheck(state: WerewolfState, seat: number, target: number): ApplyResult & { camp?: Camp } {
  if (state.phase !== 'night-seer') return { ok: false, reason: 'not-night' };
  const me = playerAt(state, seat);
  if (!me || !me.alive || me.role !== 'seer') return { ok: false, reason: 'not-seer' };
  if (target === seat) return { ok: false, reason: 'cannot-check-self' };
  const t = playerAt(state, target);
  if (!t || !t.alive) return { ok: false, reason: 'bad-target' };
  const camp: Camp = isWolfRole(t.role) ? 'wolf' : 'village';
  state.night.seerTarget = target;
  state.night.seerCamp = camp;
  emit(state, { t: 'seer-check', audience: seat, target, camp });
  return { ok: true, camp };
}

/** 女巫用药：一晚只能用一瓶；解药不能自救 */
export function applyWitchAction(
  state: WerewolfState,
  seat: number,
  action: { heal?: boolean; poison?: number | null } = {},
): ApplyResult {
  if (state.phase !== 'night-witch') return { ok: false, reason: 'not-night' };
  const me = playerAt(state, seat);
  if (!me || !me.alive || me.role !== 'witch') return { ok: false, reason: 'not-witch' };
  if (state.witchDecided) return { ok: false, reason: 'already-decided' };

  const heal = action.heal === true;
  const poison = action.poison == null ? null : Number(action.poison);
  if (heal && poison != null) return { ok: false, reason: 'one-potion-per-night' };

  if (heal) {
    if (me.antidoteUsed) return { ok: false, reason: 'no-antidote' };
    const victim = state.night.wolfTarget;
    if (victim == null) return { ok: false, reason: 'nobody-to-save' };
    if (victim === seat) return { ok: false, reason: 'cannot-heal-self' };
    state.night.witchHeal = true;
    me.antidoteUsed = true;
    emit(state, { t: 'witch-heal', audience: seat, target: victim });
  }

  if (poison != null) {
    if (me.poisonUsed) return { ok: false, reason: 'no-poison' };
    if (poison === seat) return { ok: false, reason: 'cannot-poison-self' };
    const t = playerAt(state, poison);
    if (!t || !t.alive) return { ok: false, reason: 'bad-target' };
    state.night.witchPoison = poison;
    me.poisonUsed = true;
    emit(state, { t: 'witch-poison', audience: seat, target: poison });
  }

  state.witchDecided = true;
  return { ok: true };
}

/** 女巫决定不用药（等同一次合法决定，防止卡在夜里） */
export function skipWitch(state: WerewolfState, seat: number): ApplyResult {
  const me = playerAt(state, seat);
  if (!me || !me.alive || me.role !== 'witch') return { ok: false, reason: 'not-witch' };
  state.witchDecided = true;
  return { ok: true };
}

/** 发言（白天顺序发言 / 猎人遗言等） */
export function applySpeech(state: WerewolfState, seat: number, text: string): ApplyResult {
  const clean = String(text || '').trim();
  if (!clean) return { ok: false, reason: 'empty' };
  const me = playerAt(state, seat);
  if (!me) return { ok: false, reason: 'no-such-seat' };

  if (state.phase === 'day-speak' || state.phase === 'day-pk') {
    // PK 加赛也是「依次发言」，同样要推进进度（否则会永远停在 PK）
    const expected = state.speakOrder[state.speakIndex];
    if (expected !== seat) return { ok: false, reason: 'not-your-turn' };
    emit(state, { t: 'speech', audience: 'public', seat, text: clean });
    state.speakIndex += 1;
    return { ok: true };
  }
  // 非发言阶段（遗言等）也允许追加，但不推进发言进度
  emit(state, { t: 'speech', audience: 'public', seat, text: clean });
  return { ok: true };
}

/** 投票（不能投自己；0 = 弃票） */
export function applyVote(state: WerewolfState, seat: number, target: number): ApplyResult {
  if (state.phase !== 'day-vote') return { ok: false, reason: 'not-vote-time' };
  const me = playerAt(state, seat);
  if (!me || !me.alive) return { ok: false, reason: 'not-alive' };
  if (me.canVote === false) return { ok: false, reason: 'no-vote-right' };
  const to = Number(target) || 0;
  if (to === seat) return { ok: false, reason: 'cannot-vote-self' };
  // PK 加赛期间只能投 PK 台上的候选位（弃票仍允许）
  if (to !== 0 && state.pkSeats?.length && !state.pkSeats.includes(to)) {
    return { ok: false, reason: 'pk-only' };
  }
  if (to !== 0) {
    const t = playerAt(state, to);
    if (!t || !t.alive) return { ok: false, reason: 'bad-target' };
  }
  state.votes[seat] = to;
  // ⚠️ 刻意**不**在这里写公开事件：本轮投票在结算前对所有人保密。
  // 否则后投的人（尤其是 AI）会看到先投的人投了谁 —— 真人先投、AI 后投，
  // AI 就能跟票，既泄漏信息又改变对局手感。公开记录统一由 resolveVote() 的 emitVoteRecord() 补写。
  return { ok: true };
}

/** 弃票（放弃投票 = 一种合法选择） */
export function abstain(state: WerewolfState, seat: number): ApplyResult {
  return applyVote(state, seat, 0);
}

/** 猎人开枪：target = null 表示放弃开枪 */
export function applyHunterShoot(state: WerewolfState, seat: number, target: number | null): ApplyResult {
  if (state.pendingHunterSeat !== seat) return { ok: false, reason: 'not-hunter-turn' };
  const me = playerAt(state, seat);
  if (!me || me.role !== 'hunter' || me.alive) return { ok: false, reason: 'not-dead-hunter' };

  if (target == null) {
    me.canShoot = false;
    state.pendingHunterSeat = undefined;
    emit(state, { t: 'hunter-no-shoot', audience: 'public', seat });
    return { ok: true };
  }

  const t = playerAt(state, target);
  if (!t || !t.alive) return { ok: false, reason: 'bad-target' };
  t.alive = false;
  me.canShoot = false;
  state.pendingHunterSeat = undefined;
  emit(state, { t: 'hunter-shoot', audience: 'public', seat, target });

  // 被带走的也可能是猎人（连环枪：只有被刀/被放逐才保留开枪权）
  if (t.role === 'hunter' && t.canShoot) {
    state.pendingHunterSeat = t.seat;
    state.returnPhase = state.returnPhase ?? 'day-exile';
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 便捷查询（编排层与前端都要用）
// ---------------------------------------------------------------------------

/** 当前是否轮到这个座位做点什么 */
export function isSeatPending(state: WerewolfState, seat: number): boolean {
  return actorsNeeded(state).some((a) => a.seat === seat);
}

/** 当前待办里属于该座位的动作 */
export function pendingActionFor(state: WerewolfState, seat: number): PendingAction | undefined {
  return actorsNeeded(state).find((a) => a.seat === seat)?.action;
}

/** 存活玩家（按座位） */
export function livingPlayers(state: WerewolfState): WerewolfPlayer[] {
  return state.players.filter((p) => p.alive).sort((a, b) => a.seat - b.seat);
}

export type { NightState, Phase };
