import { useCallback, useEffect, useState } from 'react';
import { reportPwaInstall } from '../services/api';

/**
 * PWA 安装/保存提示（配合 InstallAppBanner / InstallAppDialog / InstallExitModal）
 * - 桌面 Chrome/Edge/安卓：监听 beforeinstallprompt，把「安装」时机交给我们控制（否则浏览器自己弹），
 *   用户点「安装」时调用 deferredPrompt.prompt() 真正触发安装。
 * - iOS Safari：没有 beforeinstallprompt，只能给「添加到主屏幕」手动引导（install 按钮不适用）。
 * - 已安装（standalone）不再提示；「底部轻提示」：没装且能提示时**每次进入都显示**，用户点 × 才隐藏（刷新后仍未装会再显示）；「离开时引导」每天最多一次（localStorage 日期）。
 * 状态由 Home 单例统一管理，底部提示与对话框/离开引导共用同一份 beforeinstallprompt。
 */

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const EXIT_KEY = 'cure_pwa_exit_seen_date';

function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function seenToday(key: string): boolean {
  try { return localStorage.getItem(key) === localDate(); } catch { return false; }
}
function markSeen(key: string): void {
  try { localStorage.setItem(key, localDate()); } catch { /* 忽略 */ }
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const md = window.matchMedia?.('(display-mode: standalone)');
    if (md && md.matches) return true;
    return (navigator as unknown as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const iPad = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return /iphone|ipad|ipod/i.test(ua) || iPad;
}

// QQ 浏览器（QQBrowser 桌面 / MQQBrowser 安卓）是 Chromium 但多用自家菜单「创建快捷方式/添加到主屏」，
// 不保证稳定弹 `beforeinstallprompt`（或弹了也不一定真正装成 PWA）。对 QQ 强制走 manual 手动引导，别靠失效的安装按钮。
function isQQBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /QQBrowser|MQQBrowser|QQBrowserApp/i.test(navigator.userAgent || '');
}

// 是否 Chromium 内核浏览器（Chrome/Edge/Opera 等）：UA 都带 "Chrome/xx"；Firefox / (iOS·macOS)Safari 不带。
// 用于区分「真不支持 PWA 的浏览器」与「支持但暂未触发安装提示（如 Chrome 隐私模式），后者不该给手动快捷方式引导」。
function isChromiumBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Chrome\//i.test(navigator.userAgent || '');
}

const INSTALLED_KEY = 'cure_pwa_installed';
function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}
function writeCookie(name: string, value: string): void {
  if (typeof document === 'undefined') return;
  try { document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=31536000; SameSite=Lax`; } catch { /* 忽略 */ }
}
function eraseCookie(name: string): void {
  if (typeof document === 'undefined') return;
  try { document.cookie = `${name}=; path=/; max-age=0`; } catch { /* 忽略 */ }
}
function storedInstalled(): boolean {
  try { if (localStorage.getItem(INSTALLED_KEY) === '1') return true; } catch { /* 忽略 */ }
  // iOS 主屏 App 与 Safari 的 localStorage 不通：回退读 cookie（跨 Safari ↔ 主屏 App 携带）
  return readCookie(INSTALLED_KEY) === '1';
}
function markInstalled(): void {
  try { localStorage.setItem(INSTALLED_KEY, '1'); } catch { /* 忽略 */ }
  writeCookie(INSTALLED_KEY, '1');
}
function clearInstalled(): void {
  try { localStorage.removeItem(INSTALLED_KEY); } catch { /* 忽略 */ }
  eraseCookie(INSTALLED_KEY);
}

/** 安装能力：install=可真正安装（beforeinstallprompt）；ios=iOS 只能加到主屏；manual=其它浏览器（Firefox/内地等）手动「添加到主屏幕/桌面快捷方式」 */
export type PwaInstallMode = 'install' | 'ios' | 'manual' | null;

export function usePwaInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  // 已安装 = 当前在 standalone，或该设备曾安装过（localStorage 标记，兼顾客户在普通标签页访问）
  const [installed, setInstalled] = useState<boolean>(() => isStandalone() || storedInstalled());
  const [exitSeenToday, setExitSeenToday] = useState<boolean>(() => seenToday(EXIT_KEY));

  // 上报一次「安装/下载 Xiaoyu」到控制台（每设备只报一次）
  const reportInstallOnce = useCallback(() => {
    try {
      if (localStorage.getItem('cure_pwa_install_reported') === '1') return;
      localStorage.setItem('cure_pwa_install_reported', '1');
    } catch { /* 忽略 */ }
    void reportPwaInstall().catch(() => {});
  }, []);

  // 捕获浏览器的安装事件：preventDefault 后浏览器不再自动弹，由我们决定何时提示
  useEffect(() => {
    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      // 浏览器弹出安装提示 = 当前「未安装」；清掉旧的"已装过"标记（否则卸载后仍被误判为已安装）
      clearInstalled();
      setInstalled(false);
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      markInstalled();
      reportInstallOnce();
      setInstalled(true);
      setDeferredPrompt(null);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  // 运行时检测到 standalone（已安装/从主屏打开，含 iOS 无 appinstalled 事件）→ 记为「已装过」，供之后 Safari 认出已添加
  useEffect(() => { if (isStandalone()) { markInstalled(); reportInstallOnce(); } }, [reportInstallOnce]);

  const markExitSeen = useCallback(() => { setExitSeenToday(true); markSeen(EXIT_KEY); }, []);

  const promptInstall = useCallback(async (): Promise<'ok' | 'no-prompt' | 'dismissed' | 'timeout' | 'error'> => {
    if (!deferredPrompt) return 'no-prompt';
    if (typeof deferredPrompt.prompt !== 'function') return 'error'; // 非真实 beforeinstallprompt（如测试合成的 Event）
    try {
      await deferredPrompt.prompt();
    } catch {
      return 'error';
    }
    // 多数浏览器会立刻 resolve userChoice；加 60s 超时兜底，避免一直挂起
    const choice = await Promise.race([
      deferredPrompt.userChoice ? deferredPrompt.userChoice.catch(() => null) : Promise.resolve(null),
      new Promise<null>((res) => setTimeout(() => res(null), 60000)),
    ]);
    setDeferredPrompt(null);
    if (choice?.outcome === 'accepted') {
      markInstalled();
      reportInstallOnce();
      setInstalled(true);
      return 'ok';
    }
    return choice ? 'dismissed' : 'timeout';
  }, [deferredPrompt]);

  const canInstallable = !!deferredPrompt; // 拿到 beforeinstallprompt → 可真正安装
  const isIosDevice = isIos();
  // 能力判定：
  //  - canInstallable（真弹了 beforeinstallprompt）→ install（Chrome/Edge/Chromium 真安装按钮）。
  //  - iOS → ios（加到主屏引导）。
  //  - QQ（UA）或非 Chromium（Firefox）→ manual（手动添加到主屏幕/桌面快捷方式）。
  //  - 其它 Chromium（Chrome/Edge、含隐私模式）没发安装提示 → null（不给手动快捷方式引导，避免误导；隐私模式本就装不了）。
  const mode: PwaInstallMode = canInstallable
    ? 'install'
    : isIosDevice
      ? 'ios'
      : isQQBrowser()
        ? 'manual'
        : isChromiumBrowser()
          ? null
          : 'manual';

  // 底部轻提示：只要没装且有能力提示，每次进入都显示（用户点 × 才隐藏；刷新后仍未装会再显示）
  const toastEligible = !installed && mode !== null;
  // 离开时引导：非已安装、今天还没引导过
  const exitEligible = !installed && !exitSeenToday;

  return { installed, canInstallable, isIosDevice, mode, promptInstall, toastEligible, exitEligible, markExitSeen };
}
