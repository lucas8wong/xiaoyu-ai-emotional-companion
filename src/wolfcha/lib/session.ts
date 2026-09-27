/**
 * 小愈 · AI 狼人杀 —— 登录态（唯一出口）
 *
 * 重构说明（2026-09-17）：上游用 Supabase Auth（`lib/supabase.ts`，在小愈里原本是我方打桩的
 * 空实现）。小愈**不使用 Supabase**，登录态只有一个来源：小愈自己的 `~/services/api`
 * （token 与用户信息存 localStorage，由主应用的登录流程写入）。
 *
 * 子应用里已经没有登录 UI（上游那套 AuthModal 已删），所以这里只做两件事：
 *   ① 读当前登录态；② 订阅变化（跨标签页 storage 事件 + 回到前台 + 本页显式通知）。
 * 需要登录/注册/找回密码时，请回小愈主应用，不要再往子应用里加一套。
 */
import { getToken, getStoredUser, getDeviceId, clearAuth, type AuthUser } from "../../services/api";

export interface WolfchaUser {
  id: string;
  email?: string | null;
  /** 游客：没有 token，靠设备指纹识别（服务端 resolveUserId 同时认两者） */
  isGuest: boolean;
}

export interface WolfchaSession {
  /** 登录用户才有 token；游客为空串，请求靠 `X-Device-Id` 认人 */
  accessToken: string;
  /** 形状对齐上游的 `session.user.id`（多处代码按这个取用户 id） */
  user: WolfchaUser;
}

const AUTH_CHANGE_EVENT = "xiaoyu:auth-change";
const TOKEN_STORAGE_KEY = "cure_app_token";
const USER_STORAGE_KEY = "cure_app_user";

function toUser(stored: AuthUser | null): WolfchaUser | null {
  if (stored?.userId) {
    return { id: stored.userId, email: stored.email ?? null, isGuest: false };
  }
  // ⚠️ 关键：小愈的**游客也有身份**（设备指纹）。上游靠 Supabase 会话表示「有身份」，
  // 小愈则同时认 token 与 `X-Device-Id`；这里若在无 token 时返回 null，
  // 游客会被判定为「未登录」→ 开局被拦（实测：入口按钮也会整块消失）。
  const deviceId = getDeviceId();
  if (!deviceId) return null;
  return { id: deviceId, email: null, isGuest: true };
}

export function getCurrentUser(): WolfchaUser | null {
  return toUser(getStoredUser());
}

export function getSession(): WolfchaSession | null {
  const user = toUser(getStoredUser());
  if (!user) return null;
  return { accessToken: getToken(), user };
}

/** 订阅登录态变化；返回取消订阅函数 */
export function subscribeAuth(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key === TOKEN_STORAGE_KEY || event.key === USER_STORAGE_KEY) listener();
  };
  // 从主应用切回来时 token 可能已经变了（同标签页的 storage 事件不会触发）
  const onFocus = () => listener();

  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", onFocus);
  window.addEventListener(AUTH_CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener(AUTH_CHANGE_EVENT, listener);
  };
}

/** 本页显式改过登录态后调用（同标签页的 storage 事件不会触发） */
export function notifyAuthChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(AUTH_CHANGE_EVENT));
}

/** 退出登录：通知服务端 + 清本地登录态 */
export async function signOut(): Promise<void> {
  const token = getToken();
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
  } catch {
    /* 服务端登出失败也要把本地清干净，否则界面会卡在“已登录” */
  }
  clearAuth();
  notifyAuthChanged();
}
