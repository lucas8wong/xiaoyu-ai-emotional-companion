"use client";

/**
 * 狼人杀 i18n Provider。
 *
 * 语言唯一来源＝小愈的用户语言：由 `src/components/WolfchaApp.tsx` 读 `getLang()`
 * 映射后经 `initialLocale` 传进来（见 `i18n/locale-store.ts` 顶部说明）。
 * 子应用不再有自己的语言设置（语言切换器已移除），因此这里不再订阅任何 store：
 * 用户在站内换语言后重新进入游戏即生效，不存在「游戏内改了语言但主站不知道」的分叉。
 */

import { NextIntlClientProvider } from "next-intl";
import { useEffect, useMemo } from "react";
import { defaultLocale, localeToHtmlLang, type AppLocale } from "./config";
import { getMessages } from "./messages";

type I18nProviderProps = {
  children: React.ReactNode;
  initialLocale?: AppLocale;
};

export function I18nProvider({ children, initialLocale = defaultLocale }: I18nProviderProps) {
  const locale: AppLocale = initialLocale;
  const messages = useMemo(() => getMessages(locale), [locale]);

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = localeToHtmlLang[locale];
    }
  }, [locale]);

  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Shanghai">
      {children}
    </NextIntlClientProvider>
  );
}
