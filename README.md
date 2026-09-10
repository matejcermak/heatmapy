# Heatmapy — Strava Heatmap for Mapy.com

Overlay your **Strava heatmaps** on [Mapy.com](https://mapy.com) — the **global
heatmap split by sport** (MTB / Gravel / Road / Run / Trail Run, in *hot*) plus your own **personal
heatmap** (in blue), shown together over the real map. Find the roads and trails
you've never ridden or run yet — on the map with the best route planning around.

**New — Sync to Strava:** plan a route on Mapy.com and push it to your Strava
account in one click (always private and starred). From there it flows to your
**Garmin / Wahoo** on the next device sync. *(Strava subscription required.)*

**[🌐 heatmapy.com](https://heatmapy.com)** &nbsp;·&nbsp;
**[🧩 Get it on the Chrome Web Store](https://chromewebstore.google.com/detail/pkifpafiblikmgkcpkbdjmoapjnladok)** &nbsp;·&nbsp;
**[☕ Buy me a coffee](https://donate.stripe.com/5kQ5kD6bo4oV83UcCd5J600)**

![Demo](assets/demo.gif)

## Screenshots

| | | |
| --- | --- | --- |
| ![Strava global + personal heatmaps on Mapy.com](extension/store-assets/screenshot-1-heatmap.png) | ![Plan routes on the heatmap](extension/store-assets/screenshot-2-route-planning.png) | ![Sync to Strava — then to your Garmin/Wahoo](extension/store-assets/screenshot-3-sync-strava.png) |

The **global** heat shows where everyone goes; your **personal** heat (blue) shows
where *you've* already been. Together they make the good lines obvious — and the
ones you still haven't explored. That's the whole point of planning. Per-sport
**MTB / Gravel / Road / Run / Trail Run** layers mean it's not just for cyclists. And Mapy.com's
outdoor + aerial maps and route planner beat the usual map apps for this.

You need to be **logged in to Strava** in the same browser. A **Strava Subscription**
is required for the global heatmap above zoom 11, your **personal heatmap**, and
**Sync to Strava** (saving a planned route to your account). The low-zoom global
heatmap, route planning, and the plain GPX download work on a free account.

---

## Install

### From the Chrome Web Store (recommended)

**[➡️ Install Heatmapy](https://chromewebstore.google.com/detail/pkifpafiblikmgkcpkbdjmoapjnladok)**,
pin it, then open [Mapy.com](https://mapy.com). Make sure you're **logged in to
Strava** in the same browser (open `strava.com` once). Click the extension icon →
it auto-detects your athlete ID (or paste it from your `strava.com/athletes/<id>`
profile URL).

### Firefox

Heatmapy runs on **Firefox 128+** (that's when Firefox gained the `MAIN`-world
content scripts the Mapy route hook needs). Until the AMO listing is up, install it
from source:

```bash
npm run build:firefox        # → dist/firefox
```

Then `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick
`dist/firefox/manifest.json`. Or, with one command (auto-reloads on edits):

```bash
npm run start:firefox       # web-ext run, opens mapy.com
```

Log in to Strava in the same browser, then open [Mapy.com](https://mapy.com). If
Firefox asks about — or you later revoke — access to `strava.com`, click the
Heatmapy toolbar icon and use **Grant access**; the heatmap can't load without it.

### From source (unpacked, for development)

1. Clone/download this repo.
2. Chrome → `chrome://extensions` → enable **Developer mode** (top right).
3. **Load unpacked** → select the `extension/` folder.
4. Log in to Strava in the same browser, then open [Mapy.com](https://mapy.com).

## Build

No bundler and no dependencies — the build just copies `extension/` into
`dist/<browser>/` and writes the per-browser `manifest.json` (Chrome needs a
service worker, Firefox an event page + `browser_specific_settings`).

```bash
npm run build           # both targets → dist/chrome, dist/firefox
npm run build:firefox   # just one
npm run zip             # heatmapy-chrome.zip + heatmapy-firefox.zip for the stores
npm run lint:firefox    # web-ext lint (what AMO runs)
```

`extension/manifest.json` is the single source of truth, kept in its Chrome form so
`Load unpacked` on `extension/` still works directly. Firefox deltas live in
`scripts/build.mjs`. Bump the version in **both** `extension/manifest.json` and
`package.json`.

## Controls

On-map panel (bottom-left):

- **Sport** — pick the discipline: **Road / MTB / Gravel / Run / Trail**. Both layers follow it.
- **Global** — independent on/off for the crowd heatmap.
- **Personal** — independent on/off for *your* heatmap.
- **⏻** — master mute: hides everything at once (your per-layer choices are
  remembered) and brings it all back.
- **Opacity** slider — one control for both layers.
- **Sync to Strava** — saves your planned Mapy route to your Strava account as a
  Route (**requires a Strava subscription**), always private and starred. From there
  it syncs to your watch / bike computer — see below.
- **⬇** — plain GPX download (no account needed), to import manually.

The global and personal layers toggle **independently**, so you can show your
personal heat on its own, the global heat on its own, both, or neither.

Keyboard: `A` all on/off · `S` cycle sport · `D` global · `F` personal ·
`[` / `]` opacity. When planning a route, **⌘-click (Mac) / Ctrl-click (PC)** the
map to add a point.

## Getting a planned route onto your Garmin / Wahoo

The fast path is **Sync to Strava** (one click), then let your device pull
it from Strava — both brands do this once you've linked them **one time**:

- **Garmin:** connect Strava in Garmin Connect (Strava route sync). New Strava
  routes then auto-appear in **Courses** on your Edge/watch on the next sync.
- **Wahoo:** in the Wahoo app, link your Strava account under route providers.
  Your Strava routes show up in the app and sync to the ELEMNT over Wi-Fi.

(Uploading a GPX as a Strava *route* is a Strava subscriber feature; free accounts
can use the **⬇ GPX download** and import manually instead.)

## How it works

- A **background worker** (`background.js`) fetches Strava heatmap tiles with your
  logged-in cookies (`host_permissions` for `*.strava.com`) — content scripts
  can't do credentialed cross-origin fetches in MV3, the worker can. It's a service
  worker in Chrome and an event page in Firefox (which has no MV3 service workers);
  the code is identical, only the manifest key differs.
- `content.js` renders two stacked tile layers over Mapy's map, caches global
  tiles in IndexedDB (instant on reopen) and everything in memory, and
  canvas-recolors the personal tiles (Strava serves them as opaque black) to a
  transparent blue overlay.
- Endpoints: global `content-a.strava.com/identified/globalheat/sport_*/hot/...`,
  personal `personal-heatmaps-external.strava.com/tiles/<athleteId>/...`.

### Firefox: cookies need re-attaching

Chrome sends the user's Strava cookies on the background worker's fetches for free.
Firefox doesn't, for two reasons, and both break every credentialed request with a
403 or a redirect to `/login`:

1. A background request's initiator is the `moz-extension://` origin, so Firefox
   treats it as **cross-site** and withholds Strava's `SameSite` cookies. Chrome
   exempts extension requests holding host permissions.
2. **Containers each have their own cookie store** — and Zen's workspaces are
   containers. `cookies.getAll()` and background `fetch` both use the *default*
   store, so a user logged in inside a container is invisible to the extension.

So on Firefox only, `background.js` resolves which cookie store actually holds the
Strava session (`stravaStoreId()`, keyed on `_strava_idcf` / `CloudFront-Signature`,
since `_strava4_session` exists for anonymous visitors too) and re-attaches those
cookies with a blocking `webRequest.onBeforeSendHeaders` listener — which Firefox
MV3 still supports and Chrome removed. `fetch` can't do this itself: `Cookie` is a
forbidden header name. The listener is scoped to `*://*.strava.com/*` and only
touches the extension's own requests (`tabId === -1`), never page requests.

The CloudFront signed cookies (`CloudFront-Policy` / `-Signature` / `-Key-Pair-Id`)
are the ones that authorize the tile CDN — without them tiles 403 even when the
session cookie is present.

### MTB vs road: actually split

The web app's `content-*.strava.com/identified/globalheat/sport_<X>/...` endpoint
serves **per-discipline** heat — `sport_Ride` (road) vs `sport_MountainBikeRide` —
which the public `heatmap-external/.../ride/...` tiles do not (those aggregate
every ride sub-type into `ride`). `S` cycles MTB → Ride → Run, and the personal
layer (`D`) follows the same discipline. This needs your logged-in Strava cookies
(and a subscription for z>11); the official Strava API can't help — the heatmap is
an internal tile service outside the public API.

## Privacy

The extension only talks to Strava (to fetch your heatmap tiles, using cookies
already in your browser) and stores small settings locally. It sends nothing to
any third party. See [PRIVACY.md](PRIVACY.md).

## Support

If Heatmapy saves you time on the bike, **[buy me a coffee ☕](https://donate.stripe.com/5kQ5kD6bo4oV83UcCd5J600)**.
Found a bug or have an idea? **[Open a GitHub issue](https://github.com/matejcermak/heatmapy/issues)** —
it's actively maintained.

---

*Independent project — not affiliated with Strava or Mapy.com.*
