/**
 * 应用自恢复（2026-09-17 立）
 *
 * 背景：分块（chunk）构建 + 频繁部署的组合会制造一个**必然发生**的故障：
 * 用户浏览器里还是旧页面（长驻标签页 / 已装 PWA / 被 CDN 缓存的 HTML），它按旧 hash 去取
 * `/assets/RoleplayPage-<旧hash>.js`，而新部署里该文件已不存在 —— 关键是**不会 404**：
 * `vercel.json` 的 `{"source":"/(.*)","destination":"/index.html"}` 与本地 `api/app.ts` 的 SPA fallback
 * 都会把它以 **200 + text/html** 返回，于是浏览器以 MIME 错误拒绝该模块，`import()` 拒绝。
 * 没有 ErrorBoundary、也没有 `vite:preloadError` 兜底时，React 直接卸载整棵树 → **整页空白**。
 *
 * 这里做两件事：
 *   1. `reloadOnce()`：遇到「资源版本过期」时**自动刷新一次**（同一会话 10s 内不重复，避免刷新风暴）。
 *   2. `isStaleAssetError()`：把「版本过期」与「真的代码 bug」分开——前者自动刷新，后者交给错误页。
 */
import { ssGet, ssSet } from './safeStorage';

const LAST_RELOAD_KEY = 'cure_reload_at';
const MIN_INTERVAL_MS = 10_000;

/** 这条错误是不是「页面版本过期」（懒加载 chunk 取不到 / 模块 MIME 不对 / 动态 import 失败） */
export function isStaleAssetError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '');
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk \d+ failed|Expected a JavaScript module script/i.test(msg);
}

/**
 * 自动刷新一次（带节流）。返回 true 表示「已经发起刷新」。
 * 用 sessionStorage 记时间戳（它不会跨标签页，也不会在隐私模式下静默失效——失败时按「可以刷新」处理，
 * 因为刷新一次总比白屏好；极端情况下最坏是连刷两次，有 10s 间隔兜底）。
 */
export function reloadOnce(reason: string): boolean {
  const now = Date.now();
  const last = Number(ssGet(LAST_RELOAD_KEY) || '0');
  if (Number.isFinite(last) && last > 0 && now - last < MIN_INTERVAL_MS) return false;
  ssSet(LAST_RELOAD_KEY, String(now));
  try { console.warn('[Xiaoyu] 检测到页面版本过期，自动重新加载：' + reason); } catch { /* 忽略 */ }
  try { window.location.reload(); } catch { /* 忽略 */ }
  return true;
}
