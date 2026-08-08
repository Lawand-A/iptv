/* StreamHub service worker — makes the app installable and available offline.
   Strategy: precache the app shell on install; serve cache-first for the
   shell; network-first for anything else (posters, streams) with a cache
   fallback only for same-origin static files. Streams and API calls are
   never cached — they must always hit the network. */
"use strict";

var VERSION = "streamhub-v1";
var SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./js/storage.js",
  "./js/m3u-parser.js",
  "./js/m3u-exporter.js",
  "./js/xtream.js",
  "./js/player.js",
  "./js/ui.js",
  "./js/navigation.js",
  "./js/app.js",
  "./icon.png",
  "./icon-192.png",
  "./icon-512.png"
];

/* Media / API requests must never be served from cache. */
function isStreamOrApi(url) {
  return /\.(m3u8|ts|mp4|mkv|mpd|m4s|mp3|aac|ogg|webm)(\?|#|$)/i.test(url)
    || /player_api\.php|get\.php|xmltv\.php/i.test(url);
}

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== VERSION) return caches.delete(k);
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = req.url;
  if (!/^https?:\/\//i.test(url)) return;
  if (isStreamOrApi(url)) return; // always go to the network for media/API

  var sameOrigin = url.indexOf(self.location.origin) === 0;

  if (sameOrigin) {
    /* App shell & same-origin assets: cache first, then network, and keep the
       cache fresh in the background. */
    e.respondWith(
      caches.match(req, { ignoreSearch: true }).then(function (cached) {
        var net = fetch(req).then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(VERSION).then(function (cache) { cache.put(req, copy); });
          }
          return res;
        }).catch(function () { return cached; });
        return cached || net;
      })
    );
    return;
  }

  /* Cross-origin (CDN scripts like hls.js/mpegts.js, posters): network first,
     fall back to a cached copy when offline. Opaque responses (no-cors images)
     have res.ok === false but are still worth caching. */
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && (res.ok || res.type === "opaque")) {
        var copy = res.clone();
        caches.open(VERSION).then(function (cache) { cache.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true });
    })
  );
});
