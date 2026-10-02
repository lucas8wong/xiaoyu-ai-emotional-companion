/**
 * 聊天额度的显示换算，**唯一口径**（纯函数，无浏览器依赖，可在 node 测试里直接跑）。
 *
 * 为什么单独成文件：这段逻辑原来长在 `src/services/api.ts` 里，而 `api.ts` 顶层用了
 * `import.meta.env`，node 测试跑不起来（所以它一直没被单测覆盖）。
 *
 * ⚠️ **无限档返回的是 JS 的 `Infinity`**（Pro / 终身 / 7 天 Pro 体验 / 后端把无限编码成 `null` 的情形）。
 *    `Infinity` 是内部哨兵值，**绝不能**直接插进 i18n 模板：
 *    `t('chatQuotaCredit', { n: Infinity })` 会渲染成
 *    「額度剩餘 ≈ 還能聊 **Infinity** 條」（2026-09-17 线上真机就是这个）。
 *    渲染前先问 `quotaIsUnlimited()`，是则显示「无限」。
 */

/**
 * 额度换算只读这几个字段（与 `services/api.ts` 的 `QuotaInfo` 结构兼容，无需强转）。
 */
export interface QuotaRemainFields {
  /** 是否开启统一点数计费（开关关闭时走旧的「条数」字段） */
  creditEnabled?: boolean;
  /** 统一口径下的无限档（Pro）：后端把数值字段编码成 null，靠这个标记区分「无限」与「0」 */
  creditUnlimited?: boolean;
  /** 剩余点数（无限档为 null） */
  creditRemain?: number | null;
  /** 1 标准单次 ≈ 普通聊一聊短消息的平均点数（后端 UNIT_CREDIT，默认 2） */
  unitCredit?: number;
  plan?: 'free' | 'plus' | 'pro';
  lifetime?: boolean;
  chatLimitPerDay?: number | null;
  chatUsedToday?: number;
  chatFreeRemain?: number;
}

/** 后端没给/给了 0 时的兜底单次点数（与 `api/services/quota.ts` 的 UNIT_CREDIT 默认值保持一致） */
const DEFAULT_UNIT_CREDIT = 2;

/**
 * 把当前用户聊天额度换算成「还能聊 N 条」。
 * 开启点数时按 `creditRemain / unitCredit`；否则按旧条数字段。
 *
 * @returns 条数；**无限档返回 `Infinity`**，插进文案前先过 {@link quotaIsUnlimited}。
 */
export function quotaChatRemain(quota: QuotaRemainFields | null | undefined): number {
  if (!quota) return Infinity;
  if (quota.creditEnabled) {
    if (quota.creditUnlimited) return Infinity; // 无限档：不能走下面的 `?? 0`（后端把无限编码成 null）
    const unit = quota.unitCredit || DEFAULT_UNIT_CREDIT;
    return Math.floor((quota.creditRemain ?? 0) / unit);
  }
  if (quota.plan === 'pro' || quota.lifetime) return Infinity;
  if (quota.plan === 'plus') return Math.max(0, (quota.chatLimitPerDay ?? 0) - (quota.chatUsedToday ?? 0));
  return quota.chatFreeRemain ?? 0;
}

/**
 * 额度是否为「无限」（Pro / 终身 / 7 天 Pro 体验，以及还没拿到额度时的保守处理）。
 *
 * 界面据此显示「无限畅聊」，**不要**把 `quotaChatRemain()` 的数字直接插进 `{ n }`
 * `Infinity` 在三种语言里都会印成英文单词（繁中「還能聊 Infinity 條」就是这么来的）。
 */
export function quotaIsUnlimited(quota: QuotaRemainFields | null | undefined): boolean {
  return !Number.isFinite(quotaChatRemain(quota));
}
