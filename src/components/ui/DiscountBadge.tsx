/**
 * 折扣标注（全站唯一实现）+ 原价划线
 *
 * 为什么收成一处（2026-09-29 用户要求「所有显示价格的地方，有折扣时折扣标注要更明显，UI 也要好看」）：
 * 之前四处各写一套：付费弹窗是 11px **裸琥珀字**、会员卡是 10px 琥珀底小胶囊、首页是 10px 小胶囊、
 * 个人页是渐变胶囊，同一件事四种样子；更要紧的是**配色本身不达标**。
 *
 * 实测（`temp/measure-discount-contrast.mjs`，从 `src/index.css` 解析各皮肤 token 后算 WCAG 对比度）：
 *   旧写法「`text-accent` 琥珀字 on 卡片底」在**五种皮肤全部不达标**：default/healing 2.15、zen 3.10、
 *   star 2.75、candy 2.77（小字要 ≥4.5:1），「不明显」不只是观感问题，是真的看不清。
 * 于是按实测选色（皮肤 token，随皮肤自动换色，不写死 hex）：
 *   - `offer`（限时优惠）：`accent-soft` 底 + `ink` 字 + `accent` 描边 → 全皮肤 **5.93–12.76:1 ✓**
 *     （实心底 + 白字反而不行：白字 on accent 只有 2.15–3.10:1，全皮肤不达标，故不用）
 *   - `save`（省 X 个月 / 永久会员）：`primary-strong` 实底 + 白字 → 全皮肤 **4.68–15.14:1 ✓**
 * 两者都是**填充色块**而非浅色小字，这是「更明显」的主要手段；再配 11px **bold**、圆角胶囊与细阴影，
 * 以及紧贴当前价格的位置（见各调用点）。
 *
 * 纪律：
 *  - 只做**静态**提示，不加动效（better-ui：动效不能是唯一反馈通道，折扣信息也不需要呼吸灯）。
 *  - 颜色只用 token（`accent*` / `primary*` / `ink`），皮肤切换时自动跟随；不要写 `amber-700` 这类硬编码。
 *  - 图标只用于 `offer`（Tag，stroke 2 与 bold 文字同光学重量）；空间紧的格子可 `icon={false}`。
 */
import type { ReactNode } from 'react';
import { Tag, Hourglass } from 'lucide-react';
import { t, getLang } from '../../i18n';

export type DiscountTone = 'offer' | 'save';
export type DiscountSize = 'md' | 'sm';

const TONE: Record<DiscountTone, string> = {
  // 限时优惠：琥珀底 + 墨字 + 琥珀描边（描边让同色系底在浅卡面上也有明确边界）
  offer: 'bg-accent-soft text-ink ring-1 ring-accent/60',
  // 结构性省钱（年付省 3 个月 / 永久会员）：深品牌绿实底 + 白字，读作「价值」而不是「催单」
  save: 'bg-primary-strong text-white ring-1 ring-primary-strong/20',
};

const SIZE: Record<DiscountSize, string> = {
  md: 'text-[11px] px-2 py-[3px] gap-1',
  sm: 'text-[10px] px-1.5 py-0.5 gap-0.5',
};

export function DiscountBadge({
  tone = 'offer',
  size = 'md',
  icon,
  className = '',
  children,
}: {
  tone?: DiscountTone;
  size?: DiscountSize;
  /** 是否带 Tag 图标；缺省：offer 带、save 不带（“省 X 个月”文字已经说清） */
  icon?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const withIcon = icon ?? tone === 'offer';
  return (
    <span
      className={
        'inline-flex items-center rounded-full font-bold tabular-nums whitespace-nowrap align-middle shadow-sm ' +
        TONE[tone] + ' ' + SIZE[size] + ' ' + className
      }
    >
      {withIcon ? <Tag className={size === 'sm' ? 'w-2.5 h-2.5' : 'w-3 h-3'} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/**
 * 原价（划线），与折扣标注成对出现，四处必须一模一样，否则「哪个是原价」会读错。
 * `decoration-1` 保持细线，避免和加粗的现价抢注意力；`tabular-nums` 让数字对齐。
 * ⚠️ 实测小字对比度：default/healing 4.62–4.97 ✓、star 5.40–6.09 ✓、candy 4.74–5.09 ✓、
 * zen 3.38–3.81（略低于 4.5）：它是被划掉的次要信息、现价才是主信息，故保留；要更严可换 `text-ink`。
 */
export function StrikePrice({ size = 'md', className = '', children }: { size?: DiscountSize; className?: string; children: ReactNode }) {
  return (
    <span className={(size === 'sm' ? 'text-[10px]' : 'text-[11px]') + ' text-ink-soft line-through decoration-1 tabular-nums ' + className}>
      {children}
    </span>
  );
}

/**
 * 「限时」的**期限**（2026-09-29 用户提问：「既然是限时折扣，是不是也要给一个时间限制显示在那呢」）。
 *
 * 数据来自服务端 `/api/payment/config` 的 `offerEndsAt`（`DISCOUNT_END`，YYYY-MM-DD）：
 *  - 配了截止日 → 显示「⏳ 至 10月8日 截止 · 剩 3 天」（日期按界面语言本地化：10月8日 / Oct 8）；
 *  - 没配（当前线上就是这种「常开」状态）→ **返回 null**，一个字都不显示（不编日期、不写死倒计时）。
 *
 * ⚠️ 已知口径缺口（如实记录）：优惠现在是常开的，所以文案里的「限时特惠」目前没有期限支撑。
 * 要么在 `.env` 配 `DISCOUNT_START`/`DISCOUNT_END`，要么把徽章文案改成不带「限时」的说法（待定）。
 * 组件本身对两种情况都安全：有日期才渲染。
 */
export function OfferDeadline({ until, size = 'md', className = '' }: { until?: string | null; size?: DiscountSize; className?: string }) {
  if (!until) return null;
  const end = new Date(String(until) + 'T23:59:59');
  if (!Number.isFinite(end.getTime())) return null;
  const days = Math.ceil((end.getTime() - Date.now()) / 86400000);
  const lang = getLang();
  // 本地化短日期：中文「10月8日」/ 英文「Oct 8」，不引第三方日期库（只有这一处需求）
  const date = new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric' }).format(end);
  /**
   * 倒计时只在**临近**时出现（≤14 天）：期限 3 个月时挂一个「剩 93 天」既没有紧迫感，
   * 又像个没人清理的旧数字；最后两周它才真正起到催促作用。日期本身始终显示，那才是「时间限制」。
   */
  const showCountdown = days > 0 && days <= 14;
  return (
    <span
      className={(size === 'sm' ? 'text-[10px]' : 'text-[11px]') + ' inline-flex items-center gap-1 text-ink-soft tabular-nums whitespace-nowrap ' + className}
    >
      <Hourglass className={size === 'sm' ? 'w-2.5 h-2.5' : 'w-3 h-3'} aria-hidden="true" />
      {t('offerDeadline', { date })}
      {showCountdown ? ' · ' + t('offerDaysLeft', { n: days }) : ''}
    </span>
  );
}
