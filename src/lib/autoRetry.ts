/**
 * 「AI 没接上」时的**自动重试**策略（2026-09-15 事故后加）
 *
 * 线上事故：用户 13:02:58 发消息 → 连接在传输层断掉 → 因为客户端超时当时完全失效，
 * 请求挂了 37 分钟，最后只在界面上留下一句「网络好像开小差了」。用户的直觉是
 * 「网络抖一下再生就好」，所以这里按这个直觉做：**瞬时失败自动再 call 一次 AI**，
 * 成功则用户完全无感（连提示都不出现）；仍然失败才提示「没发送成功 + 重试」。
 *
 * 边界（刻意保守，避免花冤枉钱 / 破坏剧情）：
 * - 已经收到过内容（流到一半断）：不重试 —— 重试会把这一段剧情接乱（宁可保留半截 + 让用户重发）；
 * - HTTP 4xx（额度不足 / 未登录 / 参数错）业务错误：不重试（重试也没有用，还要提示付费/登录）；
 * - ABORTED（用户自己切会话/取消）：不重试 —— 不能背着用户偷偷再调一次；
 * - 其余（NETWORK / TIMEOUT / 上游 error 帧 / 空回复）：重试，且每次用户动作最多 `AUTO_RETRY_MAX` 次。
 */

/**
 * 自动重试前的等待。**0 = 立即重 call**（用户要求：「出问题基本要马上重 call」）。
 *
 * 为什么 0 是对的：触发重试的都是**连接已经坏掉**的瞬时失败（网络断 / 空闲超时），
 * 等一会儿并不会让那条坏连接变好 —— 立刻发一个新请求反而是最快的恢复路径
 *（新请求会新建连接）。真正需要等待的是「服务端过载」这类情况，那由上游自己的退避重试负责。
 */
export const AUTO_RETRY_DELAY_MS = 0;
/** 每次用户动作最多自动再 call 一次（不做静默无限重试：那会悄悄烧额度） */
export const AUTO_RETRY_MAX = 1;

export interface StreamFailureLike {
  code?: string;
  status?: number;
}

/** 这次失败值不值得自动再 call 一次 AI */
export function shouldAutoRetry(res: StreamFailureLike | null | undefined, gotContent: boolean): boolean {
  if (gotContent) return false;
  // 4xx = 业务错误（额度不足/未登录/参数错）：重试也没用，还要走付费/登录门控
  if (typeof res?.status === 'number' && res.status >= 400 && res.status < 500) return false;
  if ((res?.code || '') === 'ABORTED') return false;
  return true; // NETWORK / TIMEOUT / 5xx（上游报错）/ 空回复 → 值得再 call 一次
}

/** 失败原因码（用于埋点与文案分支）：拿不到 code 时按是否有 HTTP 状态归类 */
export function failCodeOf(res: StreamFailureLike | null | undefined): string {
  const code = (res?.code || '').trim();
  if (code) return code;
  if (typeof res?.status === 'number') return res.status >= 500 ? 'UPSTREAM' : 'HTTP_' + res.status;
  return 'NETWORK';
}
