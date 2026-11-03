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
    pins: "iptv_pins",
    lastSeriesSeason: "iptv_last_series_season"
  };

  var DB_NAME = "iptv-app";
  var DB_STORE = "library";
  var ITEM_DB_KEY = "items";
  var INDEX_DB_KEY = "indexes";
  var INDEX_VERSION = 1;
  var LS_MIRROR_LIMIT = 2500000; // chars; mirror to localStorage only when small

  var store = {};

  var itemsCache = null;
  var persistTimer = null;
  var persistErrorHandler = null;
  var dbPromise = null;
  var idbFailed = false;

  /* ---------- Lazy indexes for fast navigation on huge libraries ----------
     These indexes are invalidated on every write and rebuilt on demand.
     They store references to the same item objects, so memory overhead is
     small and all existing code keeps working unchanged. */
  var idxDirty = true;
  var idxById = {};
  var idxByType = { movie: [], episode: [], series: [] };
  var idxMovies = [];      /* non-live movies */
  var idxLive = [];        /* live channels (type movie, live:true) */
  var idxEpisodes = [];    /* type episode */
  var idxByGroup = {};     /* group name -> items (non-episode) */
  var idxCategoryPosters = {};
  var idxSeries = {};      /* seriesId -> series record */
  var idxSeriesList = [];  /* cached seriesList result */
  var idxRecentAdded = []; /* items sorted by addedAt desc */

  function isLiveSource(source) {
    var s = String(source == null ? "" : source).trim();
    if (!s || s.indexOf("<") === 0) return false;
    var lc = s.toLowerCase();
    /* Explicit VOD/series paths mean the stream is on-demand even when it is
       served as HLS (.m3u8) — Xtream /movie/ and /series/ endpoints do that. */
    if (/\/movie\//.test(lc) || /\/series\//.test(lc)) return false;
    if (/\.m3u8(?:\?|#|$)/.test(lc)) return true;
    if (/\/live\//.test(lc)) return true;
    if (/\/hls\//.test(lc)) return true;
    if (/\/(?:live|hls)\./.test(lc)) return true;
    if (/^(?:rtmp|rtmps|rtsp|udp|srt|mms):\/\//.test(lc)) return true;
    return false;
  }

  function itemIsLive(it) {
    if (typeof it.live === "boolean") return it.live;
    /* Items without an explicit live flag: use the source heuristic, but also
       respect the mediaType — embed sources are never live channels. */
    if (it.mediaType === "embed") return false;
    return isLiveSource(it.source);
  }

  function buildSeriesRecord(seriesId, seriesName) {
    return {
      seriesId: seriesId,
      seriesName: seriesName,
      poster: "",
      description: "",
      group: "",
      episodes: []
    };
  }

  function rebuildIndexes() {
    if (!idxDirty) return;
    idxDirty = false;

    var items = itemsCache || [];
    idxById = {};
    idxByType = { movie: [], episode: [], series: [] };
    idxMovies = [];
    idxLive = [];
    idxEpisodes = [];
    idxByGroup = {};
    idxCategoryPosters = {};
    idxSeries = {};

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.id) continue;
      idxById[it.id] = it;

      var type = it.type;
      if (type !== "episode" && type !== "series") type = "movie";
      if (type === "episode") {
        idxByType.episode.push(it);
        idxEpisodes.push(it);
        var skey = it.seriesId;
        if (!skey) {
          var raw = it.seriesName || it.title || "";
          skey = "series-" + (raw.length < 50 ? raw.toLowerCase().replace(/\s+/g, "-") : raw.slice(0, 50).toLowerCase().replace(/\s+/g, "-"));
        }
        var rec = idxSeries[skey];
        if (!rec) { rec = buildSeriesRecord(skey, it.seriesName || it.title); idxSeries[skey] = rec; }
        rec.episodes.push(it);
        if (it.poster && !rec.poster) rec.poster = it.poster;
        if (it.description && !rec.description) rec.description = it.description;
        if (it.group && !rec.group) rec.group = it.group;
      } else if (type === "series") {
        idxByType.series.push(it);
        var rec2 = idxSeries[it.seriesId];
        if (!rec2) { rec2 = buildSeriesRecord(it.seriesId, it.seriesName || it.title); idxSeries[it.seriesId] = rec2; }
        if (it.poster) rec2.poster = it.poster;
        if (it.description) rec2.description = it.description;
        if (it.group) rec2.group = it.group;
      } else {
        idxByType.movie.push(it);
        /* Inline live check: if live flag is boolean use it, else check source. */
        var live = it.live;
        if (typeof live !== "boolean") {
          if (it.mediaType === "embed") live = false;
          else live = isLiveSource(it.source);
        }
        if (live) {
          idxLive.push(it);
        } else {
          idxMovies.push(it);
        }
        var gname = it.group || "Uncategorized";
        var garr = idxByGroup[gname];
        if (!garr) { garr = []; idxByGroup[gname] = garr; }
        garr.push(it);
        if (it.poster && !idxCategoryPosters[gname]) idxCategoryPosters[gname] = it.poster;
      }
    }

    /* Sort episodes inside each series and build the series list. */
    idxSeriesList = [];
    for (var sid in idxSeries) {
      if (!idxSeries.hasOwnProperty(sid)) continue;
      var s = idxSeries[sid];
      s.episodes.sort(function (a, b) {
        var sa = (a.season || 0) - 0, sb = (b.season || 0) - 0;
        if (sa !== sb) return sa - sb;
        return ((a.episodeNumber || 0) - 0) - ((b.episodeNumber || 0) - 0);
      });
      idxSeriesList.push(s);
    }
    idxSeriesList.sort(function (a, b) {
      var sa = a.seriesName || "", sb = b.seriesName || "";
      if (sa < sb) return -1;
      if (sa > sb) return 1;
      return 0;
    });

    /* idxRecentAdded is built lazily by getRecentAdded() to avoid O(n) work
       on every rebuild when it's not needed. */
    idxRecentAdded = [];
  }

  function markIndexesDirty() {
    idxDirty = true;
  }

  function getIndexedById() {
    rebuildIndexes();
    return idxById;
  }

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
    if (itemsCache) {
      return itemsCache;
    }
    var legacy = read(KEYS.items, []);
    if (!Array.isArray(legacy)) legacy = [];
    var rep = repairItems(legacy.filter(isValidItem));
    itemsCache = rep.items;
    markIndexesDirty();
    if (rep.changed) schedulePersist();
    return itemsCache;
  }

  function saveItems(list) {
    if (!Array.isArray(list)) { itemsCache = []; }
    else if (list.length > 50000) { itemsCache = list; }
    else { itemsCache = list.filter(isValidItem); }
    markIndexesDirty();
    schedulePersist();
    return true;
  }

  function persistNow() {
    var snapshot = itemsCache || [];
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
      var tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(snapshot, ITEM_DB_KEY);
      tx.objectStore(DB_STORE).put(serializeIndexes(), INDEX_DB_KEY);
      return new Promise(function (resolve, reject) {
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error || new Error("idb-put")); };
      });
    }).catch(function () {
      if (small && lsSize <= LS_MIRROR_LIMIT) return; // localStorage mirror is enough
      if (persistErrorHandler) {
        persistErrorHandler("Library is too large for localStorage and IndexedDB is unavailable — items will be lost after reload. Use a Chromium-based browser for full large-library support.");
      }
    });
  }

  function serializeIndexes() {
    rebuildIndexes();
    var series = [];
    for (var i = 0; i < idxSeriesList.length; i++) {
      var s = idxSeriesList[i];
      var epIds = [];
      for (var j = 0; j < s.episodes.length; j++) epIds.push(s.episodes[j].id);
      series.push([s.seriesId, s.seriesName, s.poster, s.description, s.group, epIds]);
    }
    var groups = {};
    for (var g in idxByGroup) {
      if (!idxByGroup.hasOwnProperty(g)) continue;
      var arr = idxByGroup[g];
      var ids = [];
      for (var k = 0; k < arr.length; k++) ids.push(arr[k].id);
      groups[g] = ids;
    }
    var recentIds = [];
    for (var r = 0; r < idxRecentAdded.length; r++) recentIds.push(idxRecentAdded[r].id);
    return {
      v: INDEX_VERSION,
      count: itemsCache.length,
      series: series,
      groups: groups,
      posters: idxCategoryPosters,
      recentAdded: recentIds
    };
  }

  function rehydrateIndexes(data, items) {
    if (!data || data.v !== INDEX_VERSION || data.count !== items.length) return false;
    try {
      idxById = {};
      idxByType = { movie: [], episode: [], series: [] };
      idxMovies = [];
      idxLive = [];
      idxEpisodes = [];
      idxByGroup = {};
      idxCategoryPosters = data.posters ? Object.assign({}, data.posters) : {};
      idxSeries = {};
      idxSeriesList = [];
      idxRecentAdded = [];

      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it || !it.id) continue;
        idxById[it.id] = it;
        var type = it.type;
        if (type !== "movie" && type !== "episode" && type !== "series") type = "movie";
        idxByType[type].push(it);
        if (type === "episode") idxEpisodes.push(it);
        else if (type === "movie") {
          if (itemIsLive(it)) idxLive.push(it); else idxMovies.push(it);
        }
      }

      /* Rebuild groups from persisted ids. */
      for (var g in data.groups) {
        if (!data.groups.hasOwnProperty(g)) continue;
        var ids = data.groups[g];
        var list = [];
        for (var j = 0; j < ids.length; j++) {
          var item = idxById[ids[j]];
          if (item) list.push(item);
        }
        idxByGroup[g] = list;
      }

      /* Rebuild series from persisted data. */
      var persistedSeries = data.series;
      for (var s = 0; s < persistedSeries.length; s++) {
        var rec = persistedSeries[s];
        var epIds = rec[5] || [];
        var episodes = [];
        for (var e = 0; e < epIds.length; e++) {
          var ep = idxById[epIds[e]];
          if (ep) episodes.push(ep);
        }
        idxSeries[rec[0]] = {
          seriesId: rec[0],
          seriesName: rec[1],
          poster: rec[2],
          description: rec[3],
          group: rec[4],
          episodes: episodes
        };
        idxSeriesList.push(idxSeries[rec[0]]);
      }

      /* Recent added order. */
      var recentIds = data.recentAdded || [];
      for (var r = 0; r < recentIds.length; r++) {
        var ri = idxById[recentIds[r]];
        if (ri) idxRecentAdded.push(ri);
      }

      idxDirty = false;
      return true;
    } catch (e) {
      return false;
    }
  }

  function schedulePersist() {
    if (persistTimer) return;
    /* Large libraries: defer persist longer so the UI can render first.
       Small libraries: persist quickly. */
    var delay = (itemsCache && itemsCache.length > 50000) ? 300 : 50;
    persistTimer = setTimeout(function () {
      persistTimer = null;
      persistNow();
    }, delay);
  }

  /* Flush pending writes when the tab is about to close. */
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", function () {
      if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; persistNow(); }
    });
  }

  function getItem(id) {
    rebuildIndexes();
    return idxById[id] || null;
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
    markIndexesDirty();
    schedulePersist();
    return item;
  }

  function updateItem(id, patch) {
    var items = getItems();
    var idx = items.findIndex(function (it) { return it.id === id; });
    if (idx < 0) return null;
    items[idx] = Object.assign({}, items[idx], patch, { id: id });
    markIndexesDirty();
    schedulePersist();
    return items[idx];
  }

  function removeItem(id) {
    var items = getItems().filter(function (it) { return it.id !== id; });
    itemsCache = items;
    markIndexesDirty();
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

  /* ---------- Last watched series season ---------- */
  /* Remembers which season the user was on when they last played an episode,
     so returning to a series page without a ?season= query (e.g. via the
     device/remote back button) restores that season instead of season 1. */
  function getLastSeriesSeason(seriesId) {
    var map = read(KEYS.lastSeriesSeason, {});
    if (!map || typeof map !== "object" || Array.isArray(map)) return null;
    var s = map[seriesId];
    return s == null ? null : Number(s);
  }

  function setLastSeriesSeason(seriesId, season) {
    if (!seriesId) return;
    var map = read(KEYS.lastSeriesSeason, {});
    if (!map || typeof map !== "object" || Array.isArray(map)) map = {};
    if (season == null) delete map[seriesId];
    else map[seriesId] = Number(season);
    write(KEYS.lastSeriesSeason, map);
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
    /* Keep newest entries: sort by lastOpened desc, then cap. */
    if (h.length > MAX_HISTORY) {
      h.sort(function (a, b) { return b.lastOpened - a.lastOpened; });
      h.length = MAX_HISTORY;
    }
    write(KEYS.history, h);
  }
  function getHistoryEntry(id) {
    return read(KEYS.history, []).find(function (h) { return h.id === id; }) || null;
  }
  function removeFromHistory(id) {
    var h = read(KEYS.history, []);
    if (!Array.isArray(h)) return;
    var idx = h.findIndex(function (x) { return x.id === id; });
    if (idx >= 0) {
      h.splice(idx, 1);
      write(KEYS.history, h);
    }
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

  /* ---------- Import options ----------
     Which content types are imported from playlists/providers. Live, Movies
     and Series default to on; Adult +18 defaults to off. A regex (off by
     default) can be used to skip any content whose text matches it. */
  function getImportOptions() {
    var o = getSettings().importOptions || {};
    return {
      live: o.live !== false,
      movies: o.movies !== false,
      series: o.series !== false,
      adult: !!o.adult,
      regexEnabled: !!o.regexEnabled,
      regex: o.regex || ""
    };
  }
  function setImportOption(key, value) {
    var o = Object.assign({}, getSettings().importOptions || {});
    o[key] = typeof value === "string" ? value : !!value;
    saveSettings({ importOptions: o });
  }

  /* ---------- Library wide ops ---------- */
  function clearLibrary() {
    itemsCache = [];
    markIndexesDirty();
    schedulePersist();
    write(KEYS.watchlist, []);
    write(KEYS.history, []);
    write(KEYS.progress, {});
    write(KEYS.watched, {});
    /* Pins and the last-watched-season map reference specific item/series
       ids — dangling references once every item is gone, so they'd
       otherwise just sit there unused until a full Reset. */
    write(KEYS.pins, []);
    write(KEYS.lastSeriesSeason, {});
  }

  function resetAll() {
    memClear();
    Object.keys(KEYS).forEach(function (k) { try { localStorage.removeItem(KEYS[k]); } catch (e) { /* ignore */ } });
    itemsCache = [];
    markIndexesDirty();
    return getDB().then(function (db) {
      var tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).delete(ITEM_DB_KEY);
      tx.objectStore(DB_STORE).delete(INDEX_DB_KEY);
      return new Promise(function (resolve, reject) {
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    }).catch(function () { /* ignore */ });
  }

  /* ---------- Boot ---------- */
  function init() {
    return new Promise(function (resolve) {
      /* Repair legacy items (stale embed-marker sources) in the background,
         after the first render can already happen. This only ever touches
         pre-existing corrupted entries from older parser versions — almost
         always a no-op — so a huge library shouldn't pay an O(n) scan for it
         before its first paint on every single reload. */
      function repairInBackground() {
        setTimeout(function () {
          var rep = repairItems(itemsCache);
          if (rep.changed) {
            itemsCache = rep.items;
            markIndexesDirty();
            schedulePersist();
          }
        }, 0);
      }
      function finishFrom(data) {
        itemsCache = Array.isArray(data) ? data.filter(isValidItem) : [];
        markIndexesDirty();
        resolve();
        repairInBackground();
      }
      function fromLegacy() {
        finishFrom(read(KEYS.items, []));
      }
      getDB().then(function (db) {
        var tx = db.transaction(DB_STORE, "readonly");
        var store = tx.objectStore(DB_STORE);
        var itemsReq = store.get(ITEM_DB_KEY);
        var idxReq = store.get(INDEX_DB_KEY);
        var items = null;
        var indexes = null;
        var doneCount = 0;
        function checkDone() {
          if (++doneCount < 2) return;
          if (items) {
            finishFrom(items);
            if (indexes && rehydrateIndexes(indexes, itemsCache)) {
              /* indexes restored; nothing else to do */
            } else {
              rebuildIndexes();
            }
            /* Keep a small localStorage mirror for older versions / fallback.
               Deferred so JSON.stringify-ing a medium/large library never
               delays first paint. */
            setTimeout(function () {
              if (itemsCache.length <= 20000) {
                var s = JSON.stringify(itemsCache);
                if (s.length <= LS_MIRROR_LIMIT) write(KEYS.items, itemsCache);
                else { memDrop(KEYS.items); try { localStorage.removeItem(KEYS.items); } catch (e) { /* ignore */ } }
              } else {
                memDrop(KEYS.items);
                try { localStorage.removeItem(KEYS.items); } catch (e) { /* ignore */ }
              }
            }, 0);
          } else {
            fromLegacy();
          }
        }
        itemsReq.onsuccess = function () { items = itemsReq.result; checkDone(); };
        itemsReq.onerror = function () { items = null; checkDone(); };
        idxReq.onsuccess = function () { indexes = idxReq.result; checkDone(); };
        idxReq.onerror = function () { indexes = null; checkDone(); };
      }).catch(function () {
        fromLegacy();
      });
    });
  }

  /* Fast getters used by the UI for large libraries. These rebuild the lazy
     indexes on first use after any write. */
  function getMovieItems() {
    rebuildIndexes();
    return idxMovies.slice();
  }
  function getLiveItems() {
    rebuildIndexes();
    return idxLive.slice();
  }
  function getEpisodeItems() {
    rebuildIndexes();
    return idxEpisodes.slice();
  }
  function getSeriesList() {
    rebuildIndexes();
    return idxSeriesList.slice();
  }
  function getSeries(seriesId) {
    rebuildIndexes();
    var s = idxSeries[seriesId];
    return s ? {
      seriesId: s.seriesId,
      seriesName: s.seriesName,
      poster: s.poster,
      description: s.description,
      group: s.group,
      episodes: s.episodes.slice()
    } : null;
  }
  function getItemsByGroup(name) {
    rebuildIndexes();
    var list = idxByGroup[name] || [];
    return list.slice();
  }
  function getCategoryStats() {
    rebuildIndexes();
    var counts = {};
    for (var g in idxByGroup) {
      if (idxByGroup.hasOwnProperty(g)) counts[g] = idxByGroup[g].length;
    }
    return { counts: counts, posters: Object.assign({}, idxCategoryPosters) };
  }
  function getRecentAdded(count) {
    rebuildIndexes();
    if (!idxRecentAdded.length && itemsCache && itemsCache.length > 1000) {
      /* Build lazily only when actually needed, not during every rebuildIndexes. */
      idxRecentAdded = itemsCache.slice();
      for (var ri = 0, rj = idxRecentAdded.length - 1; ri < rj; ri++, rj--) {
        var tmp = idxRecentAdded[ri]; idxRecentAdded[ri] = idxRecentAdded[rj]; idxRecentAdded[rj] = tmp;
      }
    } else if (!idxRecentAdded.length && itemsCache && itemsCache.length <= 1000) {
      idxRecentAdded = itemsCache.slice().sort(function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); });
    }
    return idxRecentAdded.slice(0, count);
  }
  function getNonLiveItems() {
    rebuildIndexes();
    return idxMovies.concat(idxEpisodes).concat(idxByType.series);
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
    getMovieItems: getMovieItems,
    getLiveItems: getLiveItems,
    getEpisodeItems: getEpisodeItems,
    getNonLiveItems: getNonLiveItems,
    getRecentAdded: getRecentAdded,
    getSeriesList: getSeriesList,
    getSeries: getSeries,
    getItemsByGroup: getItemsByGroup,
    getCategoryStats: getCategoryStats,
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
    getLastSeriesSeason: getLastSeriesSeason,
    setLastSeriesSeason: setLastSeriesSeason,
    getHistory: getHistory,
    addToHistory: addToHistory,
    getHistoryEntry: getHistoryEntry,
    removeFromHistory: removeFromHistory,
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
    getImportOptions: getImportOptions,
    setImportOption: setImportOption,
    clearLibrary: clearLibrary,
    resetAll: resetAll
  };

  global.Store = store;
})(window);
