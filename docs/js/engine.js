import { PARAMS, Resampler, fingerprint } from "./fingerprint.js";
import { mapToAD, RECOGNITION } from "./matcher.js";

const SR = PARAMS.sr;
const HOP = PARAMS.hop;

export const TUNING = {
  windowSec: 15,        // audio analysed per attempt
  minWindowSec: 4,      // start trying once we have this much
  analyseEveryMs: 1000,
  keepScore: 6,         // votes needed to confirm an existing lock
  confirmations: 2,     // consecutive agreeing matches before starting playback
  lostAfterSec: 15,     // no confirmation for this long -> pause and listen again
  leadMs: 60,           // play the description this much earlier, always (on top of the Timing control)
  bluetoothMs: 150,     // standard Bluetooth headphone delay (AirPods ~80-180 ms, typical A2DP 150-200 ms)
  playbackQuality: 1,   // 0 = lowest quality video, 1 = next one up, …
  micOffWhenSynced: true, // once in sync, switch the mic off and play to the end
  stableConfirmations: 3, // ...after this many confirmations in a row
  stableErr: 0.06,      // ...each within this many seconds
  correctEveryMs: 100,
  seekThreshold: 0.4,   // seconds of error that trigger a hard seek
  deadband: 0.04,       // seconds of error we ignore
  maxRateChange: 0.03,  // playbackRate stays within 1 +/- this (small = no audible artefacts)
  rateGain: 0.5,        // how strongly speed reacts to the error
  minRateStep: 0.005,   // ignore speed changes smaller than this
  errSamples: 5,        // readings the median is taken over
  settleMs: 1500,       // after a seek/stall, wait this long before correcting
};

/** A tiny silent WAV, used to unlock media playback inside the Start tap. */
function silentWavUrl() {
  const n = 800, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

export class Engine extends EventTarget {
  constructor(matcher, video, options = {}) {
    super();
    this.matcher = matcher;
    this.video = video;
    this.opts = { offsetMs: 0, onlyVid: null, bluetooth: false, ...options };
    this.state = "idle";
    this.ring = new Float32Array(SR * (TUNING.windowSec + 2));
    this.written = 0; // total analysis samples received
    this.anchor = null;
    this.candidate = null;
    this.lastConfirm = 0;
    this.seekLead = 0.25;
    this.listenStarted = 0;
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setState(state, message) {
    this.state = state;
    this.emit("state", { state, message, video: this.current });
  }

  get current() {
    return this.anchor ? this.matcher.videos[this.anchor.vid] : null;
  }

  // ------------------------------------------------------------ start / stop
  /** Must be called from a user gesture (tap/click). */
  async start() {
    // Tiny speed changes are done by plain resampling (a barely noticeable pitch
    // change) instead of pitch-preserving time-stretching, which can sound choppy.
    const media = this.video;
    media.preservesPitch = media.mozPreservesPitch = media.webkitPreservesPitch = false;
    media.preload = "auto";
    media.addEventListener("waiting", () => { this.errs = []; });
    media.addEventListener("playing", () => { this.holdUntil = performance.now() + TUNING.settleMs; });
    // Unlock playback on iOS/Safari while we are still inside the gesture.
    this.video.src = silentWavUrl();
    this.video.play().then(() => this.video.pause()).catch(() => {});

    this.ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx.resume();
    await this.ctx.audioWorklet.addModule(new URL("./mic-worklet.js", import.meta.url));
    this.tap = new AudioWorkletNode(this.ctx, "mic-tap");
    const sink = this.ctx.createGain();
    sink.gain.value = 0; // keeps the graph running without playing the mic
    this.tap.connect(sink).connect(this.ctx.destination);
    this.tap.port.onmessage = (e) => this.onAudio(e.data);
    await this.micOn();

    try { this.wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* optional */ }

    this.analyseTimer = setInterval(() => this.analyse(), TUNING.analyseEveryMs);
    this.correctTimer = setInterval(() => this.correct(), TUNING.correctEveryMs);
    this.video.addEventListener("ended", this.onEnded = () => {
      this.finished = { vid: this.anchor?.vid, at: performance.now() };
      this.backToListening("Video finished. Listening for the next one…");
    });
    const v = this.opts.onlyVid;
    this.backToListening(v === null ? "Listening…" : `Listening for ${this.matcher.videos[v].title}…`);
  }

  async stop() {
    clearInterval(this.analyseTimer);
    clearInterval(this.correctTimer);
    this.video.pause();
    this.video.removeEventListener("ended", this.onEnded);
    this.micOff();
    await this.ctx?.close();
    this.wakeLock?.release?.();
    this.anchor = null;
    this.setState("idle", "Stopped.");
  }

  /** Switch the microphone on (again). Permission is only asked the first time. */
  async micOn() {
    if (this.micActive || this.micStarting) return;
    this.micStarting = true;
    try {
      this.stream = await this.openMic();
      if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
      this.src = this.ctx.createMediaStreamSource(this.stream);
      this.src.connect(this.tap);
      this.resampler = new Resampler(this.ctx.sampleRate);
      this.written = 0;
      this.micActive = true;
      this.emit("mic", { on: true });
    } finally {
      this.micStarting = false;
    }
  }

  /**
   * Open the microphone. With Bluetooth headphones the system may pick their
   * microphone, which switches them into "phone call" mode (worse sound, more
   * delay), so we ask for the phone's own microphone instead when we can tell.
   */
  async openMic() {
    const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
    const headsetMic = /airpods|bluetooth|headset|hands-?free|buds|beats|wireless/i;
    if (this.preferredMicId) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: this.preferredMicId } } });
      } catch { this.preferredMicId = null; } // that mic is gone; fall back to the default
    }
    let stream = await navigator.mediaDevices.getUserMedia({ audio: base });
    try {
      const label = stream.getAudioTracks()[0]?.label || "";
      if (headsetMic.test(label)) {
        const mics = (await navigator.mediaDevices.enumerateDevices())
          .filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default" && !headsetMic.test(d.label));
        if (mics.length) {
          stream.getTracks().forEach((t) => t.stop());
          stream = await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: mics[0].deviceId } } });
          this.preferredMicId = mics[0].deviceId;
        }
      }
    } catch { /* keep whatever microphone we got */ }
    return stream;
  }

  /** Switch the microphone off completely (the system's mic indicator goes out). */
  micOff() {
    this.src?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.src = this.stream = null;
    this.micActive = false;
    this.emit("level", { rms: 0 });
    this.emit("mic", { on: false });
  }

  backToListening(message) {
    this.video.pause();
    this.video.playbackRate = 1;
    this.errs = [];
    this.anchor = null;
    this.candidate = null;
    this.stable = 0;
    this.listenStarted = performance.now();
    this.setState("listening", message);
    if (!this.micActive) {
      this.micOn().catch((err) => this.emit("error", { message: "Could not switch the microphone back on. Tap Stop, then Start listening.", err }));
    }
  }

  // ------------------------------------------------------------ audio in
  onAudio({ samples, frame }) {
    if (!this.micActive) return;
    let level = 0;
    for (let i = 0; i < samples.length; i++) level += samples[i] * samples[i];
    this.emit("level", { rms: Math.sqrt(level / samples.length) });

    const out = this.resampler.push(samples, frame);
    for (let i = 0; i < out.length; i++) {
      this.ring[(this.written + i) % this.ring.length] = out[i];
    }
    this.written += out.length;
  }

  window() {
    const len = Math.min(this.written, SR * TUNING.windowSec);
    const start = this.written - len;
    const x = new Float32Array(len);
    for (let i = 0; i < len; i++) x[i] = this.ring[(start + i) % this.ring.length];
    return { x, start };
  }

  // ------------------------------------------------------------ recognition
  /** Download fingerprint files the recogniser asked for (in the background). */
  fetchNeeded(needs) {
    this.failed ??= new Map();
    const now = performance.now();
    for (const vid of needs) {
      if ((this.failed.get(vid) || 0) > now) continue;
      this.matcher.loadVideo(vid).catch(() => this.failed.set(vid, now + 60000));
    }
  }

  analyse() {
    if (this.state === "idle" || this.locking || !this.micActive || this.written < SR * TUNING.minWindowSec) return;
    const { x, start } = this.window();
    const fp = fingerprint(x);
    const endSample = start + x.length;
    const ctxEnd = this.resampler.timeOfOutput(endSample);
    // original time (s) of the newest analysed sample, for a given offset
    const origAtEnd = (off) => (off * HOP + x.length) / SR;

    if (this.state === "playing") {
      const a = this.anchor;
      this.matcher.touch(a.vid);
      const predicted = a.origT + (ctxEnd - a.ctxT);
      const expOff = Math.round((predicted * SR - x.length) / HOP);
      const rv = this.matcher.query(fp.hashes, fp.times, a.vid); // this video's own full file
      const near = rv ? rv.bestNear(a.vid, expOff) : null;
      if (near && near.score >= TUNING.keepScore) {
        // Still the same video at the expected place: refine the anchor.
        this.anchor = { vid: a.vid, origT: origAtEnd(near.offsetFrames), ctxT: ctxEnd };
        this.lastConfirm = performance.now();
        this.candidate = null;
        this.emit("confirm", { score: near.score, position: this.anchor.origT });
        if (Math.abs(this.lastErr ?? 1) < TUNING.stableErr) this.stable = (this.stable || 0) + 1;
        if (TUNING.micOffWhenSynced && this.stable >= TUNING.stableConfirmations) {
          this.micOff();
          this.setState("playing", `Playing: ${this.matcher.videos[a.vid].title}. In sync — microphone off until it ends.`);
        }
        return;
      }
      // Same video but somewhere else (the room skipped ahead or back)?
      if (rv && this.isConfident(rv) && this.confirmCandidate(rv, origAtEnd(rv.offsetFrames), ctxEnd)) {
        this.lock(this.candidate);
        return;
      }
      // A different video?
      const { result, needs } = this.matcher.recognise(fp.hashes, fp.times, this.opts.onlyVid);
      this.fetchNeeded(needs);
      if (result && result.vid !== a.vid && this.confirmCandidate(result, origAtEnd(result.offsetFrames), ctxEnd)) {
        this.lock(this.candidate);
        return;
      }
      if (performance.now() - this.lastConfirm > TUNING.lostAfterSec * 1000) {
        this.backToListening("Lost the video. Listening again…");
      }
      return;
    }

    // listening
    const { result, needs } = this.matcher.recognise(fp.hashes, fp.times, this.opts.onlyVid, this.excludeFinished());
    this.fetchNeeded(needs);
    if (result) {
      if (this.confirmCandidate(result, origAtEnd(result.offsetFrames), ctxEnd)) this.lock(this.candidate);
      else this.emit("state", { state: "listening", message: "Hearing something… confirming", video: null });
    } else if (needs.length && this.opts.onlyVid === null) {
      this.emit("state", { state: "listening", message: "Hearing something… checking the library", video: null });
    } else if (performance.now() - this.listenStarted > 30000) {
      this.listenStarted = performance.now();
      this.emit("state", { state: "listening", message: this.opts.onlyVid === null
        ? "Still listening. You can also pick the video from the list below."
        : "Still listening. Move closer to the speakers if you can.", video: null });
    }
  }

  /** Ignore the last 30 s of the video that just finished (the room may still be ending it). */
  excludeFinished() {
    const f = this.finished;
    if (!f || f.vid == null || performance.now() - f.at > 60000) return null;
    const fromSec = Math.max(0, this.matcher.videos[f.vid].originalDuration - 30);
    return { vid: f.vid, fromFrame: Math.floor((fromSec * SR) / HOP) };
  }

  isConfident(r) {
    return r.score >= RECOGNITION.minScore && r.score >= RECOGNITION.minRatio * r.second;
  }

  /** Require N consecutive matches that agree before acting (avoids false starts). */
  confirmCandidate(r, origT, ctxT) {
    const c = this.candidate;
    if (c && c.vid === r.vid) {
      const expected = c.origT + (ctxT - c.ctxT);
      if (Math.abs(expected - origT) < 0.1) {
        this.candidate = { vid: r.vid, origT, ctxT, n: c.n + 1 };
        return this.candidate.n >= TUNING.confirmations;
      }
    }
    this.candidate = { vid: r.vid, origT, ctxT, n: 1 };
    return TUNING.confirmations <= 1;
  }

  // ------------------------------------------------------------ playback
  /**
   * Which quality to play: 0 = lowest, 1 = next one up, and so on. The lowest
   * files on jw.org also have lower-quality sound, so the next one up is used.
   * Falls back to the highest available if a video has fewer versions.
   */
  pickFile(video) {
    const size = (f) => parseInt(f.label, 10) || Infinity;
    const files = [...(video.adFiles || [])].sort((a, b) => size(a) - size(b));
    return files[Math.min(TUNING.playbackQuality, files.length - 1)]?.url;
  }

  targetADTime() {
    const a = this.anchor;
    // Delay between the phone playing a sound and it reaching your ears. Some
    // browsers report it (and may already include Bluetooth); Safari doesn't.
    // In Bluetooth mode use the standard Bluetooth delay unless the browser
    // reports a bigger one, so it is never counted twice.
    const reported = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    const out = this.opts.bluetooth ? Math.max(reported, TUNING.bluetoothMs / 1000) : reported;
    const orig = a.origT + (this.ctx.currentTime - a.ctxT) + out + (this.opts.offsetMs + TUNING.leadMs) / 1000;
    return mapToAD(this.matcher.videos[a.vid], orig);
  }

  async lock(c) {
    if (this.locking) return;
    this.locking = true;
    try { await this.lockInner(c); } finally { this.locking = false; }
  }

  async lockInner(c) {
    this.stable = 0;
    const switching = !this.anchor || this.anchor.vid !== c.vid;
    this.anchor = { vid: c.vid, origT: c.origT, ctxT: c.ctxT };
    this.candidate = null;
    this.lastConfirm = performance.now();
    this.matcher.loadVideo(c.vid).catch(() => {}); // full detail for staying in sync
    const v = this.matcher.videos[c.vid];
    this.setState("playing", `Playing: ${v.title}`);

    const url = this.pickFile(v);
    if (switching || this.currentUrl !== url) {
      this.currentUrl = url;
      this.video.src = url;
      await new Promise((res) => this.video.addEventListener("loadedmetadata", res, { once: true }));
    }
    await this.seekTo(this.targetADTime());
    try {
      await this.video.play();
    } catch (err) {
      this.emit("error", { message: "The browser blocked playback. Tap Play on the video.", err });
    }
  }

  async seekTo(t) {
    const t0 = performance.now();
    this.video.currentTime = Math.max(0, t + this.seekLead);
    await new Promise((res) => this.video.addEventListener("seeked", res, { once: true }));
    const took = (performance.now() - t0) / 1000;
    this.seekLead = 0.7 * this.seekLead + 0.3 * Math.min(took, 1.5); // learn how long seeks take
  }

  correct() {
    if (this.state !== "playing" || !this.anchor) return;
    const v = this.video;
    if (v.readyState < 3 || v.seeking || v.paused) return;
    // After a seek or a buffering pause, let playback settle before judging it.
    if (performance.now() < (this.holdUntil || 0)) return;
    const target = this.targetADTime();
    // Phones report the playing position in coarse steps, so decide on the
    // median of the last few readings rather than reacting to every jitter.
    this.errs = [...(this.errs || []).slice(-(TUNING.errSamples - 1)), v.currentTime - target];
    const err = [...this.errs].sort((x, y) => x - y)[Math.floor(this.errs.length / 2)];
    this.lastErr = err; // + means we are ahead of the room
    this.emit("drift", { err });
    let rate = 1;
    if (Math.abs(err) > TUNING.seekThreshold) {
      this.setRate(1);
      this.errs = [];
      this.holdUntil = performance.now() + TUNING.settleMs;
      this.seekTo(target);
      return;
    }
    if (Math.abs(err) > TUNING.deadband) {
      const m = TUNING.maxRateChange;
      rate = Math.min(1 + m, Math.max(1 - m, 1 - err * TUNING.rateGain));
    }
    this.setRate(rate);
  }

  /** Change speed only when it really differs; every change can cause a tiny glitch. */
  setRate(rate) {
    const v = this.video;
    if (Math.abs(v.playbackRate - rate) < TUNING.minRateStep && !(rate === 1 && v.playbackRate !== 1)) return;
    v.playbackRate = rate;
  }

  /** Limit recognition to one video (index into catalog), or null for any. */
  focus(vid) {
    this.opts.onlyVid = vid;
    if (this.state === "playing" && vid !== null && this.anchor?.vid !== vid) {
      this.backToListening(`Listening for ${this.matcher.videos[vid].title}…`);
    }
  }

  /** Forget the current position and find it again from the room. */
  resync() {
    if (this.state === "idle") return;
    const v = this.opts.onlyVid;
    this.backToListening(v === null ? "Finding the video again…" : `Finding the spot in ${this.matcher.videos[v].title}…`);
  }

  setOffset(ms) { this.opts.offsetMs = ms; }
  setBluetooth(on) { this.opts.bluetooth = on; }
}
