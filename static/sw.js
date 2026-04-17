const CACHE_NAME = "fluid-metronome-v4";

// Static app shell — paths that don't change between builds.
const APP_SHELL = [
  "/",
  "/static/app.css",
  "/static/manifest.webmanifest",
  "/static/icons/icon.svg",
  "/js/audio-engine.js",
  "/js/firebase.js",
  "/static/firebase-config.js",
];

// Trunk generates hashed filenames (e.g. /fluidmetronome-abc123.js and
// /fluidmetronome-abc123_bg.wasm) that we can't know statically. We discover
// them by parsing index.html at install time so they're cached before any
// user tries to open the app offline.
async function cacheIndexAndHashedAssets(cache) {
  const response = await fetch("/index.html");
  if (!response.ok) return;

  // Read the HTML body while keeping the original response for caching.
  const html = await response.clone().text();
  await cache.put("/index.html", response);

  // Extract every root-relative path ending in .js or .wasm — these are
  // the Trunk-bundled assets with hashed names.
  const assetUrls = new Set();
  for (const [, url] of html.matchAll(/["'](\/[A-Za-z0-9_-]+\.(?:js|wasm))["']/g)) {
    assetUrls.add(url);
  }

  await Promise.allSettled([...assetUrls].map((url) => cache.add(url)));
}

function isSameOrigin(request) {
  return new URL(request.url).origin === self.location.origin;
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache static shell files first, then discover and cache WASM bundle.
      await cache.addAll(APP_SHELL);
      await cacheIndexAndHashedAssets(cache);
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
    ),
  );
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || !isSameOrigin(event.request)) {
    return;
  }

  // Navigation requests (HTML page loads): stale-while-revalidate.
  // Return the cached shell immediately so the app opens offline without
  // delay, and quietly refresh the cache in the background for next time.
  if (event.request.mode === "navigate") {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match("/index.html");
        const fresh = fetch(event.request)
          .then((response) => {
            if (response.ok) cache.put("/index.html", response.clone());
            return response;
          })
          .catch(() => null);

        if (cached) {
          // Serve stale immediately; revalidate in background.
          event.waitUntil(fresh);
          return cached;
        }

        // No cache yet — must wait for the network.
        return (
          (await fresh) ??
          new Response("Fluid Metronome has not been cached yet. Please open it once while online.", {
            status: 503,
            headers: { "Content-Type": "text/plain" },
          })
        );
      }),
    );
    return;
  }

  // All other same-origin GET requests: cache-first, populate cache on miss.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(event.request).then((response) => {
        if (!response.ok) {
          return response;
        }

        const cloned = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
        return response;
      });
    }),
  );
});
