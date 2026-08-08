/* Storage layer — persistent data.
   Small data (watchlist, history, progress, watched, settings) stays in
   localStorage. The item library is kept in memory and persisted to
   IndexedDB so very large playlists (100k+ entries) import and reload
   quickly without hitting the localStorage quota. If IndexedDB is
   unavailable, it falls back to localStorage with a quota warning. */
(function (global) {
  "use strict";

  var KEYS = {
    items: "iptv_items",
    watchlist: "iptv_watchlist",
    history: "iptv_history",
    progress: "iptv_progress",
    watched: "iptv_watched",
    settings: "iptv_settings",
    pins: "iptv_pins"
  };

  var DB_NAME = "iptv-app";
  var DB_STORE = "library";
  var ITEM_DB_KEY = "items";
  var LS_MIRROR_LIMIT = 2500000; // chars; mirror to localStorage only when small

  var store = {};

  var itemsCache = null;
  var persistTimer = null;
  var persistErrorHandler = null;
  var dbPromise = null;
  var idbFailed = false;

  /* In-memory mirror of every localStorage value, so reading hot data
     (watched/progress/history on every rendered card) never hits the disk
     or re-parses JSON. Invalidated on every write. */
  var memCache = {};

  function read(key, fallback) {
    if (memCache.hasOwnProperty(key)) return memCache[key];
    try {
      var raw = localStorage.getItem(key);
      var value;
      if (raw === null || raw === "") {
        value = fallback;
      } else {
        value = JSON.parse(raw);
        if (value === undefined || value === null) value = fallback;
      }
      memCache[key] = value;
      return value;
    } catch (e) {
      console.warn("Storage corrupt for", key, "- recovering.");
      localStorage.removeItem(key);
      delete memCache[key];
      return fallback;
    }
  }

  function write(key, value) {
    memCache[key] = value;
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn("Storage write failed for", key, e);
      return false;
    }
  }

  function memDrop(key) {
    delete memCache[key];
  }

  function memClear() {
    memCache = {};
  }

  function uid() {
    var rand = Math.random().toString(36).slice(2, 10);
    return "id-" + Date.now().toString(36) + "-" + rand;
  }

  function now() {
    return Date.now();
  }

  function isValidItem(it) {
    return it && typeof it === "object" && it.id;
  }

  /* Repair stale items saved by older parser versions:
     - a source still prefixed with the embed marker "*" is always an embed
     - iframe HTML stored as direct must play as an embed
     Returns the repaired list and whether anything changed. */
  function repairItems(list) {
    var changed = false;
    var out = list.map(function (it) {
      if (!isValidItem(it)) return it;
      var s = String(it.source || "").trim();
      if (s.indexOf("*") === 0) {
        changed = true;
        return Object.assign({}, it, { source: s.slice(1).trim(), mediaType: "embed" });
      }
      if (/<iframe\b/i.test(s) && it.mediaType !== "embed") {
        changed = true;
        return Object.assign({}, it, { mediaType: "embed" });
      }
      return it;
    });
    return { items: out, changed: changed };
  }

  /* ---------- IndexedDB helpers ---------- */
  function idbSupported() {
    return !!(global.indexedDB);
  }

  function openDB() {
    return new Promise(function (resolve, reject) {
      if (!idbSupported()) { idbFailed = true; reject(new Error("no-idb")); return; }
      try {
        var req = global.indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { idbFailed = true; reject(req.error || new Error("idb-open")); };
      } catch (e) {
        idbFailed = true;
        reject(e);
      }
    });
  }

  function getDB() {
    if (idbFailed) return Promise.reject(new Error("idb-unavailable"));
    if (!dbPromise) {
      dbPromise = openDB().catch(function (e) {
        idbFailed = true;
        dbPromise = null;
        throw e;
      });
    }
    return dbPromise;
  }

  function idbGet(db, key) {
    return new Promise(function (resolve, reject) {
      try {
        var tx = db.transaction(DB_STORE, "readonly");
        var req = tx.objectStore(DB_STORE).get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      } catch (e) { reject(e); }
    });
  }

  function idbPut(db, key, value) {
    return new Promise(function (resolve, reject) {
      try {
        var tx = db.transaction(DB_STORE, "readwrite");
        tx.objectStore(DB_STORE).put(value, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error || new Error("idb-put")); };
      } catch (e) { reject(e); }
    });
  }

  function idbDelete(db, key) {
    return new Promise(function (resolve, reject) {
      try {
        var tx = db.transaction(DB_STORE, "readwrite");
        tx.objectStore(DB_STORE).delete(key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error || new Error("idb-del")); };
      } catch (e) { reject(e); }
    });
  }

  /* ---------- Item library ---------- */
  function getItems() {
    if (itemsCache) return itemsCache;
    var legacy = read(KEYS.items, []);
    if (!Array.isArray(legacy)) legacy = [];
    var rep = repairItems(legacy.filter(isValidItem));
    itemsCache = rep.items;
    if (rep.changed) schedulePersist();
    return itemsCache;
  }

  function saveItems(list) {
    itemsCache = Array.isArray(list) ? list.filter(isValidItem) : [];
    schedulePersist();
    return true;
  }

  function persistNow() {
    var snapshot = itemsCache ? itemsCache.slice() : [];
    var lsSize = 0;
    var small = snapshot.length <= 20000;
    if (small) {
      try { lsSize = JSON.stringify(snapshot).length; } catch (e) { lsSize = LS_MIRROR_LIMIT + 1; }
    }

    if (small && lsSize <= LS_MIRROR_LIMIT) {
      write(KEYS.items, snapshot);
    } else {
      memDrop(KEYS.items);
      try { localStorage.removeItem(KEYS.items); } catch (e) { /* ignore */ }
    }

    getDB().then(function (db) {
      return idbPut(db, ITEM_DB_KEY, snapshot);
    }).catch(function () {
      if (small && lsSize <= LS_MIRROR_LIMIT) return; // localStorage mirror is enough
      if (persistErrorHandler) {
        persistErrorHandler("Library is too large for localStorage and IndexedDB is unavailable — items will be lost after reload. Use a Chromium-based browser for full large-library support.");
      }
    });
  }

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(function () {
      persistTimer = null;
      persistNow();
    }, 50);
  }

  function getItem(id) {
    return getItems().find(function (it) { return it.id === id; }) || null;
  }

  function addItem(data) {
    var item = Object.assign({
      id: uid(),
      title: "Untitled",
      type: "movie",
      mediaType: "direct",
      source: "",
      poster: "",
      group: "",
      description: "",
      seriesId: null,
      seriesName: null,
      season: null,
      episode: null,
      episodeNumber: null,
      episodeTitle: null,
      addedAt: now()
    }, data, { id: data && data.id ? data.id : uid() });

    var items = getItems();
    var idx = items.findIndex(function (it) { return it.id === item.id; });
    if (idx >= 0) items[idx] = item; else items.push(item);
    schedulePersist();
    return item;
  }

  function updateItem(id, patch) {
    var items = getItems();
    var idx = items.findIndex(function (it) { return it.id === id; });
    if (idx < 0) return null;
    items[idx] = Object.assign({}, items[idx], patch, { id: id });
    schedulePersist();
    return items[idx];
  }

  function removeItem(id) {
    var items = getItems().filter(function (it) { return it.id !== id; });
    itemsCache = items;
    schedulePersist();
    clearItemReferences(id);
  }

  /* Remove references to a content id across all tracking stores. */
  function clearItemReferences(id) {
    var wl = read(KEYS.watchlist, []).filter(function (x) { return x !== id; });
    write(KEYS.watchlist, wl);

    var history = read(KEYS.history, []);
    if (!Array.isArray(history)) history = [];
    history = history.filter(function (h) { return h.id !== id; });
    write(KEYS.history, history);

    var progress = read(KEYS.progress, {});
    if (progress[id]) { delete progress[id]; write(KEYS.progress, progress); }

    var watched = read(KEYS.watched, {});
    if (watched[id]) { delete watched[id]; write(KEYS.watched, watched); }

    var pins = read(KEYS.pins, []).filter(function (x) { return x !== id; });
    write(KEYS.pins, pins);
  }

  /* ---------- Pins ---------- */
  function getPins() {
    var list = read(KEYS.pins, []);
    if (!Array.isArray(list)) return [];
    return list;
  }

  function isPinned(id) {
    return getPins().indexOf(id) >= 0;
  }

  function togglePin(id) {
    var list = getPins();
    var idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1); else list.push(id);
    write(KEYS.pins, list);
    return idx < 0;
  }

  /* ---------- Watchlist ---------- */
  function getWatchlist() {
    var list = read(KEYS.watchlist, []);
    if (!Array.isArray(list)) return [];
    return list;
  }
  function isInWatchlist(id) { return getWatchlist().indexOf(id) >= 0; }
  function toggleWatchlist(id) {
    var list = getWatchlist();
    var idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1); else list.push(id);
    write(KEYS.watchlist, list);
    return idx < 0;
  }
  function removeFromWatchlist(id) {
    var list = getWatchlist().filter(function (x) { return x !== id; });
    write(KEYS.watchlist, list);
  }

  function seriesWatchKey(seriesId) { return "series:" + seriesId; }
  function isSeriesInWatchlist(seriesId) { return getWatchlist().indexOf(seriesWatchKey(seriesId)) >= 0; }
  function toggleSeriesWatchlist(seriesId) {
    var list = getWatchlist();
    var key = seriesWatchKey(seriesId);
    var idx = list.indexOf(key);
    if (idx >= 0) list.splice(idx, 1); else list.push(key);
    write(KEYS.watchlist, list);
    return idx < 0;
  }
  function removeSeriesFromWatchlist(seriesId) {
    var list = getWatchlist().filter(function (x) { return x !== seriesWatchKey(seriesId); });
    write(KEYS.watchlist, list);
  }

  function categoryWatchKey(name) { return "cat:" + name; }
  function isCategoryInWatchlist(name) { return getWatchlist().indexOf(categoryWatchKey(name)) >= 0; }
  function toggleCategoryWatchlist(name) {
    var list = getWatchlist();
    var key = categoryWatchKey(name);
    var idx = list.indexOf(key);
    if (idx >= 0) list.splice(idx, 1); else list.push(key);
    write(KEYS.watchlist, list);
    return idx < 0;
  }
  function removeCategoryFromWatchlist(name) {
    var list = getWatchlist().filter(function (x) { return x !== categoryWatchKey(name); });
    write(KEYS.watchlist, list);
  }

  /* ---------- History ---------- */
  var MAX_HISTORY = 300;

  function getHistory() {
    var h = read(KEYS.history, []);
    if (!Array.isArray(h)) return [];
    return h.slice().sort(function (a, b) { return b.lastOpened - a.lastOpened; });
  }
  function addToHistory(id, extra) {
    var h = read(KEYS.history, []);
    if (!Array.isArray(h)) h = [];
    var entry = Object.assign({ id: id, lastOpened: now(), position: 0, duration: 0, progress: 0 }, extra || {});
    var idx = h.findIndex(function (x) { return x.id === id; });
    if (idx >= 0) h[idx] = entry; else h.push(entry);
    if (h.length > MAX_HISTORY) h.length = MAX_HISTORY;
    write(KEYS.history, h);
  }
  function getHistoryEntry(id) {
    return read(KEYS.history, []).find(function (h) { return h.id === id; }) || null;
  }
  function clearHistory() { write(KEYS.history, []); }

  /* ---------- Progress ---------- */
  function getProgress() {
    var p = read(KEYS.progress, {});
    if (!p || typeof p !== "object" || Array.isArray(p)) return {};
    return p;
  }
  function getProgressFor(id) {
    return getProgress()[id] || { position: 0, duration: 0, progress: 0, updatedAt: 0 };
  }
  function saveProgress(id, position, duration) {
    var p = getProgress();
    var d = duration || 0;
    var pc = d > 0 ? Math.min(100, Math.round((position / d) * 100)) : 0;
    p[id] = { position: position || 0, duration: d, progress: pc, updatedAt: now() };
    write(KEYS.progress, p);
    var h = getHistoryEntry(id);
    if (h) { addToHistory(id, Object.assign({}, h, { position: position || 0, duration: d, progress: pc })); }
    return p[id];
  }
  function clearProgressFor(id) {
    var p = getProgress();
    if (p[id]) { delete p[id]; write(KEYS.progress, p); }
  }

  /* ---------- Watched ---------- */
  function getWatched() {
    var w = read(KEYS.watched, {});
    if (!w || typeof w !== "object" || Array.isArray(w)) return {};
    return w;
  }
  function isWatched(id) { return !!getWatched()[id]; }
  function markWatched(id) {
    var w = getWatched();
    w[id] = true;
    write(KEYS.watched, w);
  }
  function markUnwatched(id) {
    var w = getWatched();
    if (w[id]) { delete w[id]; write(KEYS.watched, w); }
  }

  /* ---------- Settings ---------- */
  function getSettings() {
    return Object.assign({}, read(KEYS.settings, {}));
  }
  function saveSettings(patch) {
    write(KEYS.settings, Object.assign(getSettings(), patch));
  }

  /* ---------- Library wide ops ---------- */
  function clearLibrary() {
    itemsCache = [];
    schedulePersist();
    write(KEYS.watchlist, []);
    write(KEYS.history, []);
    write(KEYS.progress, {});
    write(KEYS.watched, {});
  }

  function resetAll() {
    memClear();
    Object.keys(KEYS).forEach(function (k) { try { localStorage.removeItem(KEYS[k]); } catch (e) { /* ignore */ } });
    itemsCache = [];
    getDB().then(function (db) { return idbDelete(db, ITEM_DB_KEY); }).catch(function () { /* ignore */ });
  }

  /* ---------- Boot ---------- */
  function init() {
    return new Promise(function (resolve) {
      function finishFrom(data) {
        var rep = repairItems(Array.isArray(data) ? data.filter(isValidItem) : []);
        itemsCache = rep.items;
        if (rep.changed) schedulePersist();
        resolve();
      }
      function fromLegacy() {
        finishFrom(read(KEYS.items, []));
      }
      getDB().then(function (db) {
        return idbGet(db, ITEM_DB_KEY);
      }).then(function (data) {
        if (data) {
          finishFrom(data);
          // keep a small localStorage mirror for older versions / fallback
          if (data.length <= 20000) {
            var s = JSON.stringify(data);
            if (s.length <= LS_MIRROR_LIMIT) write(KEYS.items, data);
            else { memDrop(KEYS.items); try { localStorage.removeItem(KEYS.items); } catch (e) { /* ignore */ } }
          } else {
            memDrop(KEYS.items);
            try { localStorage.removeItem(KEYS.items); } catch (e) { /* ignore */ }
          }
        } else {
          fromLegacy();
        }
      }).catch(function () {
        fromLegacy();
      });
    });
  }

  var readyPromise = null;
  function ready() {
    if (!readyPromise) readyPromise = init();
    return readyPromise;
  }

  store = {
    KEYS: KEYS,
    uid: uid,
    now: now,
    ready: ready,
    setPersistErrorHandler: function (fn) { persistErrorHandler = fn; },
    getItems: getItems,
    saveItems: saveItems,
    getItem: getItem,
    addItem: addItem,
    updateItem: updateItem,
    removeItem: removeItem,
    getWatchlist: getWatchlist,
    isInWatchlist: isInWatchlist,
    toggleWatchlist: toggleWatchlist,
    removeFromWatchlist: removeFromWatchlist,
    isSeriesInWatchlist: isSeriesInWatchlist,
    toggleSeriesWatchlist: toggleSeriesWatchlist,
    removeSeriesFromWatchlist: removeSeriesFromWatchlist,
    isCategoryInWatchlist: isCategoryInWatchlist,
    toggleCategoryWatchlist: toggleCategoryWatchlist,
    removeCategoryFromWatchlist: removeCategoryFromWatchlist,
    getPins: getPins,
    isPinned: isPinned,
    togglePin: togglePin,
    getHistory: getHistory,
    addToHistory: addToHistory,
    getHistoryEntry: getHistoryEntry,
    clearHistory: clearHistory,
    getProgress: getProgress,
    getProgressFor: getProgressFor,
    saveProgress: saveProgress,
    clearProgressFor: clearProgressFor,
    getWatched: getWatched,
    isWatched: isWatched,
    markWatched: markWatched,
    markUnwatched: markUnwatched,
    getSettings: getSettings,
    saveSettings: saveSettings,
    clearLibrary: clearLibrary,
    resetAll: resetAll
  };

  global.Store = store;
})(window);
