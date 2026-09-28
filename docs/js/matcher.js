import { PARAMS } from "./fingerprint.js";

const OFF_BIAS = 1 << 21;
const VID_MUL = 1 << 22;
const MAX_HITS_PER_HASH = 250; // very common hashes carry no information
const MAX_LOADED = 40;         // per-video files kept in memory

export const RECOGNITION = {
  minScore: 10,        // votes needed to trust a match
  minRatio: 1.6,       // how much the winner must beat the runner-up
  shortlist: 4,        // candidates checked in full per attempt
  shortlistMin: 3,     // votes a candidate needs to be worth checking
};

/** Deterministic 1-in-k subsample (must match coarse_keep in build_index.py). */
export function coarseKeep(h, k) {
  if (k <= 1) return true;
  return (Math.imul(h, 2654435761) >>> 0) % k === 0;
}

function parseIndex(buf) {
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic !== "JWAD") throw new Error("not a JWAD fingerprint file");
  const count = new DataView(buf).getUint32(8, true);
  return {
    hashes: new Uint32Array(buf, 16, count),
    values: new Uint32Array(buf, 16 + count * 4, count),
  };
}

const EMPTY = { hashes: new Uint32Array(0), values: new Uint32Array(0) };

export class Matcher {
  constructor(catalog, auto, coarse = EMPTY, baseUrl = "data/") {
    this.catalog = catalog;
    this.videos = catalog.videos;
    this.coarseK = catalog.coarseK || 1;
    this.auto = auto;        // full fingerprints of the shorter videos
    this.coarse = coarse;    // thinned fingerprints of all other videos
    this.single = new Map(); // vid -> full fingerprints of one video (loaded on demand)
    this.loading = new Map();
    this.baseUrl = baseUrl;
  }

  static async load(baseUrl = "data/") {
    const catRes = await fetch(baseUrl + "catalog.json");
    if (!catRes.ok) throw new Error("the library has not been built yet");
    const catalog = await catRes.json();
    for (const [k, v] of Object.entries(PARAMS)) {
      if (catalog.params?.[k] !== v) {
        throw new Error(`library was built with ${k}=${catalog.params?.[k]}, app expects ${v}; rebuild the library`);
      }
    }
    const [autoRes, coarseRes] = await Promise.all([fetch(baseUrl + "auto.bin"), fetch(baseUrl + "coarse.bin")]);
    if (!autoRes.ok) throw new Error("auto.bin is missing; rebuild the library");
    const auto = parseIndex(await autoRes.arrayBuffer());
    const coarse = coarseRes.ok ? parseIndex(await coarseRes.arrayBuffer()) : EMPTY;
    return new Matcher(catalog, auto, coarse, baseUrl);
  }

  static fromBuffers(catalog, autoBuf, coarseBuf = null) {
    return new Matcher(catalog, parseIndex(autoBuf), coarseBuf ? parseIndex(coarseBuf) : EMPTY);
  }

  /** Download the full fingerprints of one video (cached; safe to call repeatedly). */
  loadVideo(vid) {
    if (this.single.has(vid)) return Promise.resolve();
    if (this.loading.has(vid)) return this.loading.get(vid);
    const p = fetch(this.baseUrl + this.videos[vid].fp)
      .then((res) => {
        if (!res.ok) throw new Error(`could not load fingerprints for ${this.videos[vid].title}`);
        return res.arrayBuffer();
      })
      .then((buf) => this.addVideoBuffer(vid, buf))
      .finally(() => this.loading.delete(vid));
    this.loading.set(vid, p);
    return p;
  }

  addVideoBuffer(vid, buf) {
    this.single.delete(vid);
    this.single.set(vid, parseIndex(buf)); // newest last
    while (this.single.size > MAX_LOADED) {
      this.single.delete(this.single.keys().next().value); // forget the oldest
    }
  }

  /** Keep a loaded video from being forgotten (e.g. the one playing). */
  touch(vid) {
    const idx = this.single.get(vid);
    if (idx) { this.single.delete(vid); this.single.set(vid, idx); }
  }

  // ------------------------------------------------------------ voting
  vote(idx, hashes, times, onlyVid = null, keepK = 1, exclude = null) {
    const H = idx.hashes, VAL = idx.values;
    const votes = new Map();
    for (let i = 0; i < hashes.length; i++) {
      const h = hashes[i];
      if (keepK > 1 && !coarseKeep(h, keepK)) continue;
      let lo = 0, hi = H.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (H[mid] < h) lo = mid + 1; else hi = mid;
      }
      let j = lo;
      while (j < H.length && H[j] === h) j++;
      if (j - lo > MAX_HITS_PER_HASH) continue;
      for (let k = lo; k < j; k++) {
        const v = VAL[k];
        const vid = v >>> 20;
        if (onlyVid !== null && vid !== onlyVid) continue;
        const t = v & 0xfffff;
        if (exclude && vid === exclude.vid && t >= exclude.fromFrame) continue;
        const key = vid * VID_MUL + (t - times[i]) + OFF_BIAS;
        votes.set(key, (votes.get(key) || 0) + 1);
      }
    }
    return summarise(votes);
  }

  /** Match against one index: the picked video's own file if loaded, else the automatic list. */
  query(hashes, times, onlyVid = null, exclude = null) {
    const idx = (onlyVid !== null && this.single.get(onlyVid)) || this.auto;
    return this.vote(idx, hashes, times, onlyVid, 1, exclude);
  }

  /**
   * Full recognition across the whole library:
   *   1. try the automatic list (short videos, full detail);
   *   2. shortlist likely videos from it and from the coarse list of all others;
   *   3. check each shortlisted video against its own full file, and accept a
   *      winner only if it clearly beats every other candidate.
   * Returns { result, needs } where result is a confident match or null, and
   * needs lists videos whose files should be downloaded for the next attempt.
   * exclude = { vid, fromFrame } ignores the end of a video that just finished.
   */
  recognise(hashes, times, onlyVid = null, exclude = null) {
    const R = RECOGNITION;
    if (onlyVid !== null) {
      const r = this.query(hashes, times, onlyVid, exclude);
      return { result: r && confident(r) ? r : null, needs: this.single.has(onlyVid) ? [] : [onlyVid] };
    }

    const auto = this.vote(this.auto, hashes, times, null, 1, exclude);
    const coarse = this.coarse.hashes.length
      ? this.vote(this.coarse, hashes, times, null, this.coarseK, exclude)
      : null;

    // Shortlist: best videos from both lists (coarse scores are thinned, so scale them up).
    const cand = new Map();
    for (const [vid, s] of auto?.perVideo || []) cand.set(vid, s);
    for (const [vid, s] of coarse?.perVideo || []) {
      const scaled = s * this.coarseK;
      if (s >= R.shortlistMin || scaled >= R.minScore) cand.set(vid, Math.max(cand.get(vid) || 0, scaled));
    }
    const shortlist = [...cand.entries()]
      .filter(([vid, s]) => s >= R.shortlistMin || this.single.has(vid))
      .sort((a, b) => b[1] - a[1])
      .slice(0, R.shortlist)
      .map(([vid]) => vid);

    // A clear automatic winner with no serious rival needs no further checks.
    if (auto && confident(auto) && !(coarse && coarse.best && coarse.best.score * this.coarseK >= auto.score / R.minRatio)) {
      return { result: auto, needs: this.single.has(auto.vid) ? [] : [auto.vid] };
    }

    // Verify each shortlisted video in full detail.
    const needs = [];
    const verified = [];
    for (const vid of shortlist) {
      if (!this.single.has(vid)) { needs.push(vid); continue; }
      const r = this.vote(this.single.get(vid), hashes, times, vid, 1, exclude);
      if (r) verified.push(r);
    }
    verified.sort((a, b) => b.score - a.score);
    const [win, runner] = verified;
    if (win && confident(win) && (!runner || win.score >= R.minRatio * runner.score)) {
      // the winner must also beat any shortlisted video we couldn't check yet
      const unchecked = needs.length && Math.max(...needs.map((v) => cand.get(v) || 0));
      if (!unchecked || win.score >= R.minRatio * unchecked) return { result: win, needs };
    }
    return { result: null, needs };
  }
}

function confident(r) {
  return r.score >= RECOGNITION.minScore && r.score >= RECOGNITION.minRatio * r.second;
}

/** Turn raw votes into the best (video, offset), the runner-up and per-video bests. */
function summarise(votes) {
  if (!votes.size) return null;
  const score = (key) => (votes.get(key) || 0) + (votes.get(key - 1) || 0) + (votes.get(key + 1) || 0);
  let best = null, bestScore = 0, bestRank = 0;
  const perVideo = new Map();
  for (const [key, c] of votes) {
    const s = score(key);
    const rank = 4 * s + c; // tie-break toward the bin with the most direct votes
    if (rank > bestRank) { bestRank = rank; bestScore = s; best = key; }
    const vid = Math.floor(key / VID_MUL);
    if (s > (perVideo.get(vid) || 0)) perVideo.set(vid, s);
  }
  let second = 0;
  for (const key of votes.keys()) {
    if (Math.abs(key - best) <= 3) continue;
    const s = score(key);
    if (s > second) second = s;
  }
  const vid = Math.floor(best / VID_MUL);
  return {
    vid,
    offsetFrames: (best % VID_MUL) - OFF_BIAS,
    score: bestScore,
    second,
    perVideo,
    best: { vid, score: bestScore },
    /** best-supported offset within +/- radius frames of a hypothesis */
    bestNear: (v, offsetFrames, radius = 4) => {
      let bestOff = offsetFrames, bestS = -1, bestR = -1;
      for (let o = offsetFrames - radius; o <= offsetFrames + radius; o++) {
        const key = v * VID_MUL + o + OFF_BIAS;
        const s = score(key), rank = 4 * s + (votes.get(key) || 0);
        if (rank > bestR) { bestR = rank; bestS = s; bestOff = o; }
      }
      return { offsetFrames: bestOff, score: bestS };
    },
  };
}

/** Original time (s) -> audio-description time (s), using the aligned segments. */
export function mapToAD(video, t) {
  const segs = video.map;
  if (!segs?.length) return t;
  let d = segs[0].d;
  for (const s of segs) {
    if (s.o0 <= t) d = s.d; else break;
  }
  return t + d;
}
