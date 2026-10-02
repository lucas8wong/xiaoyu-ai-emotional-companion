/**
 * 档位卡（价格卡 / 状态卡），会员线所有「档位」外观的唯一出处。
 *
 * 复用点（为什么必须有）：同一个「档位卡」在会员弹窗里被手写了三遍且各不相同
 *   ① 三张价格卡（Free/Plus/Pro，`MembershipCompare`）
 *   ② Plus→Pro 升级大卡（`MembershipModal` 的 plus 视图，带缎带 + 权益列表）
 *   ③ Pro 续费「当前档位」状态卡（`MembershipModal` 的 pro 视图）
 * 三份各自写图标芯片、描边、价格字号、CTA。于是「续费视图没跟上价格卡的改版」成了必然。
 * 现在档位配色集中在 `PLAN_THEME` 一处，三处共用同一套壳。
 *
 * 配色纪律（不要绕过）：Free=中性沙 / Plus=薄荷（品牌绿）/ Pro=琥珀。
 * 琥珀＝「Pro 专属/更高一档」的语义色，用量刻度尺的 ∞ 尾段、对比表的 Pro 列也用它。
 */
import type { ReactNode } from 'react';
import { Check, Star } from 'lucide-react';
import { SkinPlanIcon } from '../SkinIcon';
import { IconChip } from './Surface';
import { StrikePrice } from './DiscountBadge';

export type PlanKey = 'free' | 'plus' | 'pro';

/**
 * 皮肤强调色表面 / CTA：跟随用户所选皮肤（`--color-accent` → `--color-primary`），
 * 与首页会员横幅同源。会员升级/续费这类「皮肤氛围优先」的卡片与按钮用它，
 * 档位身份色（Free 沙 / Plus 薄荷 / Pro 琥珀）则用 PLAN_THEME，两者都在这个文件里，
 * 以便「哪一处该跟皮肤、哪一处该跟档位」是**一处可读的规矩**，而不是各文件各写。
 */
export const SKIN_ACCENT_SURFACE = 'border-accent/40 bg-gradient-to-r from-accent-soft/70 to-primary-lighter/50';
export const SKIN_ACCENT_CTA = 'bg-gradient-to-r from-[var(--color-accent)] to-[var(--color-primary)] text-white shadow-soft';

/** 档位外观表：改档位观感只改这里（三张价格卡 / 升级卡 / 续费状态卡 / 对比表列色同源） */
export const PLAN_THEME: Record<PlanKey, {
  /** 卡面：描边 + 背景（渐变「顶部淡色 → 白」） */
  surface: string;
  /** 图标芯片 */
  icon: string;
  /** 被推荐时的焦点环 */
  ring: string;
  /** 推荐缎带 */
  ribbon: string;
  /** 价格文字色 */
  price: string;
  /** 主 CTA */
  cta: string;
  /** 对比表里该列的高亮底（空串=不高亮） */
  column: string;
}> = {
  free: {
    surface: 'border-clay-border bg-white',
    icon: 'bg-clay-muted/60 text-ink-soft',
    ring: 'ring-2 ring-clay-border',
    ribbon: 'bg-primary-strong',
    price: 'text-gray-700',
    cta: 'bg-white text-gray-700 border-2 border-clay-border hover:border-primary/40 hover:text-primary-text',
    column: '',
  },
  plus: {
    surface: 'border-primary/30 bg-gradient-to-b from-primary-lighter to-white',
    icon: 'bg-primary-lighter text-primary',
    ring: 'ring-2 ring-primary/25',
    ribbon: 'bg-primary-strong',
    price: 'text-primary-text',
    cta: 'bg-primary-strong hover:bg-primary text-white shadow-soft',
    column: '',
  },
  pro: {
    surface: 'border-amber-200 bg-gradient-to-b from-amber-50 to-white',
    icon: 'bg-amber-100/80 text-amber-600',
    ring: 'ring-2 ring-amber-300/70',
    ribbon: 'bg-gradient-to-r from-amber-400 to-orange-500',
    price: 'text-amber-600',
    cta: 'bg-gradient-to-r from-amber-400 to-orange-500 text-white shadow-soft',
    column: 'bg-amber-50/60',
  },
};

export interface PlanCardProps {
  plan: PlanKey;
  name: ReactNode;
  /** 名字下面那行小字（如「性价比之选」/ 续费说明） */
  tag?: ReactNode;
  /** 右上角插槽（如「当前档位」角标） */
  topRight?: ReactNode;
  /** 价格（缺省 = 不渲染价格区，用于状态卡） */
  price?: ReactNode;
  /** 价格单位（如「/月」） */
  unit?: ReactNode;
  /** 划线原价（与价格同行内联，长三币种串会自动折行） */
  originalPrice?: ReactNode;
  /** 价格下方的折算小字（如另两币种 `$4.99 · ¥35`），主价固定为本币，折算只做参考 */
  priceNote?: ReactNode;
  /** 价格上方的徽标（限时特惠 / 省 3 个月 / 永久会员…） */
  badge?: ReactNode;
  /** 权益列表（升级大卡用） */
  bullets?: ReactNode[];
  /** 价格与 CTA 之间的自定义内容（如续费天数选择器、副价格行） */
  footer?: ReactNode;
  /** CTA（缺省 = 不渲染按钮） */
  cta?: ReactNode;
  onCta?: () => void;
  /** 覆盖 CTA 配色（如会员续费用皮肤强调色 SKIN_ACCENT_CTA） */
  ctaClassName?: string;
  /** 是否显示推荐缎带（颜色随档位） */
  recommended?: boolean;
  recommendedLabel?: string;
  /** 覆盖卡面 / 图标芯片（皮肤强调色场景，如「当前档位卡」用皮肤 accent 而非档位色） */
  surfaceClassName?: string;
  iconClassName?: string;
  /** 额外 class */
  className?: string;
}

export default function PlanCard({
  plan, name, tag, topRight, price, unit, originalPrice, priceNote, badge, bullets, footer,
  cta, onCta, ctaClassName, recommended, recommendedLabel, surfaceClassName, iconClassName, className = '',
}: PlanCardProps) {
  const th = PLAN_THEME[plan];
  return (
    <div
      className={
        'relative rounded-2xl border-2 p-4 transition-shadow duration-150 ' +
        (surfaceClassName || th.surface) + ' ' +
        (recommended ? 'shadow-lift ' + th.ring : 'shadow-sm') + ' ' + className
      }
    >
      {recommended && recommendedLabel ? (
        <span className={'absolute -top-2.5 left-1/2 -translate-x-1/2 text-[10px] font-bold text-white rounded-full px-2.5 py-0.5 whitespace-nowrap shadow-sm flex items-center gap-0.5 ' + th.ribbon}>
          <Star className="w-2.5 h-2.5" />{recommendedLabel}
        </span>
      ) : null}

      <div className="flex items-center gap-2.5">
        <IconChip size="lg" tone={null} className={iconClassName || th.icon}>
          <SkinPlanIcon plan={plan} className="w-full h-full" />
        </IconChip>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-gray-800 text-base leading-tight">{name}</p>
          {tag ? <span className="text-[11px] text-ink-soft">{tag}</span> : null}
        </div>
        {topRight}
      </div>

      {(badge || price != null) ? (
        <div className="mt-3">
          {badge ? <span className="inline-block mb-1 mr-1">{badge}</span> : null}
          {price != null ? (
            <div className="flex items-baseline gap-1.5 flex-wrap">
              <span className={'text-xl font-bold tabular-nums ' + th.price}>{price}</span>
              {unit ? <span className="text-[11px] text-ink-soft">{unit}</span> : null}
              {/* 原价划线统一走 ui/DiscountBadge 的 StrikePrice（四处必须同款，否则「哪个是原价」会读错） */}
              {originalPrice ? <StrikePrice>{originalPrice}</StrikePrice> : null}
            </div>
          ) : null}
          {priceNote ? <p className="text-[11px] text-ink-soft mt-0.5 tabular-nums">{priceNote}</p> : null}
        </div>
      ) : null}

      {bullets && bullets.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {bullets.map((b, i) => (
            <li key={i} className="flex items-start gap-1.5 text-[12px] text-gray-600">
              <Check className={'w-3.5 h-3.5 mt-0.5 flex-shrink-0 ' + th.price} />{b}
            </li>
          ))}
        </ul>
      ) : null}

      {footer}

      {cta ? (
        <button
          type="button"
          onClick={onCta}
          className={'mt-3 w-full py-2.5 rounded-full text-sm font-bold inline-flex items-center justify-center gap-2 transition-all duration-150 hover:brightness-95 active:scale-[0.98] ' + (ctaClassName || th.cta)}
        >
          {cta}
        </button>
      ) : null}
    </div>
  );
}
