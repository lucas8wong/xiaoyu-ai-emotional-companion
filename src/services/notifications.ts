/**
 * PWA Web Push 订阅/取消订阅的浏览器侧封装。
 * 前端「AI 主动找我（推送通知）」开关依赖它。
 */
import { getPushVapid } from './api';

/** Service Worker 脚本地址。带固定版本号：站点在 Cloudflare 后、旧 sw.js 曾被 7 天缓存，
 *  版本号让注册 URL 带 query 绕过 CDN 缓存，保证每次改 sw.js 后浏览器能拉到新版。 */
export const SW_SCRIPT = '/sw.js?v=2';

/** 当前环境是否支持推送（需要 serviceWorker + PushManager + 安全上下文/localhost） */
export function isPushSupported(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  return 'serviceWorker' in navigator && 'PushManager' in window && (window.isSecureContext || location.hostname === 'localhost');
}

/** base64url → Uint8Array（VAPID applicationServerKey 需要） */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

let swPromise: Promise<ServiceWorkerRegistration> | null = null;
function getRegistration(): Promise<ServiceWorkerRegistration> {
  if (!swPromise) swPromise = navigator.serviceWorker.register(SW_SCRIPT);
  return swPromise;
}

/** 设备『打卡』：App 打开时把当前订阅端点 + 浏览器 User-Agent 上报，让旧订阅也能在控制台识别设备 */
export async function checkinPushDevice(): Promise<void> {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await fetch('/api/reengage/push/device', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
  } catch { /* 忽略 */ }
}

/** 当前通知权限 */
export function getPushPermission(): NotificationPermission {
  if (typeof Notification === 'undefined') return 'denied';
  return Notification.permission;
}

export type PushSubscribeResult =
  | { ok: true; subscription: PushSubscriptionJSON }
  | { ok: false; reason: 'unsupported' | 'denied' | 'error'; message?: string };

/**
 * 订阅推送：请求权限 → 注册 SW → 订阅（返回可序列化的 subscription，由调用方 POST 给后端）。
 * 明确区分「不支持 / 权限被拒 / 订阅出错」，避免把真实错误误判成权限问题。
 */
export async function subscribeToPush(): Promise<PushSubscribeResult> {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' };
  let permission = getPushPermission();
  if (permission === 'denied') return { ok: false, reason: 'denied' };
  if (permission === 'default') {
    permission = await Notification.requestPermission();
  }
  if (permission !== 'granted') return { ok: false, reason: 'denied' };
  try {
    const reg = await getRegistration();
    const existing = await reg.pushManager.getSubscription();
    if (existing) return { ok: true, subscription: existing.toJSON() };
    const keyRes = await getPushVapid();
    const key = keyRes.success && keyRes.data?.publicKey ? keyRes.data.publicKey : null;
    if (!key) return { ok: false, reason: 'error', message: '无法获取推送密钥' };
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
    if (!subscription) return { ok: false, reason: 'error', message: '订阅返回为空' };
    return { ok: true, subscription: subscription.toJSON() };
  } catch (e) {
    return { ok: false, reason: 'error', message: (e as Error)?.message || '推送订阅失败' };
  }
}

/** 取消订阅：返回被移除端点的 endpoint（供后端清理）；无订阅返回 null */
export async function unsubscribeFromPush(): Promise<string | null> {
  if (!isPushSupported()) return null;
  const reg = await getRegistration();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return endpoint;
}
