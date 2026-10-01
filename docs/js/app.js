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

// ------------------------------------------------------------ first screens
// Opened from a link in a phone's browser: first help install the app.
// Opened as the app: first ask for the microphone. Then the main screen.
const ua = navigator.userAgent;
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isAndroid = /android/i.test(ua);
// Built-in browsers of other apps (WhatsApp, Facebook, Instagram…) can't install apps.
const inAppBrowser = /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|WhatsApp|Snapchat|; wv\)|GSA\//i.test(ua);

let screenShown = false;
function showScreen(name) {
  for (const id of ["install", "mic", "main"]) $(`screen-${id}`).hidden = id !== name;
  window.scrollTo(0, 0);
  // move the screen reader to the new screen's title (on first load it starts at the top anyway)
  if (screenShown) $(`screen-${name}`).querySelector("h1").focus();
  screenShown = true;
}

async function micPermission() {
  try { return (await navigator.permissions.query({ name: "microphone" })).state; } catch { return "unknown"; }
}

async function afterInstallStep() {
  const state = await micPermission();
  if (state === "granted" || (state === "unknown" && store.get("micOk", "0") === "1")) {
    showScreen("main");
  } else {
    showScreen("mic");
    if (state === "denied") showMicDenied();
  }
}

function showMicDenied() {
  const where = isIOS
    ? "Open the Settings app, go to Apps, then Safari, then Microphone, and choose Allow. Then come back here and double-tap Try again."
    : isAndroid
      ? "Open Chrome, double-tap More options, then Settings, then Site settings, then Microphone, and allow this site. Then come back here and double-tap Try again."
      : "Allow the microphone for this site in your browser's settings, then try again.";
  $("mic-denied-text").textContent = `The microphone is blocked. ${where}`;
  $("mic-denied").hidden = false;
  announce($("mic-denied-text").textContent, true);
}

async function askForMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop()); // just asking; listening starts with the Start button
    store.set("micOk", "1");
    showScreen("main");
    announce(matcher ? "Microphone allowed. Ready. Tap Start listening." : "Microphone allowed. Loading the video library.");
  } catch (err) {
    console.warn(err);
    showMicDenied();
  }
}
$("allow-mic").addEventListener("click", askForMic);
$("retry-mic").addEventListener("click", askForMic);

function setupInstallScreen() {
  if (inAppBrowser) {
    $("inapp").hidden = false;
    if (isAndroid) {
      const a = $("open-chrome");
      a.href = `intent://${location.host}${location.pathname}${location.search}#Intent;scheme=https;package=com.android.chrome;end`;
      a.hidden = false;
    } else {
      $("inapp-text").textContent = "This page opened inside another app, which can't install apps. Double-tap Copy the link, then open Safari, double-tap the address bar, paste, and go.";
      $("copy-link").hidden = false;
    }
  } else if (isIOS) {
    $("install-ios-steps").hidden = false;
  } else {
    $("install-android-menu").hidden = false; // replaced by a real Install button when Chrome offers one
  }
}
$("copy-link").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href.split("#")[0]);
    announce("Link copied. Now open Safari and paste it in the address bar.");
    $("copy-link").textContent = "Link copied";
  } catch {
    announce(`The link is ${location.href}`);
  }
});
$("install-now").addEventListener("click", async () => {
  if (!installEvent) return;
  installEvent.prompt();
  const choice = await installEvent.userChoice.catch(() => null);
  installEvent = null;
  $("install-android-now").hidden = true;
  if (choice?.outcome === "accepted") $("installed-msg").hidden = false;
  else $("install-android-menu").hidden = false;
});
$("skip-install").addEventListener("click", () => {
  store.set("skipInstall", "1");
  afterInstallStep();
});

if ((isIOS || isAndroid) && !standalone && store.get("skipInstall", "0") !== "1") {
  setupInstallScreen();
  showScreen("install");
} else {
  afterInstallStep();
}

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
  engine = new Engine(matcher, player, { offsetMs: -Number(offset.value), onlyVid: chosen, bluetooth: isBluetooth(), songs: weekVids });
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
  document.querySelectorAll(".pick").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.vid) === vid)));
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

  results.replaceChildren(...shown.map(({ v, i }) => videoItem(v, i)));

  resultCount.textContent = !hits.length
    ? "No videos match."
    : hits.length > shown.length
      ? `${hits.length} videos. Showing the first ${shown.length}; type more to narrow it down.`
      : `${hits.length} ${hits.length === 1 ? "video" : "videos"}.`;
}

function videoItem(v, i) {
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
}
let countTimer;
search.addEventListener("input", () => {
  renderResults();
  clearTimeout(countTimer); // speak the count once typing pauses
  countTimer = setTimeout(() => announce(resultCount.textContent), 900);
});

// ------------------------------------------------------------ this week's songs
// The app's manager sets them on GitHub (Actions → Set meeting songs); they are
// saved in songs.json in the repository and read from there by every phone.
function songsUrl() {
  const forced = new URLSearchParams(location.search).get("songs");
  if (forced) return forced;
  if (location.hostname.endsWith(".github.io")) {
    const owner = location.hostname.split(".")[0];
    const repo = location.pathname.split("/").filter(Boolean)[0] || `${owner}.github.io`;
    return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/songs.json`;
  }
  return "songs.json";
}

let weekVids = [];
function currentWeek(data) {
  const today = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const todayIso = iso(today);
  const tooOld = iso(new Date(today.getTime() - 10 * 86400000)); // a list stays in use for up to 10 days
  const weeks = (data?.weeks || []).filter((w) => w.from <= todayIso && w.from >= tooOld);
  weeks.sort((a, b) => a.from.localeCompare(b.from));
  return weeks.pop() || null;
}

function applyWeek(week) {
  const box = $("week"), list = $("week-list"), missing = $("week-missing");
  if (!matcher || !week?.songs?.length) {
    weekVids = [];
    box.hidden = true;
    engine?.setSongs([]);
    return;
  }
  const found = matcher.findSongs(week.songs);
  weekVids = week.songs.filter((n) => found.has(n)).map((n) => found.get(n));
  const absent = week.songs.filter((n) => !found.has(n));
  list.replaceChildren(...weekVids.map((vid) => videoItem(matcher.videos[vid], vid)));
  missing.hidden = !absent.length;
  missing.textContent = absent.length
    ? `No audio description available for song${absent.length > 1 ? "s" : ""} ${absent.join(", ")}.` : "";
  box.hidden = !weekVids.length && !absent.length;
  engine?.setSongs(weekVids);
  weekVids.forEach((vid) => matcher.loadVideo(vid).catch(() => {})); // ready before the meeting
}

async function loadWeekSongs() {
  let data = null;
  try {
    const res = await fetch(songsUrl(), { cache: "no-store" });
    if (res.ok) {
      data = await res.json();
      store.set("songs-data", JSON.stringify(data));
    }
  } catch { /* offline: use the last copy */ }
  if (!data) {
    try { data = JSON.parse(store.get("songs-data", "null")); } catch { data = null; }
  }
  applyWeek(currentWeek(data));
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && matcher) loadWeekSongs();
});
setInterval(() => { if (matcher) loadWeekSongs(); }, 30 * 60 * 1000);

// ------------------------------------------------------------ offline + install
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
  if (!inAppBrowser) {
    $("install-android-now").hidden = false;
    $("install-android-menu").hidden = true;
  }
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
  $("install-android-now").hidden = true;
  $("installed-msg").hidden = false;
  announce("Described is installed. Open it from your home screen.");
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
  loadWeekSongs();
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
