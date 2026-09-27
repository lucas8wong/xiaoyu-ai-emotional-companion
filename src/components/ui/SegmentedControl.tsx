/**
 * 分段控件（同一组选项里取值）：沙色轨道 + 白色选中胶囊。
 *
 * 复用点（抽出来的原因）：同一个「几选一」模式在会员线里出现了两次且**各写一份**——
 * ① 会员弹窗的「月付 / 年付 / 买断」；② Pro 续费视图的「30 / 60 / 90 天」。
 * 两份的圆角、描边、选中态、副文案字号全都不同，于是续费视图总是掉队。
 * 现在两处同源：改轨道/胶囊只改这一个文件。
 *
 * a11y：原生 button + `aria-pressed`（**刻意不用 tablist**——这是同组选项的取值，
 * 不是 tab↔panel 的切换关系，用 tablist 反而要再造 aria-controls/roving tabindex）。
 * 键盘：Tab 可进、Enter/Space 可切，与普通按钮一致。
 */
import type { ReactNode } from 'react';

export interface SegmentOption<T extends string> {
  key: T;
  /** 主文案（如「年付」/「30 天」） */
  label: ReactNode;
  /** 副文案（如「省 3 個月」/「$9.99」） */
  sub?: ReactNode;
  /** 选中时额外显示在右下角的内容（如续费的 ✓） */
  endSlot?: ReactNode;
  /** 该选项是否禁用（如未登录时的买断） */
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (key: T) => void;
  /** 外层追加 class（如需并排两个控件时控制宽度） */
  className?: string;
  /** 主文案字号档：sm=价格卡里的紧凑行，md=独立控件 */
  textSize?: 'sm' | 'md';
}

export default function SegmentedControl<T extends string>({
  options, value, onChange, className = '', textSize = 'md',
}: SegmentedControlProps<T>) {
  const labelCls = textSize === 'md' ? 'text-[13px]' : 'text-[12px]';
  return (
    <div
      className={'grid gap-1 rounded-2xl border border-clay-border bg-clay-muted/50 p-1 ' + className}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            disabled={o.disabled}
            aria-pressed={active}
            onClick={() => onChange(o.key)}
            className={
              'relative rounded-xl px-1 py-1.5 text-center transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed ' +
              (active ? 'bg-white shadow-soft ring-1 ring-primary/30' : 'hover:bg-white/60')
            }
          >
            <span className={'block font-semibold leading-tight ' + labelCls + ' ' + (active ? 'text-primary-text' : 'text-gray-600')}>{o.label}</span>
            {o.sub != null && <span className="block text-[10px] leading-tight mt-0.5 text-ink-soft tabular-nums">{o.sub}</span>}
            {active && o.endSlot ? <span className="absolute right-1.5 bottom-1.5">{o.endSlot}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
