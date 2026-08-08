/* M3U exporter — serializes the library back into an .m3u playlist.
   Embed entries use a documented application-specific attribute:
     tvg-media-type="embed" tvg-embed="<url-encoded HTML>"
   with the data line "#EMBED#". This round-trips losslessly through the importer. */
(function (global) {
  "use strict";

  function esc(value) {
    return String(value == null ? "" : value).replace(/"/g, "&quot;");
  }

  function buildExtInf(item) {
    var attrs = [];
    if (item.tvgId) attrs.push('tvg-id="' + esc(item.tvgId) + '"');
    if (item.tvgName) attrs.push('tvg-name="' + esc(item.tvgName) + '"');
    if (item.poster) attrs.push('tvg-logo="' + esc(item.poster) + '"');
    if (item.group) attrs.push('group-title="' + esc(item.group) + '"');
    if (item.description) attrs.push('tvg-description="' + esc(item.description) + '"');

    if (item.mediaType === "embed") {
      attrs.push('tvg-media-type="embed"');
      attrs.push('tvg-embed="' + esc(encodeURIComponent(item.source)) + '"');
    }

    var label = item.title || "Untitled";
    if (item.type === "episode") {
      label = item.seriesName ? item.seriesName + " " : "";
      label += "S" + pad(item.season) + "E" + pad(item.episodeNumber);
      if (item.episodeTitle) label += " - " + item.episodeTitle;
    }
    return "#EXTINF:-1 " + attrs.join(" ") + "," + label;
  }

  function pad(n) {
    return String(n == null ? "" : n).padStart(2, "0");
  }

  function exportM3U(items) {
    var out = ["#EXTM3U", ""];
    items.forEach(function (item) {
      if (item && item.type === "series") return;
      out.push(buildExtInf(item));
      if (item.mediaType === "embed") {
        out.push("#EMBED#");
      } else {
        out.push(item.source || "");
      }
      out.push("");
    });
    return out.join("\n");
  }

  function download(items, filename) {
    var text = exportM3U(items);
    var blob = new Blob([text], { type: "audio/x-mpegurl;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename || "library.m3u";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    return text;
  }

  global.M3UExporter = { exportM3U: exportM3U, download: download };
})(window);
