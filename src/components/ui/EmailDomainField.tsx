/**
 * 邮箱输入 + 常用域名快速选择（2026-10-12 用户要求）。
 *
 * 长相：`[ 账号 ] @ [ 域名 ▾ ]` 两格，域名格右侧的箭头打开常用域名下拉（用户给的参考图那种）。
 * 注册邮箱、登录邮箱、重设密码的注册邮箱三处共用，避免各写一份而漂移。
 *
 * 三条设计约束（改之前先看）：
 *  ① **只是快捷入口，不是封闭下拉**：域名格仍是普通输入框，公司邮箱等自定义域名照常手打，下拉只负责少打几个字。
 *  ② **为什么拆两格，而不是「单框 + 内嵌选择器」**：Chrome 的 input[type=email] 不支持 setSelectionRange
 *     （会抛 InvalidStateError），单框方案在字段为空时无法把光标放到 @ 之前，只能把域名拼到错误的一侧。
 *     拆开后不需要任何光标技巧，也正好对上参考图的观感。
 *  ③ **受控且只有一个值**：组件只接收/回传「完整邮箱」（含 @ 时自动拆成两格显示），调用方不必维护
 *     「账号 / 域名」两份 state；深链预填、粘贴、浏览器自动填充都走同一条路。
 *
 * 键盘与无障碍：role=listbox / option + aria-selected，触发按钮带 aria-expanded / aria-controls；
 * 方向键与 Home/End 遍历、Escape 关闭并把焦点还给域名格、点外部或焦点离开收起；选项 44px。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * 常用邮箱域名。排序按小愈受众：先国际普遍使用的 Gmail / Outlook / iCloud / Yahoo，
 * 再大陆常用的 QQ / 163 / 126 / 新浪；标签不翻译（域名是国际通用符号，翻译只会让人更找不到）。
 */
export const EMAIL_DOMAINS = ['gmail.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'yahoo.com', 'qq.com', '163.com', '126.com', 'sina.com'];

/**
 * 两格的样式各自写全（不复用调用方的 inputCls）：Tailwind 同类工具类谁生效看生成次序，
 * 拿 pl-3 去盖 pl-10 是不生效的（见 ui/Modal.tsx 文件头纪律①）。
 */
const LOCAL_CLS = 'w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent';
const DOMAIN_CLS = 'w-full pl-2.5 pr-9 py-2.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent';

interface EmailDomainFieldProps {
  /** 账号格的 id（外层 label 的 htmlFor 也用它） */
  id: string;
  /** 完整邮箱（受控值） */
  value: string;
  onChange: (value: string) => void;
  /** 左侧标签；不传则不渲染（调用方自己在外面写 label 时留空） */
  label?: string;
  labelClassName?: string;
  /** 账号格占位符 */
  placeholder?: string;
  /** 域名格与下拉的无障碍名 */
  domainLabel: string;
  /** 下拉触发按钮的无障碍名 */
  pickLabel: string;
  /** 账号格下方的内容（各调用方自己的校验 / 格式提示） */
  children?: ReactNode;
  autoComplete?: string;
}

export default function EmailDomainField({
  id, value, onChange, label, labelClassName = 'block text-xs text-ink-soft mb-1',
  placeholder, domainLabel, pickLabel, children, autoComplete,
}: EmailDomainFieldProps) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const localInputRef = useRef<HTMLInputElement>(null);
  const domainInputRef = useRef<HTMLInputElement>(null);

  const at = value.indexOf('@');
  const local = at >= 0 ? value.slice(0, at) : value;
  // A visible default is a real input value and is included on the first keystroke.
  // An explicit @ preserves a deliberately cleared domain instead of restoring it.
  const domain = at >= 0 ? value.slice(at + 1) : 'qq.com';
  const activeIdx = EMAIL_DOMAINS.indexOf(domain.trim().toLowerCase());
  const compose = (l: string, d: string) => (!l && d === 'qq.com' ? '' : `${l}@${d}`);

  // 点外部收起（焦点离开这一行时也会收起，见行上的 onBlur）
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rowRef.current && !rowRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  /** 账号格输入：粘贴 / 自动填充整段邮箱时，@ 后面自动落到域名格 */
  const changeLocal = (raw: string) => {
    const i = raw.indexOf('@');
    onChange(i >= 0 ? `${raw.slice(0, i)}@${raw.slice(i + 1)}` : compose(raw, domain));
  };
  const changeDomain = (d: string) => onChange(compose(local, d));

  /** 选中常用域名：只替换域名格，然后把焦点交回账号格（下一步就该打字了） */
  const pickDomain = (d: string) => {
    onChange(compose(local, d));
    setOpen(false);
    localInputRef.current?.focus();
  };

  /** 下拉里的方向键 / Home / End 导航（role=listbox 的标准键盘交互） */
  const moveFocus = (step: number | 'first' | 'last') => {
    const nodes = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') || []);
    if (!nodes.length) return;
    const cur = nodes.indexOf(document.activeElement as HTMLButtonElement);
    const next = step === 'first' ? 0 : step === 'last' ? nodes.length - 1 : (cur + step + nodes.length) % nodes.length;
    nodes[next]?.focus();
  };

  return (
    <div>
      {label ? <label className={labelClassName} htmlFor={id}>{label}</label> : null}
      <div
        className="relative"
        ref={rowRef}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || !open) return;
          e.stopPropagation();
          setOpen(false);
          domainInputRef.current?.focus();
        }}
      >
        <div className="flex items-stretch gap-1.5">
          <input
            id={id}
            ref={localInputRef}
            type="text"
            className={LOCAL_CLS}
            value={local}
            onChange={(e) => changeLocal(e.target.value)}
            placeholder={placeholder}
            autoComplete={autoComplete}
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <span className="self-center text-sm text-ink-soft" aria-hidden="true">@</span>
          <div className="relative w-[120px] shrink-0 sm:w-[132px]">
            <input
              ref={domainInputRef}
              type="text"
              className={DOMAIN_CLS}
              value={domain}
              onChange={(e) => changeDomain(e.target.value)}
              aria-label={domainLabel}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
            />
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-label={pickLabel}
              aria-expanded={open}
              aria-controls={`${id}-domain-list`}
              className="absolute right-0 top-0 flex h-full w-9 items-center justify-center rounded-r-lg text-ink-soft hover:text-primary-text"
            >
              <ChevronDown className={`w-4 h-4 transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </div>
        {open && (
          <div
            id={`${id}-domain-list`}
            ref={listRef}
            role="listbox"
            aria-label={pickLabel}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-1); }
              else if (e.key === 'Home') { e.preventDefault(); moveFocus('first'); }
              else if (e.key === 'End') { e.preventDefault(); moveFocus('last'); }
              else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); domainInputRef.current?.focus(); }
            }}
            className="absolute left-0 right-0 top-full z-20 mt-1.5 max-h-56 overflow-y-auto rounded-xl border border-gray-200 bg-white py-1 shadow-lg"
          >
            {EMAIL_DOMAINS.map((d, i) => {
              const active = activeIdx === i;
              return (
                <button
                  key={d}
                  type="button"
                  role="option"
                  aria-selected={active}
                  tabIndex={-1}
                  autoFocus={i === (activeIdx >= 0 ? activeIdx : 0)}
                  onClick={() => pickDomain(d)}
                  className={`flex min-h-[44px] w-full items-center px-3.5 text-left text-sm ${
                    active ? 'bg-primary-soft font-medium text-primary-text' : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {d}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
