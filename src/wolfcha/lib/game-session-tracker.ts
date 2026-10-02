/**
 * 游戏会话追踪器
 *
 * 在关键游戏阶段（天黑/天亮/发言）记录和更新游戏数据。
 * 所有写操作统一走服务端 API，避免依赖客户端数据库权限或策略。
 */

import { getSession } from "~/lib/session";
import { fetchDemoModeConfigClient } from "~/lib/demo-config";
import { getGuestId } from "~/lib/demo-mode";
import { fetchWithTimeout, withTimeout } from "~/lib/request-timeout";

export interface GameSessionConfig {
  playerCount: number;
  difficulty?: string;
  usedCustomKey: boolean;
  modelUsed?: string;
  sessionId?: string | null;
}

export type GameSessionStatus =
  | "starting"
  | "running"
  | "failed"
  | "abandoned"
  | "completed";

interface SessionState {
  sessionId: string | null;
  userId: string | null;
  startTime: number;
  config: GameSessionConfig | null;
  roundsPlayed: number;
  lastSyncTime: number;
}

const createInitialState = (): SessionState => ({
  sessionId: null,
  userId: null,
  startTime: 0,
  config: null,
  roundsPlayed: 0,
  lastSyncTime: 0,
});

const state: SessionState = createInitialState();

// 防抖：避免短时间内重复同步
const SYNC_DEBOUNCE_MS = 5000;
const SESSION_READ_TIMEOUT_MS = 10_000;
const SESSION_API_TIMEOUT_MS = 15_000;
const AUTHORIZED_SESSION_ACTOR_ID = "authorized_session";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toErrorDebugObject(error: unknown): Record<string, unknown> {
  if (error == null) return { error: null };
  if (!isRecord(error)) return { error };
  const obj = error;
  const ownProps = Object.getOwnPropertyNames(error).reduce<Record<string, unknown>>((acc, k) => {
    acc[k] = obj[k];
    return acc;
  }, {});
  return {
    ...ownProps,
    message: typeof obj.message === "string" ? obj.message : undefined,
    code: obj.code,
    details: obj.details,
    hint: obj.hint,
    name: obj.name,
  };
}

async function parseJsonObject(response: Response): Promise<Record<string, unknown>> {
  const json: unknown = await response.json().catch(() => ({}));
  return isRecord(json) ? json : {};
}

async function getAccessToken(): Promise<string | null> {
  return getSession()?.accessToken ?? null;
}

async function createSessionViaApi(payload: {
  playerCount: number;
  difficulty?: string;
  usedCustomKey: boolean;
  modelUsed?: string;
  userEmail?: string | null;
  region?: string | null;
  guestId?: string;
}): Promise<{ ok: true; sessionId: string } | { ok: false; error: unknown; status?: number }> {
  const token = await getAccessToken();
  const demoConfig = await fetchDemoModeConfigClient();
  const isGuest = !token && demoConfig.active;
  if (!token && !isGuest) return { ok: false, error: new Error("Missing access token") };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (payload.guestId) {
    headers["X-Guest-Id"] = payload.guestId;
  }

  try {
    const res = await fetchWithTimeout("/api/game-sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "create", ...payload }),
    }, SESSION_API_TIMEOUT_MS);
    const json = await parseJsonObject(res);
    const sessionId = typeof json.sessionId === "string" ? json.sessionId : null;
    if (!res.ok || !sessionId) {
      return { ok: false, status: res.status, error: json };
    }
    return { ok: true, sessionId };
  } catch (error) {
    return { ok: false, error };
  }
}

async function updateSessionViaApi(payload: {
  sessionId: string;
  guestId?: string;
  lifecycleStatus: GameSessionStatus;
  winner?: "wolf" | "villager" | null;
  completed: boolean;
  roundsPlayed: number;
  durationSeconds: number;
}): Promise<{ ok: true } | { ok: false; error: unknown; status?: number }> {
  const token = await getAccessToken();
  const demoConfig = await fetchDemoModeConfigClient();
  const isGuest = !token && demoConfig.active;
  if (!token && !isGuest) return { ok: false, error: new Error("Missing access token") };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (payload.guestId) {
    headers["X-Guest-Id"] = payload.guestId;
  }

  try {
    const res = await fetchWithTimeout("/api/game-sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "update", ...payload }),
    }, SESSION_API_TIMEOUT_MS);
    const json = await parseJsonObject(res);
    if (!res.ok || json.success !== true) {
      return { ok: false, status: res.status, error: json };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * ⚠️ 已替换为本地桩（移植适配，非上游原样）
 *
 * 上游这里把对局会话上报到它自己的服务端（guest session / 观测）。小愈没有这些接口，
 * 实测表现为开局时 `createGuestSession` 拿到 404 -> 抛 `Error: API not found` -> 整局开不起来。
 * 按 A 方案（会话/观测与计费一并旁路），这里换成不发任何请求的本地桩：
 * 所有方法都返回一个可用的本地 session，对局本身仍由客户端状态机正常推进。
 * 上游实现见 vendor/wolfcha/src/lib/game-session-tracker.ts
 */
export const gameSessionTracker: any = (() => {
  const SESSION_ID = 'xiaoyu-local-session';
  const noopResult = () => ({
    ok: true,
    success: true,
    status: 'active' as GameSessionStatus,
    sessionId: SESSION_ID,
    session_id: SESSION_ID,
    id: SESSION_ID,
  });
  return new Proxy({}, {
    get(_t, key) {
      if (key === 'then') return undefined;
      /**
       * ⚠️ `start()` 的返回值会被**直接当作对局状态的 `gameSessionId`**：
       *   `sessionId = await gameSessionTracker.start({...})` → `setGameState({ gameSessionId: sessionId })`
       * 而 `hasGameSessionId()` 要求它是**非空字符串**。这里若返回对象，存档会被判为
       * 「不可恢复」并**被删除** —— 实测后果是**刷新网页就丢局**（排查了很久的根因）。
       * 因此 start 必须返回字符串 id。
       */
      if (key === 'start') return async () => SESSION_ID;
      // noopResult() 已含 sessionId / status，重复声明会被展开覆盖（TS2783），直接返回即可（2026-09-28 C2）。
      if (key === 'getSummary') return () => noopResult();
      return async () => noopResult();
    },
  });
})();
