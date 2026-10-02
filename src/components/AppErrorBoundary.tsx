/**
 * 全局错误边界（2026-09-17 立）
 *
 * 为什么必须有：全站此前**没有任何 ErrorBoundary**。React 18 在渲染/提交期抛错且无边界时，
 * 会把整棵树卸载 → 用户看到的是一片空白页（连顶栏都没有），且页面上**没有任何可点的入口**，
 * 只能靠自己想到「刷新」。用户报「点进某个剧情是空白页，我这里没问题」时，这类故障无法从用户侧区分，
 * 排查只能靠猜：错误边界把它变成一页看得见、点得动、报得出的界面。
 *
 * 两类错误分开处理：
 *   · **页面版本过期**（懒加载 chunk 取不到，见 src/lib/appRecovery.ts）→ 自动刷新一次，无需用户操作；
 *   · **代码异常** → 显示中性文案 + 可展开的错误原文 + 「重新加载 / 重试」，并把错误打到 console
 *     （统一前缀 `[Xiaoyu]`，用户截图 console 即可定位）。
 *
 * 注意：错误边界只兜**渲染期**错误；事件处理器里的错误需要用 try/catch 自己兜（不是这里的事）。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '../i18n';
import { isStaleAssetError, reloadOnce } from '../lib/appRecovery';

interface Props { children: ReactNode }
interface State { error: Error | null; stale: boolean }

/** i18n 取值失败也不能再抛（否则错误页本身会把页面搞白） */
function safeT(key: string): string {
  try { return t(key); } catch { return key; }
}

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stale: false };

  static getDerivedStateFromError(error: Error): State {
    return { error, stale: isStaleAssetError(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 版本过期：自动刷新一次（带 10s 节流），用户不用做任何事
    if (isStaleAssetError(error)) {
      reloadOnce('chunk-load-failed');
    }
    try {
      // 统一前缀 + 组件栈：用户截图 console 就能定位；也便于日后接错误上报端点
      console.error('[Xiaoyu] 渲染异常：' + (error?.message || error), '\n组件栈：', info?.componentStack || '(无)');
    } catch { /* 忽略 */ }
  }

  private retry = (): void => {
    this.setState({ error: null, stale: false });
  };

  private reload = (): void => {
    try { window.location.reload(); } catch { /* 忽略 */ }
  };

  render(): ReactNode {
    const { error, stale } = this.state;
    if (!error) return this.props.children;

    const title = safeT(stale ? 'errAppStaleTitle' : 'errAppTitle');
    const body = safeT(stale ? 'errAppStaleBody' : 'errAppBody');

    return (
      <div className="min-h-screen bg-brand flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-md bg-white rounded-2xl border border-clay-border shadow-soft p-6 text-center">
          <div className="text-3xl mb-2" aria-hidden>🌱</div>
          <h1 className="text-lg font-bold text-ink">{title}</h1>
          <p className="mt-2 text-sm text-gray-600 leading-relaxed">{body}</p>

          <button
            type="button"
            onClick={this.reload}
            className="mt-5 w-full bg-primary-strong text-white font-semibold rounded-full py-3 hover:bg-primary active:scale-[0.99] transition-all"
          >
            {safeT('errAppReload')}
          </button>
          {!stale && (
            <button
              type="button"
              onClick={this.retry}
              className="mt-2 w-full bg-gray-100 text-gray-700 font-medium rounded-full py-2.5 hover:bg-gray-200 transition-all"
            >
              {safeT('errAppRetry')}
            </button>
          )}

          {!stale && (
            <details className="mt-4 text-left">
              <summary className="text-xs text-ink-soft cursor-pointer select-none">{safeT('errAppDetail')}</summary>
              <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-gray-50 border border-gray-100 p-2 text-[11px] leading-snug text-gray-600 whitespace-pre-wrap break-words">
                {String(error?.message || error)}
              </pre>
            </details>
          )}
        </div>
      </div>
    );
  }
}
