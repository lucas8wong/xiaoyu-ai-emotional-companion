/**
 * wolfcha 子应用 ↔ 小愈身份桥
 *
 * 上游客户端的每一次请求（`/api/chat`、`/api/credits/consume` …）自带的鉴权是 **Supabase session**，
 * 而小愈不使用 Supabase（用户要求：密钥与登录用小愈自己的）。这里在**不改它业务代码**的前提下，
 * 给它发往本站的请求补上小愈的身份头（`X-Device-Id` / `Authorization` / `X-Lang`），
 * 于是服务端 `resolveUserId(req)` 能正常认人：计费、每日局数闸门、运营端统计都落在这套身份上。
 *
 * 幂等安装；只对本站请求生效，不影响它可能发出的第三方请求。
 */
import { getDeviceId, getToken } from '../../services/api';
import { getLang } from '../../i18n';

type Marked = { __xiaoyuIdentityInstalled?: boolean };

export function installXiaoyuIdentity(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Marked;
  if (w.__xiaoyuIdentityInstalled) return;
  w.__xiaoyuIdentityInstalled = true;

  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const sameOrigin =
        typeof url === 'string' && (url.startsWith('/') || url.includes(window.location.host));

      if (sameOrigin) {
        const base = input instanceof Request ? (input as Request).headers : undefined;
        const headers = new Headers(init?.headers ?? base ?? undefined);
        if (!headers.has('X-Device-Id')) headers.set('X-Device-Id', getDeviceId());
        const token = getToken();
        if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
        if (!headers.has('X-Lang')) headers.set('X-Lang', getLang());
        return original(input as RequestInfo, { ...(init || {}), headers });
      }
    } catch {
      /* 任何异常都不该影响原请求 */
    }
    return original(input as RequestInfo, init);
  };
}
