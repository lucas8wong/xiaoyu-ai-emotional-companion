/**
 * 聊一聊 Emoji / 表情包 选择器
 * 内核：emoji-picker-react（自带分类/搜索/常用/皮肤色调，全面、省维护）
 * 表情包：在线贴纸搜索（后端配置化代理，默认未配置；命中「未配置」时给友好提示）
 * 外壳：贴合当前皮肤主题（背景沿用氛围底），背景透明度可调（滑块，默认取界面外观「卡片透明度」）
 */

import { useState, useRef, useEffect, type CSSProperties, type FormEvent } from 'react';
import EmojiPickerInner, { Theme, EmojiStyle, type EmojiClickData } from 'emoji-picker-react';
import { X } from 'lucide-react';
import { useSkin } from './SkinProvider';
import { t } from '../i18n';
import { stickerSearch, type StickerItem } from '../services/api';

interface EmojiPickerProps {
  /** 选中单个 emoji（父级负责插入输入框光标处；可连续点选） */
  onPick: (emoji: string) => void;
  /** 选中表情包（图片贴纸）；未提供时回退 onPick(url) */
  onPickSticker?: (url: string) => void;
  /** 关闭面板 */
  onClose: () => void;
  /** 当前语言，用于搜索框占位文案 */
  lang?: string;
  /** 桌面浮层模式（默认）：宽 340px、圆角、阴影；移动端停靠时传 true 改为全宽、贴底 */
  docked?: boolean;
  /** emoji 网格高度（px）。移动端停靠时传按视口算出的值，默认 280 */
  height?: number;
}

const SEARCH_PLACEHOLDER: Record<string, string> = {
  'zh-CN': '搜索表情…',
  'zh-TW': '搜尋表情…',
  en: 'Search emoji…',
};

/** 背景透明度下限，避免面板全透明看不清 */
const MIN_ALPHA = 0.35;
const clamp = (a: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, a));

export default function EmojiPicker({ onPick, onPickSticker, onClose, lang = 'zh-CN', docked = false, height = 280 }: EmojiPickerProps) {
  const { meta, cardBgAlpha } = useSkin();
  const [opacity, setOpacity] = useState(cardBgAlpha ?? 0.8);
  const bgAlpha = clamp(opacity, MIN_ALPHA, 1);
  const back = meta.bgPortrait || meta.bg;
  const white = (a: number) => `rgba(255,255,255,${clamp(a, 0, 1)})`;
  const pickerHeight = height ?? 280;
  // 移动端停靠：全宽 + 顶部圆角贴底；桌面浮层：固定 340px + 圆角 + 阴影
  const shellClass = docked
    ? 'flex flex-col w-full rounded-t-2xl overflow-hidden border-t border-clay-border'
    : 'flex flex-col w-[340px] max-w-[calc(100vw-16px)] rounded-2xl overflow-hidden shadow-xl border border-clay-border';

  // 【表情包（贴纸）搜索】
  const [mode, setMode] = useState<'emoji' | 'sticker'>('emoji');
  const [stickerQ, setStickerQ] = useState('');
  const [stickerLoading, setStickerLoading] = useState(false);
  const [stickerItems, setStickerItems] = useState<StickerItem[]>([]);
  const [stickerError, setStickerError] = useState<'not_configured' | 'error' | 'rate_limited' | null>(null);
  const [stickerSearched, setStickerSearched] = useState(false);
  const lastSearchRef = useRef(0);
  const searchWrapRef = useRef<HTMLDivElement>(null);

  const runStickerSearch = async (raw?: string) => {
    const query = (raw ?? stickerQ).trim();
    if (!query) return;
    // 冷却：1.2s 内不重发（防双击/连点，避免连续命中 ALAPI 限流）
    const now = Date.now();
    if (now - lastSearchRef.current < 1200 && stickerSearched) return;
    lastSearchRef.current = now;
    setStickerLoading(true);
    setStickerError(null);
    setStickerSearched(true);
    setStickerItems([]);
    const res = await stickerSearch(query);
    // 防御：兼容后端返回 `data.items`（新）或平铺 `items`（旧）两种形状；success 但取不到 = 无结果（不判失败）
    if (res.success) {
      const items = res.data?.items ?? (res as unknown as { items?: StickerItem[] }).items ?? [];
      setStickerItems(items);
    } else if ((res.error || '').includes('not_configured')) {
      setStickerError('not_configured');
    } else if ((res.error || '').includes('rate_limited')) {
      setStickerError('rate_limited');
    } else {
      setStickerError('error');
    }
    setStickerLoading(false);
  };

  const onSubmitSticker = (e: FormEvent) => {
    e.preventDefault();
    runStickerSearch();
  };

  // 【把「搜索」并入分类 Tab：在分类导航最前面插入搜索 Tab + "|" 分隔，并精简尺寸】
  useEffect(() => {
    if (mode !== 'emoji') return;
    const wrap = searchWrapRef.current;
    if (!wrap) return;
    const nav = wrap.querySelector('.epr-category-nav') as HTMLElement | null;
    if (!nav || nav.dataset.searchInjected) return;
    nav.dataset.searchInjected = '1';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'epr-search-tab';
    btn.setAttribute('aria-label', t('chatEmojiSearch'));
    btn.title = t('chatEmojiSearch');
    btn.innerHTML = '<span style="font-size:18px;line-height:1">🔍</span>';
    btn.addEventListener('click', () => {
      const open = wrap.classList.toggle('emoji-search-open');
      const inp = wrap.querySelector('.epr-search input, .epr-search-container input') as HTMLInputElement | null;
      if (open) setTimeout(() => { try { inp?.focus(); } catch { /* ignore */ } }, 30);
      else { try { inp?.blur(); } catch { /* ignore */ } }
    });
    const sep = document.createElement('span');
    sep.className = 'epr-search-sep';
    sep.textContent = '|';
    nav.insertBefore(sep, nav.firstChild);
    nav.insertBefore(btn, sep);
  }, [mode, t, lang]);

  // 精简分类 Tab 尺寸 / 分类标题字号，并默认隐藏检索行（由搜索 Tab 唤出）
  useEffect(() => {
    const styleId = 'epr-search-tab-styles';
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = [
      '.epr-category-nav{padding:4px 6px!important;gap:2px!important;min-height:0!important;height:auto!important}',
      '.epr-category-nav .epr-btn.epr-cat{width:26px!important;height:26px!important;font-size:14px!important}',
      '.epr-emoji-category-label{font-size:12px!important}',
      '.epr-main .epr-header > div:first-child{display:none!important}',
      '.emoji-search-open .epr-main .epr-header > div:first-child{display:flex!important}',
      '.epr-search-tab{width:26px;height:26px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;border-radius:8px;cursor:pointer;background:transparent;border:none;color:inherit;padding:0}',
      '.epr-search-tab:hover{background:rgba(31,164,107,0.12)}',
      '.epr-search-sep{color:#cbd5e1;margin:0 3px;font-size:14px;line-height:1;flex:0 0 auto}',
    ].join('\n');
    document.head.appendChild(style);
    return () => { /* 样式保留，全局复用 */ };
  }, []);

  // 换肤 + 透明度：直接打在 Picker 根（.epr-main）的内联 style 上，覆盖 --epr-* 变量
  const eprStyle: CSSProperties = {
    backgroundColor: white(bgAlpha),
    '--epr-bg-color': white(bgAlpha),
    '--epr-search-input-bg-color': white(bgAlpha + 0.06),
    '--epr-category-label-bg-color': white(bgAlpha + 0.14),
    '--epr-hover-bg-color': 'rgba(255,255,255,0.72)',
    '--epr-picker-border-color': 'transparent',
    '--epr-text-color': '#243B2E', // 墨绿字
    '--epr-highlight-color': '#1FA46B', // 主绿
    '--epr-category-icon-active-color': '#1FA46B',
  } as CSSProperties;

  const skinOverride = `
    .emj-skin .epr-main,
    .emj-skin .epr-main *{
      --epr-bg-color: ${white(bgAlpha)} !important;
    }
    .emj-skin .epr-main{
      background-color: ${white(bgAlpha)} !important;
      --epr-category-label-bg-color: ${white(bgAlpha + 0.14)} !important;
      --epr-search-input-bg-color: ${white(bgAlpha + 0.06)} !important;
      --epr-hover-bg-color: rgba(255,255,255,${clamp(bgAlpha + 0.12, 0, 1)}) !important;
    }
  `;

  return (
    <div
      className={shellClass + ' emj-skin'}
      style={{
        backgroundImage: back ? `url(${back})` : undefined,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundColor: white(bgAlpha),
      } as CSSProperties}
    >
      <style>{skinOverride}</style>
      {/* 分类 Tab 直接顶着面板上边框；模式切换 + 关闭移到下方工具条 */}
      {mode === 'emoji' ? (
        <div ref={searchWrapRef} className="relative flex flex-col min-h-0">
          <EmojiPickerInner
            onEmojiClick={(data: EmojiClickData) => onPick(data.emoji)}
            width="100%"
            height={pickerHeight}
            theme={Theme.LIGHT}
            emojiStyle={EmojiStyle.NATIVE}
            lazyLoadEmojis
            skinTonesDisabled
            previewConfig={{ showPreview: false }}
            searchPlaceHolder={SEARCH_PLACEHOLDER[lang] ?? SEARCH_PLACEHOLDER['zh-CN']}
            style={eprStyle}
          />
        </div>
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden" style={{ height: pickerHeight }}>
          <form onSubmit={onSubmitSticker} className="flex items-center gap-1.5 px-2.5 py-2 shrink-0">
            <input
              value={stickerQ}
              onChange={(e) => setStickerQ(e.target.value)}
              placeholder={t('chatStickerPh')}
              className="flex-1 h-8 px-2.5 rounded-full text-[13px] bg-white/70 border border-gray-200 outline-none focus:border-primary focus:bg-white transition-colors"
            />
            <button
              type="submit"
              disabled={stickerLoading}
              className="h-8 px-3 rounded-full bg-primary text-white text-[12px] font-medium hover:bg-primary-strong disabled:opacity-50 flex-shrink-0"
            >
              {stickerLoading ? '…' : t('chatStickerSearch')}
            </button>
          </form>

          <div className="flex-1 overflow-y-auto px-2.5 pb-2">
            {stickerSearched && !stickerLoading && stickerError === null && stickerItems.length === 0 && (
              <p className="text-center text-xs text-ink-soft pt-8">{t('chatStickerNoResult')}</p>
            )}
            {stickerError === 'not_configured' && (
              <div className="pt-6 px-1 text-center">
                <p className="text-[13px] text-ink font-medium">{t('chatStickerNotConfigured')}</p>
                <p className="text-[11px] text-ink-soft mt-1 leading-relaxed">{t('chatStickerNotConfiguredSub')}</p>
              </div>
            )}
            {stickerError === 'error' && (
              <p className="text-center text-xs text-red-500 pt-8">{t('chatStickerError')}</p>
            )}
            {stickerError === 'rate_limited' && (
              <p className="text-center text-xs text-amber-600 pt-8">{t('chatStickerRateLimited')}</p>
            )}
            {stickerLoading && (
              <p className="text-center text-xs text-ink-soft pt-8">{t('chatStickerLoading')}</p>
            )}
            {!stickerSearched && !stickerLoading && stickerError === null && (
              <p className="text-center text-xs text-ink-soft pt-8">{t('chatStickerHint')}</p>
            )}
            {stickerItems.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {stickerItems.map((s, i) => (
                  <button
                    key={i}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => (onPickSticker ? onPickSticker(s.url) : onPick(s.url))}
                    className="rounded-xl overflow-hidden border border-gray-100 hover:border-primary transition-colors"
                  >
                    <img src={'/api/stickers/img?u=' + encodeURIComponent(s.thumbUrl || s.url)} alt={s.title || ''} className="w-full h-20 object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {/* 底部工具条：模式切换 + 关闭（放到下方，让分类 Tab 顶着面板上边框） */}
      <div className="flex items-center gap-2 px-3 h-9 shrink-0 bg-white/40 backdrop-blur-sm border-t border-gray-100">
        <div className="flex items-center rounded-full bg-gray-100 p-0.5 flex-shrink-0">
          <button
            type="button"
            onClick={() => setMode('emoji')}
            className={`px-2 py-0.5 rounded-full text-[11px] transition-colors ${mode === 'emoji' ? 'bg-white text-primary shadow-sm' : 'text-ink-soft'}`}
          >
            😊 {t('chatTabEmoji')}
          </button>
          <button
            type="button"
            onClick={() => setMode('sticker')}
            className={`px-2 py-0.5 rounded-full text-[11px] transition-colors ${mode === 'sticker' ? 'bg-white text-primary shadow-sm' : 'text-ink-soft'}`}
          >
            🖼 {t('chatTabSticker')}
          </button>
        </div>
        {mode === 'emoji' ? (
          <label className="flex items-center gap-1.5 text-[11px] text-ink-soft flex-1 min-w-0">
            <span className="whitespace-nowrap">{t('chatEmojiBgAlpha')}</span>
            <input
              type="range"
              min={MIN_ALPHA}
              max={1}
              step={0.05}
              value={bgAlpha}
              onChange={(e) => setOpacity(Number(e.target.value))}
              className="flex-1 h-1 accent-[#1FA46B]"
              aria-label={t('chatEmojiBgAlpha')}
            />
          </label>
        ) : (
          <div className="flex-1" />
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('chatEmojiClose')}
          title={t('chatEmojiClose')}
          className="text-ink-soft hover:text-gray-600 p-1 rounded-md transition-colors flex-shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
