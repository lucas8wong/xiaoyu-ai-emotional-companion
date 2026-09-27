/**
 * 剧情场景「氛围动效」规格（docs/roleplay-immersion-plan.md §4.6 = S4 伪动效）
 *
 * 只用 **CSS 光效 + 少量粒子**，不引入 canvas/视频/第三方库：
 *  - 零额外算力、零额外请求（不增加出图/带宽成本）；
 *  - 移动端友好：粒子数有硬预算（`FX_BUDGET.maxParticles`），且只在背景层、`pointer-events:none`；
 *  - **可关**：`prefers-reduced-motion` 时整个不做（比"动画时长归零"更彻底，连 DOM 都不渲染）；
 *    极低端设备（`hardwareConcurrency <= 2`）同样关闭。
 *
 * 本文件是**纯函数**（无 DOM），便于单测；渲染见 `src/components/StorySceneAtmosphere.tsx`，
 * keyframes 在 `src/index.css`（`rp-fx-*`）。
 */

export type FxKind = 'none' | 'rain' | 'dust' | 'bokeh' | 'flicker' | 'bloom';

export interface AtmosphereSpec {
  kind: FxKind;
  /** 粒子数量（0 = 只用静态光效） */
  count: number;
  /** 极淡的叠加色（故意很淡，避免影响气泡可读性） */
  tint: string;
  /** 暗角强度 0..1（0 = 不加暗角） */
  vignette: number;
}

/** 粒子预算：超过这个数不加（性能红线，改这个值等于改性能承诺） */
export const FX_BUDGET = { maxParticles: 24, minParticles: 6 };

/**
 * 主题 → 氛围规格。
 * 口径：动效只服务于"这一刻的空气感"，**强度一律克制**（tint 透明度 ≤ 0.1、暗角 ≤ 0.3），
 * 因为背景之上还要叠半透明白遮罩、再叠聊天气泡。
 */
export function atmosphereFor(theme: string | undefined | null): AtmosphereSpec {
  switch (String(theme || '')) {
    case 'rain':
      return { kind: 'rain', count: 18, tint: 'rgba(122,142,164,0.06)', vignette: 0.18 };
    case 'night':
      return { kind: 'bokeh', count: 10, tint: 'rgba(92,112,164,0.08)', vignette: 0.22 };
    case 'memory':
      return { kind: 'dust', count: 14, tint: 'rgba(212,182,142,0.06)', vignette: 0.12 };
    case 'intimate':
    case 'promise':
      return { kind: 'flicker', count: 0, tint: 'rgba(255,182,92,0.07)', vignette: 0.28 };
    case 'crisis':
      return { kind: 'bloom', count: 0, tint: 'rgba(96,104,124,0.08)', vignette: 0.3 };
    case 'cold':
    case 'conflict':
    case 'parting':
      return { kind: 'bloom', count: 0, tint: 'rgba(118,128,148,0.05)', vignette: 0.2 };
    case 'alone':
      return { kind: 'dust', count: 8, tint: 'rgba(178,178,190,0.05)', vignette: 0.26 };
    default:
      // daily / meet / flutter / reconcile / 未知 → 暖光 + 少量浮尘
      return { kind: 'bloom', count: 8, tint: 'rgba(255,220,170,0.05)', vignette: 0.14 };
  }
}

/** 粒子数收敛到预算内（防有人把 count 调大导致低端机卡顿） */
export function clampParticles(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const v = Math.floor(n);
  if (v < FX_BUDGET.minParticles) return 0;
  return Math.min(FX_BUDGET.maxParticles, v);
}

/**
 * 是否渲染动效。任一条件命中即关闭：
 * - 用户系统偏好 `prefers-reduced-motion: reduce`（眩晕敏感人群，必须尊重）
 * - 极低端设备（CPU 核数 ≤ 2）
 * - 显式关闭（保留给将来的"关闭动效"开关）
 */
export function shouldAnimateFx(input: { reducedMotion?: boolean; cores?: number; disabled?: boolean } = {}): boolean {
  if (input.disabled) return false;
  if (input.reducedMotion) return false;
  if (typeof input.cores === 'number' && input.cores > 0 && input.cores <= 2) return false;
  return true;
}

/** 稳定的伪随机（0..1）：同 index 每次渲染一致，避免每帧跳动，也让测试可预期 */
export function fxNoise(index: number, salt = 1): number {
  const h = Math.abs(Math.sin((index + 1) * 12.9898 * salt) * 43758.5453);
  return h - Math.floor(h);
}
