import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getLang } from '../i18n';
import { companionShortName } from '../lib/companionName';
import { androidCommand, isLocalAndroidApp, type AndroidAppState } from '../lib/androidApp';
import { createAndroidUpdatePromptGate } from '../lib/androidUpdatePrompt';

// One reminder per native foreground visit; never writes account or save data.
const gate = createAndroidUpdatePromptGate();

export default function AndroidUpdateNotice() {
  const [state, setState] = useState<AndroidAppState | undefined>(() => window.__XIAOYU_ANDROID__);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const session = String(state?.openSequence ?? 1);
  useEffect(() => {
    if (!isLocalAndroidApp()) return;
    const update = () => setState({ ...window.__XIAOYU_ANDROID__! });
    window.addEventListener('xiaoyu:android-state', update);
    update();
    return () => {
      window.removeEventListener('xiaoyu:android-state', update);
    };
  }, []);
  useEffect(() => {
    if (!isLocalAndroidApp()) return;
    if (gate.enter(session)) setOpen(false);
  }, [session]);
  useEffect(() => {
    if (!isLocalAndroidApp() || open || !session || !gate.pending(state?.update)) return;
    let timer: number | undefined;
    const attempt = () => {
      const anotherDialog = Array.from(document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"], [aria-modal="true"]'))
        .some(node => node !== dialog.current && node.getClientRects().length > 0 && node.getAttribute('aria-hidden') !== 'true');
      const typing = document.activeElement?.matches('input, textarea, [contenteditable="true"]') || false;
      if (gate.claim(state?.update, document.visibilityState !== 'visible' || anotherDialog || typing)) setOpen(true);
    };
    // Throttle instead of debouncing: animated homepage styles must not starve a reminder.
    const schedule = () => { if (timer === undefined) timer = window.setTimeout(() => { timer = undefined; attempt(); }, 300); };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'aria-hidden', 'style'] });
    document.addEventListener('visibilitychange', schedule);
    document.addEventListener('focusout', schedule);
    schedule();
    return () => { window.clearTimeout(timer); observer.disconnect(); document.removeEventListener('visibilitychange', schedule); document.removeEventListener('focusout', schedule); };
  }, [session, state?.update, open]);
  useEffect(() => { if (state?.update === 'current') setOpen(false); }, [state?.update]);
  useLayoutEffect(() => {
    if (!open || !dialog.current) return;
    const node = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    node.showModal();
    document.body.style.overflow = 'hidden';
    return () => { node.close(); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [open]);
  if (!isLocalAndroidApp() || !state || !open || !session) return null;
  const lang = getLang();
  const text = (zh: string, tw: string, en: string) => lang === 'en' ? en : lang === 'zh-TW' ? tw : zh;
  const busy = state.update === 'checking' || state.update === 'downloading';
  const ready = state.update === 'ready';
  const status = state.update === 'downloading' ? text(`正在下载 ${state.progress || 0}%`, `正在下載 ${state.progress || 0}%`, `Downloading ${state.progress || 0}%`)
    : ready ? text('已下载完成，可以安装了。', '已下載完成，可以安裝了。', 'Downloaded and ready to install.')
    : state.update === 'failed' ? text('暂时无法更新，可以重试或下次再说。', '暫時無法更新，可以重試或下次再說。', 'Could not update. Try again or leave it until later.')
    : state.update === 'checking' ? text('正在重新连接…', '正在重新連線…', 'Reconnecting…') : '';
  return <dialog ref={dialog} aria-labelledby="android-update-title" aria-describedby="android-update-description"
    onCancel={event => { event.preventDefault(); setOpen(false); }}
    style={{ position: 'fixed', inset: 0, margin: 'auto', background: 'var(--color-surface)', color: 'var(--color-fg)', maxHeight: 'calc(100dvh - 32px)' }}
    className="w-[calc(100%-2rem)] max-w-sm overflow-y-auto overscroll-contain rounded-3xl border border-primary/20 p-5 shadow-xl backdrop:bg-black/40">
    <h2 id="android-update-title" className="text-lg font-semibold">{text(`${companionShortName()}有新版本了`, `${companionShortName()}有新版本了`, `A new ${companionShortName()} version is available`)}</h2>
    <p className="mt-2 text-sm text-ink-soft">{text('版本', '版本', 'Version')} {state.latestVersion}</p>
    <p id="android-update-description" className="mt-2 text-sm leading-relaxed">{text('建议连接 Wi-Fi 下载，安装时直接覆盖，保留原 App 和存档。', '建議連接 Wi-Fi 下載，安裝時直接覆蓋，保留原 App 和存檔。', 'Use Wi-Fi to download. Install over the existing app to keep your saved data.')}</p>
    <p role="status" className="mt-3 text-sm text-ink-soft">{status}</p>
    <div className="mt-4 flex flex-wrap justify-end gap-2">
      <button type="button" className="min-h-11 rounded-xl border border-primary/25 px-4" onClick={() => setOpen(false)}>{text('下次再说', '下次再說', 'Later')}</button>
      {window.XiaoyuHost ? <button type="button" disabled={busy} className="min-h-11 rounded-xl bg-primary-strong px-4 font-semibold text-white disabled:opacity-60"
        onClick={() => androidCommand(ready ? 'installUpdate' : state.update === 'failed' ? 'checkUpdate' : 'downloadUpdate')}>
        {ready ? text('安装更新', '安裝更新', 'Install update') : state.update === 'failed' ? text('重试', '重試', 'Retry') : state.updateDelivery === 'browser' ? text('前往蒲公英更新', '前往蒲公英更新', 'Update on Pgyer') : text('下载更新', '下載更新', 'Download update')}
      </button> : <a href="https://www.pgyer.com/xiaoyu-ai-android" className="inline-flex min-h-11 items-center rounded-xl bg-primary-strong px-4 font-semibold text-white">{text('下载新版', '下載新版', 'Download update')}</a>}
    </div>
  </dialog>;
}
