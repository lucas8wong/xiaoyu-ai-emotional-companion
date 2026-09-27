/**
 * 小件表面（Surface）家族：卡片壳 / 白底井 / 图标芯片 / 提示横幅。
 *
 * 复用点：这四个形状在会员弹窗里已经各写了 2–4 份（用量卡、四个模式行、三张价格卡的图标块、
 * 推荐横幅、当前档位卡…），而且**下一批弹窗迁移也要靠它们**。抽在这里 = 一处改、处处一致；
 * 配色一律走站点 token（薄荷/琥珀/沙），不新增颜色。
 */
import type { ReactNode } from 'react';

export type Tone = 'mint' | 'amber' | 'sand' | 'plain';

/* —— 配色表：单一口径（以后要调「琥珀档位感」只改这里） —— */
export const TONE = {
  mint: { chip: 'bg-primary-lighter text-primary-text', soft: 'bg-primary-soft text-primary-text', banner: 'border-primary/30 bg-primary-lighter text-primary-text', icon: 'text-primary' },
  amber: { chip: 'bg-amber-100/80 text-amber-700', soft: 'bg-amber-100 text-amber-700', banner: 'border-amber-200 bg-amber-50/70 text-amber-800', icon: 'text-amber-500' },
  sand: { chip: 'bg-clay-muted/60 text-ink-soft', soft: 'bg-clay-muted text-ink-soft', banner: 'border-clay-border bg-clay-muted/50 text-gray-700', icon: 'text-ink-soft' },
  plain: { chip: 'bg-white text-gray-700', soft: 'bg-white text-gray-700', banner: 'border-clay-border bg-white text-gray-700', icon: 'text-gray-500' },
} as const;

/**
 * 卡片壳：白底或「顶部淡色渐变 → 白」。`tint` 给渐变色调，`header` 给一条与正文分开的头部条。
 */
export function SectionCard({
  children, className = '', tint, header,
}: { children: ReactNode; className?: string; tint?: 'mint' | 'amber'; header?: ReactNode }) {
  const bg = tint === 'mint'
    ? 'bg-gradient-to-b from-primary-lighter to-white'
    : tint === 'amber'
      ? 'bg-gradient-to-b from-amber-50 to-white'
      : 'bg-white';
  return (
    <div className={'rounded-2xl border border-clay-border overflow-hidden ' + bg + ' ' + className}>
      {header ? <div className="text-xs font-semibold text-ink-soft px-4 py-2.5 border-b border-clay-border bg-clay-muted/40">{header}</div> : null}
      {children}
    </div>
  );
}

/** 白底「井」：承载一行设置/一条滑块/一行数值的最小表面（列表里成排出现时才有节奏感） */
export function Well({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={'rounded-xl bg-white/80 border border-clay-border/70 px-3 py-1.5 ' + className}>{children}</div>;
}

/** 图标芯片：tinted 圆角方块（卡片/列表行左边的身份标识），图标本身走 currentColor。
 *  `tone={null}` = 不带底色（调用方自己给 className 里的 bg-*，避免两套 bg 类互相打架）。 */
export function IconChip({
  children, tone = 'mint', size = 'md', className = '',
}: { children: ReactNode; tone?: Tone | null; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const box = size === 'lg' ? 'w-12 h-12 sm:w-14 sm:h-14 rounded-xl' : size === 'md' ? 'w-8 h-8 rounded-xl' : 'w-6 h-6 rounded-lg';
  const tint = tone === null ? '' : TONE[tone].chip;
  return <span className={'flex items-center justify-center flex-shrink-0 overflow-hidden ' + box + ' ' + tint + ' ' + className}>{children}</span>;
}

/**
 * 提示/结论横幅：图标 + 主句 + 说明。
 * 会员弹窗的「推荐结论」、Pro 续费视图的「剩余天数」提示、以及各档提示条同源。
 */
export function Banner({
  icon, title, desc, tone = 'mint', className = '', role,
}: { icon?: ReactNode; title: ReactNode; desc?: ReactNode; tone?: Tone; className?: string; role?: string }) {
  return (
    <div role={role} className={'rounded-xl border px-3 py-2 flex items-start gap-2 ' + TONE[tone].banner + ' ' + className}>
      {icon ? <span className="flex-shrink-0 mt-[3px]">{icon}</span> : null}
      <div className="min-w-0">
        <p className="text-[13px] font-bold leading-snug">{title}</p>
        {desc ? <p className="text-[11px] leading-relaxed text-ink-soft mt-0.5">{desc}</p> : null}
      </div>
    </div>
  );
}
