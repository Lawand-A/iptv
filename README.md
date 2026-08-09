# StreamHub: Free and Personal IPTV player over the web
A fully static, single-page web application for organizing and playing IPTV content. No build step, no backend, and no user accounts. Everything runs in the browser and the data stays local.

## What it does
StreamHub lets the user import playlists and stream sources into a personal media library with a dark, TV-friendly interface. 

It supports movies, live TV channels, series with episodes, and **embeddable web players too**. Content can come from M3U playlists, Xtream Codes providers, or manual entries.

The app is designed to work like a lightweight Netflix-style client: poster grids, category rows, searchable lists, resume playback, watchlist, and recently watched.

## How to use
[Downlaod this github project](https://github.com/Lawand-A/iptv/archive/refs/heads/main.zip), extract the project and then open the `index.html` file with a browser. 

This is a live Demo: http://tv.crackoverflow.com

## Main views
- **Home**: hero banner, recently watched, watchlist, movies, series, categories, and recently added rows.
- **Movies**: searchable grid of all VOD/movie items.
- **Live**: two-pane live channel player with filtering and pinned channels.
- **Series**: searchable grid of detected series.
- **Series Details**: seasons, episodes, resume progress, and series watchlist toggle.
- **Categories**: group cards with counts and posters.
- **Category View**: browse one group in the split-view layout.
- **Watchlist**: saved movies, series, episodes, and categories.
- **History**: recently watched items with resume positions.
- **Search**: real-time search across titles, groups, series names, episode titles, and channel names.
- **Settings**: import sources, export library, add or edit items, and maintenance actions.
- **Player**: full-page playback with custom controls, seeking, volume, fullscreen, and episode navigation.

## Content support
- **Direct video files**: MP4, WebM, MKV, MOV, and other browser-playable URLs.
- **Live streams**: HLS `.m3u8`, MPEG-TS `.ts`/extensionless, RTMP, RTSP, UDP, SRT, MMS, and Xtream live endpoints.
- **Series**: auto-detected from titles using `SxxExx`, `Season x Episode y`, and similar patterns; grouped by series and sorted by season/episode.
- **Embed sources**: YouTube, Vimeo, Dailymotion, dai.ly, YouTube Shorts/Live, and raw `<iframe>` HTML. Forced embed via `*` prefix, e.g. `*https://...`.

## Import sources
- **M3U file**: drag-and-drop or click-to-select in Settings; parses `#EXTM3U`, `#EXTINF`, `#EXTGRP`, and `#EMBED#`.
- **M3U URL**: fetch directly with HTTPS upgrade fallback for mixed-content situations.
- **Xtream Codes API**: server URL, username, password; imports live streams, VOD movies, and series with fallback endpoints and alternate URLs.
- **Manual add**: create movies, episodes, or series containers from a form.
- **Re-import**: update existing entries by source URL instead of duplicating; reports added / updated / skipped counts.
- **Export**: download the whole library as an `.m3u` file.

## Player features
- HTML5 `<video>` for direct files.
- `hls.js` loaded on demand for `.m3u8` sources.
- `mpegts.js` loaded on demand for MPEG-TS streams.
- Source probing with engine fallback.
- HEVC/H.265 and codec-aware fallback to WebCodecs where possible.
- Custom control bar with play/pause, ±10 s seek, progress slider, time, volume/mute, fullscreen.
- Auto-hiding controls that work in fullscreen.
- Resume from last saved position.
- Volume persistence across plays.
- Episode previous/next buttons for series.
- Error UI with retry and “open source” options.

## PWA and offline
- Installable as a Progressive Web App via the web app manifest.
- Service worker precaches the app shell and uses cache-first for local assets.
- Network-first with cache fallback for CDN scripts and posters.
- Media streams and API endpoints are never cached.
- iOS PWA meta tags and standalone display support.

## Storage
- `localStorage` for small data: watchlist, history, progress, watched status, settings, and pins.
- `IndexedDB` for the item library so large playlists do not hit storage limits.
- In-memory lazy indexes for fast navigation, category counts, grouping, and search.
- Deferred persistence and index rebuilds to keep the UI responsive.

## Controls and navigation
- Full keyboard and TV remote support with arrow-key spatial navigation.
- `Enter`/`Space`/`OK` activates focused items.
- `Escape`/`Backspace` closes modals, exits the player, or goes back.
- Focus ring and focus-visible styles for accessibility.
- Skip-to-content link and ARIA labels on controls.

## Tracking
- **Watchlist**: save movies, episodes, series, or whole categories.
- **History**: last opened time, playback position, duration, and progress.
- **Progress**: saved automatically during playback; resume prompt when reopening an item.
- **Watched**: manual toggle or automatic marking when a direct video reaches 85%.

