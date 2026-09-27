/**
 * 界面展示字体（品牌/标题/tagline 等 `.font-display` 与全局正文）——按「界面语言 + 文字脚本」联动。
 * 简体(zh-CN)→简体字；繁体(zh-TW)→繁体字；英文(en)→英文。
 * 字体完全自托管（src/fonts-display.css → /fonts/display/*，Google Fonts 子集 + 霞鹜文楷）。
 */
import type { Lang } from '../i18n';

export interface FontOption {
  key: string;
  label: string;
  family: string; // @font-face 的 font-family 名；''=不设（用皮肤/系统）
  group: string;
}

// 简体中文展示字体（马善政/志莽行/龙藏/霞鹜文楷 为简体字形）
export const ZH_FONTS: FontOption[] = [
  { key: 'default', label: '经典', family: '', group: '经典' },
  { key: 'xingkai', label: '行楷', family: "'Ma Shan Zheng'", group: '书法' },
  { key: 'xingcao', label: '行草', family: "'Zhi Mang Xing'", group: '书法' },
  { key: 'shuxie', label: '书写楷', family: "'Long Cang'", group: '书法' },
  { key: 'kuaile', label: '快乐体', family: "'ZCOOL KuaiLe'", group: '可爱' },
  { key: 'chill', label: '圆润体', family: "'ChillRoundF'", group: '可爱' },
  { key: 'wenqi', label: '文气手写', family: "'LXGW WenKai'", group: '手写' },
];

// 繁体中文展示字体（覆盖繁体字形，OFL）
export const ZH_TW_FONTS: FontOption[] = [
  { key: 'default', label: '經典', family: '', group: '經典' },
  { key: 'shujuan', label: '書卷', family: "'Noto Serif TC'", group: '書法' },
  { key: 'iansui', label: '芫荽', family: "'Iansui'", group: '書法' },
  { key: 'kexuan', label: '粉圓', family: "'jf Open Huninn'", group: '可愛' },
  { key: 'zen', label: '圓體', family: "'Zen Maru Gothic'", group: '可愛' },
];

// 英文展示字体（用户选定 6 款）
export const EN_FONTS: FontOption[] = [
  { key: 'default', label: 'Classic', family: '', group: 'Classic' },
  { key: 'cormorant', label: 'Cormorant Garamond', family: "'Cormorant Garamond'", group: 'Serif' },
  { key: 'ebgaramond', label: 'EB Garamond', family: "'EB Garamond'", group: 'Serif' },
  { key: 'baloo', label: 'Baloo 2', family: "'Baloo 2'", group: 'Rounded' },
  { key: 'inter', label: 'Inter', family: "'Inter'", group: 'Sans-serif' },
  { key: 'caveat', label: 'Caveat', family: "'Caveat'", group: 'Handwriting' },
  { key: 'dancing', label: 'Dancing Script', family: "'Dancing Script'", group: 'Handwriting' },
];

const CN_KEY = 'cure_font_preview';
const TW_KEY = 'cure_font_tw_preview';
const EN_KEY = 'cure_en_font_preview';

function getStored(k: string, fallback = 'default'): string { try { return localStorage.getItem(k) || fallback; } catch { return fallback; } }
function setStored(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* 忽略 */ } }

/** 按界面语言返回当前文字脚本应展示的字体选项 */
export function fontsForLang(lang: Lang): FontOption[] {
  if (lang === 'en') return EN_FONTS;
  if (lang === 'zh-TW') return ZH_TW_FONTS;
  return ZH_FONTS;
}

/** 当前语言音下选中的字体 key */
export function fontKeyFor(lang: Lang): string {
  if (lang === 'en') return getStored(EN_KEY, 'default');
  if (lang === 'zh-TW') return getStored(TW_KEY, 'default');
  // 简体：未自选时默认「圆润体」；已自选则尊重用户选择
  return getStored(CN_KEY, 'chill');
}

/** 保存当前语言的字体 key */
export function setFontKey(lang: Lang, k: string): void {
  if (lang === 'en') setStored(EN_KEY, k);
  else if (lang === 'zh-TW') setStored(TW_KEY, k);
  else setStored(CN_KEY, k);
}

/** 当前语言下选中的字体 family（''=不设） */
export function activeFontFamily(lang: Lang): string {
  const list = fontsForLang(lang);
  const k = fontKeyFor(lang);
  return (list.find(o => o.key === k)?.family) || '';
}

/**
 * 把当前语言对应的展示字体全局应用：
 * ① `--skin-display-font`（.font-display 展示文字）
 * ② `:root` 基础字体（所有可见正文/按钮继承，简体/繁体各用对应字体）
 * 默认（未选字）= 移除，回到皮肤字体 / Nunito Sans。
 */
export function applyFontStyle(lang: Lang): void {
  const root = document.documentElement;
  const fam = activeFontFamily(lang);
  if (fam) {
    root.style.setProperty('--skin-display-font', `${fam}, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif`);
    root.style.fontFamily = `${fam}, "Nunito Sans", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif`;
    // 预取：让所选字体尽早就绪（启动时有已存字体 → 页面加载即开始下载子集；换字后立刻开始下载），减少换字体后的等待
    try { document.fonts.load(`16px ${fam}`).catch(() => {}); } catch { /* 忽略 */ }
  } else {
    root.style.removeProperty('--skin-display-font');
    root.style.fontFamily = '';
  }
}
