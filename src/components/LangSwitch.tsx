/**
 * 语言快速切换（简/繁/EN）
 * pill  模式：三段式标签「简/繁/EN」（用于首屏同意门、FAQ 等直接可见处）
 * icon  模式：单个语言图标 + 下拉（用于空间紧张的主页顶栏——低频设置不占位）
 * 切换立即生效并写入 localStorage（刷新后保持）
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Languages, Check, X } from 'lucide-react';
import { getLang, setLang, applyDocumentTitle, t, type Lang } from '../i18n';
import { fontsForLang, fontKeyFor, setFontKey as saveFontKey, applyFontStyle } from '../lib/fontStyle';
import { savePreferences } from '../services/api';

interface LangSwitchProps {
  onChange?: () => void; // 通知父组件重新渲染（t() 文案整体刷新）
  size?: 'sm' | 'md';
  /** 紧凑模式：更小横向内边距，用于空间紧张的位置（如隐私同意门右上角） */
  compact?: boolean;
  /** pill=三段式分段控件；icon=单个语言图标+下拉（主页顶栏用） */
  variant?: 'pill' | 'icon';
  className?: string;
}

export default function LangSwitch({ onChange, size = 'sm', compact = false, variant = 'pill', className = '' }: LangSwitchProps) {
  const [lang, setLangState] = useState<Lang>(getLang());
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const langBtnRef = useRef<HTMLButtonElement>(null);
  // 英文界面下用 SC/TC/EN，避免界面出现中文；中文界面沿用 简/繁/EN
  const OPTS: [Lang, string][] = lang === 'en'
    ? [['zh-CN', 'SC'], ['zh-TW', 'TC'], ['en', 'EN']]
    : [['zh-CN', '简'], ['zh-TW', '繁'], ['en', 'EN']];

  // 字体选择与界面语言联动：简体/繁体→中文字体；英文→英文字体
  const [fontKey, setFontKey] = useState<string>(() => fontKeyFor(getLang()));
  const chooseFont = (k: string) => {
    saveFontKey(lang, k);
    setFontKey(k);
    applyFontStyle(lang);
    // 选完字体不自动关闭：用户可继续对比/换字体；点外部或「×」关闭
  };
  // 语言变化时重设字体选项并应用对应字体
  useEffect(() => { setFontKey(fontKeyFor(getLang())); applyFontStyle(getLang()); }, [lang]);

  const change = (l: Lang) => {
    if (l === lang) return;
    setLang(l);
    setLangState(l);
    applyDocumentTitle();
    onChange?.();
    // 同步到后端偏好：AI 输出语言跟随界面语言
    savePreferences({ language: l }).catch(() => { /* 网络失败不影响本地 */ });
    setFontKey(fontKeyFor(l));
    applyFontStyle(l);
    // 不关闭：等用户选完对应的字体（chooseFont 里再关）
  };

  // 点击菜单外部关闭（下拉/底部弹层；弹层经 portal 渲染到 body，需忽略其内部点击）
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const inside = (ref.current && ref.current.contains(e.target as Node)) || (sheetRef.current && sheetRef.current.contains(e.target as Node));
      if (!inside) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (variant === 'icon') {
    const openPanel = (btn: HTMLButtonElement) => {
      const r = btn.getBoundingClientRect();
      // 加宽（手机约 92vw、上限 440px），紧贴语言图标下方，并在视口内水平夹取，避免左右溢出
      const width = Math.min(window.innerWidth * 0.92, 440);
      const left = Math.min(Math.max(r.left, 8), window.innerWidth - width - 8);
      setPos({ top: r.bottom + 6, left, width });
    };
    return (
      <div className={"relative flex-shrink-0 " + className} ref={ref}>
        <button
          ref={langBtnRef}
          onClick={(e) => { openPanel(e.currentTarget); setOpen(o => !o); }}
          aria-label={t('langLabel')}
          title={t('langLabel')}
          className="flex items-center justify-center w-8 h-8 rounded-full text-gray-600 hover:text-gray-800 hover:bg-gray-100 transition-colors"
        >
          <Languages className="w-5 h-5" />
        </button>
        {open && pos && createPortal(
          <div
            ref={sheetRef}
            style={{ top: pos.top, left: pos.left, width: pos.width }}
            className="fixed z-[120] max-h-[70vh] overflow-y-auto bg-white rounded-xl shadow-2xl border border-clay-border px-3 py-2 text-gray-800"
          >
            <div className="flex items-center gap-1.5">
              {/* 语言（无标题，与关闭「×」同行，压缩上方空白） */}
              <div className="flex gap-1.5 flex-wrap">
                {OPTS.map(([v, label]) => (
                  <button key={v} type="button" onClick={() => change(v)} className={'px-2.5 py-1 rounded-full text-[12px] border transition-colors ' + (lang === v ? 'bg-primary text-white border-primary' : 'bg-white text-ink-soft border-clay-border hover:bg-primary-lighter')}>
                    {/* 语言选项始终用默认（系统）字体显示，不跟随当前全局所选字体 */}
                    <span style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif' }}>{label}</span>
                    {lang === v && <Check className="w-3 h-3 inline-block ml-0.5 -mt-0.5 align-middle" />}
                  </button>
                ))}
              </div>
              <button onClick={() => setOpen(false)} aria-label={t('prefsDone')} className="ml-auto -mr-1.5 p-1 text-ink-soft hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="my-1.5 border-t border-clay-border" />
            {/* 字体：随界面语言联动；同一行、横向滚动；每项用对应字体预览 */}
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[11px] text-ink-soft shrink-0">{t('fontLabel')}</span>
              <div className="flex gap-1.5 overflow-x-auto whitespace-nowrap pb-0.5 flex-1 min-w-0">
                {fontsForLang(lang).map(o => (
                  <button key={o.key} type="button" onClick={() => chooseFont(o.key)} className={'flex items-center px-2.5 py-1 rounded-full text-[13px] border transition-colors shrink-0 ' + (fontKey === o.key ? 'bg-primary text-white border-primary' : 'bg-white text-ink-soft border-clay-border hover:bg-primary-lighter')}>
                    {/* 每个选项用对应字体预览；「默认」固定用系统字体栈，不跟随当前全局字体 */}
                    <span style={o.family ? { fontFamily: o.family } : { fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif' }}>{o.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>,
          document.body
        )}
      </div>
    );
  }

  return (
    <div className={`inline-flex items-center gap-0.5 bg-white/80 rounded-full p-0.5 shadow-sm border border-gray-100 ${size === 'md' ? 'p-1' : ''} ${className}`}>
      {OPTS.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => change(v)}
          className={`rounded-full transition-all ${
            size === 'md' ? 'text-xs px-3 py-2 min-h-[36px] min-w-[40px]' : compact ? 'text-[11px] sm:text-xs px-2 py-2 min-h-[36px] min-w-[32px]' : 'text-[11px] sm:text-xs px-2.5 py-2 min-h-[36px] min-w-[40px]'
          } ${
            lang === v ? 'bg-primary-strong text-white font-medium' : 'text-ink-soft hover:bg-primary-lighter hover:text-primary'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
