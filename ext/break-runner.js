// Service worker side of the break actions (see break-actions.js): when a commercial is auto-muted,
// open/switch to the chosen tab and play it.
// When the game is back, pause it and switch back.
//
// The running break lives in chrome.storage.session ('breakRun') because the service worker can be
// stopped mid-break. 'breakTabId' remembers the tab it opened so the next break reuses it.

// Breaks start/end from a stream of state messages; run them one at a time so two quick
// messages can't open two tabs.
let breakQueue = Promise.resolve();
function queueBreak(fn) {
  breakQueue = breakQueue.then(fn).catch((err) => console.warn('break action:', err));
  return breakQueue;
}

// Called with every state the offscreen document reports for the stream tab.
function onStreamState(state) {
  if (state.tabId == null) return;
  if (!state.stopped && state.muted && state.override !== 'manual') queueBreak(() => startBreak(state.tabId));
  else if (state.stopped || !state.muted) queueBreak(() => endBreak());
}

async function startBreak(streamTabId) {
  const { breakRun } = await chrome.storage.session.get('breakRun');
  if (breakRun) return;
  const cfg = await getBreakSettings();
  const mode = breakMode(cfg.mode);
  if (mode.id === 'none') return;
  const streamTab = await chrome.tabs.get(streamTabId).catch(() => null);
  if (!streamTab) return;

  // Only take you away from the game if you're watching it.
  const doSwitch = cfg.switchTab && streamTab.active;
  let tab = null;
  let opened = false;
  if (mode.id === 'tab') {
    tab = await findChosenTab(cfg.tab);
    if (!tab) return;
  } else {
    const url = normalizeUrl(cfg[mode.field]);
    if (!url) return;
    tab = await reusableTab(url);
    if (!tab) {
      tab = await chrome.tabs.create({ url, windowId: streamTab.windowId, index: streamTab.index + 1, active: doSwitch });
      opened = true;
    }
  }
  if (doSwitch) await activate(tab);
  await chrome.storage.session.set({
    breakRun: { mode: mode.id, streamTabId, tabId: tab.id, switched: doSwitch, opened },
    ...(mode.id === 'tab' ? {} : { breakTabId: tab.id }),
  });
  if (mode.media) {
    if (opened) await waitForLoad(tab.id);
    await runMedia(tab.id, opened ? 'start' : 'play');
  }
}

async function endBreak() {
  const { breakRun: run } = await chrome.storage.session.get('breakRun');
  if (!run) return;
  await chrome.storage.session.set({ breakRun: null });
  const cfg = await getBreakSettings();
  const mode = breakMode(run.mode);
  const tab = await chrome.tabs.get(run.tabId).catch(() => null);
  if (!tab) return;
  if (mode.media && cfg.pauseOnReturn) await runMedia(tab.id, 'pause');
  // Switch back only if you're still on the tab it switched to.
  if (run.switched && cfg.returnToGame && tab.active) {
    const streamTab = await chrome.tabs.get(run.streamTabId).catch(() => null);
    if (streamTab) await activate(streamTab);
  }
  if (cfg.closeOnReturn && run.opened) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    await chrome.storage.session.set({ breakTabId: null });
  }
}

async function activate(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  const win = await chrome.windows.getLastFocused().catch(() => null);
  if (!win || win.id !== tab.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
}

// The tab opened in an earlier break, if it's still on the same site.
async function reusableTab(url) {
  const { breakTabId } = await chrome.storage.session.get('breakTabId');
  if (breakTabId == null) return null;
  const tab = await chrome.tabs.get(breakTabId).catch(() => null);
  if (!tab || !tab.url) return null;
  try {
    return new URL(tab.url).hostname === new URL(url).hostname ? tab : null;
  } catch {
    return null;
  }
}

// Tab ids don't survive a browser restart, so fall back to the saved URL.
async function findChosenTab(saved) {
  if (!saved) return null;
  const byId = saved.id != null ? await chrome.tabs.get(saved.id).catch(() => null) : null;
  if (byId) return byId;
  const [byUrl] = saved.url ? await chrome.tabs.query({ url: saved.url.split('#')[0] }).catch(() => []) : [];
  return byUrl || null;
}

function waitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((t) => t.status === 'complete' && done(), done);
  });
}

async function runMedia(tabId, action) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: breakMediaControl, args: [action] });
  } catch {
    // e.g. the tab navigated to a page scripts can't run on
  }
}

// Runs inside the music tab (every frame). action: 'start' (just opened), 'play' (resume), 'pause'.
// Media elements it pauses are marked, so resuming restarts exactly those.
async function breakMediaControl(action) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MARK = 'data-commercial-mute-paused';
  const media = () => [...document.querySelectorAll('video, audio')];
  const spotify = location.hostname === 'open.spotify.com';

  if (action === 'pause') {
    if (spotify && navigator.mediaSession.playbackState === 'playing') {
      document.querySelector('[data-testid="control-button-playpause"]')?.click();
    }
    for (const m of media()) {
      if (!m.paused) {
        m.setAttribute(MARK, '');
        m.pause();
      }
    }
    return;
  }

  if (spotify) {
    // The player loads after the page; give it a few seconds.
    for (let i = 0; i < 20; i++) {
      if (navigator.mediaSession.playbackState === 'playing') return;
      const big = action === 'start' && document.querySelector('[data-testid="action-bar-row"] [data-testid="play-button"]');
      const ctl = document.querySelector('[data-testid="control-button-playpause"]');
      if (big || ctl) {
        (big || ctl).click();
        return;
      }
      await sleep(500);
    }
    return;
  }

  // Wait for the page's player to appear (YouTube builds it after load).
  for (let i = 0; i < 20 && !media().length; i++) await sleep(500);
  if (window !== window.top && !media().length) return;
  const marked = media().filter((m) => m.hasAttribute(MARK));
  const targets = marked.length ? marked : media().filter((m) => m.paused && (m.currentSrc || m.srcObject)).slice(0, 1);
  for (const m of targets) {
    m.removeAttribute(MARK);
    m.play().catch(() => {}); // can be blocked by autoplay rules until you've clicked play in that tab once
  }
}
