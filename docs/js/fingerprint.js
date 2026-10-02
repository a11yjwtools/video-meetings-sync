// Landmark audio fingerprinting. Mirrors indexer/fingerprint.py exactly:
// if you change a parameter here, change it there too and rebuild the index.

export const PARAMS = {
  sr: 8000,
  nfft: 1024,
  hop: 128,
  fMin: 8,
  fMax: 480,
  peakNT: 12,
  peakNF: 12,
  block: 64,
  peaksPerBlock: 20,
  minMag: 0.01,
  fanOut: 5,
  dtMin: 2,
  dtMax: 63,
  dfMax: 100,
  tQ: 1,
};

const P = PARAMS;
const NB = P.fMax - P.fMin + 1;

// ---------------------------------------------------------------- FFT
const N = P.nfft;
const LOG2N = Math.log2(N);
const WIN = new Float64Array(N);
for (let i = 0; i < N; i++) WIN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
const COS = new Float64Array(N / 2);
const SIN = new Float64Array(N / 2);
for (let i = 0; i < N / 2; i++) {
  COS[i] = Math.cos((2 * Math.PI * i) / N);
  SIN[i] = -Math.sin((2 * Math.PI * i) / N);
}
const REV = new Uint32Array(N);
for (let i = 0; i < N; i++) {
  let r = 0;
  for (let b = 0; b < LOG2N; b++) r |= ((i >> b) & 1) << (LOG2N - 1 - b);
  REV[i] = r;
}
const re = new Float64Array(N);
const im = new Float64Array(N);

function fftMag(x, offset, out, outOffset) {
  for (let i = 0; i < N; i++) {
    re[REV[i]] = x[offset + i] * WIN[i];
    im[REV[i]] = 0;
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let k = 0; k < half; k++) {
        const c = COS[k * step], s = SIN[k * step];
        const a = start + k, b = a + half;
        const tr = re[b] * c - im[b] * s;
        const ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
  for (let f = 0; f < NB; f++) {
    const k = f + P.fMin;
    out[outOffset + f] = Math.hypot(re[k], im[k]);
  }
}

// ---------------------------------------------------------------- spectrogram
export function spectrogram(x) {
  if (x.length < N) return { frames: 0, mag: new Float64Array(0) };
  const frames = 1 + Math.floor((x.length - N) / P.hop);
  const mag = new Float64Array(frames * NB);
  for (let t = 0; t < frames; t++) fftMag(x, t * P.hop, mag, t * NB);
  return { frames, mag };
}

// ---------------------------------------------------------------- peaks
export function findPeaks({ frames, mag }, P = PARAMS) {
  if (!frames) return [];
  // separable max filter (edges behave like -Infinity padding, as in scipy)
  const tmp = new Float64Array(frames * NB);
  for (let t = 0; t < frames; t++) {
    const row = t * NB;
    for (let f = 0; f < NB; f++) {
      let m = -Infinity;
      const lo = Math.max(0, f - P.peakNF), hi = Math.min(NB - 1, f + P.peakNF);
      for (let g = lo; g <= hi; g++) if (mag[row + g] > m) m = mag[row + g];
      tmp[row + f] = m;
    }
  }
  const byBlock = new Map();
  for (let t = 0; t < frames; t++) {
    const lo = Math.max(0, t - P.peakNT), hi = Math.min(frames - 1, t + P.peakNT);
    for (let f = 0; f < NB; f++) {
      const v = mag[t * NB + f];
      if (v <= P.minMag) continue;
      let m = -Infinity;
      for (let u = lo; u <= hi; u++) if (tmp[u * NB + f] > m) m = tmp[u * NB + f];
      if (v === m) {
        const b = Math.floor(t / P.block);
        if (!byBlock.has(b)) byBlock.set(b, []);
        byBlock.get(b).push([t, f + P.fMin, v]);
      }
    }
  }
  const peaks = [];
  for (const list of byBlock.values()) {
    if (list.length > P.peaksPerBlock) {
      list.sort((a, b) => b[2] - a[2]);
      list.length = P.peaksPerBlock;
    }
    for (const [t, f, v] of list) peaks.push(P.keepValues ? [t, f, v] : [t, f]);
  }
  peaks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return peaks;
}

// ---------------------------------------------------------------- hashes
export function hashesFromPeaks(peaks, P = PARAMS) {
  const hashes = [], times = [];
  for (let i = 0; i < peaks.length; i++) {
    const [t1, f1] = peaks[i];
    let c = 0;
    for (let j = i + 1; j < peaks.length; j++) {
      const [t2, f2] = peaks[j];
      const dt = t2 - t1;
      if (dt < P.dtMin) continue;
      if (dt > P.dtMax) break;
      if (Math.abs(f2 - f1) > P.dfMax) continue;
      hashes.push(((f1 << 15) | (f2 << 6) | (dt >> P.tQ)) >>> 0);
      times.push(t1);
      if (++c >= P.fanOut) break;
    }
  }
  return { hashes, times };
}

export function fingerprint(x) {
  return hashesFromPeaks(findPeaks(spectrogram(x)));
}

/**
 * Listening side: pick out about 3x as many sound points from the room as the
 * library stores, so each stored point has more chances to be found in echoey,
 * noisy rooms (e.g. while everyone sings). Same hash format, so it matches the
 * same library; the library itself is unchanged.
 */
export const QUERY_PARAMS = { ...PARAMS, peaksPerBlock: 60, fanOut: 12 };
export function fingerprintQuery(x) {
  const Q = QUERY_PARAMS;
  return hashesFromPeaks(findPeaks(spectrogram(x), Q), Q);
}

/**
 * Both at once from one analysis: `normal` (same density as the library, used
 * for general recognition whose thresholds were tuned on it) and `dense`
 * (used for the song rules). The normal peaks are the strongest of the dense ones.
 */
export function fingerprintBoth(x) {
  const Q = QUERY_PARAMS;
  const densePeaks = findPeaks(spectrogram(x), { ...Q, keepValues: true });
  const byBlock = new Map();
  for (const p of densePeaks) {
    const b = Math.floor(p[0] / PARAMS.block);
    if (!byBlock.has(b)) byBlock.set(b, []);
    byBlock.get(b).push(p);
  }
  const normalPeaks = [];
  for (const list of byBlock.values()) {
    list.sort((a, c) => c[2] - a[2]);
    for (const p of list.slice(0, PARAMS.peaksPerBlock)) normalPeaks.push(p);
  }
  normalPeaks.sort((a, c) => a[0] - c[0] || a[1] - c[1]);
  const strip = (ps) => ps.map(([t, f]) => [t, f]);
  return {
    normal: hashesFromPeaks(strip(normalPeaks), PARAMS),
    dense: hashesFromPeaks(strip(densePeaks), Q),
  };
}

// ---------------------------------------------------------------- resampler
// Streaming low-pass + fractional decimation from the device rate to P.sr.
// Tracks exactly which input frame each output sample came from so the
// sync code can convert "sample k of the analysis stream" into audio-clock
// time.
export class Resampler {
  constructor(inRate, outRate = P.sr, taps = 63) {
    this.inRate = inRate;
    this.outRate = outRate;
    this.ratio = inRate / outRate;
    const cutoff = (0.45 * outRate) / inRate; // normalised (cycles/sample)
    const M = taps - 1;
    this.h = new Float64Array(taps);
    let sum = 0;
    for (let n = 0; n < taps; n++) {
      const x = n - M / 2;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / M) + 0.08 * Math.cos((4 * Math.PI * n) / M);
      this.h[n] = sinc * w;
      sum += this.h[n];
    }
    for (let n = 0; n < taps; n++) this.h[n] /= sum;
    this.delay = M / 2;              // group delay in input frames
    this.hist = new Float64Array(M); // previous raw input
    this.filtered = [];              // filtered samples not yet consumed
    this.filteredBase = 0;           // absolute index of filtered[0]
    this.outCount = 0;               // output samples produced so far
    this.startFrame = null;          // audio-clock frame of the first input sample
  }

  /** Feed raw input; returns Float32Array of new output samples. */
  push(input, frame) {
    if (this.startFrame === null) this.startFrame = frame;
    const M = this.hist.length;
    const buf = new Float64Array(M + input.length);
    buf.set(this.hist, 0);
    buf.set(input, M);
    const h = this.h;
    for (let i = 0; i < input.length; i++) {
      let acc = 0;
      for (let k = 0; k <= M; k++) acc += h[k] * buf[i + M - k];
      this.filtered.push(acc);
    }
    this.hist = buf.slice(buf.length - M);

    const out = [];
    const end = this.filteredBase + this.filtered.length;
    for (;;) {
      const pos = this.outCount * this.ratio;
      const i0 = Math.floor(pos);
      if (i0 + 1 >= end) break;
      const frac = pos - i0;
      const a = this.filtered[i0 - this.filteredBase];
      const b = this.filtered[i0 + 1 - this.filteredBase];
      out.push(a + (b - a) * frac);
      this.outCount++;
    }
    // Keep everything from the next output's position on, but never drop more than
    // we actually have: the next chunk continues exactly where this one ended.
    const drop = Math.min(Math.floor(this.outCount * this.ratio), end) - this.filteredBase;
    if (drop > 0) {
      this.filtered.splice(0, drop);
      this.filteredBase += drop;
    }
    return Float32Array.from(out);
  }

  /** Audio-clock time (seconds) at which output sample k was heard. */
  timeOfOutput(k) {
    return (this.startFrame + k * this.ratio - this.delay) / this.inRate;
  }
}
