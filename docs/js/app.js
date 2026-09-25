import { Matcher } from "./matcher.js";
import { Engine } from "./engine.js";

const $ = (id) => document.getElementById(id);
const listen = $("listen"), toggle = $("toggle"), label = $("toggle-label"), status = $("status");
const player = $("player"), sync = $("sync"), syncState = $("sync-state"), resync = $("resync");
const targetName = $("target-name"), targetClear = $("target-clear");
const search = $("search"), results = $("results"), resultCount = $("result-count");
const offset = $("offset"), offsetValue = $("offset-value"), quality = $("quality");

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
offset.value = store.get("offset", "0");
quality.value = store.get("quality", "480p");
showOffset();
offset.addEventListener("input", showOffset);
document.querySelectorAll(".step").forEach((b) =>
  b.addEventListener("click", () => {
    offset.value = String(Number(offset.value) + Number(b.dataset.step));
    showOffset();
  }),
);
quality.addEventListener("change", () => {
  store.set("quality", quality.value);
  engine?.setQuality(quality.value);
});

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

let lastDriftShown = 0;
function showDrift(err) {
  const now = performance.now();
  if (now - lastDriftShown < 500) return; // readable, not flickering
  lastDriftShown = now;
  const ms = Math.round(Math.abs(err) * 1000);
  const good = ms <= 60;
  syncState.dataset.quality = good ? "good" : "adjusting";
  syncState.textContent = good ? `In sync (within ${ms} ms)` : `Adjusting… ${ms} ms ${err > 0 ? "ahead" : "behind"}`;
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
  engine = new Engine(matcher, player, { quality: quality.value, offsetMs: -Number(offset.value), onlyVid: chosen });
  engine.addEventListener("state", (e) => render(e.detail.state, e.detail.message));
  engine.addEventListener("error", (e) => say(e.detail.message));
  engine.addEventListener("drift", (e) => showDrift(e.detail.err));
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

// ------------------------------------------------------------ boot
try {
  matcher = await Matcher.load(dataUrl);
  toggle.disabled = false;
  renderResults();
  render("idle", `Ready. ${matcher.videos.length} described videos in the library.`);
} catch (err) {
  console.error(err);
  label.textContent = "Unavailable";
  say(`The video library could not load. ${err.message}.`);
}
