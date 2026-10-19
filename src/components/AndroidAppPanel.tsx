import { useEffect, useState } from 'react';
import { getLang } from '../i18n';
import { androidCommand, isLocalAndroidApp, type AndroidAppState } from '../lib/androidApp';

/** Lives on Home: a new APK never interrupts a conversation or discards a draft. */
export default function AndroidAppPanel() {
  const [state, setState] = useState<AndroidAppState | undefined>(() => window.__XIAOYU_ANDROID__);
  useEffect(() => {
    if (!isLocalAndroidApp()) return;
    const update = () => setState({ ...window.__XIAOYU_ANDROID__! });
    window.addEventListener('xiaoyu:android-state', update);
    return () => window.removeEventListener('xiaoyu:android-state', update);
  }, []);
  if (!isLocalAndroidApp() || !state) return null;
  const lang = getLang();
  const en = lang === 'en';
  const tw = lang === 'zh-TW';
  const text = (zh: string, traditional: string, english: string) => en ? english : tw ? traditional : zh;
  const busy = state.update === 'checking' || state.update === 'downloading';
  const available = state.update === 'available';
  const ready = state.update === 'ready';
  const status = state.update === 'checking' ? text('正在检查更新…', '正在檢查更新…', 'Checking for updates…')
    : state.update === 'current' ? text('已是最新版本', '已是最新版本', 'App is up to date')
    : available ? text(`新版本 ${state.latestVersion} 可用`, `新版本 ${state.latestVersion} 可用`, `Version ${state.latestVersion} is available`)
    : state.update === 'downloading' ? text(`正在下载更新 ${state.progress || 0}%`, `正在下載更新 ${state.progress || 0}%`, `Downloading update ${state.progress || 0}%`)
    : ready ? text('更新已下载，可覆盖安装', '更新已下載，可覆蓋安裝', 'Update downloaded and ready to install')
    : state.update === 'failed' ? text('更新检查或下载失败，请重试', '更新檢查或下載失敗，請重試', 'Update check or download failed. Try again.') : '';
  return <section aria-label={text('安卓 App', '安卓 App', 'Android app')} className="mx-auto mb-4 max-w-4xl rounded-2xl border border-primary/20 bg-surface p-3 text-sm text-ink">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="font-semibold">App · {state.versionName}</span>
      {window.XiaoyuHost ? <button type="button" disabled={busy} className="min-h-11 rounded-xl border border-primary/30 px-3 text-primary-text disabled:opacity-60"
        onClick={() => androidCommand(ready ? 'installUpdate' : available ? 'downloadUpdate' : 'checkUpdate')}>
        {ready ? text('安装更新', '安裝更新', 'Install update') : available ? text('下载更新', '下載更新', 'Download update') : text('检查更新', '檢查更新', 'Check for updates')}
      </button> : <a href="https://myxiaoyu.com/download/" className="inline-flex min-h-11 items-center rounded-xl px-3 text-primary-text">{text('打开下载页', '打開下載頁', 'Open download page')}</a>}
    </div>
    <p role="status" className="mt-1 text-xs text-ink-soft">{status}</p>
    {state.connection === 'offline' && <div className="mt-2 border-t border-primary/15 pt-2">
      <p className="text-xs text-ink-soft">{text('界面已在本机打开，暂时连不上服务。登录和 AI 对话需要联网。', '介面已在本機打開，暫時連不上服務。登入和 AI 對話需要連線。', 'The interface is available on your device. Connect to the service to sign in or chat with AI.')}</p>
      <button type="button" onClick={() => androidCommand('checkConnection')} className="mt-1 min-h-11 rounded-xl px-3 text-primary-text">{text('重试连接', '重試連線', 'Retry connection')}</button>
    </div>}
  </section>;
}
