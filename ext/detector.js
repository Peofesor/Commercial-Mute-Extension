// Turns the raw signals into "is this a commercial?" and a mute decision.
//
// Scoreboard or channel logo visible -> game. Both gone -> commercial, OR a replay, interview, studio
// segment or halftime show (all of which you want to hear). The deciding signal is whether the
// audio still sounds like this broadcast (learned while the scoreboard is up). Music,
// black+silent cuts, persistent graphics and on-screen text only nudge the result.

(function (root) {
  const clamp01 = (x) => Math.max(0, Math.min(1, x));

  const PRESENT = 0.6; // scoreboard presence counted as "visible"
  const ABSENT = 0.4; // below this counts as "gone"
  const REPLAY_MAX_S = 10; // absence shorter than this contributes nothing
  const ABSENCE_FULL_S = 40; // absence this long is fully "not a replay"
  const PARTLY_S = 3; // scoreboard at least ABSENT this many seconds in a row: still on screen, absence
  //                     starts over (a half-matching scoreboard otherwise adds up every dip; ads stay below ~0.2)
  // Decision timing. Tuned on three labeled games (two college, one NFL), then tightened on a
  // labeled college basketball game where the scoreboard was lost after the first break, so the
  // audio alone had to decide: mute within ~1-3 s of the break, no mutes during play.
  const DEFAULTS = {
    muteP: 0.75, // ad probability needed...
    muteAfterS: 2, // ...for this many consecutive seconds
    minAbsentS: 3, // and the scoreboard gone at least this long (the music lead-in into a break counts
    //                as the break)
    // Until this broadcast's ads are learned, the sound can only be "not like the game", which a replay
    // transition or a sideline shot (engine noise, no commentary) also is for a few seconds. So until
    // then: the scoreboard gone this long, and ad-like this many seconds in a row. Black+silent cuts
    // still mute at once.
    coldAbsentS: 8,
    coldMuteAfterS: 4,
    coldUnmuteNeed: 7, // and unmuting on sound alone (no logo to go by) needs this many of the last
    //                    unmuteLogoGoneS seconds: a talky ad otherwise unmuted mid-break

    unmuteGameAudio: 0.7, // "sounds like the broadcast" level for one second...
    unmuteNeed: 5, // ...reached in at least this many...
    unmuteWindowS: 6, // ...of the last this many seconds, while the scoreboard is still gone (e.g.
    //                   halftime show after ads). Talky ads sound like the game in 2-4 s bursts;
    //                   the game coming back stays there.
    // The channel logo decides how sure the sound has to be (scoreboard still gone): logo clearly gone,
    // so it's an ad that sounds like commentary -> all of the last unmuteLogoGoneS seconds; logo partly
    // back -> unmuteLogoNeed of the last unmuteLogoWindowS seconds.
    logoGone: 0.2, // ads stayed at 0-5%; during play this stream's logo dipped to ~20%
    unmuteLogoGoneS: 8,
    logoPart: 0.4,
    unmuteLogoNeed: 3,
    unmuteLogoWindowS: 4,
    unmuteScoreboardS: 1, // or the scoreboard visible this long
    logoVisible: 0.8, // the channel logo this visible also counts as "game is on" (it stays on during
    //                  replays and studio segments): 88-93% during play, rarely above 30% in ads
    logoAdS: 30, // logo visible this many seconds (in total) while the scoreboard is gone and the audio
    //              sounds like ads: it's a watermark that stays on during commercials, so it's ignored
    windowS: 3, // smoothing window for the audio signals
    cutMuteS: 20, // a black+silent cut this soon after the scoreboard left mutes at once (black frames
    //               only showed up at break boundaries and between ads, never during play)
    ambientS: 30, // during the first this many seconds of an absence (replays, dead balls), sound with
    //               neither speech nor music (crowd, squeaks) counts as neither game nor ad
  };
  const SILENCE_DB = -50;

  // ---- Learned "what this game sounds like" (commentary + crowd + venue) ----
  // Centroid of YAMNet embeddings taken while the scoreboard is visible. Similarity is turned
  // into a 0..1 "sounds like the game" score using the similarity spread seen during the game.
  // Also used for the "show" profile learned from your Wrong! presses (studio segments,
  // interviews...), with lower sample thresholds so a short correction is enough.
  class GameAudioProfile {
    constructor(opts = {}) {
      this.minN = opts.minN ?? 15;
      this.minSimN = opts.minSimN ?? 20;
      this.zScale = opts.zScale ?? 3; // this many SD below normal -> score 0
      this.reset();
    }

    reset() {
      this.centroid = null;
      this.n = 0;
      this.simMean = 0;
      this.simVar = 0;
      this.simN = 0;
      this.rmsMean = null;
    }

    get ready() {
      return this.simN >= this.minSimN;
    }

    observe(embedding, isGame, rmsDb) {
      const e = normalize(embedding);
      const sim = this.centroid && this.n >= this.minN ? dot(e, this.centroid) : null;
      if (isGame) {
        if (sim != null) {
          this.simN++;
          const a = Math.max(1 / this.simN, 0.02);
          const d = sim - this.simMean;
          this.simMean += a * d;
          this.simVar += a * (d * d - this.simVar);
        }
        this.n++;
        if (!this.centroid) this.centroid = e.slice();
        else {
          const b = Math.max(1 / this.n, 0.01);
          for (let i = 0; i < e.length; i++) this.centroid[i] += b * (e[i] - this.centroid[i]);
          normalizeInPlace(this.centroid);
        }
        if (rmsDb != null) this.rmsMean = this.rmsMean == null ? rmsDb : this.rmsMean + 0.02 * (rmsDb - this.rmsMean);
      }
      let audioGame = null;
      if (sim != null && this.ready) {
        const sd = Math.max(0.02, Math.sqrt(this.simVar));
        audioGame = clamp01(1 + (sim - this.simMean) / sd / this.zScale);
      }
      return { sim, audioGame };
    }
  }

  // ---- Game sound vs. ad sound ----
  // Keeps recent sound fingerprints (YAMNet embeddings) of this broadcast's game audio and of its
  // ads, and scores new audio by which it is closer to (average of the k nearest in each bank).
  // Much sharper than "close enough to the game" alone: talky ads sound like speech too, but they
  // are closer to other ads than to the commentary.
  class AudioBanks {
    constructor(opts = {}) {
      this.size = opts.size ?? 400;
      this.k = opts.k ?? 5;
      this.minAd = opts.minAd ?? 20; // ad fingerprints needed before scoring
      this.minGame = opts.minGame ?? 30;
      this.scale = opts.scale ?? 4; // similarity difference -> 0..1 score until calibrated
      this.reset();
    }

    reset() {
      this.game = [];
      this.ad = [];
      this.dGameHist = []; // recent (game - ad) similarity differences for game audio...
      this.dAdHist = []; // ...and for ad audio: the score is calibrated between their medians
    }

    add(bank, e) {
      const n = normalize(e);
      if (this.ready) {
        const hist = bank === 'ad' ? this.dAdHist : this.dGameHist;
        hist.push(this.topK(this.game, n) - this.topK(this.ad, n));
        if (hist.length > 200) hist.shift();
      }
      const b = bank === 'ad' ? this.ad : this.game;
      b.push(n);
      if (b.length > this.size) b.shift();
    }

    get ready() {
      return this.ad.length >= this.minAd && this.game.length >= this.minGame;
    }

    topK(bank, e) {
      const sims = bank.map((v) => dot(v, e)).sort((a, b) => b - a);
      const top = sims.slice(0, this.k);
      return top.reduce((a, b) => a + b, 0) / top.length;
    }

    // 0 = sounds like this broadcast's ads, 1 = sounds like its game audio, null = not enough data.
    score(embedding) {
      if (!this.ready) return null;
      const e = normalize(embedding);
      const g = this.topK(this.game, e), a = this.topK(this.ad, e);
      const d = g - a;
      const med = (h) => (h.length >= 10 ? [...h].sort((x, y) => x - y)[h.length >> 1] : null);
      const dG = med(this.dGameHist), dA = med(this.dAdHist);
      const calibrated = dG != null && dA != null && dG - dA > 0.005;
      // calibrated: typical game audio -> ~0.9, typical ad audio -> ~0.1
      const audioGame = calibrated ? clamp01(0.1 + (0.8 * (d - dA)) / (dG - dA)) : clamp01(0.5 + this.scale * d);
      return { audioGame, simGame: g, simAd: a };
    }
  }

  // Fixed random projection 1024 -> 64 dims, rounded: a compact sound fingerprint for exported logs,
  // so detection changes can be tested offline against real broadcast audio.
  const FP_DIMS = 64;
  let fpMatrix = null;
  function fingerprint(embedding) {
    if (!fpMatrix) {
      let seed = 12345;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
      fpMatrix = Array.from({ length: FP_DIMS }, () => Float32Array.from({ length: 1024 }, rnd));
    }
    return fpMatrix.map((row) => Math.round(dot(row, embedding) * 100) / 100);
  }

  // ---- Black frames + silence: how broadcasters separate commercials ----
  class CutDetector {
    constructor() {
      this.reset();
    }

    reset() {
      this.black = [];
      this.silent = [];
      this.cuts = [];
      this.wasBlack = false;
      this.wasSilent = false;
      this.prevThumb = null;
    }

    // Tiny grayscale thumbnail (e.g. 32x18 of the video area), ~10x per second.
    pushThumb(thumb, t) {
      let sum = 0, max = 0, diff = 0;
      for (let i = 0; i < thumb.length; i++) {
        sum += thumb[i];
        if (thumb[i] > max) max = thumb[i];
        if (this.prevThumb) diff += Math.abs(thumb[i] - this.prevThumb[i]);
      }
      const mean = sum / thumb.length;
      const isBlack = mean < 18 && max < 60;
      if (isBlack && !this.wasBlack) this.black.push(t);
      if (this.prevThumb && !isBlack && !this.wasBlack && diff / thumb.length > 40) this.cuts.push(t);
      this.wasBlack = isBlack;
      if (!this.prevThumb) this.prevThumb = new Uint8Array(thumb.length);
      this.prevThumb.set(thumb);
      this.prune(t);
    }

    // RMS of a short audio block (~85 ms).
    pushAudioLevel(db, t) {
      const isSilent = db < SILENCE_DB;
      if (isSilent && !this.wasSilent) this.silent.push(t);
      this.wasSilent = isSilent;
    }

    prune(t) {
      const keep = (arr) => {
        while (arr.length && arr[0] < t - 120000) arr.shift();
      };
      keep(this.black);
      keep(this.silent);
      keep(this.cuts);
    }

    // Counts over the last `windowMs`.
    stats(t, windowMs = 90000) {
      const recent = (arr) => arr.filter((x) => x >= t - windowMs);
      const black = recent(this.black);
      const silent = recent(this.silent);
      const breakCuts = black.filter((b) => silent.some((s) => Math.abs(s - b) < 1200)).length;
      const cutsPerMin = (recent(this.cuts).length * 60000) / windowMs;
      return { blackCuts: black.length, breakCuts, cutsPerMin };
    }
  }

  // ---- Combining everything ----
  // The learned game-audio similarity is by far the strongest signal (it stays high for
  // replays, interviews and the halftime show, and drops to ~0 within seconds of an ad),
  // so it drives the decision; the rest only nudges it.
  const SHOW_GRAPHICS_PX = 80;
  const LOGO_PRESENT = 0.75; // the channel logo this visible
  const LOGO_AD_AUDIO = 0.3; // "sounds like the game" below this counts as ad audio for logoAdS
  const STARTUP_S = 10; // after resume(): window for muting at once...
  const STARTUP_AD_AUDIO = 0.3; // ...when one second sounds like this little like the game

  class BreakDecision {
    constructor(opts = {}) {
      this.cfg = { ...DEFAULTS, ...opts };
      this.reset();
    }

    reset() {
      this.muted = false;
      this.adSecs = 0;
      this.backSecs = 0;
      this.absentSecs = 0;
      this.gameWin = [];
      this.unmuteWin = [];
      this.musicWin = [];
      this.lastBreakCuts = 0;
      this.cutAgo = Infinity;
      this.partlySecs = 0;
      this.logoKey = null;
      this.logoAdSecs = 0;
      this.startupSecs = Infinity;
    }

    // Turned back on with everything already learned: starts over like reset(), but a logo found to be a
    // watermark stays ignored, and if it's switched on mid-commercial it mutes at once (see step()).
    resume() {
      const { logoKey, logoAdSecs } = this;
      this.reset();
      Object.assign(this, { logoKey, logoAdSecs, startupSecs: 0 });
    }

    // Call once per second. s: { learned, scorePresence, logoPresence, logoBox, audioGame, music,
    //   speech, rmsDb, breakCuts, blackCuts, persistentPx, ocrHit, adReady }
    // Older logs have only `presence` (all learned graphics together) instead of scorePresence.
    step(s) {
      const key = s.logoBox ? JSON.stringify(s.logoBox) : null;
      if (key !== this.logoKey) {
        this.logoKey = key;
        this.logoAdSecs = 0;
      }
      const logoIgnored = this.cfg.logoAdS != null && this.logoAdSecs >= this.cfg.logoAdS;
      const score = s.scorePresence !== undefined ? s.scorePresence : s.presence;
      const logo = logoIgnored ? null : s.logoPresence ?? null;
      const vis = s.learned && (score != null || logo != null);
      const logoOn = vis && this.cfg.logoVisible != null && logo != null && logo >= this.cfg.logoVisible;
      const seen = vis && ((score != null && score >= PRESENT) || logoOn); // broadcast graphics on screen
      const main = score ?? logo; // dips of this count as "gone": the scoreboard, or the logo if it's all there is
      // Presence is briefly unknown right after a graphic is added to the learned scoreboard: hold.
      this.partlySecs = vis && main >= ABSENT ? this.partlySecs + 1 : vis ? 0 : this.partlySecs;
      if (!s.learned || seen || this.partlySecs >= PARTLY_S) this.absentSecs = 0;
      else if (vis && main < ABSENT) this.absentSecs++;

      const push = (win, v) => {
        if (v != null) win.push(v);
        if (win.length > this.cfg.windowS) win.shift();
      };
      const ambient = this.absentSecs < this.cfg.ambientS && s.speech != null && s.speech < 0.2 && (s.music ?? 0) < 0.2;
      const silent = (s.rmsDb != null && s.rmsDb < SILENCE_DB) || ambient;
      // Seconds since the last black+silent cut (the count only goes up when a new one happens).
      this.cutAgo = s.breakCuts > this.lastBreakCuts ? 0 : this.cutAgo + 1;
      this.lastBreakCuts = s.breakCuts;
      push(this.gameWin, silent ? null : s.audioGame);
      push(this.musicWin, silent ? null : s.music);
      this.unmuteWin.push(silent ? null : s.audioGame);
      if (this.unmuteWin.length > Math.max(this.cfg.unmuteWindowS, this.cfg.unmuteLogoGoneS)) this.unmuteWin.shift();
      const mean = (w) => (w.length ? w.reduce((a, b) => a + b, 0) / w.length : null);
      const gameAudio = this.gameWin.length >= 3 ? mean(this.gameWin) : null;
      const music = mean(this.musicWin);

      if (logoOn && score != null && score < ABSENT && gameAudio != null && gameAudio < LOGO_AD_AUDIO) this.logoAdSecs++;

      const out = { absentSecs: this.absentSecs, gameAudio, logoIgnored, audioAd: null, structureAd: null, showScore: null, pAd: null };
      // Scoreboard not learned (e.g. relearning after a layout change): the audio alone decides,
      // if the game-audio profile is already there.
      if (!vis && gameAudio == null) return { ...out, muted: this.muted };

      out.structureAd = clamp01(0.6 * s.breakCuts + 0.3 * Math.max(0, s.blackCuts - s.breakCuts));
      out.showScore = Math.max(
        s.persistentPx >= SHOW_GRAPHICS_PX ? 0.5 : 0,
        s.ocrHit ? 0.4 : 0,
        vis && logo != null && logo >= LOGO_PRESENT ? 0.3 : 0, // channel logo still on screen
      );

      if (seen) {
        out.pAd = clamp01(0.2 * (1 - Math.max(score ?? 0, logo ?? 0)));
      } else if (gameAudio != null) {
        out.audioAd = clamp01(1 - gameAudio + 0.3 * (music || 0));
        const gone = vis ? (this.absentSecs >= this.cfg.minAbsentS ? 1 : 0) : 1; // scoreboard must actually be gone
        out.pAd = clamp01(out.audioAd + 0.15 * out.structureAd) * gone * (1 - 0.5 * out.showScore);
      } else {
        // No game-audio profile yet (audio model missing or still learning): absence time only,
        // which never mutes replays shorter than ~40 s.
        const absentScore = clamp01((this.absentSecs - REPLAY_MAX_S) / (ABSENCE_FULL_S - REPLAY_MAX_S));
        out.pAd = clamp01(0.75 * absentScore + 0.25 * out.structureAd) * (1 - 0.5 * out.showScore);
      }

      if (!this.muted) {
        this.adSecs = out.pAd >= this.cfg.muteP ? this.adSecs + 1 : 0;
        // The cut often comes a second or two before the scoreboard fades out.
        const gone = vis && !seen && main < ABSENT && this.absentSecs <= this.cfg.cutMuteS;
        // Just switched on (resume()): how long the scoreboard has been gone is unknown, so scoreboard,
        // logo and one second of ad-sounding audio are enough. Only in the first STARTUP_S seconds.
        const startup = this.startupSecs++ < STARTUP_S && vis && !seen && main < ABSENT &&
          s.adReady !== false && !silent && s.audioGame != null && s.audioGame < STARTUP_AD_AUDIO;
        if (seen) this.startupSecs = Infinity;
        const cut = startup || (gone && this.cutAgo <= 5);
        if (cut) this.cutAgo = Infinity;
        const cold = s.adReady === false; // older logs don't say: normal timing
        const muteAfter = cold ? this.cfg.coldMuteAfterS : this.cfg.muteAfterS;
        const longGone = !cold || !vis || this.absentSecs >= this.cfg.coldAbsentS;
        if (cut || (this.adSecs >= muteAfter && longGone)) {
          this.muted = true;
          this.backSecs = 0;
          this.unmuteWin = [];
        }
      } else {
        this.backSecs = seen ? this.backSecs + 1 : 0;
        // Scoreboard still gone: unmute only if the broadcast audio has been back for most of a few seconds.
        const back = (n) => this.unmuteWin.slice(-n).filter((g) => g != null && g >= this.cfg.unmuteGameAudio).length;
        const c = this.cfg;
        const soundBack = vis && logo != null && logo < c.logoGone ? back(c.unmuteLogoGoneS) >= c.unmuteLogoGoneS
          : vis && logo != null && logo >= c.logoPart ? back(c.unmuteLogoWindowS) >= c.unmuteLogoNeed
          : s.adReady === false ? back(c.unmuteLogoGoneS) >= c.coldUnmuteNeed
          : back(c.unmuteWindowS) >= c.unmuteNeed;
        // No game sound learned yet: only the scoreboard can tell the game is back.
        const showBack = gameAudio != null && soundBack;
        if (this.backSecs >= this.cfg.unmuteScoreboardS || showBack) {
          this.muted = false;
          this.adSecs = 0;
        }
      }
      return { ...out, muted: this.muted };
    }
  }

  function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  function normalizeInPlace(v) {
    const n = Math.sqrt(dot(v, v)) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
  }

  function normalize(v) {
    return normalizeInPlace(Float32Array.from(v));
  }

  root.BreakDecision = BreakDecision;
  root.GameAudioProfile = GameAudioProfile;
  root.CutDetector = CutDetector;
  root.AudioBanks = AudioBanks;
  root.fingerprint = fingerprint;
  if (typeof module !== 'undefined') module.exports = { BreakDecision, GameAudioProfile, CutDetector, AudioBanks, fingerprint };
})(typeof self !== 'undefined' ? self : globalThis);
