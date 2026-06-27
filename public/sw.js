// 아주 단순한 서비스워커: 앱 껍데기를 캐시해 오프라인에서도 마지막 화면을 보여준다.
// daily.json(데이터)은 항상 네트워크 우선으로 받아 최신을 유지한다.
const CACHE = "market-check-v5";
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

// 네트워크 우선 + 성공 시 캐시 갱신, 실패(오프라인) 시 캐시 사용
function networkFirst(req) {
  return fetch(req)
    .then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return r;
    })
    .catch(() => caches.match(req));
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return; // 메모 전송(POST) 등은 건드리지 않음
  const url = new URL(e.request.url);
  const isData = url.pathname.endsWith("daily.json");
  const isShell =
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("index.html") ||
    url.pathname.endsWith("sw.js");
  // 데이터와 화면(껍데기)은 '항상 최신 우선' → 새 버전이 바로 반영됨
  if (isData || isShell) {
    e.respondWith(networkFirst(e.request));
    return;
  }
  // 그 외(아이콘 등 잘 안 바뀌는 것)는 캐시 우선
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
