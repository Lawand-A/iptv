/* App — hash routing, global actions, boot. */
(function (global) {
  "use strict";

  var topbar = document.getElementById("topbar");
  var appEl = document.getElementById("app");
  var mobileMenu = document.getElementById("mobileMenu");
  var navStack = [];
  var booted = false;

  function parseRoute() {
    var hash = location.hash || "#home";
    var path = hash.replace(/^\#\/?/, "");
    var qIdx = path.indexOf("?");
    var query = "";
    if (qIdx >= 0) {
      query = path.slice(qIdx + 1);
      path = path.slice(0, qIdx);
    }
    var parts = path.split("/").filter(Boolean);
    return {
      name: parts[0] || "home",
      arg: parts[1] ? safeDecode(parts[1]) : null,
      query: query,
      hash: hash
    };
  }

  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function openItem(id) {
    var item = Store.getItem(id);
    if (!item) { UI.toast("Content not found.", "err"); return; }
    if (item.type === "episode") {
      navigate("#play/" + encodeURIComponent(id));
    } else if (item.type === "series") {
      navigate("#series/" + encodeURIComponent(item.seriesId || id));
    } else {
      navigate("#movie/" + encodeURIComponent(id));
    }
  }

  function navigate(hash) {
    if (location.hash === hash) {
      render();
      return;
    }
    location.hash = hash;
  }

  function render() {
    if (!booted) return;
    var route = parseRoute();

    if (route.name === "play") {
      if (route.arg) {
        Player.cancel();
        Player.play(route.arg);
      }
      updateNav("home");
      return;
    }

    if (Player.isActive()) Player.cancel();
    UI.closeModal();

    switch (route.name) {
      case "movies": UI.renderMovies(); updateNav("movies"); break;
      case "live":
        UI.renderLive(); updateNav("live"); break;
      case "cat":
      case "livecat":
        if (route.arg) { UI.renderCategory(route.arg); updateNav("categories"); }
        else { UI.renderCategories(); updateNav("categories"); }
        break;
      case "series":
        if (route.arg) {
          var seasonQ = "";
          var sqm = /(?:^|&)season=([^&]*)/.exec(route.query);
          if (sqm) seasonQ = decodeURIComponent(sqm[1]);
          UI.renderSeriesDetails(route.arg, seasonQ);
          updateNav("series");
        }
        else { UI.renderSeries(); updateNav("series"); }
        break;
      case "categories": UI.renderCategories(); updateNav("categories"); break;
      case "movie":
        if (route.arg) { UI.renderMovieDetails(route.arg); updateNav("movies"); }
        else { UI.renderMovies(); updateNav("movies"); }
        break;
      case "watchlist": UI.renderWatchlist(); updateNav("watchlist"); break;
      case "history": UI.renderHistory(); updateNav("history"); break;
      case "search": {
        var q = "";
        var qm = /(?:^|&)q=([^&]*)/.exec(route.query);
        if (qm) q = decodeURIComponent(qm[1]);
        UI.renderSearch(q); updateNav("search"); break;
      }
      case "settings": UI.renderSettings(); updateNav("settings"); break;
      case "add": UI.renderAdd(); updateNav("settings"); break;
      case "edit":
        if (route.arg) { UI.renderEdit(route.arg); updateNav("settings"); }
        else { UI.renderSettings(); updateNav("settings"); }
        break;
      default:
        UI.renderHome();
        updateNav("home");
        break;
    }

    navStack.push(location.hash);
    if (navStack.length > 40) navStack.shift();

    Nav.afterRender();
  }

  function goBack() {
    if (UI.modalOpen()) { UI.closeModal(); return; }
    if (Player.isActive()) { Player.escape(); return; }
    if (window.history.length > 1) {
      window.history.back();
    } else {
      navigate("#home");
    }
  }

  function updateNav(active) {
    document.querySelectorAll(".nav-link[data-action]").forEach(function (b) {
      var act = b.getAttribute("data-action");
      b.style.color = act === active ? "var(--text)" : "";
      b.style.background = act === active ? "rgba(255,255,255,.08)" : "";
    });
  }

  function setAction(btn) {
    var action = btn.getAttribute("data-action");
    if (action === "toggle-menu") {
      btn.addEventListener("click", function () {
        mobileMenu.hidden = !mobileMenu.hidden;
      });
      return;
    }
    if (action === "refresh") {
      btn.addEventListener("click", function () {
        mobileMenu.hidden = true;
        if (UI.refreshSources) UI.refreshSources();
      });
      return;
    }
    btn.addEventListener("click", function () {
      mobileMenu.hidden = true;
      navigate("#" + action);
    });
  }

  function bindGlobal() {
    document.querySelectorAll("[data-action]").forEach(setAction);
    bindFooter();
  }

  function bindFooter() {
    document.querySelectorAll("[data-footer]").forEach(function (btn) {
      var action = btn.getAttribute("data-footer");
      btn.addEventListener("click", function () {
        if (action === "clear-history") {
          UI.confirmModal("Clear watch history?", "", function () { Store.clearHistory(); UI.toast("History cleared", "ok"); });
        } else if (action === "clear-watchlist") {
          UI.confirmModal("Clear the entire watchlist?", "", function () {
            Store.getWatchlist().forEach(function (id) { Store.removeFromWatchlist(id); });
            UI.toast("Watchlist cleared", "ok");
          });
        } else if (action === "clear-library") {
          UI.confirmModal("Clear the entire library?", "All items, history, progress and watchlist will be removed.", function () {
            Store.clearLibrary();
            UI.toast("Library cleared", "ok");
            navigate("#home");
          });
        } else if (action === "reset") {
          UI.confirmModal("Reset everything?", "This wipes all application data. There is no undo.", function () {
            Store.resetAll().then(function () { location.reload(); }).catch(function () { location.reload(); });
          });
        } else if (action === "delete-refresh") {
          UI.confirmModal("Delete and re-import?", "All current items will be removed, then re-imported from your saved sources. History, progress and watchlist are kept.", function () {
            Store.saveItems([]);
            if (UI.refreshSources) UI.refreshSources();
          });
        }
      });
    });
  }

  function init() {
    Nav.init();
    bindGlobal();
    if (Store.setPersistErrorHandler && UI) {
      Store.setPersistErrorHandler(function (msg) { UI.toast(msg, "err"); });
    }
    var boot = Store.ready();
    window.addEventListener("hashchange", function () { boot.then(render); });
    window.addEventListener("scroll", function () {
      topbar.classList.toggle("scrolled", window.scrollY > 8);
    });
    window.addEventListener("beforeunload", function () {
      Player.cancel();
    });
    boot.then(function () {
      booted = true;
      render();
      /* Fetch hls.js/mpegts.js in the background so the first live/stream
         play starts instantly instead of waiting for a CDN download. */
      if (Player && Player.preloadStreamLibs) {
        setTimeout(Player.preloadStreamLibs, 1200);
      }
    });
  }

  global.App = {
    navigate: navigate,
    render: render,
    goBack: goBack,
    openItem: openItem,
    parseRoute: parseRoute
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
