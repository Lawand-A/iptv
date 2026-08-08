/* Navigation — spatial keyboard & Smart TV remote navigation.
   Focusables are grouped into rows; arrows move within a row (left/right)
   and between rows (up/down), wrapping at the edges. */
(function (global) {
  "use strict";

  var lastFocused = null;
  var usedKeyboard = false;

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

  function move(dir) {
    var current = document.activeElement;
    if (current === document.body || current === null) current = null;
    if (current && !current.classList.contains("focusable")) current = null;

    if (!current) {
      focusFirstContent();
      return;
    }

    usedKeyboard = true;

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
    if (!list.length) return;
    var first = list.find(function (el) { return inApp(el); }) || list[0];
    focusEl(first);
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

  function focusEl(el) {
    if (!el) return;
    try { el.focus(); } catch (e) { /* ignore */ }
    markFocused(el);
    try { el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" }); } catch (e) { /* ignore */ }
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
    var key = e.key;
    var typing = isTyping(e.target);

    if (key === "Escape") {
      if (UI.modalOpen()) {
        UI.closeModal();
        return;
      }
      e.preventDefault();
      if (Player.isActive()) Player.escape();
      else global.App && App.goBack();
      return;
    }

    if (key === "Backspace") {
      if (typing) return;
      e.preventDefault();
      if (Player.isActive()) Player.escape();
      else global.App && App.goBack();
      return;
    }

    if (typing) {
      if (key === "Enter") return;
      if (key === "ArrowDown" || key === "ArrowUp") {
        var t = e.target;
        /* Text-like inputs, textareas and dropdowns: up/down moves to the
           next field instead of editing text / cycling the dropdown
           selection. Use Enter to open a dropdown and change its value. */
        if (t && (t.tagName === "SELECT" || t.tagName === "TEXTAREA" ||
            (t.tagName === "INPUT" && /^(text|password|url|email|search|number|tel)$/.test(t.type)))) {
          e.preventDefault();
          move(key === "ArrowDown" ? "down" : "up");
        }
      }
      return;
    }

    /* Do not steal arrows from the media element (native seek/volume). */
    if (e.target && (e.target.tagName === "VIDEO" || e.target.tagName === "IFRAME")) return;

    var arrows = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    if (arrows[key]) {
      e.preventDefault();
      move(arrows[key]);
    } else if (key === "Enter" || key === " " || key === "Select" || key === "OK") {
      var cur = document.activeElement;
      if (cur && isFocusable(cur)) {
        e.preventDefault();
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

  /* Call after any page render: re-focus content when the user navigates
     by keyboard, otherwise leave focus alone (mouse/touch users). */
  function afterRender() {
    if (!usedKeyboard) return;
    setTimeout(focusFirstContent, 30);
  }

  function init() {
    document.addEventListener("keydown", onKey, true);
  }

  global.Nav = {
    init: init,
    restoreFocus: restoreFocus,
    afterRender: afterRender,
    focusFirst: focusFirstContent
  };
})(window);
