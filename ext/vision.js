// Scoreboard / network-logo detector that learns the overlay of any stream.
//
// Idea: during a broadcast the field and players keep moving, but the score bug and
// network logo stay still. While learning we average, per pixel, how much it changes
// (motion) and how sharp it is (edges). Then:
//   1. the video area = the region with lots of motion (ignores static page UI around it)
//   2. the overlay mask = pixels inside the video area that are static AND sharp
// After learning, each frame is scored by how many mask pixels still look like the
// learned overlay. A commercial replaces the whole picture, so the score collapses.
//
// Works on grayscale frames of a fixed size (default 320x180).

(function (root) {
  const MOVING = 3; // avg abs luma change per frame to count as "moving"
  const STILL_DIFF = 6; // luma change per frame below this: pixel unchanged in that frame
  const STILL_FRAC = 0.6; // overlay pixel: unchanged in at least this share of frames...
  const SHARP_FRAC = 0.45; // ...and sharp while unchanged in at least this share. Tolerates score
  //                          bars that are hidden for replays or have panels sliding in and out.
  const SHARP = 80; // Sobel magnitude (|gx|+|gy|) to count as an edge
  const ERODE = 3; // px trimmed from the video rect so its border isn't an "edge"
  const FROZEN_FRAC = 0.003; // fewer pixels than this changed since the last frame: picture is frozen
  //                           (buffering/paused), so the frame is skipped
  const MIN_MASK = 30; // px: fewer means no overlay found
  const SMALL_MASK = 120; // px: only a small graphic (e.g. just the network logo) -> keep looking
  const SMALL_RETRIES = 3; // ...for this many attempts before accepting it
  // Background search after learning: every 30 s of play, graphics that were unchanged in most frames
  // and aren't learned yet (e.g. the score bar, if learning happened during replays) are added.
  const BG_STILL_FRAC = 0.65; // a bit stricter than initial learning, so panels that come and go stay out
  const BG_MIN_REGION = 60; // px: smaller new graphics are ignored
  const BG_MIN_PRESENCE = 0.5; // only search windows where the learned graphics were mostly visible (not ads)
  const MAX_MASK_FRAC = 0.25; // more of the video static+sharp means the video isn't playing
  const MIN_RECT_FRAC = 0.15; // video must cover this fraction of width and height
  const LUMA_TOL = 28;
  const EDGE_KEEP = 0.35; // current edge must be >= this fraction of the learned edge
  const DECIDABLE_MIN = 0.3; // a graphic's presence holds when fewer of its pixels than this can tell
  const PRESENCE_ALPHA = 0.3; // EMA smoothing of the presence score
  const ADAPT = 0.02; // template drift rate while the overlay is clearly present
  // Stale pixels: part of a learned graphic that changed for good (e.g. a score bar that changed
  // layout) never matches again, so presence sticks around 0.5 and never counts as visible. Every
  // 30 s of frames where the overlay is at least partly there (ads stay below ~0.2), pixels that
  // matched in fewer than 20% of them are dropped, if the overlay matched less than 70% on average.
  const PRUNE_MIN_RAW = 0.3;
  const PRUNE_FRAMES = 60;
  const PRUNE_BELOW = 0.7;
  const PRUNE_HIT = 0.2;
  const PERSIST_FRAMES = 80; // 40 s at 2 fps: longer than a single 30 s commercial
  const PERSIST_DIFF = 8; // max luma change per frame for a pixel to count as unchanged
  const MAX_PERSIST_FRAC = 0.3; // more than this unchanged means the video froze, not a graphic
  const REGION_CELL = 6; // px: overlay pixels closer than ~this belong to the same graphic
  const MIN_REGION = 12; // px: smaller clusters are noise
  const MAX_REGIONS = 6;
  // Roles: the biggest graphic is the scoreboard; a compact graphic near a corner is the channel logo.
  // Each is tracked on its own, so the logo can carry the decision while the score bar is hidden or
  // relearned after a layout change.
  const LOGO_ASPECT = 4.5; // logo box at most this much wider than tall (or taller than wide). Wordmarks
  //                          like "NFL NETWORK / LIVE" are ~3:1; score bars are 5:1 and wider
  const LOGO_CORNER = 0.3; // logo center within this share of the video area from a corner (both axes)
  const LOGO_GAP = 0.1; // logo at least this share of the video width/height away from the scoreboard, so a
  //                       separate piece of the scoreboard (clock box, team records) isn't taken for it
  const LOGO_ON = 0.8; // logo presence counted as "visible"
  // Corner pass: a white logo over a bright background (court, jerseys, sky) has no edges in those
  // frames, so it misses SHARP_FRAC. In the corners, a pixel that is unchanged in most frames and sharp
  // on average (over the frames it was unchanged) counts too.
  const CORNER_STILL_FRAC = 0.75;
  const CORNER_EDGE = 45; // average Sobel magnitude while unchanged (compression noise stays below ~20)
  // Edge persistence, also corners only: a see-through logo ("sky sports" on a translucent box) shifts in
  // brightness with what's behind it, so it's never "unchanged", but its outline is an edge in the same
  // place in almost every frame. Moving video puts edges at a pixel only now and then.
  const EDGE_PERSIST = 60; // Sobel magnitude counted as an edge (at 40, soft grass stripes panning by counted too)
  const EDGE_PERSIST_FRAC = 0.85; // an edge in at least this share of frames...
  const LOOSE_DIFF = 20; // ...and changing less than this per frame...
  const LOOSE_FRAC = 0.7; // ...in at least this share
  const TOL_SD = 2; // see-through pixels match within this many SD of their learned brightness
  // Box drawn in the debug panel with hardly anything learned inside: watched for 5 s, then the pixels
  // sharp in most frames with steady brightness are learned (moving background fails one or the other).
  const BOX_LEARN_FRAMES = 10;
  const BOX_SHARP_FRAC = 0.7;
  const BOX_MAX_SD = 20;
  const MAX_TOL = 40;
  const SCORE_GONE = 0.2; // score bar presence below this...
  const SCORE_LOST_FRAMES = 120; // ...for 60 s while the logo is visible: the score bar changed, drop it

  class OverlayDetector {
    constructor(opts = {}) {
      this.w = opts.width || 320;
      this.h = opts.height || 180;
      this.learnFrames = opts.learnFrames || 60; // 30 s at 2 fps
      this.reset();
    }

    reset() {
      const n = this.w * this.h;
      this.prev = null;
      this.motion = new Float32Array(n);
      this.stillCount = new Uint16Array(n);
      this.sharpCount = new Uint16Array(n);
      this.stillLuma = new Float32Array(n); // luma / edge sums over the frames the pixel was unchanged,
      this.stillEdge = new Float32Array(n); // i.e. (mostly) while the overlay was showing
      // Edge-persistence stats for see-through logos (EDGE_PERSIST_*): frames the pixel was an edge, and
      // luma / luma² / edge sums over the frames it changed less than LOOSE_DIFF.
      this.edgeCount = new Uint16Array(n);
      this.looseCount = new Uint16Array(n);
      this.looseLuma = new Float32Array(n);
      this.looseLuma2 = new Float32Array(n);
      this.looseEdge = new Float32Array(n);
      this.tol = new Float32Array(n).fill(LUMA_TOL); // per-pixel luma tolerance when scoring
      this.edges = new Float32Array(n);
      this.frames = 0;
      this.learned = false;
      this.rect = null;
      this.mask = null;
      this.maskBox = null;
      this.tplLuma = null;
      this.tplEdge = null;
      this.presence = null;
      this.presenceRaw = null;
      this.failReason = null;
      this.attempts = 0;
      this.streak = new Uint16Array(n);
      this.inMask = new Uint8Array(n);
      this.persistentPx = 0;
      this.regions = [];
      this.frozen = false;
      this.bgPresSum = 0;
      this.found = 0; // graphics added by the background search
      this.bgLast = null; // result of the last background search, for the debug panel
      this.bgDiag = null; // corner snapshot from the last background search (exported logs)
      this.hitCount = null;
      this.scoreRole = null;
      this.logoRole = null;
      this.logoBox = null; // keeps the logo's role when the regions are rebuilt
      this.userBoxes = null; // boxes edited in the debug panel (setUserBoxes)
      this.boxLearning = []; // of those, the ones being watched (boxLearn)
      this.boxFound = null; // pixels learned from them
      this.dropped = 0; // score bars dropped because they changed (SCORE_LOST_FRAMES)
    }

    resetStats() {
      this.frames = 0;
      this.motion.fill(0);
      this.stillCount.fill(0);
      this.sharpCount.fill(0);
      this.stillLuma.fill(0);
      this.stillEdge.fill(0);
      this.edgeCount.fill(0);
      this.looseCount.fill(0);
      this.looseLuma.fill(0);
      this.looseLuma2.fill(0);
      this.looseEdge.fill(0);
      this.bgPresSum = 0;
    }

    push(gray) {
      // Buffering or paused: nothing moves, so everything would look like a static graphic.
      // Skip the frame entirely: learning pauses and the presence score holds its last value.
      this.frozen = !!this.prev && this.changedFraction(gray) < FROZEN_FRAC;
      if (this.frozen) return this.state();
      this.sobel(gray);
      if (!this.learned) {
        this.accumulate(gray);
        if (this.frames >= this.learnFrames) this.finishLearning();
      } else {
        if (this.mask.length) this.score(gray); // empty only while a drawn box is still being learned
        if (this.boxLearning.length) this.boxLearn(gray);
        this.accumulate(gray);
        // Only windows where the broadcast was on screen count: the score bar, or the logo while no
        // score bar is known (e.g. after the score bar changed).
        const role = this.scoreRole || this.logoRole;
        this.bgPresSum += role ? role.raw ?? role.presence ?? 0 : this.presenceRaw;
        if (this.frames >= this.learnFrames) {
          this.backgroundSearch();
          this.resetStats();
        }
      }
      if (!this.prev) this.prev = new Uint8Array(gray.length);
      this.prev.set(gray);
      return this.state();
    }

    changedFraction(gray) {
      const { prev } = this;
      let changed = 0;
      for (let i = 0; i < gray.length; i += 2) if (Math.abs(gray[i] - prev[i]) >= STILL_DIFF) changed++;
      return changed / (gray.length / 2);
    }

    state() {
      return {
        learned: this.learned,
        frozen: this.frozen,
        progress: this.learned ? 1 : Math.min(1, this.frames / this.learnFrames),
        attempts: this.attempts,
        failReason: this.failReason,
        rect: this.rect,
        maskSize: this.mask ? this.mask.length : 0,
        // A scoreboard-sized graphic is learned, not just a small logo.
        complete: !!this.scoreRole,
        found: this.found,
        dropped: this.dropped,
        bgLast: this.bgLast,
        // Background search: every learnFrames frames (30 s) after learning
        bgIn: this.learned ? Math.max(0, Math.ceil((this.learnFrames - this.frames) / 2)) : null,
        maskBox: this.maskBox,
        persistentPx: this.persistentPx,
        regions: this.regions.map((r) => ({ box: r.box, size: r.ks.length, presence: r.presence, role: r.role })),
        scorePresence: this.scoreRole ? this.scoreRole.presence : null,
        scoreBox: this.scoreRole ? this.scoreRole.box : null,
        scoreSize: this.scoreRole ? this.scoreRole.ks.length : 0,
        // The channel logo often stays on during replays and studio segments, but not during commercials.
        logoPresence: this.logoRole ? this.logoRole.presence : null,
        logoBox: this.logoRole ? this.logoRole.box : null,
        logoSize: this.logoRole ? this.logoRole.ks.length : 0,
        userBoxes: this.userBoxes,
        boxLearning: this.boxLearning.length > 0,
        boxFound: this.boxFound,
        presenceRaw: this.presenceRaw,
        presence: this.presence,
      };
    }

    sobel(g) {
      const { w, h, edges } = this;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          const tl = g[i - w - 1], t = g[i - w], tr = g[i - w + 1];
          const l = g[i - 1], r = g[i + 1];
          const bl = g[i + w - 1], b = g[i + w], br = g[i + w + 1];
          const gx = tr + 2 * r + br - tl - 2 * l - bl;
          const gy = bl + 2 * b + br - tl - 2 * t - tr;
          edges[i] = Math.abs(gx) + Math.abs(gy);
        }
      }
    }

    accumulate(gray) {
      this.frames++;
      const k = this.frames;
      const { motion, edges, prev, stillCount, sharpCount, stillLuma, stillEdge, edgeCount, looseCount, looseLuma, looseLuma2, looseEdge } = this;
      if (!prev || k < 2) return;
      for (let i = 0; i < gray.length; i++) {
        const d = Math.abs(gray[i] - prev[i]);
        motion[i] += (d - motion[i]) / (k - 1);
        if (d < STILL_DIFF) {
          stillCount[i]++;
          stillLuma[i] += gray[i];
          stillEdge[i] += edges[i];
          if (edges[i] > SHARP) sharpCount[i]++;
        }
        if (edges[i] > EDGE_PERSIST) edgeCount[i]++;
        if (d < LOOSE_DIFF) {
          looseCount[i]++;
          looseLuma[i] += gray[i];
          looseLuma2[i] += gray[i] * gray[i];
          looseEdge[i] += edges[i];
        }
      }
    }

    finishLearning() {
      this.attempts++;
      const rect = this.findVideoRect();
      if (!rect) return this.retry('Not enough moving video. Go fullscreen/theater mode and make sure the stream is playing.');
      const mask = this.findMask(rect);
      if (mask.length < MIN_MASK) return this.retry('No static scoreboard/logo found yet (maybe learning during a commercial). Retrying.');
      const area = (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
      if (mask.length > MAX_MASK_FRAC * area) return this.retry('Video looks frozen. Retrying.');

      this.rect = rect;
      this.mask = Int32Array.from([]);
      this.tplLuma = new Float32Array(0);
      this.tplEdge = new Float32Array(0);
      this.addToMask(mask);
      if ((mask.length < SMALL_MASK || !this.scoreRole) && this.attempts < SMALL_RETRIES) {
        return this.retry('Only a small graphic found (maybe just the channel logo). Looking for the scoreboard too.');
      }
      this.learned = true;
      this.failReason = null;
      this.resetStats();
    }

    // Adds pixels (learned from the current stats) to the mask and rebuilds the regions.
    // tpl: { luma, edge, tol } per pixel (a drawn box, see boxLearn()); otherwise from the current stats.
    addToMask(pixels, tpl = null) {
      const n0 = this.mask.length;
      const mask = new Int32Array(n0 + pixels.length);
      mask.set(this.mask);
      mask.set(pixels, n0);
      const tplLuma = new Float32Array(mask.length), tplEdge = new Float32Array(mask.length);
      tplLuma.set(this.tplLuma);
      tplEdge.set(this.tplEdge);
      const n = Math.max(1, this.frames - 1);
      for (let k = n0; k < mask.length; k++) {
        const i = mask[k];
        if (tpl) {
          tplLuma[k] = tpl.luma[k - n0];
          tplEdge[k] = tpl.edge[k - n0];
          this.tol[i] = tpl.tol[k - n0];
        } else if (this.stillCount[i] >= 0.3 * n) {
          tplLuma[k] = this.stillLuma[i] / this.stillCount[i];
          tplEdge[k] = this.stillEdge[i] / this.stillCount[i];
          this.tol[i] = LUMA_TOL;
        } else {
          // See-through graphic (found by edge persistence): its brightness follows the background a bit,
          // so it's matched within the spread it showed while learning.
          const c = Math.max(1, this.looseCount[i]), mean = this.looseLuma[i] / c;
          tplLuma[k] = mean;
          tplEdge[k] = this.looseEdge[i] / c;
          this.tol[i] = Math.min(MAX_TOL, Math.max(LUMA_TOL, TOL_SD * Math.sqrt(Math.max(0, this.looseLuma2[i] / c - mean * mean))));
        }
        this.inMask[i] = 1;
      }
      this.setMask(mask, tplLuma, tplEdge);
    }

    // Keeps only the mask entries at indices `ks` (see PRUNE_*).
    keepInMask(ks) {
      for (const i of this.mask) this.inMask[i] = 0;
      const mask = Int32Array.from(ks, (k) => this.mask[k]);
      for (const i of mask) this.inMask[i] = 1;
      this.setMask(mask, Float32Array.from(ks, (k) => this.tplLuma[k]), Float32Array.from(ks, (k) => this.tplEdge[k]));
    }

    setMask(mask, tplLuma, tplEdge) {
      let bx0 = Infinity, by0 = Infinity, bx1 = -1, by1 = -1;
      for (const i of mask) {
        const x = i % this.w, y = (i / this.w) | 0;
        bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y);
      }
      this.mask = mask;
      this.tplLuma = tplLuma;
      this.tplEdge = tplEdge;
      this.maskBox = { x0: bx0, y0: by0, x1: bx1 + 1, y1: by1 + 1 };
      this.regions = this.findRegions(mask);
      // Pixels in no graphic (fragments under MIN_REGION, or past MAX_REGIONS) are dropped: they'd count
      // nowhere, and the background search skips learned pixels, so a logo caught only as a fragment
      // during learning would never be found.
      const keep = this.regions.flatMap((r) => Array.from(r.ks)).sort((a, b) => a - b);
      if (keep.length < mask.length) {
        for (const i of mask) this.inMask[i] = 0;
        const kept = Int32Array.from(keep, (k) => mask[k]);
        for (const i of kept) this.inMask[i] = 1;
        return this.setMask(kept, Float32Array.from(keep, (k) => tplLuma[k]), Float32Array.from(keep, (k) => tplEdge[k]));
      }
      this.presence = null;
      this.hitCount = new Uint16Array(mask.length);
      this.assignRoles();
    }

    // Splits the learned graphics into the scoreboard and the channel logo (see LOGO_*).
    assignRoles() {
      const rs = this.regions;
      const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
      // Boxes set in the debug panel decide for the graphics inside them; the rest go by the rules below.
      const userRole = (r) => (this.userBoxes ? this.userBoxes.find((u) => overlaps(r.box, u.box))?.role ?? null : null);
      let logos = rs.filter((r) => userRole(r) === 'logo');
      if (!logos.length) {
        const free = rs.filter((r) => userRole(r) == null);
        let logo = this.logoBox ? free.find((r) => overlaps(r.box, this.logoBox)) : null;
        // The biggest group of graphics is the scoreboard (graphics not apart from each other form a group: a
        // score bar is often learned as several boxes, each smaller than the logo), unless it's the only
        // graphic and logo-sized.
        if (!logo) {
          const main = this.mainGroup();
          logo = free.find((r) => this.logoShaped(r) && (!main.includes(r) ? main.every((m) => this.apart(r.box, m.box)) : rs.length === 1 && r.ks.length < SMALL_MASK));
        }
        logos = logo ? [logo] : [];
      }
      for (const r of rs) r.role = logos.includes(r) ? 'logo' : 'score';
      const score = rs.filter((r) => !logos.includes(r));
      this.logoRole = logos.length ? newRole(logos) : null;
      this.logoBox = this.logoRole ? this.logoRole.box : null;
      this.scoreRole = score.length ? newRole(score) : null;
    }

    // Boxes edited in the debug panel (320x180 frame coordinates), [{ role: 'score' | 'logo', box }]:
    // learned pixels inside a box take its role, pixels outside every box are dropped (e.g. a stats panel
    // that folded out while learning, or a graphic taken for the wrong thing). A box with hardly anything
    // learned inside is watched for BOX_LEARN_FRAMES (see boxLearn()). An empty list goes back to automatic.
    setUserBoxes(list) {
      if (!this.learned || !this.prev) return false;
      const { w, rect } = this;
      const boxes = [];
      for (const u of list) {
        const b = {
          x0: Math.max(rect.x0 + 1, Math.round(u.box.x0)), y0: Math.max(rect.y0 + 1, Math.round(u.box.y0)),
          x1: Math.min(rect.x1 - 1, Math.round(u.box.x1)), y1: Math.min(rect.y1 - 1, Math.round(u.box.y1)),
        };
        if (b.x1 - b.x0 >= 3 && b.y1 - b.y0 >= 3) boxes.push({ role: u.role === 'logo' ? 'logo' : 'score', box: b });
      }
      if (!boxes.length) {
        this.userBoxes = null;
        this.boxLearning = [];
        this.logoBox = null;
        this.setMask(this.mask, this.tplLuma, this.tplEdge);
        return true;
      }
      const inBox = (i, b) => { const x = i % w, y = (i / w) | 0; return x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1; };
      const inside = boxes.map(() => 0);
      const keep = [];
      for (let k = 0; k < this.mask.length; k++) {
        const j = boxes.findIndex((u) => inBox(this.mask[k], u.box));
        if (j < 0) continue;
        keep.push(k);
        inside[j]++;
      }
      this.userBoxes = boxes;
      this.logoBox = null;
      this.boxFound = 0;
      this.keepInMask(keep);
      this.boxLearning = boxes.filter((u, j) => inside[j] < MIN_MASK).map(({ box: b }) => {
        const n = (b.x1 - b.x0) * (b.y1 - b.y0);
        return { b, frames: 0, sum: new Float32Array(n), sum2: new Float32Array(n), sharp: new Uint16Array(n), edge: new Float32Array(n) };
      });
      return true;
    }

    // Learning a box set in the debug panel: pixels sharp in most of the frames with steady brightness
    // (a logo, opaque or see-through) are added; moving background behind it is neither.
    boxLearn(gray) {
      const add = [], luma = [], edge = [], tol = [];
      for (const L of this.boxLearning) {
        const { b } = L, bw = b.x1 - b.x0;
        for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) {
          const i = y * this.w + x, j = (y - b.y0) * bw + (x - b.x0);
          L.sum[j] += gray[i];
          L.sum2[j] += gray[i] * gray[i];
          L.edge[j] += this.edges[i];
          if (this.edges[i] > SHARP) L.sharp[j]++;
        }
        if (++L.frames < BOX_LEARN_FRAMES) continue;
        for (let j = 0; j < L.sum.length; j++) {
          const i = (b.y0 + ((j / bw) | 0)) * this.w + b.x0 + (j % bw);
          const mean = L.sum[j] / L.frames, sd = Math.sqrt(Math.max(0, L.sum2[j] / L.frames - mean * mean));
          if (this.inMask[i] || add.includes(i) || L.sharp[j] < BOX_SHARP_FRAC * L.frames || sd > BOX_MAX_SD) continue;
          add.push(i);
          luma.push(mean);
          edge.push(L.edge[j] / L.frames);
          tol.push(Math.min(MAX_TOL, Math.max(LUMA_TOL, TOL_SD * sd)));
        }
      }
      if (!this.boxLearning.some((L) => L.frames >= BOX_LEARN_FRAMES)) return;
      this.boxLearning = this.boxLearning.filter((L) => L.frames < BOX_LEARN_FRAMES);
      this.boxFound = (this.boxFound || 0) + add.length;
      if (add.length) this.addToMask(add, { luma, edge, tol });
    }

    // Regions linked by not being apart(), transitively; returns the group with the most pixels.
    mainGroup() {
      const rs = this.regions, group = rs.map((r, i) => i);
      const find = (i) => (group[i] === i ? i : (group[i] = find(group[i])));
      for (let a = 0; a < rs.length; a++) for (let b = a + 1; b < rs.length; b++) {
        if (!this.apart(rs[a].box, rs[b].box)) group[find(a)] = find(b);
      }
      const size = new Map();
      rs.forEach((r, i) => size.set(find(i), (size.get(find(i)) || 0) + r.ks.length));
      let best = null;
      for (const [g, n] of size) if (best == null || n > size.get(best)) best = g;
      return rs.filter((r, i) => find(i) === best);
    }

    logoShaped(r) {
      const { rect } = this;
      const bw = r.box.x1 - r.box.x0, bh = r.box.y1 - r.box.y0;
      const cx = ((r.box.x0 + r.box.x1) / 2 - rect.x0) / (rect.x1 - rect.x0);
      const cy = ((r.box.y0 + r.box.y1) / 2 - rect.y0) / (rect.y1 - rect.y0);
      const corner = (c) => c < LOGO_CORNER || c > 1 - LOGO_CORNER;
      return bw <= LOGO_ASPECT * bh && bh <= LOGO_ASPECT * bw && corner(cx) && corner(cy);
    }

    apart(a, b) {
      const gx = Math.max(a.x0 - b.x1, b.x0 - a.x1), gy = Math.max(a.y0 - b.y1, b.y0 - a.y1);
      return gx >= LOGO_GAP * (this.rect.x1 - this.rect.x0) || gy >= LOGO_GAP * (this.rect.y1 - this.rect.y0);
    }

    // Per role, so a score bar hidden during a replay isn't pruned while the logo keeps the overlay
    // partly there. Returns true if the mask changed.
    prune(hit) {
      const drop = new Set();
      for (const role of [this.scoreRole, this.logoRole]) {
        if (!role || role.raw < PRUNE_MIN_RAW) continue;
        role.pruneFrames++;
        role.pruneSum += role.raw;
        for (const k of role.ks) this.hitCount[k] += hit[k];
        if (role.pruneFrames < PRUNE_FRAMES) continue;
        if (role.pruneSum / role.pruneFrames < PRUNE_BELOW) {
          const stale = role.ks.filter((k) => this.hitCount[k] < PRUNE_HIT * role.pruneFrames);
          if (role.ks.length - stale.length >= MIN_REGION) for (const k of stale) drop.add(k);
        }
        role.pruneFrames = 0;
        role.pruneSum = 0;
        for (const k of role.ks) this.hitCount[k] = 0;
      }
      if (!drop.size) return false;
      const keep = [];
      for (let k = 0; k < this.mask.length; k++) if (!drop.has(k)) keep.push(k);
      this.keepInMask(keep);
      return true;
    }

    // Logo visible but the score bar gone for a minute: the stream switched to a different score bar
    // (or a long studio segment). Drop it, so the background search can learn the new one.
    checkScoreLost() {
      const sr = this.scoreRole, lr = this.logoRole;
      if (!sr || !lr || lr.presence < LOGO_ON || sr.presence >= SCORE_GONE) {
        if (sr) sr.goneFrames = 0;
        return;
      }
      if (++sr.goneFrames < SCORE_LOST_FRAMES) return;
      this.keepInMask(Array.from(lr.ks));
      this.dropped++;
    }

    // Snapshot of the four corners for exported logs: what the search saw, per pixel, so a missed
    // logo can be diagnosed offline. Percentages of frames unchanged / sharp while unchanged, the average
    // edge while unchanged, and the last frame's brightness.
    cornerDiag() {
      const { rect, w } = this;
      const n = Math.max(1, this.frames - 1);
      const cw = Math.round(LOGO_CORNER * (rect.x1 - rect.x0)), chh = Math.round(LOGO_CORNER * (rect.y1 - rect.y0));
      const corners = [['tl', rect.x0, rect.y0], ['tr', rect.x1 - cw, rect.y0], ['bl', rect.x0, rect.y1 - chh], ['br', rect.x1 - cw, rect.y1 - chh]];
      return {
        frames: n,
        presence: Math.round((this.bgPresSum / this.frames) * 100) / 100,
        rect,
        corners: corners.map(([name, x0, y0]) => {
          const still = [], sharp = [], edge = [], luma = [], learned = [];
          for (let y = y0; y < y0 + chh; y++) for (let x = x0; x < x0 + cw; x++) {
            const i = y * w + x;
            still.push(Math.round((this.stillCount[i] / n) * 100));
            sharp.push(Math.round((this.sharpCount[i] / n) * 100));
            edge.push(Math.round((this.edgeCount[i] / n) * 100)); // % of frames it was an edge (EDGE_PERSIST)
            luma.push(this.prev ? this.prev[i] : 0);
            learned.push(this.inMask[i]);
          }
          return { name, x0, y0, w: cw, h: chh, still, sharp, edge, luma, learned };
        }),
      };
    }

    backgroundSearch() {
      this.bgDiag = this.cornerDiag();
      this.bgLast = 'skipped (scoreboard not on screen enough)';
      if (this.bgPresSum / this.frames < BG_MIN_PRESENCE) return 0;
      this.bgLast = 'nothing new';
      const cand = this.findMask(this.rect, BG_STILL_FRAC);
      const fresh = Int32Array.from(cand.filter((i) => !this.inMask[i]));
      if (!fresh.length) return 0;
      // Only separate graphics (the missing logo or score bar). Growing a learned graphic would pull in
      // panels that slide in and out next to the score bar.
      const near = (a, b) => a.x0 - REGION_CELL < b.x1 && b.x0 - REGION_CELL < a.x1 && a.y0 - REGION_CELL < b.y1 && b.y0 - REGION_CELL < a.y1;
      const add = [];
      for (const r of this.findRegions(fresh)) {
        if (r.ks.length < BG_MIN_REGION || this.regions.some((g) => near(r.box, g.box))) continue;
        for (const k of r.ks) add.push(fresh[k]);
      }
      const area = (this.rect.x1 - this.rect.x0) * (this.rect.y1 - this.rect.y0);
      if (!add.length || this.mask.length + add.length > MAX_MASK_FRAC * area) return 0;
      this.addToMask(add);
      this.found++;
      this.bgLast = `found a graphic (${add.length} px)`;
      return add.length;
    }

    retry(reason) {
      const attempts = this.attempts;
      this.reset();
      this.attempts = attempts;
      this.failReason = reason;
    }

    findVideoRect() {
      const { w, h, motion } = this;
      const moving = (i) => motion[i] > MOVING;

      const longestRun = (counts, minCount) => {
        let best = null, start = -1;
        for (let i = 0; i <= counts.length; i++) {
          const ok = i < counts.length && counts[i] >= minCount;
          if (ok && start < 0) start = i;
          if (!ok && start >= 0) {
            if (!best || i - start > best[1] - best[0]) best = [start, i];
            start = -1;
          }
        }
        return best;
      };

      // Columns first (all rows), then rows within those columns, then refine columns.
      const cols = new Int32Array(w);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (moving(y * w + x)) cols[x]++;
      let colMax = Math.max(...cols);
      if (!colMax) return null;
      let cr = longestRun(cols, colMax * 0.25);

      const rows = new Int32Array(h);
      for (let y = 0; y < h; y++) for (let x = cr[0]; x < cr[1]; x++) if (moving(y * w + x)) rows[y]++;
      const rowMax = Math.max(...rows);
      const rr = longestRun(rows, rowMax * 0.12); // low: rows mostly covered by a score bar still count

      cols.fill(0);
      for (let y = rr[0]; y < rr[1]; y++) for (let x = 0; x < w; x++) if (moving(y * w + x)) cols[x]++;
      colMax = Math.max(...cols);
      cr = longestRun(cols, colMax * 0.25);

      const rect = { x0: cr[0] + ERODE, x1: cr[1] - ERODE, y0: rr[0] + ERODE, y1: rr[1] - ERODE };
      if (rect.x1 - rect.x0 < w * MIN_RECT_FRAC || rect.y1 - rect.y0 < h * MIN_RECT_FRAC) return null;
      return rect;
    }

    findMask(rect, stillFrac = STILL_FRAC) {
      const { w, stillCount, sharpCount, stillEdge, edgeCount, looseCount } = this;
      const n = this.frames - 1;
      const cand = new Uint8Array(w * this.h);
      const cw = LOGO_CORNER * (rect.x1 - rect.x0), chh = LOGO_CORNER * (rect.y1 - rect.y0);
      for (let y = rect.y0; y < rect.y1; y++) {
        const cornerY = y < rect.y0 + chh || y >= rect.y1 - chh;
        for (let x = rect.x0; x < rect.x1; x++) {
          const i = y * w + x;
          if (stillCount[i] >= stillFrac * n && sharpCount[i] >= SHARP_FRAC * n) cand[i] = 1;
          else if (cornerY && (x < rect.x0 + cw || x >= rect.x1 - cw) &&
            ((stillCount[i] >= CORNER_STILL_FRAC * n && stillEdge[i] >= CORNER_EDGE * stillCount[i]) ||
              (edgeCount[i] >= EDGE_PERSIST_FRAC * n && looseCount[i] >= LOOSE_FRAC * n))) cand[i] = 1;
        }
      }
      // Drop isolated pixels: keep those with >= 2 candidate neighbours.
      const mask = [];
      for (let y = rect.y0 + 1; y < rect.y1 - 1; y++) {
        for (let x = rect.x0 + 1; x < rect.x1 - 1; x++) {
          const i = y * w + x;
          if (!cand[i]) continue;
          const nb = cand[i - w - 1] + cand[i - w] + cand[i - w + 1] + cand[i - 1] + cand[i + 1] +
            cand[i + w - 1] + cand[i + w] + cand[i + w + 1];
          if (nb >= 2) mask.push(i);
        }
      }
      return Int32Array.from(mask);
    }

    score(gray) {
      this.trackPersistence(gray);
      const { mask, tplLuma, tplEdge, edges } = this;
      let match = 0;
      const hit = new Uint8Array(mask.length);
      // Right brightness but no edge: the background behind it is the same color (white logo on a
      // white jersey), so this pixel can't tell whether the graphic is there.
      const unsure = new Uint8Array(mask.length);
      for (let k = 0; k < mask.length; k++) {
        const i = mask[k];
        if (Math.abs(gray[i] - tplLuma[k]) >= this.tol[i]) continue;
        if (edges[i] >= EDGE_KEEP * tplEdge[k]) {
          match++;
          hit[k] = 1;
        } else unsure[k] = 1;
      }
      const raw = match / mask.length;
      const ema = (o, v) => (o.presence = o.presence == null ? v : o.presence + PRESENCE_ALPHA * (v - o.presence));
      // Share of the graphic's pixels that match, out of those that can tell. null (presence holds)
      // when most of it blends into the background.
      const rawOf = (ks) => {
        let m = 0, u = 0;
        for (const k of ks) {
          m += hit[k];
          u += unsure[k];
        }
        return ks.length - u >= DECIDABLE_MIN * ks.length ? m / (ks.length - u) : null;
      };
      for (const r of this.regions) {
        const v = rawOf(r.ks);
        if (v != null) ema(r, v);
      }
      for (const role of [this.scoreRole, this.logoRole]) {
        if (!role) continue;
        role.raw = rawOf(role.ks);
        if (role.raw != null) ema(role, role.raw);
      }
      this.presenceRaw = raw;
      ema(this, raw);

      // Follow slow changes (e.g. lighting, score digits) while the overlay is clearly there.
      if (raw > 0.6) {
        for (let k = 0; k < mask.length; k++) {
          if (!hit[k]) continue;
          const i = mask[k];
          tplLuma[k] += ADAPT * (gray[i] - tplLuma[k]);
          tplEdge[k] += ADAPT * (edges[i] - tplEdge[k]);
        }
      }
      if (!this.prune(hit)) this.checkScoreLost();
    }
  }

  // A role (scoreboard or channel logo) made of one or more graphics, with its own presence score.
  function newRole(regions) {
    return {
      ks: Int32Array.from(regions.flatMap((r) => Array.from(r.ks))),
      box: {
        x0: Math.min(...regions.map((r) => r.box.x0)), y0: Math.min(...regions.map((r) => r.box.y0)),
        x1: Math.max(...regions.map((r) => r.box.x1)), y1: Math.max(...regions.map((r) => r.box.y1)),
      },
      raw: null,
      presence: null,
      pruneFrames: 0,
      pruneSum: 0,
      goneFrames: 0,
    };
  }

  // Splits the overlay mask into separate graphics (scoreboard, channel logo, ...) by grouping
  // mask pixels on a coarse grid. Returns regions with mask-index lists, largest first.
  OverlayDetector.prototype.findRegions = function (mask) {
    const { w, h } = this;
    const cw = Math.ceil(w / REGION_CELL), chh = Math.ceil(h / REGION_CELL);
    const cellKs = new Map();
    for (let k = 0; k < mask.length; k++) {
      const i = mask[k];
      const c = (((i / w) | 0) / REGION_CELL | 0) * cw + ((i % w) / REGION_CELL | 0);
      if (!cellKs.has(c)) cellKs.set(c, []);
      cellKs.get(c).push(k);
    }
    const parent = new Map([...cellKs.keys()].map((c) => [c, c]));
    const find = (c) => (parent.get(c) === c ? c : (parent.set(c, find(parent.get(c))), parent.get(c)));
    for (const c of cellKs.keys()) {
      const cx = c % cw, cy = (c / cw) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= chh) continue;
        const n = ny * cw + nx;
        if (cellKs.has(n)) parent.set(find(c), find(n));
      }
    }
    const groups = new Map();
    for (const [c, ks] of cellKs) {
      const root = find(c);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(...ks);
    }
    return [...groups.values()]
      .filter((ks) => ks.length >= MIN_REGION)
      .sort((a, b) => b.length - a.length)
      .slice(0, MAX_REGIONS)
      .map((ks) => {
        let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
        for (const k of ks) {
          const x = mask[k] % w, y = (mask[k] / w) | 0;
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
        return { ks: Int32Array.from(ks), box: { x0, y0, x1: x1 + 1, y1: y1 + 1 }, presence: null };
      });
  };

  // Graphics that stay put for 40+ s while the scoreboard is gone (score ticker, network
  // logo, studio graphics) point to broadcast content rather than a commercial pod.
  OverlayDetector.prototype.trackPersistence = function (gray) {
    const { w, rect, edges, prev, streak, inMask } = this;
    if (!prev) return;
    let count = 0;
    for (let y = rect.y0; y < rect.y1; y++) {
      for (let x = rect.x0; x < rect.x1; x++) {
        const i = y * w + x;
        if (!inMask[i] && edges[i] > SHARP && Math.abs(gray[i] - prev[i]) < PERSIST_DIFF) {
          if (streak[i] < 65535) streak[i]++;
          if (streak[i] >= PERSIST_FRAMES) count++;
        } else streak[i] = 0;
      }
    }
    const area = (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
    this.persistentPx = count > MAX_PERSIST_FRAC * area ? 0 : count;
  };

  root.OverlayDetector = OverlayDetector;
  if (typeof module !== 'undefined') module.exports = { OverlayDetector };
})(typeof self !== 'undefined' ? self : globalThis);
