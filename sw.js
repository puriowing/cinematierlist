/* Tiari - Service Worker
 * 方針: 画面の鮮度を最優先（network-first）。オンライン時は常に最新を取得し、
 * 取得できた内容をキャッシュへ保存。オフライン時のみキャッシュから返す。
 * これにより「古い app.js が残って不具合」を避けつつ、電波が無い場所でも
 * 直近のリスト画面を開けるようにする。
 */
const CACHE = "ctl-cache-v10";
// ポスター画像は中身が変わらないので、端末に保存して次からは即表示（cache-first）
const IMG_CACHE = "ctl-img-v1";
const IMG_MAX = 1500;
const CORE = ["./", "./index.html", "./app.js", "./icons.js", "./styles.css", "./icon.svg", "./icon-pop.svg", "./manifest.webmanifest", "./icons/icon-192.png"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) => Promise.allSettled(CORE.map((u) => c.add(u))))
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k !== IMG_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const isPoster = (url.origin === self.location.origin && url.pathname === "/api/img") ||
    url.hostname.endsWith(".cloudfront.net");
  if (isPoster) {
    e.respondWith(posterFirst(req));
    return;
  }
  if (url.origin !== self.location.origin) return; // 外部（Filmarks等）は素通し

  // 検索・スクレイピングAPIは常に最新をネットワークから。キャッシュしない。
  if (url.pathname.startsWith("/api/")) return;

  // それ以外（HTML/JS/CSS/アイコン等）は network-first、失敗時はキャッシュ。
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(
          (hit) =>
            hit ||
            // ?v= 付きの app.js/styles.css はクエリ無視で照合、無ければ最後にシェルへ
            caches.match(req, { ignoreSearch: true }).then(
              (h2) => h2 || (req.mode === "navigate" ? caches.match("./index.html") : undefined)
            )
        )
      )
  );
});

async function posterFirst(req) {
  const cache = await caches.open(IMG_CACHE);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok && (res.type === "basic" || res.type === "cors")) {
    cache.put(req, res.clone()).then(() => trimPosters(cache)).catch(() => {});
  }
  return res;
}

let trimming = false;
async function trimPosters(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    const extra = keys.length - IMG_MAX;
    for (let i = 0; i < extra; i++) await cache.delete(keys[i]);
  } finally {
    trimming = false;
  }
}
