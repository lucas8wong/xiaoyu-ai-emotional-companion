/**
 * AI 狼人杀 · 规则引擎单测
 *
 * 重点不是「跑通」，而是把三类最要命的缺陷钉死：
 *  1. **视角泄漏**：村民/AI 的视图里绝不能出现狼人身份、狼刀、别人的验人结果。
 *  2. **胜负与技能边界**：平票不出局、女巫一晚一瓶药且不能自救、猎人被毒杀不能开枪。
 *  3. **状态机不死循环**：整局自动推进必须真的结束（这是编排层「等不到输入就卡死」的防线）。
 */

import { test } from 'node:test';
import assert from 'node:assert';

import type { SeatInput, WerewolfRole, WerewolfState } from '../../src/werewolf/engine/types.js';
import {
  ROSTERS,
  GAME_SIZES,
  aliveVillageCount,
  aliveWolfCount,
  isWolfRole,
  livingSeats,
  playerAt,
} from '../../src/werewolf/engine/types.js';
import {
  abstain,
  actorsNeeded,
  applyBoom as _applyBoom,
  applyBoomTarget,
  applyGuard,
  applyHunterShoot,
  applyLastWords,
  applySeerCheck,
  applySpeech,
  applyVote,
  applyWitchAction,
  applyWolfVote,
  buildRoleDeck,
  checkWin,
  createGame,
  runSystemSteps,
  skipWitch,
  tallyVotes,
  witchBriefing,
} from '../../src/werewolf/engine/rules.js';
import { canSeeEvent, viewFor, viewForAi } from '../../src/werewolf/engine/view.js';
import { buildReplay } from '../../src/werewolf/replay.js';
import { buildAgentMessages } from '../../src/werewolf/ai/prompt.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function makeSeats(n: number, humanSeat = 1): SeatInput[] {
  const out: SeatInput[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(
      i === humanSeat
        ? { id: 'user', kind: 'human', name: '你' }
        : { id: `ai:builtin:p${i}`, kind: 'ai', name: `陪玩${i}`, builtin: true },
    );
  }
  return out;
}

function newGame(size: 6 | 9 | 12 = 9, seed = 20260915, humanSeat = 1): WerewolfState {
  return createGame({
    id: `g-${size}-${seed}`,
    userId: 'u1',
    size,
    seats: makeSeats(size, humanSeat),
    seed,
  });
}

/** 强制指定身份（用于精确测某条技能规则，不依赖洗牌结果） */
function forceRoles(state: WerewolfState, map: Record<number, WerewolfRole>): void {
  for (const [seat, role] of Object.entries(map)) {
    const p = playerAt(state, Number(seat));
    if (!p) throw new Error(`no seat ${seat}`);
    p.role = role;
    if (role === 'witch') {
      p.antidoteUsed = false;
      p.poisonUsed = false;
    }
    if (role === 'hunter') p.canShoot = true;
  }
}

function seatOfRole(state: WerewolfState, role: WerewolfRole): number {
  const p = state.players.find((x) => x.role === role);
  if (!p) throw new Error(`no ${role} in this game`);
  return p.seat;
}

/** 确定性「假 AI」驱动：把一整局打完，返回步数 */
function autoPlay(state: WerewolfState, maxSteps = 4000): number {
  for (let i = 0; i < maxSteps; i++) {
    runSystemSteps(state);
    if (state.status === 'ended') return i;

    const actors = actorsNeeded(state);
    if (!actors.length) {
      throw new Error(`状态机卡死：phase=${state.phase} 无人可动但也没结束`);
    }

    for (const a of actors) {
      switch (a.action) {
        case 'wolf-kill': {
          const targets = state.players.filter((p) => p.alive && p.seat !== a.seat);
          const target = targets[0] ?? state.players.find((p) => p.alive);
          assert.ok(target, '夜里没有可刀的人');
          const r = applyWolfVote(state, a.seat, target.seat);
          assert.ok(r.ok, `wolf-kill 失败：${r.reason}`);
          break;
        }
        case 'seer-check': {
          const t = state.players.find((p) => p.alive && p.seat !== a.seat);
          if (!t) throw new Error('没有可验的人');
          const r = applySeerCheck(state, a.seat, t.seat);
          assert.ok(r.ok, `seer-check 失败：${r.reason}`);
          break;
        }
        case 'witch': {
          const b = witchBriefing(state, a.seat);
          // 能救就救，救不了就明确「不用药」，不表态会卡死
          const r = b.canHeal ? applyWitchAction(state, a.seat, { heal: true }) : skipWitch(state, a.seat);
          assert.ok(r.ok, `witch 失败：${r.reason}`);
          break;
        }
        case 'speak': {
          const r = applySpeech(state, a.seat, `${a.seat}号发言：我先说，我是好人。`);
          assert.ok(r.ok, `speak 失败：${r.reason}`);
          break;
        }
        case 'vote': {
          // PK 加赛期间只能投 PK 台上的候选位
          const pool = state.pkSeats?.length
            ? state.players.filter((p) => p.alive && state.pkSeats!.includes(p.seat) && p.seat !== a.seat)
            : state.players.filter((p) => p.alive && p.seat !== a.seat);
          const r = applyVote(state, a.seat, pool[0] ? pool[0].seat : 0);
          assert.ok(r.ok, `vote 失败：${r.reason}`);
          break;
        }
        case 'hunter-shoot': {
          const r = applyHunterShoot(state, a.seat, null); // 一律放弃开枪，便于收敛
          assert.ok(r.ok, `hunter-shoot 失败：${r.reason}`);
          break;
        }
        case 'guard': {
          // 避开「昨晚守过的人」（规则不允许连守）
          const t = state.players.find((p) => p.alive && p.seat !== state.lastGuardTarget);
          if (!t) throw new Error('守卫没有合法目标');
          const r = applyGuard(state, a.seat, t.seat);
          assert.ok(r.ok, `guard 失败：${r.reason}`);
          break;
        }
        case 'last-words': {
          applyLastWords(state, a.seat, `${a.seat}号遗言：我先走了，剩下的靠你们。`);
          break;
        }
        case 'boom': {
          const r = applyBoomTarget(state, a.seat, null); // 不带人，便于收敛
          assert.ok(r.ok, `boom 失败：${r.reason}`);
          break;
        }
        default:
          throw new Error(`未知动作 ${a.action}`);
      }
    }
  }
  throw new Error(`一局在 ${maxSteps} 步内没打完（round=${state.round} phase=${state.phase}）`);
}

// ---------------------------------------------------------------------------
// 1. 身份配置与洗牌
// ---------------------------------------------------------------------------

test('各局型的身份牌堆数量与配比表一致', () => {
  for (const size of GAME_SIZES) {
    const deck = buildRoleDeck(size);
    assert.strictEqual(deck.length, size, `${size} 人局牌数不对`);
    const roster = ROSTERS[size];
    for (const role of Object.keys(roster) as WerewolfRole[]) {
      const n = deck.filter((r) => r === role).length;
      assert.strictEqual(n, roster[role], `${size} 人局 ${role} 数量不对`);
    }
  }
});

test('同一 seed 生成同一份身份（可复现，便于复盘与排障）', () => {
  const a = newGame(9, 42);
  const b = newGame(9, 42);
  const c = newGame(9, 43);
  const rolesOf = (s: WerewolfState) => s.players.map((p) => p.role).join(',');
  assert.strictEqual(rolesOf(a), rolesOf(b));
  assert.notStrictEqual(rolesOf(a), rolesOf(c));
});

test('座位数与局型不符直接拒绝（防越界）', () => {
  assert.throws(
    () => createGame({ id: 'x', userId: 'u', size: 9, seats: makeSeats(6) }),
    /seats length/,
  );
});

// ---------------------------------------------------------------------------
// 2. 视角隔离（本玩法最严重的一类缺陷）
// ---------------------------------------------------------------------------

test('村民视角：拿不到任何别人的身份，也拿不到狼刀与验人结果', () => {
  const state = newGame(9, 777);
  const villager = state.players.find((p) => p.role === 'villager');
  assert.ok(villager, '这一局没有平民，换个 seed');

  // 推进到夜晚有动作之后，制造出「狼刀 + 验人」这些私密事件
  applyWolfVote(state, seatOfRole(state, 'werewolf'), seatOfRole(state, 'villager'));
  state.phase = 'night-seer';
  applySeerCheck(state, seatOfRole(state, 'seer'), seatOfRole(state, 'werewolf'));

  const view = viewFor(state, villager!.seat, { spectatorReveal: false });

  // 只有自己那一行有身份
  for (const p of view.players) {
    if (p.seat === villager!.seat) assert.strictEqual(p.role, 'villager');
    else assert.strictEqual(p.role, undefined, `${p.seat} 号的身份泄漏给了平民`);
  }

  // 私密事件一条都不该出现
  assert.ok(!view.events.some((e) => e.t === 'wolf-kill'), '狼刀泄漏');
  assert.ok(!view.events.some((e) => e.t === 'wolf-teammates'), '狼队互认泄漏');
  assert.ok(!view.events.some((e) => e.t === 'seer-check'), '验人结果泄漏');
  assert.ok(!view.events.some((e) => e.t === 'role-assigned' && e.seat !== villager!.seat), '他人身份事件泄漏');
  assert.strictEqual(view.wolfTeammates, undefined);
  assert.strictEqual(view.seerChecks, undefined);
});

test('村民视角的整个 JSON 里不含 "werewolf" 字样（序列化层也不漏）', () => {
  const state = newGame(9, 778);
  const villager = state.players.find((p) => p.role === 'villager');
  assert.ok(villager);
  const json = JSON.stringify(viewFor(state, villager!.seat, { spectatorReveal: false }));
  assert.ok(!json.includes('werewolf'), '视图 JSON 里出现了狼人身份');
});

test('狼人视角：看得到队友，看不到预言家的查验结果', () => {
  const state = newGame(9, 779);
  const wolf = state.players.find((p) => isWolfRole(p.role));
  assert.ok(wolf);
  state.phase = 'night-seer';
  applySeerCheck(state, seatOfRole(state, 'seer'), seatOfRole(state, 'werewolf'));

  const view = viewFor(state, wolf!.seat, { spectatorReveal: false });
  assert.ok(view.wolfTeammates, '狼人应该看得到队友');
  assert.strictEqual(view.wolfTeammates!.length, ROSTERS[9].werewolf - 1);
  for (const s of view.wolfTeammates!) {
    assert.ok(isWolfRole(playerAt(state, s)!.role));
    assert.strictEqual(view.players.find((p) => p.seat === s)?.role, 'werewolf', '队友身份必须可见');
  }
  // 好人身份仍然不可见
  const villagerSeat = seatOfRole(state, 'villager');
  assert.strictEqual(view.players.find((p) => p.seat === villagerSeat)?.role, undefined);
  assert.strictEqual(view.seerChecks, undefined, '狼人不该看到预言家的验人');
});

test('预言家视角：只拿到自己的查验结果；女巫视角：只拿到自己的药水', () => {
  const state = newGame(9, 780);
  const seerSeat = seatOfRole(state, 'seer');
  const witchSeat = seatOfRole(state, 'witch');
  const wolfSeat = seatOfRole(state, 'werewolf');
  state.phase = 'night-seer';
  applySeerCheck(state, seerSeat, wolfSeat);

  const seerView = viewFor(state, seerSeat, { spectatorReveal: false });
  assert.deepStrictEqual(seerView.seerChecks, [{ seat: wolfSeat, camp: 'wolf', round: 1 }]);

  const witchView = viewFor(state, witchSeat, { spectatorReveal: false });
  assert.strictEqual(witchView.seerChecks, undefined, '验人结果泄漏给女巫');
  assert.deepStrictEqual(witchView.witch, { antidoteLeft: true, poisonLeft: true });
});

test('出局者在多人模式下不亮牌；单人局旁观默认亮牌', () => {
  const state = newGame(9, 781);
  const seat = seatOfRole(state, 'villager');
  playerAt(state, seat)!.alive = false;

  const strict = viewFor(state, seat, { spectatorReveal: false });
  assert.ok(
    strict.players.filter((p) => p.seat !== seat).every((p) => p.role === undefined),
    '多人模式下出局者不该看到别人的底牌',
  );

  const single = viewFor(state, seat); // 默认 spectatorReveal = true
  assert.ok(
    single.players.some((p) => p.role !== undefined && p.seat !== seat),
    '单人局旁观应当亮牌',
  );
});

test('局终复盘：所有身份公开（含狼人）', () => {
  const state = newGame(6, 782);
  const seat = seatOfRole(state, 'villager');
  state.status = 'ended';
  state.winner = 'wolf';
  state.phase = 'ended';
  const view = viewFor(state, seat, { spectatorReveal: false });
  assert.ok(view.players.every((p) => p.role !== undefined), '局终必须亮全部底牌');
  assert.strictEqual(view.winner, 'wolf');
});

test('canSeeEvent：public / wolf / 指定座位三种可见性', () => {
  const state = newGame(9, 783);
  const wolfSeat = seatOfRole(state, 'werewolf');
  const villagerSeat = seatOfRole(state, 'villager');

  const pub = { t: 'night-fall' as const, round: 1, audience: 'public' as const, at: 0 };
  const wolfOnly = { t: 'wolf-kill' as const, round: 1, audience: 'wolf' as const, at: 0, target: 2 };
  const privateToWolf = { t: 'seer-check' as const, round: 1, audience: wolfSeat, at: 0, target: 3 };

  assert.ok(canSeeEvent(pub, villagerSeat, state));
  assert.ok(canSeeEvent(wolfOnly, wolfSeat, state));
  assert.ok(!canSeeEvent(wolfOnly, villagerSeat, state));
  assert.ok(canSeeEvent(privateToWolf, wolfSeat, state));
  assert.ok(!canSeeEvent(privateToWolf, villagerSeat, state));
});

test('viewFor 对不存在的座位抛错（避免静默下发错人的视角）', () => {
  const state = newGame(6, 784);
  assert.throws(() => viewFor(state, 99), /seat 99 not found/);
});

// ---------------------------------------------------------------------------
// 3. 女巫：一晚一瓶药、解药不能自救
// ---------------------------------------------------------------------------

test('女巫：一晚只能用一瓶药', () => {
  const state = newGame(9, 900);
  forceRoles(state, { 1: 'werewolf', 2: 'werewolf', 3: 'seer', 4: 'witch', 5: 'hunter', 6: 'villager', 7: 'villager', 8: 'villager', 9: 'villager' });
  state.phase = 'night-witch';
  state.night.wolfTarget = 6;

  const r = applyWitchAction(state, 4, { heal: true, poison: 7 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'one-potion-per-night');
  // 注意：beginNight 会把 witchDecided 显式初始化为 false（不是 undefined），所以断言「不为 true」
  assert.notStrictEqual(state.witchDecided, true, '非法操作不该被记为已决定');
  assert.strictEqual(state.night.witchHeal, undefined, '非法操作不该偷偷用掉解药');
});

test('女巫：解药不能自救', () => {
  const state = newGame(9, 901);
  forceRoles(state, { 1: 'werewolf', 2: 'werewolf', 3: 'seer', 4: 'witch', 5: 'hunter', 6: 'villager', 7: 'villager', 8: 'villager', 9: 'villager' });
  state.phase = 'night-witch';
  state.night.wolfTarget = 4; // 刀的是女巫自己

  assert.strictEqual(witchBriefing(state, 4).canHeal, false);
  const r = applyWitchAction(state, 4, { heal: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'cannot-heal-self');
});

test('女巫：解药只能用一次、毒药只能用一次', () => {
  const state = newGame(9, 902);
  forceRoles(state, { 1: 'werewolf', 2: 'werewolf', 3: 'seer', 4: 'witch', 5: 'hunter', 6: 'villager', 7: 'villager', 8: 'villager', 9: 'villager' });

  state.phase = 'night-witch';
  state.night.wolfTarget = 6;
  assert.ok(applyWitchAction(state, 4, { heal: true }).ok);
  assert.strictEqual(playerAt(state, 4)!.antidoteUsed, true);

  // 第二夜：解药已用完
  state.phase = 'night-witch';
  state.witchDecided = false;
  state.night = { wolfTarget: 7 };
  const again = applyWitchAction(state, 4, { heal: true });
  assert.strictEqual(again.reason, 'no-antidote');

  assert.ok(applyWitchAction(state, 4, { poison: 8 }).ok);
  assert.strictEqual(playerAt(state, 4)!.poisonUsed, true);

  state.phase = 'night-witch';
  state.witchDecided = false;
  state.night = { wolfTarget: 6 };
  assert.strictEqual(applyWitchAction(state, 4, { poison: 9 }).reason, 'no-poison');
});

test('女巫救人后，狼刀目标当夜不死；毒药照常生效', () => {
  const state = newGame(9, 903);
  forceRoles(state, { 1: 'werewolf', 2: 'werewolf', 3: 'seer', 4: 'witch', 5: 'hunter', 6: 'villager', 7: 'villager', 8: 'villager', 9: 'villager' });
  state.phase = 'night-witch';
  state.night.wolfTarget = 6;
  assert.ok(applyWitchAction(state, 4, { heal: true }).ok);
  // 夜晚顺序是 守卫→狼→女巫→**预言家**→结算，所以还要把预言家这步走完才会结算
  state.night.seerTarget = 6;

  runSystemSteps(state);
  assert.strictEqual(playerAt(state, 6)!.alive, true, '被救的人不该死');
  assert.ok(state.events.some((e) => e.t === 'peaceful-night'), '应记平安夜');
});

// ---------------------------------------------------------------------------
// 4. 猎人：被毒杀不能开枪，被刀可以
// ---------------------------------------------------------------------------

test('猎人被毒杀：失去开枪权，流程不卡在开枪', () => {
  const state = newGame(9, 904);
  forceRoles(state, { 1: 'werewolf', 2: 'werewolf', 3: 'seer', 4: 'witch', 5: 'hunter', 6: 'villager', 7: 'villager', 8: 'villager', 9: 'villager' });
  state.phase = 'night-witch';
  state.night.wolfTarget = 6; // 刀别人，毒猎人
  assert.ok(applyWitchAction(state, 4, { poison: 5 }).ok);
  state.night.seerTarget = 6; // 走完预言家这步才会结算

  runSystemSteps(state);
  const hunter = playerAt(state, 5)!;
  assert.strictEqual(hunter.alive, false);
  assert.strictEqual(hunter.canShoot, false, '被毒杀不能开枪');
  assert.strictEqual(state.pendingHunterSeat, undefined);
  assert.strictEqual(state.phase, 'day-speak', '应直接进入白天发言');
});

test('猎人被刀：白天先开枪，开枪能改变胜负', () => {
  const state = newGame(9, 905);
  // 2 狼 vs 7 好人：猎人被刀后若带走一狼，狼数不够屠城
  forceRoles(state, { 1: 'werewolf', 2: 'werewolf', 3: 'seer', 4: 'witch', 5: 'hunter', 6: 'villager', 7: 'villager', 8: 'villager', 9: 'villager' });
  state.phase = 'night-witch';
  state.night.wolfTarget = 5;
  assert.ok(skipWitch(state, 4).ok);
  state.night.seerTarget = 6; // 走完预言家这步才会结算

  runSystemSteps(state);
  assert.strictEqual(state.phase, 'hunter-shoot', '应停在猎人开枪');
  assert.strictEqual(state.pendingHunterSeat, 5);
  assert.deepStrictEqual(actorsNeeded(state), [{ seat: 5, action: 'hunter-shoot' }]);

  assert.ok(applyHunterShoot(state, 5, 1).ok);
  assert.strictEqual(playerAt(state, 1)!.alive, false);
  assert.strictEqual(aliveWolfCount(state), 1);

  runSystemSteps(state);
  assert.strictEqual(state.phase, 'day-speak', '开完枪继续白天');
  assert.strictEqual(state.status, 'playing');
});

test('猎人放弃开枪也能推进（不会卡死）', () => {
  const state = newGame(9, 906);
  forceRoles(state, { 1: 'werewolf', 2: 'werewolf', 3: 'seer', 4: 'witch', 5: 'hunter', 6: 'villager', 7: 'villager', 8: 'villager', 9: 'villager' });
  state.phase = 'night-witch';
  state.night.wolfTarget = 5;
  assert.ok(skipWitch(state, 4).ok);
  state.night.seerTarget = 6; // 走完预言家这步才会结算
  runSystemSteps(state);

  assert.ok(applyHunterShoot(state, 5, null).ok);
  runSystemSteps(state);
  assert.ok(state.events.some((e) => e.t === 'hunter-no-shoot'));
  assert.strictEqual(state.phase, 'day-speak');
});

test('非猎人开枪 / 活人开枪都被拒绝', () => {
  const state = newGame(9, 907);
  forceRoles(state, { 1: 'werewolf', 2: 'werewolf', 3: 'seer', 4: 'witch', 5: 'hunter', 6: 'villager', 7: 'villager', 8: 'villager', 9: 'villager' });
  state.pendingHunterSeat = 5;
  assert.strictEqual(applyHunterShoot(state, 6, 1).reason, 'not-hunter-turn');
  assert.strictEqual(applyHunterShoot(state, 5, 1).reason, 'not-dead-hunter', '猎人还活着不该开枪');
});

// ---------------------------------------------------------------------------
// 5. 投票与放逐
// ---------------------------------------------------------------------------

test('投票：平票先进入 PK 加赛；加赛仍平票则无人出局', () => {
  const state = newGame(6, 950);
  state.phase = 'day-vote';
  state.votes = {};
  // 1↔2、5↔6 对投，3、4 弃票 → 四个目标各 1 票，平票
  assert.ok(applyVote(state, 1, 2).ok);
  assert.ok(applyVote(state, 2, 1).ok);
  assert.ok(abstain(state, 3).ok);
  assert.ok(abstain(state, 4).ok);
  assert.ok(applyVote(state, 5, 6).ok);
  assert.ok(applyVote(state, 6, 5).ok);

  const t = tallyVotes(state);
  assert.strictEqual(t.top.length, 4, '四个目标各 1 票');
  assert.strictEqual(t.abstain, 2, '两票弃票');
  assert.ok(!('3' in t.counts), '弃票不该进票数统计');

  runSystemSteps(state);
  // 移植后的规则：平票 → 先 PK 加赛（不再是直接无人出局）
  assert.ok(state.events.some((e) => e.t === 'pk-start'), '平票应触发 PK 加赛');
  assert.strictEqual(state.phase, 'day-pk');
  assert.ok(state.players.every((p) => p.alive), 'PK 阶段不该有人出局');
  assert.deepStrictEqual(state.pkSeats, t.top);
});

test('PK 加赛期间只能投 PK 台上的候选位，且加赛再平票 = 无人出局', () => {
  const state = newGame(6, 950);
  state.phase = 'day-vote';
  state.votes = {};
  assert.ok(applyVote(state, 1, 2).ok);
  assert.ok(applyVote(state, 2, 1).ok);
  assert.ok(abstain(state, 3).ok);
  assert.ok(abstain(state, 4).ok);
  assert.ok(applyVote(state, 5, 6).ok);
  assert.ok(applyVote(state, 6, 5).ok);
  runSystemSteps(state);
  assert.strictEqual(state.phase, 'day-pk');

  const pk = state.pkSeats!.slice();
  const outsider = state.players.find((p) => !pk.includes(p.seat))!.seat;

  // 让 PK 台上的候选位发完言
  for (const s of pk) applySpeech(state, s, `${s}号 PK 发言：我不是狼。`);
  runSystemSteps(state);
  assert.strictEqual(state.phase, 'day-vote', 'PK 发言完应进入再投');
  assert.deepStrictEqual(state.pkSeats, pk, '再投阶段票只认 PK 台');

  // 台外的人不能被投
  const voter = state.players.find((p) => p.alive && p.canVote !== false)!.seat;
  assert.strictEqual(applyVote(state, voter, outsider).reason, 'pk-only');

  // 再投依然平票 → 无人出局（且不再无限加赛）
  // 注意：要**刻意**把票在两台之间对半分开才叫平票；随便投会投出唯一最高票
  const [a1, a2] = pk;
  const voters = state.players.filter((p) => p.alive && p.canVote !== false).map((p) => p.seat);
  voters.forEach((s, i) => {
    const target = s === a1 ? a2 : s === a2 ? a1 : i % 2 === 0 ? a1 : a2;
    const r = applyVote(state, s, target);
    assert.ok(r.ok, `再投失败：${r.reason}`);
  });
  runSystemSteps(state);
  assert.ok(state.events.some((e) => e.t === 'vote-tie'), '加赛再平票应记「无人出局」');
  assert.ok(state.players.every((p) => p.alive), '加赛仍平票时不该有人出局');
  assert.ok(!state.events.some((e) => e.t === 'exile'), '不该有人被放逐');
});

test('投票：多数票放逐，且不能投自己', () => {
  const state = newGame(6, 951);
  // 固定身份：2 号是狼、且狼不止一只 → 放逐后不会立刻结束，便于断言放逐本身
  forceRoles(state, { 1: 'werewolf', 2: 'werewolf', 3: 'seer', 4: 'witch', 5: 'villager', 6: 'villager' });
  state.phase = 'day-vote';
  state.votes = {};
  // 自投被拒
  assert.strictEqual(applyVote(state, 2, 2).reason, 'cannot-vote-self');
  // 1、3、4 投 2 号；2、5、6 各投别的 → 2 号 3 票，其余各 1 票
  assert.ok(applyVote(state, 1, 2).ok);
  assert.ok(applyVote(state, 3, 2).ok);
  assert.ok(applyVote(state, 4, 2).ok);
  assert.ok(applyVote(state, 2, 3).ok);
  assert.ok(applyVote(state, 5, 6).ok);
  assert.ok(applyVote(state, 6, 5).ok);

  const t = tallyVotes(state);
  assert.deepStrictEqual(t.top, [2], '2 号应是唯一最高票');

  runSystemSteps(state); // day-vote → 全员已投 → resolveVote
  assert.strictEqual(playerAt(state, 2)!.alive, false, '2 号应被放逐');
  assert.ok(state.events.some((e) => e.t === 'exile' && e.seat === 2));
  assert.ok(state.events.some((e) => e.t === 'vote-result' && e.target === 2 && e.count === 3));
  assert.ok(!state.events.some((e) => e.t === 'vote-tie'), '有唯一最高票就不该判平票');
  // 注意：不在这里断言 state.exiledSeat，未分胜负时会进入下一轮，beginNight 会重置它
});

test('投票：不能投已出局的人，也不能由出局者投票', () => {
  const state = newGame(6, 952);
  state.phase = 'day-vote';
  state.votes = {};
  playerAt(state, 6)!.alive = false;
  assert.strictEqual(applyVote(state, 1, 6).reason, 'bad-target');
  assert.strictEqual(applyVote(state, 6, 1).reason, 'not-alive');
});

// ---------------------------------------------------------------------------
// 6. 胜负判定
// ---------------------------------------------------------------------------

test('胜负：狼人全灭 → 好人胜；狼数 >= 好人数 → 狼人胜', () => {
  const state = newGame(6, 960);
  forceRoles(state, { 1: 'werewolf', 2: 'werewolf', 3: 'seer', 4: 'witch', 5: 'villager', 6: 'villager' });

  assert.strictEqual(checkWin(state), undefined, '开局不该有胜负');
  assert.strictEqual(aliveWolfCount(state), 2);
  assert.strictEqual(aliveVillageCount(state), 4);

  playerAt(state, 1)!.alive = false;
  playerAt(state, 2)!.alive = false;
  assert.strictEqual(checkWin(state), 'village');

  const s2 = newGame(6, 961);
  forceRoles(s2, { 1: 'werewolf', 2: 'werewolf', 3: 'seer', 4: 'witch', 5: 'villager', 6: 'villager' });
  playerAt(s2, 5)!.alive = false;
  playerAt(s2, 6)!.alive = false;
  assert.strictEqual(checkWin(s2), 'wolf', '狼数 2 = 好人数 2 应判狼人胜');
});

test('达到轮数上限仍未屠城 → 判好人守住（不无限打下去）', () => {
  // 6 人局 2 狼 4 好人；把狼压到 1 只、好人留 4 只，永远达不到屠城条件
  const state = newGame(6, 962);
  forceRoles(state, { 1: 'werewolf', 2: 'villager', 3: 'seer', 4: 'witch', 5: 'villager', 6: 'villager' });
  state.round = 8;
  state.phase = 'day-exile';
  state.exiledSeat = undefined;
  runSystemSteps(state);
  assert.strictEqual(state.status, 'ended');
  assert.strictEqual(state.winner, 'village');
  assert.ok(state.events.some((e) => e.t === 'game-end'));
});

// ---------------------------------------------------------------------------
// 7. 发言顺序与状态机收敛
// ---------------------------------------------------------------------------

test('发言顺序只含存活玩家，且放逐死者后跳过他', () => {
  const state = newGame(6, 970);
  state.phase = 'day-announce';
  runSystemSteps(state);
  assert.strictEqual(state.phase, 'day-speak');
  assert.deepStrictEqual(state.speakOrder.slice().sort(), livingSeats(state).slice().sort());

  // 杀掉当前该发言的人，推进时应自动跳过
  const current = state.speakOrder[state.speakIndex];
  playerAt(state, current)!.alive = false;
  const before = state.speakIndex;
  runSystemSteps(state);
  assert.ok(state.speakIndex > before, '应跳过已出局的发言位');
});

test('发言必须轮到自己；轮次推进正确', () => {
  const state = newGame(6, 971);
  state.phase = 'day-announce';
  runSystemSteps(state);
  const first = state.speakOrder[0];
  const second = state.speakOrder[1];
  assert.strictEqual(applySpeech(state, second, '插队').reason, 'not-your-turn');
  assert.ok(applySpeech(state, first, '轮到我了').ok);
  assert.strictEqual(state.speakIndex, 1);
  assert.strictEqual(applySpeech(state, first, '又说一次').reason, 'not-your-turn');
});

test('整局自动推进：三种局型都能真的打完（不死循环、必有胜负）', () => {
  for (const size of GAME_SIZES) {
    for (const seed of [11, 22, 33, 44, 55, 66]) {
      const state = newGame(size, seed);
      const steps = autoPlay(state);
      assert.strictEqual(state.status, 'ended', `${size}人局 seed=${seed} 没打完`);
      assert.ok(state.winner === 'wolf' || state.winner === 'village', '必须有胜负');
      assert.ok(state.round <= 8, `轮数超上限：${state.round}`);
      assert.ok(steps < 4000);
      // 结束后的视图必须是完整亮牌的复盘
      const view = viewFor(state, state.humanSeat, { spectatorReveal: false });
      assert.ok(view.players.every((p) => p.role !== undefined));
    }
  }
});

test('结束后的状态不再被 tickOnce 推进（幂等）', () => {
  const state = newGame(9, 1000);
  autoPlay(state);
  const eventsBefore = state.events.length;
  const phase = state.phase;
  runSystemSteps(state);
  assert.strictEqual(state.phase, phase);
  assert.strictEqual(state.events.length, eventsBefore);
});

test('actorsNeeded 在等待输入时给出正确的动作类型', () => {
  const state = newGame(9, 1001);
  runSystemSteps(state); // 先推进掉「守卫」（9 人局无守卫）+ 入夜
  const wolves = state.players.filter((p) => isWolfRole(p.role)).map((p) => p.seat);
  assert.strictEqual(state.phase, 'night-wolf');
  assert.deepStrictEqual(
    actorsNeeded(state).map((a) => a.action),
    wolves.map(() => 'wolf-kill'),
    '夜里应等所有活狼出刀',
  );

  // 狼全部出刀后应推进到女巫（夜晚顺序：守卫 → 狼 → 女巫 → 预言家）
  for (const s of wolves) applyWolfVote(state, s, state.players.find((p) => p.alive && p.seat !== s)!.seat);
  runSystemSteps(state);
  assert.strictEqual(state.phase, 'night-witch');
  assert.deepStrictEqual(actorsNeeded(state), [{ seat: seatOfRole(state, 'witch'), action: 'witch' }]);
});

test('phase 与 actorsNeeded 自洽：任何阶段只要有待办就一定有动作类型', () => {
  const state = newGame(9, 1002);
  let guard = 0;
  while (state.status === 'playing' && guard++ < 500) {
    runSystemSteps(state);
    if (state.status === 'ended') break;
    const actors = actorsNeeded(state);
    assert.ok(actors.length > 0, `phase=${state.phase} 既没结束也没待办`);
    for (const a of actors) {
      assert.ok(playerAt(state, a.seat), '待办座位必须存在');
      assert.ok(a.action, '待办必须有动作类型');
    }
    // 用假 AI 走一步，保证循环推进
    for (const a of actors) {
      if (a.action === 'guard') {
        const t = state.players.find((p) => p.alive && p.seat !== state.lastGuardTarget)!;
        applyGuard(state, a.seat, t.seat);
      } else if (a.action === 'wolf-kill') {
        applyWolfVote(state, a.seat, state.players.find((p) => p.alive && p.seat !== a.seat)!.seat);
      } else if (a.action === 'seer-check') {
        applySeerCheck(state, a.seat, state.players.find((p) => p.alive && p.seat !== a.seat)!.seat);
      } else if (a.action === 'witch') {
        skipWitch(state, a.seat);
      } else if (a.action === 'speak') {
        applySpeech(state, a.seat, '过');
      } else if (a.action === 'vote') {
        const pool = state.pkSeats?.length
          ? state.players.filter((p) => p.alive && state.pkSeats!.includes(p.seat) && p.seat !== a.seat)
          : state.players.filter((p) => p.alive && p.seat !== a.seat);
        applyVote(state, a.seat, pool[0] ? pool[0].seat : 0);
      } else if (a.action === 'last-words') {
        applyLastWords(state, a.seat, '遗言');
      } else if (a.action === 'hunter-shoot') {
        applyHunterShoot(state, a.seat, null);
      } else if (a.action === 'boom') {
        applyBoomTarget(state, a.seat, null);
      }
    }
  }
  assert.strictEqual(state.status, 'ended');
});

// ---------------------------------------------------------------------------
// 8. 复盘卡「这局谁在骗你」
// ---------------------------------------------------------------------------

test('复盘卡：局终后能还原真相（谁在骗你 / 谁怎么出局 / 夜里发生了什么）', () => {
  const state = newGame(6, 31415);
  autoPlay(state);
  const view = viewFor(state, state.humanSeat); // 已结束 → revealAll，全部底牌可见
  const replay = buildReplay(view);

  const wolfCount = state.players.filter((p) => isWolfRole(p.role)).length;
  if (view.myCamp === 'wolf') {
    assert.strictEqual(replay.liars.length, wolfCount - 1, '自己是狼时卡上是同伙（不含自己）');
  } else {
    assert.strictEqual(replay.liars.length, wolfCount, '好人视角应看到全部狼人');
  }
  assert.strictEqual(replay.iWon, view.winner === view.myCamp);
  assert.ok(replay.deaths.length > 0, '一局打完总得有人出局');
  assert.ok(replay.truths.some((t) => t.kind === 'wolfKill'), '应能还原「狼刀了谁」');
  assert.ok(replay.truths.every((t) => t.name), '真相条目必须都能对上人名');
  assert.ok(
    replay.headlineKey === 'replayHeadlineWolfWin' || replay.headlineKey === 'replayHeadlineVillageWin',
    '一句话钩子必须是三语里有词条的 key',
  );
});

test('复盘卡不能变成提前开天眼：局中途（村民视角）算不出狼人名单', () => {
  const state = newGame(9, 2718);
  forceRoles(state, { 1: 'villager', 2: 'werewolf', 3: 'werewolf', 4: 'seer', 5: 'witch', 6: 'hunter', 7: 'villager', 8: 'villager', 9: 'villager' });
  const mid = viewFor(state, 1, { spectatorReveal: false });
  assert.strictEqual(mid.myCamp, 'village');
  assert.strictEqual(buildReplay(mid).liars.length, 0, '局中不该算出狼人，否则复盘卡就是作弊器');
});

test('复盘卡：被票出局时能列出是谁投的', () => {
  const state = newGame(6, 951);
  forceRoles(state, { 1: 'werewolf', 2: 'werewolf', 3: 'seer', 4: 'witch', 5: 'villager', 6: 'villager' });
  state.phase = 'day-vote';
  state.votes = {};
  // 2、3、4 投 1 号（我）把我票出去；5、6 互投；我自己弃票
  // 注意：少任何一张票引擎都不会结算（全员表态才算投完），第一版测试就是漏了我自己这张票
  assert.ok(applyVote(state, 2, 1).ok);
  assert.ok(applyVote(state, 3, 1).ok);
  assert.ok(applyVote(state, 4, 1).ok);
  assert.ok(applyVote(state, 5, 6).ok);
  assert.ok(applyVote(state, 6, 5).ok);
  assert.ok(abstain(state, 1).ok);
  runSystemSteps(state);

  const replay = buildReplay(viewFor(state, 1, { spectatorReveal: false }));
  assert.strictEqual(replay.votedMeOut.length, 3, '应有 3 个人投了我');
  assert.deepStrictEqual(replay.votedMeOut.map((p) => p.seat).sort((a, b) => a - b), [2, 3, 4]);
  assert.ok(
    replay.deaths.some((d) => d.seat === 1 && d.by === 'vote'),
    '我应出现在出局名单里，且死因是「被票」',
  );
});

// ---------------------------------------------------------------------------
// 9. 投票期间的信息隔离（读竞品源码后回头查出并修掉的真问题）
// ---------------------------------------------------------------------------

test('投票期间信息隔离：结算前，任何 AI 的提示词里都不能出现本轮别人的票', () => {
  const state = newGame(6, 8123);
  state.phase = 'day-vote';
  state.votes = {};
  assert.ok(applyVote(state, 1, 3).ok, '真人先投（drive 会先停下来等真人）');

  // 结算前：既不能有公开的投票事件，也不能进任何人的视图 / 提示词
  assert.ok(!state.events.some((e) => e.t === 'vote'), '结算前不该存在公开的投票事件');
  assert.deepStrictEqual(viewForAi(state, 2).votes, [], '结算前视图里不该带本轮票型');

  const msgs = buildAgentMessages(state, { seat: 2, name: '陪玩2' }, 'vote', 'zh');
  assert.ok(!/投给了|voted for/.test(msgs.user), 'AI 的提示词里出现了别人的票 → AI 会跟票');

  // 结算后才公开票型
  assert.ok(applyVote(state, 2, 4).ok);
  assert.ok(applyVote(state, 3, 4).ok);
  assert.ok(applyVote(state, 4, 2).ok);
  assert.ok(applyVote(state, 5, 2).ok);
  assert.ok(abstain(state, 6).ok);
  runSystemSteps(state);
  assert.ok(
    state.events.some((e) => e.t === 'vote' && e.seat === 1 && e.to === 3),
    '结算后票型必须公开（复盘卡要靠它）',
  );
  assert.ok(!state.events.some((e) => e.t === 'vote' && e.seat === 6), '弃票不写公开事件');
});
