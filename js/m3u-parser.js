/* M3U parser — converts playlist text into library items.
   Also exposes source type detection (direct vs embed). */
(function (global) {
  "use strict";

  var URL_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
  var EXTINF_RE = /^#EXTINF:(?:-?\d+|[\w\-.+]+)\s*(.*)$/i;
  var ATTR_RE = /([a-z0-9_-]+)\s*=\s*"([^"]*)"/gi;
  var GROUP_RE = /^#EXTGRP:(.*)$/;
  var SEASON_EP_RE = /(?:^|[\s._-])(S(\d{1,2})[\s._-]*E(\d{1,3}))\b|(?:^|[\s._-])(Season\s+(\d{1,2})[\s._-]+Episode\s+(\d{1,3}))\b|(?:^|[\s._-])(S(\d{1,2})\s+E(\d{1,3}))\b/i;
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
    var comma = text.lastIndexOf(",");
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
    if (m[2] !== undefined) { season = parseInt(m[2], 10); episode = parseInt(m[3], 10); matched = m[0]; }
    else if (m[5] !== undefined) { season = parseInt(m[5], 10); episode = parseInt(m[6], 10); matched = m[0]; }
    else if (m[8] !== undefined) { season = parseInt(m[8], 10); episode = parseInt(m[9], 10); matched = m[0]; }
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
    var series = matchSeries(title) || matchSeries(entry.attrs["tvg-name"]);
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
      poster: entry.attrs["tvg-logo"] || entry.attrs["logo"] || entry.attrs["tvg-logo"],
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
      item.episode = series.episode;
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

  /* Main entry point. Accepts playlist text, returns { items, errors } */
  function parse(text) {
    var items = [];
    var errors = [];
    if (!text || !text.trim()) {
      return { items: [], errors: ["The file is empty."], sourceTypeCount: { direct: 0, embed: 0 } };
    }

    var lines = String(text).split(/\r?\n/);
    var sawHeader = false;
    var pending = null;
    var afterInf = false;

    function flush() {
      if (pending && pending.source) {
        items.push(pending);
      }
      pending = null;
      afterInf = false;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;

      if (line === "#EXTM3U") { sawHeader = true; continue; }

      if (/^#EXTINF:/i.test(line)) {
        flush();
        var parsed = parseInfLine(line);
        pending = {
          id: null,
          attrs: parsed.attrs,
          title: parsed.title,
          mediaType: "direct",
          source: "",
          group: "",
          addedAt: null
        };
        afterInf = true;
        continue;
      }

      if (GROUP_RE.test(line)) {
        if (pending) pending.group = GROUP_RE.exec(line)[1].trim();
        continue;
      }

      if (line === "#EMBED#") {
        if (pending && pending.attrs[EMBED_ATTR]) {
          pending.source = normalizeEmbedSource(decodeEmbed(pending.attrs[EMBED_ATTR]));
          pending.mediaType = "embed";
          pending.id = "auto-" + stableId(pending.source + "|" + (pending.title || ""));
          pending.addedAt = Date.now();
          flush();
        }
        continue;
      }

      if (/^#EXT(?:VLC|CODEC|URL|TARGET|COMMENT|NOTE|SERVICE)/i.test(line)) {
        continue;
      }

      if (/^#/.test(line)) {
        if (afterInf && pending && !pending.source) { /* skip unknown headers between EXTINF and source */ }
        continue;
      }

      /* data line (URL or embed) */
      if (pending) {
        var src = line;
        var isEmbedAttr = pending.attrs && (pending.attrs[EMBED_ATTR] || pending.attrs["media-type"] === "embed");
        if (isEmbedAttr && pending.attrs[EMBED_ATTR]) {
          src = decodeEmbed(pending.attrs[EMBED_ATTR]);
        }
        pending.mediaType = pending.attrs["media-type"] === "embed" || !!pending.attrs[EMBED_ATTR]
          ? "embed"
          : detectMediaType(src);
        if (pending.mediaType === "embed") {
          src = normalizeEmbedSource(src);
        }
        pending.source = src;
        pending.id = "auto-" + stableId(src + "|" + (pending.title || ""));
        pending.addedAt = Date.now();
        flush();
      } else {
        /* bare entry without EXTINF — accept only plausible sources */
        if (!looksLikeSource(line)) {
          errors.push("Skipped line " + (i + 1) + ": \"" + line.slice(0, 40) + "\" is not a valid entry.");
          continue;
        }
        var type = detectMediaType(line);
        var bsrc = line;
        if (type === "embed") {
          bsrc = normalizeEmbedSource(bsrc);
        }
        items.push({
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
    flush();

    if (!sawHeader && items.length === 0) {
      errors.push("No valid M3U entries found in this file.");
    }

    var itemsOut = items.map(makeItem);
    var counts = { direct: 0, embed: 0 };
    itemsOut.forEach(function (it) {
      if (it.mediaType === "embed") counts.embed++; else counts.direct++;
    });
    if (itemsOut.length === 0 && errors.length === 0) {
      errors.push("No playable entries were found.");
    }
    return { items: itemsOut, errors: errors, sourceTypeCount: counts, sawHeader: sawHeader };
  }

  function parseInfLine(line) {
    var m = EXTINF_RE.exec(line);
    var payload = m ? m[1] : line;
    return parseAttrs(payload);
  }

  global.M3UParser = {
    parse: parse,
    detectMediaType: detectMediaType,
    toEmbedUrl: toEmbedUrl,
    normalizeEmbedSource: normalizeEmbedSource,
    isLiveSource: isLiveSource,
    stableId: stableId,
    EMBED_ATTR: EMBED_ATTR
  };
})(window);
