/**
 * AI 狼人杀 · 规则引擎类型与配置（纯数据，无副作用）
 *
 * 设计红线（见《AI狼人杀-调研与实施方案.md》）：
 *  1. **服务端是唯一权威**：LLM 只负责「发言 / 决策倾向」，输赢一律由本引擎裁决，绝不交给模型判。
 *  2. **事件自带可见范围（audience）**：狼人刀谁、预言家验出什么，只能下发给该看的人。
 *     视角隔离由 `view.ts` 单一出口实现——这是防作弊的地基。
 *  3. **文案与语言解耦**：事件只存结构化参数（seat/target/role/camp），不下发中文句子，
 *     由前端按 zh-CN / zh-TW / en 渲染。
 */

/**
 * 局内身份。
 * 白狼王 / 守卫 / 白痴 三项移植自 wolfcha（Apache-2.0，见 `../upstream/ATTRIBUTION.md`）。
 */
export type WerewolfRole =
  | 'werewolf'
  | 'whiteWolfKing'
  | 'seer'
  | 'witch'
  | 'hunter'
  | 'guard'
  | 'idiot'
  | 'villager';

/** 阵营 */
export type Camp = 'wolf' | 'village';

/** 玩家类型：真人 / AI（AI 又分「聊一聊角色」与「内置陪玩」） */
export type PlayerKind = 'human' | 'ai';

/**
 * 事件可见范围：
 *  - 'public'：所有人可见
 *  - 'wolf'：仅狼人阵营可见（狼队刀人、狼队互认）
 *  - number：仅该座位可见（预言家验人结果、女巫用药）
 */
export type Audience = 'public' | 'wolf' | number;

/**
 * 对局阶段。
 * 夜晚顺序沿用 wolfcha 的 Phase 枚举：**守卫 → 狼人 → 女巫 → 预言家 → 结算**。
 */
export type Phase =
  | 'night-guard' // 守卫守人（夜里第一步）
  | 'night-wolf' // 狼人刀人
  | 'night-witch' // 女巫用药
  | 'night-seer' // 预言家验人
  | 'day-announce' // 公布死讯
  | 'day-badge-signup' // 警长竞选 · 上警报名（移植自 wolfcha DAY_BADGE_SIGNUP）
  | 'day-badge-speech' // 警长竞选 · 竞选发言
  | 'day-badge-election' // 警长竞选 · 投票选警长
  | 'badge-transfer' // 警长出局后移交警徽（移植自 BADGE_TRANSFER）
  | 'day-speak' // 依次发言（白狼王可在自己发言时选择自爆）
  | 'day-pk' // 平票后的 PK 发言与再投
  | 'day-vote' // 投票
  | 'day-exile' // 放逐 + 遗言
  | 'hunter-shoot' // 猎人开枪
  | 'white-wolf-boom' // 白狼王自爆后选带走谁
  | 'ended';

/** 等待谁做什么（人类玩家的操作点；AI 由服务端自动推进） */
export type PendingAction =
  | 'guard'
  | 'wolf-kill'
  | 'seer-check'
  | 'witch'
  | 'badge-signup'
  | 'badge-vote'
  | 'badge-transfer'
  | 'speak'
  | 'vote'
  | 'last-words'
  | 'hunter-shoot'
  | 'boom';

/** 局型（人数）：6 人是我们自己的快速局，其余沿用 wolfcha 的 8~12 人配置 */
export type GameSize = 6 | 8 | 9 | 10 | 11 | 12;

/** 事件类型 */
export type EventType =
  | 'game-start'
  | 'role-assigned'
  | 'wolf-teammates'
  | 'night-fall'
  | 'guard-protect'
  | 'wolf-kill'
  | 'wolf-consensus-fail'
  | 'seer-check'
  | 'witch-heal'
  | 'witch-poison'
  | 'night-result'
  | 'day-break'
  | 'death-announced'
  | 'peaceful-night'
  | 'speech'
  | 'turn-failed'
  | 'badge-signup'
  | 'badge-elected'
  | 'badge-pk'
  | 'badge-transfer'
  | 'badge-destroyed'
  | 'vote'
  | 'vote-result'
  | 'vote-tie'
  | 'pk-start'
  | 'exile'
  | 'last-words'
  | 'idiot-revealed'
  | 'white-wolf-boom'
  | 'hunter-shoot'
  | 'hunter-no-shoot'
  | 'game-end';

/**
 * 对局事件。
 * 只存结构化参数、不存成句文案——三语渲染是前端的事。
 * `text` 仅用于承载玩家/AI 的发言原文（用户内容，不翻译）。
 */
export interface GameEvent {
  t: EventType;
  round: number;
  audience: Audience;
  seat?: number;
  target?: number;
  role?: WerewolfRole;
  camp?: Camp;
  text?: string;
  /** 投票事件：被投给谁 */
  to?: number;
  /** 通用计数（如平票票数） */
  count?: number;
  at: number;
}

/** 玩家 */
export interface WerewolfPlayer {
  /** 座位号，从 1 开始 */
  seat: number;
  /** 'user' = 本人；'ai:chat:<characterId>' = 聊一聊角色；'ai:builtin:<id>' = 内置陪玩 */
  id: string;
  kind: PlayerKind;
  /** 展示名（用角色自己的名字，不是「AI 1 号」） */
  name: string;
  avatar?: string;
  /** 该 AI 玩家对应的「聊一聊」角色 id：用于注入它的人格与跟你的关系记忆 */
  characterId?: string;
  /** 是否内置陪玩角色（未拉聊一聊角色时补齐用） */
  builtin?: boolean;
  role: WerewolfRole;
  alive: boolean;
  /** 女巫 · 解药是否已用 */
  antidoteUsed?: boolean;
  /** 女巫 · 毒药是否已用 */
  poisonUsed?: boolean;
  /** 猎人 · 当前是否还握有开枪权（被毒杀则失去） */
  canShoot?: boolean;
  /** 白痴 · 是否已翻牌（翻牌后不出局但失去投票权） */
  idiotRevealed?: boolean;
  /** 是否还有投票权（白痴翻牌后为 false；缺省视为有） */
  canVote?: boolean;
  /** 白狼王 · 是否已自爆（自爆带人后立即入夜） */
  boomed?: boolean;
}

/** 开局时传入的座位输入（服务端已按视角校验过角色归属） */
export interface SeatInput {
  id: string;
  kind: PlayerKind;
  name: string;
  avatar?: string;
  characterId?: string;
  builtin?: boolean;
}

/** 夜晚暂存（次晨结算前的私密状态） */
export interface NightState {
  /** 狼队本夜刀的人 */
  wolfTarget?: number;
  /** 狼人各自的票（用于多数决与「狼队没统一意见」的叙事） */
  wolfVotes?: Record<string, number>;
  /** 预言家本夜验的人 */
  seerTarget?: number;
  /** 预言家本夜结果 */
  seerCamp?: Camp;
  /** 女巫是否用解药 */
  witchHeal?: boolean;
  /** 女巫毒谁 */
  witchPoison?: number;
  /** 守卫本夜守的人 */
  guardTarget?: number;
}

/** 对局状态（服务端权威全量；下发给前端前必须过 view.ts 过滤） */
export interface WerewolfState {
  id: string;
  /** 归属用户（单人局只有一个真人；多人预留时这里改为房间归属） */
  userId: string;
  size: GameSize;
  createdAt: number;
  updatedAt: number;
  status: 'playing' | 'ended';
  winner?: Camp;
  /** 第几轮（夜 + 昼 = 一轮），从 1 开始 */
  round: number;
  phase: Phase;
  players: WerewolfPlayer[];
  /** 本人坐哪一号（多人预留：本窗口用户的座位） */
  humanSeat: number;
  /** 完整事件流（服务端真相；下发时按 audience 过滤） */
  events: GameEvent[];
  night: NightState;
  /** 本日投票：座位 → 目标座位 */
  votes: Record<string, number>;
  /** 本日发言顺序（存活座位） */
  speakOrder: number[];
  /** 当前轮到 speakOrder 的第几位 */
  speakIndex: number;
  /** 当前等待行动的座位 */
  pendingSeat?: number;
  pendingAction?: PendingAction;
  /** 本日已被投票放逐者（等待遗言/猎人开枪） */
  exiledSeat?: number;
  /** 女巫本夜是否已做决定（每夜开始重置）——「不用药」也是一次决定 */
  witchDecided?: boolean;
  /** 猎人待开枪的座位（有值 = 卡在开枪这一步等决定；处理完清空） */
  pendingHunterSeat?: number;
  /** 开枪处理完后回到哪个阶段（夜间死亡 → day-announce；放逐死亡 → day-exile） */
  returnPhase?: Phase;
  /** 守卫上一夜守的人（规则：不能连续两晚守同一人） */
  lastGuardTarget?: number;
  /** 本日平票后进入 PK 的候选座位（空 = 未进入 PK） */
  pkSeats?: number[];
  /** 本日是否已经用过一次 PK 加赛（避免无限加赛） */
  pkUsed?: boolean;
  /** 本日 PK 的轮次（1 = 首次加赛） */
  pkRound?: number;
  /** 白狼王自爆后，等待被带走的座位（有值 = 卡在自爆选人这步） */
  boomSeat?: number;
  /** 已给出遗言的座位（避免重复要遗言） */
  lastWordsSeat?: number;
  // —— 警长竞选 / 警徽流（移植自 wolfcha 的 DAY_BADGE_* 与 BADGE_TRANSFER）——
  /** 当前警长座位（空 = 本局还没有警长） */
  badgeSeat?: number;
  /** 上警报名：座位 → 是否上警 */
  badgeSignups?: Record<string, boolean>;
  /** 警长候选人（报名「上」的存活座位） */
  badgeCandidates?: number[];
  /** 警长票：座位 → 候选人 */
  badgeVotes?: Record<string, number>;
  /** 警长竞选是否已办过（只在第一天上警） */
  badgeElectionDone?: boolean;
  /** 警长竞选平票后是否已加赛过一次 */
  badgePkUsed?: boolean;
  /** 警长出局后等待移交（存前警长座位；有值 = 卡在移交这步） */
  badgeTransferFrom?: number;
  /** 本局累计真实 usage（成本核算：整局预留、收尾结算校正） */
  usage: { promptTokens: number; completionTokens: number; calls: number };
  /** 洗牌种子（可复现，便于复盘与排障） */
  seed: number;
}

// ---------------------------------------------------------------------------
// 身份配置
// ---------------------------------------------------------------------------

export interface RoleSpec {
  role: WerewolfRole;
  camp: Camp;
  nameZh: string;
  nameZhTw: string;
  nameEn: string;
  /** 一句话能力说明（三语） */
  descZh: string;
  descZhTw: string;
  descEn: string;
}

export const ROLES: Record<WerewolfRole, RoleSpec> = {
  werewolf: {
    role: 'werewolf',
    camp: 'wolf',
    nameZh: '狼人',
    nameZhTw: '狼人',
    nameEn: 'Werewolf',
    descZh: '夜里与同伴共同选一个人出局，白天要装作好人。',
    descZhTw: '夜裡與同伴共同選一個人出局，白天要裝作好人。',
    descEn: 'At night you and your pack choose someone to eliminate; by day you must pass as a villager.',
  },
  seer: {
    role: 'seer',
    camp: 'village',
    nameZh: '预言家',
    nameZhTw: '預言家',
    nameEn: 'Seer',
    descZh: '每晚可以查验一个人的阵营。',
    descZhTw: '每晚可以查驗一個人的陣營。',
    descEn: 'Each night you may check one player to learn their camp.',
  },
  witch: {
    role: 'witch',
    camp: 'village',
    nameZh: '女巫',
    nameZhTw: '女巫',
    nameEn: 'Witch',
    descZh: '有一瓶解药和一瓶毒药，各只能用一次；同一晚只能用其中一瓶，解药不能救自己。',
    descZhTw: '有一瓶解藥和一瓶毒藥，各只能用一次；同一晚只能用其中一瓶，解藥不能救自己。',
    descEn: 'You hold one antidote and one poison, each usable once, at most one per night, and you cannot save yourself.',
  },
  hunter: {
    role: 'hunter',
    camp: 'village',
    nameZh: '猎人',
    nameZhTw: '獵人',
    nameEn: 'Hunter',
    descZh: '出局时（被毒杀除外）可以开枪带走一个人。',
    descZhTw: '出局時（被毒殺除外）可以開槍帶走一個人。',
    descEn: 'When you are eliminated (unless by poison) you may shoot one player.',
  },
  villager: {
    role: 'villager',
    camp: 'village',
    nameZh: '平民',
    nameZhTw: '平民',
    nameEn: 'Villager',
    descZh: '没有特殊能力，靠发言和投票找出狼人。',
    descZhTw: '沒有特殊能力，靠發言和投票找出狼人。',
    descEn: 'No special ability — you find the wolves by talk and by vote.',
  },
  whiteWolfKing: {
    role: 'whiteWolfKing',
    camp: 'wolf',
    nameZh: '白狼王',
    nameZhTw: '白狼王',
    nameEn: 'White Wolf King',
    descZh: '狼人阵营。白天可以在自己发言时自爆，自爆后带走一个人，然后直接进入黑夜。',
    descZhTw: '狼人陣營。白天可以在自己發言時自爆，自爆後帶走一個人，然後直接進入黑夜。',
    descEn: 'Wolf camp. By day you may blow up during your own speech, taking one player with you; night falls at once.',
  },
  guard: {
    role: 'guard',
    camp: 'village',
    nameZh: '守卫',
    nameZhTw: '守衛',
    nameEn: 'Guard',
    descZh: '每晚守护一个人，被守护的人当晚不会被狼人刀死；不能连续两晚守护同一个人。',
    descZhTw: '每晚守護一個人，被守護的人當晚不會被狼人刀死；不能連續兩晚守護同一個人。',
    descEn: 'Each night you shield one player from the wolves; you may not shield the same player two nights running.',
  },
  idiot: {
    role: 'idiot',
    camp: 'village',
    nameZh: '白痴',
    nameZhTw: '白痴',
    nameEn: 'Idiot',
    descZh: '被投票放逐时翻牌，不会出局，但从此失去投票权（仍可发言）。',
    descZhTw: '被投票放逐時翻牌，不會出局，但從此失去投票權（仍可發言）。',
    descEn: 'If voted out you reveal your card and survive, but you lose your vote from then on (you may still speak).',
  },
};

/**
 * 各局型的身份配比。
 * **8~12 人配置移植自 wolfcha `src/lib/role-configuration.ts`**（Apache-2.0，见 `../upstream/ATTRIBUTION.md`）；
 * 6 人快速局是我们自己加的（成本最低，作默认）。
 */
export const ROSTERS: Record<GameSize, Record<WerewolfRole, number>> = {
  // 6 人局：新手 / 快速局（我们自己的配置，成本最低，作为默认）
  6: { werewolf: 2, whiteWolfKing: 0, seer: 1, witch: 1, hunter: 0, guard: 0, idiot: 0, villager: 2 },
  // —— 以下 8~12 人移植自 wolfcha ——
  8: { werewolf: 3, whiteWolfKing: 0, seer: 1, witch: 1, hunter: 1, guard: 0, idiot: 0, villager: 2 },
  9: { werewolf: 3, whiteWolfKing: 0, seer: 1, witch: 1, hunter: 1, guard: 0, idiot: 0, villager: 3 },
  10: { werewolf: 2, whiteWolfKing: 1, seer: 1, witch: 1, hunter: 1, guard: 1, idiot: 0, villager: 3 },
  11: { werewolf: 3, whiteWolfKing: 1, seer: 1, witch: 1, hunter: 1, guard: 1, idiot: 1, villager: 2 },
  12: { werewolf: 3, whiteWolfKing: 1, seer: 1, witch: 1, hunter: 1, guard: 1, idiot: 1, villager: 3 },
};

/** 可选局型（按人数从小到大） */
export const GAME_SIZES: GameSize[] = [6, 8, 9, 10, 11, 12];

/** 一局的最大轮数上限（防止长局烧钱 / 卡死） */
export const MAX_ROUNDS = 8;

/** 该身份的阵营 */
export function roleCamp(role: WerewolfRole): Camp {
  return ROLES[role].camp;
}

/** 是否狼人 */
export function isWolfRole(role: WerewolfRole): boolean {
  return ROLES[role].camp === 'wolf';
}

/** 存活座位号（升序） */
export function livingSeats(state: WerewolfState): number[] {
  return state.players.filter((p) => p.alive).map((p) => p.seat).sort((a, b) => a - b);
}

/** 按座位号取玩家 */
export function playerAt(state: WerewolfState, seat: number): WerewolfPlayer | undefined {
  return state.players.find((p) => p.seat === seat);
}

/** 存活狼人数 */
export function aliveWolfCount(state: WerewolfState): number {
  return state.players.filter((p) => p.alive && isWolfRole(p.role)).length;
}

/** 存活好人数（非狼阵营） */
export function aliveVillageCount(state: WerewolfState): number {
  return state.players.filter((p) => p.alive && !isWolfRole(p.role)).length;
}

/** 狼队座位（含已出局的，用于复盘；视角过滤由 view.ts 负责） */
export function wolfSeats(state: WerewolfState): number[] {
  return state.players.filter((p) => isWolfRole(p.role)).map((p) => p.seat);
}

/** 局内身份配比表（前端展示「本局配置」用） */
export function rosterOf(size: GameSize): Record<WerewolfRole, number> {
  return ROSTERS[size] ?? ROSTERS[6];
}
