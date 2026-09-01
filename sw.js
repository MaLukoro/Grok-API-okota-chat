const CACHE = "kotatsu-v27";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=27",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-64.png",
  "./icons/grik.png",
  "./icons/maro.png",
  "./js/app.js?v=27",
  "./js/util.js",
  "./js/settings.js",
  "./js/db.js",
  "./js/xai.js",
  "./js/gemini.js",
  "./js/memory.js",
  "./js/rag.js",
  "./js/importChat.js",
  "./js/tts.js",
  "./js/cloud.js",
  "./js/drive.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Drive / Gemini / Google ログインをキャッシュに入れない。同じオリジンの殻だけ。
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/v1") || url.pathname.startsWith("/mgmt")) {
    return;
  }
  const isDoc = req.mode === "navigate" || req.destination === "document";
  event.respondWith(
    fetch(req, isDoc ? { cache: "reload" } : undefined)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
  );
});
