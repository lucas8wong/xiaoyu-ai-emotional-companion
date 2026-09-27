/**
 * wolfcha 子应用挂载层（对齐 `WenyouPage → <WenyouApp />` 范式）
 *
 * 上游整套玩法界面（牌桌 / 叙事栏 / 身份卡 / 夜间旁白）由 `src/wolfcha/` 提供，
 * Apache-2.0；署名见 `src/wolfcha/LICENSE`、`docs/werewolf-porting.md`。
 *
 * 样式说明：它的 `globals.css` 是 **Tailwind v4** 写法，直接 import 会与我们项目的 v3 管线冲突
 * （v4 的原生 `@layer` vs v3 的 `@tailwind base`）。因此改用 v4 隔离编译成 `public/wolfcha.css`，
 * 进页面时才注入 `<link>` —— 既不经过 PostCSS，也不进打包图、不影响全站。
 */
import { useEffect } from 'react';
import { Toaster } from 'sonner';
import WolfchaGamePage from '../wolfcha/app/page';
import { I18nProvider } from '../wolfcha/i18n/I18nProvider';
import { installXiaoyuIdentity } from '../wolfcha/adapters/xiaoyu-identity';
import { toWolfchaLocale } from '../wolfcha/i18n/locale-store';
import { STORAGE_KEY } from '../wolfcha/i18n/config';
import { getLang } from '../i18n';

/**
 * 清掉旧版子应用自带语言开关留下的本地偏好。
 * 语言现在**只跟随小愈**（`cure_lang`，见 `i18n/locale-store.ts`），旧值继续留在
 * localStorage / cookie 里既无用处，又会在排查「界面英文但旁白中文」这类问题时误导。
 */
function clearLegacyLocaleOverride(): void {
  try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* 忽略 */ }
  try { document.cookie = `${STORAGE_KEY}=;path=/;max-age=0;SameSite=Lax`; } catch { /* 忽略 */ }
}

function useWolfchaCss(): void {
  useEffect(() => {
    const id = 'wolfcha-css';
    if (document.getElementById(id)) return;
    // ⚠️ 必须带版本参数：文件名不带 hash，而 CDN 对 .css 默认缓存 7 天——
    // 实测线上曾命中 Age≈41h 的旧 wolfcha.css（源站已更新，用户仍看不到新样式）。
    // 改 wolfcha 样式后把版本 +1（与项目里 /skins/*?v= 同一套做法）；源站也已改为 no-cache 强制回源校验。
    const CSS_V = '5';
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = `/wolfcha.css?v=${CSS_V}`;
    document.head.appendChild(link);
    // 小愈侧的样式修正（弹窗居中双重平移等），必须在 /wolfcha.css 之后加载
    const fix = document.createElement('link');
    fix.rel = 'stylesheet';
    fix.href = `/wolfcha-overrides.css?v=${CSS_V}`;
    document.head.appendChild(fix);
  }, []);
}

export default function WolfchaApp() {
  // 身份桥：给它发往本站的请求补上小愈的身份头，计费/次数闸门/运营端统计才能认到人
  useEffect(() => {
    installXiaoyuIdentity();
    clearLegacyLocaleOverride();
  }, []);
  useWolfchaCss();
  return (
    <I18nProvider initialLocale={toWolfchaLocale(getLang())}>
      {/*
        🚨 必须挂 `<Toaster />`（2026-09-27 补）：子应用里 5 个文件都在调 `toast()`（开局反馈、
        额度被拦的出路说明、自定义角色保存结果…），但**全站从来没有挂过 Toaster** —— 那些提示
        全是隐形的，用户看到的就是「点了没反应」（WelcomeScreen 里那几处"移植适配：给可见反馈"
        的注释因此一直是空转）。挂在这里 = 作用域只在狼人杀子应用内，不影响主应用。
      */}
      <Toaster position="top-center" richColors closeButton />
      <WolfchaGamePage />
    </I18nProvider>
  );
}
