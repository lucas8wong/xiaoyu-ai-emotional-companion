/* Console navigation: reuse one browser checkpoint; never push from popstate. */
(function () {
  'use strict';
  if (typeof window.switchTab !== 'function') return;
  var key = 'xiaoyuConsoleBack', history = window.history;
  var old = history.state && history.state[key];
  var session = old && old.session || Date.now() + '-' + Math.random().toString(36).slice(2);
  var position = old ? old.position : 0, restoring = false, exiting = false;
  var replace = history.replaceState.bind(history), sourceUrl = location.href, sourceState;
  var exitUntil = 0, timer, trail = [], layers = new Map(), sequence = 0, trigger;
  var openedDetails = [], listParent = null;
  var status = document.createElement('div');
  status.id = 'consoleBackStatus'; status.className = 'toast';
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true'); document.body.appendChild(status);
  function resetExit() {
    exitUntil = 0; clearTimeout(timer); status.textContent = ''; status.classList.remove('show');
  }
  function visible(el) {
    return !!(el && el.isConnected && !el.closest('[hidden],.hidden') && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  }
  function focus(el) { if (visible(el) && el.focus) el.focus({ preventScroll: true }); }
  function currentTab() {
    var el = document.querySelector('.nav-item.active');
    return el ? el.dataset.tab : 'dash';
  }
  function tag(state) {
    var data = Object.assign({}, state || {}); data[key] = { session: session, position: position }; return data;
  }
  history.replaceState = function (state, unused, url) {
    replace(tag(state), unused, url); sourceUrl = location.href; sourceState = history.state;
  };
  history.replaceState(history.state, '', sourceUrl);
  if (!old) {
    position = 1; history.pushState(tag(history.state), '', sourceUrl); sourceState = history.state;
  }
  history.scrollRestoration = 'manual';
  var switchTab = window.switchTab;
  var navigatingBack = false;
  window.switchTab = function (name) {
    var before = currentTab(), view = window.PEOPLE_VIEW;
    var normalized = name === 'activity' ? 'users' : name === 'attr' ? 'promotion' : name;
    var different = before !== normalized;
    if (!navigatingBack && different) {
      if (normalized === 'dash') trail = [];
      else trail.push({ tab: before, people: view, y: window.scrollY, focus: document.activeElement });
    }
    resetExit(); return switchTab.apply(this, arguments);
  };
  // Keep a native list alive while its user detail is on top, including search and scroll.
  window.adminBackFromList = function (el, open) {
    el.dataset.backSuspended = 'true';
    listParent = { el: el, focus: document.activeElement, y: el.scrollTop };
    el.close(); open();
  };
  var closeDetail = window.closeActDetail;
  window.closeActDetail = function () {
    closeDetail.apply(this, arguments);
    if (listParent) {
      var parent = listParent; listParent = null;
      if (parent.el.isConnected) {
        parent.el.showModal(); parent.el.scrollTop = parent.y; focus(parent.focus);
        // The preceding close event is queued; keep its suspension marker until it fires.
        setTimeout(function () { delete parent.el.dataset.backSuspended; }, 0);
      }
    }
  };
  function layerRoot(el) {
    if (el.matches('dialog,.act-detail-modal,.reward-modal')) return el;
    var parent = el;
    while (parent && parent !== document.body) {
      if (getComputedStyle(parent).position === 'fixed') return parent;
      parent = parent.parentElement;
    }
    return el;
  }
  function syncLayers() {
    var active = new Set();
    document.querySelectorAll('dialog[open],.act-detail-modal,.reward-modal,#manualRewardModal,#shareApproveModal,[role="dialog"][aria-modal="true"]').forEach(function (el) {
      var root = layerRoot(el);
      if (!visible(root)) return;
      active.add(root);
      if (!layers.has(root)) { layers.set(root, { order: ++sequence, focus: trigger }); resetExit(); }
    });
    layers.forEach(function (_, el) { if (!active.has(el)) layers.delete(el); });
  }
  var closers = {
    actChatWrap: 'closeActivityChat', actDetailModal: 'closeActDetail', prefDetailModal: 'closePrefDetail',
    drillModal: 'closeDrill', geoRegionModal: 'closeGeoRegion', refDetailModal: 'closeRefDetail',
    ugcDetailModal: 'closeUgcDetail', ugcRejectModal: 'closeUgcReject', communityPostDetailModal: 'closeCommunityPostDetail',
    manualRewardModal: 'closeManualReward', shareApproveModal: 'closeShareApprove', rewardModal: 'closeRewardModal'
  };
  function closeLayer(el) {
    if (closers[el.id] && typeof window[closers[el.id]] === 'function') window[closers[el.id]]();
    else if (el.matches('dialog')) el.close();
    else {
      var button = el.querySelector('#gsClose,[data-close],.act-detail-close,.reward-modal-close');
      if (button) button.click();
      else return false;
    }
    return true;
  }
  function consumeBack() {
    syncLayers();
    var top = Array.from(layers.keys()).sort(function (a, b) {
      if (a.matches('dialog:modal') !== b.matches('dialog:modal')) return a.matches('dialog:modal') ? 1 : -1;
      return (Number(getComputedStyle(a).zIndex) || 0) - (Number(getComputedStyle(b).zIndex) || 0) || layers.get(a).order - layers.get(b).order;
    }).pop();
    var sidebar = document.getElementById('sidebar');
    if (!top && sidebar && sidebar.classList.contains('open')) { window.toggleSidebar(); resetExit(); return true; }
    if (!top && currentTab() === 'commerce' && window.adminCommerceBack && window.adminCommerceBack(true)) { resetExit(); return true; }
    // Only user-opened disclosure levels count; default dashboard/navigation groups do not.
    for (var i = openedDetails.length - 1; i >= 0; i--) {
      var detail = openedDetails[i];
      if (!detail.isConnected || !detail.open) { openedDetails.splice(i, 1); continue; }
      if (!visible(detail)) continue;
      if (top ? top.contains(detail) : !detail.closest('#sidebar')) {
        detail.open = false; openedDetails.splice(i, 1); focus(detail.querySelector('summary')); resetExit(); return true;
      }
    }
    if (top) {
      var origin = layers.get(top).focus;
      if (closeLayer(top)) { focus(origin); resetExit(); return true; }
    }
    var tab = currentTab();
    if (tab === 'energy' && window.adminEnergyBack && window.adminEnergyBack()) { resetExit(); return true; }
    if (tab === 'commerce' && window.adminCommerceBack && window.adminCommerceBack()) { resetExit(); return true; }
    if (tab === 'business' && visible(document.getElementById('expCancelBtn'))) { window.cancelExpenseEdit(); resetExit(); return true; }
    if (tab === 'prefs' && window.PREF_UI && PREF_UI.view !== 'stats') {
      var prefParent = PREF_UI.filter && PREF_UI.filter.kind === 'usage' ? 'usage' : 'stats';
      window.PREF_UI.filter = null; window.prefSetView(prefParent, true); resetExit(); return true;
    }
    if (tab === 'users' && window.PEOPLE_VIEW === 'behavior') { window.setPeopleView('account'); resetExit(); return true; }
    if (tab !== 'dash') {
      var previous = trail.pop() || { tab: 'dash' };
      navigatingBack = true;
      try {
        if (previous.people) window.PEOPLE_VIEW = previous.people;
        window.switchTab(previous.tab);
      } finally { navigatingBack = false; }
      window.scrollTo(0, previous.y || 0); focus(previous.focus); return true;
    }
    if (Date.now() < exitUntil) { resetExit(); return false; }
    exitUntil = Date.now() + 2200; status.textContent = '再按一次返回键退出控制台'; status.classList.add('show');
    clearTimeout(timer); timer = setTimeout(resetExit, 2200); return true;
  }
  document.addEventListener('click', function (event) {
    trigger = event.target.closest('button,a,summary,input,select') || document.activeElement; resetExit();
    var summary = event.target.closest('summary');
    if (summary) {
      var detail = summary.parentElement;
      openedDetails = openedDetails.filter(function (item) { return item !== detail; });
      if (!detail.open) openedDetails.push(detail);
    }
  }, true);
  document.addEventListener('keydown', function (event) { if (event.key !== 'BrowserBack' && event.key !== 'Escape') resetExit(); }, true);
  new MutationObserver(syncLayers).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'open', 'style'] });
  syncLayers();
  window.addEventListener('popstate', function (event) {
    event.stopImmediatePropagation();
    var dest = event.state && event.state[key];
    var next = dest && dest.session === session ? dest.position : 0;
    if (exiting) { position = next; history.back(); return; }
    if (restoring && next === 1) {
      position = 1; restoring = false; history.replaceState(sourceState, '', sourceUrl); return;
    }
    if (next > position) { position = next; return; }
    position = next; history.replaceState(sourceState, '', sourceUrl);
    if (!consumeBack()) { exiting = true; history.back(); return; }
    restoring = true; history.go(1);
  }, true);
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    exiting = false; resetExit();
    var state = history.state && history.state[key]; position = state ? state.position : 0;
    if (position === 0) { restoring = true; history.go(1); }
  });
  if (old && position === 0) { restoring = true; history.go(1); }
})();
