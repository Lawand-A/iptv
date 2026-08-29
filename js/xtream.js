/* Xtream Codes client — fetches a provider's library via player_api.php.
   Requests are made directly (no third-party proxies). If the JSON API is
   blocked at the network level, it falls back to the provider's own M3U
   export (get.php), which is still a direct call to the provider.
   Converts live streams, VOD movies and series into library items so they
   can be merged into the app (and refreshed later to pick up new content). */
(function (global) {
  "use strict";

  if (global.console) console.log("[build] xtream.js v11 (CORS proxy fallback)");

  var API_PATH = "player_api.php";

  function enc(v) { return encodeURIComponent(String(v == null ? "" : v)); }

  /* Normalize a user-supplied server address into "scheme://host:port". */
  function cleanBase(base) {
    var u = String(base || "").trim().replace(/\/+$/, "");
    if (!u) return "";
    if (u.indexOf("://") === -1) u = "http://" + u;
    return u.replace(/\/+$/, "");
  }

  function apiUrl(base, user, pass, action, extra) {
    var q = "username=" + enc(user) + "&password=" + enc(pass) + "&action=" + enc(action);
    if (extra) {
      Object.keys(extra).forEach(function (k) { q += "&" + enc(k) + "=" + enc(extra[k]); });
    }
    return base + "/" + API_PATH + "?" + q;
  }

  /* Build the URL for the built-in CORS proxy (Cloudflare Pages Function).
     When the app is hosted on the same origin the proxy is right here;
     otherwise fall back to no proxy (direct fetch only). */
  function proxyUrl(url) {
    var loc = global.location;
    var origin = loc ? (loc.protocol + "//" + loc.host) : "";
    if (!origin) return "";
    return origin + "/api/proxy?url=" + encodeURIComponent(url);
  }

  /* True when the error looks like a CORS or mixed-content block:
     the browser refused the request at the network level before getting
     an HTTP response. */
  function isCorsLikeError(err) {
    if (!err) return false;
    /* AbortError is a timeout, not CORS. */
    if (err.name === "AbortError") return false;
    /* TypeError is what Chrome/Firefox throw for CORS blocks and network errors. */
    if (err instanceof TypeError) return true;
    /* Some browsers use "Failed to fetch" or "NetworkError". */
    var msg = String(err.message || err).toLowerCase();
    return msg.indexOf("cors") !== -1 || msg.indexOf("network") !== -1 || msg.indexOf("failed to fetch") !== -1;
  }

  function directFetch(url) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 120000) : null;
    return new Promise(function (resolve, reject) {
      /* no-referrer: many IPTV servers reject requests that carry a website
         Referer (hotlink protection). Opening the app from file:// sent no
         Referer, so this keeps that behaviour when the app is hosted. */
      fetch(url, Object.assign(ctrl ? { signal: ctrl.signal } : {}, { referrerPolicy: "no-referrer" })).then(function (res) {
        if (timer) clearTimeout(timer);
        resolve(res);
      }, function (err) {
        if (timer) clearTimeout(timer);
        reject(err);
      });
    });
  }

  function request(url) {
    return directFetch(url).catch(function (err) {
      /* If the direct fetch failed with what looks like a CORS block,
         automatically retry through the built-in proxy. The proxy runs
         server-side (Cloudflare Pages Function) so CORS does not apply. */
      if (isCorsLikeError(err)) {
        var proxied = proxyUrl(url);
        if (proxied) {
          return directFetch(proxied);
        }
      }
      throw err;
    });
  }

  /* Fetch a URL directly. Falls back to the built-in CORS proxy (Cloudflare
     Pages Function at /api/proxy) when the request is blocked by CORS. */
  function fetchDirect(url, parse) {
    return request(url).then(function (res) {
      if (!res.ok) {
        /* Providers often put the real reason (expired account, wrong
           credentials, etc.) in the error body — read it and carry it through
           so it can be shown to the user. */
        return res.text().catch(function () { return ""; }).then(function (body) {
          var e = new Error("HTTP " + res.status);
          e.http = true;
          e.status = res.status;
          var t = String(body || "").trim().replace(/\s+/g, " ");
          if (t) e.body = t.slice(0, 300);
          throw e;
        });
      }
      return parse(res);
    });
  }

  function fetchJson(url) {
    return fetchDirect(url, function (res) {
      return res.json().then(function (data) {
        if (data && typeof data === "object" && !Array.isArray(data) && data.error) {
          throw new Error(String(data.error));
        }
        return data;
      });
    });
  }

  function fetchText(url) {
    return fetchDirect(url, function (res) { return res.text(); });
  }

  /* Build a clear, actionable message for a network-level failure. */
  function describeFetchError(err, url) {
    if (err && err.name === "AbortError") {
      return "The provider took too long to respond (timeout after 120s). Check that the server address and port are correct.";
    }
    if (err && err.http) {
      var body = err.body ? " Server says: \"" + err.body + "\"." : "";
      return "The provider answered with HTTP " + err.status + "." + body + " This is the provider's own rejection (not a browser block) — usually wrong or expired credentials, max connections reached, or the account being restricted. Test the same URL directly in a browser tab, and check with your provider.";
    }
    var pageProto = global.location ? global.location.protocol : "";
    var m = /^([a-z]+):\/\//i.exec(String(url || ""));
    var targetProto = m ? m[1] : "";
    if (pageProto === "https:" && targetProto === "http") {
      return "Blocked: this page is HTTPS but the Xtream server is HTTP (mixed content). The built-in proxy was also unable to reach the server. Open the server URL in a browser tab to confirm it responds, and check with your provider.";
    }
    if (pageProto === "file:") {
      return "The app is opened straight from disk (file://), and Chrome/Edge block all network requests from file:// pages. Open this app via http:// or https://, then try again.";
    }
    return "Could not reach the provider: its server is unreachable or actively refusing the connection. Open the server URL in a browser tab to confirm it responds. If it loads there but not here, the server may be blocking connections from cloud networks — check with your provider.";
  }

  /* First non-empty value among candidate keys. */
  function pick(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj && obj[keys[i]];
      if (v != null && v !== "") return v;
    }
    return "";
  }

  function iconOf(v) {
    if (!v) return "";
    if (typeof v === "object") return pick(v, ["src", "url", "backdrop_path"]) || "";
    return String(v);
  }

  /* Resolve poster/logo URLs against the provider base. Many Xtream servers
     return relative paths like "/images/logo.png" which would otherwise be
     requested from the app's own origin and fail to load. */
  function absUrl(base, u) {
    var s = String(u || "").trim();
    if (!s) return "";
    if (/^https?:\/\//i.test(s) || s.indexOf("//") === 0) return s;
    if (s.indexOf("/") === 0) return base + s;
    return s;
  }

  /* Stream URL builders (standard Xtream paths). */
  function liveUrl(base, user, pass, id) {
    return base + "/live/" + enc(user) + "/" + enc(pass) + "/" + id + ".m3u8";
  }
  function vodUrl(base, user, pass, id, ext) {
    return base + "/movie/" + enc(user) + "/" + enc(pass) + "/" + id + (ext ? "." + ext : "");
  }
  function seriesUrl(base, user, pass, id, ext) {
    return base + "/series/" + enc(user) + "/" + enc(pass) + "/" + id + (ext ? "." + ext : "");
  }

  function baseItem(id, title) {
    return {
      id: id,
      title: title,
      type: "movie",
      mediaType: "direct",
      source: "",
      poster: "",
      group: "",
      description: "",
      tvgId: null,
      tvgName: null,
      seriesId: null,
      seriesName: null,
      season: null,
      episode: null,
      episodeNumber: null,
      episodeTitle: null,
      addedAt: Date.now()
    };
  }

  function fetchCategories(base, user, pass, action) {
    return fetchJson(apiUrl(base, user, pass, action)).then(function (list) {
      var m = {};
      if (Array.isArray(list)) {
        list.forEach(function (c) {
          if (c && c.category_id != null) {
            m[c.category_id] = pick(c, ["category_name", "category_name2"]) || "";
          }
        });
      }
      return m;
    }).catch(function () { return {}; });
  }

  function fetchLive(base, user, pass, catMap) {
    return fetchJson(apiUrl(base, user, pass, "get_live_streams")).then(function (list) {
      if (!Array.isArray(list)) throw new Error("No live streams returned (bad credentials or empty account).");
      return list.map(function (s) {
        var name = pick(s, ["name"]) || "Channel " + s.stream_id;
        var it = baseItem("xt-live-" + s.stream_id, name);
        it.live = true;
        it.source = liveUrl(base, user, pass, s.stream_id);
        it.alts = [
          base + "/" + enc(user) + "/" + enc(pass) + "/" + s.stream_id,
          base + "/" + enc(user) + "/" + enc(pass) + "/" + s.stream_id + ".m3u8",
          base + "/live/" + enc(user) + "/" + enc(pass) + "/" + s.stream_id
        ];
        it.poster = absUrl(base, iconOf(s.stream_icon));
        it.group = catMap[s.category_id] || pick(s, ["category_name"]) || "Live";
        it.tvgId = s.epg_channel_id || String(s.stream_id);
        it.tvgName = name;
        return it;
      });
    });
  }

  function fetchVod(base, user, pass, catMap) {
    return fetchJson(apiUrl(base, user, pass, "get_vod_streams")).then(function (list) {
      if (!Array.isArray(list)) throw new Error("No VOD movies returned.");
      return list.map(function (s) {
        var name = pick(s, ["name"]) || "Movie " + s.stream_id;
        var ext = String(pick(s, ["container_extension"]) || "mp4").replace(/^\./, "");
        var it = baseItem("xt-vod-" + s.stream_id, name);
        it.source = vodUrl(base, user, pass, s.stream_id, ext);
        it.poster = absUrl(base, iconOf(s.stream_icon));
        it.group = catMap[s.category_id] || pick(s, ["category_name"]) || "Movies";
        it.description = pick(s, ["plot", "description"]) || "";
        it.tvgId = String(s.stream_id);
        return it;
      });
    });
  }

  function seriesInfoToEpisodes(info, series, base, user, pass, catMap, groupFallback) {
    var items = [];
    var infoName = pick(info, ["name"]) || pick(series, ["name"]) || "Series";
    var cover = absUrl(base, iconOf(pick(info, ["cover"])) || iconOf(pick(series, ["cover"])));
    var seasons = [];
    var bySeason = {};
    /* Some providers put the episodes inside info.seasons entries; others only
       in the info.episodes map keyed by season number (notably trial accounts,
       whose `seasons` array is metadata-only). Merge both, preferring whichever
       actually contains episodes, deduped by season number. */
    if (Array.isArray(info.seasons)) {
      info.seasons.forEach(function (s) {
        var n = s.season_number != null ? parseInt(s.season_number, 10) : 1;
        var eps = Array.isArray(s.episodes) ? s.episodes : [];
        if (eps.length) bySeason[n] = { season_number: n, episodes: eps };
      });
    }
    if (info.episodes && typeof info.episodes === "object") {
      Object.keys(info.episodes).forEach(function (sNum) {
        var eps = info.episodes[sNum];
        if (Array.isArray(eps) && eps.length) {
          var n = parseInt(sNum, 10) || 1;
          if (!bySeason[n]) bySeason[n] = { season_number: n, episodes: eps };
        }
      });
    }
    Object.keys(bySeason).sort(function (a, b) { return a - b; }).forEach(function (k) {
      seasons.push(bySeason[k]);
    });
    seasons.forEach(function (season) {
      var seasonNo = season.season_number != null ? season.season_number : 1;
      (Array.isArray(season.episodes) ? season.episodes : []).forEach(function (ep) {
        var epId = String(ep.id != null ? ep.id : "");
        if (!epId) return;
        var ext = String(pick(ep, ["container_extension"]) || "mp4").replace(/^\./, "");
        var it = baseItem("xt-ep-" + epId, ep.title || infoName);
        it.type = "episode";
        it.source = seriesUrl(base, user, pass, epId, ext);
        it.poster = absUrl(base, iconOf(ep.info ? pick(ep.info, ["movie_image"]) : "")) || cover;
        it.group = catMap[series.category_id] || pick(series, ["category_name"]) || groupFallback || "Series";
        it.description = ep.info ? pick(ep.info, ["plot"]) || "" : "";
        it.seriesId = "xt-series-" + series.series_id;
        it.seriesName = infoName;
        it.season = seasonNo;
        it.episode = seasonNo;
        it.episodeNumber = ep.episode_number != null ? parseInt(ep.episode_number, 10)
          : (ep.episode_num != null ? parseInt(ep.episode_num, 10) : 0);
        it.episodeTitle = ep.title || "";
        items.push(it);
      });
    });
    return items;
  }

  function fetchSeries(base, user, pass, catMap) {
    return fetchJson(apiUrl(base, user, pass, "get_series")).then(function (list) {
      if (!Array.isArray(list)) throw new Error("No series returned.");
      var containers = list.map(function (s) {
        var name = pick(s, ["name"]) || "Series " + s.series_id;
        var it = baseItem("xt-series-" + s.series_id, name);
        it.type = "series";
        it.mediaType = "series";
        it.poster = absUrl(base, iconOf(s.cover));
        it.group = catMap[s.category_id] || pick(s, ["category_name"]) || "Series";
        it.seriesId = "xt-series-" + s.series_id;
        it.seriesName = name;
        it.xtSeriesId = String(s.series_id);
        it.xtBase = base;
        return it;
      });
      /* Episodes are loaded lazily per-series (fetchSeriesEpisodes) so importing
         a provider with tens of thousands of series never needs one
         get_series_info request per series just to build the library. */
      return { containers: containers, episodes: [] };
    });
  }

  /* Lazy per-series episode loader. `ctx` is the saved provider connection
     { base, username, password } from settings.xtream. Resolves to the episode
     items of a single series, fetched on demand when the series is opened. */
  function fetchSeriesEpisodes(ctx, seriesId, name, group) {
    var m = /^xt-series-(\d+)$/.exec(String(seriesId || ""));
    if (!m) return Promise.reject(new Error("This series has no Xtream provider id."));
    if (!ctx || !ctx.base || !ctx.username || !ctx.password) {
      return Promise.reject(new Error("The provider's credentials are no longer saved. Re-import the provider to load episodes."));
    }
    var b = cleanBase(ctx.base);
    return fetchJson(apiUrl(b, ctx.username, ctx.password, "get_series_info", { series_id: m[1] })).then(function (info) {
      if (!info || typeof info !== "object" || Array.isArray(info)) return [];
      return seriesInfoToEpisodes(info, {
        series_id: m[1],
        category_id: null,
        category_name: "",
        name: name
      }, b, ctx.username, ctx.password, {}, group);
    });
  }

  /* -------- M3U fallback (get.php) -------- */
  var DIRECT_MEDIA_RE = /\.(mp4|m4v|mkv|webm|mov|ogv|avi)(\?|#|$)/i;

  /* Detect an Xtream playlist export link (get.php) and pull out the provider
     base, username and password, so a plain URL import can also talk to the
     provider's player_api.php endpoint. Returns null when the link is not an
     Xtream export. */
  function parseGetPhpUrl(url) {
    var u = String(url || "").trim();
    var m = /^([a-z][a-z0-9+.-]*:\/\/[^\/?#]+)\/get\.php(?:\?|#|$)/i.exec(u);
    if (!m) return null;
    var qIdx = u.indexOf("?");
    var qs = qIdx >= 0 ? u.slice(qIdx + 1) : "";
    function qv(name) {
      var mm = new RegExp("(?:^|&)" + name + "=([^&]*)", "i").exec(qs);
      if (!mm) return "";
      try { return decodeURIComponent(mm[1]); } catch (e) { return mm[1]; }
    }
    var username = qv("username"), password = qv("password");
    if (!username || !password) return null;
    return { base: m[1].replace(/\/+$/, ""), username: username, password: password };
  }

  /* Best-effort fetch of the series containers only (no episodes), for merging
     into a playlist import so the Series section is populated even when an
     Xtream get.php export is blocked or does not include episode entries.
     Episodes stay lazy (fetchSeriesEpisodes). Resolves to [] on any failure. */
  function fetchSeriesContainers(base, user, pass) {
    return fetchCategories(base, user, pass, "get_series_categories").then(function (catMap) {
      return fetchSeries(base, user, pass, catMap).then(function (r) {
        return r.containers || [];
      });
    }).catch(function () { return []; });
  }

  /* The m3u_plus export uses the classic URL form (base/user/pass/id).
     Enrich those entries with alternate HLS forms and mark them live so the
     player tries them through hls.js instead of the plain <video> tag. */
  function enrichM3uItem(it, base, user, pass) {
    var src = String(it.source || "");
    var m = /\/(\d+)(?:\.([a-z0-9]+))?(\?|$)/i.exec(src);
    if (!m || src.indexOf(base) !== 0 || DIRECT_MEDIA_RE.test(src)
        || /\/movie\//i.test(src) || /\/series\//i.test(src)) {
      if (it.poster && !/^https?:/i.test(it.poster) && it.poster.indexOf("//") !== 0) {
        return Object.assign({}, it, { poster: absUrl(base, it.poster) });
      }
      return it;
    }
    var id = m[1];
    var alts = [
      liveUrl(base, user, pass, id),
      base + "/" + enc(user) + "/" + enc(pass) + "/" + id,
      base + "/" + enc(user) + "/" + enc(pass) + "/" + id + ".m3u8",
      base + "/live/" + enc(user) + "/" + enc(pass) + "/" + id
    ];
    var seen = {};
    alts = alts.filter(function (u) { return u !== src && !seen[u] && (seen[u] = true); });
    return Object.assign({}, it, { live: true, source: src, alts: alts, poster: absUrl(base, it.poster) });
  }

  /* The provider's own M3U export URL — the same URL a plain playlist import
     would use, so the fetch behaves exactly like the URL import path. */
  function m3uUrl(base, user, pass) {
    return base + "/get.php?username=" + enc(user) + "&password=" + enc(pass) + "&type=m3u_plus&output=ts";
  }

  function fetchM3u(base, user, pass) {
    return fetchText(m3uUrl(base, user, pass)).then(function (text) {
      if (!global.M3UParser) throw new Error("M3U parser unavailable.");
      /* Parse asynchronously in chunks so a huge provider export never freezes
         the UI; surface progress through the import overlay when visible. */
      return M3UParser.parseAsync(text, function (pct) {
        if (global.UI && UI.setProgressStatus) UI.setProgressStatus("Parsing provider playlist… " + pct + "%");
      }).then(function (res) {
        var items = (res.items || []).map(function (it) { return enrichM3uItem(it, base, user, pass); });
        var counts = { live: 0, vod: 0, series: 0, episodes: 0 };
        items.forEach(function (it) {
          if (it.live) counts.live++;
          else if (it.type === "episode") counts.episodes++;
          else if (it.type === "series") counts.series++;
          else counts.vod++;
        });
        return { items: items, counts: counts, base: base, viaM3u: true };
      });
    });
  }

  function fetchJsonApi(b, user, pass) {
    if (global.UI && UI.setProgressStatus) UI.setProgressStatus("Fetching provider categories…");
    var liveCat = fetchCategories(b, user, pass, "get_live_categories");
    var vodCat = fetchCategories(b, user, pass, "get_vod_categories");
    var seriesCat = fetchCategories(b, user, pass, "get_series_categories");
    return Promise.all([liveCat, vodCat, seriesCat]).then(function (cats) {
      if (global.UI && UI.setProgressStatus) UI.setProgressStatus("Fetching live channels, movies and series…");
      return Promise.all([
        fetchLive(b, user, pass, cats[0]),
        fetchVod(b, user, pass, cats[1]),
        fetchSeries(b, user, pass, cats[2])
      ]).then(function (groups) {
        var seriesOut = groups[2];
        var items = groups[0].concat(groups[1], seriesOut.containers, seriesOut.episodes);
        return {
          items: items,
          counts: { live: groups[0].length, vod: groups[1].length, series: seriesOut.containers.length, episodes: seriesOut.episodes.length },
          base: b,
          viaM3u: false
        };
      });
    });
  }

  /* Fetch the whole provider library. Resolves to { items, counts }.
     Same as a URL import: fetch the provider's own M3U export (get.php) and
     parse it. Many servers disable player_api (HTTP 503) while get.php always
     works, so the JSON player_api is only used as a last resort if get.php is
     unreachable. No third-party proxies are used.
     When this page is HTTPS and the server address is HTTP, the browser blocks
     the request (mixed content). Many servers also answer on HTTPS, so the
     upgraded https:// address is tried first and the given one falls back. */
  function fetchLibrary(base, user, pass) {
    var b = cleanBase(base);
    if (!b) return Promise.reject(new Error("Server URL is required (e.g. http://host:8080)."));
    if (!user || !pass) return Promise.reject(new Error("Username and password are required."));

    var attempts = [b];
    var up = String(b).replace(/^http:\/\//i, "https://");
    if (up !== b && global.location && global.location.protocol === "https:") {
      attempts.unshift(up);
    }

    function fetchFrom(baseForAttempt) {
      return fetchM3u(baseForAttempt, user, pass).catch(function () {
        if (global.UI && UI.setProgressStatus) {
          UI.setProgressStatus("Provider blocked the playlist (get.php). Fetching via its API instead…");
        }
        return fetchJsonApi(baseForAttempt, user, pass);
      });
    }

    var lastErr = null;
    var p = Promise.reject(new Error("__start__"));
    attempts.forEach(function (ab) {
      p = p.catch(function (err) { lastErr = err; return fetchFrom(ab); });
    });
    return p.catch(function () {
      throw new Error(describeFetchError(lastErr, m3uUrl(b, user, pass)));
    });
  }

  global.Xtream = {
    cleanBase: cleanBase,
    fetchLibrary: fetchLibrary,
    fetchSeriesEpisodes: fetchSeriesEpisodes,
    fetchSeriesContainers: fetchSeriesContainers,
    parseGetPhpUrl: parseGetPhpUrl,
    apiUrl: apiUrl
  };
})(window);
