
export type DemoModePublicConfigSnapshot = {
  source: "database";
  enabled: boolean;
  active: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  serverNow: string;
};


let cachedDemoModeConfig: DemoModePublicConfigSnapshot | null = null;

export function getDefaultDemoModeConfigSnapshot(now: Date = new Date()): DemoModePublicConfigSnapshot {
  return {
    source: "database",
    enabled: false,
    active: false,
    startsAt: null,
    expiresAt: null,
    serverNow: now.toISOString(),
  };
}

export function getCachedDemoModeConfig(): DemoModePublicConfigSnapshot | null {
  return cachedDemoModeConfig;
}

export function setCachedDemoModeConfig(snapshot: DemoModePublicConfigSnapshot) {
  cachedDemoModeConfig = snapshot;
}

export function isCachedDemoModeActiveClient(): boolean {
  return cachedDemoModeConfig?.active ?? false;
}

export async function fetchDemoModeConfigClient(_forceRefresh = false): Promise<DemoModePublicConfigSnapshot> {
  // ⚠️ 移植适配：不请求上游的 demo 配置接口（我们服务器没有它，会 404 污染 console），
  // 直接返回「未启用」的默认快照。
  // 注：曾有一版恒为 active 以旁路计费（A 方案）；现已接入小愈 quota，
  // 演示模式**必须为 false**，否则 `startGameWithCreditGuard(skipCredit)` 会跳过额度闸门。
  // 真实拉取（若将来要 demo 活动）见 vendor/wolfcha/src/lib/demo-config.ts。
  return {
    source: "database",
    enabled: false,
    active: false,
    startsAt: null,
    expiresAt: null,
    serverNow: new Date().toISOString(),
  };
}

