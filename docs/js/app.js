import { Matcher } from "./matcher.js";
import { Engine } from "./engine.js";

const $ = (id) => document.getElementById(id);
const listen = $("listen"), toggle = $("toggle"), label = $("toggle-label"), status = $("status");
const player = $("player"), sync = $("sync"), syncState = $("sync-state"), resync = $("resync");
const targetName = $("target-name"), targetClear = $("target-clear");
const search = $("search"), results = $("results"), resultCount = $("result-count");
const offset = $("offset"), offsetValue = $("offset-value");

// ?data=path/ points the app at another index (for example the test fixtures)
const dataUrl = new URLSearchParams(location.search).get("data") || "data/";
const MAX_RESULTS = 40;

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private browsing */ } },
};

let matcher = null;
let engine = null;
let chosen = null; // index into matcher.videos, or null = any video

const say = (text) => { status.textContent = text; };
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// ------------------------------------------------------------ settings
function showOffset() {
  const v = Number(offset.value);
  offsetValue.textContent = v === 0 ? "0 ms" : `${Math.abs(v)} ms ${v < 0 ? "earlier" : "later"}`;
  store.set("offset", String(v));
  engine?.setOffset(-v); // "later" = play the description further behind
}
// ------------------------------------------------------------ headphones
const phoneRadios = document.querySelectorAll('input[name="phones"]');
const isBluetooth = () => document.getElementById("phones-bt").checked;
document.getElementById(store.get("phones", "wired") === "bluetooth" ? "phones-bt" : "phones-wired").checked = true;
phoneRadios.forEach((r) => r.addEventListener("change", () => {
  store.set("phones", isBluetooth() ? "bluetooth" : "wired");
  engine?.setBluetooth(isBluetooth());
  if (engine) say(isBluetooth() ? "Bluetooth selected. The description now plays slightly earlier to match." : "Wired headphones selected.");
}));

// ------------------------------------------------------------ between descriptions
const narrationOnly = () => document.getElementById("between-room").checked;
document.getElementById(store.get("between", "room") === "sound" ? "between-sound" : "between-room").checked = true;
document.querySelectorAll('input[name="between"]').forEach((r) => r.addEventListener("change", () => {
  store.set("between", narrationOnly() ? "room" : "sound");
  engine?.setNarrationOnly(narrationOnly());
}));

offset.value = store.get("offset", "0");
showOffset();
offset.addEventListener("input", showOffset);
document.querySelectorAll(".step").forEach((b) =>
  b.addEventListener("click", () => {
    offset.value = String(Number(offset.value) + Number(b.dataset.step));
    showOffset();
  }),
);

// ------------------------------------------------------------ state display
function render(state, message) {
  listen.dataset.state = state;
  if (message) say(message);
  label.textContent = state === "idle" ? "Start listening" : "Stop";
  toggle.setAttribute("aria-pressed", String(state !== "idle"));
  sync.hidden = state !== "playing";
  $("target").hidden = state === "playing";
  if (state !== "playing") {
    syncState.textContent = "Checking…";
    delete syncState.dataset.quality;
  }
}

function showNow(v) {
  const img = $("now-poster");
  $("now-title").textContent = v.title;
  img.hidden = !v.poster;
  if (v.poster && img.src !== v.poster) img.src = v.poster;
}

let lastDriftShown = 0;
let micOn = false;
let speaking = true;
function showDrift(err) {
  const now = performance.now();
  if (now - lastDriftShown < 500) return; // readable, not flickering
  lastDriftShown = now;
  const ms = Math.round(Math.abs(err) * 1000);
  const good = ms <= 60;
  syncState.dataset.quality = good ? "good" : "adjusting";
  syncState.textContent = !micOn
    ? (speaking ? "In sync · describing" : "In sync · waiting for a description")
    : good ? `In sync (within ${ms} ms)` : `Adjusting… ${ms} ms ${err > 0 ? "ahead" : "behind"}`;
}

// ------------------------------------------------------------ choosing a video
async function choose(vid) {
  chosen = vid;
  targetName.textContent = vid === null ? "any video" : matcher.videos[vid].title;
  targetClear.hidden = vid === null;
  results.querySelectorAll(".pick").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.vid) === vid)));
  if (engine) engine.focus(vid);
  else if (vid !== null) start(); // picking a video is also a tap, so we can start listening right away
  if (vid === null || matcher.single.has(vid)) return;
  const title = matcher.videos[vid].title;
  say(`Getting ready for ${title}…`);
  try {
    await matcher.loadVideo(vid);
    if (chosen === vid && engine?.state === "listening") say(`Listening for ${title}…`);
  } catch (err) {
    say(`Could not load ${title}. Check your connection and pick it again.`);
  }
}
targetClear.addEventListener("click", () => {
  choose(null);
  say(engine ? "Listening for any video." : "Ready.");
});

function renderResults() {
  const q = search.value.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
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
    if (v.poster) {
      const img = document.createElement("img");
      img.src = v.poster; img.alt = ""; img.loading = "lazy";
      b.append(img);
    } else {
      const ph = document.createElement("span");
      ph.className = "thumb";
      b.append(ph);
    }
    const t = document.createElement("span");
    t.className = "title"; t.textContent = v.title;
    const len = document.createElement("span");
    len.className = "len"; len.textContent = fmtTime(v.originalDuration);
    len.setAttribute("aria-label", `${Math.round(v.originalDuration / 60) || 1} minutes`);
    b.append(t, len);
    b.addEventListener("click", () => choose(i));
    li.append(b);
    return li;
  }));

  resultCount.textContent = !hits.length
    ? "No described videos match that search."
    : hits.length > shown.length
      ? `Showing ${shown.length} of ${hits.length}. Type more of the title to narrow it down.`
      : `${hits.length} ${hits.length === 1 ? "video" : "videos"}.`;
}
search.addEventListener("input", renderResults);

// ------------------------------------------------------------ start / stop
async function start() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    say("This page needs HTTPS to use the microphone. Open it from its https:// address.");
    return;
  }
  engine = new Engine(matcher, player, { offsetMs: -Number(offset.value), onlyVid: chosen, bluetooth: isBluetooth(), narrationOnly: narrationOnly() });
  engine.addEventListener("state", (e) => {
    render(e.detail.state, e.detail.message);
    if (e.detail.state === "playing" && e.detail.video) showNow(e.detail.video);
  });
  engine.addEventListener("error", (e) => say(e.detail.message));
  engine.addEventListener("drift", (e) => showDrift(e.detail.err));
  engine.addEventListener("mic", (e) => { micOn = e.detail.on; });
  engine.addEventListener("gate", (e) => { speaking = e.detail.speaking; });
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
    say(err.name === "NotAllowedError"
      ? "Microphone access was blocked. Allow the microphone for this site, then start again."
      : `Could not start: ${err.message}`);
  }
}

toggle.addEventListener("click", async () => {
  if (engine) {
    await engine.stop();
    engine = null;
    render("idle", "Stopped. Start again when the next video plays.");
  } else {
    start();
  }
});
resync.addEventListener("click", () => engine?.resync());

// ------------------------------------------------------------ offline + install
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("offline support unavailable", err));
}

/** Tell the service worker which library files are still used, so old ones are deleted. */
function keepOnlyCurrentLibrary() {
  if (!("serviceWorker" in navigator) || !matcher) return;
  const urls = [...(matcher.dataUrls || []), ...matcher.videos.map((v) => dataUrl + v.fp)];
  navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage({ type: "keep-data", urls })).catch(() => {});
}

let installEvent = null;
const installBox = $("install"), installBtn = $("install-btn"), installText = $("install-text");
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // show our own button instead of the browser's banner
  installEvent = e;
  installBox.hidden = false;
  installBtn.hidden = false;
});
installBtn.addEventListener("click", async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => {});
  installEvent = null;
  installBtn.hidden = true;
});
window.addEventListener("appinstalled", () => { installBox.hidden = true; });
if (!standalone && /iphone|ipad|ipod/i.test(navigator.userAgent)) {
  installBox.hidden = false;
  installText.textContent = "On iPhone: tap the Share button (the square with an arrow) at the bottom of Safari, then choose “Add to Home Screen”. Described then opens like an app, starts instantly, and keeps the video library on your phone.";
}

// ------------------------------------------------------------ boot
const progress = $("progress"), progressBar = $("progress-bar");
let lastPct = -1;
function showProgress(done, total) {
  if (!total) return;
  const pct = Math.floor((done / total) * 100);
  if (pct === lastPct) return;
  lastPct = pct;
  progressBar.value = pct;
  if (pct < 100) {
    progress.hidden = false;
    // announce in steps of 25% so screen readers aren't flooded
    if (pct % 25 === 0 || lastPct === 0) say(`Downloading the video library… ${pct}%. This only happens once.`);
  }
}

try {
  matcher = await Matcher.load(dataUrl, showProgress);
  progress.hidden = true;
  toggle.disabled = false;
  renderResults();
  render("idle", `Ready. ${matcher.videos.length} described videos in the library.`);
  keepOnlyCurrentLibrary();
  navigator.storage?.persist?.().catch(() => {});
} catch (err) {
  console.error(err);
  progress.hidden = true;
  label.textContent = "Unavailable";
  say(navigator.onLine === false
    ? "You're offline and the video library isn't on this phone yet. Connect to the internet once to download it."
    : `The video library could not load. ${err.message}.`);
}
