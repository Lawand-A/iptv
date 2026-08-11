/* M3U parser — converts playlist text into library items.
   Also exposes source type detection (direct vs embed). */
(function (global) {
  "use strict";

  var URL_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
  var EXTINF_RE = /^#EXTINF:(?:-?\d+|[\w\-.+]+)\s*(.*)$/i;
  var ATTR_RE = /([a-z0-9_-]+)\s*=\s*"([^"]*)"/gi;
  var GROUP_RE = /^#EXTGRP:(.*)$/;
  /* Season/episode patterns: "S01E02", "S01 E02", "Season 1 Episode 2".
     The leading char may be any punctuation/separator (so "Show (S01E01)",
     "Show: S01E01", "Show_S01E01" all match) and the episode number must not
     be followed by a digit (so "S01E0012" is never misread). */
  var SEASON_EP_RE = /(?:^|[\W_])(?:S(\d{1,2})[\s._-]*E(\d{1,3}))(?![0-9])|(?:^|[\W_])(?:Season\s+(\d{1,2})[\s._-]+Episode\s+(\d{1,3}))(?![0-9])/i;
  var EMBED_ATTR = "tvg-embed";

  /* Known providers that must play inside an <iframe>.
     Returns a ready-to-embed URL for recognized links, keeps already-embed
     URLs as-is, and returns null for direct file links. */
  function toEmbedUrl(url) {
    var u = String(url || "").trim();
    if (!/^https?:\/\//i.test(u)) return null;

    /* already an embed page — keep as-is */
    if (/\/\/[^\/]*youtube(?:-nocookie)?\.com\/(?:embed|live)\//i.test(u)) return u;
    if (/\/\/player\.vimeo\.com\/video\//i.test(u)) return u;
    if (/\/\/[^\/]*dailymotion\.com\/embed\/video\//i.test(u)) return u;

    var m;
    /* youtube.com/watch?v=ID | /shorts/ID | /live/ID | youtu.be/ID */
    m = /\/\/(?:[^\/]+\.)?youtube\.com\/(?:watch\?(?:[^#]*?&)?v=|shorts\/|live\/)([\w-]+)/i.exec(u);
    if (!m) m = /\/\/(?:[^\/]+\.)?youtu\.be\/([\w-]+)/i.exec(u);
    if (m) return "https://www.youtube.com/embed/" + m[1];

    /* vimeo.com/123456789 */
    m = /\/\/(?:[^\/]+\.)?vimeo\.com\/(\d+)/i.exec(u);
    if (m) return "https://player.vimeo.com/video/" + m[1];

    /* dailymotion.com/video/xabc | dai.ly/xabc */
    m = /\/\/(?:[^\/]+\.)?dailymotion\.com\/video\/([a-z0-9]+)/i.exec(u);
    if (!m) m = /\/\/(?:www\.)?dai\.ly\/([a-z0-9]+)/i.exec(u);
    if (m) return "https://www.dailymotion.com/embed/video/" + m[1];

    return null;
  }

  var EMBED_MARKER = "*";

  function hasEmbedMarker(s) { return String(s).trim().indexOf(EMBED_MARKER) === 0; }

  function stripEmbedMarker(s) {
    var t = String(s).trim();
    return t.indexOf(EMBED_MARKER) === 0 ? t.slice(1).trim() : t;
  }

  /* Wrap a URL in the iframe HTML used to store embed sources.
     The player rebuilds a safe iframe from the src later. */
  function toIframeHtml(url) {
    var u = String(url || "").trim().replace(/"/g, "&quot;");
    return '<iframe width="1920" height="1080" src="' + u + '" frameborder="0" allowfullscreen></iframe>';
  }

  /* Convert any recognized embed input into the iframe source to store:
     - "*https://…"  → forced embed, wrapped in iframe HTML
     - "<iframe…>"   → raw embed HTML kept as-is
     - provider URL  → converted to its embed URL, wrapped in iframe HTML
     - anything else → kept as-is */
  function normalizeEmbedSource(src) {
    var s = String(src || "").trim();
    if (hasEmbedMarker(s)) return toIframeHtml(stripEmbedMarker(s));
    if (/<iframe/i.test(s)) return s;
    var conv = toEmbedUrl(s);
    return conv ? toIframeHtml(conv) : s;
  }

  /* Detect the source type.
     Returns "direct" for plain URLs, "embed" for HTML markup, *-prefixed
     links, or known iframe-based providers (YouTube/Vimeo/Dailymotion…). */
  function detectMediaType(source) {
    if (!source) return "direct";
    var s = String(source).trim();
    if (s.indexOf(EMBED_MARKER) === 0) return "embed";
    if (s.indexOf("<") === 0) return "embed";
    if (/<[\w\/!]/.test(s) && s.indexOf(">") > -1) return "embed";
    if (/^(?:src|data|href)\s*=/i.test(s)) return "embed";
    if (URL_RE.test(s)) return toEmbedUrl(s) ? "embed" : "direct";
    if (/^\S+\/\S+/.test(s)) return "direct";
    return "embed";
  }

  /* Extract attributes from the #EXTINF payload. */
  function parseAttrs(text) {
    var attrs = {};
    var m;
    ATTR_RE.lastIndex = 0;
    while ((m = ATTR_RE.exec(text)) !== null) {
      attrs[m[1].toLowerCase()] = m[2];
    }
    var comma = -1;
    var inQuote = false;
    for (var i = text.length - 1; i >= 0; i--) {
      if (text[i] === '"') inQuote = !inQuote;
      else if (text[i] === ',' && !inQuote) { comma = i; break; }
    }
    var title = comma >= 0 ? text.slice(comma + 1).trim() : text.trim();
    return { attrs: attrs, title: title };
  }

  function decodeEmbed(encoded) {
    try { return decodeURIComponent(encoded); } catch (e) { return encoded; }
  }

  function filenameTitle(url) {
    try {
      var u = String(url || "");
      if (/\/\/[^\/]*youtu(?:be\.com|\.be)\//i.test(u)) return "YouTube video";
      if (/\/\/[^\/]*vimeo\.com\//i.test(u)) return "Vimeo video";
      if (/\/\/[^\/]*dailymotion\.com\//i.test(u) || /\/\/dai\.ly\//i.test(u)) return "Dailymotion video";
      var clean = u.split(/[?#]/)[0];
      var name = clean.split("/").pop();
      return decodeURIComponent(name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_+]/g, " ")) || "Untitled";
    } catch (e) { return "Untitled"; }
  }

  /* Only accept bare (non-EXTINF) lines that plausibly hold a source. */
  function looksLikeSource(line) {
    var s = String(line).trim();
    if (!s) return false;
    if (s.indexOf(EMBED_MARKER) === 0) return true;
    if (s.indexOf("<") >= 0 && s.indexOf(">") >= 0) return true;
    if (URL_RE.test(s)) return true;
    if (/^\S+\/\S+/.test(s)) return true;
    return false;
  }

  /* Match a title against season/episode patterns. */
  function matchSeries(text) {
    if (!text) return null;
    SEASON_EP_RE.lastIndex = 0;
    var m = SEASON_EP_RE.exec(text);
    if (!m) return null;

    var season = null, episode = null, matched = null;
    if (m[1] !== undefined) { season = parseInt(m[1], 10); episode = parseInt(m[2], 10); matched = m[0]; }
    else if (m[3] !== undefined) { season = parseInt(m[3], 10); episode = parseInt(m[4], 10); matched = m[0]; }
    if (season === null || episode === null) return null;

    var seriesName = text.slice(0, m.index).replace(/[\s.:\-_]+$/g, "").trim();
    var rest = text.slice(m.index + matched.length).replace(/^\s*[\-:.]*\s*/, "").trim();
    return { seriesName: seriesName, season: season, episodeNumber: episode, episodeTitle: rest };
  }

  /* Live-stream detection, shared with the UI so the parser and the live/
     movie filtering always agree. Only a strong signal counts as live, so
     ordinary VOD files are never misclassified:
     - HLS manifests (.m3u8) — the common live transport,
     - Xtream-style /live/ paths and /live|/hls path segments or filenames,
     - dedicated streaming protocols (rtmp/rtsp/udp…).
     Bare .ts / .mpd extensions are NOT enough on their own — MPEG-TS and
     DASH are also used for on-demand movies (those live cases are instead
     detected via the EXTINF -1 duration or tvg-type attribute in makeItem). */
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

  function makeItem(entry) {
    var title = entry.title || filenameTitle(entry.source);
    var series = matchSeries(title);
    if (!series && entry.attrs["tvg-name"]) series = matchSeries(entry.attrs["tvg-name"]);
    /* When the title carries the season/episode numbers but no show name
       (e.g. "S01E01 - Pilot"), take the name from the group-title so such
       entries are still detected as episodes of that series. */
    if (series && !series.seriesName) {
      var g = entry.attrs["group-title"] || entry.group || "";
      if (g) series.seriesName = g;
    }
    var tvgType = String(entry.attrs["tvg-type"] || "").toLowerCase();

    var item = {
      id: entry.id,
      title: title,
      type: "movie",
      mediaType: entry.mediaType,
      source: entry.source,
      /* Live if the URL itself says so, or the playlist explicitly marks it
         (tvg-type="live"/"radio"). An explicit VOD/movie/series tvg-type
         overrides the URL heuristic. #EXTINF:-1 is deliberately NOT used —
         IPTV playlists use it for VOD entries too, which would misclassify
         movies as live. */
      live: tvgType === "live" || tvgType === "radio"
        || (isLiveSource(entry.source)
            && tvgType !== "vod" && tvgType !== "movie"
            && tvgType !== "series" && tvgType !== "episode"),
      poster: entry.attrs["tvg-logo"] || entry.attrs["logo"],
      group: entry.attrs["group-title"] || entry.group || "",
      description: entry.attrs["tvg-description"] || entry.attrs["description"] || "",
      tvgId: entry.attrs["tvg-id"] || null,
      tvgName: entry.attrs["tvg-name"] || null,
      seriesId: null,
      seriesName: null,
      season: null,
      episode: null,
      episodeNumber: null,
      episodeTitle: null,
      addedAt: entry.addedAt
    };

    if (series && series.seriesName) {
      item.type = "episode";
      item.live = false;
      item.seriesName = series.seriesName;
      item.seriesId = "series-" + stableId(series.seriesName);
      item.season = series.season;
      item.episode = series.episodeNumber;
      item.episodeNumber = series.episodeNumber;
      item.episodeTitle = series.episodeTitle || title;
    }

    return item;
  }

  /* Simple stable hash for group/series keys. */
  function stableId(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(36);
  }

  /* -------- parse core -------- */

  /* Shared parse state. Driven line-by-line by the synchronous parse() or the
     yielding parseAsync(), so both produce byte-identical results. */
  function createParseState(text) {
    return {
      lines: String(text).split(/\r?\n/),
      items: [],
      errors: [],
      sawHeader: false,
      pending: null,
      afterInf: false
    };
  }

  function flushPending(state) {
    if (state.pending && state.pending.source) {
      state.items.push(state.pending);
    }
    state.pending = null;
    state.afterInf = false;
  }

  function processLine(state, line, lineNo) {
    if (!line) return;

    if (line === "#EXTM3U") { state.sawHeader = true; return; }

    if (/^#EXTINF:/i.test(line)) {
      flushPending(state);
      var parsed = parseInfLine(line);
      state.pending = {
        id: null,
        attrs: parsed.attrs,
        title: parsed.title,
        mediaType: "direct",
        source: "",
        group: "",
        addedAt: null
      };
      state.afterInf = true;
      return;
    }

    var gm = GROUP_RE.exec(line);
    if (gm) {
      if (state.pending) state.pending.group = gm[1].trim();
      return;
    }

    if (line === "#EMBED#") {
      if (state.pending && state.pending.attrs[EMBED_ATTR]) {
        state.pending.source = normalizeEmbedSource(decodeEmbed(state.pending.attrs[EMBED_ATTR]));
        state.pending.mediaType = "embed";
        state.pending.id = "auto-" + stableId(state.pending.source + "|" + (state.pending.title || ""));
        state.pending.addedAt = Date.now();
        flushPending(state);
      }
      return;
    }

    if (/^#EXT(?:VLC|CODEC|URL|TARGET|COMMENT|NOTE|SERVICE)/i.test(line)) {
      return;
    }

    if (/^#/.test(line)) {
      /* unknown header between EXTINF and source — keep pending */
      return;
    }

    /* data line (URL or embed) */
    if (state.pending) {
      var src = line;
      var isEmbedAttr = state.pending.attrs && (state.pending.attrs[EMBED_ATTR] || state.pending.attrs["media-type"] === "embed");
      if (isEmbedAttr && state.pending.attrs[EMBED_ATTR]) {
        src = decodeEmbed(state.pending.attrs[EMBED_ATTR]);
      }
      state.pending.mediaType = state.pending.attrs["media-type"] === "embed" || !!state.pending.attrs[EMBED_ATTR]
        ? "embed"
        : detectMediaType(src);
      if (state.pending.mediaType === "embed") {
        src = normalizeEmbedSource(src);
      }
      state.pending.source = src;
      state.pending.id = "auto-" + stableId(src + "|" + (state.pending.title || ""));
      state.pending.addedAt = Date.now();
      flushPending(state);
    } else {
      /* bare entry without EXTINF — accept only plausible sources */
      if (!looksLikeSource(line)) {
        state.errors.push("Skipped line " + (lineNo + 1) + ": \"" + line.slice(0, 40) + "\" is not a valid entry.");
        return;
      }
      var type = detectMediaType(line);
      var bsrc = line;
      if (type === "embed") {
        bsrc = normalizeEmbedSource(bsrc);
      }
      state.items.push({
        id: "auto-" + stableId(bsrc),
        attrs: {},
        title: filenameTitle(line),
        mediaType: type,
        source: bsrc,
        group: "",
        addedAt: Date.now()
      });
    }
  }

  function finishParse(state) {
    flushPending(state);

    if (!state.sawHeader && state.items.length === 0) {
      state.errors.push("No valid M3U entries found in this file.");
    }

    var itemsOut = state.items.map(makeItem);
    var counts = { direct: 0, embed: 0 };
    itemsOut.forEach(function (it) {
      if (it.mediaType === "embed") counts.embed++; else counts.direct++;
    });
    if (itemsOut.length === 0 && state.errors.length === 0) {
      state.errors.push("No playable entries were found.");
    }
    return { items: itemsOut, errors: state.errors, sourceTypeCount: counts, sawHeader: state.sawHeader };
  }

  var EMPTY_RESULT = { items: [], errors: ["The file is empty."], sourceTypeCount: { direct: 0, embed: 0 } };

  /* Main entry point. Accepts playlist text, returns { items, errors }.
     Runs synchronously — use parseAsync for large playlists so the page
     stays responsive and can show progress while a big file is imported. */
  function parse(text) {
    if (!text || !text.trim()) return EMPTY_RESULT;
    var state = createParseState(text);
    var lines = state.lines;
    for (var i = 0; i < lines.length; i++) {
      processLine(state, lines[i].trim(), i);
    }
    return finishParse(state);
  }

  /* Like parse, but processes the text in chunks and yields to the browser
     between chunks so huge imports never freeze the UI. onProgress(percent)
     is called after every chunk. Resolves with the same shape as parse(). */
  function parseAsync(text, onProgress) {
    return new Promise(function (resolve) {
      if (!text || !text.trim()) { resolve(EMPTY_RESULT); return; }
      var state = createParseState(text);
      var lines = state.lines;
      var CHUNK = 4000;
      var i = 0;
      function step() {
        var end = Math.min(i + CHUNK, lines.length);
        for (; i < end; i++) {
          processLine(state, lines[i].trim(), i);
        }
        if (onProgress) onProgress(Math.floor((i / lines.length) * 100), i, lines.length);
        if (i < lines.length) {
          setTimeout(step, 0);
        } else {
          resolve(finishParse(state));
        }
      }
      step();
    });
  }

  function parseInfLine(line) {
    var m = EXTINF_RE.exec(line);
    var payload = m ? m[1] : line;
    return parseAttrs(payload);
  }

  global.M3UParser = {
    parse: parse,
    parseAsync: parseAsync,
    detectMediaType: detectMediaType,
    toEmbedUrl: toEmbedUrl,
    normalizeEmbedSource: normalizeEmbedSource,
    isLiveSource: isLiveSource,
    stableId: stableId,
    EMBED_ATTR: EMBED_ATTR
  };
})(window);
