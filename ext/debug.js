// Debug panel: live view of what the detector sees, plus labeling and log export.

const $ = (id) => document.getElementById(id);
const fmtPct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);

let history = [];
let label = 'game';

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

  $('presence').textContent = r.learned ? fmtPct(r.presence) : '–';
  $('learn').textContent = r.frozen
    ? `video frozen (buffering?) · ${r.learned ? 'holding last value' : `learning paused at ${fmtPct(r.learnProgress)}`}`
    : r.learned
    ? r.complete === false
      ? `only a small graphic so far (logo?) · still looking for the scoreboard · ${r.maskSize} px`
      : `learned · ${r.maskSize} px overlay · raw ${fmtPct(r.presenceRaw)}`
    : r.failReason
      ? `${r.failReason} (${fmtPct(r.learnProgress)})`
      : `learning… ${fmtPct(r.learnProgress)}`;

  $('crowd').value = r.crowd ?? 0;
  $('music').value = r.music ?? 0;
  $('speech').value = r.speech ?? 0;
  $('loud').textContent = `loudness ${r.rmsDb == null ? '–' : `${r.rmsDb.toFixed(1)} dBFS`} · audio ad score ${fmtPct(r.audioAd)}`;

  $('audioGame').textContent = r.gameAudio == null ? 'learning…' : fmtPct(r.gameAudio);
  $('banks').textContent = r.gameBank == null ? '–' : `${r.gameBank} / ${r.adBank}${r.simAd != null ? ' · comparing' : r.adBank < 20 ? ' · learning ads' : ''}`;
  $('showAudio').textContent = r.learningShow ? 'learning…' : r.showAudio == null ? '–' : fmtPct(r.showAudio);
  $('logo').textContent = r.logoPresence == null ? '–' : `${fmtPct(r.logoPresence)}${r.regions ? ` (${r.regions.length} graphic${r.regions.length === 1 ? '' : 's'})` : ''}`;
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

  const line = (key, stroke, width) => {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.beginPath();
    let pen = false;
    for (const r of recs) {
      const v = r[key];
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
  line('presence', color('--vis'), 1.2);
  line('audioAd', color('--aud'), 1.2);
  line('showScore', color('--show'), 1.2);
  line('pAd', color('--p'), 2);
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

$('relearn').addEventListener('click', () => send({ type: 'relearn' }));
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
  const data = JSON.stringify({ exportedAt: new Date().toISOString(), history: res ? res.history : history }, null, 1);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  a.download = `commercial-mute-log-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

init();
