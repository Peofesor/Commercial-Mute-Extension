// Options page: pick what happens during a muted commercial (see break-actions.js).
// Every change is saved right away.

const modesEl = document.getElementById('modes');
const tabOptions = document.getElementById('tabOptions');
const savedEl = document.getElementById('saved');
const tryBtn = document.getElementById('try');
const tryHint = document.getElementById('tryHint');

let cfg = { ...BREAK_DEFAULTS };
const TEST_S = 15;
let testing = false; // seconds left in the test break, or false
let testTimer = null;
let savedTimer = null;

async function save(patch) {
  cfg = { ...cfg, ...patch };
  await chrome.storage.sync.set({ breakAction: cfg });
  savedEl.textContent = 'Saved';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (savedEl.textContent = ''), 1500);
  update();
}

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

function urlField(mode) {
  const input = el('input', { type: 'url', placeholder: mode.placeholder, value: cfg[mode.field] || '', spellcheck: false });
  input.setAttribute('aria-label', `${mode.label} link`);
  input.addEventListener('change', () => {
    const url = normalizeUrl(input.value);
    if (url) input.value = url;
    save({ [mode.field]: url });
  });
  return input;
}

async function tabField() {
  const select = el('select');
  select.setAttribute('aria-label', 'Tab to switch to');
  const refresh = el('button', { type: 'button', textContent: 'Refresh' });
  const fill = async () => {
    const self = await chrome.tabs.getCurrent();
    const tabs = (await chrome.tabs.query({})).filter((t) => /^https?:/.test(t.url || '') && t.id !== self?.id);
    select.replaceChildren(el('option', { value: '', textContent: tabs.length ? 'Choose a tab…' : 'No open tabs to choose from' }));
    let found = false;
    for (const t of tabs) {
      const host = new URL(t.url).hostname.replace(/^www\./, '');
      const selected = !!cfg.tab && (cfg.tab.id === t.id || (!found && cfg.tab.url === t.url));
      found ||= selected;
      select.append(el('option', { value: String(t.id), textContent: `${t.title || host} — ${host}`, selected }));
    }
    if (cfg.tab && !found) {
      select.append(el('option', { value: 'saved', textContent: `${cfg.tab.title || cfg.tab.url} (not open right now)`, selected: true }));
    }
    select._tabs = tabs;
  };
  select.addEventListener('change', () => {
    if (select.value === 'saved') return;
    const t = select._tabs.find((x) => String(x.id) === select.value);
    save({ tab: t ? { id: t.id, url: t.url, title: t.title } : null });
  });
  refresh.addEventListener('click', fill);
  await fill();
  return el('div', { className: 'row' }, select, refresh);
}

async function render() {
  modesEl.replaceChildren();
  const tpl = document.getElementById('modeTpl');
  for (const mode of BREAK_MODES) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    const radio = node.querySelector('input');
    radio.value = mode.id;
    radio.checked = cfg.mode === mode.id;
    radio.addEventListener('change', () => save({ mode: mode.id }));
    node.querySelector('.label').textContent = mode.label;
    node.querySelector('.desc').textContent = mode.desc;
    const extra = node.querySelector('.extra');
    if (mode.field) extra.append(urlField(mode));
    if (mode.id === 'tab') extra.append(await tabField());
    if (!extra.childNodes.length) extra.remove();
    modesEl.append(node);
  }
  update();
}

// What's missing before the chosen action can run, or null.
function problem() {
  const mode = breakMode(cfg.mode);
  if (mode.field && !cfg[mode.field]) return 'Paste a link first.';
  if (mode.id === 'tab' && !cfg.tab) return 'Choose a tab first.';
  return null;
}

function update() {
  const mode = breakMode(cfg.mode);
  tabOptions.hidden = mode.id === 'none';
  tabOptions.querySelector('[data-media]').hidden = !mode.media;
  tabOptions.querySelector('[data-opened]').hidden = mode.id === 'tab';
  for (const box of tabOptions.querySelectorAll('input[data-key]')) box.checked = !!cfg[box.dataset.key];

  const issue = mode.id === 'none' ? 'Choose an action above to try it.' : problem();
  tryBtn.disabled = !!issue && !testing;
  tryBtn.textContent = testing ? 'End now' : `Start a ${TEST_S} s test break`;
  tryBtn.classList.toggle('on', !!testing);
  tryHint.textContent = issue || (testing
    ? `Test break running: the "game" is back in ${testing} s.`
    : `Runs the break action now, with this page standing in for the game. After ${TEST_S} s the "game" is back.`);
}

for (const box of tabOptions.querySelectorAll('input[data-key]')) {
  box.addEventListener('change', () => save({ [box.dataset.key]: box.checked }));
}

function setTesting(on) {
  clearInterval(testTimer);
  testing = on ? TEST_S : false;
  chrome.runtime.sendMessage({ target: 'sw', type: 'break-test', on }).catch(() => {});
  if (on) {
    testTimer = setInterval(() => {
      testing -= 1;
      if (testing <= 0) setTesting(false);
      else update();
    }, 1000);
  }
  update();
}

tryBtn.addEventListener('click', () => setTesting(!testing));

// Closing the page mid-test ends the test break.
window.addEventListener('beforeunload', () => {
  if (testing) chrome.runtime.sendMessage({ target: 'sw', type: 'break-test', on: false }).catch(() => {});
});

getBreakSettings().then((c) => {
  cfg = c;
  render();
});
