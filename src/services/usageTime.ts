/**
 * 用户真实使用时长埋点（客户端单例）
 *
 * 仅在「页面可见 + 窗口聚焦」期间累计活跃秒数；每约 30s 上报一次，并在页面
 * 隐藏/离开时用 sendBeacon 兜底 flush（避免页面关闭丢失最后一段活跃时间）。
 * 后台标签页 / 最小化 / 切走窗口不计入，保证统计的是「真实使用时长」。
 *
 * ⚠️ 2026-09-18 两处修复（「区间使用=0 秒」排查结论，见 usage-time-zero-audit-2026-09-18.md）：
 *  1. **兜底 flush 必须带身份**：`navigator.sendBeacon` 是唯一能在页面关闭时送达的通道，
 *     但它**无法携带自定义请求头**（Beacon API 规范），旧版只靠请求头认人 → 服务端只能按 IP
 *     造出一个「无设备身份」的幽灵游客（真数据：259 个幽灵身份占全部已记时长 13.5%）。
 *     现在把 `deviceId`（登录态再带 token）放进 body，由服务端兜底解析。
 *  2. **活跃门不能只看 hasFocus()**：内嵌浏览器 / WebView（WKWebView 等）里 `document.hasFocus()`
 *     可能**恒为 false**（WebKit bug 226025），旧版会导致整段访问一秒都不计，且因为 accum=0
 *     连兜底上报都没有，线上完全看不见。现在改为「可见 且（聚焦 或 近 INTERACTION_GRACE_MS 内有真实交互）」，
 *     并在一次都没计到时补一份 0 秒诊断上报，让这种场景在运营端可见。
 *
 * 幂等：模块级 started 守卫，规避 React StrictMode 双 effect 导致的重复启动。
 */

import { getDeviceId, getToken, reportUsageTime } from './api';

const TICK_MS = 1000;          // 活跃计时粒度
const FLUSH_INTERVAL_MS = 30000; // 心跳上报间隔
/** 交互宽限期：窗口失焦后，只要这段时间内有真实交互，仍按「人在用」计（治 WebView hasFocus 恒 false） */
const INTERACTION_GRACE_MS = 10 * 60 * 1000;

const HIT_PATH = '/api/usage-time/hit';

/** 记「有真实交互」的事件（passive，不影响滚动性能） */
const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'] as const;

let started = false;
let accum = 0; // 尚未上报的活跃秒数
let tickTimer: number | undefined;
let flushTimer: number | undefined;
let lastInteractionAt = 0;
let diagSent = false; // 每次页面加载只补一份 0 秒诊断

function markInteraction(): void {
  lastInteractionAt = Date.now();
}

interface GateFlags {
  vis: boolean;
  focus: boolean;
  interaction: boolean;
}

/** 当前「活跃门」的三个状态（同时用于计时判定与诊断上报） */
function gateFlags(): GateFlags {
  let vis = false;
  let focus = false;
  try {
    vis = document.visibilityState === 'visible';
    focus = document.hasFocus();
  } catch {
    vis = true; // 读不到就按可见处理（与旧版 catch 分支一致）
  }
  return { vis, focus, interaction: Date.now() - lastInteractionAt <= INTERACTION_GRACE_MS };
}

/** 是否处于活跃状态：页面可见，且（窗口聚焦 或 近期有真实交互） */
function isActive(): boolean {
  const f = gateFlags();
  return f.vis && (f.focus || f.interaction);
}

/** 身份兜底载荷：给无法带请求头的 sendBeacon 用（服务端只在缺头时兜底采用） */
function identityPayload(): Record<string, string> {
  const out: Record<string, string> = {};
  try { const d = getDeviceId(); if (d) out.deviceId = d; } catch { /* 忽略 */ }
  try { const tk = getToken(); if (tk) out.token = tk; } catch { /* 忽略 */ }
  return out;
}

function payloadOf(seconds: number, beacon: boolean, diagOnly: boolean): Record<string, unknown> {
  const f = gateFlags();
  return {
    seconds,
    vis: f.vis,
    focus: f.focus,
    interaction: f.interaction,
    beacon,
    ...(diagOnly ? { diag: true } : {}),
    ...identityPayload(),
  };
}

/** 用 sendBeacon 发（页面卸载/隐藏时保证送达）；不可用或返回 false 时调用方回退 fetch */
function sendViaBeacon(body: string): boolean {
  try {
    if (typeof navigator === 'undefined' || !('sendBeacon' in navigator)) return false;
    return navigator.sendBeacon(HIT_PATH, new Blob([body], { type: 'application/json' }));
  } catch {
    return false;
  }
}

/** 发一次上报：优先（可选）sendBeacon，失败回退带请求头的 fetch（两条路都带 body 身份） */
function send(seconds: number, beacon: boolean, diagOnly = false): void {
  const payload = payloadOf(seconds, beacon, diagOnly);
  if (beacon && sendViaBeacon(JSON.stringify(payload))) return;
  void reportUsageTime(seconds, payload);
}

/** 把累计秒数上报并清零；useBeacon=true 用 sendBeacon（页面卸载/隐藏时保证送达） */
function flush(useBeacon = false): void {
  const sec = Math.floor(accum);
  accum = 0;
  if (sec > 0) {
    send(sec, useBeacon);
    return;
  }
  // 一秒都没计到也要留一份「门状态」样本：否则 WebView 里 hasFocus() 恒 false 的整段访问
  // 在运营端完全无痕（这正是「区间使用=0 秒」里最需要被看见的那种情况）。
  if (useBeacon && !diagSent) {
    diagSent = true;
    send(0, true, true);
  }
}

function tick(): void {
  if (isActive()) accum += TICK_MS / 1000;
}

function onVisibility(): void {
  if (document.visibilityState === 'hidden') flush(true);
}

function onPageHide(): void {
  flush(true);
}

/** 启动使用时长埋点（幂等，可在 App 挂载 effect 中调用） */
export function startUsageTimeTracking(): void {
  if (started || typeof window === 'undefined' || typeof document === 'undefined') return;
  started = true;

  // 刚进入页面即视为「有人在用」：给首屏一个完整宽限期，之后靠真实交互续期
  lastInteractionAt = Date.now();
  for (const ev of INTERACTION_EVENTS) window.addEventListener(ev, markInteraction, { passive: true });
  window.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  tickTimer = window.setInterval(tick, TICK_MS);
  flushTimer = window.setInterval(() => flush(false), FLUSH_INTERVAL_MS);
}

/** 停止埋点（一般不需要；主要供测试/调试使用，会清掉定时器与事件监听） */
export function stopUsageTimeTracking(): void {
  if (!started) return;
  started = false;
  if (tickTimer !== undefined) { window.clearInterval(tickTimer); tickTimer = undefined; }
  if (flushTimer !== undefined) { window.clearInterval(flushTimer); flushTimer = undefined; }
  for (const ev of INTERACTION_EVENTS) window.removeEventListener(ev, markInteraction);
  window.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('pagehide', onPageHide);
  flush(true);
}

/** 仅供测试：重置模块内部状态（累计秒数 / 诊断已发标记 / 交互时间） */
export function __resetUsageTimeTrackingForTest(): void {
  accum = 0;
  diagSent = false;
  lastInteractionAt = 0;
  started = false;
  if (tickTimer !== undefined) { window.clearInterval(tickTimer); tickTimer = undefined; }
  if (flushTimer !== undefined) { window.clearInterval(flushTimer); flushTimer = undefined; }
}
