/**
 * 剧情场景画面（换幕 + 淡入淡出 + 极缓推拉）
 * 对应 docs/roleplay-immersion-plan.md §4.2（S2 图库层）+ §4.5（S5 专属画面）
 *
 * 🔧 2026-09-14 复盘后的优先级（用户反馈"默认画面跟剧情没啥关系"）：
 *   ① 专属画面（`overrideUrl`，按需/Pro 自动生成的那张）
 *   ② **主场景图**（`masterUrl`，每部内置剧本一张 → 整部剧发生在属于它自己的空间里）
 *   ③ 共享主题池（`{世界观}-{幕}`，自建剧本或未出主场景图时）
 *   ④ 共享兜底（`{世界观}-daily`）
 *   ② 压过 ③ 是关键：不再"每换一幕就跳到另一个通用房间"，换幕的观感交给**氛围层**（调色/光效/粒子）。
 *
 * 其余不变：换幕淡出→换→淡入（与 BGM 切曲同一手感）、进入剧情预热主题池、Ken Burns 缓推拉（reduced-motion 时不动）。
 */
import { useEffect, useRef, useState } from 'react';
import { poolUrlsFor, scenePoolUrl, sceneUrlFor, DEFAULT_THEME } from '../lib/storyScene';

/**
 * 剧情视图的**首帧兜底**工具（配合 index.html 的启动脚本）。
 *
 * 为什么还需要它：index.html 那段脚本只在**页面加载**时跑。而用户从剧本列表**点进**详情页/聊天
 * 是 SPA 内切换（不刷新）→ 那一刻还没人把兜底层铺上，React 的首帧仍会露出皮肤
 * （用户 2026-09-15 反馈的第二处闪现："点进一个剧情看角色介绍的位置，还是会先闪一下皮肤"）。
 * 所以在进入 detail/chat 这两种视图时，由应用自己把"最近一次看过的场景图"贴到皮肤层上，
 * 离开时摘掉（RoleplayPage 卸载的 cleanup 会做）。
 */
export function sceneBootUrlFor(scenarioId: string, fallback: string): string {
  if (!scenarioId) return fallback;
  for (const [k, v] of urlMemo) if (k.startsWith(scenarioId + '|')) return v;
  return fallback;
}
export function applySceneBoot(url: string): void {
  try {
    if (!url) return;
    document.documentElement.style.setProperty('--scene-boot-url', `url("${url}")`);
    document.documentElement.setAttribute('data-scene-boot', '1');
  } catch { /* 忽略 */ }
}
export function clearSceneBoot(): void {
  try {
    document.documentElement.removeAttribute('data-scene-boot');
    document.documentElement.style.removeProperty('--scene-boot-url');
  } catch { /* 忽略 */ }
}

/**
 * 🔴 2026-09-15 修复"刚进去先闪一下皮肤再跳到背景图"（用户反馈）：
 * 冷启动实测（`temp/trace-flash-cold.mjs`，关缓存）暴露**两个独立原因**，合计背景层不可见 **762ms**：
 *   ① t≈0–350ms  React 还没挂载 → 什么都没有（露皮肤）
 *   ② t≈350ms    先渲染的是**共享主题池图**（`hk-daily.webp`）——因为 `masterUrl`/`ownUrl` 还没从接口回来
 *   ③ t≈401–763ms 旧图 **opacity 1.00 → 0.00**，而新图还没到 → **中间完全没有背景**（闪现主因）
 * 对应修法：
 *   · ③ → **交叉淡入**：旧图**保持 opacity 1 不动**，新图叠在它上面从 0 淡到 1，淡完再移除旧层。
 *        任何时刻至少有一层是可见的 → 结构上不可能再"两层都空"。
 *   · ② → **记住上次解析出的 URL**（`scenarioId|theme` → url，模块级 Map + sessionStorage）：
 *        再次进入同一部剧/同一幕时**第一帧就用对的那张**（接口回来若一致就完全不换图）。
 *   · 换图前先 `decode()` 解码完成再叠上去，避免"新图已挂载但还没解码"的空档。
 */
const urlMemo = new Map<string, string>();
const MEMO_KEY = 'cure_scene_url_memo';
try {
  const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(MEMO_KEY) : null;
  if (raw) for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, string>).slice(0, 60)) urlMemo.set(k, v);
} catch { /* 忽略 */ }
const LAST_KEY = 'cure_scene_url_last';
function rememberUrl(key: string, url: string): void {
  // 最近一次显示过的场景图 → 给 index.html 的启动脚本用（进剧情首帧就铺上它，不闪皮肤）
  try { localStorage.setItem(LAST_KEY, url); } catch { /* 忽略 */ }
  if (!key || !url || urlMemo.get(key) === url) return;
  urlMemo.set(key, url);
  try {
    if (urlMemo.size > 60) { const first = urlMemo.keys().next().value; if (first) urlMemo.delete(first); }
    sessionStorage.setItem(MEMO_KEY, JSON.stringify(Object.fromEntries(urlMemo)));
  } catch { /* 忽略 */ }
}

export interface StorySceneBackdropProps {
  scenario: { id: string; tags?: string[] } | null | undefined;
  /** 当前幕（由父组件用 matchTheme 决定；从未命中时为 null → 用主场景图/兜底） */
  theme: string | null;
  /** 专属画面（按需生成、已缓存） */
  overrideUrl?: string | null;
  /** 该剧本的主场景图（服务端查文件后给出；没有则 null） */
  masterUrl?: string | null;
  /**
   * 预热地址（C 方案：该剧本每一幕的专属图 URL，由服务端查文件后给出）。
   * 给了就预热这 16 张（换幕即命中缓存）；没给则退回预热共享主题池。
   */
  preheatUrls?: string[];
  /** 传 false 时完全不渲染（例如自建剧本已自带聊天背景图） */
  enabled?: boolean;
  className?: string;
  /**
   * 背景虚化半径（px，0 = 不虚化）。
   * 2026-09-15 用户要求「剧情浏览首页可以虚化这里的背景，然后继续增加白板的透明度也能保证字被看清」：
   * 虚化去掉高频细节后，正文压在低透明度卡片上也能读 —— **高频细节才是"糊字"的主因**。
   * 实现：容器加 `filter: blur()` + 轻微 `scale()`（否则滤镜会让四边出现发虚的边缘）。
   */
  blur?: number;
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export default function StorySceneBackdrop({ scenario, theme, overrideUrl, masterUrl, preheatUrls, enabled = true, className = '', blur = 0 }: StorySceneBackdropProps) {
  const res = sceneUrlFor(scenario, theme, { master: !!masterUrl });
  const targetUrl = overrideUrl || res.url;
  // 层级词汇表与 storyScene.ts 统一：own-theme（专属画面）/ master（主场景图）/ pool-theme / pool-daily
  const layer = overrideUrl ? 'own-theme' : res.layer;

  const memoKey = scenario ? `${scenario.id}|${theme || ''}` : '';
  /** 首帧兜底取 URL：先精确命中"同一部剧同一幕"，没命中就退到**同一部剧最近看过的那张**——
   *  首次挂载时"当前幕"还没算出来（key 里 theme 为空），不这样兜就会先闪一张共享主题池图。 */
  const memoUrlFor = (key: string): string => {
    if (key && urlMemo.get(key)) return urlMemo.get(key) as string;
    const prefix = key.split('|')[0] + '|';
    if (!prefix || prefix === '|') return '';
    for (const [k, v] of urlMemo) if (k.startsWith(prefix)) return v;
    return '';
  };
  // 首帧优先用"上次解析出的那张"（命中就完全不会先闪错图）
  const [shown, setShown] = useState(() => memoUrlFor(memoKey) || targetUrl);
  /** 正在淡出的上一层（旧图始终可见，新图叠上来 → 永远不会出现"两层都空"） */
  const [prevUrl, setPrevUrl] = useState<string | null>(null);
  const [curVisible, setCurVisible] = useState(true);
  const [broken, setBroken] = useState(false);
  const fading = useRef(false);

  useEffect(() => {
    if (!targetUrl) return;
    rememberUrl(memoKey, targetUrl);
    if (targetUrl === shown) { setCurVisible(true); return; }
    let cancelled = false;
    const swap = () => {
      if (cancelled || fading.current) return;
      fading.current = true;
      setPrevUrl(shown);        // 旧图留在下面（opacity 1，不动）
      setShown(targetUrl);      // 新图叠上来
      setCurVisible(false);
      // 下一帧开始淡入（挂载时 opacity 0 → 1 才能触发 transition）
      requestAnimationFrame(() => { if (!cancelled) setCurVisible(true); });
      window.setTimeout(() => { if (!cancelled) { setPrevUrl(null); fading.current = false; } }, 500);
    };
    // 先解码再叠上去：避免"新图已挂载但尚未解码"的空档
    const im = new Image();
    im.decoding = 'async';
    im.src = targetUrl;
    setBroken(false);
    if (typeof im.decode === 'function') im.decode().then(swap).catch(swap);
    else { im.onload = swap; im.onerror = () => { if (!cancelled) setBroken(true); }; }
    return () => { cancelled = true; };
  }, [targetUrl, shown, memoKey]);

  // 预热：**优先**把该剧本自己的每一幕专属图塞进浏览器缓存（C 方案，换幕即命中）；
  // 没有专属图库时退回共享主题池（自建剧本/未跑批的剧本走这条）。
  const preheatKey = (preheatUrls || []).join('|');
  useEffect(() => {
    if (!scenario || !enabled) return;
    const urls = preheatUrls && preheatUrls.length ? preheatUrls : poolUrlsFor(scenario);
    const imgs = urls.map((u) => { const im = new Image(); im.decoding = 'async'; im.src = u; return im; });
    return () => { imgs.length = 0; };
    // preheatKey 是 preheatUrls 的内容指纹：数组每次渲染都是新引用，用它避免无谓重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, enabled, preheatKey]);

  /**
   * Ken Burns：极缓推拉（reduced-motion 时不动）。
   * ⚠️ 2026-09-15 实测修正：原来跑到 **1.08**，而 `object-cover` 已经把 3:4 的图裁到 89%，
   *    再乘 1.08² 后**有效可见比例掉到 76%**，且把"源图→设备像素"的放大倍数**再乘 1.08**
   *    （dpr3 手机上 1.40 × 1.08 = **1.51×** → 明显发糊）。
   *    改成 1.00 → 1.03：保留"画面在呼吸"的观感，不再吃掉构图与清晰度。
   */
  const animate = enabled && !prefersReducedMotion();
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    if (!animate) { setZoomed(false); return; }
    const t = setTimeout(() => setZoomed(true), 60);
    return () => clearTimeout(t);
  }, [animate, shown]);

  // 主场景图缺失/损坏 → 退到共享主题池（自建剧本走这条）
  const fallbackUrl = scenario ? scenePoolUrl(res.worldview, theme || DEFAULT_THEME) : '';
  const useFallback = broken && !!fallbackUrl && shown !== fallbackUrl;

  if (!enabled || !scenario || !shown) return null;

  return (
    <div
      className={'absolute inset-0 overflow-hidden ' + className}
      aria-hidden="true"
      style={blur > 0 ? { filter: `blur(${blur}px)`, transform: 'scale(1.06)' } : undefined}
    >
      {/*
        ⚠️ 2026-09-15 结论已定：**回到 `object-cover` 满屏铺底**（用户看过 contain + 模糊垫底后选择回退）。
        记录一下已知事实，免得以后又"顺手改一次"：
          · 实测（`temp/diagnose-layout.mjs`）背景容器比例随设备在 **0.63 ~ 1.05** 之间变，
            竖版 0.75 的图在 `object-cover` 下只能看到 **70%–89%**（手机 ~84%、矮屏 78%、桌面 71%）。
          · 曾试过 `object-contain` + 模糊垫底（整张可见），**用户偏好满屏铺底的观感**，已回退。
          · 若以后想再讨论"看到整张图"，先看 `temp/verify-scene-art/` 里那批对照截图，
            而不是直接改 CSS —— 这是**审美取舍**，不是 bug。
        Ken Burns 保持 1.00→1.03（原 1.08 会多吃 14% 构图）。
      */}
      {/* 旧图（下层）：**保持 opacity 1 不动**，等新图淡入盖住它之后再移除 */}
      {prevUrl && (
        <img
          src={prevUrl}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 w-full h-full object-cover"
          style={{ transform: animate ? `scale(${zoomed ? 1.03 : 1.0})` : 'none', transition: animate ? 'transform 24000ms linear' : 'none' }}
        />
      )}
      <img
        src={useFallback ? fallbackUrl : shown}
        alt=""
        decoding="async"
        data-scene-layer={useFallback ? (theme ? 'pool-theme' : 'pool-daily') : layer}
        data-scene-theme={theme || ''}
        className={prevUrl ? 'absolute inset-0 w-full h-full object-cover' : 'w-full h-full object-cover'}
        style={{
          opacity: curVisible ? 1 : 0,
          transform: animate ? `scale(${zoomed ? 1.03 : 1.0})` : 'none',
          transition: `opacity 420ms ease, transform ${animate ? '24000ms' : '0ms'} linear`,
          willChange: animate ? 'transform, opacity' : undefined,
        }}
        onError={(e) => {
          if (!useFallback) setBroken(true);
          else (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
        }}
      />
    </div>
  );
}
