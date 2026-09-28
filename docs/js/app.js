import { Matcher } from "./matcher.js";
import { Engine } from "./engine.js";

const $ = (id) => document.getElementById(id);
const listen = $("listen"), toggle = $("toggle"), statusEl = $("status");
const player = $("player"), now = $("now"), nowTitle = $("now-title"), nowPoster = $("now-poster");
const syncState = $("sync-state"), resync = $("resync");
const target = $("target"), targetName = $("target-name"), targetClear = $("target-clear");
const search = $("search"), results = $("results"), resultCount = $("result-count");
const offset = $("offset"), offsetValue = $("offset-value"), vibrateBox = $("vibrate");
const progress = $("progress"), progressBar = $("progress-bar");

// ?data=path/ points the app at another library (for example the test fixtures)
const dataUrl = new URLSearchParams(location.search).get("data") || "data/";
const MAX_RESULTS = 40;

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private browsing */ } },
};

let matcher = null;
let engine = null;
let chosen = null;       // index into matcher.videos, or null = any video
let playingVid = null;   // the video currently playing, for announcements
let micOn = false;

// ------------------------------------------------------------ speaking
// Screen readers only hear what is put in #announcer (polite) or #alert
// (urgent). Small in-between updates stay visual so the screen reader never
// talks over the audio description.
const announcer = $("announcer"), alertBox = $("alert");
function announce(text, urgent = false) {
  const el = urgent ? alertBox : announcer;
  el.textContent = "";
  setTimeout(() => { el.textContent = text; }, 60); // re-announce even if the text repeats
}
function show(text) { statusEl.textContent = text; }
function vibrate(pattern) {
  if (vibrateBox.checked) navigator.vibrate?.(pattern);
}

// ------------------------------------------------------------ settings
const isBluetooth = () => $("phones-bt").checked;
$(store.get("phones", "wired") === "bluetooth" ? "phones-bt" : "phones-wired").checked = true;
document.querySelectorAll('input[name="phones"]').forEach((r) => r.addEventListener("change", () => {
  store.set("phones", isBluetooth() ? "bluetooth" : "wired");
  engine?.setBluetooth(isBluetooth());
}));

vibrateBox.checked = store.get("vibrate", "1") === "1";
vibrateBox.addEventListener("change", () => store.set("vibrate", vibrateBox.checked ? "1" : "0"));

function offsetText(v) {
  return v === 0 ? "No adjustment" : `${Math.abs(v)} milliseconds ${v < 0 ? "earlier" : "later"}`;
}
function applyOffset(speak = false) {
  const v = Number(offset.value);
  const text = offsetText(v);
  offsetValue.textContent = text;
  offset.setAttribute("aria-valuetext", text);
  store.set("offset", String(v));
  engine?.setOffset(-v); // "later" = play the description further behind
  if (speak) announce(text);
}
offset.value = store.get("offset", "0");
applyOffset();
offset.addEventListener("input", () => applyOffset());
document.querySelectorAll(".step").forEach((b) => b.addEventListener("click", () => {
  offset.value = String(Math.max(-600, Math.min(600, Number(offset.value) + Number(b.dataset.step))));
  applyOffset(true);
}));

// ------------------------------------------------------------ what's on screen
function render(state) {
  listen.dataset.state = state;
  toggle.textContent = state === "idle" ? "Start listening" : "Stop listening";
  const playing = state === "playing";
  $("intro").hidden = state !== "idle";
  statusEl.hidden = playing; // the "Now playing" card says it; avoids hearing the title twice
  now.hidden = !playing;
  resync.hidden = !playing;
  target.hidden = playing || chosen === null;
  targetClear.hidden = playing || chosen === null;
  if (!playing) {
    playingVid = null;
    document.title = "Described";
  }
  updateMediaSession(state);
}

function showNow(v) {
  nowTitle.textContent = v.title;
  nowPoster.hidden = !v.poster;
  if (v.poster && nowPoster.src !== v.poster) nowPoster.src = v.poster;
  document.title = `${v.title} · Described`;
}

let lastDriftShown = 0;
function showDrift(err) {
  const t = performance.now();
  if (t - lastDriftShown < 1000) return;
  lastDriftShown = t;
  const ms = Math.round(Math.abs(err) * 1000);
  syncState.textContent = !micOn ? "In sync. Microphone off until the video ends."
    : ms <= 60 ? "In sync." : "Adjusting the timing…";
}

/** Turn the engine's state changes into what is shown and what is spoken. */
function onEngineState({ state, message, video }) {
  render(state);
  if (state === "playing" && video) {
    showNow(video);
    const vid = matcher.videos.indexOf(video);
    if (vid !== playingVid) {           // a new video was found: the one moment worth speaking
      playingVid = vid;
      updateMediaSession("playing");
      show(`Playing ${video.title}`);
      announce(`Playing ${video.title}`);
      vibrate([80, 60, 80]);
    }
    return;
  }
  if (state === "listening") {
    if (/^Video finished/.test(message)) {
      show("Video finished. Listening for the next one.");
      announce("Video finished. Listening for the next one.");
      vibrate(200);
    } else if (/^Lost/.test(message)) {
      show("Lost the video. Listening again.");
      announce("Lost the video. Listening again.");
    } else if (/^Listening|^Finding/.test(message)) {
      show(chosen === null ? "Listening. Play the video in the room." : `Listening for ${matcher.videos[chosen].title}.`);
      announce(statusEl.textContent);
    } else if (/^Hearing/.test(message)) {
      show("Hearing something. Checking…");          // visual only
    } else if (/^Still listening/.test(message)) {
      show("Still listening. If it's a video, you can also choose it below."); // visual only
    }
  }
}

// ------------------------------------------------------------ start / stop
async function start() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    show("This page needs a secure https address to use the microphone.");
    announce(statusEl.textContent, true);
    return;
  }
  engine = new Engine(matcher, player, { offsetMs: -Number(offset.value), onlyVid: chosen, bluetooth: isBluetooth() });
  engine.addEventListener("state", (e) => onEngineState(e.detail));
  engine.addEventListener("error", (e) => { show(e.detail.message); announce(e.detail.message, true); });
  engine.addEventListener("drift", (e) => showDrift(e.detail.err));
  engine.addEventListener("mic", (e) => {
    micOn = e.detail.on;
    if (!micOn) syncState.textContent = "In sync. Microphone off until the video ends.";
  });
  let smooth = 0;
  engine.addEventListener("level", (e) => {
    smooth = 0.7 * smooth + 0.3 * Math.min(1, e.detail.rms * 8);
    listen.style.setProperty("--level", smooth.toFixed(3));
  });
  try {
    await engine.start();
  } catch (err) {
    console.error(err);
    engine = null;
    render("idle");
    const msg = err.name === "NotAllowedError"
      ? "Microphone access is blocked. Allow the microphone for this app in your phone's settings, then tap Start listening again."
      : `Could not start. ${err.message}`;
    show(msg);
    announce(msg, true);
  }
}

async function stop(message = "Stopped.") {
  if (!engine) return;
  const e = engine;
  engine = null;
  await e.stop();
  render("idle");
  show(message);
  announce(message);
}

toggle.addEventListener("click", () => (engine ? stop() : start()));
resync.addEventListener("click", () => engine?.resync());

// Headphone buttons and lock screen: pause stops, play finds the place again.
function updateMediaSession(state) {
  const ms = navigator.mediaSession;
  if (!ms) return;
  if (state === "playing" && playingVid !== null && matcher) {
    const v = matcher.videos[playingVid];
    try {
      ms.metadata = new MediaMetadata({
        title: v.title,
        artist: "Audio description",
        album: "Described",
        artwork: [{ src: v.poster || "icons/icon-512.png", sizes: "512x512" }],
      });
    } catch { /* older browsers */ }
  }
  ms.playbackState = state === "playing" ? "playing" : state === "idle" ? "none" : "paused";
}
if (navigator.mediaSession) {
  const handle = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported */ } };
  handle("pause", () => stop("Stopped from your headphones."));
  handle("stop", () => stop("Stopped."));
  handle("play", () => (engine ? engine.resync() : start()));
}

// ------------------------------------------------------------ choosing a video
function choose(vid) {
  chosen = vid;
  targetName.textContent = vid === null ? "" : matcher.videos[vid].title;
  results.querySelectorAll(".pick").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.vid) === vid)));
  if (vid === null) {
    engine?.focus(null);
    render(engine?.state || "idle");
    announce(engine ? "Listening for any video." : "Choice cleared.");
    return;
  }
  const title = matcher.videos[vid].title;
  announce(`Chosen: ${title}. ${engine ? "Listening for it." : "Starting to listen."}`);
  if (engine) engine.focus(vid);
  else start(); // choosing is a tap, so listening can start right away
  render(engine?.state || "idle");
  matcher.loadVideo(vid).catch(() => {
    show(`Could not load ${title}. Check your connection and choose it again.`);
    announce(statusEl.textContent, true);
  });
}
targetClear.addEventListener("click", () => choose(null));

const minutes = (s) => Math.max(1, Math.round(s / 60));
function renderResults() {
  const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const all = matcher.videos.map((v, i) => ({ v, i }));
  const hits = words.length ? all.filter(({ v }) => words.every((w) => v.title.toLowerCase().includes(w))) : all;
  const shown = hits.slice(0, MAX_RESULTS);

  results.replaceChildren(...shown.map(({ v, i }) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pick";
    b.dataset.vid = String(i);
    b.setAttribute("aria-pressed", String(i === chosen));
    const m = minutes(v.originalDuration);
    b.setAttribute("aria-label", `${v.title}, ${m} ${m === 1 ? "minute" : "minutes"}`);
    if (v.poster) {
      const img = document.createElement("img");
      img.src = v.poster; img.alt = ""; img.loading = "lazy";
      b.append(img);
    }
    const t = document.createElement("span");
    t.className = "title"; t.textContent = v.title;
    const len = document.createElement("span");
    len.className = "len"; len.setAttribute("aria-hidden", "true");
    len.textContent = `${Math.floor(v.originalDuration / 60)}:${String(Math.floor(v.originalDuration % 60)).padStart(2, "0")}`;
    b.append(t, len);
    b.addEventListener("click", () => choose(i));
    li.append(b);
    return li;
  }));

  resultCount.textContent = !hits.length
    ? "No videos match."
    : hits.length > shown.length
      ? `${hits.length} videos. Showing the first ${shown.length}; type more to narrow it down.`
      : `${hits.length} ${hits.length === 1 ? "video" : "videos"}.`;
}
let countTimer;
search.addEventListener("input", () => {
  renderResults();
  clearTimeout(countTimer); // speak the count once typing pauses
  countTimer = setTimeout(() => announce(resultCount.textContent), 900);
});

// ------------------------------------------------------------ offline + install
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isAndroid = /android/i.test(navigator.userAgent);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("offline support unavailable", err));
}
function keepOnlyCurrentLibrary() {
  if (!("serviceWorker" in navigator) || !matcher) return;
  const urls = [...(matcher.dataUrls || []), ...matcher.videos.map((v) => dataUrl + v.fp)];
  navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage({ type: "keep-data", urls })).catch(() => {});
}

let installEvent = null;
const installBox = $("install"), installBtn = $("install-btn");
if (!standalone) {
  if (isIOS) { installBox.hidden = false; $("install-ios").hidden = false; }
  else if (isAndroid) { installBox.hidden = false; $("install-android").hidden = false; }
}
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // our own clearly labelled button instead of the browser's banner
  installEvent = e;
  installBox.hidden = false;
  installBtn.hidden = false;
  $("install-android").hidden = true;
});
installBtn.addEventListener("click", async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => {});
  installEvent = null;
  installBtn.hidden = true;
});
window.addEventListener("appinstalled", () => {
  installBox.hidden = true;
  announce("Described is installed. You can open it from your home screen.");
});

// ------------------------------------------------------------ boot
let lastPct = -1, spokeDownload = false;
function showProgress(done, total) {
  if (!total) return;
  const pct = Math.floor((done / total) * 100);
  if (pct === lastPct) return;
  lastPct = pct;
  progressBar.value = pct;
  progressBar.setAttribute("aria-valuetext", `${pct} percent`);
  if (pct < 100 && performance.now() > 1500) {
    progress.hidden = false;
    show(`Downloading the video library, ${pct}%. This happens only once.`);
    if (!spokeDownload) {
      spokeDownload = true;
      announce("Downloading the video library. This happens only once.");
    }
  }
}

try {
  matcher = await Matcher.load(dataUrl, showProgress);
  progress.hidden = true;
  toggle.disabled = false;
  renderResults();
  render("idle");
  show("Ready.");
  if (spokeDownload) announce("Ready. Tap Start listening.");
  keepOnlyCurrentLibrary();
  navigator.storage?.persist?.().catch(() => {});
} catch (err) {
  console.error(err);
  progress.hidden = true;
  toggle.textContent = "Not available";
  const msg = navigator.onLine === false
    ? "You're offline, and the video library isn't on this phone yet. Connect to the internet once to download it."
    : `The video library could not load. ${err.message}.`;
  show(msg);
  announce(msg, true);
}
