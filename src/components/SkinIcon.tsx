/**
 * 按皮肤渲染的小图标：当前皮肤有对应图片 → 用图片；没有（原版皮肤/资源缺失）→ 回退通用 Lucide 图标。
 * 场景卡插画（键名沿用 mode*）／意见反馈／会员三档 共用。
 */
import {
  Flower2,
  ShieldCheck,
  Compass,
  SunMedium,
  Scale,
  MessageSquareHeart,
  Gift,
  Sparkles,
  Crown,
  type LucideIcon,
} from 'lucide-react';
import './premium-plan-emblem.css';
import { useSkin } from './SkinProvider';
import { premiumMemberArt } from '../lib/premiumMemberArt';
import type { CompanionMode } from '../services/api';

/** 会员档位（含免费档），与支付侧可购买的 `PlanKey`（仅 plus/pro）不同，仅用于会员图标/徽章映射 */
type PlanLevel = 'free' | 'plus' | 'pro' | 'max' | 'mini' | 'flagship';

const MODE_FALLBACK: Record<CompanionMode, LucideIcon> = {
  hug: Flower2,
  ally: ShieldCheck,
  clarify: Compass,
  light: SunMedium,
  objective: Scale,
};

const PLAN_FALLBACK: Record<PlanLevel, LucideIcon> = {
  free: Gift,
  plus: Sparkles,
  pro: Crown,
  max: Crown,
  mini: Sparkles,
  flagship: Crown,
};

function modeField(mode: CompanionMode): keyof ReturnType<typeof useSkin>['meta'] {
  switch (mode) {
    case 'hug': return 'modeHug';
    case 'ally': return 'modeAlly';
    case 'clarify': return 'modeClarify';
    case 'light': return 'modeLight';
    case 'objective': return 'modeObjective';
  }
}

function planField(plan: PlanLevel): keyof ReturnType<typeof useSkin>['meta'] {
  switch (plan) {
    case 'free': return 'planFree';
    case 'plus': return 'planPlus';
    case 'pro': return 'planPro';
    case 'mini':
    case 'flagship':
    case 'max': return 'planMax';
  }
}

interface SkinModeIconProps {
  mode: CompanionMode;
  className?: string;
}

export function SkinModeIcon({ mode, className = '' }: SkinModeIconProps) {
  const { meta } = useSkin();
  const base = modeField(mode);
  // 优先用 240px 小图（场景图标只有 ~40px），无则回退大图
  const url = (meta as unknown as Record<string, string>)[base + 'Sm'] || meta[base];
  if (url) {
    return <img src={url} alt="" className={`${className} object-contain`} loading="lazy" />;
  }
  const Icon = MODE_FALLBACK[mode];
  return <Icon className={className} />;
}

interface SkinFeedbackIconProps {
  className?: string;
}

export function SkinFeedbackIcon({ className = '' }: SkinFeedbackIconProps) {
  const { meta } = useSkin();
  // 优先用 240px 小图，无则回退大图
  const url = meta.feedbackSm || meta.feedback;
  if (url) {
    return <img src={url} alt="" className={`${className} object-contain`} loading="lazy" />;
  }
  return <MessageSquareHeart className={className} />;
}

interface SkinPlanIconProps {
  plan: PlanLevel;
  className?: string;
}

export function SkinPlanIcon({ plan, className = '' }: SkinPlanIconProps) {
  const { meta } = useSkin();
  if (plan === 'mini' || plan === 'flagship') {
    const artwork = premiumMemberArt(meta.id, plan);
    if (artwork) return <img src={artwork} alt="" className={`${className} premium-plan-image`} data-plan-emblem={plan} loading="lazy" decoding="async" />;
    const Icon = PLAN_FALLBACK[plan];
    return <Icon className={className} aria-hidden="true" />;
  }
  const base = planField(plan);
  // 优先用 240px 小图（会员徽章/会员卡只有 ~36-48px），无则回退大图
  const url = (meta as unknown as Record<string, string>)[base + 'Sm'] || meta[base];
  if (url) {
    return <img src={url} alt="" className={`${className} object-contain`} loading="lazy" />;
  }
  const Icon = PLAN_FALLBACK[plan];
  return <Icon className={className} />;
}
