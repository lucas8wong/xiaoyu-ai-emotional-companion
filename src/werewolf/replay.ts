/**
 * AI 狼人杀 · 复盘卡数据（纯函数，便于单测）
 *
 * 局终后服务端会**亮出全部底牌与全部事件**（`viewFor` 在 `status === 'ended'` 时 revealAll），
 * 所以这里能把「**这局谁在骗你**」还原出来——包括此前只对狼人 / 预言家 / 女巫可见的夜间动作。
 *
 * 两条设计约束：
 *  1. **不拼文案**：只产出结构化事实，三语由组件用 `wwT` 渲染（与服务端事件同一套哲学）。
 *  2. **不越过视角**：本函数只读 `view`，所以局中途调用时它天然算不出狼人名单
 *     （因为 view 里没有别人的底牌）——有单测钉住这一点，防止「复盘卡变成提前开天眼」。
 */

import type { GameEvent } from './engine/types';
import type { WerewolfView } from './engine/view';

export interface ReplayPerson {
  seat: number;
  name: string;
  role: string;
}

/** 夜里的真相（局终才可见） */
export interface ReplayTruth {
  kind: 'wolfKill' | 'seerCheck' | 'witchHeal' | 'witchPoison';
  round: number;
  /** 被作用的人 */
  seat: number;
  name: string;
  role: string;
  /** 预言家验出的阵营 */
  camp?: 'wolf' | 'village';
}

/** 谁怎么出局的 */
export interface ReplayDeath {
  round: number;
  seat: number;
  name: string;
  role: string;
  by: 'night' | 'vote' | 'hunter';
}

export interface ReplayData {
  winner?: 'wolf' | 'village';
  iWon: boolean;
  myRole: string;
  myCamp: 'wolf' | 'village';
  /** 骗你的人（全部狼人；你自己是狼时语义变成「跟你一起骗人的同伙」） */
  liars: ReplayPerson[];
  /** 你自己是不是狼（组件据此换文案口径） */
  iAmWolf: boolean;
  /** 把你票出去的人（你是被投票放逐时才有） */
  votedMeOut: Array<{ seat: number; name: string }>;
  deaths: ReplayDeath[];
  truths: ReplayTruth[];
  /** 一句话钩子（三语在组件里取） */
  headlineKey: 'replayHeadlineWolfWin' | 'replayHeadlineVillageWin';
}

/**
 * 从「局终视图」构建复盘数据。
 * 传入局中途的视图也可以调用，但不会泄漏——它只能看到 view 里已有的东西。
 */
export function buildReplay(view: WerewolfView): ReplayData {
  const playerOf = (seat?: number) => view.players.find((p) => p.seat === seat);
  const nameOf = (seat?: number) => playerOf(seat)?.name ?? '';
  const roleOf = (seat?: number) => playerOf(seat)?.role ?? '';

  const iAmWolf = view.myCamp === 'wolf';

  // 骗你的人 = 全部狼人阵营（含白狼王！——不能只判断 role === 'werewolf'）
  const liars: ReplayPerson[] = view.players
    .filter((p) => p.camp === 'wolf' && !p.isYou)
    .map((p) => ({ seat: p.seat, name: p.name, role: p.role as string }));

  const deaths: ReplayDeath[] = [];
  const seenDeath = new Set<number>();
  const pushDeath = (e: GameEvent, seat: number | undefined, by: ReplayDeath['by']) => {
    if (seat == null || seenDeath.has(seat)) return;
    seenDeath.add(seat);
    deaths.push({ round: e.round, seat, name: nameOf(seat), role: roleOf(seat), by });
  };

  const truths: ReplayTruth[] = [];
  for (const e of view.events) {
    switch (e.t) {
      case 'death-announced':
        pushDeath(e, e.seat, 'night');
        break;
      case 'exile':
        pushDeath(e, e.seat, 'vote');
        break;
      case 'hunter-shoot':
        pushDeath(e, e.target, 'hunter');
        break;
      case 'wolf-kill':
        if (e.target != null) {
          truths.push({ kind: 'wolfKill', round: e.round, seat: e.target, name: nameOf(e.target), role: roleOf(e.target) });
        }
        break;
      case 'seer-check':
        if (e.target != null) {
          truths.push({
            kind: 'seerCheck',
            round: e.round,
            seat: e.target,
            name: nameOf(e.target),
            role: roleOf(e.target),
            camp: e.camp,
          });
        }
        break;
      case 'witch-heal':
        if (e.target != null) {
          truths.push({ kind: 'witchHeal', round: e.round, seat: e.target, name: nameOf(e.target), role: roleOf(e.target) });
        }
        break;
      case 'witch-poison':
        if (e.target != null) {
          truths.push({ kind: 'witchPoison', round: e.round, seat: e.target, name: nameOf(e.target), role: roleOf(e.target) });
        }
        break;
      default:
        break;
    }
  }

  const votedMeOut = view.events
    .filter((e) => e.t === 'vote' && e.to === view.humanSeat && e.seat != null)
    .map((e) => ({ seat: e.seat as number, name: nameOf(e.seat) }));

  return {
    winner: view.winner,
    iWon: !!view.winner && view.winner === view.myCamp,
    myRole: view.myRole,
    myCamp: view.myCamp,
    iAmWolf,
    liars,
    votedMeOut,
    deaths,
    // 真相按时间倒序取最近几条即可（卡面不需要全量）
    truths: truths.slice(-6),
    headlineKey: view.winner === 'wolf' ? 'replayHeadlineWolfWin' : 'replayHeadlineVillageWin',
  };
}

/**
 * 复盘卡要展示的「你的角色们」——把局内角色与它们的身份对上，
 * 供卡面显示「谁陪你玩了、它是什么身份」。
 */
export function replayCast(view: WerewolfView): ReplayPerson[] {
  return view.players
    .filter((p) => !p.isYou)
    .map((p) => ({ seat: p.seat, name: p.name, role: p.role || 'unknown' }));
}
