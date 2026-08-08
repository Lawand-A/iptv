/* Player — renders direct HTML5 video or safe embed iframe.
   Handles progress saving, resume, and the 60-second watched rule. */
(function (global) {
  "use strict";

  var WATCHED_SECONDS = 60;
  var SAVE_INTERVAL_MS = 5000;
  var watchedTimer = null;
  var saveTimer = null;
  var currentId = null;
  var video = null;
  var active = false;
  var inlineActive = false;

  var page = document.getElementById("app");

  function notify(msg, isErr) {
    if (UI && UI.toast) UI.toast(msg, isErr ? "err" : undefined);
  }

  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function fmt(sec) {
    if (!isFinite(sec)) return "0:00";
    sec = Math.floor(sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ":" + pad(m) : m) + ":" + pad(s);
  }

  function startWatchedTimer(item) {
    stopWatchedTimer();
    if (Store.isWatched(item.id)) return;
    watchedTimer = setTimeout(function () {
      Store.markWatched(item.id);
      notify("Marked as watched");
      if (UI) UI.refreshBadges && UI.refreshBadges();
    }, WATCHED_SECONDS * 1000);
  }

  function stopWatchedTimer() {
    if (watchedTimer) { clearTimeout(watchedTimer); watchedTimer = null; }
  }

  function savePosition() {
    if (!video || currentId == null) return;
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

  function showPlayError(el, item, src) {
    var wrap = el.parentNode;
    if (!wrap || wrap.querySelector(".player-error")) return;
    var url = src || (item && item.source) || "";
    var msg = document.createElement("div");
    msg.className = "player-msg player-error";
    msg.innerHTML = "<strong>Unable to play this video.</strong><br>The source may be unavailable, blocked (CORS), or in an unsupported format.<br><span style='font-size:12px;word-break:break-all'>" + escapeHtml(url) + "</span>";
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

  function initHls(video, src, saved, onFail) {
    if (!window.Hls || !Hls.isSupported()) {
      video.src = src;
      return;
    }
    var hls = new Hls();
    hlsInstance = hls;
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, function () {
      if (saved && saved.position > 5 && saved.progress < 98 && !video.ended) {
        try { video.currentTime = saved.position; } catch (e) { /* ignore */ }
      }
      var p = video.play();
      if (p && p.catch) p.catch(function () { showTapHint(video); });
    });
    hls.on(Hls.Events.ERROR, function (evt, data) {
      if (!data || !data.fatal) return;
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

  /* Custom bottom control bar (play/pause, ±10s seek, time, fullscreen).
     Replaces the native <video> controls so the seek overlay also works in
     fullscreen (native fullscreen only renders the bare <video> element).
     Visible on hover/touch/key activity; auto-hide after 5s idle. */
  var seekWrap = null;      /* current .player-wrap (for fullscreen)   */
  var seekControls = null;  /* current control bar element            */
  var seekFsBtn = null;     /* current fullscreen toggle button       */
  var seekPoke = null;      /* current show/reset-timer function      */

  var HIDE_DELAY_MS = 5000;

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
      if (document.exitFullscreen) document.exitFullscreen().catch(function () { /* ignore */ });
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

    var fsBtn = makeBarButton("bar-btn bar-fs", "Toggle fullscreen", fsIcon());
    seekFsBtn = fsBtn;
    fsBtn.addEventListener("click", function () { toggleFullscreen(wrap); poke(); });

    row.appendChild(playBtn);
    row.appendChild(backBtn);
    row.appendChild(fwdBtn);
    row.appendChild(timeEl);

    var spacer = document.createElement("span");
    spacer.className = "bar-spacer";
    row.appendChild(spacer);
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

    /* ---- visibility: show on activity, hide after 5s idle ---- */
    var hideTimer = null;

    function hide() {
      if (bar.contains(document.activeElement)) {
        hideTimer = setTimeout(hide, 2000);
        return;
      }
      bar.classList.remove("show");
    }

    function poke() {
      bar.classList.add("show");
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, HIDE_DELAY_MS);
    }
    seekPoke = poke;

    wrap.addEventListener("mousemove", poke);
    wrap.addEventListener("mouseleave", function () {
      if (hideTimer) clearTimeout(hideTimer);
      hide();
    });
    wrap.addEventListener("touchstart", poke, { passive: true });
    wrap.addEventListener("keydown", poke);
    video.addEventListener("pause", poke);
    video.addEventListener("play", poke);

    poke();

    return bar;
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

  function buildDirect(item, saved) {
    var el = document.createElement("video");
    el.autoplay = true;
    el.playsInline = true;
    el.className = "player-video";

    /* Candidate URLs (Xtream live channels carry alternates). The player
       walks through them until one plays, then shows a clear error. */
    var candidates = [item.source].concat(item.alts || []).filter(Boolean);
    var lock = false;
    el.__idx = 0;
    el.__hlsManaged = false;

    function removeMessages() {
      var wrap = el.parentNode;
      if (!wrap) return;
      var msgs = wrap.querySelectorAll(".player-msg");
      for (var i = msgs.length - 1; i >= 0; i--) msgs[i].remove();
    }

    function destroyCurrentHls() {
      if (hlsInstance) {
        try { hlsInstance.destroy(); } catch (e) { /* ignore */ }
        hlsInstance = null;
      }
    }

    function loadCandidate() {
      var src = candidates[el.__idx];
      if (!src) { showPlayError(el, item); lock = false; return; }
      /* Only .m3u8 sources go through hls.js. Live streams served as raw
         MPEG-TS (.ts) or with no extension play natively in the <video>
         element — feeding them to hls.js fails because they are not HLS
         manifests. This is what makes most Xtream .ts live channels work. */
      if (isHlsSource(src)) {
        loadHls().then(function (ok) {
          lock = false;
          if (!ok) { el.__hlsManaged = false; el.src = src; return; }
          el.__hlsManaged = true;
          initHls(el, src, saved, advance);
        });
      } else {
        el.__hlsManaged = false;
        el.src = src;
        lock = false;
      }
    }

    function advance() {
      if (lock) return;
      lock = true;
      el.__hlsManaged = false;
      destroyCurrentHls();
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
      destroyCurrentHls();
      el.__idx = 0;
      removeMessages();
      loadCandidate();
    }
    el.__restart = restart;

    el.addEventListener("error", function () {
      if (el.__suppressError) { el.__suppressError = false; return; }
      if (el.__hlsManaged) return;
      if (el.__idx < candidates.length - 1) advance();
      else showPlayError(el, item);
    });

    /* ←/→ seek ±10s, Enter/Space toggle play. The native controls are
       replaced by the custom bottom bar, so the default arrow-key seek
       (~5s) is suppressed here. */
    el.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight") { e.preventDefault(); seekBy(el, 10); if (seekPoke) seekPoke(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); seekBy(el, -10); if (seekPoke) seekPoke(); }
      else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePlay(el); if (seekPoke) seekPoke(); }
    });

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

    el.addEventListener("timeupdate", function () {
      var keep = (el.duration || 0) - el.currentTime;
      if (isFinite(keep) && keep > 0.5) Store.addToHistory(currentId, {
        position: el.currentTime, duration: el.duration, progress: el.duration ? Math.round(el.currentTime / el.duration * 100) : 0
      });
    });

    el.addEventListener("pause", savePosition);
    el.addEventListener("ended", function () {
      Store.saveProgress(currentId, el.duration || 0, el.duration || 0);
      Store.markWatched(currentId);
      notify("Playback finished — marked as watched");
      if (UI) UI.refreshBadges && UI.refreshBadges();
    });

    loadCandidate();

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
    if (video) {
      savePosition();
      video.pause();
      video = null;
    }
    currentId = null;
    seekWrap = null;
    seekControls = null;
    seekFsBtn = null;
    seekPoke = null;
  }

  /* Public API */
  function play(itemId) {
    var item = Store.getItem(itemId);
    if (!item) { notify("Content not found.", true); if (App) App.navigate("#home"); return; }

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

    var saved = Store.getProgressFor(itemId);
    Store.addToHistory(itemId, { position: saved.position, duration: saved.duration, progress: saved.progress });

    var root = document.createElement("div");
    root.className = "page player-page";

    var head = document.createElement("div");
    head.className = "player-head";
    var back = document.createElement("button");
    back.className = "btn btn-secondary focusable";
    back.innerHTML = "&larr; Back";
    back.addEventListener("click", function () { App.navigate("#home"); });
    var title = document.createElement("h2");
    title.textContent = item.type === "episode"
      ? (item.seriesName ? item.seriesName + " " : "") + "S" + pad(item.season) + "E" + pad(item.episodeNumber) + " — " + (item.episodeTitle || item.title)
      : item.title;
    head.appendChild(back);
    head.appendChild(title);

    var wrap = document.createElement("div");
    wrap.className = "player-wrap";
    if (item.mediaType === "embed") {
      var embed = buildEmbed(item);
      wrap.appendChild(embed);
    } else {
      video = buildDirect(item, saved);
      wrap.appendChild(video);
      wrap.appendChild(buildControlBar(wrap, video));
      startSaveTimer();
    }

    var note = document.createElement("div");
    note.className = "player-msg player-note";
    note.style.display = "none";
    note.innerHTML = "Opening the player for at least 60 seconds marks this item as watched.";

    root.appendChild(head);
    root.appendChild(wrap);
    root.appendChild(note);

    page.innerHTML = "";
    page.appendChild(root);

    startWatchedTimer(item);

    var el = video || wrap.querySelector("iframe");
    if (el) {
      el.classList.add("focusable");
      el.focus();
    }
  }

  function escape() {
    if (inlineActive) { cancel(); return; }
    if (active) { App.navigate("#home"); }
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

    var saved = Store.getProgressFor(itemId);
    Store.addToHistory(itemId, { position: saved.position, duration: saved.duration, progress: saved.progress });

    container.innerHTML = "";
    var wrap = document.createElement("div");
    wrap.className = "player-wrap live-wrap";
    if (item.mediaType === "embed") {
      wrap.appendChild(buildEmbed(item));
    } else {
      video = buildDirect(item, saved);
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
