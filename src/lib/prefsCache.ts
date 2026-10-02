/**
 * 偏好缓存（模块级，全局复用）
 * 目的：偏好面板在聊一聊/理一理/我的-偏好三处复用，首次加载后缓存，
 * 再次打开秒显（不再每次都重新请求后端，避免骨架屏等待）
 */

import { getPreferences, type UserPreferences } from '../services/api';

let cache: UserPreferences | null = null;
let inFlight: Promise<UserPreferences | null> | null = null;

/** 同步读取已缓存的偏好（可能为 null） */
export function getCachedPreferences(): UserPreferences | null {
  return cache;
}

/** 写入缓存（保存成功后调用，保持缓存与后端一致） */
export function setCachedPreferences(p: UserPreferences | null): void {
  if (p) cache = p;
}

/**
 * 清空缓存（2026-09-28 审查 B5）：`clearAuth()` 必须调用。
 * 否则同一个标签页换账号时，下一个账号会**继承**上一个账号的区域/强度/关系档，
 * 更糟的是继承 `adultConfirmed`，客户端的 18+ 门槛会被直接跳过。
 */
export function resetPreferencesCache(): void {
  cache = null;
  inFlight = null;
}

/** 加载偏好：有缓存直接用，无缓存才请求（并发去重） */
export function loadPreferences(): Promise<UserPreferences | null> {
  if (cache) return Promise.resolve(cache);
  if (!inFlight) {
    inFlight = getPreferences().then(r => {
      const d = r.success && r.data ? r.data : null;
      if (d) cache = d;
      return d;
    }).finally(() => { inFlight = null; });
  }
  return inFlight;
}