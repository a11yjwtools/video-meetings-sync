// End-to-end check of the browser code in Node:
//   python tests/make_fixture.py
//   python indexer/build_index.py tests/fixtures/manifest.json --out tests/fixtures/data \
//          --auto-max-minutes 1.2 --coarse-budget-mb 0.02
//   node tests/roundtrip.mjs
// (songs go on the automatic list; the two longer "videos" are only on the
//  thinned-out coarse list, and share the same intro music)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Resampler, fingerprint, fingerprintBoth, StreamAnalyser, PARAMS } from "../docs/js/fingerprint.js";
import { Matcher, mapToAD } from "../docs/js/matcher.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const catalog = JSON.parse(readFileSync(join(dir, "data/catalog.json"), "utf8"));
const ab = (p) => { const b = readFileSync(join(dir, "data", p.split("?")[0])); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const matcher = Matcher.fromBuffers(catalog, catalog.files.auto.map((f) => ab(f.path)), catalog.files.coarse.map((f) => ab(f.path)));

const IN_SR = 48000;
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

/** Simulate a phone in a room: quieter, reverberant, noisy, 44.1 or 48 kHz chunks. */
function roomRecording(x, start, seconds, { gain = 0.2, noise = 0.03 } = {}) {
  const n = seconds * IN_SR, out = new Float32Array(n), s0 = start * IN_SR;
  for (let i = 0; i < n; i++) {
    let v = x[s0 + i] || 0;
    v += 0.5 * (x[s0 + i - 2400] || 0) + 0.3 * (x[s0 + i - 5300] || 0); // echoes
    out[i] = gain * v + noise * rand();
  }
  return out;
}

function run(name, x, start, expectVid, opts, onlyVid = null) {
  const rec = roomRecording(x, start, opts?.seconds ?? 15, opts);
  const rs = new Resampler(IN_SR);
  const frame0 = 123456; // arbitrary audio-clock frame of the first sample
  const chunks = [];
  for (let i = 0; i < rec.length; i += 2048) chunks.push(rs.push(rec.subarray(i, i + 2048), frame0 + i));
  const y = Float32Array.from(chunks.flatMap((c) => [...c]));
  const t0 = performance.now();
  const fp = fingerprint(y);
  let r = null;
  for (let attempt = 0; attempt < 3 && !r; attempt++) {
    const out = matcher.recognise(fp.hashes, fp.times, onlyVid);
    r = out.result;
    for (const v of out.needs) matcher.addVideoBuffer(v, ab(catalog.videos[v].fp)); // what the app downloads
  }
  if (!r) { console.log(`${expectVid ? "FAIL" : "PASS"} ${name}: no confident match`); return !expectVid; }
  const ms = (performance.now() - t0).toFixed(0);
  const origT = (r.offsetFrames * PARAMS.hop + y.length) / PARAMS.sr; // time of newest sample
  const ctxT = rs.timeOfOutput(y.length);
  const truth = start + (ctxT - frame0 / IN_SR);                       // true original time at that instant
  const v = matcher.videos[r.vid];
  const ok = expectVid ? v.id === expectVid && Math.abs(origT - truth) < 0.05 : false;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: got ${v.id} @ ${origT.toFixed(3)}s (truth ${truth.toFixed(3)}s, ` +
    `err ${((origT - truth) * 1000).toFixed(0)} ms) score ${r.score} vs ${r.second}, ` +
    `AD time ${mapToAD(v, origT).toFixed(2)}s, ${fp.hashes.length} hashes, ${ms} ms`);
  return ok;
}

const a = new Float32Array(readFileSync(join(dir, "song_a.f32")).buffer.slice(0));
const b = new Float32Array(readFileSync(join(dir, "song_b.f32")).buffer.slice(0));
let ok = true;
ok &= run("song A before AD insert", a, 5, "song_a");
ok &= run("song A after AD insert", a, 40, "song_a");
ok &= run("song B, noisy room", b, 22, "song_b", { gain: 0.1, noise: 0.05 });
ok &= run("song B, very quiet", b, 47, "song_b", { gain: 0.03, noise: 0.01 });
ok &= run("song B picked from the list", b, 30, "song_b", { gain: 0.1, noise: 0.05 }, 1);

const c = new Float32Array(readFileSync(join(dir, "video_c.f32")).buffer.slice(0));
const d = new Float32Array(readFileSync(join(dir, "video_d.f32")).buffer.slice(0));
// Shared intro: must NOT guess (either answer could be wrong)
ok &= run("video C during the shared intro (should wait)", c, 1, null, { seconds: 10 });
matcher.single.clear();
ok &= run("video C narration, not picked", c, 30, "video_c");
ok &= run("video D narration, not picked, noisy", d, 50, "video_d", { gain: 0.1, noise: 0.04 });
ok &= run("video C just after the intro", c, 8, "video_c");

/**
 * The listening loop reuses earlier analysis (StreamAnalyser). Replay it like the
 * engine does: microphone chunks through the resampler, a 15 s window on the frame
 * grid every half second, and check each result is identical to analysing the
 * window from scratch.
 */
function streamCheck() {
  const SR = PARAMS.sr, HOP = PARAMS.hop, WINDOW = SR * 15;
  const rec = roomRecording(b, 3, 40, { gain: 0.1, noise: 0.05 });
  const rs = new Resampler(IN_SR);
  const stream = new Float32Array(SR * 41);
  const analyser = new StreamAnalyser();
  let written = 0, nextCheck = SR * 3, windows = 0, same = 0, tFull = 0, tStream = 0;
  for (let i = 0; i < rec.length; i += 2048) {
    const out = rs.push(rec.subarray(i, i + 2048), i);
    stream.set(out, written);
    written += out.length;
    if (written < nextCheck) continue;
    nextCheck += SR / 2;
    const start = Math.ceil((written - Math.min(written, WINDOW)) / HOP) * HOP;
    const x = stream.slice(start, written);
    let t = performance.now();
    const full = fingerprintBoth(x);
    tFull += performance.now() - t;
    t = performance.now();
    const fast = analyser.fingerprintBoth(x, start);
    tStream += performance.now() - t;
    windows++;
    const eq = (p, q) => p.hashes.length === q.hashes.length && p.hashes.every((h, k) => h === q.hashes[k] && p.times[k] === q.times[k]);
    if (eq(full.normal, fast.normal) && eq(full.dense, fast.dense)) same++;
  }
  const pass = windows > 50 && same === windows;
  console.log(`${pass ? "PASS" : "FAIL"} listening loop reuses earlier analysis: ${same}/${windows} windows identical, ` +
    `${(tFull / windows).toFixed(1)} ms -> ${(tStream / windows).toFixed(1)} ms per analysis`);
  return pass;
}
ok &= streamCheck();
console.log(ok ? "\nall passed" : "\nSOME FAILED");
process.exit(ok ? 0 : 1);
