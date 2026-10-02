/**
 * 「用 Google 继续」按钮（Google Identity Services / GIS）。
 *
 * 三条硬约束：
 *  1. **必须用官方按钮**（google.accounts.id.renderButton）——Google 品牌规范不允许自己画一个
 *     「G」图标 + 自造文案，也不允许改动按钮外观；
 *  2. 脚本**只注入一次**（模块级 Promise 缓存），多个 tab 反复挂载不会重复插 script；
 *  3. clientId 为空 / 脚本加载失败 → **渲染 null**。线上没配好时宁可没有按钮，
 *     也不要出现一个点了弹报错的按钮。
 *
 * 拿到的是 ID token（credential，JWT），原样交给服务端验签 —— 浏览器侧不做任何信任判断。
 */

import { useEffect, useRef, useState } from 'react';
import { getLang } from '../i18n';

const GIS_SRC = 'https://accounts.google.com/gsi/client';

/** GIS 只暴露这两个方法给我们用；这里按需最小声明，避免引入 @types/gsi */
interface GsiIdApi {
  initialize: (options: Record<string, unknown>) => void;
  renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
}
interface GsiNamespace {
  accounts?: { id?: GsiIdApi };
}
declare global {
  interface Window { google?: GsiNamespace }
}

let gisPromise: Promise<boolean> | null = null;

function loadGis(): Promise<boolean> {
  if (typeof document === 'undefined') return Promise.resolve(false);
  if (gisPromise) return gisPromise;
  gisPromise = new Promise<boolean>((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src="' + GIS_SRC + '"]');
    if (existing) { resolve(true); return; }
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(true);
    // 加载失败（断网/被 CSP 拦）→ 清掉缓存允许下次重试，并且不渲染按钮
    script.onerror = () => { gisPromise = null; resolve(false); };
    document.head.appendChild(script);
  });
  return gisPromise;
}

/** GIS 自己的 locale 命名（下划线），与站内 zh-CN / zh-TW / en 不是同一套 */
const GIS_LOCALE: Record<string, string> = { 'zh-CN': 'zh_CN', 'zh-TW': 'zh_TW', en: 'en' };

interface GoogleSignInButtonProps {
  /** 后端的 GOOGLE_CLIENT_ID；为空则整个按钮不渲染 */
  clientId?: string;
  onCredential: (credential: string) => void;
  disabled?: boolean;
}

export default function GoogleSignInButton({ clientId, onCredential, disabled = false }: GoogleSignInButtonProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  // 回调放进 ref：initialize 只在 clientId 变化时跑一次，不需要因为父组件重渲染而重新初始化
  const callbackRef = useRef(onCredential);
  useEffect(() => { callbackRef.current = onCredential; }, [onCredential]);

  useEffect(() => {
    if (!clientId) { setReady(false); return; }
    let alive = true;
    loadGis().then((ok) => {
      if (alive && ok && window.google?.accounts?.id) setReady(true);
    });
    return () => { alive = false; };
  }, [clientId]);

  useEffect(() => {
    const host = hostRef.current;
    const api = window.google?.accounts?.id;
    if (!ready || !clientId || !host || !api) return;
    api.initialize({
      client_id: clientId,
      callback: (response: { credential?: string }) => {
        if (response?.credential) callbackRef.current(response.credential);
      },
      auto_select: false,          // 不要「自动登录」：用户没点就不该有登录状态
      cancel_on_tap_outside: true,
    });
    // 按钮宽度跟随容器（窄屏不能溢出），并限制在 Google 允许的范围内
    const width = Math.max(200, Math.min(320, host.clientWidth || 320));
    api.renderButton(host, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      shape: 'rectangular',
      text: 'continue_with',
      logo_alignment: 'left',
      locale: GIS_LOCALE[getLang()] || 'en',
      width,
    });
  }, [ready, clientId]);

  if (!clientId) return null;
  return (
    <div className="flex justify-center">
      {/* Google 官方按钮是 iframe，内部无法真正 disabled → 用遮罩层挡住点击并降低不透明度 */}
      <div
        className="relative"
        style={disabled ? { pointerEvents: 'none', opacity: 0.5 } : undefined}
      >
        <div ref={hostRef} />
      </div>
    </div>
  );
}
