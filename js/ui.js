/* UI — renders all views (home, movies, series, details, search, settings)
   and shared components (cards, rows, modals, toasts). */
(function (global) {
  "use strict";

  var BUILD = 10;
  if (global.console) console.log("[build] ui.js v" + BUILD);

  var page = document.getElementById("app");
  var modalRoot = document.getElementById("modalRoot");
  var toastRoot = document.getElementById("toastRoot");

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function pad(n) { n = parseInt(n, 10) || 0; return n < 10 ? "0" + n : "" + n; }
  function fmt(sec) {
    if (!isFinite(sec) || sec <= 0) return "";
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ":" + pad(m) : m) + ":" + pad(s);
  }

  function toast(msg, type) {
    var el = document.createElement("div");
    el.className = "toast " + (type === "err" ? "err" : type === "ok" ? "ok" : "");
    el.textContent = msg;
    toastRoot.appendChild(el);
    setTimeout(function () {
      el.style.opacity = "0";
      el.style.transition = "opacity .3s";
      setTimeout(function () { el.remove(); }, 320);
    }, 2600);
  }

  /* ---------- import progress overlay ---------- */
  var progressEl = null;
  var progressStatusEl = null;

  function ensureProgressEl() {
    if (progressEl) return;
    progressEl = document.createElement("div");
    progressEl.className = "progress-overlay";
    progressEl.hidden = true;
    var card = document.createElement("div");
    card.className = "progress-card";
    var spin = document.createElement("div");
    spin.className = "progress-spinner";
    var title = document.createElement("div");
    title.className = "progress-title";
    title.textContent = "Importing…";
    progressStatusEl = document.createElement("div");
    progressStatusEl.className = "progress-status";
    card.appendChild(spin);
    card.appendChild(title);
    card.appendChild(progressStatusEl);
    progressEl.appendChild(card);
    document.body.appendChild(progressEl);
  }

  function showProgress(title, status) {
    ensureProgressEl();
    progressEl.querySelector(".progress-title").textContent = title || "Importing…";
    progressStatusEl.textContent = status || "";
    progressEl.hidden = false;
  }

  function setProgressStatus(text) {
    if (progressStatusEl) progressStatusEl.textContent = text;
  }

  function hideProgress() {
    if (progressEl) progressEl.hidden = true;
    if (progressStatusEl) progressStatusEl.textContent = "";
  }

  /* ---------- data helpers ---------- */
  /* Live items (Xtream channels, HLS/TS/DASH streams) are kept out of Home,
     Movies and Series — they live in the dedicated Live view instead. The
     live flag is decided once at import time (M3U parser / Xtream fetch) and
     trusted here so an item is never re-classified just because its URL ends
     in .m3u8 or contains /live/ — that re-check is what leaked movies into
     the Live section and live channels into Movies. */
  function isLiveItem(it) {
    if (!it) return false;
    if (typeof it.live === "boolean") return it.live;
    if (it.mediaType === "embed") return false;
    var s = String(it.source || "");
    var lc = s.toLowerCase();
    if (/\/movie\//.test(lc) || /\/series\//.test(lc)) return false;
    if (/\.m3u8(?:\?|#|$)/.test(lc)) return true;
    if (/\/live\//.test(lc)) return true;
    if (/\/hls\//.test(lc)) return true;
    if (/\/(?:live|hls)\./.test(lc)) return true;
    if (/^(?:rtmp|rtmps|rtsp|udp|srt|mms):\/\//.test(lc)) return true;
    return false;
  }

  /* Adult content is detected by its category/group or title wording (IPTV
     providers usually label these channels plainly). The +18 Import Option
     gates these — they are only imported when explicitly enabled. */
  var ADULT_RE = /(?:^|[^a-z0-9])(?:adult|xxx|18\+|18plus|nsfw|erotic|erotik|explicit|onlyfans|porntv|pornhub|hardcore|playboy|bangbros|brazzers|sexvideos|pornstar)(?:$|[^a-z0-9])/i;

  function isAdultItem(it) {
    if (!it) return false;
    var hay = String(it.group || "") + " " + String(it.title || "") + " " + String(it.tvgName || "");
    return ADULT_RE.test(hay);
  }

  /* Should an item be imported given the current Import Options?
     Episodes and series containers belong to the "Series" toggle, live
     channels to "Live", everything else to "Movies". Adult content is gated
     by its own toggle first, so it never leaks through another type. */
  function shouldImportItem(it) {
    if (!it) return false;
    var opts = Store.getImportOptions();
    if (isAdultItem(it)) return !!opts.adult;
    if (it.type === "episode" || it.type === "series") return !!opts.series;
    if (it.live) return !!opts.live;
    return !!opts.movies;
  }

  function filterImportItems(items) {
    if (!items || !items.length) return items || [];
    var re = buildRegexFilter();
    return items.filter(function (it) {
      if (!shouldImportItem(it)) return false;
      if (!re) return true;
      var hay = String(it.title || "") + " " + String(it.group || "")
        + " " + String(it.seriesName || "") + " " + String(it.episodeTitle || "")
        + " " + String(it.tvgName || "");
      return !re.test(hay);
    });
  }

  /* Normalize a user-entered pattern. JavaScript has no inline (?i) flag
     (that's PCRE/Python syntax) and would throw a SyntaxError for it, but we
     already compile everything case-insensitively, so (?i) is redundant —
     strip it wherever it appears. */
  function sanitizeRegex(pattern) {
    return String(pattern || "").replace(/\(\?i\)/gi, "").trim();
  }

  /* Compile the user's skip-regex once per filter pass (never once per item).
     Returns null when disabled, empty, or un-compilable — meaning no filter. */
  function buildRegexFilter() {
    var opts = Store.getImportOptions();
    if (!opts.regexEnabled) return null;
    var pattern = sanitizeRegex(opts.regex);
    if (!pattern) return null;
    try { return new RegExp(pattern, "i"); } catch (e) { return null; }
  }

  /* Non-empty when the regex option is enabled but the pattern won't compile,
     so imports can warn the user instead of silently filtering nothing. */
  function invalidRegexWarning() {
    var opts = Store.getImportOptions();
    if (!opts.regexEnabled || !opts.regex) return "";
    var pattern = sanitizeRegex(opts.regex);
    if (!pattern) return "the pattern is empty.";
    try { new RegExp(pattern, "i"); return ""; } catch (e) {
      return "\u201C" + opts.regex + "\u201D is not a valid regular expression.";
    }
  }

  function liveItems() {
    return Store.getLiveItems();
  }

  function movies() {
    return Store.getMovieItems();
  }

  function episodes() {
    return Store.getEpisodeItems();
  }

  function seriesList() {
    return Store.getSeriesList();
  }

  /* Index of series keyed by seriesId, built from a single full pass over the
     library (cheap), reused by renderHome so it never calls seriesList() again
     per item. */
  function seriesById(list) {
    list = list || seriesList();
    var map = {};
    for (var i = 0; i < list.length; i++) map[list[i].seriesId] = list[i];
    return map;
  }

  function getSeries(seriesId) {
    return Store.getSeries(seriesId);
  }

  /* Deduplicated in-flight lazy loads for Xtream series whose episodes are not
     imported eagerly (see Xtream.fetchSeriesEpisodes). Resolves to the episode
     items after they are merged into the library. */
  var xtSeriesLoading = {};

  /* In-flight background "fill every series" fetch; prevents restarts from
     re-running while a fill is already in progress. */
  var allFetchPromise = null;

  /* Set once a fill completes, so merely visiting the Series page does not
     immediately restart a fill for series that failed; the button still lets
     the user retry manually. */
  var allFetchDoneOnce = false;

  /* When true, an import automatically starts the background fill. */
  var xtSeriesAutoFill = false;

  /* Network-only fetch of a series' episodes (no merge/persist), shared by the
     lazy open path and the background fill so one place owns credentials. */
  function fetchSeriesEpisodesItems(seriesId, rec) {
    var settings = Store.getSettings();
    var container = Store.getItem(seriesId) || {};
    var base = container.xtBase || (settings.xtream && settings.xtream.base) || "";
    var regs = settings.xtreamProviders || {};
    var creds = regs[base] || (settings.xtream && settings.xtream.base === base ? settings.xtream : null);
    var ctx = creds ? { base: base, username: creds.username, password: creds.password } : null;
    if (!ctx || !ctx.base || !ctx.username || !ctx.password) {
      return Promise.reject(new Error("This series' provider is no longer connected. Re-import that provider to load its episodes."));
    }
    return global.Xtream.fetchSeriesEpisodes(ctx, seriesId, rec.seriesName, rec.group);
  }

  function loadXtreamEpisodes(seriesId, rec) {
    if (xtSeriesLoading[seriesId]) return xtSeriesLoading[seriesId];
    var p = fetchSeriesEpisodesItems(seriesId, rec)
      .then(function (eps) {
        delete xtSeriesLoading[seriesId];
        if (!eps || !eps.length) return [];
        return queuedMerge(eps).then(function () { return eps; });
      })
      .catch(function (err) {
        delete xtSeriesLoading[seriesId];
        throw err;
      });
    xtSeriesLoading[seriesId] = p;
    return p;
  }

  /* Fetch missing episodes for every series that has none, in the background.
     Network requests run concurrently, but per-series library merges are
     batched: rebuilding the whole library index once per series is what made
     the app grind to a halt on a 50k-series provider. The fill also pauses
     while the player is active so it never competes with video/live playback.
     `listArg` is optional. Safe to call repeatedly: while a fill is running the
     in-flight promise is returned, and once every series has episodes it is a
     no-op. Resolves to the number of series that yielded episodes. */
  function fetchAllSeriesEpisodes(listArg) {
    if (allFetchPromise) return allFetchPromise;
    /* Skip series that would be excluded by the Import Options (e.g. Adult
       content with the +18 toggle off, or all series with Series off, or a
       name/group matching the skip regex). */
    var re = buildRegexFilter();
    var list = (listArg || seriesList()).filter(function (s) {
      if (s.episodes.length) return false;
      var pseudo = {
        type: "series",
        group: s.group,
        title: s.seriesName,
        seriesName: s.seriesName
      };
      if (!shouldImportItem(pseudo)) return false;
      if (re) {
        var hay = String(s.seriesName || "") + " " + String(s.group || "");
        if (re.test(hay)) return false;
      }
      return true;
    });
    if (!list.length) return Promise.resolve(0);
    var total = list.length;
    var done = 0, found = 0, failed = 0;
    var CONC = 4;
    var BATCH = 5000;
    var buffer = [];
    var flushBusy = null;
    var i = 0;
    var statusTimer = null;

    function setStatus() {
      if (statusTimer) return;
      statusTimer = setTimeout(function () {
        statusTimer = null;
        var btn = document.getElementById("seriesFetchBtn");
        if (btn) btn.textContent = "Fetching series episodes… " + done + " / " + total + (found ? " · " + found + " with episodes" : "");
      }, 200);
    }

    function flush() {
      if (!buffer.length) return Promise.resolve();
      if (flushBusy) return flushBusy;
      var items = buffer;
      buffer = [];
      flushBusy = queuedMerge(items).then(function (c) { flushBusy = null; return c; });
      flushBusy.catch(function () { flushBusy = null; });
      return flushBusy;
    }

    function drain() {
      return flush().then(function () { return buffer.length ? drain() : null; });
    }

    function playerBusy() {
      var p = global.Player;
      return !!(p && typeof p.isActive === "function" && p.isActive());
    }

    function fetchOne(s) {
      function tryFetch() {
        return fetchSeriesEpisodesItems(s.seriesId, s).then(function (eps) {
          if (eps && eps.length) {
            found++;
            buffer.push.apply(buffer, eps);
          }
        });
      }
      return tryFetch().catch(function () {
        /* trial providers occasionally throttle bursts; retry once */
        return tryFetch().catch(function () { failed++; });
      });
    }

    function next() {
      if (i >= list.length) return Promise.resolve();
      var s = list[i++];
      function step() {
        return fetchOne(s).then(function () {
          done++;
          setStatus();
        });
      }
      if (playerBusy()) {
        /* Don't compete with playback: persist what we have and wait until the
           player closes before fetching more. */
        return flush().then(function () {
          return new Promise(function (resolveWait) {
            var iv = setInterval(function () {
              if (!playerBusy()) {
                clearInterval(iv);
                resolveWait(step().then(function () { return next(); }));
              }
            }, 800);
          });
        });
      }
      return step().then(function () { return next(); });
    }

    var workers = [];
    for (var k = 0; k < CONC; k++) workers.push(next());
    var p = Promise.all(workers).then(function () {
      return drain().then(function () {
        allFetchPromise = null;
        allFetchDoneOnce = true;
        toast("Fetched series episodes · " + found + " populated" + (failed ? " · " + failed + " skipped" : ""), "ok");
        if (global.App && App.render) App.render();
        return found;
      });
    });
    p.catch(function () { allFetchPromise = null; });
    allFetchPromise = p;
    return p;
  }

  function episodeLabel(ep) {
    var s = ep.season == null ? 0 : ep.season;
    var e = ep.episodeNumber == null ? 0 : ep.episodeNumber;
    return "S" + pad(s) + "E" + pad(e);
  }

  function progressOf(id) {
    return Store.getProgressFor(id);
  }

  function isWatched(id) {
    return Store.isWatched(id);
  }

  /* ---------- poster ---------- */
  function posterEl(item, cls) {
    var wrap = document.createElement("div");
    wrap.className = (cls || "card-poster");
    if (item.poster) {
      var img = document.createElement("img");
      img.alt = item.title;
      img.loading = "lazy";
      bindPosterImage(img, wrap);
      img.src = item.poster;
      wrap.appendChild(img);
    } else {
      wrap.appendChild(fallbackIcon(wrap));
    }
    return wrap;
  }

  function fallbackIcon(container) {
    var icon = document.createElement("span");
    icon.className = "poster-fallback";
    icon.textContent = "▶";
    container.appendChild(icon);
    return icon;
  }

  /* Robust poster loading: falls back to the placeholder icon on error, on a
     zero-size load, and when a stuck/blocked image has not finished loading a
     while after becoming visible (the browser does not always fire "error",
     e.g. mixed-content blocks or hung servers). */
  function bindPosterImage(img, container, iconChar) {
    var done = false;
    function showFallback() {
      if (done || !img.parentNode) return;
      done = true;
      try { img.remove(); } catch (e) { /* ignore */ }
      var icon = document.createElement("span");
      icon.className = "poster-fallback";
      icon.textContent = iconChar || "▶";
      container.appendChild(icon);
    }
    img.addEventListener("error", showFallback);
    img.addEventListener("load", function () {
      if (img.naturalWidth === 0) showFallback();
    });
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        io.disconnect();
        if (entries[0].isIntersecting) {
          setTimeout(function () {
            if (!img.complete) showFallback();
          }, 8000);
        }
      }, { rootMargin: "200px" });
      try { io.observe(img); } catch (e) { /* ignore */ }
    }
  }

  /* ---------- card ---------- */
  function card(item, opts) {
    opts = opts || {};
    var el = document.createElement("button");
    el.className = "card focusable";
    el.setAttribute("role", "button");
    el.dataset.card = item.id;
    el.setAttribute("aria-label", item.title + (isWatched(item.id) ? " (watched)" : ""));

    var poster = posterEl(item);
    poster.style.width = "100%";

    if (item.mediaType === "embed") {
      var badgeType = document.createElement("span");
      badgeType.className = "badge-type embed";
      badgeType.textContent = "EMBED";
      poster.appendChild(badgeType);
    }

    if (isWatched(item.id)) {
      var badge = document.createElement("span");
      badge.className = "card-badge watched";
      badge.textContent = "WATCHED";
      poster.appendChild(badge);
    }

    el.appendChild(poster);

    var body = document.createElement("div");
    body.className = "card-body";
    var title = document.createElement("div");
    title.className = "card-title";
    title.textContent = item.type === "episode" ? (episodeLabel(item) + (item.episodeTitle ? " · " + item.episodeTitle : "")) : item.title;
    body.appendChild(title);
    var sub = document.createElement("div");
    sub.className = "card-sub";
    sub.textContent = item.group || (item.type === "episode" ? item.seriesName : "");
    body.appendChild(sub);
    el.appendChild(body);

    var prog = progressOf(item.id);
    if (prog && prog.progress > 0 && prog.progress < 100) {
      var pw = document.createElement("div");
      pw.className = "card-progress-wrap";
      var bar = document.createElement("div");
      bar.className = "pbar";
      bar.style.width = prog.progress + "%";
      pw.appendChild(bar);
      el.appendChild(pw);
    }

    el.addEventListener("click", function () { App.openItem(item.id); });
    return el;
  }

  /* ---------- rows ---------- */
  function makeRow(title, items, opts) {
    if (!items.length) return null;
    opts = opts || {};
    var section = document.createElement("section");
    section.className = "section";
    var header = document.createElement("div");
    header.className = "section-header";
    var h = document.createElement("h2");
    h.className = "section-title";
    h.textContent = title;
    header.appendChild(h);
    if (opts.link) {
      var a = document.createElement("a");
      a.className = "section-link focusable";
      a.href = opts.link.href;
      a.textContent = opts.link.label || "View all";
      a.addEventListener("click", function (e) {
        e.preventDefault();
        App.navigate(opts.link.href);
      });
      header.appendChild(a);
    }
    section.appendChild(header);
    var row = document.createElement("div");
    row.className = "row";
    items.forEach(function (it) {
      if (it && it.nodeType === 1) row.appendChild(it);
      else row.appendChild(card(it, opts));
    });
    section.appendChild(row);
    return section;
  }

  /* Renders items into a grid, loading a chunk at a time so huge libraries
     do not flood the DOM with thousands of cards at once. */
  function pagedGrid(root, items, cardFn, pageSize) {
    pageSize = pageSize || 120;
    var grid = document.createElement("div");
    grid.className = "grid";
    var i = 0;
    var btn = null;

    function syncBtn() {
      if (i >= items.length) {
        if (btn && btn.parentNode) btn.remove();
        btn = null;
      } else if (!btn) {
        btn = document.createElement("button");
        btn.className = "btn btn-primary focusable load-more";
        btn.textContent = "Load more";
        btn.addEventListener("click", addChunk);
        root.appendChild(btn);
      }
    }
    function addChunk() {
      var end = Math.min(i + pageSize, items.length);
      for (; i < end; i++) grid.appendChild(cardFn(items[i]));
      syncBtn();
    }

    root.appendChild(grid);
    addChunk();
    return grid;
  }

  /* A full-width search bar above a paged grid. Typing filters the items
     (case-insensitive substring over title/seriesName) and re-renders. */
  function searchableGrid(root, allItems, placeholder, cardFn) {
    var bar = document.createElement("div");
    bar.className = "search-bar";
    var search = document.createElement("input");
    search.type = "text";
    search.placeholder = placeholder;
    search.className = "focusable";
    bar.appendChild(search);
    root.appendChild(bar);
    var gridWrap = document.createElement("div");
    root.appendChild(gridWrap);

    /* Precompute lowercase search keys once so filtering huge libraries
       (100k+ items) never calls toLowerCase per item per keystroke. */
    var keys = new Array(allItems.length);
    for (var ki = 0; ki < allItems.length; ki++) {
      keys[ki] = String(allItems[ki].title || allItems[ki].seriesName || "").toLowerCase();
    }

    function renderGrid(list) {
      gridWrap.innerHTML = "";
      if (!list.length) {
        gridWrap.appendChild(emptyState("? ", "No matches", "No result matches your search."));
        return;
      }
      pagedGrid(gridWrap, list, cardFn);
    }

    function render(q) {
      var ql = (q || "").trim().toLowerCase();
      if (!ql) {
        renderGrid(allItems.slice());
        return;
      }
      var hits = [];
      var CHUNK = 8000;
      var i = 0;
      render.seq = (render.seq || 0) + 1;
      var seq = render.seq;
      function step() {
        /* A newer keystroke superseded this scan; drop it. */
        if (seq !== render.seq) return;
        var end = Math.min(i + CHUNK, allItems.length);
        for (; i < end; i++) {
          if (keys[i].indexOf(ql) >= 0) hits.push(allItems[i]);
        }
        if (i < allItems.length) {
          setTimeout(step, 0);
        } else if (seq === render.seq) {
          renderGrid(hits);
        }
      }
      step();
    }

    var timer = null;
    search.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () { render(search.value); }, 120);
    });
    render("");
  }

  function emptyState(icon, title, text, actionBtn) {
    var el = document.createElement("div");
    el.className = "empty";
    el.innerHTML = '<div class="big">' + icon + "</div>";
    var h = document.createElement("h3");
    h.textContent = title;
    var p = document.createElement("p");
    p.textContent = text;
    el.appendChild(h);
    el.appendChild(p);
    if (actionBtn) el.appendChild(actionBtn);
    return el;
  }

  function backButton(label, target) {
    var b = document.createElement("button");
    b.className = "btn btn-ghost btn-sm focusable back-btn";
    b.innerHTML = "&larr; " + (label || "Back");
    b.addEventListener("click", function () {
      if (target) App.navigate(target);
      else if (String(label || "").toLowerCase() === "home") App.navigate("#home");
      else App.goBack();
    });
    return b;
  }

  /* ---------- HOME ---------- */
  function renderHome() {
    var root = document.createElement("div");
    root.className = "page";

    var mv = Store.getMovieItems();

    var heroPool = mv.filter(function (m) { return m.poster; });
    if (!heroPool.length) heroPool = mv;
    var heroItem = heroPool.length ? heroPool[Math.floor(Math.random() * heroPool.length)] : null;
    if (heroItem) {
      root.appendChild(hero(heroItem));
    }

    var history = Store.getHistory();

    var recentItems = history
      .map(function (h) { return Store.getItem(h.id); })
      .filter(function (it) { return it && !isLiveItem(it); })
      .slice(0, 14);

    /* Build a map of seriesId -> {season, episode} from history so Recently
       Watched series cards open the right season and show the ep label. */
    var watchedInfoBySeries = {};
    recentItems.forEach(function (it) {
      if (it && it.type === "episode" && it.seriesId) {
        if (!watchedInfoBySeries[it.seriesId]) {
          watchedInfoBySeries[it.seriesId] = {
            season: it.season,
            episodeNumber: it.episodeNumber
          };
        }
      }
    });
    var watchedSeasonBySeries = {};
    for (var sid in watchedInfoBySeries) {
      if (watchedInfoBySeries.hasOwnProperty(sid)) {
        watchedSeasonBySeries[sid] = watchedInfoBySeries[sid].season;
      }
    }

    /* Build the series index once and reuse it everywhere below — the old
       code re-ran the full series scan for every watched/series entry,
       which made the home page crawl on large libraries. */
    var allSeries = seriesList();
    var sbyId = seriesById(allSeries);
    var seriesCardMap = {};

    var watchlist = [];
    var catStats = categoryStats();
    Store.getWatchlist().forEach(function (id) {
      if (id && id.indexOf("series:") === 0) {
        var s = sbyId[id.slice(7)];
        if (s) watchlist.push({ seriesRef: s });
      } else if (id && id.indexOf("cat:") === 0) {
        var cname = id.slice(4);
        if (cname && (catStats.counts[cname] || 0) > 0) watchlist.push(categoryCard(cname, catStats));
      } else {
        var it = Store.getItem(id);
        if (it) watchlist.push(it);
      }
    });

    var recentAdded = Store.getRecentAdded(14);

    appendIf(root, makeRow("Recently Watched", seriesCardFor(recentItems, seriesCardMap, sbyId, watchedSeasonBySeries, watchedInfoBySeries)));
    appendIf(root, makeRow("Watchlist", seriesCardFor(watchlist, seriesCardMap, sbyId)));
    appendIf(root, makeRow("Movies", mv.slice(0, 24), { link: { label: "View all", href: "#movies" } }));
    appendIf(root, makeRow("Series", seriesCards(allSeries.slice(0, 24)), { link: { label: "View all", href: "#series" } }));
    appendIf(root, makeRow("Categories", categoryCards(12, catStats), { link: { label: "View all", href: "#categories" } }));
    appendIf(root, makeRow("Recently Added", seriesCardFor(recentAdded, seriesCardMap, sbyId)));

    if (!root.querySelector("section")) {
      var btn = document.createElement("button");
      btn.className = "btn btn-primary focusable";
      btn.textContent = "Import your first M3U";
      btn.addEventListener("click", function () { App.navigate("#settings"); });
      root.appendChild(emptyState("▶", "Your library is empty", "Import an M3U playlist or add content manually to get started.", btn));
    }

    page.innerHTML = "";
    page.appendChild(root);
  }

  function appendIf(container, node) {
    if (node) container.appendChild(node);
  }

  function hero(item) {
    var el = document.createElement("div");
    el.className = "hero";
    var bg = document.createElement("div");
    bg.className = "hero-bg";
    if (item.poster) bg.style.backgroundImage = "url('" + escapeHtml(item.poster) + "')";
    bg.style.cursor = "pointer";
    bg.setAttribute("title", "Open " + item.title);
    bg.addEventListener("click", function () { App.openItem(item.id); });
    el.appendChild(bg);
    var body = document.createElement("div");
    body.className = "hero-body";
    var title = document.createElement("h1");
    title.className = "hero-title";
    title.textContent = item.title;
    var meta = document.createElement("div");
    meta.className = "hero-meta";
    meta.textContent = [item.group, item.mediaType === "embed" ? "Embed" : "Video"].filter(Boolean).join(" · ");
    var desc = document.createElement("p");
    desc.className = "hero-desc";
    desc.textContent = item.description || "Enjoy from your personal library.";
    var actions = document.createElement("div");
    actions.className = "hero-actions";
    var play = document.createElement("button");
    play.className = "btn btn-primary focusable";
    play.textContent = "▶ Play";
    play.addEventListener("click", function () { App.navigate("#play/" + encodeURIComponent(item.id)); });
    var details = document.createElement("button");
    details.className = "btn btn-ghost focusable";
    details.textContent = "Details";
    details.addEventListener("click", function () { App.openItem(item.id); });
    actions.appendChild(play);
    actions.appendChild(details);
    body.appendChild(title);
    body.appendChild(meta);
    body.appendChild(desc);
    body.appendChild(actions);
    el.appendChild(body);
    return el;
  }

  function seriesCards(list) {
    return list.map(function (s) {
      var epCount = s && s.episodes ? s.episodes.length : 0;
      var it = {
        id: s.seriesId,
        title: s.seriesName,
        poster: s.poster,
        group: s.group + (epCount ? " · " + epCount + " episodes" : ""),
        type: "series",
        seriesId: s.seriesId
      };
      var el = document.createElement("button");
      el.className = "card focusable";
      el.dataset.series = s.seriesId;
      var poster = posterEl(it);
      poster.style.width = "100%";
      el.appendChild(poster);
      var body = document.createElement("div");
      body.className = "card-body";
      var t = document.createElement("div");
      t.className = "card-title";
      t.textContent = s.seriesName;
      var sub = document.createElement("div");
      sub.className = "card-sub";
      sub.textContent = epCount + " episodes";
      body.appendChild(t);
      body.appendChild(sub);
      el.appendChild(body);
      el.addEventListener("click", function () { App.navigate("#series/" + encodeURIComponent(s.seriesId)); });
      return el;
    });
  }

  /* Maps a list of items to cards, building a series card on demand for any
     referenced series so huge libraries never create cards for series that
     are not shown. `seriesById` (a precomputed seriesId → series map) avoids
     rebuilding the whole series index for every referenced series. */
  function seriesCardFor(items, map, sById, watchedSeasons, watchedInfo) {
    map = map || {};
    sById = sById || seriesById();
    watchedSeasons = watchedSeasons || {};
    watchedInfo = watchedInfo || {};
    var seen = {};
    var out = [];
    items.forEach(function (it) {
      if (it && it.seriesRef) {
        var sr = it.seriesRef;
        if (seen[sr.seriesId]) return;
        seen[sr.seriesId] = true;
        var card = map[sr.seriesId] || seriesCards([sr])[0];
        out.push(card);
        return;
      }
      if (it && it.type === "episode") {
        var key = it.seriesId || "series-" + M3UParser.stableId(it.seriesName || it.title);
        if (seen[key]) return;
        seen[key] = true;
        var e = map[key];
        if (!e) {
          var s = sById[key];
          if (s) e = seriesCards([s])[0];
        }
        /* If we have watched info, override the card subtitle and click. */
        if (e && watchedInfo[key]) {
          var info = watchedInfo[key];
          var sub = e.querySelector(".card-sub");
          if (sub) {
            var epCount = "";
            var s2 = sById[key];
            if (s2 && s2.episodes) epCount = s2.episodes.length + " episodes · ";
            sub.textContent = epCount + "S" + pad(info.season) + " E" + pad(info.episodeNumber);
          }
          var season = info.season;
          e.onclick = null;
          e.removeEventListener("click", e.__clickHandler);
          e.__clickHandler = function () {
            App.navigate("#series/" + encodeURIComponent(key) + "?season=" + season);
          };
          e.addEventListener("click", e.__clickHandler);
        }
        if (e) { out.push(e); return; }
      }
      if (it && it.type === "series") {
        var sid = it.seriesId || "series-" + M3UParser.stableId(it.seriesName || it.title);
        if (seen[sid]) return;
        seen[sid] = true;
        var card = map[sid];
        if (!card) {
          var full = sById[sid] || it;
          card = seriesCards([full])[0];
        }
        out.push(card);
        return;
      }
      out.push(it);
    });
    return out;
  }

  /* Categories always open the split view (items on the left, inline player
     on the right) — the same layout the Live section uses. */
  function categoryTarget(name) {
    return "#cat/" + encodeURIComponent(name);
  }

  function categoryItemCount(name) {
    return Store.getItemsByGroup(name).length;
  }

  /* Single pass over the library: item count and first poster per category.
     Avoids O(categories × items) work when rendering category cards. */
  function categoryStats() {
    return Store.getCategoryStats();
  }

  /* Category card. Categories always open the split view (items on the left,
     inline player on the right) — the same layout the Live section uses. */
  function categoryCard(name, stats) {
    stats = stats || categoryStats();
    var el = document.createElement("button");
    el.className = "card category-card focusable";
    var art = document.createElement("div");
    art.className = "card-poster";
    var first = stats.posters[name];
    if (first) {
      var img = document.createElement("img");
      img.src = first;
      img.alt = name;
      img.loading = "lazy";
      bindPosterImage(img, art, "▦");
      art.appendChild(img);
    } else {
      var ic = document.createElement("span");
      ic.className = "poster-fallback";
      ic.textContent = "▦";
      art.appendChild(ic);
    }
    el.appendChild(art);

    var body = document.createElement("div");
    body.className = "card-body";
    var t = document.createElement("div");
    t.className = "card-title";
    t.textContent = name;
    var sub = document.createElement("div");
    sub.className = "card-sub";
    sub.textContent = (stats.counts[name] || 0) + " items";
    body.appendChild(t);
    body.appendChild(sub);
    el.appendChild(body);
    el.addEventListener("click", function () { App.navigate(categoryTarget(name)); });
    return el;
  }

  function categoryCards(limit, stats) {
    var st = stats || categoryStats();
    var names = Object.keys(st.counts).sort();
    if (limit) names = names.slice(0, limit);
    return names.map(function (name) { return categoryCard(name, st); });
  }

  /* ---------- CATEGORIES ---------- */
  function renderCategories() {
    var root = document.createElement("div");
    root.className = "page";
    root.appendChild(backButton("Home"));
    var header = document.createElement("div");
    header.className = "section-header";
    var h = document.createElement("h1");
    h.className = "section-title";
    h.textContent = "Categories";
    header.appendChild(h);
    root.appendChild(header);

    var stats = categoryStats();
    var names = Object.keys(stats.counts).sort();
    if (!names.length) {
      root.appendChild(emptyState("▦", "No categories yet", "Add channels or import an M3U playlist to see categories here."));
    } else {
      var bar = document.createElement("div");
      bar.className = "search-bar";
      var search = document.createElement("input");
      search.type = "text";
      search.placeholder = "Search categories…";
      search.className = "focusable";
      bar.appendChild(search);
      root.appendChild(bar);
      var gridWrap = document.createElement("div");
      root.appendChild(gridWrap);
      var all = names.slice();
      function renderCatGrid(q) {
        gridWrap.innerHTML = "";
        var ql = (q || "").trim().toLowerCase();
        var filtered = ql ? all.filter(function (n) { return n.toLowerCase().indexOf(ql) >= 0; }) : all.slice();
        if (!filtered.length) {
          gridWrap.appendChild(emptyState("? ", "No matching categories", "No category name matches \u201C" + q + "\u201D."));
          return;
        }
        pagedGrid(gridWrap, filtered, function (name) { return categoryCard(name, stats); });
      }
      search.addEventListener("input", function () { renderCatGrid(search.value); });
      renderCatGrid("");
    }
    page.innerHTML = "";
    page.appendChild(root);
  }

  /* ---------- MOVIES ---------- */
  function renderMovies() {
    var root = document.createElement("div");
    root.className = "page";
    root.appendChild(backButton("Home"));
    var header = document.createElement("div");
    header.className = "section-header";
    var h = document.createElement("h1");
    h.className = "section-title";
    h.textContent = "Movies";
    header.appendChild(h);
    root.appendChild(header);

    var mv = movies();
    if (!mv.length) {
      root.appendChild(emptyState("▶", "No movies yet", "Movies appear here after importing an M3U playlist."));
    } else {
      searchableGrid(root, mv, "Search movies…", card);
    }
    page.innerHTML = "";
    page.appendChild(root);
  }

  /* ---------- LIVE ---------- */
  /* Two-pane layout shared by Live and every category view: a filterable
     list of items on the left, an inline player on the right. Picking an
     item starts playback right there; picking the same item again toggles
     fullscreen. Series containers open their details page instead. */
  function splitView(items, opts) {
    opts = opts || {};

    function labelFor(it) {
      if (!it) return "";
      if (it.type === "episode") {
        return ((it.seriesName || it.title || "Episode") + " — " + episodeLabel(it) + (it.episodeTitle ? " · " + it.episodeTitle : "")).trim();
      }
      return it.title || it.seriesName || it.episodeTitle || "Untitled";
    }

    items = items.slice();
    var pinned = {};
    Store.getPins().forEach(function (id) { pinned[id] = true; });

    /* Precompute lowercase search labels once so filtering doesn't call
       labelFor + toLowerCase for every item on every keystroke. */
    var searchLabels = new Array(items.length);
    for (var si = 0; si < items.length; si++) {
      searchLabels[si] = labelFor(items[si]).toLowerCase();
    }

    /* Cache labels to avoid calling labelFor twice per sort comparison. */
    var labelCache = {};
    function cachedLabel(it) {
      if (!labelCache[it.id]) labelCache[it.id] = labelFor(it);
      return labelCache[it.id];
    }
    function sortItems() {
      items.sort(function (a, b) {
        var pa = pinned[a.id] ? 0 : 1;
        var pb = pinned[b.id] ? 0 : 1;
        if (pa !== pb) return pa - pb;
        var ga = a.group || "", gb = b.group || "";
        if (ga < gb) return -1;
        if (ga > gb) return 1;
        var la = cachedLabel(a), lb = cachedLabel(b);
        if (la < lb) return -1;
        if (la > lb) return 1;
        return 0;
      });
    }
    sortItems();
    /* Rebuild search labels after sort so indices match. */
    for (var si2 = 0; si2 < items.length; si2++) {
      searchLabels[si2] = labelFor(items[si2]).toLowerCase();
    }

    var layout = document.createElement("div");
    layout.className = "live-layout";

    var list = document.createElement("div");
    list.className = "live-list";
    var filter = document.createElement("input");
    filter.type = "text";
    filter.className = "focusable live-filter";
    filter.placeholder = opts.filterPlaceholder || "Filter items…";
    list.appendChild(filter);
    var listBody = document.createElement("div");
    listBody.className = "live-list-body";
    list.appendChild(listBody);

    var playerPane = document.createElement("div");
    playerPane.className = "live-player";
    var ph = document.createElement("div");
    ph.className = "live-placeholder";
    ph.textContent = opts.placeholder || "▶ Select an item";
    playerPane.appendChild(ph);

    layout.appendChild(list);
    layout.appendChild(playerPane);

    var playingId = null;
    var stopPlaying = null;

    function stopIfPlaying() {
      if (stopPlaying) {
        try { stopPlaying(); } catch (e) { /* ignore */ }
      }
      stopPlaying = null;
      playingId = null;
    }

    function wrapFor(id) {
      var ws = listBody.querySelectorAll(".live-item-wrap");
      for (var i = 0; i < ws.length; i++) {
        if (ws[i].dataset.id === id) return ws[i];
      }
      return null;
    }

    function rowFor(it) {
      var wrap = document.createElement("div");
      wrap.className = "live-item-wrap";
      wrap.dataset.id = it.id;

      var row = document.createElement("button");
      row.className = "live-item focusable";
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", labelFor(it));
      var ico = document.createElement("span");
      ico.className = "live-ico";
      ico.textContent = "▶";
      var name = document.createElement("span");
      name.className = "live-name";
      name.textContent = labelFor(it);
      row.appendChild(ico);
      row.appendChild(name);
      if (opts.showGroup && (it.group || "")) {
        var grp = document.createElement("span");
        grp.className = "live-grp";
        grp.textContent = it.group;
        row.appendChild(grp);
      }
      wrap.appendChild(row);

      /* Pin-to-top button: pinned items are kept at the top of the list. */
      var pin = document.createElement("button");
      pin.className = "live-pin focusable";
      pin.setAttribute("role", "button");
      pin.setAttribute("aria-label", (pinned[it.id] ? "Unpin " : "Pin ") + labelFor(it));
      pin.title = pin.getAttribute("aria-label");
      function paintPin() {
        pin.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/></svg>';
        pin.classList.toggle("pinned", !!pinned[it.id]);
      }
      paintPin();
      pin.addEventListener("click", function (e) {
        e.stopPropagation();
        var on = Store.togglePin(it.id);
        if (on) pinned[it.id] = true; else delete pinned[it.id];
        toast(on ? "Pinned — moved to the top" : "Unpinned", "ok");
        sortItems();
        renderList(filter.value);
        var w = wrapFor(it.id);
        if (w) {
          var np = w.querySelector(".live-pin");
          if (np) {
            try { np.focus(); } catch (err) { /* ignore */ }
            if (global.Nav && Nav.markFocused) Nav.markFocused(np);
          }
        }
      });
      wrap.appendChild(pin);

      row.addEventListener("click", function () {
        if (it.type === "series") {
          App.navigate("#series/" + encodeURIComponent(it.seriesId || it.id));
          return;
        }
        if (playingId === it.id) {
          Player.fullscreen();
          return;
        }
        listBody.querySelectorAll(".live-item.active").forEach(function (n) { n.classList.remove("active"); });
        row.classList.add("active");
        stopIfPlaying();
        playerPane.innerHTML = "";
        playingId = it.id;
        stopPlaying = Player.playInline(playerPane, it.id) || null;
        try { row.scrollIntoView({ block: "nearest" }); } catch (e) { /* ignore */ }
      });

      return wrap;
    }

    var listGen = 0;
    function renderList(q) {
      var gen = ++listGen;
      listBody.innerHTML = "";
      var ql = (q || "").trim().toLowerCase();
      var max = ql ? 500 : (opts.maxRows || 1000);
      var rows = [];
      var i = 0;
      var shown = 0;
      function buildChunk() {
        /* A newer filter/render superseded this one; drop it. */
        if (gen !== listGen) return;
        var CHUNK = 200;
        var inChunk = 0;
        for (; i < items.length && shown < max && inChunk < CHUNK; i++) {
          if (ql && searchLabels[i].indexOf(ql) === -1) continue;
          shown++;
          inChunk++;
          var wrap = rowFor(items[i]);
          if (items[i].id === playingId) {
            var r = wrap.querySelector(".live-item");
            if (r) r.classList.add("active");
          }
          rows.push(wrap);
        }
        if (i < items.length && shown < max) {
          setTimeout(buildChunk, 0);
          return;
        }
        var frag = document.createDocumentFragment();
        for (var k = 0; k < rows.length; k++) frag.appendChild(rows[k]);
        listBody.appendChild(frag);
        if (!ql && shown === max && items.length > max) {
          var note = document.createElement("div");
          note.className = "live-more";
          note.textContent = "Showing " + max + " of " + items.length + " — type in the filter to see the rest.";
          listBody.appendChild(note);
        }
        /* Auto-select the first item so the player pane is never left showing
           the "Select a channel" placeholder — especially useful on mobile. */
        if (opts.autoplay && !playingId && shown > 0 && !ql) {
          var first = listBody.querySelector(".live-item");
          if (first) { try { first.click(); } catch (e) { /* ignore */ } }
        }
      }
      buildChunk();
    }

    var filterTimer = null;
    filter.addEventListener("input", function () {
      if (filterTimer) clearTimeout(filterTimer);
      filterTimer = setTimeout(function () { renderList(filter.value); }, 80);
    });

    return { layout: layout, render: renderList };
  }

  function renderLive() {
    var root = document.createElement("div");
    root.className = "page live-page";

    var header = document.createElement("div");
    header.className = "section-header page-head";
    var left = document.createElement("div");
    left.className = "page-head-left";
    left.appendChild(backButton("Home"));
    var h = document.createElement("h1");
    h.className = "section-title";
    h.textContent = "Live";
    left.appendChild(h);
    header.appendChild(left);
    root.appendChild(header);

    var items = liveItems();
    if (!items.length) {
      root.appendChild(emptyState("▶", "No live channels yet", "Import an Xtream provider or a playlist with live/HLS channels and they will appear here."));
      page.innerHTML = "";
      page.appendChild(root);
      return;
    }

    if (global.Player && Player.preloadStreamLibs) Player.preloadStreamLibs();

    var sv = splitView(items, { filterPlaceholder: "Filter channels…", placeholder: "▶ Select a channel", showGroup: true, autoplay: true });
    root.appendChild(sv.layout);
    sv.render("");

    page.innerHTML = "";
    page.appendChild(root);
  }

  /* A single category: every item in the group listed on the left, an
     inline player on the right. A header button pins/unpins the category
     in the watchlist. */
  function renderCategory(name) {
    var root = document.createElement("div");
    root.className = "page live-page";

    var header = document.createElement("div");
    header.className = "section-header page-head";
    var left = document.createElement("div");
    left.className = "page-head-left";
    left.appendChild(backButton("Categories", "#categories"));
    var h = document.createElement("h1");
    h.className = "section-title";
    h.textContent = name;
    left.appendChild(h);
    header.appendChild(left);
    var starBtn = document.createElement("button");
    starBtn.className = "btn btn-secondary focusable page-head-action";
    function paintStar() { starBtn.textContent = Store.isCategoryInWatchlist(name) ? "★ In watchlist" : "☆ Add to watchlist"; }
    paintStar();
    starBtn.addEventListener("click", function () {
      var on = Store.toggleCategoryWatchlist(name);
      paintStar();
      toast(on ? "Category added to watchlist" : "Category removed from watchlist", "ok");
    });
    header.appendChild(starBtn);
    root.appendChild(header);

    var items = Store.getItemsByGroup(name);
    if (!items.length) {
      root.appendChild(emptyState("▦", "Empty category", "This category has no items."));
      page.innerHTML = "";
      page.appendChild(root);
      return;
    }

    if (global.Player && Player.preloadStreamLibs) Player.preloadStreamLibs();

    var sv = splitView(items, { filterPlaceholder: "Filter items…", placeholder: "▶ Select an item", autoplay: true });
    root.appendChild(sv.layout);
    sv.render("");

    page.innerHTML = "";
    page.appendChild(root);
  }

  /* ---------- SERIES ---------- */
  function renderSeries() {
    var root = document.createElement("div");
    root.className = "page";
    root.appendChild(backButton("Home"));
    var header = document.createElement("div");
    header.className = "section-header";
    var h = document.createElement("h1");
    h.className = "section-title";
    h.textContent = "Series";
    header.appendChild(h);
    root.appendChild(header);

    if (shouldImportItem({ type: "series" }) && seriesList().some(function (s) { return !s.episodes.length; })) {
      var loadBtn = document.createElement("button");
      loadBtn.id = "seriesFetchBtn";
      loadBtn.className = "btn btn-secondary focusable";
      loadBtn.style.marginBottom = "14px";
      loadBtn.textContent = "Fetch all series episodes";
      loadBtn.setAttribute("aria-label", "Fetch episodes for all series that have none");
      loadBtn.addEventListener("click", function () { fetchAllSeriesEpisodes(); });
      root.appendChild(loadBtn);
    }

    var list = seriesList();
    if (!list.length) {
      root.appendChild(emptyState("▶", "No series yet", "Series are detected automatically from episode titles like “Show S01E01”."));
    } else {
      searchableGrid(root, list, "Search series…", function (s) { return seriesCards([s])[0]; });
    }
    page.innerHTML = "";
    page.appendChild(root);
  }

  /* ---------- SERIES DETAILS ---------- */
  function renderSeriesDetails(seriesId, seasonQuery) {
    var s = getSeries(seriesId);
    if (!s) {
      page.innerHTML = "";
      var missing = document.createElement("div");
      missing.className = "page";
      missing.appendChild(backButton("Back"));
      missing.appendChild(emptyState("?", "Series not found", "This series is no longer in your library."));
      page.appendChild(missing);
      return;
    }

    var root = document.createElement("div");
    root.className = "page";

    var back = backButton("Series", "#series");
    root.appendChild(back);

    var backdrop = document.createElement("div");
    backdrop.className = "hero detail-backdrop";
    var bg = document.createElement("div");
    bg.className = "hero-bg";
    if (s.poster) {
      var bgImg = document.createElement("img");
      bgImg.alt = "";
      bgImg.loading = "lazy";
      bindPosterImage(bgImg, bg);
      bgImg.src = s.poster;
      bg.appendChild(bgImg);
    }
    backdrop.appendChild(bg);
    root.appendChild(backdrop);

    var header = document.createElement("div");
    header.className = "detail-header";
    var poster = document.createElement("div");
    poster.className = "detail-poster";
    var it = { poster: s.poster, title: s.seriesName };
    if (s.poster) {
      var img = document.createElement("img");
      img.alt = s.seriesName;
      bindPosterImage(img, poster);
      img.src = s.poster;
      poster.appendChild(img);
    } else {
      poster.appendChild(fallbackIcon(poster));
    }
    poster.style.cursor = "pointer";
    poster.setAttribute("title", s.episodes.length ? "Play first episode" : "No episodes yet");
    if (s.episodes.length) {
      poster.addEventListener("click", function () { App.navigate("#play/" + encodeURIComponent(s.episodes[0].id)); });
    }
    header.appendChild(poster);

    var info = document.createElement("div");
    info.className = "detail-info";
    var title = document.createElement("h1");
    title.className = "detail-title";
    title.textContent = s.seriesName;
    var meta = document.createElement("div");
    meta.className = "detail-meta";
    var seasons = {};
    s.episodes.forEach(function (e) { seasons[e.season] = true; });
    meta.textContent = Object.keys(seasons).length + " season" + (Object.keys(seasons).length !== 1 ? "s" : "") + " · " + s.episodes.length + " episodes";
    var desc = document.createElement("p");
    desc.className = "detail-desc";
    desc.textContent = s.description || "No description available.";
    info.appendChild(title);
    info.appendChild(meta);
    info.appendChild(desc);
    header.appendChild(info);
    root.appendChild(header);

    var actions = document.createElement("div");
    actions.className = "detail-actions";
    var wl = document.createElement("button");
    wl.className = "btn btn-secondary focusable";
    wl.textContent = Store.isSeriesInWatchlist(seriesId) ? "✓ In Watchlist" : "Add to Watchlist";
    wl.addEventListener("click", function () {
      var on = Store.toggleSeriesWatchlist(seriesId);
      wl.textContent = on ? "✓ In Watchlist" : "Add to Watchlist";
      toast(on ? "Series added to watchlist" : "Series removed from watchlist", "ok");
    });
    actions.appendChild(wl);
    root.appendChild(actions);

    var seasonNumbers = Object.keys(seasons).map(Number).sort(function (a, b) { return a - b; });

    if (!seasonNumbers.length && /^xt-series-/i.test(String(seriesId))) {
      var loadBox = emptyState("…", "Loading episodes…", "Fetching this series from your provider…");
      root.appendChild(loadBox);
      loadXtreamEpisodes(seriesId, s).then(function (eps) {
        var r = global.App && App.parseRoute();
        var stillHere = r && r.name === "series" && r.arg === seriesId;
        if (eps && eps.length) {
          if (stillHere) App.render();
        } else {
          loadBox.innerHTML = '<div class="big">…</div>';
          var h = loadBox.querySelector("h3"); if (h) h.textContent = "No episodes";
          var p2 = loadBox.querySelector("p"); if (p2) p2.textContent = "This series has no episodes on the provider.";
          var retry = document.createElement("button");
          retry.className = "btn btn-secondary focusable";
          retry.textContent = "Retry";
          retry.addEventListener("click", function () { App.navigate("#series/" + encodeURIComponent(seriesId)); });
          loadBox.appendChild(retry);
        }
      }).catch(function (err) {
        loadBox.innerHTML = '<div class="big">!</div>';
        var h = loadBox.querySelector("h3"); if (h) h.textContent = "Could not load episodes";
        var p2 = loadBox.querySelector("p"); if (p2) p2.textContent = err && err.message ? err.message : "Unknown error";
        var retry = document.createElement("button");
        retry.className = "btn btn-secondary focusable";
        retry.textContent = "Retry";
        retry.addEventListener("click", function () { App.navigate("#series/" + encodeURIComponent(seriesId)); });
        loadBox.appendChild(retry);
      });
    } else if (!seasonNumbers.length) {
      var addBtn = document.createElement("button");
      addBtn.className = "btn btn-primary focusable";
      addBtn.textContent = "Add an episode";
      addBtn.addEventListener("click", function () { App.navigate("#add"); });
      root.appendChild(emptyState("▶", "No episodes yet", "This series has no episodes. Add an episode via Add Content.", addBtn));
    } else {
      var selector = document.createElement("div");
      selector.className = "season-selector";
      /* Prefer the season from the URL (player back / recently watched); fall
         back to the last season watched in this series so the device/remote
         back button (history back drops the ?season= query) still returns to
         the season the user was on. */
      var requestedSeason = seasonQuery != null ? Number(seasonQuery) : null;
      var lastWatchedSeason = (requestedSeason != null ? requestedSeason : Store.getLastSeriesSeason(seriesId));
      var activeSeason = (lastWatchedSeason != null && seasons[lastWatchedSeason]) ? lastWatchedSeason : seasonNumbers[0];

      var pills = {};
      seasonNumbers.forEach(function (n) {
        var pill = document.createElement("button");
        pill.className = "season-pill focusable";
        pill.textContent = "Season " + n;
        pill.addEventListener("click", function () {
          selectSeason(n);
        });
        selector.appendChild(pill);
        pills[n] = pill;
      });
      root.appendChild(selector);

      var listWrap = document.createElement("div");
      listWrap.className = "episode-list";

      function selectSeason(n) {
        activeSeason = n;
        seasonNumbers.forEach(function (k) { pills[k].classList.toggle("active", k === n); });
        renderEpisodes();
      }

      function renderEpisodes() {
        listWrap.innerHTML = "";
        var eps = s.episodes.filter(function (e) { return e.season === activeSeason; });
        eps.forEach(function (ep) {
          listWrap.appendChild(episodeRow(ep));
        });
      }

      root.appendChild(listWrap);
      selectSeason(activeSeason);
    }

    function episodeRow(ep) {
      var row = document.createElement("div");
      row.className = "episode";
      row.style.position = "relative";

      var main = document.createElement("button");
      main.className = "episode-main focusable";

      var thumb = document.createElement("div");
      thumb.className = "episode-thumb";
      if (ep.poster) {
        var tImg = document.createElement("img");
        tImg.alt = ep.episodeTitle || ep.title;
        tImg.loading = "lazy";
        bindPosterImage(tImg, thumb);
        tImg.src = ep.poster;
        thumb.appendChild(tImg);
      } else {
        thumb.textContent = "▶";
      }
      var num = document.createElement("div");
      num.className = "episode-num";
      num.textContent = pad(ep.episodeNumber);
      var body = document.createElement("div");
      body.className = "episode-body";
      var name = document.createElement("div");
      name.className = "episode-name";
      name.textContent = ep.episodeTitle || ep.title;
      var sub = document.createElement("div");
      sub.className = "episode-sub";
      sub.textContent = episodeLabel(ep) + (ep.group ? " · " + ep.group : "");
      body.appendChild(name);
      body.appendChild(sub);
      var state = document.createElement("div");
      state.className = "episode-watch";
      var p = progressOf(ep.id);
      if (isWatched(ep.id)) {
        state.textContent = "✓ Watched";
        state.classList.add("watched");
      } else if (p && p.progress > 0) {
        state.textContent = p.progress + "% watched";
      }
      if (p && p.progress > 0 && p.progress < 100) {
        var pb = document.createElement("div");
        pb.className = "ep-progress";
        pb.style.width = p.progress + "%";
        row.appendChild(pb);
      }
      main.appendChild(thumb);
      main.appendChild(num);
      main.appendChild(body);
      main.appendChild(state);
      main.addEventListener("click", function () { App.navigate("#play/" + encodeURIComponent(ep.id)); });
      row.appendChild(main);

      var edit = document.createElement("button");
      edit.className = "btn btn-ghost btn-sm focusable episode-edit";
      edit.textContent = "Edit";
      edit.setAttribute("aria-label", "Edit " + (ep.episodeTitle || ep.title));
      edit.addEventListener("click", function (e) {
        e.stopPropagation();
        App.navigate("#edit/" + encodeURIComponent(ep.id));
      });
      row.appendChild(edit);

      return row;
    }

    var danger = document.createElement("div");
    danger.style.marginTop = "26px";
    danger.style.display = "flex";
    danger.style.gap = "10px";
    danger.style.flexWrap = "wrap";
    var editSeriesBtn = document.createElement("button");
    editSeriesBtn.className = "btn btn-secondary focusable";
    editSeriesBtn.textContent = "Edit series";
    editSeriesBtn.addEventListener("click", function () {
      var rec = Store.getItems().find(function (x) { return x.type === "series" && x.seriesId === seriesId; });
      if (!rec) {
        rec = Store.addItem({
          title: s.seriesName,
          type: "series",
          mediaType: "series",
          source: "",
          poster: s.poster || "",
          description: s.description || "",
          group: s.group || "",
          seriesId: seriesId,
          seriesName: s.seriesName
        });
      }
      App.navigate("#edit/" + encodeURIComponent(rec.id));
    });
    danger.appendChild(editSeriesBtn);
    var del = document.createElement("button");
    del.className = "btn btn-danger focusable";
    del.textContent = "Delete entire series";
    del.addEventListener("click", function () { confirmDeleteSeries(s); });
    danger.appendChild(del);
    root.appendChild(danger);

    page.innerHTML = "";
    page.appendChild(root);
  }

  function confirmDeleteSeries(s) {
    confirmModal("Delete “" + s.seriesName + "”?", "This removes every episode of the series, plus its watch history, progress and watchlist entries. This cannot be undone.", function () {
      s.episodes.forEach(function (ep) { Store.removeItem(ep.id); });
      Store.getItems().forEach(function (x) { if (x.type === "series" && x.seriesId === s.seriesId) Store.removeItem(x.id); });
      Store.removeSeriesFromWatchlist(s.seriesId);
      toast("Series deleted", "ok");
      App.navigate("#series");
    });
  }

  /* ---------- MOVIE DETAILS ---------- */
  function renderMovieDetails(id) {
    var item = Store.getItem(id);
    if (!item) {
      page.innerHTML = "";
      var r = document.createElement("div");
      r.className = "page";
      r.appendChild(backButton("Back"));
      r.appendChild(emptyState("?", "Not found", "This item is no longer in your library."));
      page.appendChild(r);
      return;
    }

    var root = document.createElement("div");
    root.className = "page";
    var back = backButton("Movies", "#movies");
    root.appendChild(back);

    var backdrop = document.createElement("div");
    backdrop.className = "hero detail-backdrop";
    var bg = document.createElement("div");
    bg.className = "hero-bg";
    if (item.poster) {
      var bgImg = document.createElement("img");
      bgImg.alt = "";
      bgImg.loading = "lazy";
      bindPosterImage(bgImg, bg);
      bgImg.src = item.poster;
      bg.appendChild(bgImg);
    }
    backdrop.appendChild(bg);
    root.appendChild(backdrop);

    var header = document.createElement("div");
    header.className = "detail-header";
    var poster = document.createElement("div");
    poster.className = "detail-poster";
    if (item.poster) {
      var img = document.createElement("img");
      img.src = item.poster;
      img.alt = item.title;
      bindPosterImage(img, poster);
      poster.appendChild(img);
    } else {
      poster.appendChild(fallbackIcon(poster));
    }
    poster.style.cursor = "pointer";
    poster.setAttribute("title", "Play " + item.title);
    poster.addEventListener("click", function () { App.navigate("#play/" + encodeURIComponent(item.id)); });
    header.appendChild(poster);

    var info = document.createElement("div");
    info.className = "detail-info";
    var title = document.createElement("h1");
    title.className = "detail-title";
    title.textContent = item.title;
    var meta = document.createElement("div");
    meta.className = "detail-meta";
    var bits = [item.group || "Uncategorized"];
    if (item.tvgId) bits.push(item.tvgId);
    if (item.tvgName) bits.push(item.tvgName);
    bits.push(item.mediaType === "embed" ? "Embed source" : "Direct video");
    meta.textContent = bits.join(" · ");
    var desc = document.createElement("p");
    desc.className = "detail-desc";
    desc.textContent = item.description || "No description available.";

    var actions = document.createElement("div");
    actions.className = "detail-actions";

    var play = document.createElement("button");
    play.className = "btn btn-primary focusable";
    play.textContent = "▶ Play";
    play.addEventListener("click", function () { App.navigate("#play/" + encodeURIComponent(item.id)); });

    var wl = document.createElement("button");
    wl.className = "btn btn-secondary focusable";
    wl.textContent = Store.isInWatchlist(item.id) ? "✓ In Watchlist" : "Add to Watchlist";
    wl.addEventListener("click", function () {
      var on = Store.toggleWatchlist(item.id);
      wl.textContent = on ? "✓ In Watchlist" : "Add to Watchlist";
      toast(on ? "Added to watchlist" : "Removed from watchlist", "ok");
    });

    var watched = document.createElement("button");
    watched.className = "btn btn-secondary focusable";
    function updateWatchedBtn() {
      watched.textContent = Store.isWatched(item.id) ? "✓ Watched" : "Mark as Watched";
      watched.classList.toggle("btn-ok", Store.isWatched(item.id));
    }
    updateWatchedBtn();
    watched.addEventListener("click", function () {
      if (Store.isWatched(item.id)) Store.markUnwatched(item.id);
      else Store.markWatched(item.id);
      updateWatchedBtn();
      toast("Watched status updated", "ok");
    });

    var edit = document.createElement("button");
    edit.className = "btn btn-secondary focusable";
    edit.textContent = "Edit";
    edit.addEventListener("click", function () { App.navigate("#edit/" + encodeURIComponent(item.id)); });

    var del = document.createElement("button");
    del.className = "btn btn-danger focusable";
    del.textContent = "Delete";
    del.addEventListener("click", function () {
      confirmModal("Delete “" + item.title + "”?", "Its history, progress and watchlist entry will also be removed. This cannot be undone.", function () {
        Store.removeItem(item.id);
        toast("Movie deleted", "ok");
        App.navigate("#movies");
      });
    });

    actions.appendChild(play);
    actions.appendChild(wl);
    actions.appendChild(watched);
    actions.appendChild(edit);
    actions.appendChild(del);

    info.appendChild(title);
    info.appendChild(meta);
    info.appendChild(desc);
    info.appendChild(actions);
    header.appendChild(info);
    root.appendChild(header);

    page.innerHTML = "";
    page.appendChild(root);
  }

  /* ---------- WATCHLIST ---------- */
  function renderWatchlist() {
    var root = document.createElement("div");
    root.className = "page";
    root.appendChild(backButton("Home"));
    var header = document.createElement("div");
    header.className = "section-header";
    var h = document.createElement("h1");
    h.className = "section-title";
    h.textContent = "Watchlist";
    header.appendChild(h);
    var clear = document.createElement("button");
    clear.className = "btn btn-ghost btn-sm focusable";
    clear.textContent = "Clear";
    clear.addEventListener("click", function () {
      confirmModal("Clear the entire watchlist?", "", function () {
        Store.getWatchlist().forEach(function (id) { Store.removeFromWatchlist(id); });
        renderWatchlist();
        toast("Watchlist cleared", "ok");
      });
    });
    header.appendChild(clear);
    root.appendChild(header);

    var cards2 = [];
    var wlStats = categoryStats();
    Store.getWatchlist().forEach(function (id) {
      if (id && id.indexOf("series:") === 0) {
        var s = getSeries(id.slice(7));
        if (s) cards2.push(seriesCard(s.seriesId, s.seriesName, s.poster, s.episodes.length));
        return;
      }
      if (id && id.indexOf("cat:") === 0) {
        var cname = id.slice(4);
        if (cname && (wlStats.counts[cname] || 0) > 0) cards2.push(categoryCard(cname, wlStats));
        return;
      }
      var it = Store.getItem(id);
      if (!it) return;
      if (it.type === "episode") {
        var s2 = getSeries(it.seriesId);
        if (s2) { cards2.push(seriesCard(s2.seriesId, s2.seriesName, s2.poster, s2.episodes.length)); return; }
      }
      cards2.push(card(it));
    });
    if (!cards2.length) {
      root.appendChild(emptyState("★", "Your watchlist is empty", "Star movies, series or categories to find them here."));
    } else {
      var grid = document.createElement("div");
      grid.className = "grid";
      cards2.forEach(function (c) { grid.appendChild(c); });
      root.appendChild(grid);
    }
    page.innerHTML = "";
    page.appendChild(root);
  }

  function seriesCard(id, name, poster, count) {
    var el = document.createElement("button");
    el.className = "card focusable";
    var it = { id: id, title: name, poster: poster };
    var p = posterEl(it);
    p.style.width = "100%";
    el.appendChild(p);
    var body = document.createElement("div");
    body.className = "card-body";
    var t = document.createElement("div");
    t.className = "card-title";
    t.textContent = name;
    var sub = document.createElement("div");
    sub.className = "card-sub";
    sub.textContent = count + " episodes · Series";
    body.appendChild(t);
    body.appendChild(sub);
    el.appendChild(body);
    el.addEventListener("click", function () { App.navigate("#series/" + encodeURIComponent(id)); });
    return el;
  }

  /* ---------- HISTORY ---------- */
  function renderHistory() {
    var root = document.createElement("div");
    root.className = "page";
    root.appendChild(backButton("Home"));
    var header = document.createElement("div");
    header.className = "section-header";
    var h = document.createElement("h1");
    h.className = "section-title";
    h.textContent = "Recently Watched";
    header.appendChild(h);
    var clear = document.createElement("button");
    clear.className = "btn btn-ghost btn-sm focusable";
    clear.textContent = "Clear history";
    clear.addEventListener("click", function () {
      confirmModal("Clear watch history?", "Playback positions and history will be removed.", function () {
        Store.clearHistory();
        renderHistory();
        toast("History cleared", "ok");
      });
    });
    header.appendChild(clear);
    root.appendChild(header);

    var list = Store.getHistory();
    var items = [];
    list.forEach(function (h) {
      var it = Store.getItem(h.id);
      if (it && !isLiveItem(it)) items.push(it);
    });

    if (!items.length) {
      root.appendChild(emptyState("▶", "No history yet", "Everything you open will show up here."));
    } else {
      var grid = document.createElement("div");
      grid.className = "grid";
      items.slice(0, 30).forEach(function (it) {
        if (it.type === "episode") {
          var s = getSeries(it.seriesId || "series-" + M3UParser.stableId(it.seriesName || it.title));
          if (s) { grid.appendChild(seriesCard(s.seriesId, s.seriesName, s.poster, s.episodes.length)); return; }
        }
        grid.appendChild(card(it));
      });
      root.appendChild(grid);
    }
    page.innerHTML = "";
    page.appendChild(root);
  }

  /* ---------- SEARCH ---------- */
  function renderSearch(initialQ) {
    var root = document.createElement("div");
    root.className = "page";
    root.appendChild(backButton("Home"));
    var header = document.createElement("div");
    header.className = "section-header";
    var h = document.createElement("h1");
    h.className = "section-title";
    h.textContent = "Search";
    header.appendChild(h);
    root.appendChild(header);

    var bar = document.createElement("div");
    bar.className = "search-bar";
    var input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Search movies, series, live channels, categories…";
    input.className = "focusable";
    input.value = initialQ || "";
    bar.appendChild(input);
    root.appendChild(bar);

    var results = document.createElement("div");
    results.className = "search-results";
    root.appendChild(results);

    /* Precompute searchable text once per page render. The library is static
       during a search session, and rebuilding 300k+ haystack strings on every
       keystroke is what froze the UI. */
    var searchCache = null;
    function buildCache() {
      var series = seriesList();
      var seriesMap = {};
      var hay = [];
      for (var i = 0; i < series.length; i++) {
        var s = series[i];
        seriesMap[s.seriesId] = s;
        hay.push({ it: s, seriesRef: s, isEpisode: false, hay: (s.seriesName + " " + (s.group || "")).toLowerCase() });
      }
      Store.getItems().forEach(function (it) {
        if (it.type === "series") return;
        var h = ((it.title || "") + " " + (it.group || "") + " " + (it.seriesName || "") + " " + (it.episodeTitle || "") + " " + (it.tvgName || "")).toLowerCase();
        if (it.type === "episode") {
          var skey = it.seriesId || "series-" + M3UParser.stableId(it.seriesName || it.title);
          hay.push({ it: it, seriesRef: seriesMap[skey] || null, isEpisode: true, hay: h });
        } else {
          hay.push({ it: it, seriesRef: null, isEpisode: false, hay: h });
        }
      });
      searchCache = hay;
    }

    function renderResults(q, moviesHit, seriesHit) {
      var list = document.createElement("div");
      list.className = "result-list";
      function addBlock(title, arr) {
        if (!arr.length) return;
        var hd = document.createElement("h3");
        hd.className = "section-title";
        hd.style.fontSize = "18px";
        hd.style.margin = "18px 0 8px";
        hd.textContent = title;
        list.appendChild(hd);
        var shown = arr.slice(0, 60);
        shown.forEach(function (it) { list.appendChild(resultRow(it)); });
        if (arr.length > shown.length) {
          var more = document.createElement("div");
          more.className = "search-more";
          more.textContent = "… and " + (arr.length - shown.length) + " more";
          list.appendChild(more);
        }
      }
      addBlock("Movies", moviesHit);
      addBlock("Series", seriesHit);
      if (!list.children.length) {
        var none = document.createElement("div");
        none.className = "empty";
        none.innerHTML = '<div class="big">?</div><h3>No results</h3><p>Try a different search term.</p>';
        results.appendChild(none);
      } else {
        results.appendChild(list);
      }
    }

    function run(q) {
      results.innerHTML = "";
      q = (q || "").trim().toLowerCase();
      if (!q) {
        var hint = document.createElement("div");
        hint.className = "empty";
        hint.innerHTML = '<div class="big">&#128269;</div><h3>Type to search</h3><p>Results appear as you type.</p>';
        results.appendChild(hint);
        return;
      }
      if (!searchCache) buildCache();
      var moviesHit = [], seriesHit = [];
      var CHUNK = 8000;
      var i = 0;
      run.seq = (run.seq || 0) + 1;
      var seq = run.seq;
      function step() {
        /* A newer keystroke superseded this scan; drop it. */
        if (seq !== run.seq) return;
        var end = Math.min(i + CHUNK, searchCache.length);
        for (; i < end; i++) {
          var d = searchCache[i];
          if (d.hay.indexOf(q) === -1) continue;
          if (d.isEpisode) {
            if (d.seriesRef && seriesHit.indexOf(d.seriesRef) === -1) seriesHit.push(d.seriesRef);
          } else if (d.seriesRef) {
            if (seriesHit.indexOf(d.seriesRef) === -1) seriesHit.push(d.seriesRef);
          } else {
            moviesHit.push(d.it);
          }
        }
        if (i < searchCache.length) {
          setTimeout(step, 0);
        } else if (seq === run.seq) {
          renderResults(q, moviesHit, seriesHit);
        }
      }
      step();
    }

    function resultRow(it) {
      var row = document.createElement("button");
      row.className = "result-item focusable";
      var thumb = document.createElement("div");
      thumb.className = "result-thumb";
      if (it.poster) {
        thumb.style.backgroundImage = "url('" + escapeHtml(it.poster) + "')";
      } else {
        thumb.textContent = "▶";
      }
      var isSeries = it.type === "series" || (it.seriesName && !it.type);
      var isLive = isLiveItem(it);
      var body = document.createElement("div");
      var t = document.createElement("div");
      t.className = "r-title";
      t.textContent = isSeries ? it.seriesName
        : it.type === "episode" ? (it.seriesName + " — " + episodeLabel(it) + (it.episodeTitle ? " · " + it.episodeTitle : ""))
        : it.title;
      var sub = document.createElement("div");
      sub.className = "r-sub";
      sub.textContent = (isSeries ? "Series · " : isLive ? "Live · " : it.type === "episode" ? "Episode · " : "Movie · ") + (it.group || "Uncategorized");
      body.appendChild(t);
      body.appendChild(sub);
      row.appendChild(thumb);
      row.appendChild(body);
      var target = isSeries ? "#series/" + encodeURIComponent(it.seriesId || it.id)
        : it.type === "episode" || isLive ? "#play/" + encodeURIComponent(it.id)
        : "#movie/" + encodeURIComponent(it.id);
      row.addEventListener("click", function () { App.navigate(target); });
      return row;
    }

    var debounce;
    input.addEventListener("input", function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () { run(input.value); }, 120);
    });
    input.addEventListener("keydown", function (e) {
      if (Nav.keyName(e) === "enter") {
        run(input.value);
        input.focus();
        if (global.Nav && Nav.markFocused) Nav.markFocused(input);
      }
    });

    page.innerHTML = "";
    page.appendChild(root);
    run(initialQ || "");
    setTimeout(function () {
      input.focus();
      if (global.Nav && Nav.markFocused) Nav.markFocused(input);
    }, 30);
  }

  /* ---------- SETTINGS / LIBRARY ---------- */
  function renderSettings() {
    var root = document.createElement("div");
    root.className = "page";
    root.appendChild(backButton("Home"));
    var header = document.createElement("div");
    header.className = "section-header";
    var h = document.createElement("h1");
    h.className = "section-title";
    h.textContent = "Settings";
    header.appendChild(h);
    var count = document.createElement("span");
    count.className = "detail-meta";
    var n = Store.getItems().length;
    count.textContent = n + " item" + (n !== 1 ? "s" : "") + " in library";
    root.appendChild(header);
    root.appendChild(count);

    var grid = document.createElement("div");
    grid.className = "settings-grid";

    /* Import */
    var importPanel = panel("Import M3U", "Load a playlist from a file or a URL. Direct videos and embed code are detected automatically. Re-imports update existing entries instead of duplicating them.");
    importPanel.classList.add("panel-import");
    var drop = document.createElement("div");
    drop.className = "file-drop focusable";
    drop.tabIndex = 0;
    drop.innerHTML = "Click or drop your .m3u file here";
    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".m3u,.m3u8,audio/x-mpegurl";
    drop.appendChild(fileInput);
    drop.addEventListener("click", function () { fileInput.click(); });
    drop.addEventListener("keydown", function (e) {
      var k = Nav.keyName(e);
      if (k === "enter" || k === "space") { e.preventDefault(); fileInput.click(); }
    });
    ["dragover", "drop"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault();
        drop.classList.toggle("dragover", ev === "dragover");
      });
    });
    fileInput.addEventListener("change", function () {
      var f = fileInput.files[0];
      if (f) importFile(f);
    });
    importPanel.appendChild(drop);

    var savedUrl = Store.getSettings().m3uUrl || "";
    var urlRow = document.createElement("div");
    urlRow.className = "url-import-row";
    var urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.className = "url-import-input focusable";
    urlInput.placeholder = "…or paste a playlist URL (e.g. GitHub raw link)";
    urlInput.value = savedUrl;
    var importUrlBtn = buttonEl("btn btn-secondary", "Import from URL", function () {
      importFromUrl(urlInput.value.trim(), false);
    });
    urlRow.appendChild(urlInput);
    urlRow.appendChild(importUrlBtn);
    if (savedUrl) {
      var refreshBtn = buttonEl("btn btn-primary", "⟳ Refresh", function () {
        importFromUrl(savedUrl, true);
      });
      urlRow.appendChild(refreshBtn);
      var hint = document.createElement("div");
      hint.className = "url-hint";
      hint.textContent = "Saved source: " + savedUrl;
      importPanel.appendChild(hint);
    }
    urlInput.addEventListener("keydown", function (e) {
      if (Nav.keyName(e) === "enter") { e.preventDefault(); importFromUrl(urlInput.value.trim(), false); }
    });
    importPanel.appendChild(urlRow);
    grid.appendChild(importPanel);

    /* Import Options: which content types are imported from files, URLs and
       providers. Disabled types are skipped on import — items already in the
       library are kept. */
    var opts = Store.getImportOptions();
    var importOptsPanel = panel("Import Options", "Choose which content types are imported from files, URLs and providers.");
    importOptsPanel.classList.add("panel-importopts");
    var optsGrid = document.createElement("div");
    optsGrid.className = "import-options";
    var optDefs = [
      { key: "live", label: "Live", hint: "Live channels" },
      { key: "movies", label: "Movies", hint: "Movies & clips" },
      { key: "series", label: "Series", hint: "Series & episodes" },
      { key: "adult", label: "Adult +18", hint: "Adult content" }
    ];
    optDefs.forEach(function (d) {
      optsGrid.appendChild(importOptionToggle(d.label, d.hint, d.key, !!opts[d.key]));
    });
    importOptsPanel.appendChild(optsGrid);

    /* Advanced: skip anything matching a regular expression. */
    var regexOn = !!opts.regexEnabled;
    var regexInput = inputField("text", opts.regex, "Filters out content that matches this regex (advanced)");
    regexInput.className = "import-regex-input focusable";
    regexInput.setAttribute("aria-label", "Regular expression for content to skip");
    regexInput.disabled = !regexOn;

    function regexValid() {
      var p = sanitizeRegex(regexInput.value);
      if (!p) return false;
      try { new RegExp(p, "i"); return true; } catch (e) { return false; }
    }

    var regexToggle = switchButton(regexOn, function (next) {
      var p = regexInput.value.trim();
      if (p && !regexValid()) {
        toast("That is not a valid regular expression.", "err");
        regexInput.classList.add("invalid");
        return false;
      }
      regexOn = next;
      regexInput.disabled = !regexOn;
      regexInput.classList.remove("invalid");
      Store.setImportOption("regex", p);
      Store.setImportOption("regexEnabled", regexOn);
      toast(regexOn
        ? (p ? "Regex filtering enabled" : "Regex filtering enabled — type a pattern to filter")
        : "Regex filtering disabled", "ok");
      if (regexOn && !p) {
        try { regexInput.focus(); } catch (e) { /* ignore */ }
        if (global.Nav && Nav.markFocused) Nav.markFocused(regexInput);
      }
      return true;
    }, "Enable regex filtering");
    regexToggle.classList.add("import-regex-toggle");

    regexInput.addEventListener("input", function () {
      var p = regexInput.value.trim();
      regexInput.classList.toggle("invalid", regexOn && !!p && !regexValid());
      Store.setImportOption("regex", p);
    });

    var regexRow = document.createElement("div");
    regexRow.className = "import-regex-row";
    regexRow.appendChild(regexInput);
    regexRow.appendChild(regexToggle);
    importOptsPanel.appendChild(regexRow);
    grid.appendChild(importOptsPanel);

    /* Xtream provider */
    var xt = Store.getSettings().xtream || {};
    var xtreamPanel = panel("Xtream Provider", "Add a whole provider using its server URL (with port), username and password. Live channels, VOD movies and series are fetched automatically, directly from your provider. Use Refresh later to pull in any new content.");
    xtreamPanel.classList.add("panel-xtream");
    var xtUrlIn = inputField("url", xt.base || "", "http://server-address:8080");
    var xtUserIn = inputField("text", xt.username || "", "username");
    var xtPassIn = inputField("password", xt.password || "", "password");
    xtreamPanel.appendChild(fieldRow("Server URL (host:port)", xtUrlIn));
    xtreamPanel.appendChild(fieldRow("Username", xtUserIn));
    xtreamPanel.appendChild(fieldRow("Password", xtPassIn));
    var xtActions = document.createElement("div");
    xtActions.className = "url-import-row";
    var xtFetchBtn = buttonEl("btn btn-primary", "⟳ Fetch & add", function () {
      runXtreamFetch(xtUrlIn.value, xtUserIn.value, xtPassIn.value, false);
    });
    xtActions.appendChild(xtFetchBtn);
    if (xt.base) {
      var xtRefreshBtn = buttonEl("btn btn-secondary", "⟳ Refresh", function () {
        runXtreamFetch(xt.base, xt.username, xt.password, true);
      });
      xtActions.appendChild(xtRefreshBtn);
      var xtForget = buttonEl("btn btn-ghost", "Forget credentials", function () {
        confirmModal("Forget saved Xtream credentials?", "Items already imported stay in the library.", function () {
          Store.saveSettings({ xtream: null });
          renderSettings();
          toast("Xtream credentials cleared", "ok");
        });
      });
      xtActions.appendChild(xtForget);
      var xtHint = document.createElement("div");
      xtHint.className = "url-hint";
      xtHint.textContent = "Saved provider: " + xt.base;
      xtreamPanel.appendChild(xtHint);
    }
    xtreamPanel.appendChild(xtActions);
    grid.appendChild(xtreamPanel);

    /* Export */
    var exportPanel = panel("Export M3U", "Download the current library as library.m3u. Embed sources round-trip losslessly.");
    exportPanel.classList.add("panel-export");
    var exportBtn = buttonEl("btn btn-primary", "⬇ Download library.m3u", function () {
      M3UExporter.download(Store.getItems(), "library.m3u");
      toast("Exported library.m3u", "ok");
    });
    exportPanel.appendChild(exportBtn);
    grid.appendChild(exportPanel);

    /* Add */
    var addPanel = panel("Add Content", "Manually add a movie or a series episode without a file.");
    addPanel.classList.add("panel-add");
    var addBtn = buttonEl("btn btn-primary", "+ Add content", function () { App.navigate("#add"); });
    addPanel.appendChild(addBtn);
    grid.appendChild(addPanel);

    /* Edit */
    var editPanel = panel("Edit Content", "Modify an existing item — titles, sources, posters and more.");
    editPanel.classList.add("panel-edit");
    var editBtn = buttonEl("btn btn-secondary", "Edit an item…", function () { openEditPicker(); });
    editPanel.appendChild(editBtn);
    grid.appendChild(editPanel);

    /* Delete */
    var delPanel = panel("Delete Content", "Remove a movie, an episode, or an entire series.");
    delPanel.classList.add("panel-delete");
    var delBtn = buttonEl("btn btn-danger", "Delete an item…", function () { openDeletePicker(); });
    delPanel.appendChild(delBtn);
    grid.appendChild(delPanel);

    /* Maintenance */
    var maintPanel = panel("Maintenance", "Clear history, watchlist, or reset the whole application.");
    maintPanel.classList.add("panel-maint");
    var clearH = buttonEl("btn btn-ghost", "Clear history", function () {
      confirmModal("Clear watch history?", "", function () { Store.clearHistory(); toast("History cleared", "ok"); });
    });
    var clearW = buttonEl("btn btn-ghost", "Clear watchlist", function () {
      confirmModal("Clear the entire watchlist?", "", function () {
        Store.getWatchlist().forEach(function (id) { Store.removeFromWatchlist(id); });
        toast("Watchlist cleared", "ok");
      });
    });
    var clearL = buttonEl("btn btn-ghost", "Clear library", function () {
      confirmModal("Clear the entire library?", "All items, history, progress and watchlist will be removed.", function () {
        Store.clearLibrary();
        toast("Library cleared", "ok");
        App.navigate("#home");
      });
    });
    var reset = buttonEl("btn btn-danger", "Reset application", function () {
      confirmModal("Reset everything?", "This wipes all application data. There is no undo.", function () {
        Store.resetAll();
        location.hash = "#home";
        App.render();
        toast("Application reset", "ok");
      });
    });
    var maintBtns = document.createElement("div");
    maintBtns.className = "maint-actions";
    maintBtns.appendChild(clearH);
    maintBtns.appendChild(clearW);
    maintBtns.appendChild(clearL);
    maintBtns.appendChild(reset);
    maintPanel.appendChild(maintBtns);
    grid.appendChild(maintPanel);

    root.appendChild(grid);
    page.innerHTML = "";
    page.appendChild(root);
  }

  function panel(title, desc) {
    var p = document.createElement("div");
    p.className = "panel";
    var h = document.createElement("h3");
    h.textContent = title;
    var d = document.createElement("p");
    d.textContent = desc;
    p.appendChild(h);
    p.appendChild(d);
    return p;
  }

  function buttonEl(cls, label, fn) {
    var b = document.createElement("button");
    b.className = cls + " focusable";
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  }

  /* A switch-style toggle button for the Import Options. Persists its state
     to settings immediately so the next import respects it. */
  function importOptionToggle(label, hint, key, value) {
    var el = document.createElement("button");
    el.type = "button";
    el.className = "import-toggle focusable" + (value ? " on" : "");
    el.setAttribute("role", "switch");
    el.setAttribute("aria-checked", value ? "true" : "false");
    el.setAttribute("aria-label", label + ": " + (value ? "import enabled" : "import disabled"));

    var text = document.createElement("span");
    text.className = "import-toggle-label";
    var t = document.createElement("span");
    t.textContent = label;
    var h = document.createElement("small");
    h.textContent = hint;
    text.appendChild(t);
    text.appendChild(h);

    var sw = document.createElement("span");
    sw.className = "switch";
    sw.setAttribute("aria-hidden", "true");

    el.appendChild(text);
    el.appendChild(sw);

    el.addEventListener("click", function () {
      value = !value;
      el.classList.toggle("on", value);
      el.setAttribute("aria-checked", value ? "true" : "false");
      el.setAttribute("aria-label", label + ": " + (value ? "import enabled" : "import disabled"));
      Store.setImportOption(key, value);
      toast((value ? "Importing " : "Skipping ") + label + " content", "ok");
    });
    return el;
  }

  /* A bare switch (no label) used next to a field, e.g. the regex skip box.
     onChange(next) may return false to reject the change and keep the old
     state. */
  function switchButton(value, onChange, label) {
    var el = document.createElement("button");
    el.type = "button";
    el.className = "switch-btn focusable" + (value ? " on" : "");
    el.setAttribute("role", "switch");
    el.setAttribute("aria-checked", value ? "true" : "false");
    el.setAttribute("aria-label", label || "Toggle");
    var sw = document.createElement("span");
    sw.className = "switch";
    sw.setAttribute("aria-hidden", "true");
    el.appendChild(sw);
    el.addEventListener("click", function () {
      var next = !value;
      if (onChange && onChange(next) === false) return;
      value = next;
      el.classList.toggle("on", value);
      el.setAttribute("aria-checked", value ? "true" : "false");
    });
    return el;
  }

  function normalizeSource(s) {
    var t = String(s == null ? "" : s).trim().replace(/\s+/g, " ");
    /* Legacy items may still carry the embed marker; treat "*url", a plain
       URL, and its iframe HTML form as the same source so old direct copies
       merge into the embed copy instead of duplicating. */
    if (t.indexOf("*") === 0) t = t.slice(1).trim();
    var m = /<iframe\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(t);
    if (m) t = (m[2] || m[3] || m[4] || "").replace(/&amp;/g, "&").trim();
    return t;
  }

  /* Merge parsed items into the library, keyed by source.
     New sources are added; matching sources update metadata (no duplicates).
     Does a single batched save so huge playlists import without O(n^2) writes.
     Items excluded by the Import Options are dropped here too, so any import
     path (file, URL, Xtream, lazy episode loads) respects the toggles. */
  function mergeIntoLibrary(parsedItems) {
    parsedItems = filterImportItems(parsedItems);
    var p = mergePlanner(Store.getItems());
    parsedItems.forEach(p.mergeItem);
    Store.saveItems(p.merged);
    return p.counts();
  }

  /* Chunked variant used by the import paths. The same merge runs a few
     thousand items at a time and yields between chunks, so importing a huge
     playlist into a large library no longer freezes the UI.
     Resolves with { added, updated, skipped }. */
  /* Serialize all library merges so a background fill, a lazy episode load and
     an import never interleave inside mergeIntoLibraryAsync (each one rebuilds
     and persists the whole library). */
  var mergeQueue = Promise.resolve();
  function queuedMerge(items, onProgress) {
    var run = mergeQueue.then(function () { return mergeIntoLibraryAsync(items, onProgress); });
    mergeQueue = run.catch(function () {});
    return run;
  }

  function mergeIntoLibraryAsync(parsedItems, onProgress) {
    parsedItems = filterImportItems(parsedItems);
    return new Promise(function (resolve) {
      var p = mergePlanner(Store.getItems());
      var i = 0;
      var CHUNK = 2000;
      function step() {
        var end = Math.min(i + CHUNK, parsedItems.length);
        for (; i < end; i++) p.mergeItem(parsedItems[i]);
        if (onProgress) onProgress(parsedItems.length ? Math.floor((i / parsedItems.length) * 100) : 100);
        if (i < parsedItems.length) {
          setTimeout(step, 0);
        } else {
          Store.saveItems(p.merged);
          resolve(p.counts());
        }
      }
      step();
    });
  }

  /* Shared per-item merge logic plus an O(n) source/id lookup index. */
  function mergePlanner(existing) {
    var bySource = new Map();
    var indexById = new Map();
    existing.forEach(function (it, i) {
      bySource.set(normalizeSource(it.source), it);
      indexById.set(it.id, i);
    });

    var seen = {};
    var added = 0, updated = 0, skipped = 0;
    var merged = existing;

    function mergeItem(newIt) {
      var key = normalizeSource(newIt.source);
      /* Series containers have no source — use a synthetic key so they merge properly. */
      if (!key && newIt.type === "series" && newIt.seriesId) key = "series:" + newIt.seriesId;
      if (!key) { skipped++; return; }
      if (seen[key]) { skipped++; return; }
      seen[key] = true;

      var old = bySource.get(key);
      if (old) {
        var patch = {
          title: newIt.title,
          type: newIt.type,
          mediaType: newIt.mediaType,
          live: !!newIt.live,
          source: newIt.source,
          poster: newIt.poster,
          group: newIt.group,
          description: newIt.description,
          tvgId: newIt.tvgId,
          tvgName: newIt.tvgName,
          seriesId: newIt.seriesId,
          seriesName: newIt.seriesName,
          season: newIt.season,
          episode: newIt.episode,
          episodeNumber: newIt.episodeNumber,
          episodeTitle: newIt.episodeTitle
        };
        var idx = indexById.get(old.id);
        merged[idx] = Object.assign({}, old, patch, { id: old.id });
        bySource.set(key, merged[idx]);
        updated++;
      } else {
        merged.push(newIt);
        bySource.set(key, newIt);
        added++;
      }
    }

    return {
      merged: merged,
      mergeItem: mergeItem,
      counts: function () { return { added: added, updated: updated, skipped: skipped }; }
    };
  }

  /* Async import path: merges without freezing the UI and reports progress.
     Resolves true when items were imported. */
  function applyParseResultAsync(result, stay) {
    if (result.errors.length) toast(result.errors.join(" "), "err");
    var reWarn = invalidRegexWarning();
    if (reWarn) toast("Regex filtering is off: " + reWarn, "err");
    var all = result.items || [];
    var items = filterImportItems(all);
    if (!items.length) {
      toast(all.length
        ? "Everything in this playlist is excluded by your Import Options."
        : "No playable entries found.", "err");
      return Promise.resolve(false);
    }
    var filtered = all.length - items.length;
    return mergeIntoLibraryAsync(items, function (pct) {
      setProgressStatus("Importing items… " + pct + "%");
    }).then(function (c) {
      toast("Added " + c.added + " · Updated " + c.updated + " · Duplicates skipped " + c.skipped
        + (filtered ? " · " + filtered + " excluded by import options" : ""), "ok");
      if (stay) App.render();
      else App.navigate("#home");
      return true;
    });
  }

  function importFile(file) {
    var reader = new FileReader();
    showProgress("Importing…", "Reading file…");
    reader.onload = function () {
      var text = reader.result;
      setProgressStatus("Parsing playlist…");
      M3UParser.parseAsync(text, function (pct) {
        setProgressStatus("Parsing playlist… " + pct + "%");
      }).then(function (result) {
        return applyParseResultAsync(result, false);
      }).then(function () {
        hideProgress();
      });
    };
    reader.onerror = function () { hideProgress(); toast("Could not read that file.", "err"); };
    reader.readAsText(file);
  }

  function importFromUrl(url, isRefresh) {
    url = (url || "").trim();
    if (!/^https?:\/\//i.test(url)) {
      toast("Please paste a valid playlist URL.", "err");
      return Promise.resolve(false);
    }

    /* When this page is HTTPS and the playlist URL is HTTP the browser blocks
       the request (mixed content). Try the upgraded https:// link first and
       fall back to the given one, so servers that answer on HTTPS just work. */
    var attempts = [url];
    var isHttpsPage = !!(global.location && global.location.protocol === "https:");
    if (isHttpsPage && /^http:\/\//i.test(url)) {
      attempts.unshift(url.replace(/^http:\/\//i, "https://"));
    }

    function fetchText(u, rest) {
      var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 120000) : null;
      var opts = { referrerPolicy: "no-referrer" };
      if (ctrl) opts.signal = ctrl.signal;
      return fetch(u, opts).then(function (res) {
        if (timer) clearTimeout(timer);
        if (!res.ok) {
          return res.text().catch(function () { return ""; }).then(function (body) {
            var e = new Error("HTTP " + res.status);
            e.status = res.status;
            var t = String(body || "").trim().replace(/\s+/g, " ");
            if (t) e.body = t.slice(0, 300);
            throw e;
          });
        }
        return res.text();
      }).then(function (text) {
        return { url: u, text: text };
      }).catch(function (err) {
        if (timer) clearTimeout(timer);
        if (rest.length) return fetchText(rest[0], rest.slice(1));
        throw err;
      });
    }

    /* Xtream get.php export links get special handling: many providers block
       the get.php playlist (some accounts) or omit series from it entirely,
       so the provider's player_api.php endpoint — which hosts live, movies
       and series — is used to fill in the gaps. */
    var xt = global.Xtream && Xtream.parseGetPhpUrl(url);
    if (xt) {
      /* Register the provider's credentials so lazily loaded series episodes
         keep working after the import (same registry the Xtream panel uses). */
      var st = Store.getSettings();
      var regs2 = Object.assign({}, st.xtreamProviders || {});
      regs2[xt.base] = { username: xt.username, password: xt.password };
      Store.saveSettings({ xtreamProviders: regs2 });
    }

    /* Full provider library via player_api.php (get.php was blocked or empty). */
    function xtApiImport() {
      setProgressStatus("Playlist unavailable — importing via the provider API…");
      return global.Xtream.fetchLibrary(xt.base, xt.username, xt.password)
        .then(function (res) {
          if (!res.items.length) {
            hideProgress();
            toast("The provider API returned no playable items.", "err");
            return false;
          }
          setProgressStatus("Importing items…");
          return applyParseResultAsync({ items: res.items, errors: [] }, isRefresh).then(function (ok) {
            hideProgress();
            return ok;
          });
        });
    }

    /* Playlist imported fine, but series may be missing — merge in the series
       containers from the API (best-effort, deduped by series name). */
    function xtSupplementSeries(result) {
      setProgressStatus("Fetching series from the provider…");
      return global.Xtream.fetchSeriesContainers(xt.base, xt.username, xt.password)
        .then(function (containers) {
          if (containers && containers.length) {
            var names = {};
            result.items.forEach(function (it) {
              if (it.type === "episode" || it.type === "series") {
                var n = (it.seriesName || "").toLowerCase();
                if (n) names[n] = true;
              }
            });
            var fresh = containers.filter(function (c) {
              var n = (c.seriesName || "").toLowerCase();
              return n && !names[n];
            });
            if (fresh.length) result.items = result.items.concat(fresh);
          }
          return applyParseResultAsync(result, isRefresh);
        })
        .catch(function () {
          return applyParseResultAsync(result, isRefresh);
        });
    }

    showProgress(isRefresh ? "Refreshing…" : "Importing…", "Fetching playlist…");
    return fetchText(attempts[0], attempts.slice(1))
      .then(function (res) {
        Store.saveSettings({ m3uUrl: res.url });
        setProgressStatus("Parsing playlist…");
        return M3UParser.parseAsync(res.text, function (pct) {
          setProgressStatus("Parsing playlist… " + pct + "%");
        }).then(function (result) {
          if (xt && !result.items.length) return xtApiImport();
          return xt ? xtSupplementSeries(result) : applyParseResultAsync(result, isRefresh);
        });
      })
      .then(function () {
        hideProgress();
        return true;
      })
      .catch(function (err) {
        if (xt) {
          return xtApiImport().catch(function (err2) {
            hideProgress();
            toast("Could not import this Xtream link: " + ((err2 && err2.message) ? err2.message
              : (err && err.status ? "the playlist was rejected (HTTP " + err.status + ") and the provider API also failed."
                : "the playlist could not be fetched.")), "err");
            return false;
          });
        }
        hideProgress();
        var msg = "Could not fetch the playlist from that URL. The link may be wrong or the server blocks it (CORS).";
        if (err && err.status) {
          if (/get\.php/i.test(url) && /username=/i.test(url)) {
            msg = "This is an Xtream export link and the provider rejected it (HTTP " + err.status + ") — many accounts block the get.php playlist. Use the Xtream panel in Settings (server URL + username + password) instead; it imports through the provider's API.";
          } else {
            msg = "The playlist URL answered with HTTP " + err.status + (err.body ? " — the server says: \"" + err.body + "\"" : "") + ". This is the provider's own rejection (not a browser block) — test the link directly in a browser tab and check with your provider.";
          }
        } else if (isHttpsPage && /^http:\/\//i.test(url)) {
          msg = "Blocked: this page is HTTPS but the playlist URL is HTTP. Browsers refuse to call http:// from a https:// page (mixed content). Fix: open this app over HTTP instead, or use an https:// address if the provider offers one.";
        }
        toast(msg, "err");
        return false;
      });
  }

  /* Refresh every saved source from the navbar button: the saved M3U link and
     the saved Xtream provider (in that order), one after the other — the merge
     rewrites the whole library, so concurrent refreshes would clobber each
     other. Shows an error only when nothing is saved. */
  function refreshSources() {
    var settings = Store.getSettings();
    var jobs = [];
    var m3u = (settings.m3uUrl || "").trim();
    if (m3u) jobs.push(function () { return importFromUrl(m3u, true); });
    var xt = settings.xtream || null;
    if (xt && xt.base && xt.username && xt.password) {
      jobs.push(function () { return runXtreamFetch(xt.base, xt.username, xt.password, true); });
    }
    if (!jobs.length) {
      toast("No saved playlist or provider to refresh. Add one in the Settings page.", "err");
      return;
    }
    if (jobs.length === 1) { jobs[0](); return; }
    /* Run both sources in parallel to cut total refresh time in half. */
    Promise.all(jobs.map(function (j) { return j(); }));
  }

  /* ---------- XTREAM PROVIDER ---------- */
  function runXtreamFetch(base, username, password, isRefresh) {
    var baseClean = global.Xtream ? Xtream.cleanBase(base) : base;
    if (!baseClean || !username || !password) {
      toast("Server URL, username and password are required.", "err");
      return Promise.resolve(false);
    }
    /* Keep a per-provider credential registry (keyed by server base) so lazy
       series-episode loads still work after switching to another provider. */
    var xtSettings = Store.getSettings();
    var regs = Object.assign({}, xtSettings.xtreamProviders || {});
    regs[baseClean] = { username: username, password: password };
    Store.saveSettings({
      xtream: { base: baseClean, username: username, password: password },
      xtreamProviders: regs
    });
    showProgress(isRefresh ? "Refreshing…" : "Importing…", "Contacting provider…");
    return Xtream.fetchLibrary(baseClean, username, password)
      .then(function (res) {
        var reWarn = invalidRegexWarning();
        if (reWarn) toast("Regex filtering is off: " + reWarn, "err");
        if (!res.items || !res.items.length) {
          hideProgress();
          toast("Provider returned no playable items.", "err");
          return false;
        }
        var items = filterImportItems(res.items);
        if (!items.length) {
          hideProgress();
          toast("Everything from this provider is excluded by your Import Options.", "err");
          return false;
        }
        var filtered = res.items.length - items.length;
        setProgressStatus("Importing items…");
        return queuedMerge(items, function (pct) {
          setProgressStatus("Importing items… " + pct + "%");
        }).then(function (c) {
          hideProgress();
          toast("Xtream: Added " + c.added + " · Updated " + c.updated + " · Duplicates skipped " + c.skipped
            + (filtered ? " · " + filtered + " excluded by import options" : ""), "ok");
          if (isRefresh && App && App.render) App.render();
          if (xtSeriesAutoFill && seriesList().some(function (s) { return !s.episodes.length; })) {
            fetchAllSeriesEpisodes();
          }
          return true;
        });
      })
      .catch(function (err) {
        hideProgress();
        toast("Xtream fetch failed: " + (err && err.message ? err.message : "unknown error"), "err");
        return false;
      });
  }

  /* ---------- ADD CONTENT ---------- */
  function renderAdd() {
    var root = document.createElement("div");
    root.className = "page";
    var back = backButton("Settings", "#settings");
    root.appendChild(back);
    var header = document.createElement("div");
    header.className = "section-header";
    var h = document.createElement("h1");
    h.className = "section-title";
    h.textContent = "Add Content";
    header.appendChild(h);
    root.appendChild(header);

    var form = document.createElement("form");
    form.className = "panel";
    form.style.maxWidth = "760px";

    var typeSel = selectField([["movie", "Movie"], ["episode", "Series Episode"], ["series", "Series"]], "movie");
    var mediaSel = selectField([["direct", "Direct URL"], ["embed", "Embed HTML"]], "direct");
    var titleIn = inputField("text", "", "Movie or episode title");
    var sourceIn = textareaField("", "https://…/video.mp4  or  <iframe src=…></iframe>");
    var posterIn = inputField("url", "", "https://…/poster.jpg (optional)");
    var groupIn = inputField("text", "", "e.g. Movies (optional)");
    var descIn = textareaField("", "Optional description");

    var typeRow = fieldRow("Content type", typeSel);
    var mediaRow = fieldRow("Source type", mediaSel);
    var titleRow = fieldRow("Title", titleIn);
    var sourceRow = fieldRow("Source URL or Embed HTML", sourceIn);
    var posterRow = fieldRow("Poster URL", posterIn);
    var groupRow = fieldRow("Group / Category", groupIn);
    var descRow = fieldRow("Description", descIn);

    var epFields = document.createElement("div");
    epFields.style.display = "none";
    var seriesNameRow = fieldRow("Series name", inputField("text", "", "e.g. Example Series"));
    var seasonRow = fieldRow("Season number", inputField("number", "", "1"));
    var episodeRow = fieldRow("Episode number", inputField("number", "", "1"));
    var epTitleRow = fieldRow("Episode title", inputField("text", "", "Optional episode title"));
    [seriesNameRow, seasonRow, episodeRow, epTitleRow].forEach(function (r) { epFields.appendChild(r); });

    var seriesFields = document.createElement("div");
    seriesFields.style.display = "none";
    var seriesTitleRow = fieldRow("Series name", inputField("text", "", "e.g. Example Series"));
    seriesFields.appendChild(seriesTitleRow);

    var formGrid = document.createElement("div");
    formGrid.className = "form-grid";
    [typeRow, mediaRow, titleRow, groupRow, posterRow].forEach(function (r) { formGrid.appendChild(r); });

    form.appendChild(formGrid);
    form.appendChild(descRow);
    form.appendChild(epFields);
    form.appendChild(seriesFields);
    form.appendChild(sourceRow);

    function updateAddUI() {
      var t = typeSel.value;
      epFields.style.display = t === "episode" ? "block" : "none";
      seriesFields.style.display = t === "series" ? "block" : "none";
      mediaRow.style.display = t === "series" ? "none" : "";
      sourceRow.style.display = t === "series" ? "none" : "";
    }

    var actions = document.createElement("div");
    actions.className = "form-actions";
    var save = buttonEl("btn btn-primary", "Save content", null);
    var cancel = buttonEl("btn btn-ghost", "Cancel", null);
    cancel.addEventListener("click", function (e) { e.preventDefault(); App.goBack(); });
    save.addEventListener("click", function (e) {
      e.preventDefault();
      var type = typeSel.value;
      var mediaType = mediaSel.value;
      var title = titleIn.value.trim();
      var source = sourceIn.value.trim();
      var poster = posterIn.value.trim();
      var group = groupIn.value.trim();
      var desc = descIn.value.trim();

      var data = {
        title: title,
        type: type,
        mediaType: mediaType,
        source: source,
        poster: poster,
        group: group,
        description: desc
      };

      if (type === "series") {
        var sTitle = seriesFields.querySelector("input").value.trim();
        if (!sTitle) {
          toast("Series name is required.", "err");
          return;
        }
        data.title = sTitle;
        data.seriesName = sTitle;
        data.seriesId = "series-" + M3UParser.stableId(sTitle);
        data.mediaType = "series";
        data.source = "";
      } else {
        if (!title || !source) {
          toast("Title and source are required.", "err");
          return;
        }
        var detected = M3UParser.detectMediaType(source);
        if (detected === "embed") {
          mediaType = "embed";
          source = M3UParser.normalizeEmbedSource(source);
        }

        if (type === "episode") {
          var sName = epFields.querySelector("input").value.trim();
          var season = parseInt(epFields.querySelectorAll("input")[1].value, 10);
          var epNum = parseInt(epFields.querySelectorAll("input")[2].value, 10);
          var epTitle = epFields.querySelectorAll("input")[3].value.trim();
          if (!sName || !season || !epNum) {
            toast("Series name, season and episode number are required for episodes.", "err");
            return;
          }
          data.seriesName = sName;
          data.seriesId = "series-" + M3UParser.stableId(sName);
          data.season = season;
          data.episode = season;
          data.episodeNumber = epNum;
          data.episodeTitle = epTitle || title;
        }
      }
      data.live = type === "movie" && M3UParser.isLiveSource(data.source);
      Store.addItem(data);
      toast("Content added", "ok");
      App.navigate("#home");
    });
    actions.appendChild(save);
    actions.appendChild(cancel);
    form.appendChild(actions);

    typeSel.addEventListener("change", updateAddUI);
    updateAddUI();

    root.appendChild(form);
    page.innerHTML = "";
    page.appendChild(root);
  }

  /* ---------- EDIT CONTENT ---------- */
  function renderEdit(id) {
    var item = Store.getItem(id);
    if (!item) { App.goBack(); return; }

    var root = document.createElement("div");
    root.className = "page";
    var back = backButton("Back");
    root.appendChild(back);
    var header = document.createElement("div");
    header.className = "section-header";
    var h = document.createElement("h1");
    h.className = "section-title";
    h.textContent = "Edit — " + item.title;
    header.appendChild(h);
    root.appendChild(header);

    var form = document.createElement("form");
    form.className = "panel";
    form.style.maxWidth = "760px";

    var typeSel = selectField([["movie", "Movie"], ["episode", "Series Episode"], ["series", "Series"]], item.type);
    var mediaSel = selectField([["direct", "Direct URL"], ["embed", "Embed HTML"]], item.mediaType);
    var titleIn = inputField("text", item.title);
    var sourceIn = textareaField(item.source);
    var posterIn = inputField("url", item.poster);
    var groupIn = inputField("text", item.group);
    var descIn = textareaField(item.description);

    var mediaRowEdit = fieldRow("Source type", mediaSel);
    var sourceRowEdit = fieldRow("Source URL or Embed HTML", sourceIn);

    var epFields = document.createElement("div");
    epFields.style.display = item.type === "episode" ? "block" : "none";
    var sNameIn = inputField("text", item.seriesName || "");
    var seasonIn = inputField("number", item.season || "");
    var epNumIn = inputField("number", item.episodeNumber || "");
    var epTitleIn = inputField("text", item.episodeTitle || "");
    [fieldRow("Series name", sNameIn), fieldRow("Season number", seasonIn), fieldRow("Episode number", epNumIn), fieldRow("Episode title", epTitleIn)].forEach(function (r) { epFields.appendChild(r); });

    var seriesFields = document.createElement("div");
    seriesFields.style.display = item.type === "series" ? "block" : "none";
    var seriesTitleIn = inputField("text", item.seriesName || item.title || "");
    seriesFields.appendChild(fieldRow("Series name", seriesTitleIn));

    form.appendChild(fieldRow("Content type", typeSel));
    form.appendChild(mediaRowEdit);
    form.appendChild(fieldRow("Title", titleIn));
    form.appendChild(sourceRowEdit);
    form.appendChild(fieldRow("Poster URL", posterIn));
    form.appendChild(fieldRow("Group / Category", groupIn));
    form.appendChild(fieldRow("Description", descIn));
    form.appendChild(epFields);
    form.appendChild(seriesFields);

    function updateEditUI() {
      var t = typeSel.value;
      epFields.style.display = t === "episode" ? "block" : "none";
      seriesFields.style.display = t === "series" ? "block" : "none";
      mediaRowEdit.style.display = t === "series" ? "none" : "";
      sourceRowEdit.style.display = t === "series" ? "none" : "";
    }

    var actions = document.createElement("div");
    actions.className = "form-actions";
    var save = buttonEl("btn btn-primary", "Save changes", null);
    var cancel = buttonEl("btn btn-ghost", "Cancel", null);
    cancel.addEventListener("click", function (e) { e.preventDefault(); App.goBack(); });
    save.addEventListener("click", function (e) {
      e.preventDefault();
      var type = typeSel.value;
      var patch = {
        title: titleIn.value.trim() || item.title,
        type: type,
        mediaType: mediaSel.value,
        source: sourceIn.value.trim(),
        poster: posterIn.value.trim(),
        group: groupIn.value.trim(),
        description: descIn.value.trim()
      };
      if (type === "episode") {
        var sName = sNameIn.value.trim();
        var season = parseInt(seasonIn.value, 10);
        var epNum = parseInt(epNumIn.value, 10);
        if (!sName || !season || !epNum) { toast("Series name, season and episode are required.", "err"); return; }
        patch.seriesName = sName;
        patch.seriesId = "series-" + M3UParser.stableId(sName);
        patch.season = season;
        patch.episode = season;
        patch.episodeNumber = epNum;
        patch.episodeTitle = epTitleIn.value.trim() || patch.title;
        patch.type = "episode";
      } else if (type === "series") {
        var sTitle = seriesTitleIn.value.trim();
        if (!sTitle) { toast("Series name is required.", "err"); return; }
        var newSeriesId = "series-" + M3UParser.stableId(sTitle);
        if (newSeriesId !== item.seriesId) {
          Store.getItems().forEach(function (it) {
            if (it.seriesId === item.seriesId) Store.updateItem(it.id, { seriesId: newSeriesId, seriesName: sTitle });
          });
        }
        patch.title = sTitle;
        patch.seriesName = sTitle;
        patch.seriesId = newSeriesId;
        patch.mediaType = "series";
        patch.source = "";
        patch.season = null; patch.episode = null; patch.episodeNumber = null; patch.episodeTitle = null;
      } else {
        patch.seriesId = null; patch.seriesName = null; patch.season = null;
        patch.episode = null; patch.episodeNumber = null; patch.episodeTitle = null;
        if (patch.type !== "series" && M3UParser.detectMediaType(patch.source) === "embed") {
          patch.mediaType = "embed";
          patch.source = M3UParser.normalizeEmbedSource(patch.source);
        }
      }
      if (String(patch.source) !== String(item.source || "")) {
        patch.live = type === "movie" ? !!M3UParser.isLiveSource(patch.source) : false;
      }
      Store.updateItem(item.id, patch);
      toast("Changes saved", "ok");
      if (type === "series") {
        App.navigate("#series/" + encodeURIComponent(patch.seriesId || item.seriesId || ""));
      } else {
        App.goBack();
      }
    });
    actions.appendChild(save);
    actions.appendChild(cancel);
    form.appendChild(actions);

    typeSel.addEventListener("change", updateEditUI);
    updateEditUI();

    root.appendChild(form);
    page.innerHTML = "";
    page.appendChild(root);
  }

  function fieldRow(label, field) {
    var wrap = document.createElement("div");
    wrap.className = "form-row";
    var l = document.createElement("label");
    l.textContent = label;
    wrap.appendChild(l);
    wrap.appendChild(field);
    return wrap;
  }
  function inputField(type, value, placeholder) {
    var i = document.createElement("input");
    i.type = type;
    i.value = value || "";
    i.placeholder = placeholder || "";
    i.className = "focusable";
    i.dataset.f = i.type === "number" ? "" : "";
    return i;
  }
  function textareaField(value, placeholder) {
    var t = document.createElement("textarea");
    t.value = value || "";
    t.placeholder = placeholder || "";
    t.className = "focusable";
    return t;
  }
  function selectField(options, selected) {
    var s = document.createElement("select");
    s.className = "focusable";
    options.forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o[0];
      opt.textContent = o[1];
      if (o[0] === selected) opt.selected = true;
      s.appendChild(opt);
    });
    return s;
  }

  /* ---------- Edit / Delete pickers ---------- */
  function openEditPicker() {
    pickerModal("Edit which item?", Store.getItems(), function (it) { App.navigate("#edit/" + encodeURIComponent(it.id)); });
  }

  function openDeletePicker() {
    pickerModal("Delete which item?", Store.getItems(), function (it) {
      if (it.type === "series") {
        confirmModal("Delete “" + it.title + "”?", "This removes every episode of the series, plus its watch history, progress and watchlist entries. This cannot be undone.", function () {
          Store.getItems().forEach(function (x) { if (x.seriesId === it.seriesId) Store.removeItem(x.id); });
          Store.removeItem(it.id);
          Store.removeSeriesFromWatchlist(it.seriesId);
          renderSettings();
          toast("Series deleted", "ok");
        });
        return;
      }
      if (it.type === "episode") {
        var s = getSeries(it.seriesId);
        if (s && s.episodes.length <= 1) {
          confirmModal("Delete “" + it.title + "”?", "This is the last episode of this series. Its history, progress and watchlist entries will be removed.", function () { Store.removeItem(it.id); Store.removeSeriesFromWatchlist(it.seriesId); renderSettings(); toast("Deleted", "ok"); });
          return;
        }
      }
      confirmModal("Delete “" + it.title + "”?", "Its history, progress and watchlist entry will also be removed. This cannot be undone.", function () {
        Store.removeItem(it.id);
        renderSettings();
        toast("Deleted", "ok");
      });
    });
  }

  /* ---------- Modals ---------- */
  function confirmModal(title, message, onOk) {
    var root = document.createElement("div");
    root.className = "modal";
    var h = document.createElement("h3");
    h.textContent = title;
    root.appendChild(h);
    if (message) {
      var p = document.createElement("p");
      p.style.color = "var(--text-dim)";
      p.style.margin = "8px 0 4px";
      p.textContent = message;
      root.appendChild(p);
    }
    var actions = document.createElement("div");
    actions.className = "modal-actions";
    var ok = buttonEl("btn btn-danger", "Delete", null);
    var no = buttonEl("btn btn-secondary", "Cancel", null);
    ok.addEventListener("click", function () { closeModal(); onOk(); });
    no.addEventListener("click", closeModal);
    actions.appendChild(ok);
    actions.appendChild(no);
    root.appendChild(actions);
    showModal(root, no);
  }

  function pickerModal(title, items, onPick) {
    var root = document.createElement("div");
    root.className = "modal";
    var h = document.createElement("h3");
    h.textContent = title;
    root.appendChild(h);

    var search = document.createElement("input");
    search.type = "text";
    search.className = "picker-search focusable";
    search.placeholder = "Search items…";
    root.appendChild(search);

    var list = document.createElement("div");
    list.className = "result-list";
    list.style.maxHeight = "45vh";
    list.style.overflow = "auto";
    root.appendChild(list);

    var firstMatched = null;
    var firstRowEl = null;

    function labelOf(it) {
      return it.type === "episode"
        ? (it.seriesName + " — S" + pad(it.season) + "E" + pad(it.episodeNumber) + (it.episodeTitle ? " · " + it.episodeTitle : ""))
        : it.title;
    }

    function render(q) {
      list.innerHTML = "";
      firstMatched = null;
      firstRowEl = null;
      var ql = (q || "").trim().toLowerCase();
      items.forEach(function (it) {
        var label = labelOf(it);
        var hay = (label + " " + (it.group || "") + " " + (it.tvgName || "")).toLowerCase();
        if (ql && hay.indexOf(ql) === -1) return;
        var row = document.createElement("button");
        row.className = "result-item focusable";
        row.textContent = label;
        row.addEventListener("click", function () { closeModal(); onPick(it); });
        list.appendChild(row);
        if (!firstMatched) { firstMatched = it; firstRowEl = row; }
      });
      if (!list.children.length) {
        var none = document.createElement("div");
        none.className = "empty";
        none.style.padding = "30px 10px";
        none.textContent = "No items match.";
        list.appendChild(none);
      }
    }

    var debounce;
    search.addEventListener("input", function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () { render(search.value); }, 100);
    });
    search.addEventListener("keydown", function (e) {
      if (Nav.keyName(e) === "enter" && firstMatched) {
        e.preventDefault();
        closeModal();
        onPick(firstMatched);
      }
    });

    render("");

    var actions = document.createElement("div");
    actions.className = "modal-actions";
    var no = buttonEl("btn btn-secondary", "Cancel", null);
    no.addEventListener("click", closeModal);
    actions.appendChild(no);
    root.appendChild(actions);
    showModal(root, search);
  }

  var lastFocusBeforeModal = null;

  function showModal(modalEl, defaultFocus) {
    lastFocusBeforeModal = document.activeElement;
    modalRoot.innerHTML = "";
    modalRoot.appendChild(modalEl);
    modalRoot.hidden = false;
    setTimeout(function () {
      var f = defaultFocus || modalEl.querySelector(".focusable");
      if (f) {
        try { f.focus(); } catch (e) { /* ignore */ }
        if (global.Nav && Nav.markFocused) Nav.markFocused(f);
      }
    }, 30);
  }
  function closeModal() {
    modalRoot.innerHTML = "";
    modalRoot.hidden = true;
    if (lastFocusBeforeModal && document.body.contains(lastFocusBeforeModal)) {
      try { lastFocusBeforeModal.focus(); } catch (e) { /* ignore */ }
      if (global.Nav && Nav.markFocused) Nav.markFocused(lastFocusBeforeModal);
    }
    lastFocusBeforeModal = null;
  }
  function modalOpen() {
    return !modalRoot.hidden;
  }

  function refreshBadges() {
    if (Player.isActive()) return;
    App.render();
  }

  global.UI = {
    escapeHtml: escapeHtml,
    toast: toast,
    card: card,
    makeRow: makeRow,
    posterEl: posterEl,
    fallbackIcon: fallbackIcon,
    renderHome: renderHome,
    renderMovies: renderMovies,
    renderLive: renderLive,
    renderCategory: renderCategory,
    renderSeries: renderSeries,
    renderCategories: renderCategories,
    renderSeriesDetails: renderSeriesDetails,
    renderMovieDetails: renderMovieDetails,
    renderWatchlist: renderWatchlist,
    renderHistory: renderHistory,
    renderSearch: renderSearch,
    renderSettings: renderSettings,
    renderAdd: renderAdd,
    renderEdit: renderEdit,
    importFile: importFile,
    importFromUrl: importFromUrl,
    refreshSources: refreshSources,
    mergeIntoLibrary: mergeIntoLibrary,
    setProgressStatus: setProgressStatus,
    confirmModal: confirmModal,
    closeModal: closeModal,
    modalOpen: modalOpen,
    refreshBadges: refreshBadges,
    pad: pad,
    episodeLabel: episodeLabel,
    progressOf: progressOf,
    isWatched: isWatched,
    seriesList: seriesList,
    getSeries: getSeries,
    fetchAllSeriesEpisodes: fetchAllSeriesEpisodes,
    isLiveItem: isLiveItem,
    liveItems: liveItems,
    isAdultItem: isAdultItem,
    shouldImportItem: shouldImportItem
  };
})(window);
