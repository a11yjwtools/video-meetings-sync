// Keeps the app and its fingerprint library on the phone.
//
// - App files (page, scripts, styles, icons) are stored per app version and
//   served from the phone, so the app opens instantly and works on poor Wi-Fi.
//   VERSION is rewritten by build_index.py whenever the app files change; the
//   phone then fetches the new version in the background for the next launch.
// - Library pieces have their content hash in the URL (?h=...), so each one
//   is downloaded once and kept until the library no longer uses it.
// - catalog.json is always checked online first (it is small), and the stored
//   copy is used when offline.
// - Sound from jw.org is never stored; it streams as usual.

const VERSION = "dev";
const APP_CACHE = `described-app-${VERSION}`;
const DATA_CACHE = "described-data";

const APP_FILES = [
  "./",
  "index.html",
  "styles.css",
  "manifest.webmanifest",
  "js/app.js",
  "js/engine.js",
  "js/matcher.js",
  "js/fingerprint.js",
  "js/mic-worklet.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((c) => c.addAll(APP_FILES.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.startsWith("described-app-") && k !== APP_CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return; // jw.org sound etc.
  if (req.headers.has("range")) return; // media seeking: let the network handle it

  const inData = url.pathname.includes("/data/");
  if (inData && url.pathname.endsWith("/catalog.json")) {
    event.respondWith(networkFirst(req, DATA_CACHE));
  } else if (inData && url.searchParams.has("h")) {
    event.respondWith(cacheForever(req, DATA_CACHE));
  } else if (!inData) {
    event.respondWith(appFile(req));
  }
});

/** Library pieces: the URL contains the content hash, so a stored copy is always right. */
async function cacheForever(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req, { cache: "no-cache" });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw new Error("offline and not stored");
  }
}

/** App files: from this version's store; anything else from the network. */
async function appFile(req) {
  const cache = await caches.open(APP_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    return await fetch(req);
  } catch {
    if (req.mode === "navigate") {
      const page = await cache.match("index.html");
      if (page) return page;
    }
    throw new Error("offline");
  }
}

// The page tells us which library pieces are still in use; drop the rest.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "keep-data") return;
  const keep = new Set(event.data.urls.map((u) => new URL(u, self.location).href));
  event.waitUntil(
    caches.open(DATA_CACHE).then(async (cache) => {
      for (const req of await cache.keys()) {
        if (!keep.has(req.url)) await cache.delete(req);
      }
    }),
  );
});
