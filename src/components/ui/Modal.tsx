/**
 * 通用弹窗外壳（居中式）：遮罩 + 面板 + 头部（标题/副标题）+ 右上关闭。
 *
 * 为什么要有这个文件（2026-09-17 立，用户口径「能复用的就复用去改，而不是每个单独改，
 * 这样以后如果其中一个有改动的话，都可以同时保持一致」）：
 *   盘点 `temp/modal-inventory.mjs` 的结论——全站 **49 处浮层里有 28 处**是同一套壳，
 *   原文逐字重复（遮罩 `fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4`、
 *   面板 `bg-white rounded-2xl shadow-2xl max-w-md w-full p-4 sm:p-6 relative max-h-[92vh] overflow-y-auto`、
 *   关闭按钮 `absolute top-4 right-4 …`）。改一处观感要在 28 个文件里各改一遍，必然漂移
 *   （会员弹窗的「续费视图」就是这么掉队的）。
 *   → 本文件是那条**唯一口径**，并提供 `role="dialog" aria-modal="true"` 与关闭按钮的可访问名。
 *
 * ⚠️ 两条纪律（踩过再写下来）：
 *   ① **不要用 `panelClassName` 覆盖 padding/宽度/圆角/最大高度**——Tailwind 的同类工具类
 *      谁生效取决于它在生成 CSS 里的次序，**不取决于 class 书写顺序**，两套 `p-*` 一起出现必然有一个
 *      静默失效。所以这些一律走下面登记的 props（`width`/`padding`/`radius`/`maxHeight`/`layout`）。
 *   ② 底部抽屉（`items-end`）、全屏浮层、气泡/工具条不在本壳范围内（21 处「非标准壳」就是它们），
 *      它们各有各的手势与安全区处理——要套也得先用 `overlayClassName` 明确写出来。
 */
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../../i18n';

/** 常用宽度档（也可以直接传 class 字符串） */
export const MODAL_WIDTH = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
} as const;

export interface ModalProps {
  /** 是否打开（默认 true）。**条件渲染**的调用点（`{cond && <Modal …>}`）可以不传 */
  open?: boolean;
  onClose: () => void;
  children: ReactNode;
  /** 头部标题（与 subtitle 任一存在才渲染头部区）。**不给自己在 children 里排版** */
  title?: ReactNode;
  subtitle?: ReactNode;
  /** 面板宽度 class（默认 `max-w-md`） */
  width?: string;
  /** 面板内边距 class（默认 `p-4 sm:p-6`，与迁移前逐字一致） */
  padding?: string;
  /** 面板圆角 class（默认 `rounded-2xl`；底部弹出式用 `rounded-t-2xl sm:rounded-2xl`） */
  radius?: string;
  /** 面板最大高度 class（默认 `max-h-[92vh]`） */
  maxHeight?: string;
  /** 面板溢出（默认 `overflow-y-auto`；`max-h + flex` 那种要自己滚子区块的传 `overflow-hidden`） */
  overflow?: string;
  /** 面板阴影（默认 `shadow-2xl`；指南那类用 `shadow-lift`） */
  shadow?: string;
  /** 点遮罩是否关闭（默认 true）。原来点遮罩**不关**的（如首次引导）传 false，保持原状 */
  closeOnOverlayClick?: boolean;
  /** 面板布局：`flex` = 加 `flex flex-col`（头固定、正文自己滚的那种） */
  layout?: 'block' | 'flex';
  /** 层级（默认 z-50）；注册弹窗 z-[70]、隐私 z-[80]、语音 z-[120] 等历史值由调用方保留 */
  zClass?: string;
  /** **整条遮罩 class**（给了就完全取代默认那条，用于底部弹出/淡一点的遮罩等变体；默认见下方 DEFAULT_OVERLAY） */
  overlayClassName?: string;
  /** 关闭按钮的可访问名（默认 i18n `authClose`） */
  closeLabel?: string;
  /** 是否渲染右上 ✕（默认 true）。迁移时**与原状一致**：原来没有 ✕ 的传 false */
  showClose?: boolean;
  /** 面板追加 class —— **只放不与 width/padding/radius/maxHeight 冲突的东西**（见文件头纪律①） */
  panelClassName?: string;
  /** 头部区追加 class（如 `mb-3` 收紧间距） */
  headerClassName?: string;
  /** 面板最顶部自定义内容（缎带/进度条等），渲染在关闭按钮之下、正文之上 */
  topSlot?: ReactNode;
}

/** 默认遮罩：与迁移前 28 处里最常见的写法逐字一致 */
export const DEFAULT_OVERLAY = 'z-50 bg-black/50 flex items-center justify-center p-4';

export default function Modal({
  open = true, onClose, children, title, subtitle, width = 'max-w-md', padding = 'p-4 sm:p-6', radius = 'rounded-2xl',
  maxHeight = 'max-h-[92vh]', overflow = 'overflow-y-auto', shadow = 'shadow-2xl', layout = 'block', zClass = 'z-50', overlayClassName = '',
  closeOnOverlayClick = true,
  closeLabel, showClose = true, panelClassName = '', headerClassName = '', topSlot,
}: ModalProps) {
  if (!open) return null;
  return (
    <div
      className={`fixed inset-0 ${overlayClassName || `${zClass} ${DEFAULT_OVERLAY.replace('z-50 ', '')}`}`}
      onClick={closeOnOverlayClick ? onClose : undefined}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={
          `bg-white ${radius} ${shadow} ${width} w-full relative ${maxHeight} ${overflow} ` +
          `${padding} ${layout === 'flex' ? 'flex flex-col' : ''} ${panelClassName}`
        }
        onClick={(e) => e.stopPropagation()}
      >
        {showClose ? (
          <button onClick={onClose} aria-label={closeLabel || t('authClose')} className="absolute top-4 right-4 text-ink-soft hover:text-gray-600 p-2 -m-1 z-10">
            <X className="w-5 h-5" />
          </button>
        ) : null}
        {topSlot}
        {(title || subtitle) && (
          <div className={'text-center mb-5 ' + headerClassName}>
            {title && <h2 className="text-xl font-bold text-gray-800">{title}</h2>}
            {subtitle && <p className="text-sm text-ink-soft mt-1">{subtitle}</p>}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
