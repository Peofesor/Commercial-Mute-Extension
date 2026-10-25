// Service worker: toolbar click starts/stops capture of the current tab, hotkeys, toolbar badge,
// and relaying the mute state to the on-screen badge in the stream tab.
// Capture, analysis and muting run in the offscreen document. Break actions (music during ads)
// are in break-runner.js.

importScripts('break-actions.js', 'break-runner.js');

async function getState() {
  const { active = null, debugWindowId = null } = await chrome.storage.session.get(['active', 'debugWindowId']);
  return { active, debugWindowId };
}

async function getAutoEnabled() {
  const { autoEnabled = true } = await chrome.storage.local.get('autoEnabled');
  return autoEnabled;
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Capture tab audio/video to detect commercial breaks and play the tab audio back (muted during ads).',
  });
}

async function openDebugWindow() {
  const { debugWindowId } = await getState();
  if (debugWindowId != null) {
    try {
      await chrome.windows.update(debugWindowId, { focused: true });
      return;
    } catch {
      // window was closed
    }
  }
  const win = await chrome.windows.create({ url: 'debug.html', type: 'popup', width: 760, height: 980 });
  await chrome.storage.session.set({ debugWindowId: win.id });
}

async function setBadge(state) {
  const text = !state || state.stopped ? '' : state.muted ? 'MUTE' : state.autoEnabled === false ? 'II' : 'ON';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: state && state.muted ? '#d33' : '#2a7' });
}

async function stopCapture() {
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
  } catch {
    // offscreen document not running
  }
  await chrome.storage.session.set({ active: null });
  queueBreak(() => endBreak());
  await setBadge(null);
  await chrome.action.setTitle({ title: 'Commercial Mute: click to start on this tab (right-click for debug panel)' });
}

// The badge script goes into every frame, so it can also show inside a fullscreen player iframe.
async function injectBadge(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['badge.js'] });
  } catch {
    // e.g. a chrome:// page, or the tab is gone
  }
}

async function relayState(state) {
  onStreamState(state);
  await setBadge(state);
  if (state.tabId == null) return;
  if (!state.stopped) await injectBadge(state.tabId);
  chrome.tabs.sendMessage(state.tabId, { target: 'badge', state }).catch(() => {});
}

chrome.action.onClicked.addListener(async (tab) => {
  const { active } = await getState();
  if (active) {
    await stopCapture();
    if (active.tabId === tab.id) return;
  }
  try {
    const autoEnabled = await getAutoEnabled();
    await ensureOffscreen();
    // Must be called directly from the user gesture (toolbar click). The id expires within a few
    // seconds, so hand it to the offscreen document right away; badge injection comes after.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId, tabId: tab.id, title: tab.title, autoEnabled });
    if (!res || !res.ok) throw new Error(res && res.error ? res.error : 'offscreen document did not respond');
    await chrome.storage.session.set({ active: { tabId: tab.id }, lastError: null });
    await chrome.action.setTitle({ title: 'Commercial Mute: running (click to stop, right-click for debug panel)' });
    await injectBadge(tab.id);
  } catch (err) {
    await showError(err);
  }
});

async function showError(err) {
  const message = String(err && err.message ? err.message : err);
  await chrome.storage.session.set({ active: null, lastError: message });
  await chrome.action.setBadgeText({ text: 'ERR' });
  await chrome.action.setBadgeBackgroundColor({ color: '#d33' });
  await chrome.action.setTitle({ title: `Commercial Mute could not start: ${message}\nClick to try again.` });
  chrome.runtime.sendMessage({ target: 'debug', type: 'status', capturing: false, error: message }).catch(() => {});
}

chrome.commands.onCommand.addListener(async (command) => {
  const { active } = await getState();
  if (!active) return;
  const action = command === 'toggle-mute' ? 'toggle' : command === 'toggle-auto' ? 'toggle-auto' : null;
  if (action) chrome.runtime.sendMessage({ target: 'offscreen', type: 'override', action }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'debug', title: 'Open debug panel', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'shortcuts', title: 'Change keyboard shortcuts', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'options', title: 'During commercials…', contexts: ['action'] });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'debug') openDebugWindow();
  if (info.menuItemId === 'shortcuts') chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  if (info.menuItemId === 'options') chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.target !== 'sw') return;
  if (msg.type === 'capture-ended') {
    chrome.storage.session.set({ active: null });
    queueBreak(() => endBreak());
    setBadge(null);
  } else if (msg.type === 'break-test' && sender.tab) {
    // Options page "Try it": the options tab plays the part of the stream.
    queueBreak(() => (msg.on ? startBreak(sender.tab.id) : endBreak()));
  } else if (msg.type === 'state') {
    if ('autoEnabled' in msg) chrome.storage.local.set({ autoEnabled: msg.autoEnabled });
    relayState(msg);
  }
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const { debugWindowId } = await getState();
  if (windowId === debugWindowId) await chrome.storage.session.set({ debugWindowId: null });
});
