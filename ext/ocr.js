// On-screen text: learns the team abbreviations from the scoreboard, then looks for them
// (and football/soccer words) while the scoreboard is gone. Finding them means a replay,
// stats graphic, interview or halftime show, not a commercial.
// Uses Tesseract.js (bundled, runs locally in a worker).

(function (root) {
  // Words that show up in broadcast graphics but rarely in commercials.
  const KEYWORDS = new Set([
    'HALFTIME', 'QUARTER', 'QTR', 'TOUCHDOWN', 'YARDS', 'YDS', 'RUSHING', 'PASSING', 'RECEIVING',
    'TACKLES', 'SACKS', 'POSSESSION', 'TIMEOUTS', 'TIMEOUT', 'KICKOFF', 'PREGAME',
    'POSTGAME', 'STATS', 'LEADERS', 'COMP', 'FUMBLE', 'INTERCEPTION', 'PENALTY', 'REPLAY',
    'REVIEW', 'CHALLENGE', 'GOAL', 'SHOTS', 'CORNERS', 'FOULS', 'OFFSIDE', 'SAVES',
  ]);
  // Tokens from the scoreboard that are not team names (network names appear in promos during ads).
  const NOT_TEAMS = new Set([
    'QTR', 'ST', 'ND', 'RD', 'TH', 'OT', 'DOWN', 'AND', 'TO', 'GO', 'FLAG', 'TIMEOUT', 'HALF', 'END',
    'FOX', 'CBS', 'NBC', 'ABC', 'ESPN', 'FS', 'FSI', 'BTN', 'SEC', 'ACC', 'NFL', 'TV', 'HD', 'LIVE',
    'CW', 'TNT', 'TBS', 'PRIME', 'PEACOCK', 'NET', 'THE', 'YDS', 'REPLAY', 'REVIEW',
  ]);
  const HIT_TTL_MS = 12000;
  const MIN_CONF_TEAM = 80; // Tesseract word confidence for scoreboard tokens
  const MIN_CONF_SCAN = 70; // ...and for words found while the scoreboard is gone
  const TEAM_MIN_READS = 4;
  const TEAM_MIN_SHARE = 0.5; // a team token must appear in at least half the scoreboard reads

  class OcrReader {
    constructor() {
      this.ready = false;
      this.error = null;
      this.busy = false;
      this.reset();
    }

    reset() {
      this.tokenCounts = new Map();
      this.reads = 0;
      this.lastHit = 0;
      this.lastHitWords = [];
      this.lastText = '';
    }

    async load() {
      try {
        const url = (p) => chrome.runtime.getURL(p);
        this.worker = await Tesseract.createWorker('eng', 1, {
          workerPath: url('vendor/tesseract/worker.min.js'),
          corePath: url('vendor/tesseract/'),
          langPath: url('vendor/tesseract/lang'),
          workerBlobURL: false,
          gzip: true,
          cacheMethod: 'none',
        });
        this.ready = true;
      } catch (err) {
        this.error = String(err && err.message ? err.message : err);
        throw err;
      }
    }

    get teams() {
      if (this.reads < TEAM_MIN_READS) return [];
      return [...this.tokenCounts.entries()]
        .filter(([, n]) => n / this.reads >= TEAM_MIN_SHARE)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([t]) => t);
    }

    hitActive(now) {
      return now - this.lastHit < HIT_TTL_MS;
    }

    // Full text plus the uppercase words Tesseract is at least minConf sure about.
    async read(blob, minConf) {
      const { data } = await this.worker.recognize(blob, {}, { text: true, blocks: true });
      const words = (data.blocks || [])
        .flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)))
        .filter((w) => w.confidence >= minConf)
        .map((w) => w.text.toUpperCase().replace(/[^A-Z]/g, ''))
        .filter((w) => w.length >= 2);
      return { text: (data.text || '').toUpperCase(), words: new Set(words) };
    }

    // Scoreboard crop: collect candidate team abbreviations.
    async learnFromScoreboard(blob) {
      if (!this.ready || this.busy) return;
      this.busy = true;
      try {
        const { words } = await this.read(blob, MIN_CONF_TEAM);
        this.reads++;
        for (const tok of words) {
          if (tok.length > 5 || NOT_TEAMS.has(tok)) continue;
          this.tokenCounts.set(tok, (this.tokenCounts.get(tok) || 0) + 1);
        }
      } finally {
        this.busy = false;
      }
    }

    // Full video area while the scoreboard is gone: any team name or keyword?
    async scan(blob, now) {
      if (!this.ready || this.busy) return;
      this.busy = true;
      try {
        const { text, words } = await this.read(blob, MIN_CONF_SCAN);
        this.lastText = text.replace(/\s+/g, ' ').trim().slice(0, 200);
        const teams = new Set(this.teams);
        const hits = [...words].filter((w) => teams.has(w) || KEYWORDS.has(w));
        if (hits.length) {
          this.lastHit = now;
          this.lastHitWords = hits.slice(0, 5);
        }
      } finally {
        this.busy = false;
      }
    }
  }

  root.OcrReader = OcrReader;
})(typeof self !== 'undefined' ? self : globalThis);
