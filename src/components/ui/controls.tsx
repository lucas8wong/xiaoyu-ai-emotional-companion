/**
 * 表单/设置类控件件（2026-09-17 立，用户口径「我说的弹窗也包括『我的』『个性化偏好』这类」）。
 *
 * 为什么要有这一层：这些弹窗的「壳」早就统一了（`ui/Modal`），但**内容**仍是各写一套——
 *   · 「我的」用 `rounded-lg` 方按钮 + `bg-clay-bg` 灰块 + `sectionTitle()` 局部助手；
 *   · 「个性化偏好」把「几选一」（地区/程度/深度思考/推送频率）抄了 6 遍、
 *     「标签 + 说明 + 开关」抄了 4 遍（`selectedCls/normalCls` 是文件内常量，出了这个文件就没人遵守）。
 * 结果就是「同一款控件在不同弹窗里长得不一样」。这一层把四件事固定下来：
 *   ① `Section`   卡片 + 图标标题（会员线用 `SectionCard`，设置线用这个带标题的包装）
 *   ② `Switch` / `ToggleRow`  开关与「标签+说明+开关」行（原生 `role="switch"` + `aria-checked`）
 *   ③ `OptionGroup` 「几选一」——沿用会员线已验证的分段语言（沙色轨道 + 白色选中胶囊 + 品牌色细环）
 *   ④ `BTN` / `INPUT`  按钮与输入框的**唯一 class 口径**（主/次/弱/危险 × 常规/小）
 * 迁移原则同弹窗壳：**默认外观与原来一致**，改的是「以后只改这一处」。
 */
import type { ReactNode } from 'react';
import { IconChip, SectionCard } from './Surface';

/* ─────────────── ① 区块 ─────────────── */

/** 带图标标题的区块：会员线用 `SectionCard`，设置类弹窗用这个（标题行 + 内容） */
export function Section({
  icon, title, desc, children, className = '', bodyClassName = '', right, tint,
}: {
  icon?: ReactNode;
  title: ReactNode;
  desc?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** 标题右侧的内容（如到期时间、当前档位） */
  right?: ReactNode;
  tint?: 'mint' | 'amber';
}) {
  return (
    <SectionCard tint={tint} className={'p-4 ' + className}>
      <div className={'flex items-start gap-2 ' + (children ? 'mb-3' : '')}>
        {icon ? <IconChip size="sm" tone="mint">{icon}</IconChip> : null}
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-gray-800 leading-snug">{title}</h3>
          {desc ? <p className="text-[11px] text-ink-soft leading-snug mt-0.5">{desc}</p> : null}
        </div>
        {right}
      </div>
      <div className={bodyClassName}>{children}</div>
    </SectionCard>
  );
}

/** 组小标题（如「地區語氣」「內在獨白」这类分组标签） */
export function GroupLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={'text-xs font-semibold text-ink-soft mb-1.5 ' + className}>{children}</p>;
}

/* ─────────────── ② 开关 ─────────────── */

/** 开关（原生 role="switch"）：与「个性化偏好」原来那颗逐像素一致，只是抽出来共用 */
export function Switch({
  checked, onChange, disabled, label, pulse,
}: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; pulse?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={
        'relative w-11 h-6 rounded-full transition-colors flex-shrink-0 disabled:opacity-50 ' +
        (checked ? 'bg-primary' : 'bg-gray-300') + (pulse ? ' ring-2 ring-primary/40' : '')
      }
    >
      <span className={'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-[left] ' + (checked ? 'left-[22px]' : 'left-0.5')} />
    </button>
  );
}

/** 「标签 + 说明 + 开关」行（设置类弹窗里成排出现时才有一致性） */
export function ToggleRow({
  title, desc, checked, onChange, disabled, className = '', children,
}: {
  title: ReactNode;
  desc?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
  /** 开关之外还想挂在右侧的内容 */
  children?: ReactNode;
}) {
  return (
    <div className={'flex items-center justify-between bg-white border border-clay-border rounded-xl px-3 py-2.5 ' + className}>
      <div className="flex-1 mr-2 min-w-0">
        <p className="text-sm font-medium text-ink">{title}</p>
        {desc ? <p className="text-[11px] text-ink-soft leading-snug mt-0.5">{desc}</p> : null}
      </div>
      {children}
      <Switch checked={checked} onChange={onChange} disabled={disabled} label={typeof title === 'string' ? title : 'toggle'} />
    </div>
  );
}

/* ─────────────── ③ 几选一 ─────────────── */

export interface Option<T extends string> {
  key: T;
  label: ReactNode;
  /** 副文案（如说明/价格） */
  sub?: ReactNode;
  /** Pro 专属等「不可选但可点（点了给升级引导）」的档：虚线 + 锁标，点击走 onLocked */
  locked?: boolean;
  disabled?: boolean;
  /** 右上角小标（如 Pro 徽标） */
  badge?: ReactNode;
}

/**
 * 单选取值组：**沿用会员线已验证的分段语言**（沙色轨道 + 白色选中胶囊 + 品牌色细环）。
 * 🔴 与旧实现的差别：旧的是「深绿填充 + 方角 border」，同一个 App 里两套选中文案会打架；
 * 这里统一成白色胶囊（与会员弹窗的「月付/年付/买断」「30/60/90」完全同源）。
 */
export function OptionGroup<T extends string>({
  options, value, onChange, cols = 3, onLocked, className = '', size = 'md',
}: {
  options: Option<T>[];
  value: T;
  onChange: (k: T) => void;
  cols?: 2 | 3 | 4;
  onLocked?: () => void;
  className?: string;
  size?: 'sm' | 'md';
}) {
  const grid = cols === 2 ? 'grid-cols-2' : cols === 3 ? 'grid-cols-3' : 'grid-cols-4';
  return (
    <div className={'grid gap-1 rounded-2xl border border-clay-border bg-clay-muted/50 p-1 ' + grid + ' ' + className}>
      {options.map((o) => {
        const active = o.key === value && !o.locked;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={active}
            disabled={o.disabled}
            onClick={() => (o.locked ? onLocked?.() : onChange(o.key))}
            className={
              'relative rounded-xl text-center transition-colors duration-150 disabled:opacity-50 ' +
              (size === 'md' ? 'px-1.5 py-2 ' : 'px-1.5 py-1.5 ') +
              (o.locked
                ? 'border border-dashed border-gray-300 text-ink-soft '
                : active
                  ? 'bg-white shadow-soft ring-1 ring-primary/30 '
                  : 'hover:bg-white/60 ')
            }
          >
            {o.badge ? <span className="absolute right-1 top-1">{o.badge}</span> : null}
            <span className={'block leading-tight ' + (size === 'md' ? 'text-[13px]' : 'text-[12px]') + ' ' + (active ? 'font-semibold text-primary-text' : 'text-gray-600')}>
              {o.label}
            </span>
            {o.sub ? <span className="block text-[10px] leading-snug mt-0.5 text-ink-soft">{o.sub}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 「几选一」胶囊的选中/未选中口径（与 `OptionGroup` 同源）。
 * 给**不想改成组件**的既有网格用：`className={CHIP.base + ' ' + (v === x ? CHIP.on : CHIP.off)}`——
 * 样式仍只有一处，避免「同一套选择态在 6 个网格里各写一份」的漂移。
 */
export const CHIP = {
  base: 'rounded-xl px-1.5 py-2 text-center text-[13px] font-medium transition-colors',
  /**
   * 紧凑胶囊（2026-09-23）：**选项多、每项只有 2–3 个字**的网格用（如地区语气 10 项）。
   * 实测病根：那一块原来 2 列铺 5 行，白占掉设置面板半个屏，且宽胶囊显得稀疏。
   * 高度兜底 38px（iOS 分段控件是 32px 量级）；窄屏 5 列时每格≈66px，3 个汉字放得下。
   */
  baseSm: 'rounded-lg px-1 py-2 min-h-[38px] flex items-center justify-center text-center text-[12px] font-medium transition-colors',
  on: 'bg-white shadow-soft ring-1 ring-primary/30 text-primary-text font-semibold',
  off: 'text-gray-600 hover:bg-white/60',
  track: 'grid gap-1 rounded-2xl border border-clay-border bg-clay-muted/50 p-1',
  locked: 'border border-dashed border-gray-300 text-ink-soft cursor-not-allowed',
} as const;

/* ─────────────── ④ 按钮 / 输入框口径 ─────────────── */

/**
 * 按钮 class 口径（唯一出处）。会员线用 `ui/PlanCard` 的 CTA，设置类弹窗用这里的 `BTN`。
 * 形状统一：`rounded-full` + 按压回弹（与站点 `.btn-primary` 同 `active:scale-[0.98]`）。
 */
export const BTN = {
  primary: 'bg-primary-strong hover:bg-primary text-white font-semibold shadow-soft',
  secondary: 'bg-white text-gray-700 border-2 border-clay-border hover:border-primary/40 hover:text-primary-text font-medium',
  subtle: 'bg-clay-muted text-ink hover:bg-clay-border font-medium',
  danger: 'bg-red-500 hover:bg-red-600 text-white font-semibold',
  /** 未开通会员的「查看权益」这类琥珀提示按钮（与 Pro 档色一致） */
  amber: 'bg-accent-soft text-amber-700 border border-amber-200 font-medium',
  size: 'w-full py-2.5 rounded-full text-sm transition-all duration-150 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed',
  sizeSm: 'w-full py-2 rounded-full text-[12px] transition-all duration-150 active:scale-[0.98] disabled:opacity-50',
} as const;

/** 输入框口径（设置类弹窗的文本框/密码框） */
export const INPUT = 'w-full px-3 py-2 border border-clay-border rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/30';
