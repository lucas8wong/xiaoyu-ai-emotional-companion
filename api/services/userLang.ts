/**
 * 用户语言 / 地区推断（发信与运营报表共用一份口径）
 *
 * 为什么单独成模块：邮件语言此前只写在 `proTrialNewcomer.ts`（新人 Pro 试用那封）里，
 * 现在「会员开通通知」（`memberNotifier.ts`）也要用同一套判断。按项目既有做法
 * （见 `accountFilters.ts` 的注释：同一个口径只留一份，避免两处各写一份、日后漂移），
 * 把它抽到这里，`proTrialNewcomer` 原样 re-export，老调用点与单测**不受影响**。
 *
 * 口径（与抽取前逐字一致）：
 *   港/澳/台 → 繁中；中国大陆 → 简中；其它国家 → 英文；无地区记录 → 显式语言偏好 → 英文（应用默认）。
 */

import { activityStore } from './activity.js';
import { preferenceStore } from './preferences.js';
import { lookupIp, countryCodeToName } from './geo.js';
import type { OutputLang } from './zhConvert.js';

export type EmailLang = OutputLang;

/**
 * 由用户的「最近 IP/国家」推断邮件语言。
 * 港/澳/台 → 繁中；中国大陆 → 简中；其它国家 → 英文；无 IP/国家记录 → 英文（默认语言）。
 */
export function inferLanguageForUser(userId: string): EmailLang {
  const act = activityStore.get(userId);
  const code = String(act?.lastCountry || '').trim().toUpperCase();
  if (code === 'CN') return 'zh-CN';
  if (code === 'HK' || code === 'MO' || code === 'TW') return 'zh-TW';
  if (code) return 'en'; // 有国家码但非大中华区 → 英文

  const ip = String(act?.lastIp || '').trim();
  if (ip) {
    try {
      const g = lookupIp(ip);
      if (g.country === '香港' || g.country === '澳门' || g.country === '台湾') return 'zh-TW';
      if (g.country === '中国大陆') return 'zh-CN';
    } catch {
      /* 忽略定位异常，回退 */
    }
    return 'en';
  }

  // 无 IP/国家记录 → 回退「已显式保存的语言偏好」；无偏好记录 → 英文（应用默认语言）
  const pref = preferenceStore.listAll().find((p) => p.userId === userId);
  const lang = pref?.language;
  return lang === 'zh-CN' || lang === 'zh-TW' || lang === 'en' ? lang : 'en';
}

/** 用户地区标签（格式化为便于阅读；港/澳/台/大陆/国家名，未知为空串） */
export function regionLabelForUser(userId: string): string {
  const act = activityStore.get(userId);
  const code = String(act?.lastCountry || '').trim().toUpperCase();
  if (code) {
    const name = countryCodeToName(code);
    return name || code;
  }
  const ip = String(act?.lastIp || '').trim();
  if (ip) {
    try {
      return lookupIp(ip).country;
    } catch {
      return '';
    }
  }
  return '';
}
