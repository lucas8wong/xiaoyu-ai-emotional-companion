/**
 * AI 狼人杀 · 视角过滤（防作弊的唯一出口）
 *
 * **所有**下发到前端的对局数据都必须经过 `viewFor()`。任何地方直接返回 `WerewolfState`
 * 都会把狼人底牌、预言家验人结果泄漏给真人玩家，这是本玩法最严重的一类缺陷，
 * 因此这里有专门的单测（`test/unit/werewolf.test.ts`）断言「村民视角拿不到狼人身份」。
 */

import type {
  Camp,
  GameEvent,
  GameSize,
  PendingAction,
  Phase,
  WerewolfRole,
  WerewolfState,
} from './types.js';
import { isWolfRole, livingSeats, MAX_ROUNDS, playerAt, roleCamp, wolfSeats } from './types.js';

/** 下发给前端的玩家条目（只有该知道的字段才会出现） */
export interface ViewPlayer {
  seat: number;
  name: string;
  avatar?: string;
  alive: boolean;
  /** 是否为本人 */
  isYou: boolean;
  /** AI 还是真人（前端给个「AI」角标用） */
  kind: 'human' | 'ai';
  /** 内置陪玩角色（前端可标注「默认陪玩」） */
  builtin?: boolean;
  /** 身份：仅当「本人 / 狼队友 / 局终复盘」时才出现 */
  role?: WerewolfRole;
  /** 所属阵营：与 role 同步出现 */
  camp?: Camp;
}

/** 下发前端的对局视图 */
export interface WerewolfView {
  id: string;
  size: GameSize;
  round: number;
  maxRounds: number;
  phase: Phase;
  status: 'playing' | 'ended';
  winner?: Camp;
  /** 本人的座位号 */
  humanSeat: number;
  /** 本人是否已出局（出局后进入旁观） */
  youAlive: boolean;
  players: ViewPlayer[];
  /** 已按视角过滤过的事件流 */
  events: GameEvent[];
  /** 当前等待的动作与座位（人类玩家据此显示操作按钮） */
  pendingAction?: PendingAction;
  pendingSeat?: number;
  /** 是否轮到本人操作 */
  isMyTurn: boolean;
  myRole: WerewolfRole;
  myCamp: Camp;
  /** 狼队友座位（仅狼人可见） */
  wolfTeammates?: number[];
  /** 预言家已知的查验结果（仅预言家本人可见） */
  seerChecks?: Array<{ seat: number; camp: Camp; round: number }>;
  /** 女巫药水剩余（仅女巫本人可见） */
  witch?: { antidoteLeft: boolean; poisonLeft: boolean };
  /** 猎人是否仍握有开枪权（仅猎人本人可见） */
  canShoot?: boolean;
  /** 本日发言顺序与进度（公开） */
  speakOrder: number[];
  speakIndex: number;
  /** 已投出的票（公开亮票） */
  votes: Array<{ from: number; to: number }>;
  /** 存活座位 */
  living: number[];
}

/**
 * 该事件是否对某座位可见。
 *  - public：所有人
 *  - wolf：仅狼人阵营
 *  - number：仅该座位本人
 */
export function canSeeEvent(e: GameEvent, seat: number, state: WerewolfState): boolean {
  if (e.audience === 'public') return true;
  if (e.audience === 'wolf') {
    const me = playerAt(state, seat);
    return !!me && isWolfRole(me.role);
  }
  return e.audience === seat;
}

/**
 * 生成某座位的对局视图。
 *
 * @param opts.spectatorReveal 出局者是否进入「旁观者全见」。
 *   单人局（场上全是 AI）默认开启：用户出局后还能把这一局看完，体验更好、也不存在串通。
 *   **一旦场上出现第二个真人，必须传 false**，出局者只能看公开信息，否则等于把底牌告诉活人。
 */
export function viewFor(
  state: WerewolfState,
  seat: number,
  opts: { spectatorReveal?: boolean } = {},
): WerewolfView {
  const me = playerAt(state, seat);
  if (!me) throw new Error(`seat ${seat} not found`);
  /**
   * 默认值按「场上有几个真人」决定（2026-09-29 审查 A7-P3-5）。
   * 单人局（只有 1 个真人）→ 出局后允许旁观全见：体验更好，也不存在串通。
   * **一旦出现第 2 个真人 → 必须关闭**，否则等于把底牌直接告诉还活着的那个真人。
   * 此前这里恒为 true（`!== false`），而线上调用方（api/services/werewolf.ts）都不传 opts
   * → 多人局一直在泄漏底牌，与函数上方自己的注释互相矛盾。
   */
  const humanCount = state.players.filter((p) => p.kind === 'human').length;
  const spectatorReveal = opts.spectatorReveal !== undefined ? opts.spectatorReveal : humanCount <= 1;
  const ended = state.status === 'ended';
  /** 出局旁观（单人局）或局终复盘时，亮出全部底牌 */
  const revealAll = ended || (spectatorReveal && !me.alive);
  const iAmWolf = isWolfRole(me.role);
  const teammates = iAmWolf ? wolfSeats(state).filter((s) => s !== seat) : [];

  const players: ViewPlayer[] = state.players
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((p) => {
      const row: ViewPlayer = {
        seat: p.seat,
        name: p.name,
        avatar: p.avatar,
        alive: p.alive,
        isYou: p.seat === seat,
        kind: p.kind,
        builtin: p.builtin,
      };
      // 身份只会在这三种情况出现：本人、狼队友、亮牌（局终/旁观）
      if (revealAll || p.seat === seat || (iAmWolf && isWolfRole(p.role))) {
        row.role = p.role;
        row.camp = roleCamp(p.role);
      }
      return row;
    });

  const events = state.events.filter((e) => revealAll || canSeeEvent(e, seat, state));

  const view: WerewolfView = {
    id: state.id,
    size: state.size,
    round: state.round,
    maxRounds: MAX_ROUNDS,
    phase: state.phase,
    status: state.status,
    winner: state.winner,
    humanSeat: seat,
    youAlive: me.alive,
    players,
    events,
    pendingAction: state.pendingAction,
    pendingSeat: state.pendingSeat,
    isMyTurn: state.status === 'playing' && state.pendingSeat === seat,
    myRole: me.role,
    myCamp: roleCamp(me.role),
    speakOrder: state.speakOrder.slice(),
    speakIndex: state.speakIndex,
    // 未结算的本轮投票**不下发**（结算前保密，结算后才由 resolveVote 写成公开事件）
    votes: state.phase === 'day-vote' ? [] : Object.entries(state.votes).map(([from, to]) => ({ from: Number(from), to })),
    living: livingSeats(state),
  };

  if (iAmWolf) view.wolfTeammates = teammates;

  if (me.role === 'seer') {
    view.seerChecks = state.events
      .filter((e) => e.t === 'seer-check' && e.audience === seat)
      .map((e) => ({ seat: e.target as number, camp: e.camp as Camp, round: e.round }));
  }

  if (me.role === 'witch') {
    view.witch = { antidoteLeft: !me.antidoteUsed, poisonLeft: !me.poisonUsed };
  }

  // 猎人：`canShoot` 表示开枪权是否还在（被毒杀时引擎会置 false）
  if (me.role === 'hunter') view.canShoot = me.canShoot !== false;

  return view;
}

/**
 * 「每一局开场都要给每个 AI 玩家一份它自己视角的视图」，服务端编排用。
 * 与 `viewFor` 同源，保证 AI 与真人看到的世界规则一致（不可能出现「AI 偷看」）。
 */
export function viewForAi(state: WerewolfState, seat: number): WerewolfView {
  return viewFor(state, seat, { spectatorReveal: false });
}
