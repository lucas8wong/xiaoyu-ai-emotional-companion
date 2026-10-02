import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import AppErrorBoundary from "./components/AppErrorBoundary";
import { isStaleAssetError, reloadOnce } from "./lib/appRecovery";
import "./index.css";
import "./generated-skins.css";
import "./fonts-display.css"; // 自托管展示字体（书法/衬线/圆润/手写等 @font-face，避免外部 googleapis）
import { applyDocumentTitle, getStoredLang, setDefaultLang, setLang, type Lang } from "./i18n";
import { getGeoLang } from "./services/api";
import { captureAttribution } from "./lib/attribution";
import { SW_SCRIPT, checkinPushDevice } from "./services/notifications";
import { installXiaoyuIdentity } from "./wolfcha/adapters/xiaoyu-identity";

/**
 * 身份桥必须**在 React 渲染之前**装好（2026-09-17 修的真实 bug）：
 * 装在 `WolfchaApp` 的 `useEffect` 里时，React 是**子组件 effect 先跑**，
 * 于是狼人杀欢迎页 `useCredits` 的首次 `/api/credits/balance` 会在桥装好之前发出
 * → 请求不带 `Authorization` → 服务端只按设备指纹认成**游客**，
 * 结果 **Pro 用户看到的是免费档的「剩余 20 条」**（用户实测截图就是这个问题）。
 * 放在入口处一次装好，子应用任何请求都带得上身份。函数幂等，重复调用无害。
 */
installXiaoyuIdentity();

/**
 * 全局异常兜底接线（2026-09-17 立，配合 AppErrorBoundary）：
 *   ① `vite:preloadError`：Vite 官方事件，懒加载 chunk 取不到时触发（最常见成因是「部署后旧页面取旧 hash」，
 *      见 src/lib/appRecovery.ts）。这里直接自动刷新一次，用户不需要做任何事；
 *   ② `unhandledrejection` / `error`：只做**记录下来**（统一前缀 [Xiaoyu]），不再让它们静默消失。
 *      注意只记「真正的 JS 异常」（有 error 对象），避免图片 404 之类把 console 刷满。
 */
function installGlobalErrorHooks(): void {
  try {
    window.addEventListener('vite:preloadError', (e) => {
      const reason = String((e as unknown as { payload?: unknown })?.payload ?? 'preloadError');
      // 阻止 Vite 的默认「抛给上层」行为，改为自恢复
      try { (e as Event).preventDefault?.(); } catch { /* 忽略 */ }
      reloadOnce('vite:preloadError ' + reason);
    });
    window.addEventListener('unhandledrejection', (e) => {
      const reason = (e as PromiseRejectionEvent).reason;
      if (isStaleAssetError(reason)) { reloadOnce('unhandledrejection:stale-asset'); return; }
      try { console.error('[Xiaoyu] 未处理的 Promise 拒绝：', reason); } catch { /* 忽略 */ }
    });
    window.addEventListener('error', (e) => {
      const err = (e as ErrorEvent).error;
      if (!err) return; // 资源加载失败（img/script）不在这里刷屏
      if (isStaleAssetError(err)) { reloadOnce('window.onerror:stale-asset'); return; }
      try { console.error('[Xiaoyu] 全局错误：', (err as Error)?.message || err); } catch { /* 忽略 */ }
    });
  } catch { /* 忽略 */ }
}
installGlobalErrorHooks();


// 首访（本地没有语言记录）时的兜底语言：
// 优先用浏览器语言做合理默认（同步、零网络、立即可用于兜底），避免首屏卡在 geo 网络往返；
// 真正的首访默认由 boot() 在 geo 响应后确定（见下），这里只在 geo 失败/超时后作为最终兜底。
// 边界：浏览器语言无法识别时按产品决策默认英文（en）。
function initialLang(): Lang {
  try {
    const stored = getStoredLang();
    if (stored) return stored;
  } catch { /* 忽略 */ }
  try {
    const nav = (navigator.language || '').toLowerCase();
    if (nav.startsWith('zh')) {
      // 繁体 / 港台澳 / 汉繁 → zh-TW；其余中文 → zh-CN
      return (nav.includes('tw') || nav.includes('hk') || nav.includes('mo') || nav.includes('hant')) ? 'zh-TW' : 'zh-CN';
    }
  } catch { /* 忽略 */ }
  return 'en'; // 内网 / 无法识别 → 默认英文（与原决策一致）
}

// 首访等待 geo 返回前的中性加载壳：不含任何语言相关文案。
// 这样用户第一次看到的不会是"先英文后中文"的闪切，正文总在最终语言确定后才渲染。
function BootShell() {
  return (
    <div className="min-h-screen bg-brand flex items-center justify-center">
      <div className="w-8 h-8 rounded-full border-2 border-white/30 border-t-white animate-spin" />
    </div>
  );
}

// 给 geo 解析设一个总超时：即使 /api/geo/lang 因网络/服务端问题走了重试，
// 加载壳也不会长时间卡住（超过就退浏览器语言兜底）。
const GEO_WAIT_MS = 3000;
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((res) => setTimeout(() => res(fallback), ms))]);
}

// 注册 Service Worker（Web Push / PWA）：生产环境（或 localhost）才需要，避免 dev 干扰 HMR
function registerServiceWorker(): void {
  try {
    if ('serviceWorker' in navigator && (window.isSecureContext || location.hostname === 'localhost')) {
      navigator.serviceWorker.register(SW_SCRIPT).then((reg) => {
        // 主动检查更新：让新的 sw.js（如推送皮肤图标）尽快替换旧版本
        reg.update().catch(() => { /* 更新失败不影响主流程 */ });
        // 设备打卡：把当前订阅端点 + 浏览器 UA 报给服务端，让旧订阅也能识别电脑/手机
        checkinPushDevice();
      }).catch(() => { /* SW 注册失败不影响主流程 */ });
    }
  } catch { /* 忽略 */ }
}
registerServiceWorker();

async function boot() {
  // 来源归因：落地第一时间记下 UTM/referrer/落地路径（first-touch 一旦确立就不再被覆盖），
  // 供 reportVisit 上报、注册时 stitch 到账号。必须在渲染前跑，避免路由变化污染 first-touch。
  captureAttribution();
  const container = document.getElementById("root")!;
  const root = createRoot(container);
  /** 统一渲染入口：**所有**渲染都包一层错误边界（渲染期异常=整页空白，见 AppErrorBoundary 注释） */
  const renderTree = (node: ReactNode): void => {
    root.render(<AppErrorBoundary><StrictMode>{node}</StrictMode></AppErrorBoundary>);
  };

  // 已有语言记录（用户选过 / 已校准过）：直接渲染，零等待，后续不会再切语言。
  const stored = getStoredLang();
  if (stored) {
    setDefaultLang(stored);
    applyDocumentTitle();
    renderTree(<App />);
    return;
  }

  // 首访：先渲染无文字加载壳，等 geo 返回确定最终语言后再渲染正文。
  setDefaultLang(initialLang()); // 先用浏览器语言兜底；geo 回来后以 geo 为准
  // ⚠️ **这里刻意不调 applyDocumentTitle()**：那会用浏览器语言抢设一次标题，等 geo 回来再改成地区语言
  //   → 用户看到"标签页标题闪一下英文"。标题先留 index.html 那份中英并列的静态值，
  //   等 geo 落定后在下面两个分支里一次性设好。
  // 另外：加载壳是无文字的（只有转圈），此刻没有"错语言文本"需要遮 → 立刻摘掉语言闪切遮罩，
  //   否则 html[data-lang-swap] #root{visibility:hidden} 会把转圈壳一起藏掉（等 geo 时白屏）。
  document.documentElement.removeAttribute('data-lang-swap');
  renderTree(<BootShell />);

  // geo 明确给出语言时才持久化（二次访问直接用它，不再等待）。
  // 失败/超时/不建议 → 退浏览器语言兜底，但不写存档，保留「首访仍可按 IP 校准」语义。
  const geoLang = (await withTimeout(
    getGeoLang(3000).catch(() => null),
    GEO_WAIT_MS,
    'timeout'
  )) as Lang | null | 'timeout';

  if (geoLang === 'timeout' || geoLang === null) {
    const fallback = initialLang();
    setDefaultLang(fallback);
    applyDocumentTitle(); // 兜底：用浏览器语言作为最终标题
  } else {
    setLang(geoLang); // 持久化，二次访问直接用它
    setDefaultLang(geoLang);
    applyDocumentTitle();
  }

  renderTree(<App />);
}

void boot();
