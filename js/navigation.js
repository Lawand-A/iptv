/* Navigation — spatial keyboard & Smart TV remote navigation.
   Focusables are grouped into rows; arrows move within a row (left/right)
   and between rows (up/down), wrapping at the edges.

   Smart TV remotes are handled specially because their webviews differ from
   desktop browsers in three ways that made navigation flaky:
     • Remotes may deliver keydown with an empty or non-standard `key`
       ("Left" instead of "ArrowLeft", "Select" instead of "Enter", or only a
       keyCode). keyName() normalizes every form so arrows / OK / back always
       work on Tizen, webOS, Android TV, CEF shells, etc.
     • Programmatic .focus() can silently fail or lag on TV webviews, leaving
       document.activeElement stuck on <body> — navigation kept our own
       lastFocused pointer and falls back to it, and lazily tabindexes
       non-native focusables (e.g. the .file-drop div) so .focus() works.
     • After a render, layout can take a beat before elements have size, so
       re-focus retries until real focusables exist. */
(function (global) {
  "use strict";

  var lastFocused = null;
  var usedKeyboard = false;

  var KEY_ALIASES = {
    ArrowLeft: "left", Left: "left",
    ArrowRight: "right", Right: "right",
    ArrowUp: "up", Up: "up",
    ArrowDown: "down", Down: "down",
    Enter: "enter", Select: "enter", OK: "enter", ok: "enter",
    " ": "space", Spacebar: "space",
    Escape: "escape",
    Backspace: "backspace", Back: "backspace"
  };
  var KEY_CODES = {
    37: "left", 38: "up", 39: "right", 40: "down",
    13: "enter", 32: "space", 27: "escape", 8: "backspace",
    461: "backspace", 10009: "backspace", 1082: "backspace"
  };

  /* Canonicalize a keydown into left/right/up/down/enter/space/escape/
     backspace (or the raw key string for anything else). */
  function keyName(e) {
    if (!e) return "";
    var k = e.key || e.keyIdentifier || "";
    if (KEY_ALIASES[k]) return KEY_ALIASES[k];
    var code = e.keyCode || e.which;
    if (KEY_CODES[code]) return KEY_CODES[code];
    return k || "";
  }

  /* Rough Smart-TV detection (Tizen, webOS, NetCast, Android TV, consoles…).
     Used to auto-focus on load (remotes expect the app to land on an item)
     and to skip smooth-scroll animations TV engines choke on. */
  function isTV() {
    var ua = "";
    try { ua = (global.navigator && global.navigator.userAgent) || ""; } catch (e) { /* ignore */ }
    return /(?:Tizen|Web0S|webOS|NetCast|SMART-?TV|Smarttv|Viera|Vestel|Hisense|Xbox|PlayStation|CrKey|GoogleTV|Android.{0,40}\bTV|Opera.{0,10}TV)/i.test(ua);
  }
  var tvMode = isTV();

  function isVisible(el) {
    if (!el || el.hidden) return false;
    if (el.closest && el.closest("[hidden]")) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    return true;
  }

  function getFocusables() {
    var nodes = document.querySelectorAll(".focusable");
    var out = [];
    nodes.forEach(function (el) {
      if (isVisible(el)) out.push(el);
    });
    return out;
  }

  function inApp(el) {
    var app = document.getElementById("app");
    return app && app.contains(el);
  }

  /* The element navigation should move from: the real DOM focus when it is a
     visible focusable, otherwise our own lastFocused pointer. TV webviews
     sometimes fail to move document.activeElement, so relying on it alone
     made navigation stop dead after the first step. */
  function currentFocusable() {
    var c = document.activeElement;
    if (c && c !== document.body && isFocusable(c) && isVisible(c)) return c;
    if (lastFocused && document.body.contains(lastFocused) && isFocusable(lastFocused) && isVisible(lastFocused)) return lastFocused;
    return null;
  }

  function move(dir) {
    usedKeyboard = true;
    var current = currentFocusable();
    if (!current) {
      focusFirstContent();
      return;
    }

    /* 1-D gap between two intervals — 0 when they overlap. Full-width bars
       (search inputs, the file drop zone) overlap every column, so they are
       reachable from anywhere instead of being skipped. */
    function gap(a1, a2, b1, b2) {
      return b1 > a2 ? b1 - a2 : a1 > b2 ? a1 - b2 : 0;
    }

    var curRect = current.getBoundingClientRect();
    var cx = curRect.left + curRect.width / 2;
    var cy = curRect.top + curRect.height / 2;
    var horizontal = dir === "left" || dir === "right";
    var sgn = dir === "right" || dir === "down" ? 1 : -1;
    var fromLink = !horizontal && current.classList.contains("section-link");

    var best = null, bestScore = Infinity;
    var aligned = null, alignedScore = Infinity;
    var flowBest = null, flowScore = Infinity;
    var wrapBest = null, wrapScore = Infinity;

    /* The fixed topbar stays at the viewport top while content scrolls, so
       plain spatial scoring against it is unreliable (the "up from the top
       button sometimes fails" bug). Instead: topbar items are excluded from
       normal scoring, and ArrowUp lands on the navbar exactly when nothing
       in the page content is above the current element. */
    var topbar = document.getElementById("topbar");
    var inTopbar = topbar && topbar.contains(current);

    getFocusables().forEach(function (el) {
      if (el === current) return;
      if (topbar && topbar.contains(el) && !inTopbar) return;
      var r = el.getBoundingClientRect();
      var ex = r.left + r.width / 2;
      var ey = r.top + r.height / 2;

      if (horizontal) {
        var hDist = sgn * (ex - cx);
        var vGap = gap(curRect.top, curRect.bottom, r.top, r.bottom);
        if (hDist > 4) {
          if (vGap === 0) {
            /* same visual row — always beats a nearer element on another row */
            if (hDist < alignedScore) { alignedScore = hDist; aligned = el; }
          } else {
            var hScore = hDist + vGap * 2;
            if (hScore < bestScore) { bestScore = hScore; best = el; }
          }
        }
        /* flow: at the row edge, continue on the next line down (right) or
           previous line up (left), taking the edge element of that line */
        var fDist = sgn > 0 ? ey - cy : cy - ey;
        if (fDist > 4) {
          var fScore = fDist * 10 + (sgn > 0 ? r.left : -r.right);
          if (fScore < flowScore) { flowScore = fScore; flowBest = el; }
        }
        /* wrap: nearest band vertically, extreme element in direction */
        var wScore = Math.abs(ey - cy) * 10 + (sgn > 0 ? r.left : -r.right);
        if (wScore < wrapScore) { wrapScore = wScore; wrapBest = el; }
      } else {
        var vDist = sgn * (ey - cy);
        var hGap = gap(curRect.left, curRect.right, r.left, r.right);
        if (vDist > 4) {
          /* From a "View all" link prefer the first (leftmost) element of the
             next band. */
          if (fromLink) {
            var lScore = vDist * 10 + r.left;
            if (lScore < bestScore) { bestScore = lScore; best = el; }
          } else if (hGap === 0) {
            /* same column — always beats a nearer element in another column,
               which is what keeps multi-column form pages sane */
            if (vDist < alignedScore) { alignedScore = vDist; aligned = el; }
          } else {
            var vScore = vDist + hGap * 2;
            if (vScore < bestScore) { bestScore = vScore; best = el; }
          }
        }
        /* wrap: the extreme element in the direction of travel */
        var w2Score = (sgn > 0 ? ey : -ey) + hGap * 2;
        if (w2Score < wrapScore) { wrapScore = w2Score; wrapBest = el; }
      }
    });

    var target = aligned || best || (horizontal ? flowBest : null) || wrapBest;

    /* ArrowUp with nothing above in the content → go to the navbar (the
       horizontally nearest topbar item). Reaching the navbar from anywhere
       else is impossible, as required. */
    if (!inTopbar && dir === "up" && !aligned && !best && topbar) {
      var tbItems = [];
      topbar.querySelectorAll(".focusable").forEach(function (el) {
        if (isVisible(el)) tbItems.push(el);
      });
      if (tbItems.length) {
        var tbBest = null, tbScore = Infinity;
        tbItems.forEach(function (el) {
          var r = el.getBoundingClientRect();
          var hGap = gap(curRect.left, curRect.right, r.left, r.right);
          var d = hGap === 0 ? 0 : hGap * 2 + Math.abs((r.left + r.width / 2) - cx);
          if (d < tbScore) { tbScore = d; tbBest = el; }
        });
        target = tbBest || tbItems[0];
      }
    }

    if (target) focusEl(target);
  }

  function focusFirstContent() {
    var list = getFocusables();
    if (!list.length) return false;
    var first = list.find(function (el) { return inApp(el); }) || list[0];
    focusEl(first);
    return true;
  }

  function markFocused(el) {
    document.querySelectorAll(".spatial-focus").forEach(function (n) {
      n.classList.remove("spatial-focus");
    });
    if (el) {
      el.classList.add("spatial-focus");
      lastFocused = el;
    }
  }

  /* Ensure .focus() is honoured even on elements that are not natively
     focusable (e.g. the .file-drop div). tabindex="-1" keeps them out of the
     Tab order while still allowing programmatic focus everywhere. */
  function ensureFocusable(el) {
    if (!el || !el.tagName) return;
    var tag = el.tagName;
    if (tag === "BUTTON" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (tag === "A" && el.getAttribute("href")) return;
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  }

  function focusEl(el) {
    if (!el) return;
    ensureFocusable(el);
    try { el.focus(); } catch (e) { /* ignore */ }
    markFocused(el);
    try {
      el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: tvMode ? "auto" : "smooth" });
    } catch (e) { /* ignore */ }
  }

  function isFocusable(el) {
    return el && el.classList && el.classList.contains("focusable");
  }

  function isTyping(el) {
    if (!el) return false;
    if (/INPUT|TEXTAREA|SELECT/.test(el.tagName)) return true;
    return el.isContentEditable === true;
  }

  function onKey(e) {
    var key = keyName(e);
    var typing = isTyping(e.target);

    if (key === "escape" || key === "backspace") {
      if (typing) return;
      if (key === "escape" && UI.modalOpen()) {
        UI.closeModal();
        return;
      }
      e.preventDefault();
      usedKeyboard = true;
      if (Player.isActive()) Player.escape();
      else global.App && App.goBack();
      return;
    }

    if (typing) {
      if (key === "enter") return;
      if (key === "up" || key === "down") {
        var t = e.target;
        /* Text-like inputs, textareas and dropdowns: up/down moves to the
           next field instead of editing text / cycling the dropdown
           selection. Use Enter to open a dropdown and change its value. */
        if (t && (t.tagName === "SELECT" || t.tagName === "TEXTAREA" ||
            (t.tagName === "INPUT" && /^(text|password|url|email|search|number|tel)$/.test(t.type)))) {
          e.preventDefault();
          move(key === "down" ? "down" : "up");
        }
      }
      return;
    }

    /* Do not steal arrows from the media element (native seek/volume). */
    if (e.target && (e.target.tagName === "VIDEO" || e.target.tagName === "IFRAME")) return;

    if (key === "left" || key === "right" || key === "up" || key === "down") {
      e.preventDefault();
      move(key);
    } else if (key === "enter" || key === "space") {
      var cur = document.activeElement;
      if (cur && isFocusable(cur)) {
        e.preventDefault();
        usedKeyboard = true;
        cur.click();
      }
    }
  }

  function restoreFocus() {
    if (lastFocused && document.body.contains(lastFocused)) {
      focusEl(lastFocused);
    } else {
      focusFirstContent();
    }
  }

  /* Call after any page render: re-focus content when the user navigates by
     keyboard, and always on Smart TVs (remotes expect the app to land on an
     item). Retried a few times because TV webviews can take a moment to lay
     out — until then focusables have zero bounds and getFocusables() is
     empty, which used to leave navigation dead after a render. */
  var FOCUS_ATTEMPTS = 8;
  var FOCUS_DELAY = 80;
  function afterRender() {
    if (!usedKeyboard && !tvMode) return;
    retryFirstFocus(0);
  }
  function retryFirstFocus(attempt) {
    if (focusFirstContent()) return;
    if (attempt >= FOCUS_ATTEMPTS) return;
    setTimeout(function () { retryFirstFocus(attempt + 1); }, FOCUS_DELAY);
  }

  function init() {
    document.addEventListener("keydown", onKey, true);
  }

  global.Nav = {
    init: init,
    restoreFocus: restoreFocus,
    afterRender: afterRender,
    focusFirst: focusFirstContent,
    keyName: keyName
  };
})(window);
