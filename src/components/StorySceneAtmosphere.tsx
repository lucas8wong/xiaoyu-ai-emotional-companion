/**
 * 剧情场景「氛围层」（S4 伪动效 · docs/roleplay-immersion-plan.md §4.6）
 *
 * 叠在场景图**之上**（但在聊天气泡之下）：极淡的色调 + 暗角 + 主题化粒子/烛光。
 * 全部是 CSS 光效，无 canvas、无视频、无第三方库、无额外请求。
 *
 * 可关闭（三条闸门，命中任一就**完全不渲染**）：
 *   ① `prefers-reduced-motion: reduce`（眩晕敏感人群）
 *   ② 极低端设备（`navigator.hardwareConcurrency <= 2`）
 *   ③ `enabled=false`（调用方显式关，例如自建剧本自带上传背景图时）
 *
 * 粒子数有硬预算（`FX_BUDGET.maxParticles`），且位置/时长用**稳定伪随机**（同 index 恒定）——
 * 避免每帧跳动，也让端到端测试可预期。
 */
import { useEffect, useMemo, useState } from 'react';
import { atmosphereFor, clampParticles, shouldAnimateFx, fxNoise } from '../lib/storyFx';

export interface StorySceneAtmosphereProps {
  theme: string;
  enabled?: boolean;
  className?: string;
}

function readEnv(): { reducedMotion: boolean; cores?: number } {
  let reducedMotion = false;
  try {
    reducedMotion = typeof window !== 'undefined' && !!window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch { /* 忽略 */ }
  const cores = typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
    ? navigator.hardwareConcurrency
    : undefined;
  return { reducedMotion, cores };
}

export default function StorySceneAtmosphere({ theme, enabled = true, className = '' }: StorySceneAtmosphereProps) {
  const [env, setEnv] = useState(() => readEnv());
  useEffect(() => {
    // 用户可能在使用中改系统偏好；跟随变化
    let mq: MediaQueryList | null = null;
    const onChange = () => setEnv(readEnv());
    try {
      mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      mq.addEventListener?.('change', onChange);
    } catch { /* 忽略 */ }
    return () => { try { mq?.removeEventListener?.('change', onChange); } catch { /* 忽略 */ } };
  }, []);

  const spec = useMemo(() => atmosphereFor(theme), [theme]);
  const animate = shouldAnimateFx({ reducedMotion: env.reducedMotion, cores: env.cores, disabled: !enabled });
  const count = clampParticles(spec.count);

  const particles = useMemo(() => {
    if (!animate || count <= 0) return [];
    return Array.from({ length: count }, (_, i) => {
      const left = Math.round(fxNoise(i, 1) * 100);
      const delay = +(fxNoise(i, 2) * 6).toFixed(2);
      const duration = +(spec.kind === 'rain' ? 0.55 + fxNoise(i, 3) * 0.5 : 9 + fxNoise(i, 3) * 9).toFixed(2);
      const size = spec.kind === 'rain' ? 0 : 2 + Math.round(fxNoise(i, 4) * 3);
      const top = spec.kind === 'rain' ? 0 : Math.round(fxNoise(i, 5) * 88);
      return { i, left, delay, duration, size, top, opacity: 0.38 + +(fxNoise(i, 6) * 0.32).toFixed(2) };
    });
  }, [animate, count, spec.kind]);

  if (!animate) return null;

  return (
    <div
      className={'rp-fx-layer ' + className}
      aria-hidden="true"
      data-atmosphere={spec.kind}
      data-fx-count={particles.length}
      style={{ opacity: 1 }}
    >
      {/* 色调层：极淡的整体色温（不做模糊，避免移动端合成开销） */}
      <div className="absolute inset-0" style={{ background: spec.tint }} />
      {/* 暗角层：把视线收到画面中心 */}
      {spec.vignette > 0 ? (
        <div className="absolute inset-0" style={{ background: `radial-gradient(120% 90% at 50% 45%, rgba(0,0,0,0) 42%, rgba(20,18,16,${spec.vignette}) 100%)` }} />
      ) : null}
      {/* 烛光/暖光呼吸（intimate / promise） */}
      {spec.kind === 'flicker' ? (
        <div className="absolute inset-0 rp-fx-flicker" style={{ background: 'radial-gradient(60% 45% at 32% 62%, rgba(255,196,120,0.28) 0%, rgba(255,196,120,0) 70%)' }} />
      ) : null}
      {/* 粒子层：雨丝 / 浮尘 / 夜色光斑 */}
      {particles.map((p) => (
        spec.kind === 'rain' ? (
          <span
            key={p.i}
            className="rp-fx-streak"
            style={{ left: p.left + '%', opacity: p.opacity, animationDelay: p.delay + 's', animationDuration: p.duration + 's' }}
          />
        ) : (
          <span
            key={p.i}
            className="rp-fx-mote"
            style={{
              left: p.left + '%',
              top: p.top + '%',
              width: p.size + 'px',
              height: p.size + 'px',
              opacity: p.opacity,
              animationDelay: p.delay + 's',
              animationDuration: p.duration + 's',
            }}
          />
        )
      ))}
    </div>
  );
}
