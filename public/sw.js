// 아주 단순한 서비스워커: 앱 껍데기를 캐시해 오프라인에서도 마지막 화면을 보여준다.
// daily.json(데이터)은 항상 네트워크 우선으로 받아 최신을 유지한다.
const CACHE = "market-check-v3";
const SHELL = ["./", "./index.html", "./manifest.webmanifest",
  "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // 데이터는 항상 최신 우선(네트워크), 실패 시에만 캐시
  if (url.pathname.endsWith("daily.json")) {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return r;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  // 그 외(앱 껍데기)는 캐시 우선, 없으면 네트워크
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
