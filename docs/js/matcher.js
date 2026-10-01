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
  listMinScore: 6,     // tonight's songs: votes needed (only a few candidates)
  listRatio: 1.5,      // ...and how much the winner must beat the others
  songMinScore: 7,     // a song near its beginning, without a list
  songRatio: 1.6,
  songMaxStart: 30,    // "near its beginning": within this many seconds of the start…
  songLateStart: 12,   // …and no more than this much further in than we have been listening
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

/** Download a file, reporting bytes as they arrive (instant when the phone already has it). */
async function fetchBytes(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not download ${url.split("?")[0]}`);
  if (!res.body || !onBytes) return res.arrayBuffer();
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
    onBytes(value.length);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

export class Matcher {
  constructor(catalog, auto = [], coarse = [], baseUrl = "data/") {
    this.catalog = catalog;
    this.videos = catalog.videos;
    this.coarseK = catalog.coarseK || 1;
    this.auto = auto;        // pieces with full fingerprints of the shorter videos
    this.coarse = coarse;    // pieces with thinned fingerprints of all other videos
    this.single = new Map(); // vid -> full fingerprints of one video (loaded on demand)
    this.loading = new Map();
    this.baseUrl = baseUrl;
  }

  /**
   * Load the library. onProgress(done, total) reports bytes; files the phone
   * already keeps (see sw.js) arrive instantly.
   */
  static async load(baseUrl = "data/", onProgress = null) {
    const catRes = await fetch(baseUrl + "catalog.json", { cache: "no-cache" });
    if (!catRes.ok) throw new Error("the library has not been built yet");
    const catalog = await catRes.json();
    for (const [k, v] of Object.entries(PARAMS)) {
      if (catalog.params?.[k] !== v) {
        throw new Error(`library was built with ${k}=${catalog.params?.[k]}, app expects ${v}; rebuild the library`);
      }
    }
    const files = catalog.files || { auto: [{ path: "auto.bin" }], coarse: [{ path: "coarse.bin" }] };
    const all = [...files.auto, ...files.coarse];
    const total = all.reduce((n, f) => n + (f.bytes || 0), 0);
    let done = 0;
    const tick = (n) => { done += n; onProgress?.(Math.min(done, total), total); };
    onProgress?.(0, total);
    const load = (f) => fetchBytes(baseUrl + f.path, tick).then(parseIndex);
    const [auto, coarse] = await Promise.all([
      Promise.all(files.auto.map(load)),
      Promise.all(files.coarse.map((f) => load(f).catch(() => null))).then((xs) => xs.filter(Boolean)),
    ]);
    const m = new Matcher(catalog, auto, coarse, baseUrl);
    m.dataUrls = [baseUrl + "catalog.json", ...all.map((f) => baseUrl + f.path)];
    return m;
  }

  static fromBuffers(catalog, autoBufs, coarseBufs = []) {
    const list = (x) => (Array.isArray(x) ? x : x ? [x] : []).map(parseIndex);
    return new Matcher(catalog, list(autoBufs), list(coarseBufs));
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
  vote(pieces, hashes, times, onlyVid = null, keepK = 1, exclude = null) {
    const votes = new Map();
    for (const idx of Array.isArray(pieces) ? pieces : [pieces]) {
      this.votePiece(idx, votes, hashes, times, onlyVid, keepK, exclude);
    }
    return summarise(votes);
  }

  votePiece(idx, votes, hashes, times, onlyVid, keepK, exclude) {
    const H = idx.hashes, VAL = idx.values;
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
    const coarse = this.coarse.length
      ? this.vote(this.coarse, hashes, times, null, this.coarseK, exclude)
      : null;

    // Shortlist: best videos from both lists (coarse scores are thinned, so scale them up).
    const cand = new Map();
    for (const [vid, b] of auto?.perVideo || []) cand.set(vid, b.score);
    for (const [vid, b] of coarse?.perVideo || []) {
      const s = b.score;
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

// How jw.org labels meeting songs, most reliable first (must match set_songs.py):
const SONG_RULES = [
  ["id", /(?:^|[-_])sjj[a-z]*_(\d{1,3})(?:_|$)/i],                // code like pub-sjjm_79_VIDEO
  ["title", /\bsong\s*(?:no\.?\s*)?(\d{1,3})\b/i],                // "Song 79", "Song No. 79"
  ["title", /^\s*(\d{1,3})(?=\s*[.:\-\u2013\u2014]?\s+[^\d\s])/],      // "79 Teach Them…"
];
const NOT_SONG = /^\s*\d+\s+(minutes?|ways?|things?|reasons?|days?|years?|tips?|steps?|questions?|lessons?|keys?|secrets?)\b/i;

/** Song number and how sure we are (0 = code, 1 = "Song N", 2 = number at the start). */
Matcher.prototype.songInfo = function (vid) {
  const v = this.videos[vid];
  if (v._song === undefined) {
    v._song = null;
    v._songRank = null;
    for (let rank = 0; rank < SONG_RULES.length; rank++) {
      const [field, rx] = SONG_RULES[rank];
      if (rank === 2 && NOT_SONG.test(v.title || "")) continue;
      const m = String(v[field] || "").match(rx);
      if (m && Number(m[1]) >= 1 && Number(m[1]) <= 200) { v._song = Number(m[1]); v._songRank = rank; break; }
    }
  }
  return { n: v._song, rank: v._songRank };
};

/** The meeting-song number of a video, or null, if it is the surest video for that number. */
Matcher.prototype.songNumber = function (vid) {
  const { n } = this.songInfo(vid);
  if (n === null) return null;
  if (!this._songOwner) {
    this._songOwner = new Map(); // number -> vid with the surest label
    for (let i = 0; i < this.videos.length; i++) {
      const s = this.songInfo(i);
      if (s.n === null) continue;
      const cur = this._songOwner.get(s.n);
      if (cur === undefined || s.rank < this.songInfo(cur).rank) this._songOwner.set(s.n, i);
    }
  }
  return this._songOwner.get(n) === vid ? n : null;
};

/**
 * Best SONG on the automatic list for these (dense) fingerprints, with its
 * strongest rival among all other videos there.
 */
Matcher.prototype.songGuess = function (hashes, times, exclude = null) {
  const auto = this.vote(this.auto, hashes, times, null, 1, exclude);
  if (!auto) return null;
  let g = null;
  for (const [vid, b] of auto.perVideo) {
    if (this.songNumber(vid) && (!g || b.score > g.score)) g = { vid, ...b };
  }
  if (!g) return null;
  let rival = 0;
  for (const [vid, b] of auto.perVideo) if (vid !== g.vid) rival = Math.max(rival, b.score);
  // the song's own best wrong position counts as a rival too
  if (auto.vid === g.vid) rival = Math.max(rival, auto.second);
  return { ...g, rival };
};

/** Videos whose title is "Song <n>…", by song number. */
Matcher.prototype.findSongs = function (numbers) {
  const out = new Map();
  for (let vid = 0; vid < this.videos.length; vid++) {
    const n = this.songNumber(vid);
    if (n !== null && numbers.includes(n)) out.set(n, vid);
  }
  return out;
};

/**
 * Check a short list of videos (tonight's songs) in full detail. With only a
 * few candidates, much less evidence is needed: the winner must beat the
 * other listed songs and its own best wrong position.
 */
Matcher.prototype.checkList = function (hashes, times, vids, exclude = null) {
  const R = RECOGNITION;
  const res = [];
  for (const vid of vids) {
    const idx = this.single.get(vid);
    if (!idx) continue;
    const r = this.vote(idx, hashes, times, vid, 1, exclude);
    if (r) res.push(r);
  }
  res.sort((a, b) => b.score - a.score);
  const [w, other] = res;
  if (!w) return null;
  const rival = Math.max(w.second, other ? other.score : 0);
  return w.score >= R.listMinScore && w.score >= R.listRatio * rival ? w : null;
};

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
    if (s > (perVideo.get(vid)?.score || 0)) perVideo.set(vid, { score: s, offsetFrames: (key % VID_MUL) - OFF_BIAS });
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
