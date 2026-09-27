/**
 * 狼人杀语言适配层：**只跟随「小愈」的用户语言**（`cure_lang`），子应用不再有自己的语言设置。
 *
 * 背景（移植适配）：
 *  - 上游 wolfcha 是 Next.js 应用，语言来自 `/zh` 路径前缀 + 自己的 localStorage / cookie；
 *    小愈里语言是全站唯一设置（`src/i18n/index.ts` 的 `getLang()`，键 `cure_lang`），
 *    文游同款做法就是「不提供子应用内独立语言切换，外层 LangSwitch 是全 App 语言总控」
 *    （见 `src/wenyou/i18n.ts` 顶部注释）。
 *  - 子应用再存一份会出现**错配**：主站切成英文、子应用还留着旧的中文值 →
 *    「界面英文、旁白却是中文」这类问题，且用户无法在站内解释（游戏内切换器已移除）。
 *
 * 因此这里把 `wolfcha.locale`（localStorage/cookie）与 URL 前缀两条来源**全部关掉**：
 * 语言每次都实时读小愈设置（不存在缓存旧值）。历史遗留的那份 localStorage 键由
 * `src/components/WolfchaApp.tsx` 挂载时清除。
 */

import { getLang } from '../../i18n';
import type { AppLocale } from './config';

/** 小愈语言 → 子应用 locale（zh-CN→zh；zh-TW→zh-TW；其余（含未知值）→en，与旧行为一致） */
export const toWolfchaLocale = (lang?: string): AppLocale =>
  lang === 'zh-CN' ? 'zh' : lang === 'zh-TW' ? 'zh-TW' : 'en';

/** 当前语言：实时读小愈设置（用户在站内切换语言后，游戏重新进入即生效） */
export const getLocale = (): AppLocale => toWolfchaLocale(getLang());
