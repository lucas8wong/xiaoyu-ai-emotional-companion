import { MODEL_ID, MODEL_PROVIDER } from "~/lib/model";

export type Role = "Villager" | "Werewolf" | "Seer" | "Witch" | "Hunter" | "Guard" | "Idiot" | "WhiteWolfKing";

/** Check if a role belongs to the wolf team (used for seer checks, wolf actions, etc.) */
export function isWolfRole(role: string | undefined): boolean {
  return role === "Werewolf" || role === "WhiteWolfKing";
}

export type DifficultyLevel = "easy" | "normal" | "hard";

export type SpeechDirection = "clockwise" | "counterclockwise";

export type DevPreset = "MILK_POISON_TEST" | "LAST_WORDS_TEST";

export interface CustomCharacterData {
  id: string;
  display_name: string;
  gender: "male" | "female" | "nonbinary";
  age: number;
  mbti: string;
  basic_info?: string;
  style_label?: string;
  avatar_seed?: string;
}

export interface StartGameOptions {
  fixedRoles?: Role[];
  devPreset?: DevPreset;
  difficulty?: DifficultyLevel;
  playerCount?: number;
  gameSessionId?: string;
  isGenshinMode?: boolean;
  isSpectatorMode?: boolean;
  customCharacters?: CustomCharacterData[];
  preferredRole?: Role;
}

export type Phase =
  | "LOBBY"
  | "SETUP"
  | "NIGHT_START"
  | "NIGHT_GUARD_ACTION"   // 守卫保护
  | "NIGHT_WOLF_ACTION"    // 狼人出刀
  | "NIGHT_WITCH_ACTION"   // 女巫用药
  | "NIGHT_SEER_ACTION"    // 预言家查验
  | "NIGHT_RESOLVE"
  | "DAY_START"
  | "DAY_BADGE_SIGNUP"     // 警徽竞选报名
  | "DAY_BADGE_SPEECH"     // 警徽竞选发言
  | "DAY_BADGE_ELECTION"   // 警徽评选
  | "DAY_PK_SPEECH"        // PK发言
  | "DAY_SPEECH"
  | "DAY_LAST_WORDS"
  | "DAY_VOTE"
  | "DAY_RESOLVE"
  | "BADGE_TRANSFER"        // 警长移交警徽
  | "HUNTER_SHOOT"          // 猎人开枪
  | "WHITE_WOLF_KING_BOOM"  // 白狼王自爆
  | "GAME_END";

export type Alignment = "village" | "wolf";

 export interface GameScenario {
   id: string;
   title: string;
   description: string;
   rolesHint: string;
 }

export interface ModelRef {
  /** 来源标记（不再承担路由职责；旧存档里的 "zenmux"/"dashscope" 等值仍可读写） */
  provider: string;
  model: string;
  /** Override call-time temperature for this model (e.g. some models only support 1) */
  temperature?: number;
  /** Override call-time reasoning/thinking for this model (e.g. some models must enable it) */
  reasoning?: { enabled: boolean, exclude?: boolean, effort?: "minimal" | "low" | "medium" | "high", max_tokens?: number };
}

export interface Persona {
  styleLabel?: string;
  voiceRules: string[];
  mbti: string;
  gender: "male" | "female" | "nonbinary";
  age: number;
  basicInfo?: string;
  voiceId?: string;
  relationships?: string[];
  logicStyle?: string;
  triggerTopics?: string[];
  socialHabit?: string;
  humorStyle?: string;
  werewolfExperience?: string;
  vocabularyStyle?: string;
  reasoningStyle?: string;
  speechLengthHabit?: string;
  pressureStyle?: string;
  uncertaintyStyle?: string;
  mistakePattern?: string;
  wolfDeceptionStyle?: string;
}

export interface PlayerMind {
  courage: string;
  memoryBias: string;
  suspicionThreshold: string;
  selfProtection: string;
  logicDepth: string;
  tablePresence: string;
}

export interface AgentProfile {
  modelRef: ModelRef;
  persona: Persona;
  playerMind?: PlayerMind;
}

export interface Player {
  playerId: string;
  seat: number;
  displayName: string;
  avatarSeed?: string;
  alive: boolean;
  role: Role;
  alignment: Alignment;
  isHuman: boolean;
  agentProfile?: AgentProfile;
}

export type GameEventType =
  | "GAME_START"
  | "ROLE_ASSIGNED"
  | "PHASE_CHANGED"
  | "CHAT_MESSAGE"
  | "SYSTEM_MESSAGE"
  | "NIGHT_ACTION"
  | "VOTE_CAST"
  | "PLAYER_DIED"
  | "GAME_END";

export interface GameEvent {
  id: string;
  ts: number;
  type: GameEventType;
  visibility: "public" | "private";
  visibleTo?: string[];
  payload: unknown;
}

export interface ChatMessage {
  id: string;
  playerId: string;
  playerName: string;
  content: string;
  timestamp: number;
  day?: number;
  phase?: Phase;
  isSystem?: boolean;
  isStreaming?: boolean;
  speechRound?: number;
  pkSource?: "badge" | "vote";
  isLastWords?: boolean;  // Flag for last words (遗言) messages
}

/** 已结算且公开的投票快照；旧存档中的每日票型仍保留作兼容回退。 */
export interface VoteRound {
  id: string;
  day: number;
  kind: "badge" | "execution";
  round: number;
  candidates: number[];
  votes: Record<string, number>;
  sheriffSeat: number | null;
  winnerSeat: number | null;
  outcome: "elected" | "executed" | "idiot-revealed" | "tie" | "no-votes";
}

export interface GameState {
  gameId: string;
  /** 数据库单人游戏会话的唯一身份；进行中的可恢复状态必须存在。 */
  gameSessionId?: string | null;
  phase: Phase;
  day: number;
  startTime?: number;
  devMutationId?: number;
  devPhaseJump?: { to: Phase; ts: number };
  isPaused?: boolean;
  scenario?: GameScenario;
  isGenshinMode?: boolean;
  isSpectatorMode?: boolean;
  difficulty: DifficultyLevel;
  players: Player[];
  events: GameEvent[];
  messages: ChatMessage[];
  currentSpeakerSeat: number | null;
  nextSpeakerSeatOverride?: number | null;
  daySpeechStartSeat: number | null;
  /** 当前发言轮次开始时的 messages 长度；用于隔离同一天重复进入的 PK/竞选发言。 */
  speechRoundStartMessageIndex?: number | null;
  speechDirection?: SpeechDirection;
  pkTargets?: number[];
  pkSource?: "badge" | "vote";
  badge: {
    holderSeat: number | null;
    candidates: number[];
    signup: Record<string, boolean>;
    votes: Record<string, number>;
    allVotes: Record<string, number>;
    history: Record<number, Record<string, number>>;
    /** 每日警徽竞选最终赢家快照；null 表示该日竞选最终无人当选。 */
    electionWinners?: Record<number, number | null>;
    revoteCount: number;
  };
  votes: Record<string, number>;
  voteReasons?: Record<string, string>;
  lastVoteReasons?: Record<string, string>;
  voteRounds?: VoteRound[];
  voteHistory: Record<number, Record<string, number>>; // day -> { voterId -> targetSeat }
  nightHistory?: Record<
    number,
    {
      /** 夜间结算已由主持人公开，不能用提示词的 phase 代替。 */
      resultsAnnounced?: boolean;
      guardTarget?: number;
      wolfTarget?: number;
      witchSave?: boolean;
      witchPoison?: number;
      seerTarget?: number;
      seerResult?: { targetSeat: number; isWolf: boolean };
      deaths?: Array<{ seat: number; reason: "wolf" | "poison" | "milk" }>;
      hunterShot?: { hunterSeat: number; targetSeat: number };
    }
  >;
  dayHistory?: Record<
    number,
    {
      executed?: { seat: number; votes: number };
      voteTie?: boolean;
      /** 当日放逐投票发生时的警长座位；null 表示当时无警长。 */
      sheriffSeatAtVote?: number | null;
      hunterShot?: { hunterSeat: number; targetSeat: number };
      whiteWolfKingBoom?: { boomSeat: number; targetSeat: number };
      idiotRevealed?: { seat: number };
    }
  >;
  dailySummaries: Record<number, string[]>; // day -> summary bullet list
  dailySummaryFacts: Record<number, DailySummaryFact[]>; // day -> structured facts
  dailySummaryVoteData?: Record<number, DailySummaryVoteData>;
  nightActions: {
    guardTarget?: number;        // 守卫保护的目标
    lastGuardTarget?: number;    // 上一晚守卫保护的目标（不能连续保护同一人）
    wolfVotes?: Record<string, number>;
    wolfTarget?: number;         // 狼人出刀目标
    witchSave?: boolean;         // 女巫是否救人
    witchPoison?: number;        // 女巫毒谁
    seerTarget?: number;
    seerResult?: { targetSeat: number; isWolf: boolean };
    seerHistory?: Array<{ targetSeat: number; isWolf: boolean; day: number }>; // 查验历史
    pendingWolfVictim?: number;  // 待公布的狼人击杀目标（警长竞选后公布）
    pendingPoisonVictim?: number; // 待公布的女巫毒杀目标（警长竞选后公布）
  };
  // 角色能力使用记录
  roleAbilities: {
    witchHealUsed: boolean;      // 女巫解药是否已用
    witchPoisonUsed: boolean;    // 女巫毒药是否已用
    hunterCanShoot: boolean;     // 猎人是否能开枪（被毒死不能开枪）
    idiotRevealed: boolean;      // 白痴是否已翻牌（翻牌后失去投票权但不死）
    whiteWolfKingBoomUsed: boolean; // 白狼王是否已自爆
  };
  winner: Alignment | null;
}

export interface DailySummaryFact {
  fact: string;
  day?: number;
  speakerSeat?: number | null;
  speakerName?: string;
  targetSeat?: number | null;
  targetName?: string;
  type?: "vote" | "claim" | "suspicion" | "defense" | "alignment" | "death" | "switch" | "other";
  evidence?: string;
}

/** Structured vote data extracted from [VOTE_RESULT] to preserve "who voted for whom" for later days. */
export interface DailySummaryVoteData {
  sheriff_election?: { winner: number; votes: Record<string, number[]> };
  execution_vote?: { eliminated: number; votes: Record<string, number[]> };
}

// —— 小愈单模型口径（2026-09-17 重构）——
//
// 上游（wolfcha）在这里维护一张多 provider、二十多个模型的目录
// （Zenmux / 百炼 Dashscope / TokenDance），由用户自带 API Key 来选择。
// 小愈不使用这套：狼人杀的模型调用一律走本站 `POST /api/chat`，由服务端用小愈自己的
// Key 转发，且服务端**有意忽略**客户端传的 model（见 api/routes/wolfchaCompat.ts 顶部说明）。
// 因此这里只保留「一个模型」，运行时取值统一来自 `~/lib/model.ts`。
// （对局存档里可能还带着旧的 provider/model 字符串，ModelRef 的字段仍按 string 读写兼容。）

export const DEFAULT_MODEL_REF: ModelRef = { provider: MODEL_PROVIDER, model: MODEL_ID };

/** 生成角色 / 生成总结 / 生成复盘：小愈只有一个模型，三者相同 */
export const GENERATOR_MODEL = MODEL_ID;
export const SUMMARY_MODEL = MODEL_ID;
export const REVIEW_MODEL = MODEL_ID;

// 下面这几个名字保留，是为了不改动既有调用点（对局状态里也存着 ModelRef）
export const PROJECT_MODELS: ModelRef[] = [DEFAULT_MODEL_REF];
export const AVAILABLE_MODELS: ModelRef[] = PROJECT_MODELS;
export const BUILTIN_PLAYER_MODELS: ModelRef[] = PROJECT_MODELS;
export const PLAYER_MODELS: ModelRef[] = PROJECT_MODELS;
export const ALL_MODELS: ModelRef[] = PROJECT_MODELS;
