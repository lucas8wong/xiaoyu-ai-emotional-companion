import { isLocalAndroidApp } from './androidApp';

/** Delivery channel, not the phone OS. Safari/PWA and Android browsers remain web. */
export function clientEnvironment(): { client: 'web' | 'ios-web' | 'ios-home' | 'android-app'; appVersion?: string } {
  if (!isLocalAndroidApp()) {
    const ios = typeof navigator !== 'undefined' && (/iPhone|iPad|iPod/i.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
    const standalone = ios && (('standalone' in navigator && navigator.standalone === true)
      || window.matchMedia?.('(display-mode: standalone)').matches);
    return { client: ios ? standalone ? 'ios-home' : 'ios-web' : 'web' };
  }
  const version = window.__XIAOYU_ANDROID__?.versionName;
  return { client: 'android-app', ...(version && /^[0-9]{1,8}(\.[0-9]{1,8}){1,3}$/.test(version) ? { appVersion: version } : {}) };
}

export function clientEnvironmentHeaders(): Record<string, string> {
  const source = clientEnvironment();
  return { 'X-Xiaoyu-Client': source.client, ...(source.appVersion ? { 'X-Xiaoyu-Version': source.appVersion } : {}) };
}
