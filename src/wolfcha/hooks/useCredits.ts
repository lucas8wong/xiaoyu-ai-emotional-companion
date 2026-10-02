"use client";

/**
 * 额度与开局扣费（小愈版）
 *
 * 重构说明（2026-09-17）：这个文件原本是上游 wolfcha 的 631 行版本，里面混着**小愈用不到**的
 * 一整套东西：Supabase 登录态、TokenPay 代付、WatchaPay 余额、兑换码（`/api/credits/redeem`）、
 * 邀请码（`/api/credits/referral`）、每日奖励（`/api/credits/daily-bonus`）、新春活动额度
 * （`/api/credits/spring-login-bonus`）、游客迁移（`/api/guest/migrate`），这些端点在 `api/` 里
 * **一个都不存在**（只有 `/api/credits/balance` 与 `/api/credits/consume` 是真的）。
 *
 * 现在只保留小愈真正需要的一条链：**读余额 → 开局扣费（带跨刷新幂等）→ 对局结束清除幂等键**。
 * 身份来自 `~/lib/session`（小愈自己的登录态），请求头由 `adapters/xiaoyu-identity.ts` 统一注入。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchDemoModeConfigClient,
  getDefaultDemoModeConfigSnapshot,
  type DemoModePublicConfigSnapshot,
} from "~/lib/demo-config";
import { MODEL_PROVIDER } from "~/lib/model";
import { getSession, signOut as xiaoyuSignOut, subscribeAuth, type WolfchaSession } from "~/lib/session";
import { fetchWithTimeout } from "~/lib/request-timeout";
import {
  buildGameStartIntentFingerprint,
  completeGameStartRequest as clearPendingGameStartRequest,
  GameStartPersistenceError,
  getOrCreateGameStartRequest,
  hasPendingGameStartRequest as readPendingGameStartRequest,
  runGameStartRequestWithRetry,
  shouldRetryGameStartRequest,
} from "~/lib/game-start-idempotency";

const JSON_CONTENT_TYPE = "application/json";
const DEMO_CONFIG_REFRESH_INTERVAL_MS = 60_000;
const CONSUME_CREDIT_TIMEOUT_MS = 15_000;
const BALANCE_TIMEOUT_MS = 15_000;

export type ConsumeCreditOptions = {
  createSession?: boolean;
  playerCount?: number;
  difficulty?: string;
  usedCustomKey?: boolean;
  modelUsed?: string;
  userEmail?: string | null;
  region?: string | null;
};

export type ConsumeCreditResult = {
  success: boolean;
  credits?: number;
  sessionId?: string | null;
  startRequestId?: string;
  idempotentReplay?: boolean;
  error?: string;
  code?: string;
  recoveryAction?: string;
  status?: number;
  /**
   * 额度被拦时的**可执行**信息（2026-09-27，服务端 `/api/credits/consume` 402 下发）：
   *  - `reason`：`guest` = 游客档本身不够开一局（出路是注册）；`insufficient` = 今天用完了（等明天/获取额度/升级）；
   *    `fair-use` = Pro 公平使用阀；
   *  - `registerHint`：出路是否为「注册」（前端据此决定走注册弹窗还是获取额度弹窗）；
   *  - `neededTiao`：开局准入下限（条）。
   */
  reason?: 'guest' | 'insufficient' | 'fair-use' | string;
  registerHint?: boolean;
  neededTiao?: number;
};

function buildStartIntentFingerprint(options: ConsumeCreditOptions): string {
  return buildGameStartIntentFingerprint({
    createSession: options.createSession === true,
    difficulty: options.difficulty ?? null,
    modelSource: MODEL_PROVIDER,
    modelUsed: options.modelUsed ?? null,
    playerCount: options.playerCount ?? null,
    usedCustomKey: false,
  });
}

export function useCredits() {
  const [session, setSession] = useState<WolfchaSession | null>(() => getSession());
  const user = session?.user ?? null;
  const [credits, setCredits] = useState<number | null>(null);
  /**
   * 一局价（条），由 `/api/credits/balance` 下发（服务端 `CREDIT_PER_GAME_ESTIMATE`）。
   * 2026-09-17 A′ 计费模型要求「开局前告知本局约消耗多少」，所以这里必须拿到真实数值，
   * **不能在前端写死 40**（改价目表时前后端会不一致）。
   */
  const [gameEstimate, setGameEstimate] = useState<number | null>(null);
  /**
   * 开局**准入下限**（条），由 `/api/credits/balance` 下发（服务端 `MIN_START_CREDIT / UNIT_CREDIT`）。
   * 2026-09-27：欢迎页据此**提前**判断「这局开不了」（游客 5 条 < 准入 20 条），直接走统一额度门控，
   * 而不是先发一个注定 402 的请求再弹通用失败提示。拿不到（老服务端）时为 null → 退回旧行为。
   */
  const [minStartTiao, setMinStartTiao] = useState<number | null>(null);
  /** 无限档（Pro）：`credits` 为 null 时用它区分「无限」与「取不到值」（否则会显示成 0 条） */
  const [unlimited, setUnlimited] = useState(false);
  /** 上一局结算回执（A′：局终/退出按真实消耗结算）→ 欢迎页提示「本局实际 X 条，已退回 Y 条」 */
  const [lastSettlement, setLastSettlement] = useState<{ used: number; refunded: number; at?: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const creditsRequestVersion = useRef(0);
  const [demoConfig, setDemoConfig] = useState<DemoModePublicConfigSnapshot>(() =>
    getDefaultDemoModeConfigSnapshot(),
  );
  const [demoConfigLoading, setDemoConfigLoading] = useState(true);
  const [isDemoMode, setIsDemoMode] = useState(false);

  // 登录态：读小愈自己的 token/用户；登录/登出发生在主应用，这里只订阅变化
  useEffect(() => subscribeAuth(() => setSession(getSession())), []);

  const fetchCredits = useCallback(async () => {
    if (!user) {
      // ⚠️ 移植适配：上游这里直接 return，而 loading 初值为 true，
      // 于是「没有 user」时 loading 永远为 true（界面是个永不停的加载态）。
      setLoading(false);
      return;
    }
    const version = ++creditsRequestVersion.current;
    const isCurrent = () => version === creditsRequestVersion.current;
    setLoading(true);
    try {
      // 小愈的余额口径 = 今日还可用次数，与服务端开局闸门 `/api/credits/consume` 同源；
      // 拿不到就保持 null（界面显示 0），不要把整个子应用带崩。
      const res = await fetchWithTimeout("/api/credits/balance", { cache: "no-store" }, BALANCE_TIMEOUT_MS);
      if (res.ok) {
        const payload = (await res.json()) as { credits?: number | null; gameEstimateTiao?: number; minStartTiao?: number; unlimited?: boolean; lastSettlementTiao?: { used: number; refunded: number; at?: number } | null };
        if (isCurrent()) {
          // credits === null 且 unlimited → 无限档；两者都不是 → 取不到值，按 0 处理（老行为）
          setUnlimited(!!payload.unlimited);
          setCredits(payload.credits === null && payload.unlimited ? null : Number(payload.credits) || 0);
          if (typeof payload.gameEstimateTiao === 'number') setGameEstimate(payload.gameEstimateTiao);
          setMinStartTiao(typeof payload.minStartTiao === 'number' ? payload.minStartTiao : null);
          setLastSettlement(payload.lastSettlementTiao ?? null);
        }
      }
    } catch {
      /* 忽略：保持上一次的值 */
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void fetchCredits();
  }, [fetchCredits]);

  const refreshDemoConfig = useCallback(async (forceRefresh = false) => {
    const snapshot = await fetchDemoModeConfigClient(forceRefresh);
    setDemoConfig(snapshot);
    setIsDemoMode(snapshot.active);
    setDemoConfigLoading(false);
    return snapshot;
  }, []);

  useEffect(() => {
    void refreshDemoConfig();
    const timer = window.setInterval(() => {
      void refreshDemoConfig(true);
    }, DEMO_CONFIG_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refreshDemoConfig]);

  const consumeCredit = useCallback(async (options: ConsumeCreditOptions = {}): Promise<ConsumeCreditResult> => {
    if (isDemoMode) return { success: true };
    // ⚠️ 这里**不**要求登录：小愈的游客也有身份（设备指纹，由 adapters/xiaoyu-identity.ts
    // 注入 `X-Device-Id`）。上游那版用 Supabase 会话当「有身份」的判据，照搬会把游客拦在门外。
    if (!session) return { success: false, error: "unauthorized", status: 401 };

    let startIntentFingerprint: string;
    let startRequestId: string;
    try {
      // 开局扣费前必须成功写入持久幂等键；不能用内存状态代替跨刷新保护。
      startIntentFingerprint = buildStartIntentFingerprint(options);
      startRequestId = getOrCreateGameStartRequest(session.user.id, startIntentFingerprint);
    } catch (error) {
      if (error instanceof GameStartPersistenceError) {
        return {
          success: false,
          error: "Game start idempotency storage is unavailable",
          code: error.code,
          status: 503,
        };
      }
      return { success: false, error: "idempotency_storage_unavailable", status: 503 };
    }

    try {
      const requestInit: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": JSON_CONTENT_TYPE,
          "Idempotency-Key": startRequestId,
          // 登录用户带 token；游客不带（身份由 X-Device-Id 认）
          ...(session.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {}),
        },
        body: JSON.stringify({
          ...options,
          usedCustomKey: false,
        }),
      };

      const res = await runGameStartRequestWithRetry(
        () => fetchWithTimeout("/api/credits/consume", requestInit, CONSUME_CREDIT_TIMEOUT_MS),
        2,
      );

      if (!res.ok) {
        let payload: { error?: unknown; code?: unknown; recoveryAction?: unknown; reason?: unknown; registerHint?: unknown; neededTiao?: unknown } = {};
        try {
          payload = (await res.json()) as typeof payload;
        } catch {
          /* 响应不是 JSON：用状态码兜底 */
        }
        if (!shouldRetryGameStartRequest(res.status)) {
          clearPendingGameStartRequest(session.user.id, startRequestId);
        }
        return {
          success: false,
          startRequestId,
          status: res.status,
          error: typeof payload.error === "string" ? payload.error : `request_failed_${res.status}`,
          code: typeof payload.code === "string" ? payload.code : undefined,
          recoveryAction:
            typeof payload.recoveryAction === "string" ? payload.recoveryAction : undefined,
          // 额度拦截的可执行信息（2026-09-27）：WelcomeScreen 据此走统一额度门控而不是通用失败提示
          reason: typeof payload.reason === "string" ? payload.reason : undefined,
          registerHint: payload.registerHint === true,
          neededTiao: typeof payload.neededTiao === "number" ? payload.neededTiao : undefined,
        };
      }

      const payload = (await res.json()) as {
        credits: number;
        sessionId?: string | null;
        idempotentReplay?: boolean;
      };
      if (options.createSession && !payload.sessionId) {
        return { success: false, startRequestId, error: "missing_game_session", status: 502 };
      }
      setCredits(payload.credits);
      return {
        success: true,
        credits: payload.credits,
        sessionId: payload.sessionId ?? null,
        startRequestId,
        idempotentReplay: payload.idempotentReplay === true,
      };
    } catch (error) {
      return {
        success: false,
        startRequestId,
        error: error instanceof Error ? error.message : "network_error",
      };
    }
  }, [isDemoMode, session]);

  const completeGameStartRequest = useCallback((requestId: string | undefined) => {
    if (!requestId || !session?.user.id) return true;
    const cleared = clearPendingGameStartRequest(session.user.id, requestId);
    if (!cleared) {
      console.warn("[credits] Failed to clear completed game-start idempotency key");
    }
    return cleared;
  }, [session]);

  const hasPendingGameStartRequest = useCallback((options: ConsumeCreditOptions) => {
    if (!session?.user.id) return false;
    try {
      return readPendingGameStartRequest(session.user.id, buildStartIntentFingerprint(options));
    } catch {
      // 这里只用于是否展示低余额弹窗；按「可能存在待恢复请求」处理，
      // 真正扣费前仍会严格检查持久化存储并 fail closed。
      return true;
    }
  }, [session]);

  const signOut = useCallback(async () => {
    await xiaoyuSignOut();
    setSession(null);
    setCredits(null);
  }, []);

  return {
    user,
    session,
    credits,
    unlimited,
    gameEstimate,
    minStartTiao,
    lastSettlement,
    loading: loading || demoConfigLoading,
    fetchCredits,
    consumeCredit,
    completeGameStartRequest,
    hasPendingGameStartRequest,
    signOut,
    isDemoMode,
    demoConfig,
    refreshDemoConfig,
  };
}
