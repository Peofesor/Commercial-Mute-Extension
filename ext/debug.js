// Debug panel: live view of what the detector sees, plus labeling and log export.

const $ = (id) => document.getElementById(id);
const fmtPct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);

let history = [];
let label = 'game';
let boxWasLearning = false;

function send(msg) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg }).catch(() => null);
}

async function init() {
  const res = await send({ type: 'get-history' });
  if (res) {
    history = res.history || [];
    setLabelUi(res.label || 'game');
    if (res.autoEnabled != null) setAutoUi(res.autoEnabled);
    const { lastError = null } = res.capturing ? {} : await chrome.storage.session.get('lastError');
    setStatus(res.capturing, res.title, lastError);
    setModel(res.audioModel, res.error, res.backend);
    setOcr(res.ocr, res.ocrError);
    if (history.length) showRecord(history[history.length - 1]);
  }
  draw();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'debug') return;
  if (msg.type === 'stats') {
    history.push(msg.rec);
    showRecord(msg.rec);
    draw();
  } else if (msg.type === 'frame') {
    $('frame').src = msg.dataUrl;
    if (msg.ocrText) $('ocrText').textContent = msg.ocrText;
  } else if (msg.type === 'status') {
    if ('capturing' in msg) setStatus(msg.capturing, msg.title, msg.error);
    if ('audioModel' in msg) setModel(msg.audioModel, msg.error, msg.backend);
    if ('ocr' in msg) setOcr(msg.ocr, msg.ocrError);
  }
});

function setStatus(capturing, title, error) {
  const el = $('status');
  if (error) el.textContent = `Could not start: ${error}. Click the extension icon on the stream tab to try again.`;
  else if (capturing) el.textContent = `Analyzing: ${title || 'tab'}`;
  else el.textContent = 'Idle. Click the extension icon on the stream tab.';
  el.style.color = error ? 'var(--p)' : '';
}

function setModel(state, error, backend) {
  const el = $('model');
  if (state === 'ready') el.textContent = `audio model ready${backend ? ` (${backend})` : ''}`;
  else if (state === 'error') el.textContent = `audio model failed: ${error || 'unknown error'}`;
  else el.textContent = 'audio model loading…';
  el.style.color = state === 'error' ? 'var(--p)' : '';
}

function setOcr(state, error) {
  const el = $('ocrState');
  el.textContent = state === 'ready' ? 'OCR ready' : state === 'error' ? `OCR failed: ${error || 'unknown error'}` : 'OCR loading…';
  el.style.color = state === 'error' ? 'var(--p)' : '';
}

function showRecord(r) {
  $('pAd').textContent = fmtPct(r.pAd);
  $('pAd').style.color = r.pAd == null ? '' : r.pAd >= 0.75 ? 'var(--p)' : r.pAd >= 0.4 ? 'var(--aud)' : '#8fd18f';
  const would = $('would');
  const muted = r.muted ?? r.wouldMute;
  would.textContent = muted
    ? r.override === 'manual' ? 'MUTED (by you)' : 'MUTED'
    : r.override === 'skip' ? 'unmuted by you (this break)' : r.wouldMute && r.autoEnabled === false ? 'would mute (paused)' : 'not muted';
  would.classList.toggle('on', !!muted);
  if (r.autoEnabled != null) setAutoUi(r.autoEnabled);

  const score = scoreOf(r);
  $('presence').textContent = !r.learned ? '–' : score == null ? 'none' : fmtPct(score);
  $('logoV').textContent = !r.learned ? '–' : r.logoPresence == null ? 'none' : fmtPct(r.logoPresence);
  $('logoV').style.color = r.logoIgnored ? 'var(--dim)' : '';
  $('learn').textContent = r.frozen
    ? `video frozen (buffering?) · ${r.learned ? 'holding last value' : `learning paused at ${fmtPct(r.learnProgress)}`}`
    : r.learned
    ? r.complete === false
      ? `only the channel logo so far · still looking for the scoreboard · ${r.maskSize} px`
      : `learned · scoreboard ${r.scoreSize ?? r.maskSize} px · ${r.logoSize ? `logo ${r.logoSize} px` : 'no logo yet'}`
    : r.failReason
      ? `${r.failReason} (${fmtPct(r.learnProgress)})`
      : `learning… ${fmtPct(r.learnProgress)}`;

  if (r.boxLearning) $('drawHint').textContent = 'Learning the drawn box: keep it on screen for 5 s…';
  else if (boxWasLearning) $('drawHint').textContent = r.boxFound ? `Drawn box learned (${r.boxFound} px)` : 'Nothing steady found in the drawn box: was it on screen?';
  boxWasLearning = !!r.boxLearning;

  $('crowd').value = r.crowd ?? 0;
  $('music').value = r.music ?? 0;
  $('speech').value = r.speech ?? 0;
  $('loud').textContent = `loudness ${r.rmsDb == null ? '–' : `${r.rmsDb.toFixed(1)} dBFS`} · audio ad score ${fmtPct(r.audioAd)}`;

  $('audioGame').textContent = r.gameAudio == null ? 'learning…' : fmtPct(r.gameAudio);
  $('banks').textContent = r.gameBank == null ? '–' : `${r.gameBank} / ${r.adBank}${r.simAd != null ? ' · comparing' : r.adBank < 20 ? ' · learning ads' : ''}`;
  $('showAudio').textContent = r.learningShow ? 'learning…' : r.showAudio == null ? '–' : fmtPct(r.showAudio);
  const search = r.bgIn == null ? '' : ` · next search in ${r.bgIn} s${r.bgLast ? `, last: ${r.bgLast}` : ''}`;
  $('logo').textContent = r.logoPresence == null ? (r.learned ? `not found${search}` : 'not found')
    : r.logoIgnored ? 'ignored (stays on during ads)' : fmtPct(r.logoPresence);
  $('persist').textContent = r.persistentPx == null ? '–' : `${r.persistentPx} px`;
  $('ocrHit').textContent = r.ocrHit ? (r.ocrWords || []).join(', ') : 'none';
  $('show').textContent = fmtPct(r.showScore);
  $('cuts').textContent = r.breakCuts == null ? '–' : `${r.breakCuts} (${r.blackCuts} black)`;
  $('absent').textContent = r.absentSecs ? `${r.absentSecs} s` : '–';
  $('teams').textContent = r.teams && r.teams.length ? `teams: ${r.teams.join(', ')}` : 'teams: learning…';

  if (r.top) {
    $('top').innerHTML = '';
    for (const { name, p } of r.top) {
      const li = document.createElement('li');
      li.textContent = `${name} — ${Math.round(p * 100)}%`;
      $('top').appendChild(li);
    }
  }
  showAccuracy();
}

// Scoreboard presence; logs from before 1.7 only have all learned graphics together.
const scoreOf = (r) => (r.scorePresence !== undefined ? r.scorePresence : r.presence);

// ---- chart ----

function draw() {
  const canvas = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);

  const css = getComputedStyle(document.documentElement);
  const color = (v) => css.getPropertyValue(v).trim();
  const pad = { l: 34, r: 8, t: 8, b: 20 };
  const w = cw - pad.l - pad.r, h = ch - pad.t - pad.b;
  const range = Number($('range').value) * 1000;
  const now = history.length ? history[history.length - 1].t : Date.now();
  const t0 = now - range;
  const x = (t) => pad.l + ((t - t0) / range) * w;
  const y = (v) => pad.t + (1 - v) * h;
  const recs = history.filter((r) => r.t >= t0);

  // Bands: user AD marks (top half) and "would mute" (bottom half).
  const band = (pred, fill, top, bottom) => {
    ctx.fillStyle = fill;
    let start = null;
    recs.forEach((r, i) => {
      const on = pred(r);
      if (on && start == null) start = r.t;
      const last = i === recs.length - 1;
      if ((!on || last) && start != null) {
        ctx.fillRect(x(start), top, Math.max(1, x(r.t) - x(start)), bottom - top);
        start = null;
      }
    });
  };
  band((r) => r.label === 'ad', color('--label'), pad.t, pad.t + h / 2);
  band((r) => r.muted ?? r.wouldMute, color('--would'), pad.t + h / 2, pad.t + h);

  // Grid
  ctx.strokeStyle = color('--line');
  ctx.fillStyle = color('--dim');
  ctx.font = '11px system-ui';
  ctx.lineWidth = 1;
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    ctx.moveTo(pad.l, y(v) + 0.5);
    ctx.lineTo(pad.l + w, y(v) + 0.5);
    ctx.stroke();
    ctx.fillText(`${v * 100}`, 4, y(v) + 4);
  }
  const minutes = range / 60000;
  const stepMin = minutes <= 5 ? 1 : minutes <= 15 ? 3 : minutes <= 60 ? 10 : 30;
  for (let m = 0; m <= minutes; m += stepMin) {
    const tx = x(now - m * 60000);
    ctx.fillText(m === 0 ? 'now' : `-${m}m`, tx - 12, ch - 5);
  }

  // New stream (learning started over): dashed vertical line.
  ctx.strokeStyle = color('--dim');
  ctx.setLineDash([3, 3]);
  for (const r of recs) {
    if (!r.newStream) continue;
    ctx.beginPath();
    ctx.moveTo(Math.round(x(r.t)) + 0.5, pad.t);
    ctx.lineTo(Math.round(x(r.t)) + 0.5, pad.t + h);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const line = (get, stroke, width) => {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.beginPath();
    let pen = false;
    for (const r of recs) {
      const v = get(r);
      if (v == null) {
        pen = false;
        continue;
      }
      if (!pen) ctx.moveTo(x(r.t), y(v));
      else ctx.lineTo(x(r.t), y(v));
      pen = true;
    }
    ctx.stroke();
  };
  line(scoreOf, color('--vis'), 1.2);
  line((r) => r.logoPresence, color('--logo'), 1.2);
  line((r) => r.audioAd, color('--aud'), 1.2);
  line((r) => r.showScore, color('--show'), 1.2);
  line((r) => r.pAd, color('--p'), 2);
}

window.addEventListener('resize', draw);
$('range').addEventListener('change', draw);

// ---- accuracy vs. labels ----

function showAccuracy() {
  const recs = history.filter((r) => r.pAd != null);
  const adSecs = recs.filter((r) => r.label === 'ad');
  if (!adSecs.length) return;
  const gameSecs = recs.filter((r) => r.label === 'game');
  const caught = adSecs.filter((r) => r.wouldMute).length;
  const falseMute = gameSecs.filter((r) => r.wouldMute).length;

  // Per-break delay: seconds from the user's AD mark until "would mute".
  const delays = [];
  let breakStart = null, muted = false, breaks = 0;
  for (const r of recs) {
    if (r.label === 'ad' && breakStart == null) {
      breakStart = r.t;
      muted = false;
      breaks++;
    }
    if (r.label === 'ad' && r.wouldMute && !muted) {
      muted = true;
      delays.push((r.t - breakStart) / 1000);
    }
    if (r.label !== 'ad' && breakStart != null) {
      breakStart = null;
    }
  }
  const avgDelay = delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null;
  $('acc').innerHTML =
    `Breaks marked: <b>${breaks}</b> · detected: <b>${delays.length}</b>` +
    ` · avg. delay: <b>${avgDelay == null ? '–' : `${avgDelay.toFixed(0)} s`}</b><br>` +
    `Ad seconds muted: <b>${fmtPct(caught / adSecs.length)}</b> · ` +
    `<span style="color:${falseMute ? 'var(--p)' : 'inherit'}">game seconds wrongly muted: <b>${falseMute}</b></span>`;
}

// ---- controls ----

function setLabelUi(l) {
  label = l;
  const btn = $('label');
  btn.innerHTML = `Mark: <b>${l === 'ad' ? 'AD' : 'GAME'}</b>`;
  btn.classList.toggle('ad', l === 'ad');
}

function toggleLabel() {
  setLabelUi(label === 'ad' ? 'game' : 'ad');
  send({ type: 'label', label });
}

$('label').addEventListener('click', toggleLabel);
document.addEventListener('keydown', (e) => {
  if (e.key === 'a' || e.key === 'A') toggleLabel();
});

// ---- editing the scoreboard / logo boxes on the preview ----
// Starts from what the detector found (or your last edit): drag a box to move it, its corners or edges to
// resize it, select one to relabel or delete it, or add new ones. Apply sends them all to the detector.

const FRAME_W = 320, FRAME_H = 180; // detector frame; the preview shows it at 16:9 over the whole width
const HANDLE = 7; // px on screen: grab distance for corners and edges
let edit = null; // { boxes: [{ role, box }], sel, drag, adding }

function startEdit() {
  const r = history[history.length - 1];
  if (!r || !r.learned) {
    $('drawHint').textContent = 'Wait until the scoreboard is learned';
    return;
  }
  const src = r.userBoxes && r.userBoxes.length ? r.userBoxes : (r.regions || []).map((g) => ({
    role: g.role || 'score',
    box: { x0: g.box.x0 - 1, y0: g.box.y0 - 1, x1: g.box.x1 + 1, y1: g.box.y1 + 1 },
  }));
  edit = { boxes: src.map((u) => ({ role: u.role, box: { ...u.box } })), sel: -1, drag: null, adding: null };
  $('draw').classList.add('on');
  $('editTools').hidden = false;
  $('boxList').hidden = false;
  $('editBoxes').hidden = true;
  $('drawHint').textContent = 'Drag boxes or their edges · double-click one (or use the list) to switch scoreboard / logo';
  renderEdit();
}

function endEdit(msg = '') {
  edit = null;
  $('draw').classList.remove('on');
  $('editTools').hidden = true;
  $('boxList').hidden = true;
  $('editBoxes').hidden = false;
  $('drawHint').textContent = msg;
  const c = $('draw');
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
}

// Canvas pixels per frame pixel (the canvas is kept at its on-screen size).
function canvasScale() {
  const c = $('draw'), r = c.getBoundingClientRect();
  if (c.width !== Math.round(r.width) || c.height !== Math.round(r.height)) {
    c.width = Math.round(r.width);
    c.height = Math.round(r.height);
  }
  return { c, sx: c.width / FRAME_W, sy: c.height / FRAME_H };
}

function renderEdit() {
  if (!edit) return;
  const { c, sx, sy } = canvasScale();
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.font = '11px system-ui';
  edit.boxes.forEach((u, j) => {
    const { box: b } = u, sel = j === edit.sel;
    const x = b.x0 * sx, y = b.y0 * sy, w = (b.x1 - b.x0) * sx, h = (b.y1 - b.y0) * sy;
    const col = u.role === 'logo' ? '#f5f' : '#fd3';
    ctx.strokeStyle = col;
    ctx.lineWidth = sel ? 2.5 : 1.5;
    ctx.setLineDash(sel ? [] : [5, 3]);
    ctx.fillStyle = sel ? 'rgba(255,255,255,0.08)' : 'transparent';
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    ctx.fillStyle = col;
    ctx.fillText(u.role === 'logo' ? 'logo' : 'scoreboard', x + 2, y > 14 ? y - 3 : y + h + 11);
    if (sel) for (const [hx, hy] of handlePoints(b)) ctx.fillRect(hx * sx - 3, hy * sy - 3, 6, 6);
  });
  renderBoxList();
  const s = edit.sel >= 0 ? edit.boxes[edit.sel] : null;
  $('toggleRole').disabled = $('deleteBox').disabled = !s;
  $('toggleRole').textContent = s && s.role === 'logo' ? 'Make scoreboard' : 'Make logo';
  for (const id of ['addScore', 'addLogo']) $(id).classList.toggle('active', edit.adding === $(id).dataset.role);
}

// One row per box: what it is (rename it here), where it is, delete. Clicking a row selects the box.
function renderBoxList() {
  const ol = $('boxList');
  ol.innerHTML = '';
  edit.boxes.forEach((u, j) => {
    const li = document.createElement('li');
    li.classList.toggle('sel', j === edit.sel);
    const sw = document.createElement('i');
    sw.className = 'sw';
    sw.style.background = u.role === 'logo' ? '#f5f' : '#fd3';
    const role = document.createElement('select');
    for (const [v, t] of [['score', 'Scoreboard'], ['logo', 'Channel logo']]) role.add(new Option(t, v, false, u.role === v));
    role.addEventListener('change', () => {
      u.role = role.value;
      edit.sel = j;
      renderEdit();
    });
    const b = u.box, where = document.createElement('span');
    where.className = 'where';
    where.textContent = `${b.y0 + b.y1 < FRAME_H ? 'top' : 'bottom'} ${b.x0 + b.x1 < FRAME_W ? 'left' : 'right'} · ${Math.round(b.x1 - b.x0)}×${Math.round(b.y1 - b.y0)}`;
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = 'Delete this box';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      edit.boxes.splice(j, 1);
      edit.sel = -1;
      renderEdit();
    });
    li.append(sw, role, where, del);
    li.addEventListener('click', (e) => {
      if (e.target === role) return;
      edit.sel = j;
      renderEdit();
    });
    ol.appendChild(li);
  });
}

function handlePoints(b) {
  const mx = (b.x0 + b.x1) / 2, my = (b.y0 + b.y1) / 2;
  return [[b.x0, b.y0], [mx, b.y0], [b.x1, b.y0], [b.x1, my], [b.x1, b.y1], [mx, b.y1], [b.x0, b.y1], [b.x0, my]];
}

// What's under the mouse: { j, mode } with mode 'move' or the edges to drag ('n', 'se', ...).
function hitTest(e) {
  const r = $('draw').getBoundingClientRect(), sx = r.width / FRAME_W, sy = r.height / FRAME_H;
  const px = e.clientX - r.left, py = e.clientY - r.top;
  // Selected box first, then the smallest one, so a logo inside a big box stays reachable.
  const order = edit.boxes.map((u, j) => j).sort((a, b) => (a === edit.sel ? -1 : b === edit.sel ? 1 : area(edit.boxes[a].box) - area(edit.boxes[b].box)));
  for (const j of order) {
    const b = edit.boxes[j].box;
    const x0 = b.x0 * sx, x1 = b.x1 * sx, y0 = b.y0 * sy, y1 = b.y1 * sy;
    if (px < x0 - HANDLE || px > x1 + HANDLE || py < y0 - HANDLE || py > y1 + HANDLE) continue;
    let mode = '';
    if (Math.abs(py - y0) <= HANDLE) mode += 'n';
    else if (Math.abs(py - y1) <= HANDLE) mode += 's';
    if (Math.abs(px - x0) <= HANDLE) mode += 'w';
    else if (Math.abs(px - x1) <= HANDLE) mode += 'e';
    if (mode) return { j, mode };
    if (px >= x0 && px <= x1 && py >= y0 && py <= y1) return { j, mode: 'move' };
  }
  return null;
}

const area = (b) => (b.x1 - b.x0) * (b.y1 - b.y0);
const CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize', move: 'move' };

// Mouse position -> detector frame coordinates.
function framePoint(e) {
  const r = $('draw').getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(FRAME_W, ((e.clientX - r.left) / r.width) * FRAME_W)),
    y: Math.max(0, Math.min(FRAME_H, ((e.clientY - r.top) / r.height) * FRAME_H)),
  };
}

$('draw').addEventListener('mousedown', (e) => {
  if (!edit) return;
  const p = framePoint(e);
  if (edit.adding) {
    edit.boxes.push({ role: edit.adding, box: { x0: p.x, y0: p.y, x1: p.x, y1: p.y } });
    edit.sel = edit.boxes.length - 1;
    edit.drag = { j: edit.sel, mode: 'se', from: p, orig: { ...edit.boxes[edit.sel].box } };
    edit.adding = null;
  } else {
    const hit = hitTest(e);
    edit.sel = hit ? hit.j : -1;
    edit.drag = hit ? { ...hit, from: p, orig: { ...edit.boxes[hit.j].box } } : null;
  }
  renderEdit();
});

$('draw').addEventListener('mousemove', (e) => {
  if (!edit) return;
  if (!edit.drag) {
    const hit = edit.adding ? null : hitTest(e);
    $('draw').style.cursor = edit.adding ? 'crosshair' : hit ? CURSORS[hit.mode] : 'default';
    return;
  }
  const p = framePoint(e), { j, mode, from, orig } = edit.drag, dx = p.x - from.x, dy = p.y - from.y;
  const b = { ...orig };
  if (mode === 'move') {
    const mx = Math.max(-orig.x0, Math.min(FRAME_W - orig.x1, dx)), my = Math.max(-orig.y0, Math.min(FRAME_H - orig.y1, dy));
    b.x0 += mx; b.x1 += mx; b.y0 += my; b.y1 += my;
  } else {
    if (mode.includes('n')) b.y0 = orig.y0 + dy;
    if (mode.includes('s')) b.y1 = orig.y1 + dy;
    if (mode.includes('w')) b.x0 = orig.x0 + dx;
    if (mode.includes('e')) b.x1 = orig.x1 + dx;
  }
  // Dragging an edge past the opposite one flips the box instead of inverting it.
  edit.boxes[j].box = { x0: Math.min(b.x0, b.x1), y0: Math.min(b.y0, b.y1), x1: Math.max(b.x0, b.x1), y1: Math.max(b.y0, b.y1) };
  renderEdit();
});

window.addEventListener('mouseup', () => {
  if (!edit || !edit.drag) return;
  const { j } = edit.drag;
  edit.drag = null;
  if (area(edit.boxes[j].box) < 9) { // a click, not a drag, while adding
    edit.boxes.splice(j, 1);
    edit.sel = -1;
  }
  renderEdit();
});

// Double-click a box: switch it between scoreboard and logo.
$('draw').addEventListener('dblclick', (e) => {
  if (!edit || edit.adding) return;
  const hit = hitTest(e);
  if (!hit) return;
  const u = edit.boxes[hit.j];
  u.role = u.role === 'logo' ? 'score' : 'logo';
  edit.sel = hit.j;
  renderEdit();
});

$('editBoxes').addEventListener('click', startEdit);
for (const id of ['addScore', 'addLogo']) {
  $(id).addEventListener('click', () => {
    edit.adding = edit.adding === $(id).dataset.role ? null : $(id).dataset.role;
    $('drawHint').textContent = edit.adding ? `Drag on the preview to add a ${edit.adding === 'logo' ? 'logo' : 'scoreboard'} box` : '';
    renderEdit();
  });
}
$('toggleRole').addEventListener('click', () => {
  const s = edit.boxes[edit.sel];
  s.role = s.role === 'logo' ? 'score' : 'logo';
  renderEdit();
});
function deleteSelected() {
  if (!edit || edit.sel < 0) return;
  edit.boxes.splice(edit.sel, 1);
  edit.sel = -1;
  renderEdit();
}
$('deleteBox').addEventListener('click', deleteSelected);
document.addEventListener('keydown', (e) => {
  if (!edit) return;
  if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
  if (e.key === 'Escape') endEdit();
});
$('cancelBoxes').addEventListener('click', () => endEdit());
async function applyBoxes(boxes) {
  const res = await send({ type: 'set-boxes', boxes });
  endEdit(res && res.ok ? (boxes.length ? 'Boxes applied (shows on the next preview)' : 'Back to automatic boxes') : `Not applied: ${(res && res.error) || 'no response'}`);
}
$('applyBoxes').addEventListener('click', () => applyBoxes(edit.boxes));
$('autoBoxes').addEventListener('click', () => applyBoxes([]));
window.addEventListener('resize', renderEdit);

$('relearn').addEventListener('click', () => send({ type: 'relearn' }));
$('newStream').addEventListener('click', () => send({ type: 'new-stream' }));
$('resetSounds').addEventListener('click', () => send({ type: 'reset-sounds' }));

function setAutoUi(on) {
  $('auto').innerHTML = `Auto-mute: <b>${on ? 'ON' : 'PAUSED'}</b>`;
  $('auto').classList.toggle('ad', !on);
}
$('auto').addEventListener('click', async () => {
  const res = await send({ type: 'override', action: 'toggle-auto' });
  if (res) setAutoUi(res.autoEnabled);
});

$('export').addEventListener('click', async () => {
  const res = await send({ type: 'get-history' });
  // bgDiag goes on one line: it's ~20k numbers.
  const data = JSON.stringify({ exportedAt: new Date().toISOString(), history: res ? res.history : history }, null, 1)
    .replace(/\n}$/, `,\n "bgDiag": ${JSON.stringify(res ? res.bgDiag ?? null : null)}\n}`);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = `commercial-mute-log-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

init();
