/**
 * 带护栏的浏览器存储访问（2026-09-17 立）
 *
 * 为什么需要它：`localStorage` / `sessionStorage` 在真实用户环境里**会直接抛异常**，而不是返回 null：
 *   · Safari 无痕/隐私模式、iOS「阻止跨站跟踪」下的部分场景；
 *   · 内嵌 WebView（Instagram / Facebook / 抖音等 App 内打开）里第三方存储被拦；
 *   · 浏览器设置里禁用了 Cookie/网站数据；企业策略/扩展拦截。
 * 而本项目大量代码是 `localStorage.getItem(...)` 裸调（或包在 try 里，或**没包**）。
 * 一旦抛在**渲染路径**上（模块顶层、`useState` 初始化器、挂载期 effect），React 没有 ErrorBoundary
 * 时会卸载整棵树 → 用户看到的就是**一片空白的页面**，且没有任何可恢复入口。
 *
 * 这里给四个常用入口加护栏：读失败 = 当作「没有存过」，写失败 = 静默丢弃（不阻断交互）。
 * 新代码请一律用这里的方法；老代码按「渲染路径优先」逐步替换（审计见 temp/audit-sustainability.txt）。
 */

/** 读字符串（失败 → null） */
export function lsGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** 写字符串（失败 → 静默忽略；存储不可用时功能降级，而不是白屏） */
export function lsSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* 忽略：存储不可用 */ }
}

/** 删键（失败 → 静默忽略） */
export function lsRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* 忽略 */ }
}

/** 读 JSON（键不存在 / 解析失败 / 存储不可用 → fallback） */
export function lsGetJson<T>(key: string, fallback: T): T {
  const raw = lsGet(key);
  if (raw == null) return fallback;
  try {
    const v = JSON.parse(raw) as T;
    return v == null ? fallback : v;
  } catch { return fallback; }
}

/** sessionStorage 版（会话级；用法同上） */
export function ssGet(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
export function ssSet(key: string, value: string): void {
  try { sessionStorage.setItem(key, value); } catch { /* 忽略 */ }
}
