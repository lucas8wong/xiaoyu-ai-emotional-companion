/* Runs before the bundled application. The origin is unchanged from Android 1.0. */
(() => {
  const state = window.__XIAOYU_ANDROID__;
  if (!state) return;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    let target = input;
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin === location.origin && url.pathname.startsWith('/api/') &&
        state.backendOrigins.includes(state.backendOrigin) && state.backendOrigin !== location.origin) {
      const next = state.backendOrigin + url.pathname + url.search;
      target = input instanceof Request ? new Request(next, input) : next;
    }
    // No automatic replay of POST/PUT/DELETE or generation streams when a route changes.
    return originalFetch(target, init);
  };
  // An earlier WebView may have registered the site's SW. Unregister only that worker,
  // keeping localStorage, IndexedDB, cookies and all business data intact.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => {
      return Promise.all(regs.map(reg => reg.unregister()));
    }).catch(() => {});
  }
  document.addEventListener('click', async event => {
    const link = event.target.closest?.('a[download]');
    if (!link || !window.XiaoyuHost || !/^(blob:|data:image\/)/.test(link.href)) return;
    event.preventDefault();
    try {
      const response = await originalFetch(link.href);
      const blob = await response.blob();
      if (blob.size > 24 * 1024 * 1024 || !/^image\/(png|jpeg|webp)$/.test(blob.type)) return;
      const reader = new FileReader();
      reader.onload = () => window.XiaoyuHost.postMessage(JSON.stringify({ action: 'saveImage', name: link.download || 'xiaoyu.png', data: reader.result }));
      reader.readAsDataURL(blob);
    } catch { /* The app keeps the current image available for another attempt. */ }
  }, true);
})();
