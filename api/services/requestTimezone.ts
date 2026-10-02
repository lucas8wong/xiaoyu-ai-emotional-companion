/**
 * 请求时区解析（2026-09-19）：`X-Timezone` 请求头 → 用户那边的「今天/现在」。
 * 单独成模块（不塞进 session.ts）：一是职责单一，二是避免把别的窗口在 session.ts 里的在飞改动
 * 一起卷进本次提交。
 */

import type { Request } from 'express';
import { preferenceStore } from './preferences.js';
import { normalizeTimezone } from './timeAnchor.js';

/**
 * 请求方所在时区（IANA），「时间锚」用它算**用户那边的今天/现在**。
 *
 * 取值优先级：
 *  1. `X-Timezone` 请求头（前端每个请求都带，浏览器 `Intl` 解析），**立刻生效**：
 *     存量用户不必先去设置里开推送、游客也从第一条消息起就对，出国/换设备自动跟随；
 *  2. 用户偏好里已存的时区（历史上报过，或下面第 3 步回写的）；
 *  3. undefined → 调用方回退 APP_DEFAULT_TZ。
 *
 * 顺便把请求头里的时区**回写偏好**（仅当变了才写）：后台链路（记忆提取、主动找我、召回邮件）
 * 不经过这个请求头，回写一次能让它们也用对时区；写失败不影响主流程（时区只是优化项）。
 */
export function resolveUserTimezone(req?: Request, userId?: string): string | undefined {
  const fromHeader = normalizeTimezone(String(req?.headers?.['x-timezone'] || ''));
  if (fromHeader && userId) {
    try {
      if (preferenceStore.get(userId).timezone !== fromHeader) preferenceStore.set(userId, { timezone: fromHeader });
    } catch { /* 忽略 */ }
  }
  if (fromHeader) return fromHeader;
  if (userId) {
    try { return normalizeTimezone(preferenceStore.get(userId).timezone); } catch { /* 忽略 */ }
  }
  return undefined;
}
