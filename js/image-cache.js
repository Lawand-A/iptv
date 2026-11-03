/* Poster/thumbnail image cache — works even on file://, unlike the Service
   Worker Cache API (which requires https:// or localhost and is therefore
   unavailable there). Fetches each image once, stores it as a data: URI
   string in its own dedicated IndexedDB database, and serves that on every
   later view instead of re-hitting the provider's (often slow) image
   server every single time.

   Purely additive and fail-safe by design: every image element already gets
   its normal remote URL as `src` immediately, unchanged, wherever this is
   used — this module only ever swaps that `src` to a cached copy if one is
   already stored, or stores one in the background for next time. If
   anything here fails (the provider's image server has no CORS headers, a
   network error, IndexedDB unavailable, storage full, anything) it silently
   does nothing, and the image keeps loading exactly as it already does
   without this module at all. No object URLs are used (so there is nothing
   to revoke/leak as grids are rebuilt) — plain data: URI strings only. */
(function (global) {
  "use strict";

  var DB_NAME = "iptv-image-cache";
  var STORE = "images";
  var MAX_ENTRIES = 4000;       /* cap so a huge library can't grow this without bound */
  var MAX_IMAGE_BYTES = 3 * 1024 * 1024; /* skip caching anything unusually large */

  var dbPromise = null;
  var dbHandle = null;
  var idbFailed = false;
  var pending = {}; /* url -> in-flight fetch-and-cache promise, so the same
                        image is never fetched twice concurrently */

  function openDB() {
    if (idbFailed) return Promise.reject(new Error("idb-unavailable"));
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) { idbFailed = true; reject(new Error("no-idb")); return; }
      try {
        var req = global.indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            var store = db.createObjectStore(STORE, { keyPath: "url" });
            store.createIndex("cachedAt", "cachedAt");
          }
        };
        req.onsuccess = function () { dbHandle = req.result; resolve(req.result); };
        req.onerror = function () { idbFailed = true; reject(req.error || new Error("idb-open")); };
      } catch (e) { idbFailed = true; reject(e); }
    }).catch(function (e) { dbPromise = null; throw e; });
    return dbPromise;
  }

  /* Wipe the whole image cache — used when the user clears the library or
     resets the app, so a full "start fresh" actually clears everything
     instead of leaving a separate multi-MB IndexedDB database behind.
     Closes the open connection first so deleteDatabase can't get stuck
     "blocked"; resolves either way rather than risking hanging the UI. */
  function clearAll() {
    pending = {};
    var handle = dbHandle;
    dbHandle = null;
    dbPromise = null;
    idbFailed = false;
    if (handle) { try { handle.close(); } catch (e) { /* ignore */ } }
    return new Promise(function (resolve) {
      try {
        var req = global.indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { resolve(); };
        req.onblocked = function () { resolve(); };
      } catch (e) { resolve(); }
    });
  }

  function getCached(url) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readonly");
        var req = tx.objectStore(STORE).get(url);
        req.onsuccess = function () { resolve(req.result ? req.result.dataUri : null); };
        req.onerror = function () { reject(req.error); };
      });
    }).catch(function () { return null; });
  }

  /* Best-effort cap: if the store has grown past MAX_ENTRIES, trim the
     oldest entries. Only runs right after a write, never blocks a load. */
  function pruneIfNeeded() {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(STORE, "readonly");
        var countReq = tx.objectStore(STORE).count();
        countReq.onsuccess = function () { resolve(countReq.result); };
        countReq.onerror = function () { resolve(0); };
      });
    }).then(function (count) {
      if (count <= MAX_ENTRIES) return;
      var toDelete = count - MAX_ENTRIES + 50;
      return openDB().then(function (db) {
        return new Promise(function (resolve) {
          var tx = db.transaction(STORE, "readwrite");
          var idx = tx.objectStore(STORE).index("cachedAt");
          var cursorReq = idx.openCursor();
          var deleted = 0;
          cursorReq.onsuccess = function () {
            var cursor = cursorReq.result;
            if (cursor && deleted < toDelete) {
              cursor.delete();
              deleted++;
              cursor.continue();
            } else {
              resolve();
            }
          };
          cursorReq.onerror = function () { resolve(); };
        });
      });
    }).catch(function () { /* ignore */ });
  }

  function putCached(url, dataUri) {
    return openDB().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put({ url: url, dataUri: dataUri, cachedAt: Date.now() });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      });
    }).then(pruneIfNeeded).catch(function () { /* ignore */ });
  }

  function blobToDataUri(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error("read-failed")); };
      reader.readAsDataURL(blob);
    });
  }

  /* Fetch `url`, cache it as a data: URI, resolve with that data URI.
     Resolves to null on any failure (no CORS headers on the image server,
     network error, oversized response, etc.) — callers must keep using the
     plain remote URL in that case, which they already do. */
  function fetchAndCache(url) {
    if (pending[url]) return pending[url];
    var p = fetch(url, { referrerPolicy: "no-referrer" })
      .then(function (res) { return res && res.ok ? res.blob() : null; })
      .then(function (blob) {
        if (!blob || blob.size > MAX_IMAGE_BYTES) return null;
        return blobToDataUri(blob).then(function (dataUri) {
          putCached(url, dataUri);
          return dataUri;
        });
      })
      .catch(function () { return null; })
      .then(function (result) { delete pending[url]; return result; });
    pending[url] = p;
    return p;
  }

  /* Public entry point. Call this right after setting img.src = url (the
     normal, already-working path) — it only ever swaps to a cached copy if
     one exists, or warms the cache in the background for next time. Never
     throws; every failure path just leaves the image exactly as it already
     was. */
  function useCached(img, url) {
    if (!img || !url || !global.indexedDB) return;
    getCached(url).then(function (dataUri) {
      if (dataUri) {
        img.src = dataUri;
        return;
      }
      fetchAndCache(url);
    });
  }

  global.ImageCache = { useCached: useCached, clearAll: clearAll };
})(window);
