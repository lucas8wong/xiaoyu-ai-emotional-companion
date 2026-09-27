/**
 * AI 狼人杀 · 前端接口层
 *
 * 复用主 App 的 `apiRequest`（重试 / 超时 / 错误本地化 / 设备指纹 / 语言 / 登录态），
 * 不重写一套 fetch。类型只从引擎**按类型**引入（`import type` 会被编译期抹掉，
 * 前端不会把规则引擎打进包里——规则权威在服务端）。
 */

import { apiRequest } from '../services/api';
import type { GameSize } from './engine/types';
import type { WerewolfView } from './engine/view';

export type { GameSize, WerewolfView };

export interface WerewolfQuota {
  plan: 'free' | 'plus' | 'pro';
  limitToday: number;
  remainToday: number;
}

export interface RosterCharacter {
  id: string;
  name: string;
  avatar?: string;
  isDefault: boolean;
  /** 与该用户的长期记忆条数（局里「记得你」的依据） */
  memoryCount: number;
}

export interface RosterBuiltin {
  id: string;
  name: string;
  identity: string;
}

export interface WerewolfRoster {
  characters: RosterCharacter[];
  builtin: RosterBuiltin[];
  quota: WerewolfQuota;
}

export interface SizeConfig {
  size: GameSize;
  roster: Record<string, number>;
  estimatedCredit: number;
  estimatedCalls: number;
}

export interface WerewolfConfig {
  sizes: SizeConfig[];
  quota: WerewolfQuota;
  builtinCount: number;
}

export interface StartGameResult {
  gameId: string;
  view: WerewolfView;
  estimatedCredit: number;
  quota: WerewolfQuota;
  fallbackCount: number;
}

export interface AdvanceResult {
  view: WerewolfView;
  quota: WerewolfQuota;
  /** true = 已结束或已轮到本人，可以停下来了 */
  done: boolean;
}

export interface SubmitActionResult {
  /** 命中危机内容：对局已中断，界面应切到陪伴路径而不是继续玩 */
  crisis?: boolean;
  code?: string;
  gameId: string;
  view?: WerewolfView;
  quota?: WerewolfQuota;
}

/** 一局要跑几十次模型调用，单请求故意给较长超时（服务端已按 MAX_AI_CALLS_PER_REQUEST 分段） */
const GAME_TIMEOUT_MS = 150_000;

export function getWerewolfConfig() {
  return apiRequest<WerewolfConfig>('/api/werewolf/config');
}

export function getWerewolfRoster() {
  return apiRequest<WerewolfRoster>('/api/werewolf/roster');
}

export function startWerewolfGame(body: { size: GameSize; characterIds: string[] }) {
  return apiRequest<StartGameResult>('/api/werewolf/start', {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: GAME_TIMEOUT_MS,
  });
}

export function advanceWerewolfGame(gameId: string) {
  return apiRequest<AdvanceResult>(`/api/werewolf/${encodeURIComponent(gameId)}/advance`, {
    method: 'POST',
    timeoutMs: GAME_TIMEOUT_MS,
  });
}

export function submitWerewolfAction(
  gameId: string,
  body: { text?: string; target?: number | null; heal?: boolean; poison?: number | null },
) {
  return apiRequest<SubmitActionResult>(`/api/werewolf/${encodeURIComponent(gameId)}/action`, {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: GAME_TIMEOUT_MS,
  });
}

export function getWerewolfGame(gameId: string) {
  return apiRequest<{ view: WerewolfView; quota: WerewolfQuota }>(
    `/api/werewolf/${encodeURIComponent(gameId)}`,
  );
}

export function abandonWerewolfGame(gameId: string) {
  return apiRequest<{ removed: boolean }>(`/api/werewolf/${encodeURIComponent(gameId)}/abandon`, {
    method: 'POST',
  });
}

export function getWerewolfGames() {
  return apiRequest<{ games: unknown[]; quota: WerewolfQuota }>('/api/werewolf/games');
}

/**
 * 一直推进到「轮到我」或「结束」。
 * 服务端每次只跑一小段（防边缘超时），所以这里要循环；`guard` 兜底防死循环。
 */
export async function advanceUntilMyTurn(
  gameId: string,
  onProgress?: (view: WerewolfView) => void,
  guard = 20,
): Promise<WerewolfView | null> {
  let last: WerewolfView | null = null;
  for (let i = 0; i < guard; i++) {
    const res = await advanceWerewolfGame(gameId);
    if (!res.success || !res.data) return last;
    last = res.data.view;
    onProgress?.(res.data.view);
    if (res.data.done) return last;
  }
  return last;
}
