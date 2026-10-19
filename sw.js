const CACHE_NAME = "mw-request-portal-v13";
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./styles.css",
  "./manifest.webmanifest",
  "./assets/mothers-wonderland-logo.png",
  "./assets/app-icon-192.png",
  "./assets/app-icon-180.png",
  "./assets/app-icon-512.png",
  "./SIG.png",
];
const APP_SHELL_ASSETS = new Set(
  APP_SHELL
    .filter(path => path !== "./" && path !== "./index.html")
    .map(path => new URL(path, self.registration.scope).pathname),
);

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith("mw-request-portal-") && key !== CACHE_NAME)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (APP_SHELL_ASSETS.has(url.pathname)) {
    const cachedResponse = caches.match(request);
    const updateResponse = fetch(request).then(async response => {
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    });
    event.waitUntil(updateResponse.then(() => undefined, () => undefined));
    event.respondWith(cachedResponse.then(cached => cached || updateResponse));
    return;
  }

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === "navigate") {
        const appShell = await caches.match("./index.html");
        if (appShell) return appShell;
      }
      throw error;
    }
  })());
});
