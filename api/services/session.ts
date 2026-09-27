/**
 * 用户识别工具
 * 登录用户 → 账号 userId（跨设备、跟账号走）
 * 游客 → 设备指纹 + IP 哈希（限设备）
 */

import type { Request } from 'express';
import { accountStore } from './accounts.js';
import { quotaStore } from './quota.js';

/**
 * 从请求头解析登录用户
 */
export function getAuthUser(req: Request) {
  const auth = String(req.headers['authorization'] || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  return accountStore.getTokenUser(token);
}

/**
 * 解析用户唯一标识：
 * 登录 → 账号 userId；游客 → 设备指纹+IP 哈希
 */
export function resolveUserId(req: Request): string {
  const user = getAuthUser(req);
  if (user) return user.userId;
  return guestIdOf(String(req.headers['x-device-id'] || ''), req.ip || '');
}

/**
 * 游客身份（设备指纹 + IP 哈希），并给该游客记录打上「纯设备指纹」标签
 * （注册时据此归并「同设备不同 IP」的历史记录：孤儿邀请奖励归因）。
 */
export function guestIdOf(deviceId: string, ip?: string): string {
  const id = quotaStore.identify(deviceId, ip || '');
  quotaStore.setDeviceKey(id, deviceId);
  return id;
}

/**
 * 解析登录用户，允许用**兜底 token**（缺 Authorization 头的上报才需要）。
 * 只给「无权限语义」的上报端点用；有权限语义的接口一律走 getAuthUser(req)。
 */
export function getAuthUserWithFallback(req: Request, fallbackToken?: string) {
  const user = getAuthUser(req);
  if (user) return user;
  const token = String(fallbackToken || '').trim();
  return token ? accountStore.getTokenUser(token) : null;
}

/**
 * 解析用户唯一标识，允许调用方传入**兜底身份**（`deviceId` / `token`）。
 *
 * 为什么需要（2026-09-18）：使用时长心跳的兜底 flush 用 `navigator.sendBeacon`，而 Beacon API
 * **无法携带自定义请求头** → 请求到了服务端既没有 `X-Device-Id` 也没有 `Authorization`，
 * 只能按 IP 认人，于是每个出口 IP 被记成一个「无设备身份」的幽灵游客（真数据：259 个幽灵身份、
 * 占总时长 13.5%）。前端改为把身份放进 body，这里做兜底解析，让那段时间回到真人名下。
 *
 * ⚠️ 边界：只有计时类端点（`/api/usage-time/hit`）用它；有权限语义的接口必须走 resolveUserId(req)。
 */
export function resolveUserIdWithFallback(
  req: Request,
  fallback?: { deviceId?: string; token?: string }
): string {
  const user = getAuthUserWithFallback(req, fallback?.token);
  if (user) return user.userId;
  const deviceId = String(req.headers['x-device-id'] || '') || String(fallback?.deviceId || '');
  return guestIdOf(deviceId, req.ip || '');
}

/**
 * 当前是否登录用户
 */
export function isLoggedIn(req: Request): boolean {
  return getAuthUser(req) !== null;
}

/**
 * 归属校验（防 IDOR）：会话/订单等记录必须属于当前调用者。
 * 规则：record.userId 为空（未归属/遗留数据）→ 允许（调用方可认领）；
 *       非空且 ≠ 当前用户 → 拒绝（返回 false，路由层应回 404 不暴露存在性）。
 * 登录用户按账号 userId 比对；游客按设备指纹+IP 哈希比对（与 resolveUserId 一致）。
 */
export function isRecordOwner(req: Request, record: { userId?: string | null }): boolean {
  const currentUserId = resolveUserId(req);
  if (!record.userId) return true;
  return record.userId === currentUserId;
}
