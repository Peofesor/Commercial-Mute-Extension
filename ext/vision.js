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
      this.hitCount = null;
      this.pruneFrames = 0;
      this.pruneSum = 0;
    }

    resetStats() {
      this.frames = 0;
      this.motion.fill(0);
      this.stillCount.fill(0);
      this.sharpCount.fill(0);
      this.stillLuma.fill(0);
      this.stillEdge.fill(0);
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
        this.score(gray);
        this.accumulate(gray);
        this.bgPresSum += this.presenceRaw;
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
        complete: !!this.mask && this.mask.length >= SMALL_MASK,
        found: this.found,
        maskBox: this.maskBox,
        persistentPx: this.persistentPx,
        regions: this.regions.map((r) => ({ box: r.box, size: r.ks.length, presence: r.presence })),
        // Best single overlay graphic (e.g. the channel logo, which often stays on during replays
        // and studio segments but never during commercials).
        // Only graphics at least a quarter the size of the largest count, so a small network logo
        // (which also shows up in the network's own promos during breaks) doesn't.
        logoPresence: this.regions.length
          ? Math.max(...this.regions.filter((r) => r.ks.length >= 0.25 * this.regions[0].ks.length).map((r) => r.presence ?? 0))
          : null,
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
      const { motion, edges, prev, stillCount, sharpCount, stillLuma, stillEdge } = this;
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
      if (mask.length < SMALL_MASK && this.attempts < SMALL_RETRIES) {
        return this.retry('Only a small graphic found (maybe just the channel logo). Looking for the scoreboard too.');
      }

      this.rect = rect;
      this.mask = Int32Array.from([]);
      this.tplLuma = new Float32Array(0);
      this.tplEdge = new Float32Array(0);
      this.addToMask(mask);
      this.learned = true;
      this.failReason = null;
      this.resetStats();
    }

    // Adds pixels (learned from the current stats) to the mask and rebuilds the regions.
    addToMask(pixels) {
      const n0 = this.mask.length;
      const mask = new Int32Array(n0 + pixels.length);
      mask.set(this.mask);
      mask.set(pixels, n0);
      const tplLuma = new Float32Array(mask.length), tplEdge = new Float32Array(mask.length);
      tplLuma.set(this.tplLuma);
      tplEdge.set(this.tplEdge);
      for (let k = n0; k < mask.length; k++) {
        const i = mask[k];
        tplLuma[k] = this.stillLuma[i] / this.stillCount[i];
        tplEdge[k] = this.stillEdge[i] / this.stillCount[i];
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
      this.presence = null;
      this.hitCount = new Uint16Array(mask.length);
      this.pruneFrames = 0;
      this.pruneSum = 0;
    }

    prune(raw, hit) {
      if (raw < PRUNE_MIN_RAW) return;
      this.pruneFrames++;
      this.pruneSum += raw;
      for (let k = 0; k < hit.length; k++) this.hitCount[k] += hit[k];
      if (this.pruneFrames < PRUNE_FRAMES) return;
      const stale = this.pruneSum / this.pruneFrames < PRUNE_BELOW;
      const keep = [];
      if (stale) for (let k = 0; k < hit.length; k++) if (this.hitCount[k] >= PRUNE_HIT * this.pruneFrames) keep.push(k);
      if (stale && keep.length >= MIN_MASK && keep.length < this.mask.length) this.keepInMask(keep);
      else {
        this.hitCount.fill(0);
        this.pruneFrames = 0;
        this.pruneSum = 0;
      }
    }

    backgroundSearch() {
      if (this.bgPresSum / this.frames < BG_MIN_PRESENCE) return 0;
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
      const { w, stillCount, sharpCount } = this;
      const n = this.frames - 1;
      const cand = new Uint8Array(w * this.h);
      for (let y = rect.y0; y < rect.y1; y++) {
        for (let x = rect.x0; x < rect.x1; x++) {
          const i = y * w + x;
          if (stillCount[i] >= stillFrac * n && sharpCount[i] >= SHARP_FRAC * n) cand[i] = 1;
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
      for (let k = 0; k < mask.length; k++) {
        const i = mask[k];
        if (Math.abs(gray[i] - tplLuma[k]) < LUMA_TOL && edges[i] >= EDGE_KEEP * tplEdge[k]) {
          match++;
          hit[k] = 1;
        }
      }
      const raw = match / mask.length;
      for (const r of this.regions) {
        let m = 0;
        for (const k of r.ks) m += hit[k];
        const rr = m / r.ks.length;
        r.presence = r.presence == null ? rr : r.presence + PRESENCE_ALPHA * (rr - r.presence);
      }
      this.presenceRaw = raw;
      this.presence = this.presence == null ? raw : this.presence + PRESENCE_ALPHA * (raw - this.presence);
      this.prune(raw, hit);

      // Follow slow changes (e.g. lighting, score digits) while the overlay is clearly there.
      if (raw > 0.6) {
        for (let k = 0; k < mask.length; k++) {
          if (!hit[k]) continue;
          const i = mask[k];
          tplLuma[k] += ADAPT * (gray[i] - tplLuma[k]);
          tplEdge[k] += ADAPT * (edges[i] - tplEdge[k]);
        }
      }
    }
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
