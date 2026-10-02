/**
 * 小愈 · AI 狼人杀，模型口径（唯一出口）
 *
 * 重构背景（2026-09-17）：上游 wolfcha 把这套放在 `lib/api-keys.ts` 里，客户端要管
 * **三套 provider**（Zenmux / 百炼 Dashscope / TokenDance）、**用户自带 API Key**、
 * **TokenPay 代付恢复**、模型目录与「每个 AI 玩家用不同模型」。
 *
 * 小愈**不使用其中任何一项**：狼人杀的所有模型调用都打到本站 `POST /api/chat`
 * （`api/routes/wolfchaCompat.ts`），由服务端用小愈自己的 DeepSeek Key 转发，
 * 并且服务端**有意忽略**客户端传的 `model` / `provider` 字段。
 * 因此客户端只需要一个模型标识（用于日志、提示词元信息与存档），不再有 provider 选择、
 * 不再携带任何第三方 Key 头、不再有代付与额度恢复逻辑。
 *
 * 需要换模型时：改这里一处（或直接由服务端决定），不要再把 provider 概念加回来。
 */

/** 小愈侧唯一模型（服务端实际用哪个由 `api/routes/wolfchaCompat.ts` 决定） */
export const MODEL_ID = "deepseek-v4-flash";

/** 来源标记：只用于日志/存档，不再是「provider」概念 */
export const MODEL_PROVIDER = "xiaoyu";

export function getModelId(): string {
  return MODEL_ID;
}
