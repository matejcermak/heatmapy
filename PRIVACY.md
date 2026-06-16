# Privacy Policy — Strava Heatmap for Mapy.com

_Last updated: 2026-06-16_

This Chrome extension overlays your Strava heatmaps on Mapy.com. It is designed to
keep your data on your own machine.

## What it accesses

- **Strava heatmap tiles.** When you use the overlay, the extension requests
  heatmap image tiles from Strava's servers (`*.strava.com`). These requests
  include the Strava cookies already stored in your browser, so Strava can
  authenticate you — exactly as if your browser loaded them on strava.com. This
  is the only way to show your personalized / high-resolution heatmap.
- **Your Strava athlete ID.** To request your *personal* heatmap, the extension
  reads your numeric Strava athlete ID (from a Strava page you're logged into, or
  one you enter manually). It is stored locally and used only to build your
  personal-heatmap tile URLs.

## What it stores (locally, on your device only)

- Your settings (which layers are on, opacity) — in the page's local storage.
- Your athlete ID — in the extension's local storage (`chrome.storage.local`).
- A cache of heatmap image tiles — in your browser's IndexedDB, to make the map
  fast and reduce repeated requests. You can clear it any time via the browser.

## What it does NOT do

- It does **not** send your data, browsing activity, or Strava information to the
  developer or any third-party server. There are no analytics, no tracking, and
  no remote code.
- It only runs on Mapy.com (the `mapy.com` and `mapy.cz` domains, for the overlay)
  and only contacts `strava.com` (to fetch your tiles).

## Permissions

- `host_permissions: *://*.strava.com/*` — to fetch your heatmap tiles with your
  logged-in session.
- `storage`, `unlimitedStorage` — to keep your settings, athlete ID, and the
  local tile cache.

## Contact

Questions or issues: open an issue at
<https://github.com/matejcermak/mapycz_strava>.
