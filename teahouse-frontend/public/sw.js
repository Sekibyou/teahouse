// Teahouse 应用壳缓存 + PWA 安装支持。
const CACHE_NAME = "teahouse-v1";
const APP_SHELL = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];
const API_PREFIXES = ["/api/", "/v1/", "/events"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // 后端接口与 SSE 永远走网络：含认证与动态数据，绝不缓存。
  if (API_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;

  // 导航请求网络优先：新构建会改 index.html 里的 hash 引用，缓存优先会导致读到旧资源名。
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/")));
    return;
  }

  // 静态资源缓存优先；hash 化资源不可变，其余（manifest/图标）很少变。
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
