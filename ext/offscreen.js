// Offscreen document: owns the tab capture stream.
// - plays the tab audio back (tab capture silences the tab otherwise)
// - samples video frames for the scoreboard detector, black-frame cuts and OCR
// - feeds audio to YAMNet and the learned game-audio profile
// - mutes the playback when a commercial is detected (MuteController handles your overrides)
// - broadcasts stats to the debug panel and keeps a history for export

const FRAME_W = 320;
const FRAME_H = 180;
const THUMB_W = 32;
const THUMB_H = 18;
const FRAME_INTERVAL_MS = 500;
const THUMB_INTERVAL_MS = 100;
const AUDIO_INTERVAL_MS = 1000;
const PREVIEW_INTERVAL_MS = 2000;
const OCR_INTERVAL_MS = 4000;
const OCR_LEARN_EVERY_MS = 15000;
const MAX_HISTORY = 6 * 60 * 60; // 6 h at 1 record/s

const video = document.getElementById('video');
const frameCanvas = new OffscreenCanvas(FRAME_W, FRAME_H);
const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });
const thumbCanvas = new OffscreenCanvas(THUMB_W, THUMB_H);
const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });
const previewCanvas = new OffscreenCanvas(FRAME_W, FRAME_H);
const previewCtx = previewCanvas.getContext('2d');

const overlay = new OverlayDetector({ width: FRAME_W, height: FRAME_H });
const audioClassifier = new AudioClassifier();
const audioProfile = new GameAudioProfile();
// Learned from Wrong! presses. Few samples, so it is stricter: only a close match counts.
const showProfile = new GameAudioProfile({ minN: 5, minSimN: 5, zScale: 1.5 });
// Game vs. ad sound fingerprints. Ads: scoreboard gone longer than any replay, with music.
const banks = new AudioBanks();
const AD_BANK_ABSENT_S = 40;
const AD_BANK_MUSIC = 0.2;
let gameTick = 0;
const cuts = new CutDetector();
const ocr = new OcrReader();
const decision = new BreakDecision();
const controller = new MuteController();

let session = null;
let history = [];
let label = 'game'; // user's manual label for the current moment
let lastVision = null;
let lastAudio = null;
let lastVideoSize = '';
let lastOcrLearn = 0;
let audioErrors = 0;
let wasLearned = false;
let lastFound = 0;
let lastDecision = { muted: false };

function audioStatus() {
  return {
    audioModel: audioClassifier.ready ? 'ready' : audioClassifier.error ? 'error' : 'loading',
    backend: audioClassifier.backend,
    error: audioClassifier.error,
  };
}

function ocrStatus() {
  return { ocr: ocr.ready ? 'ready' : ocr.error ? 'error' : 'loading', ocrError: ocr.error };
}

function loadAudio(skip) {
  audioClassifier.load(skip).then(
    () => broadcast({ type: 'status', ...audioStatus() }),
    () => broadcast({ type: 'status', ...audioStatus() }),
  );
}
loadAudio();
ocr.load().then(
  () => broadcast({ type: 'status', ...ocrStatus() }),
  () => broadcast({ type: 'status', ...ocrStatus() }),
);

function broadcast(msg) {
  chrome.runtime.sendMessage({ target: 'debug', ...msg }).catch(() => {});
}

async function start(streamId, title, tabId, autoEnabled) {
  stop();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 15,
      },
    },
  });

  // Audio: playback path (the gain node is the mute switch) + analysis tap.
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const gain = audioCtx.createGain();
  source.connect(gain).connect(audioCtx.destination);

  await audioCtx.audioWorklet.addModule('audio-tap.js');
  const tap = new AudioWorkletNode(audioCtx, 'tap');
  const resampler = new Resampler(audioCtx.sampleRate, 16000, 16000);
  tap.port.onmessage = (e) => {
    resampler.push(e.data);
    cuts.pushAudioLevel(rmsDbOf(e.data), Date.now());
  };
  source.connect(tap).connect(audioCtx.destination); // tap outputs silence; connection keeps it running

  video.srcObject = new MediaStream(stream.getVideoTracks());
  await video.play();

  const s = { stream, audioCtx, gain, resampler, title, tabId, timers: [], audioBusy: false };
  session = s;
  resetDetection();
  controller.setAuto(autoEnabled !== false);
  controller.override = null;
  controller.muted = false;
  controller.takeEvents();
  pushState({ flash: 'Commercial Mute is on: learning the scoreboard (about 30 s of game)' });

  s.timers.push(setInterval(() => sampleFrame(), FRAME_INTERVAL_MS));
  s.timers.push(setInterval(() => sampleThumb(), THUMB_INTERVAL_MS));
  s.timers.push(setInterval(() => sampleAudio(s), AUDIO_INTERVAL_MS));
  s.timers.push(setInterval(() => runOcr(), OCR_INTERVAL_MS));
  s.timers.push(setInterval(() => sendPreview(), PREVIEW_INTERVAL_MS));

  for (const track of stream.getTracks()) {
    track.addEventListener('ended', () => {
      if (session === s) {
        stop();
        chrome.runtime.sendMessage({ target: 'sw', type: 'capture-ended' }).catch(() => {});
      }
    });
  }
  broadcast({ type: 'status', capturing: true, title });
}

function resetDetection() {
  overlay.reset();
  resetSounds();
  cuts.reset();
  ocr.reset();
  decision.reset();
  lastVision = lastAudio = null;
  lastOcrLearn = 0;
  wasLearned = false;
  lastFound = 0;
  lastDecision = { muted: false };
}

function resetSounds() {
  audioProfile.reset();
  showProfile.reset();
  banks.reset();
}

function applyMute() {
  if (!session) return;
  const { gain, audioCtx } = session;
  gain.gain.cancelScheduledValues(audioCtx.currentTime);
  gain.gain.setTargetAtTime(controller.muted ? 0 : 1, audioCtx.currentTime, 0.08); // ~0.3 s fade
}

// Tells the service worker (toolbar badge) and the on-screen badge in the stream tab.
function pushState(extra = {}) {
  if (!session) return;
  chrome.runtime
    .sendMessage({ target: 'sw', type: 'state', tabId: session.tabId, learned: wasLearned, ...controller.state(), ...extra })
    .catch(() => {});
}

function handleOverride(action) {
  const presence = lastVision && lastVision.learned ? lastVision.presence : null;
  let changed = false;
  if (action === 'toggle') changed = controller.toggle(lastDecision.muted, presence);
  else if (action === 'wrong') changed = controller.toggle(lastDecision.muted, presence, true);
  else if (action === 'pause') changed = controller.setAuto(false);
  else if (action === 'resume') changed = controller.setAuto(true);
  else if (action === 'toggle-auto') changed = controller.setAuto(!controller.autoEnabled);
  applyMute();
  const flash = action === 'wrong' ? 'Thanks, logged as a mistake' : action === 'pause' || (action === 'toggle-auto' && !controller.autoEnabled) ? 'Auto-mute paused' : action === 'resume' || action === 'toggle-auto' ? 'Auto-mute resumed' : null;
  pushState(flash ? { flash } : {});
  return changed;
}

function stop() {
  if (!session) return;
  const s = session;
  session = null;
  s.timers.forEach(clearInterval);
  s.stream.getTracks().forEach((t) => t.stop());
  s.audioCtx.close();
  video.srcObject = null;
  chrome.runtime.sendMessage({ target: 'sw', type: 'state', tabId: s.tabId, stopped: true }).catch(() => {});
  controller.muted = false;
  controller.override = null;
  broadcast({ type: 'status', capturing: false });
}

// Video area in source-video pixels (the learned rect is in 320x180 frame coordinates).
function videoArea(box) {
  const sx = video.videoWidth / FRAME_W, sy = video.videoHeight / FRAME_H;
  const r = box || { x0: 0, y0: 0, x1: FRAME_W, y1: FRAME_H };
  return { x: r.x0 * sx, y: r.y0 * sy, w: (r.x1 - r.x0) * sx, h: (r.y1 - r.y0) * sy };
}

function sampleFrame() {
  if (!session || video.readyState < 2) return;
  const size = `${video.videoWidth}x${video.videoHeight}`;
  if (size !== lastVideoSize) {
    // Tab layout/size changed (e.g. fullscreen toggled): the learned scoreboard position is invalid,
    // but the game still sounds the same, so the audio profile and team names are kept.
    if (lastVideoSize) {
      overlay.reset();
      lastOcrLearn = 0;
    }
    lastVideoSize = size;
  }
  frameCtx.drawImage(video, 0, 0, FRAME_W, FRAME_H);
  const { data } = frameCtx.getImageData(0, 0, FRAME_W, FRAME_H);
  lastVision = overlay.push(toGray(data, FRAME_W * FRAME_H));
}

function sampleThumb() {
  if (!session || video.readyState < 2) return;
  const a = videoArea(overlay.rect);
  thumbCtx.drawImage(video, a.x, a.y, a.w, a.h, 0, 0, THUMB_W, THUMB_H);
  const { data } = thumbCtx.getImageData(0, 0, THUMB_W, THUMB_H);
  cuts.pushThumb(toGray(data, THUMB_W * THUMB_H), Date.now());
}

function toGray(data, n) {
  const gray = new Uint8Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) gray[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  return gray;
}

async function cropBlob(area, outW) {
  const scale = outW / area.w;
  const canvas = new OffscreenCanvas(Math.round(outW), Math.max(1, Math.round(area.h * scale)));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, area.x, area.y, area.w, area.h, 0, 0, canvas.width, canvas.height);
  return canvas.convertToBlob({ type: 'image/png' });
}

async function runOcr() {
  const v = lastVision;
  if (!session || !ocr.ready || ocr.busy || !v || !v.learned || video.readyState < 2) return;
  const now = Date.now();
  try {
    if (v.presence >= 0.6 && v.maskBox && now - lastOcrLearn > OCR_LEARN_EVERY_MS) {
      lastOcrLearn = now;
      const b = v.maskBox;
      const pad = { x0: Math.max(0, b.x0 - 4), y0: Math.max(0, b.y0 - 3), x1: Math.min(FRAME_W, b.x1 + 4), y1: Math.min(FRAME_H, b.y1 + 3) };
      const area = videoArea(pad);
      await ocr.learnFromScoreboard(await cropBlob(area, Math.min(1600, area.w * 2)));
    } else if (v.presence < 0.4) {
      await ocr.scan(await cropBlob(videoArea(overlay.rect), 1280), now);
    }
  } catch (err) {
    ocr.error = String(err && err.message ? err.message : err);
    broadcast({ type: 'status', ...ocrStatus() });
  }
}

async function sampleAudio(s) {
  const samples = s.resampler.latest();
  const rmsDb = rmsDbOf(samples);
  let audio = { rmsDb };
  if (audioClassifier.ready && !s.audioBusy && samples.length >= 15600) {
    s.audioBusy = true;
    try {
      const res = await audioClassifier.classify(samples);
      const v = lastVision;
      // Only learn the game sound once a scoreboard-sized graphic is learned: a small network logo
      // alone also shows up in the network's promos during breaks.
      const isGame = !!(v && v.learned && v.complete && v.presence >= 0.7);
      const { sim, audioGame } = audioProfile.observe(res.embedding, isGame, rmsDb);
      const show = showProfile.observe(res.embedding, controller.learningShow, rmsDb);
      if (isGame && gameTick++ % 2 === 0) banks.add('game', res.embedding);
      const adLike = (lastDecision.absentSecs || 0) >= AD_BANK_ABSENT_S && !controller.learningShow &&
        !(show.audioGame >= 0.5) && (res.music ?? 0) >= AD_BANK_MUSIC;
      if (adLike) banks.add('ad', res.embedding);
      const two = banks.score(res.embedding);
      const fp = fingerprint(res.embedding);
      delete res.embedding;
      audio = {
        rmsDb, ...res, sim, showAudio: show.audioGame, fp,
        oneClass: audioGame, // "close enough to the game" only
        audioGame: two ? two.audioGame : audioGame, // game-vs-ad comparison once both are learned
        simGame: two ? two.simGame : null,
        simAd: two ? two.simAd : null,
      };
      audioErrors = 0;
    } catch (err) {
      audioClassifier.error = String(err && err.message ? err.message : err);
      if (++audioErrors >= 3) {
        // Backend broke at runtime (e.g. lost WebGL context): reload on the next backend.
        audioErrors = 0;
        loadAudio([audioClassifier.backend]);
      }
      broadcast({ type: 'status', ...audioStatus() });
    } finally {
      s.audioBusy = false;
    }
  }
  if (session !== s) return;
  lastAudio = audio;
  record();
}

function record() {
  const v = lastVision || {};
  const a = lastAudio || {};
  const now = Date.now();
  const cut = cuts.stats(now);
  const ocrHit = ocr.hitActive(now);
  const signals = {
    learned: !!v.learned,
    presence: v.learned ? v.presence : null,
    logoPresence: v.learned ? v.logoPresence : null,
    // "Sounds like the broadcast": the game itself, or show content you confirmed with Wrong!
    audioGame: a.audioGame == null ? null : Math.max(a.audioGame, a.showAudio != null && a.showAudio >= 0.5 ? a.showAudio : 0),
    crowd: a.crowd ?? null,
    music: a.music ?? null,
    rmsDb: a.rmsDb ?? null,
    breakCuts: cut.breakCuts,
    blackCuts: cut.blackCuts,
    persistentPx: v.persistentPx || 0,
    ocrHit,
  };
  const d = decision.step(signals);
  lastDecision = d;
  if (controller.tick(d.muted, signals.presence)) {
    applyMute();
    pushState();
  }
  if (signals.learned && !wasLearned) {
    wasLearned = true;
    lastFound = v.found || 0;
    pushState({ flash: v.complete ? 'Scoreboard learned: auto-mute is active' : 'Only the channel logo so far: still looking for the scoreboard' });
  } else if (!signals.learned && wasLearned) {
    wasLearned = false;
  }
  if (signals.learned && (v.found || 0) > lastFound) {
    lastFound = v.found;
    pushState({ flash: v.complete ? 'Found the scoreboard: auto-mute is fully active' : 'Found another on-screen graphic' });
  }
  const events = controller.takeEvents();
  const rec = {
    t: now,
    label,
    learned: signals.learned,
    frozen: !!v.frozen,
    learnProgress: v.progress ?? 0,
    failReason: v.failReason ?? null,
    maskSize: v.maskSize ?? 0,
    complete: !!v.complete,
    presenceRaw: v.presenceRaw ?? null,
    presence: signals.presence,
    logoPresence: signals.logoPresence,
    regions: v.regions ? v.regions.map((r) => ({ size: r.size, presence: r.presence == null ? null : Math.round(r.presence * 100) / 100, box: r.box })) : null,
    absentSecs: d.absentSecs,
    rmsDb: signals.rmsDb,
    crowd: signals.crowd,
    music: signals.music,
    speech: a.speech ?? null,
    top: a.top ?? null,
    audioSim: a.sim ?? null,
    audioGame: a.audioGame ?? null,
    oneClass: a.oneClass ?? null,
    simGame: a.simGame ?? null,
    simAd: a.simAd ?? null,
    adBank: banks.ad.length,
    gameBank: banks.game.length,
    fp: a.fp ?? null,
    showAudio: a.showAudio ?? null,
    learningShow: controller.learningShow,
    gameAudio: d.gameAudio,
    breakCuts: cut.breakCuts,
    blackCuts: cut.blackCuts,
    cutsPerMin: Math.round(cut.cutsPerMin * 10) / 10,
    persistentPx: signals.persistentPx,
    ocrHit,
    ocrWords: ocrHit ? ocr.lastHitWords : null,
    teams: ocr.teams,
    audioAd: d.audioAd,
    structureAd: d.structureAd,
    showScore: d.showScore,
    pAd: d.pAd,
    wouldMute: d.muted,
    muted: controller.muted,
    override: controller.override,
    autoEnabled: controller.autoEnabled,
    events: events.length ? events : null,
    audioModel: audioStatus().audioModel,
  };
  history.push(rec);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  broadcast({ type: 'stats', rec });
}

function sendPreview() {
  if (!session) return;
  previewCtx.drawImage(frameCanvas, 0, 0);
  const img = previewCtx.getImageData(0, 0, FRAME_W, FRAME_H);
  const mask = overlay.mask;
  if (mask) {
    for (let k = 0; k < mask.length; k++) {
      const p = mask[k] * 4;
      img.data[p] = 255;
      img.data[p + 1] = 40;
      img.data[p + 2] = 40;
    }
  }
  // Persistent graphics (40 s+ unchanged) in green.
  if (overlay.learned) {
    for (let i = 0; i < overlay.streak.length; i++) {
      if (overlay.streak[i] >= 80 && !overlay.inMask[i]) {
        img.data[i * 4] = 40;
        img.data[i * 4 + 1] = 230;
        img.data[i * 4 + 2] = 90;
      }
    }
  }
  previewCtx.putImageData(img, 0, 0);
  // Each learned graphic (scoreboard, channel logo, ...) in yellow.
  previewCtx.strokeStyle = '#fd3';
  previewCtx.lineWidth = 1;
  for (const g of overlay.regions) {
    const b = g.box;
    previewCtx.strokeRect(b.x0 - 1.5, b.y0 - 1.5, b.x1 - b.x0 + 2, b.y1 - b.y0 + 2);
  }
  const r = overlay.rect;
  if (r) {
    previewCtx.strokeStyle = '#3cf';
    previewCtx.lineWidth = 1;
    previewCtx.strokeRect(r.x0 + 0.5, r.y0 + 0.5, r.x1 - r.x0, r.y1 - r.y0);
  }
  previewCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 }).then((blob) => {
    const reader = new FileReader();
    reader.onload = () => broadcast({ type: 'frame', dataUrl: reader.result, ocrText: ocr.lastText });
    reader.readAsDataURL(blob);
  });
}

function rmsDbOf(samples) {
  if (!samples.length) return null;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return 10 * Math.log10(sum / samples.length + 1e-12);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  switch (msg.type) {
    case 'start':
      start(msg.streamId, msg.title, msg.tabId, msg.autoEnabled).then(
        () => sendResponse({ ok: true }),
        (err) => {
          broadcast({ type: 'status', capturing: false, error: String(err) });
          sendResponse({ ok: false, error: String(err) });
        },
      );
      return true;
    case 'stop':
      stop();
      sendResponse({ ok: true });
      break;
    case 'relearn':
      // Scoreboard only: the learned game sound and your corrections stay.
      overlay.reset();
      lastOcrLearn = 0;
      sendResponse({ ok: true });
      break;
    case 'override':
      sendResponse({ ok: true, changed: handleOverride(msg.action), ...controller.state() });
      break;
    case 'get-state':
      sendResponse(session ? { tabId: session.tabId, learned: wasLearned, ...controller.state() } : null);
      break;
    case 'reset-sounds':
      resetSounds();
      sendResponse({ ok: true });
      break;
    case 'label':
      label = msg.label;
      sendResponse({ ok: true });
      break;
    case 'get-history':
      sendResponse({
        history,
        label,
        capturing: !!session,
        ...controller.state(),
        title: session ? session.title : null,
        ...audioStatus(),
        ...ocrStatus(),
      });
      break;
    case 'clear-history':
      history = [];
      sendResponse({ ok: true });
      break;
  }
});
