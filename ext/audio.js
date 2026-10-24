// Audio side: resampling to 16 kHz mono and YAMNet sound classification (521 AudioSet classes).

(function (root) {
  // Keeps the most recent `capacity` samples, resampled from `fromRate` to `toRate`.
  class Resampler {
    constructor(fromRate, toRate, capacity) {
      this.step = fromRate / toRate;
      this.pos = 0; // fractional read position into the pending input
      this.carry = null; // last input sample of the previous block
      this.ring = new Float32Array(capacity);
      this.filled = 0;
      this.head = 0;
    }

    push(block) {
      // Linear interpolation; YAMNet only looks at up to 8 kHz so no fancy filtering is needed
      // beyond the averaging done by the step.
      const src = this.carry == null ? block : prepend(this.carry, block);
      let p = this.pos;
      while (p + 1 < src.length) {
        const i = Math.floor(p);
        const f = p - i;
        this.write(src[i] * (1 - f) + src[i + 1] * f);
        p += this.step;
      }
      this.pos = p - (src.length - 1);
      this.carry = src[src.length - 1];
    }

    write(v) {
      this.ring[this.head] = v;
      this.head = (this.head + 1) % this.ring.length;
      if (this.filled < this.ring.length) this.filled++;
    }

    latest() {
      const out = new Float32Array(this.filled);
      const start = (this.head - this.filled + this.ring.length) % this.ring.length;
      for (let k = 0; k < this.filled; k++) out[k] = this.ring[(start + k) % this.ring.length];
      return out;
    }
  }

  function prepend(v, block) {
    const out = new Float32Array(block.length + 1);
    out[0] = v;
    out.set(block, 1);
    return out;
  }

  const GROUPS = {
    crowd: ['Crowd', 'Cheering', 'Applause', 'Hubbub, speech noise, speech babble'],
    music: ['Music'],
    speech: ['Speech'],
  };

  const BACKENDS = ['webgl', 'cpu'];

  class AudioClassifier {
    constructor() {
      this.ready = false;
      this.error = null; // string, last load/classify failure
      this.backend = null;
      this.attempts = []; // per-backend outcome, shown in the debug panel
    }

    // Tries each backend with a real warm-up classification; offscreen documents may report
    // WebGL as available and then fail on the first op.
    async load(skip = []) {
      this.ready = false;
      const base = typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.getURL('model/') : 'model/';
      try {
        const csv = await fetch(base + 'yamnet_class_map.csv').then((r) => r.text());
        this.names = parseClassMap(csv);
        this.groups = {};
        for (const [g, names] of Object.entries(GROUPS)) {
          this.groups[g] = names.map((n) => this.names.indexOf(n)).filter((i) => i >= 0);
        }
      } catch (err) {
        this.error = `class map: ${err && err.message ? err.message : err}`;
        throw new Error(this.error);
      }

      for (const backend of BACKENDS.filter((b) => !skip.includes(b))) {
        try {
          if (!(await tf.setBackend(backend))) throw new Error('backend not available');
          await tf.ready();
          if (this.model) this.model.dispose();
          this.model = await tf.loadGraphModel(base + 'model.json');
          await this.classify(new Float32Array(15600));
          this.backend = backend;
          this.ready = true;
          this.error = null;
          this.attempts.push(`${backend}: ok`);
          return;
        } catch (err) {
          this.attempts.push(`${backend}: ${err && err.message ? err.message : err}`);
        }
      }
      this.error = this.attempts.join(' | ');
      throw new Error(this.error);
    }

    // samples: Float32Array, 16 kHz mono in [-1, 1].
    // Returns group scores, top classes and the mean 1024-d embedding.
    async classify(samples) {
      const [scores, embedding] = tf.tidy(() => {
        const out = this.model.predict(tf.tensor1d(samples));
        const outs = Array.isArray(out) ? out : [out];
        const last = (t) => t.shape[t.shape.length - 1];
        // average over YAMNet's 0.48 s frames
        return [outs.find((t) => last(t) === 521).mean(0), outs.find((t) => last(t) === 1024).mean(0)];
      });
      const [arr, emb] = await Promise.all([scores.data(), embedding.data()]);
      scores.dispose();
      embedding.dispose();

      const group = (g) => Math.max(0, ...this.groups[g].map((i) => arr[i]));
      const top = Array.from(arr)
        .map((p, i) => [this.names[i], p])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, p]) => ({ name, p: Math.round(p * 1000) / 1000 }));
      return { crowd: group('crowd'), music: group('music'), speech: group('speech'), top, embedding: emb };
    }
  }

  function parseClassMap(csv) {
    // index,mid,display_name   (display_name may be quoted and contain commas)
    return csv
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((line) => {
        const m = line.match(/^\d+,[^,]*,(.*)$/);
        return m ? m[1].replace(/^"(.*)"$/, '$1') : '';
      });
  }

  root.Resampler = Resampler;
  root.AudioClassifier = AudioClassifier;
  if (typeof module !== 'undefined') module.exports = { Resampler, parseClassMap };
})(typeof self !== 'undefined' ? self : globalThis);
