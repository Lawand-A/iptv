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

  function centerX(el) { var r = el.getBoundingClientRect(); return r.left + r.width / 2; }
  function centerY(el) { var r = el.getBoundingClientRect(); return r.top + r.height / 2; }

  /* Cluster focusables into horizontal rows, sorted top-to-bottom.
     Within each row items are sorted left-to-right. */
  function buildRows() {
    var list = getFocusables();
    list.sort(function (a, b) { return centerY(a) - centerY(b); });

    var rows = [];
    list.forEach(function (el) {
      var cy = centerY(el);
      var h = el.getBoundingClientRect().height;
      var placed = false;
      for (var i = 0; i < rows.length; i++) {
        if (Math.abs(cy - rows[i].cy) < Math.max(30, rows[i].height * 0.5)) {
          rows[i].els.push(el);
          placed = true;
          break;
        }
      }
      if (!placed) {
        rows.push({ cy: cy, height: h, els: [el] });
      }
    });
    rows.forEach(function (r) {
      r.els.sort(function (a, b) { return centerX(a) - centerX(b); });
    });
    return rows;
  }

  function findPosition(rows, el) {
    for (var i = 0; i < rows.length; i++) {
      var idx = rows[i].els.indexOf(el);
      if (idx >= 0) return { row: i, idx: idx };
    }
    return null;
  }

  function nearestInRow(rowEls, x) {
    var best = null, bestD = Infinity;
    rowEls.forEach(function (el) {
      var d = Math.abs(centerX(el) - x);
      if (d < bestD) { bestD = d; best = el; }
    });
    return best;
  }

  function move(dir) {
    var rows = buildRows();
    if (!rows.length) return;

    var current = document.activeElement;
    if (current === document.body || current === null) current = null;
    if (current && !current.classList.contains("focusable")) current = null;

    if (!current) {
      focusFirstContent();
      return;
    }

    usedKeyboard = true;
    var pos = findPosition(rows, current);
    if (!pos) {
      focusFirstContent();
      return;
    }

    var rowEls = rows[pos.row].els;
    var target = null;

    if (dir === "left" || dir === "right") {
      var idx = pos.idx + (dir === "right" ? 1 : -1);
      if (idx >= 0 && idx < rowEls.length) {
        target = rowEls[idx];
      } else {
        /* edge of row — continue on the row below (right) / above (left) */
        var nextRow = rows[pos.row + (dir === "right" ? 1 : -1)];
        if (nextRow) {
          target = nearestInRow(nextRow.els, centerX(current));
        } else {
          /* wrap around to the opposite end of the same row */
          target = rowEls[idx < 0 ? rowEls.length - 1 : 0];
        }
      }
    } else if (dir === "up" || dir === "down") {
      var nextPos = pos.row + (dir === "down" ? 1 : -1);
      if (nextPos >= 0 && nextPos < rows.length) {
        target = nearestInRow(rows[nextPos].els, centerX(current));
      } else {
        /* top/bottom edge — wrap to the other end */
        var wrapRow = rows[dir === "down" ? 0 : rows.length - 1];
        target = nearestInRow(wrapRow.els, centerX(current));
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
        if (e.target && e.target.tagName === "INPUT" && e.target.type === "text") {
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
