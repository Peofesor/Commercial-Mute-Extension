// On-screen badge in the stream tab: shows when a commercial is muted, with override buttons.
// Injected into every frame; only one frame shows it:
//   - the frame whose fullscreen element is the player (works with fullscreen iframes), or
//   - the top frame when nothing is fullscreen.

(() => {
  if (window.__commercialMuteBadge) return;
  window.__commercialMuteBadge = true;

  const FLASH_MS = 3500;
  let state = null;
  let flash = null;
  let flashTimer = null;

  const host = document.createElement('div');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 16px; right: 16px;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .box { font: 13px/1.35 system-ui, -apple-system, Segoe UI, sans-serif; color: #fff;
        background: rgba(20, 22, 26, 0.88); border: 1px solid rgba(255,255,255,0.14); border-radius: 10px;
        padding: 8px 10px; box-shadow: 0 6px 24px rgba(0,0,0,0.35); display: flex; align-items: center; gap: 10px;
        backdrop-filter: blur(6px); max-width: 420px; }
      .box[hidden] { display: none; }
      .icon { font-size: 18px; }
      .title { font-weight: 650; }
      .sub { color: rgba(255,255,255,0.65); font-size: 11.5px; }
      .btns { display: flex; gap: 6px; margin-left: 4px; }
      button { all: unset; cursor: pointer; font: 12px system-ui, sans-serif; color: #fff; padding: 4px 9px;
        border-radius: 6px; background: rgba(255,255,255,0.12); white-space: nowrap; }
      button:hover { background: rgba(255,255,255,0.22); }
      button.primary { background: #d33; }
      button.primary:hover { background: #e44; }
      .muted { border-color: rgba(221, 51, 51, 0.7); }
    </style>
    <div class="box" hidden>
      <span class="icon"></span>
      <div><div class="title"></div><div class="sub"></div></div>
      <div class="btns"></div>
    </div>`;
  const box = root.querySelector('.box');
  const icon = root.querySelector('.icon');
  const title = root.querySelector('.title');
  const sub = root.querySelector('.sub');
  const btns = root.querySelector('.btns');

  function send(action) {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'override', action }).catch(() => {});
  }

  function button(label, action, primary) {
    const b = document.createElement('button');
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      send(action);
    });
    return b;
  }

  function container() {
    const fs = document.fullscreenElement;
    if (fs) return fs.tagName === 'IFRAME' || fs.tagName === 'VIDEO' ? null : fs;
    return window === window.top ? document.documentElement : null;
  }

  function place() {
    const c = container();
    if (!c) host.remove();
    else if (host.parentNode !== c) c.appendChild(host);
  }

  function render() {
    place();
    btns.replaceChildren();
    box.classList.remove('muted');
    if (!state || state.stopped) {
      box.hidden = true;
      return;
    }
    if (state.muted) {
      box.classList.add('muted');
      icon.textContent = '🔇';
      title.textContent = state.override === 'manual' ? 'Muted (by you)' : 'Commercial: muted';
      sub.textContent = 'Alt+Shift+M to unmute';
      btns.append(button('Unmute', 'toggle', true), button('Wrong!', 'wrong'), button('Pause auto', 'pause'));
    } else if (flash) {
      icon.textContent = '🔊';
      title.textContent = flash;
      sub.textContent = '';
      if (flash.startsWith('Back to the game')) btns.append(button('Wrong!', 'wrong'));
    } else if (state.autoEnabled === false) {
      icon.textContent = '⏸';
      title.textContent = 'Auto-mute paused';
      sub.textContent = 'Alt+Shift+P to resume';
      btns.append(button('Resume', 'resume', true));
    } else {
      box.hidden = true;
      return;
    }
    box.hidden = false;
  }

  function showFlash(text) {
    flash = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flash = null;
      render();
    }, FLASH_MS);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.target !== 'badge') return;
    const prev = state;
    state = msg.state;
    if (state.flash) showFlash(state.flash);
    else if (prev && prev.muted && !state.muted && state.autoEnabled !== false) {
      showFlash(state.override === 'skip' ? 'Unmuted for the rest of this break' : 'Back to the game');
    }
    render();
  });

  document.addEventListener('fullscreenchange', render);
})();
