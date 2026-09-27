import en from "./messages/en.json";
import zh from "./messages/zh.json";
import zhTW from "./messages/zh-TW.json";
import { defaultLocale, type AppLocale } from "./config";

export type AppMessages = typeof zh;

export const messagesByLocale: Record<AppLocale, AppMessages> = { zh, "zh-TW": zhTW, en };

export const getMessages = (locale: AppLocale): AppMessages => {
  return messagesByLocale[locale] ?? messagesByLocale[defaultLocale];
};
