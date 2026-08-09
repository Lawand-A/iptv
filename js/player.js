/* Player — renders direct HTML5 video or safe embed iframe.
   Handles progress saving, resume, and the 60-second watched rule. */
(function (global) {
  "use strict";

  var WATCHED_THRESHOLD = 0.85; /* 85% of duration marks a direct video as watched */
  var SAVE_INTERVAL_MS = 5000;
  var watchedTimer = null;
  var saveTimer = null;
  var currentId = null;
  var currentLive = false;
  var video = null;
  var active = false;
  var inlineActive = false;

  var page = document.getElementById("app");

  function notify(msg, isErr) {
    if (UI && UI.toast) UI.toast(msg, isErr ? "err" : undefined);
  }

  function pad(n) { n = parseInt(n, 10) || 0; return n < 10 ? "0" + n : "" + n; }
  function fmt(sec) {
    if (!isFinite(sec)) return "0:00";
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ":" + pad(m) : m) + ":" + pad(s);
  }

  var watchedBtnPaint = null; /* paint function for the player's watched button */

  function startWatchedTimer(item) {
    stopWatchedTimer();
    if (!item || item.live) return;
    if (Store.isWatched(item.id)) return;
    /* Embed sources can't report progress, so mark as watched on open. */
    if (item.mediaType === "embed") {
      Store.markWatched(item.id);
      if (watchedBtnPaint) watchedBtnPaint();
      if (global.UI) UI.refreshBadges && UI.refreshBadges();
      return;
    }
    /* Direct videos: mark as watched when playback reaches 85%. */
    if (video) {
      video.addEventListener("timeupdate", onWatchedProgress);
    }
  }

  function onWatchedProgress() {
    if (!video || currentId == null || currentLive) return;
    var d = video.duration;
    if (!d || !isFinite(d) || d <= 0) return;
    if (video.currentTime / d >= WATCHED_THRESHOLD) {
      if (!Store.isWatched(currentId)) {
        Store.markWatched(currentId);
        notify("Marked as watched");
        if (watchedBtnPaint) watchedBtnPaint();
        if (global.UI) UI.refreshBadges && UI.refreshBadges();
      }
      stopWatchedTimer();
    }
  }

  function stopWatchedTimer() {
    if (watchedTimer) { clearTimeout(watchedTimer); watchedTimer = null; }
    if (video) video.removeEventListener("timeupdate", onWatchedProgress);
  }

  function savePosition() {
    if (!video || currentId == null || currentLive) return;
    try {
      if (isFinite(video.currentTime)) {
        Store.saveProgress(currentId, video.currentTime, video.duration || 0);
      }
    } catch (e) { /* ignore */ }
  }

  function startSaveTimer() {
    stopSaveTimer();
    saveTimer = setInterval(savePosition, SAVE_INTERVAL_MS);
  }
  function stopSaveTimer() {
    if (saveTimer) { clearInterval(saveTimer); saveTimer = null; }
  }

  /* ---------- HLS (.m3u8) support ---------- */
  var HLS_CDN = "https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js";
  var hlsScriptPromise = null;
  var hlsInstance = null;

  function loadHls() {
    if (window.Hls) return Promise.resolve(true);
    if (!hlsScriptPromise) {
      hlsScriptPromise = new Promise(function (resolve) {
        var s = document.createElement("script");
        s.src = HLS_CDN;
        s.async = true;
        s.onload = function () { resolve(!!window.Hls); };
        s.onerror = function () { resolve(false); };
        document.head.appendChild(s);
      });
    }
    return hlsScriptPromise;
  }

  function isHlsSource(source) {
    return /\.m3u8(\?|#|$)/i.test(String(source || ""));
  }

  /* ---------- Raw MPEG-TS (.ts / extensionless streams) ----------
     Chromium browsers cannot play MPEG-TS natively in a <video> tag, so raw
     .ts live streams need MSE via mpegts.js (loaded on demand, like hls.js). */
  var MPEGTS_CDN = "https://cdn.jsdelivr.net/npm/mpegts.js@1.8.1/dist/mpegts.js";
  var mpegtsScriptPromise = null;
  var mpegtsInstance = null;

  function loadMpegts() {
    if (window.mpegts) return Promise.resolve(true);
    if (!mpegtsScriptPromise) {
      mpegtsScriptPromise = new Promise(function (resolve) {
        var s = document.createElement("script");
        s.src = MPEGTS_CDN;
        s.async = true;
        s.onload = function () { resolve(!!window.mpegts); };
        s.onerror = function () { resolve(false); };
        document.head.appendChild(s);
      });
    }
    return mpegtsScriptPromise;
  }

  /* True for raw-stream sources that native <video> cannot play but mpegts.js
     can: a .ts/.m2ts/.mts file, or an extensionless live endpoint (the classic
     Xtream "host/user/pass/id" form serves MPEG-TS). */
  function needsMpegts(source, isLive) {
    var s = String(source || "").split(/[?#]/)[0];
    var m = /\.([a-z0-9]+)$/i.exec(s);
    var ext = m ? m[1].toLowerCase() : "";
    if (ext === "ts" || ext === "m2ts" || ext === "mts") return true;
    return ext === "" && !!isLive;
  }

  var PROBE_TIMEOUT_MS = 5000;

  function classifyBytes(bytes, ct) {
    if (bytes.length >= 7 && bytes[0] === 0x23) {
      var s = "";
      for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      if (s.indexOf("#EXTM3U") === 0) return "hls";
    }
    if (ct && (ct.indexOf("vnd.apple.mpegurl") >= 0 || ct.indexOf("mpegurl") >= 0)) return "hls";
    if (bytes.length > 0 && bytes[0] === 0x47) return "ts";
    return "unknown";
  }

  var CODEC_NAMES = {
    "1": "MPEG-1 video", "2": "MPEG-2 video", "10": "MPEG-4 video",
    "1b": "H.264/AVC video", "24": "H.265/HEVC video",
    "3": "MPEG-1 audio", "4": "MPEG-2 audio", "f": "AAC audio",
    "11": "AAC LATM audio", "81": "AC-3 audio", "87": "E-AC-3 audio"
  };

  /* Best-effort read of the PAT/PMT in the first TS packets to log which
     video/audio codecs the stream uses (H.265 and AC-3 are often not
     decodable in Chromium's MSE, which is why mpegts.js stalls at 0). */
  function detectCodecs(bytes) {
    var pmtPids = [];
    var n = Math.floor(bytes.length / 188);
    var i;
    for (i = 0; i < n; i++) {
      var p = i * 188;
      if (bytes[p] !== 0x47) continue;
      var pid = ((bytes[p + 1] & 0x1F) << 8) | bytes[p + 2];
      var afc = (bytes[p + 3] >> 4) & 0x3;
      if (afc !== 1 && afc !== 3) continue;
      if ((bytes[p + 3] & 0x40) === 0) continue;
      if (pid !== 0) continue;
      var o = p + 4;
      if (afc === 3) o += bytes[p + 4] + 1;
      var s = o + 1 + bytes[o];
      if (bytes[s] !== 0x00) continue;
      var slen = ((bytes[s + 1] & 0x0F) << 8) | bytes[s + 2];
      var end = Math.min(s + 3 + slen, bytes.length);
      var j = s + 8;
      while (j + 4 <= end) {
        var prog = (bytes[j] << 8) | bytes[j + 1];
        var pmpid = ((bytes[j + 2] & 0x1F) << 8) | bytes[j + 3];
        if (prog !== 0 && pmtPids.indexOf(pmpid) < 0) pmtPids.push(pmpid);
        j += 4;
      }
    }
    var streams = [];
    for (i = 0; i < n; i++) {
      var p2 = i * 188;
      if (bytes[p2] !== 0x47) continue;
      var pid2 = ((bytes[p2 + 1] & 0x1F) << 8) | bytes[p2 + 2];
      if (pmtPids.indexOf(pid2) < 0) continue;
      var afc2 = (bytes[p2 + 3] >> 4) & 0x3;
      if (afc2 !== 1 && afc2 !== 3) continue;
      if ((bytes[p2 + 3] & 0x40) === 0) continue;
      var o2 = p2 + 4;
      if (afc2 === 3) o2 += bytes[p2 + 4] + 1;
      var s2 = o2 + 1 + bytes[o2];
      if (bytes[s2] !== 0x02) continue;
      var slen2 = ((bytes[s2 + 1] & 0x0F) << 8) | bytes[s2 + 2];
      var end2 = Math.min(s2 + 3 + slen2, bytes.length);
      var proginfo = ((bytes[s2 + 10] & 0x0F) << 8) | bytes[s2 + 11];
      var j2 = s2 + 12 + proginfo;
      while (j2 + 5 <= end2) {
        var st = bytes[j2];
        var esinfo = ((bytes[j2 + 3] & 0x0F) << 8) | bytes[j2 + 4];
        streams.push(CODEC_NAMES[st.toString(16)] || ("stream 0x" + st.toString(16)));
        j2 += 5 + esinfo;
      }
    }
    return streams;
  }

  /* Peek at a candidate's actual response before picking an engine. URL
     extensions can lie — Xtream sometimes serves an HLS manifest at a .ts
     URL, which makes mpegts.js hang silently forever. Dead links (4xx/5xx)
     are skipped instantly, and a connection that accepts but never delivers
     bytes (offline channel) times out and moves on instead of freezing. */
  function probeSource(src) {
    return new Promise(function (resolve) {
      var settled = false;
      function settle(p) {
        if (settled) return;
        settled = true;
        if (window.console) console.log("[player][probe]", src, p);
        resolve(p);
      }
      var ac = null;
      try { ac = window.AbortController ? new AbortController() : null; } catch (e) { ac = null; }
      var timer = setTimeout(function () {
        settle({ kind: "stall", note: "no data within " + (PROBE_TIMEOUT_MS / 1000) + "s" });
        if (ac) { try { ac.abort(); } catch (e) { /* ignore */ } }
      }, PROBE_TIMEOUT_MS);
      var opts = { headers: { "Range": "bytes=0-8191" }, cache: "no-store" };
      if (ac) opts.signal = ac.signal;
      try {
        fetch(src, opts).then(function (res) {
          if (!res.ok) { settle({ kind: "dead", status: res.status }); return; }
          var ct = (res.headers.get("content-type") || "").toLowerCase();
          if (!res.body || !res.body.getReader) { settle({ kind: "unknown", status: res.status, ct: ct }); return; }
          var reader = res.body.getReader();
          var acc = 0, parts = [];
          (function read() {
            reader.read().then(function (r) {
              if (r.done || acc >= 2048) {
                try { reader.cancel(); } catch (e) { /* ignore */ }
                var buf = new Uint8Array(acc);
                var off = 0;
                for (var i = 0; i < parts.length; i++) { buf.set(new Uint8Array(parts[i]), off); off += parts[i].byteLength; }
                settle({ kind: classifyBytes(buf, ct), status: res.status, ct: ct, bytes: acc, codecs: detectCodecs(buf) });
              } else {
                parts.push(r.value); acc += r.value.byteLength; read();
              }
            }, function () {
              try { reader.cancel(); } catch (e) { /* ignore */ }
              settle({ kind: "unknown", status: res.status, ct: ct });
            });
          })();
        }, function (err) {
          if (settled) return;
          settle({ kind: "error", error: String((err && err.message) || err) });
        });
      } catch (err) {
        settle({ kind: "error", error: String((err && err.message) || err) });
      }
    });
  }

  function showPlayError(el, item, src) {
    var wrap = el.parentNode;
    if (!wrap || wrap.querySelector(".player-error")) return;
    var url = src || (item && item.source) || "";
    var detail = (el && el.__lastErr) ? " " + String(el.__lastErr) : "";
    var msg = document.createElement("div");
    msg.className = "player-msg player-error";
    msg.innerHTML = "<strong>Unable to play this video.</strong><br>The source may be unavailable, blocked (CORS), or in an unsupported format.<br><span style='font-size:12px;word-break:break-all'>" + escapeHtml(url) + "</span>" + (detail ? "<br><span style='font-size:11px;opacity:.7'>" + escapeHtml(detail) + "</span>" : "");
    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;justify-content:center";
    if (url && /^https?:\/\//i.test(url)) {
      var open = document.createElement("a");
      open.href = url;
      open.target = "_blank";
      open.rel = "noopener";
      open.className = "btn btn-secondary";
      open.textContent = "Open source";
      row.appendChild(open);
    }
    var retry = document.createElement("button");
    retry.className = "btn btn-primary";
    retry.textContent = "⟳ Retry";
    retry.addEventListener("click", function () {
      if (msg.parentNode) msg.remove();
      if (el.__restart) el.__restart();
      else { try { el.load(); } catch (e) { /* ignore */ } }
    });
    row.appendChild(retry);
    msg.appendChild(row);
    wrap.appendChild(msg);
  }

  function showTapHint(el) {
    var wrap = el.parentNode;
    if (!wrap || wrap.querySelector(".player-tap-hint")) return;
    var hint = document.createElement("div");
    hint.className = "player-msg player-tap-hint";
    hint.textContent = "▶ Autoplay blocked — press play to start";
    wrap.appendChild(hint);
    var onPlay = function () {
      if (hint.parentNode) hint.remove();
      el.removeEventListener("playing", onPlay);
    };
    el.addEventListener("playing", onPlay);
  }

  function initHls(video, src, saved, onFail, isLive) {
    if (!window.Hls || !Hls.isSupported()) {
      video.src = src;
      return;
    }
    var hls = new Hls({
      lowLatencyMode: false,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 5,
      maxBufferLength: 60,
      backBufferLength: 60,
      startLevel: -1,
      manifestLoadingMaxRetry: 4,
      levelLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 8,
      keyLoadingMaxRetry: 8
    });
    hlsInstance = hls;
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      if (!isLive && saved && saved.position > 5 && saved.progress < 98 && !video.ended) {
        try { video.currentTime = saved.position; } catch (e) { /* ignore */ }
      }
      var p = video.play();
      if (p && p.catch) p.catch(function () { showTapHint(video); });
    });
    hls.on(Hls.Events.ERROR, function (evt, data) {
      if (!data || !data.fatal) return;
      if (window.console) console.warn("[player] hls fatal:", data.type, data.details, data.fatal);
      video.__lastErr = data.details || (data.type || "") + ": " + (data.reason || "");
      try { hls.destroy(); } catch (e) { /* ignore */ }
      if (hlsInstance === hls) hlsInstance = null;
      if (onFail) {
        video.__suppressError = true;
        onFail();
      } else {
        showPlayError(video, Store.getItem(currentId) || { source: src });
      }
    });
  }

  /* mpegts.js can buffer a stream it cannot decode via MSE (e.g. H.265 video
     on Chromium): playback reports "playing" but currentTime never advances
     and no error fires, so nothing would ever move on. Track whether
     currentTime is actually progressing (immune to mpegts's own "startup
     stall jumper" micro-seeks to 0.06). On a stall, retry the stream with
     WebCodecs decoding, which can handle HEVC that plain MSE cannot. */
  function watchMpegtsStall(video, onFail, webCodecs) {
    var lastTime = video.currentTime || 0;
    var lastChange = Date.now();
    var timer = setInterval(function () {
      if (!video.__mpegtsManaged) { clearInterval(timer); return; }
      if (video.paused) return;
      var t = video.currentTime || 0;
      if (t !== lastTime) { lastTime = t; lastChange = Date.now(); return; }
      var hasData = webCodecs || video.readyState >= 2 || (video.buffered && video.buffered.length > 0);
      if (hasData && Date.now() - lastChange > 5000) {
        clearInterval(timer);
        if (!webCodecs && video.__mpegtsSrc && window.VideoDecoder) {
          if (window.console) console.warn("[player] mpegts not progressing via MSE — retrying with WebCodecs");
          try { if (mpegtsInstance) { mpegtsInstance.destroy(); mpegtsInstance = null; } } catch (e) { /* ignore */ }
          video.__mpegtsManaged = false;
          if (video.__mpegtsItem) {
            initMpegts(video, video.__mpegtsSrc, video.__mpegtsItem, onFail, { webCodecs: true });
          } else {
            onFail();
          }
          return;
        }
        if (window.console) console.warn("[player] mpegts not progressing (stuck at " + lastTime + "s) with data buffered — advancing");
        video.__lastErr = video.__mpegtsHevc
          ? "This channel uses H.265 (HEVC) video, which this browser cannot decode"
          : "Stream delivers data but the browser cannot decode it (unsupported video/audio codec)";
        if (video.__mpegtsSrc) probeSource(video.__mpegtsSrc);
        if (onFail) {
          video.__suppressError = true;
          onFail();
        } else {
          showPlayError(video, Store.getItem(currentId) || { source: video.currentSrc || "" });
        }
      }
    }, 500);
  }

  var mseCapsLogged = false;

  /* Log once which codecs this browser's MediaSource can actually decode,
     so unsupported-codec failures are explainable at a glance. */
  function logMseCapabilities() {
    if (mseCapsLogged) return;
    mseCapsLogged = true;
    try {
      var MS = window.MediaSource || window.WebKitMediaSource;
      if (!MS || !MS.isTypeSupported) return;
      var tests = [
        ["h264", 'video/mp4; codecs="avc1.4d4028"'],
        ["h265", 'video/mp4; codecs="hvc1.1.6.L120.90"'],
        ["aac-lc", 'audio/mp4; codecs="mp4a.40.2"'],
        ["he-aac", 'audio/mp4; codecs="mp4a.40.5"'],
        ["mp3", "audio/mpeg"],
        ["mp3-mp4", 'audio/mp4; codecs="mp3"']
      ];
      var out = {};
      for (var i = 0; i < tests.length; i++) out[tests[i][0]] = !!MS.isTypeSupported(tests[i][1]);
      if (window.console) console.log("[player] MSE codec support:", out);
    } catch (e) { /* ignore */ }
  }

  function initMpegts(video, src, item, onFail, opts) {
    if (!window.mpegts || !mpegts.isSupported()) {
      video.src = src;
      return;
    }
    logMseCapabilities();
    video.__mpegtsManaged = true;
    video.__mpegtsSrc = src;
    video.__mpegtsItem = item;
    var webCodecs = !!(opts && opts.webCodecs);
    var player = mpegts.createPlayer(
      { type: "mpegts", isLive: !!item.live, url: src },
      { lazyLoad: false, enableWebCodecs: webCodecs }
    );
    mpegtsInstance = player;
    player.attachMediaElement(video);
    player.load();
    watchMpegtsStall(video, onFail, webCodecs);
    player.on(mpegts.Events.ERROR, function (type, detail, info) {
      if (info && !info.fatal) return;
      if (mpegtsInstance !== player) return;
      if (window.console) console.warn("[player] mpegts error:", type, detail, info);
      video.__lastErr = String(type) + (detail ? ": " + String(detail) : "");
      try { player.destroy(); } catch (e) { /* ignore */ }
      if (mpegtsInstance === player) mpegtsInstance = null;
      if (onFail) {
        video.__suppressError = true;
        onFail();
      } else {
        showPlayError(video, Store.getItem(currentId) || { source: src });
      }
    });
    player.on(mpegts.Events.MEDIA_INFO, function (mi) {
      if (!mi) return;
      if (mpegtsInstance !== player) return;
      var vc = String(mi.videoCodec || "");
      var ac = String(mi.audioCodec || "");
      var isHevc = vc === "h265" || vc === "hvc1" || vc === "hev1";
      /* Chromium's MSE cannot decode HEVC, AC-3/E-AC-3 or HE-AAC/LATM audio.
         Channels using any of these stall at 0 forever — fail fast instead and
         explain why. (MP3/MP2 is fine in MSE since mpegts.js v1.8.1.) */
      var isBadAudio = ac === "ac3" || ac === "eac3" || ac === "latm_aac";
      if (!isHevc && !isBadAudio) return;
      if (window.console) console.warn("[player] unsupported codec: video=" + vc + " audio=" + ac);
      video.__mpegtsHevc = isHevc;
      /* HEVC with a decodable audio track + a WebCodecs VideoDecoder →
         decode the video via WebCodecs (audio still goes through MSE). */
      if (isHevc && !webCodecs && !isBadAudio && window.VideoDecoder && video.__mpegtsItem) {
        if (window.console) console.warn("[player] HEVC — retrying with WebCodecs decode");
        try { player.destroy(); } catch (e) { /* ignore */ }
        if (mpegtsInstance === player) mpegtsInstance = null;
        video.__mpegtsManaged = false;
        initMpegts(video, video.__mpegtsSrc, video.__mpegtsItem, onFail, { webCodecs: true });
        return;
      }
      try { player.destroy(); } catch (e) { /* ignore */ }
      if (mpegtsInstance === player) mpegtsInstance = null;
      video.__mpegtsManaged = false;
      var msg;
      if (isHevc && !window.VideoDecoder) {
        msg = "This channel uses H.265 (HEVC) video, which this browser cannot decode. Try Microsoft Edge (with the HEVC Video Extensions installed).";
      } else if (isHevc) {
        msg = "This channel uses H.265 (HEVC) video with an audio codec this browser cannot play alongside it.";
      } else if (ac === "ac3" || ac === "eac3") {
        msg = "This channel uses AC-3/E-AC-3 audio, which this browser cannot play.";
      } else {
        msg = "This channel uses an audio codec this browser cannot play (" + ac + ").";
      }
      video.__lastErr = msg;
      showPlayError(video, Store.getItem(currentId) || { source: src });
    });
    var p = player.play();
    if (p && p.catch) p.catch(function () { showTapHint(video); });
  }

  function createLoader() {
    var loader = document.createElement("div");
    loader.className = "player-loader";
    return {
      el: loader,
      show: function () { loader.classList.add("show"); },
      hide: function () { loader.classList.remove("show"); }
    };
  }

  function attachLoader(video, loader) {
    function show() { loader.show(); }
    function hide() { loader.hide(); }
    video.addEventListener("loadstart", show);
    video.addEventListener("waiting", show);
    video.addEventListener("seeking", show);
    video.addEventListener("stalled", show);
    video.addEventListener("playing", hide);
    video.addEventListener("canplay", hide);
    video.addEventListener("seeked", hide);
    video.addEventListener("pause", hide);
    video.addEventListener("ended", hide);
    video.addEventListener("error", hide);
    /* Start visible until we know the video is ready. */
    loader.show();
  }

  /* Custom bottom control bar (play/pause, ±10s seek, time, fullscreen).
     Replaces the native <video> controls so the seek overlay also works in
     fullscreen (native fullscreen only renders the bare <video> element).
     Visible on hover/touch/key activity; auto-hide after 5s idle. */
  var seekWrap = null;      /* current .player-wrap (for fullscreen)   */
  var seekControls = null;  /* current control bar element            */
  var seekFsBtn = null;     /* current fullscreen toggle button       */
  var seekPoke = null;      /* current show/reset-timer function      */

  var HIDE_DELAY_MS = 3000;

  function onFullscreenChange() {
    if (seekFsBtn) seekFsBtn.innerHTML = fsIcon();
    if (seekWrap && (document.fullscreenElement === seekWrap || document.webkitFullscreenElement === seekWrap)) {
      if (seekPoke) seekPoke();
    }
  }
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);

  function fsIcon() {
    return (seekWrap && document.fullscreenElement === seekWrap) ||
           (seekWrap && document.webkitFullscreenElement === seekWrap)
      ? '<svg class="bar-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>'
      : '<svg class="bar-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 14H5v5h5v-2H7v-3zM5 10h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
  }

  function toggleFullscreen(wrap) {
    var target = wrap;
    if (document.fullscreenElement === target || document.webkitFullscreenElement === target) {
      if (document.exitFullscreen) {
        var p = document.exitFullscreen();
        if (p && p.catch) p.catch(function () { /* ignore */ });
      }
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    } else {
      var r = target.requestFullscreen ? target.requestFullscreen()
        : target.webkitRequestFullscreen ? target.webkitRequestFullscreen()
        : null;
      if (r && r.catch) r.catch(function () { /* fullscreen blocked */ });
    }
  }

  function playIcon(isPlay) {
    return isPlay
      ? '<svg class="bar-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>'
      : '<svg class="bar-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
  }

  function volumeIcon(vol, muted) {
    if (muted || vol === 0) {
      return '<svg class="bar-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM19 12c0 3.86-2.69 7.11-6.32 7.95V21h-.79l-4.62-4H5c-1.1 0-2-.9-2-2v-4c0-1.1.9-2 2-2h2.29l4.62-4h.79v1.05C16.31 4.89 19 8.14 19 12z"/></svg>';
    }
    if (vol < 0.5) {
      return '<svg class="bar-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 9v6h2.29l4.62 4h.79V5h-.79L7.29 9H5zm13 3c0 1.77-1.02 3.29-2.5 4.03V7.97c1.48.74 2.5 2.26 2.5 4.03z"/></svg>';
    }
    return '<svg class="bar-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
  }

  /* Same circular-arrow icon for both directions; the forward button
     mirrors it via CSS so the two always look identical. */
  function seekIcon() {
    return '<svg class="bar-ico bar-ico-seek" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>' +
           '<span class="bar-ico-label">10</span>';
  }

  function makeBarButton(cls, label, html) {
    var b = document.createElement("button");
    b.className = cls + " focusable";
    b.setAttribute("aria-label", label);
    b.innerHTML = html;
    return b;
  }

  function togglePlay(video) {
    if (video.paused) {
      var p = video.play();
      if (p && p.catch) p.catch(function () { /* autoplay blocked; user presses play */ });
    } else {
      video.pause();
    }
  }

  function buildControlBar(wrap, video) {
    var bar = document.createElement("div");
    bar.className = "video-bar";
    seekWrap = wrap;
    seekControls = bar;

    /* Episode navigation: only shown when the current item is a series episode. */
    var currentItem = currentId != null ? Store.getItem(currentId) : null;
    var episodeNav = currentItem && currentItem.type === "episode" && currentItem.seriesId
      ? makeEpisodeNavButtons(currentItem, true)
      : null;

    var progress = document.createElement("input");
    progress.type = "range";
    progress.min = "0";
    progress.max = "1000";
    progress.step = "1";
    progress.value = "0";
    progress.className = "video-progress focusable";
    progress.setAttribute("aria-label", "Seek");
    progress.addEventListener("input", function () {
      if (!video.duration || !isFinite(video.duration)) return;
      try { video.currentTime = progress.value / 1000 * video.duration; } catch (e) { /* ignore */ }
    });

    var row = document.createElement("div");
    row.className = "video-bar-buttons";

    var playBtn = makeBarButton("bar-btn bar-play", "Play", playIcon(true));
    playBtn.addEventListener("click", function () { togglePlay(video); poke(); });

    var backBtn = makeBarButton("bar-btn bar-back", "Backward 10 seconds", seekIcon());
    backBtn.addEventListener("click", function () { seekBy(video, -10); poke(); });

    var fwdBtn = makeBarButton("bar-btn bar-fwd", "Forward 10 seconds", seekIcon());
    fwdBtn.addEventListener("click", function () { seekBy(video, 10); poke(); });

    var timeEl = document.createElement("span");
    timeEl.className = "bar-time";
    timeEl.textContent = "0:00 / 0:00";

    /* Volume button + slider */
    var savedVol = 1;
    var savedMuted = false;
    try { var s = Store.getSettings(); savedVol = typeof s.volume === "number" ? s.volume : 1; savedMuted = !!s.muted; } catch (e) { /* ignore */ }
    var lastVolume = (savedVol > 0 ? savedVol : 1);
    var volBtn = makeBarButton("bar-btn bar-vol", "Mute", volumeIcon(video.volume, video.muted));
    var volSlider = document.createElement("input");
    volSlider.type = "range";
    volSlider.min = "0";
    volSlider.max = "1";
    volSlider.step = "0.05";
    volSlider.value = String(video.muted ? 0 : video.volume);
    volSlider.className = "bar-volume focusable";
    volSlider.setAttribute("aria-label", "Volume");

    function persistVolume() {
      try { Store.saveSettings({ volume: video.volume, muted: video.muted }); } catch (e) { /* ignore */ }
    }

    function updateVolIcon() {
      volBtn.innerHTML = volumeIcon(video.volume, video.muted);
      volBtn.setAttribute("aria-label", video.muted ? "Unmute" : "Mute");
    }
    function setVolume(v) {
      v = Math.max(0, Math.min(1, parseFloat(v) || 0));
      video.muted = v === 0;
      video.volume = v === 0 ? lastVolume : v;
      if (v > 0) lastVolume = v;
      volSlider.value = String(video.muted ? 0 : video.volume);
      updateVolIcon();
    }
    volBtn.addEventListener("click", function () {
      if (video.muted || video.volume === 0) {
        video.muted = false;
        video.volume = lastVolume || 0.5;
      } else {
        lastVolume = video.volume || 1;
        video.muted = true;
      }
      volSlider.value = String(video.muted ? 0 : video.volume);
      updateVolIcon();
      poke();
    });
    volSlider.addEventListener("input", function () {
      var v = parseFloat(volSlider.value) || 0;
      video.muted = v === 0;
      video.volume = v === 0 ? (lastVolume || 0.5) : v;
      if (v > 0) lastVolume = v;
      updateVolIcon();
      poke();
    });
    video.addEventListener("volumechange", function () {
      volSlider.value = String(video.muted ? 0 : video.volume);
      updateVolIcon();
      persistVolume();
    });

    var fsBtn = makeBarButton("bar-btn bar-fs", "Toggle fullscreen", fsIcon());
    seekFsBtn = fsBtn;
    fsBtn.addEventListener("click", function () { toggleFullscreen(wrap); poke(); });

    row.appendChild(playBtn);
    row.appendChild(backBtn);
    row.appendChild(fwdBtn);
    row.appendChild(timeEl);
    if (episodeNav) row.appendChild(episodeNav);

    var spacer = document.createElement("span");
    spacer.className = "bar-spacer";
    row.appendChild(spacer);
    row.appendChild(volBtn);
    row.appendChild(volSlider);
    row.appendChild(fsBtn);

    bar.appendChild(progress);
    bar.appendChild(row);

    /* live updates */
    function paint() {
      var d = video.duration;
      if (d && isFinite(d)) {
        progress.value = Math.round(video.currentTime / d * 1000);
        timeEl.textContent = fmt(video.currentTime) + " / " + fmt(d);
      }
    }
    video.addEventListener("timeupdate", paint);
    video.addEventListener("durationchange", paint);
    video.addEventListener("play", function () { playBtn.innerHTML = playIcon(false); });
    video.addEventListener("pause", function () { playBtn.innerHTML = playIcon(true); });
    video.addEventListener("ended", function () { playBtn.innerHTML = playIcon(true); });

    /* ---- visibility: show on activity, hide after 3s idle ---- */
    var hideTimer = null;
    var lastMouseX = -1, lastMouseY = -1;

    function hide() {
      /* Keep controls visible only if a range slider (seek/volume) has focus.
         Buttons don't need to keep the bar visible on mobile. */
      var ae = document.activeElement;
      if (ae && bar.contains(ae) && ae.tagName === "INPUT" && ae.type === "range") {
        hideTimer = setTimeout(hide, 1000);
        return;
      }
      bar.classList.remove("show");
    }

    function poke() {
      bar.classList.add("instant");
      bar.classList.add("show");
      /* Force reflow so the bar becomes visible with transition disabled,
         then re-enable transitions for the smooth fade-out on hide. */
      void bar.offsetHeight;
      bar.classList.remove("instant");
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, HIDE_DELAY_MS);
    }
    seekPoke = poke;

    /* Only treat real mouse movement as interaction — browsers fire spurious
       mousemove events from <video> elements even when the mouse is still. */
    wrap.addEventListener("mousemove", function (e) {
      if (e.clientX !== lastMouseX || e.clientY !== lastMouseY) {
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        poke();
      }
    });
    wrap.addEventListener("mouseleave", function () {
      lastMouseX = -1; lastMouseY = -1;
      if (hideTimer) clearTimeout(hideTimer);
      hide();
    });
    wrap.addEventListener("touchstart", poke, { passive: true });
    wrap.addEventListener("touchmove", poke, { passive: true });
    wrap.addEventListener("keydown", poke);

    /* Fullscreen overlay: in fullscreen the browser only renders the <video>
       element inside .player-wrap, so mouse events stop reaching the wrapper.
       This transparent layer sits above the video (but below the bar) and
       catches movement/taps to reveal the controls. */
    var fsOverlay = document.createElement("div");
    fsOverlay.className = "player-fs-overlay";
    fsOverlay.addEventListener("pointermove", function (e) {
      if (e.pointerType === "mouse") poke();
    });
    fsOverlay.addEventListener("mousemove", poke);
    fsOverlay.addEventListener("touchstart", function (e) { poke(); }, { passive: true });
    fsOverlay.addEventListener("click", function (e) {
      if (e.pointerType === "touch") return;
      togglePlay(video);
      poke();
    });
    wrap.appendChild(fsOverlay);

    poke();

    return bar;
  }


  function blockNativeControls(el) {
    /* Hide the device's default media notification / remote overlay and keep
       our custom control bar as the only UI. Works in Chrome/Edge/Smart-TV
       browsers that support the Media Session API and WebKit controls. */
    try {
      el.controls = false;
      if (el.disableRemotePlayback !== undefined) el.disableRemotePlayback = true;
      if (navigator.mediaSession) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.setActionHandler("play", function () { togglePlay(el); });
        navigator.mediaSession.setActionHandler("pause", function () { togglePlay(el); });
        navigator.mediaSession.setActionHandler("stop", function () { cancel(); });
        navigator.mediaSession.setActionHandler("seekbackward", function () { seekBy(el, -10); });
        navigator.mediaSession.setActionHandler("seekforward", function () { seekBy(el, 10); });
        navigator.mediaSession.setActionHandler("seekto", function (details) {
          if (details.seekTime && isFinite(el.duration)) el.currentTime = details.seekTime;
        });
        try {
          navigator.mediaSession.setActionHandler("previoustrack", function () { seekBy(el, -10); });
          navigator.mediaSession.setActionHandler("nexttrack", function () { seekBy(el, 10); });
        } catch (e) { /* older implementations may not support these */ }
      }
    } catch (e) { /* ignore */ }
  }

  function seekBy(video, delta) {
    if (!video) return;
    var dur = isFinite(video.duration) ? video.duration : Infinity;
    var t = Math.min(Math.max(0, (video.currentTime || 0) + delta), dur);
    try { video.currentTime = t; } catch (e) { /* ignore */ }
    try {
      var p = video.play();
      if (p && p.catch) p.catch(function () { /* autoplay blocked; user presses play */ });
    } catch (e) { /* ignore */ }
  }

  function buildEpisodeNav(item) {
    var series = Store.getSeries(item.seriesId);
    if (!series || !series.episodes || series.episodes.length <= 1) return null;
    var eps = series.episodes;
    var idx = -1;
    for (var i = 0; i < eps.length; i++) {
      if (eps[i].id === item.id) { idx = i; break; }
    }
    if (idx < 0) return null;
    var out = {};
    if (idx > 0) {
      out.prevId = eps[idx - 1].id;
    }
    if (idx < eps.length - 1) {
      out.nextId = eps[idx + 1].id;
    } else {
      out.isFinal = true;
    }
    return out;
  }

  function goToEpisode(id) {
    App.navigate("#play/" + encodeURIComponent(id));
  }

  function makeEpisodeNavButtons(item, forBar) {
    var state = buildEpisodeNav(item);
    if (!state) return null;
    var container = document.createElement("span");
    container.className = forBar ? "bar-epnav-wrap" : "player-epnav-wrap";
    if (state.prevId) {
      var prevBtn = makeBarButton(forBar ? "bar-btn bar-epnav bar-prev" : "btn btn-secondary btn-sm bar-prev", "Previous episode", "‹ Prev");
      (function (id) {
        prevBtn.addEventListener("click", function () { goToEpisode(id); if (seekPoke) seekPoke(); });
      })(state.prevId);
      container.appendChild(prevBtn);
    }
    if (state.nextId) {
      var nextBtn = makeBarButton(forBar ? "bar-btn bar-epnav bar-next" : "btn btn-secondary btn-sm bar-next", "Next episode", "Next ›");
      (function (id) {
        nextBtn.addEventListener("click", function () { goToEpisode(id); if (seekPoke) seekPoke(); });
      })(state.nextId);
      container.appendChild(nextBtn);
    } else if (state.isFinal) {
      var finalBtn = makeBarButton(forBar ? "bar-btn bar-epnav bar-final" : "btn btn-secondary btn-sm bar-final", "Final episode", "Final Episode");
      finalBtn.disabled = true;
      finalBtn.classList.add("bar-final");
      container.appendChild(finalBtn);
    }
    return container;
  }

  function buildDirect(item, saved) {
    var el = document.createElement("video");
    el.autoplay = true;
    el.playsInline = true;
    el.setAttribute("webkit-playsinline", "true");
    el.setAttribute("x5-playsinline", "true");
    el.setAttribute("x5-video-player-type", "h5");
    el.setAttribute("x5-video-player-fullscreen", "false");
    el.controls = false;
    el.setAttribute("controlsList", "nodownload noremoteplayback nofullscreen");
    el.disableRemotePlayback = true;
    el.setAttribute("disableRemotePlayback", "true");
    el.disablePictureInPicture = true;
    el.setAttribute("disablePictureInPicture", "true");
    el.preload = "metadata";
    el.setAttribute("fetchpriority", "high");
    el.className = "player-video";

    /* Restore saved volume so it persists across plays and reloads. */
    try {
      var s = Store.getSettings();
      if (typeof s.volume === "number" && s.volume >= 0 && s.volume <= 1) el.volume = s.volume;
      if (typeof s.muted === "boolean") el.muted = s.muted;
    } catch (e) { /* ignore */ }

    /* Candidate URLs (Xtream live channels carry alternates). The player
       walks through them until one plays, then shows a clear error. */
    var candidates = [item.source].concat(item.alts || []).filter(Boolean);
    var lock = false;
    el.__idx = 0;
    el.__hlsManaged = false;
    el.__mpegtsManaged = false;

    function removeMessages() {
      var wrap = el.parentNode;
      if (!wrap) return;
      var msgs = wrap.querySelectorAll(".player-msg");
      for (var i = msgs.length - 1; i >= 0; i--) msgs[i].remove();
    }

    function destroyManaged() {
      if (hlsInstance) {
        try { hlsInstance.destroy(); } catch (e) { /* ignore */ }
        hlsInstance = null;
      }
      if (mpegtsInstance) {
        try { mpegtsInstance.destroy(); } catch (e) { /* ignore */ }
        mpegtsInstance = null;
      }
    }

    function loadCandidate() {
      var src = candidates[el.__idx];
      if (!src) { showPlayError(el, item); lock = false; return; }
      if (window.console) console.log("[player] candidate " + (el.__idx + 1) + "/" + candidates.length, src);
      /* Only .m3u8 sources go through hls.js. Live streams served as raw
         MPEG-TS (.ts) or with no extension play through mpegts.js (MSE) —
         feeding them to the native <video> element fails on Chromium because
         they are not HLS manifests. Ordinary files (mp4/webm…) stay native. */
      if (isHlsSource(src)) {
        loadHls().then(function (ok) {
          lock = false;
          el.__hlsManaged = false;
          el.__mpegtsManaged = false;
          if (!ok) { el.src = src; return; }
          el.__hlsManaged = true;
          initHls(el, src, saved, advance, !!item.live);
        });
      } else if (needsMpegts(src, item.live)) {
        loadMpegts().then(function (ok) {
          lock = false;
          el.__hlsManaged = false;
          el.__mpegtsManaged = false;
          if (!ok) { el.src = src; return; }
          initMpegts(el, src, item, advance);
        });
      } else {
        el.__hlsManaged = false;
        el.__mpegtsManaged = false;
        el.src = src;
        lock = false;
      }
    }

    function advance() {
      if (lock) return;
      lock = true;
      el.__hlsManaged = false;
      el.__mpegtsManaged = false;
      destroyManaged();
      el.__idx++;
      if (el.__idx >= candidates.length) {
        lock = false;
        showPlayError(el, item);
        return;
      }
      loadCandidate();
    }

    function restart() {
      if (lock) return;
      lock = true;
      el.__hlsManaged = false;
      el.__mpegtsManaged = false;
      destroyManaged();
      el.__idx = 0;
      removeMessages();
      loadCandidate();
    }
    el.__restart = restart;

    el.addEventListener("error", function () {
      if (el.__suppressError) { el.__suppressError = false; return; }
      if (el.__hlsManaged || el.__mpegtsManaged) return;
      if (el.__idx < candidates.length - 1) advance();
      else showPlayError(el, item);
    });

    /* Arrow/Enter/Space handling is on document (onDocKeydown) so it works
       in fullscreen regardless of focus. */

    /* Click the video to toggle play/pause (mouse only; a touch tap just
       reveals the control bar instead of pausing). */
    el.addEventListener("click", function (e) {
      if (e.pointerType === "touch") return;
      togglePlay(el);
      if (seekPoke) seekPoke();
    });

    el.addEventListener("loadedmetadata", function () {
      if (saved && saved.position > 5 && saved.progress < 98 && !item.live) {
        try { el.currentTime = saved.position; } catch (e) { /* ignore */ }
      }
    });

    var lastHistoryWrite = 0;
    el.addEventListener("timeupdate", function () {
      if (item.live) return;
      var now = Date.now();
      if (now - lastHistoryWrite < 3000) return;
      var keep = (el.duration || 0) - el.currentTime;
      if (isFinite(keep) && keep > 0.5) {
        lastHistoryWrite = now;
        Store.addToHistory(currentId, {
          position: el.currentTime, duration: el.duration, progress: el.duration ? Math.round(el.currentTime / el.duration * 100) : 0
        });
      }
    });

    el.addEventListener("pause", savePosition);
    el.addEventListener("ended", function () {
      Store.saveProgress(currentId, el.duration || 0, el.duration || 0);
      Store.markWatched(currentId);
      notify("Playback finished — marked as watched");
      if (global.UI) UI.refreshBadges && UI.refreshBadges();
    });

    loadCandidate();
    blockNativeControls(el);

    return el;
  }

  /* Extract a safe iframe from untrusted embed HTML.
     Never evaluates the raw HTML; only reads the iframe src. */
  function buildEmbed(item) {
    var raw = String(item.source || "").trim();
    /* source may be raw <iframe> HTML (extract src) or a plain embed URL
       (auto-detected from providers like YouTube/Vimeo/Dailymotion). */
    var src = /<iframe/i.test(raw) ? extractIframeSrc(raw) : "";
    if (!src && (/^https?:\/\//i.test(raw) || /^\/\//.test(raw))) src = raw;
    var wrap = document.createElement("div");
    wrap.className = "embed-wrap";
    if (!src) {
      wrap.innerHTML = '<div class="player-msg player-error"><strong>Unable to embed this content.</strong><br>The embed code contains no usable iframe.<br><span style="font-size:12px;word-break:break-all">' + escapeHtml(item.source) + "</span></div>";
      return wrap;
    }
    var frame = document.createElement("iframe");
    frame.src = src;
    frame.setAttribute("allow", "autoplay; fullscreen; encrypted-media; picture-in-picture");
    frame.setAttribute("allowfullscreen", "allowfullscreen");
    frame.setAttribute("frameborder", "0");
    frame.setAttribute("referrerpolicy", "no-referrer-when-downgrade");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation allow-popups");
    frame.title = item.title;
    frame.className = "player-frame";
    wrap.appendChild(frame);
    return wrap;
  }

  function extractIframeSrc(html) {
    var s = String(html || "");
    var m = /<iframe\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(s);
    var src = m ? (m[2] || m[3] || m[4] || "") : "";
    src = src.replace(/&amp;/g, "&");
    if (/^https?:\/\//i.test(src) || /^\/\//.test(src)) return src;
    return "";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function cancel() {
    active = false;
    inlineActive = false;
    stopWatchedTimer();
    stopSaveTimer();
    if (hlsInstance) {
      try { hlsInstance.destroy(); } catch (e) { /* ignore */ }
      hlsInstance = null;
    }
    if (mpegtsInstance) {
      try { mpegtsInstance.destroy(); } catch (e) { /* ignore */ }
      mpegtsInstance = null;
    }
    if (video) {
      video.__mpegtsManaged = false;
      video.__hlsManaged = false;
      savePosition();
      video.pause();
      video = null;
    }
    currentId = null;
    currentLive = false;
    seekWrap = null;
    seekControls = null;
    seekFsBtn = null;
    seekPoke = null;
    watchedBtnPaint = null;
  }

  /* Public API */
  function play(itemId) {
    var item = Store.getItem(itemId);
    if (!item) { notify("Content not found.", true); if (global.App) App.navigate("#home"); return; }

    /* Defensive: stale items stored as "direct" may still hold embed sources
       (star-prefixed links or iframe HTML from older imports). Play them as
       embeds and repair the stored copy. */
    if (item.mediaType !== "embed") {
      var srcText = String(item.source || "").trim();
      var detected = global.M3UParser ? M3UParser.detectMediaType(srcText) : "direct";
      if (detected === "embed" || srcText.indexOf("*") === 0 || /^<iframe\b/i.test(srcText)) {
        var fixed = {
          mediaType: "embed",
          source: global.M3UParser ? M3UParser.normalizeEmbedSource(srcText) : srcText
        };
        item = Object.assign({}, item, fixed);
        if (Store.updateItem) Store.updateItem(itemId, fixed);
      }
    }

    cancel();
    active = true;
    currentId = itemId;
    currentLive = !!item.live;

    var saved = Store.getProgressFor(itemId);
    Store.addToHistory(itemId, { position: saved.position, duration: saved.duration, progress: saved.progress });

    var root = document.createElement("div");
    root.className = "page player-page";

    var head = document.createElement("div");
    head.className = "player-head";
    var title = document.createElement("h2");
    title.textContent = item.type === "episode"
      ? (item.seriesName ? item.seriesName + " " : "") + "S" + pad(item.season) + "E" + pad(item.episodeNumber) + " — " + (item.episodeTitle || item.title)
      : item.title;

    /* Fix doubled title: if the episode title already contains the series
       name, strip it to avoid showing "Series Name S01E03 — Series Name S1 E3". */
    if (item.type === "episode" && item.seriesName) {
      var epLabel = item.episodeTitle || item.title || "";
      var sn = item.seriesName;
      if (epLabel.indexOf(sn) === 0 || epLabel.toLowerCase().indexOf(sn.toLowerCase()) === 0) {
        epLabel = epLabel.substring(sn.length).replace(/^[\s:–-]+/, "").trim();
      }
      if (epLabel) {
        title.textContent = (item.seriesName ? item.seriesName + " " : "") + "S" + pad(item.season) + "E" + pad(item.episodeNumber) + " — " + epLabel;
      }
    }

    /* Details target: episode -> series page (with season), movie -> movie details. */
    var detailsTarget = item.type === "episode" && item.seriesId
      ? "#series/" + encodeURIComponent(item.seriesId) + (item.season != null ? "?season=" + item.season : "")
      : "#movie/" + encodeURIComponent(item.id);

    var actions = document.createElement("div");
    actions.className = "player-head-actions";
    var backDetails = document.createElement("button");
    backDetails.className = "btn btn-secondary btn-sm focusable";
    backDetails.innerHTML = "&larr; Back";
    backDetails.addEventListener("click", function () { App.navigate(detailsTarget); });
    var goHome = document.createElement("button");
    goHome.className = "btn btn-secondary btn-sm focusable";
    goHome.textContent = "Home";
    goHome.addEventListener("click", function () { App.navigate("#home"); });
    actions.appendChild(backDetails);
    actions.appendChild(goHome);

    head.appendChild(title);
    head.appendChild(actions);

    var wrap = document.createElement("div");
    wrap.className = "player-wrap";
    var loader = createLoader();
    wrap.appendChild(loader.el);

    if (item.mediaType === "embed") {
      var embed = buildEmbed(item);
      wrap.appendChild(embed);
    } else {
      video = buildDirect(item, saved);
      attachLoader(video, loader);
      wrap.appendChild(video);
      wrap.appendChild(buildControlBar(wrap, video));
      startSaveTimer();
    }

    /* Episode navigation strip under the player: visible for all episodes,
       including embed sources which don't have the custom control bar. */
    var epNavStrip = item.type === "episode" && item.seriesId ? makeEpisodeNavButtons(item, false) : null;

    var note = document.createElement("div");
    note.className = "player-msg player-note";
    note.style.display = "none";
    note.innerHTML = "Direct videos are marked as watched at 85% playback. Embed sources are marked on open.";

    /* Small info block under the player: title, source link, description. */
    var info = document.createElement("div");
    info.className = "player-info";
    var infoTitle = document.createElement("div");
    infoTitle.className = "player-info-title";
    infoTitle.textContent = title.textContent;
    var infoLink = document.createElement("div");
    infoLink.className = "player-info-link";
    if (/^https?:\/\//i.test(item.source || "") || /^\/\//.test(item.source || "")) {
      var a = document.createElement("a");
      a.href = item.source;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = item.source;
      infoLink.appendChild(a);
    } else if (item.source) {
      infoLink.textContent = item.source;
    }
    var infoDesc = document.createElement("div");
    infoDesc.className = "player-info-desc";
    infoDesc.textContent = item.description || "";
    info.appendChild(infoTitle);
    if (infoLink.textContent) info.appendChild(infoLink);
    if (infoDesc.textContent) info.appendChild(infoDesc);

    root.appendChild(head);
    root.appendChild(wrap);
    root.appendChild(note);

    /* Row under the player: prev/next episode buttons on the left,
       mark watched button on the right. */
    var underPlayerRow = document.createElement("div");
    underPlayerRow.className = "player-under-row";
    if (epNavStrip) underPlayerRow.appendChild(epNavStrip);

    var watchedBtn = document.createElement("button");
    watchedBtn.className = "btn btn-secondary btn-sm focusable";
    function paintWatched() {
      var watched = Store.isWatched(itemId);
      watchedBtn.textContent = watched ? "✓ Watched" : "Mark as Watched";
      watchedBtn.classList.toggle("btn-ok", watched);
    }
    watchedBtnPaint = paintWatched;
    paintWatched();
    watchedBtn.addEventListener("click", function () {
      if (Store.isWatched(itemId)) {
        Store.markUnwatched(itemId);
        notify("Removed from watched");
      } else {
        Store.markWatched(itemId);
        notify("Marked as watched");
      }
      paintWatched();
    });
    underPlayerRow.appendChild(watchedBtn);
    root.appendChild(underPlayerRow);

    root.appendChild(info);

    page.innerHTML = "";
    page.appendChild(root);

    startWatchedTimer(item);
    paintWatched(); /* re-paint after startWatchedTimer, which may mark embeds as watched */

    var el = video || wrap.querySelector("iframe");
    if (el) {
      el.classList.add("focusable");
      el.focus();
    }
  }

  function escape() {
    if (inlineActive) { cancel(); return; }
    if (active) {
      var item = currentId != null ? Store.getItem(currentId) : null;
      var target = item && item.type === "episode" && item.seriesId
        ? "#series/" + encodeURIComponent(item.seriesId)
        : "#home";
      App.navigate(target);
    }
  }

  /* Play an item inline inside a given container (used by the Live view,
     which keeps the channel list next to the video). The video element gets
     the same direct/embed handling and control bar as the full player, but
     without any page navigation. Returns a stop function. */
  function playInline(container, itemId) {
    var item = Store.getItem(itemId);
    if (!item) { notify("Content not found.", true); return null; }
    cancel();
    active = true;
    inlineActive = true;
    currentId = itemId;
    currentLive = !!item.live;

    var saved = Store.getProgressFor(itemId);
    Store.addToHistory(itemId, { position: saved.position, duration: saved.duration, progress: saved.progress });

    container.innerHTML = "";
    var wrap = document.createElement("div");
    wrap.className = "player-wrap live-wrap";
    var loader = createLoader();
    wrap.appendChild(loader.el);
    if (item.mediaType === "embed") {
      wrap.appendChild(buildEmbed(item));
    } else {
      video = buildDirect(item, saved);
      attachLoader(video, loader);
      wrap.appendChild(video);
      wrap.appendChild(buildControlBar(wrap, video));
      startSaveTimer();
    }
    container.appendChild(wrap);

    return function stop() { cancel(); };
  }

  /* Toggle fullscreen on the currently active inline player (or no-op). */
  function fullscreen() {
    if (seekWrap) toggleFullscreen(seekWrap);
  }

  global.Player = {
    play: play,
    playInline: playInline,
    fullscreen: fullscreen,
    cancel: cancel,
    isActive: function () { return active; },
    escape: escape
  };
})(window);
