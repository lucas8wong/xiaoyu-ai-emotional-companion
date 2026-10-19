export type AndroidAppState = {
  versionName: string;
  versionCode: number;
  openSequence?: number;
  backendOrigin: string;
  backendOrigins: string[];
  connection?: 'checking' | 'online' | 'offline';
  update?: 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'failed';
  latestVersion?: string;
  updateDelivery?: 'browser';
  progress?: number;
};

declare global {
  interface Window {
    __XIAOYU_ANDROID__?: AndroidAppState;
    XiaoyuHost?: { postMessage: (message: string) => void };
  }
}

export function isLocalAndroidApp(): boolean {
  return import.meta.env.VITE_ANDROID_LOCAL === '1';
}

export function androidCommand(action: 'checkUpdate' | 'downloadUpdate' | 'installUpdate' | 'checkConnection'): void {
  if (!isLocalAndroidApp()) return;
  window.XiaoyuHost?.postMessage(JSON.stringify({ action }));
}
