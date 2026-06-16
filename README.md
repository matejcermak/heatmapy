# Strava Heatmap for Mapy.com

Overlay your **Strava heatmaps** on [Mapy.com](https://mapy.com) — the **global
heatmap split by sport** (MTB / Ride / Run, in *hot*) plus your own **personal
heatmap** (in blue), shown together over the real map. Find the roads and trails
you've never ridden or run yet — on the map with the best route planning around.

![Demo](assets/demo.gif)

| Global MTB + your personal heat | Global Ride + your personal heat |
| --- | --- |
| ![MTB + personal](assets/screenshot-mtb-personal.png) | ![Ride + personal](assets/screenshot-ride-personal.png) |

The **global** heat shows where everyone goes; your **personal** heat (blue) shows
where *you've* already been. Together they make the good lines obvious — and the
ones you still haven't explored. That's the whole point of planning. Per-sport
**MTB / Ride / Run** layers mean it's not just for cyclists. And Mapy.com's
outdoor + aerial maps and route planner beat the usual map apps for this.

Two ways to run it:

- **`extension/`** — a **Chrome extension** (Manifest V3). The easy, one-click
  way; this is what goes to the Chrome Web Store. See **[Chrome extension](#chrome-extension)**.
- **`mapy_strava_overlay.user.js`** — the original **Tampermonkey userscript**
  for power users (also does Waymarked Trails layers, GPX→Ride with GPS export,
  etc.). See **[Userscript](#userscript-tampermonkey)**.

You need to be **logged in to Strava** in the same browser. The global heatmap
above zoom 11 and the personal heatmap require a **Strava Subscription**.

---

## Chrome extension

### Install (development / unpacked, until it's on the Web Store)

1. Clone/download this repo.
2. Chrome → `chrome://extensions` → enable **Developer mode** (top right).
3. **Load unpacked** → select the `extension/` folder.
4. Make sure you're **logged in to Strava** in the same browser (open
   `strava.com` once). Click the extension icon → it auto-detects your athlete ID
   (or paste it manually from your `strava.com/athletes/<id>` profile URL).
5. Open [Mapy.com](https://mapy.com) — use the **on-map panel** (bottom-left) or
   the keys below.

### Controls

On-map panel (bottom-left):

- **(A) Heatmaps** — master on/off switch; turns both layers off (and back on).
- **(S) Global** — cycles **MTB → Ride → Run → off** (in *hot*).
- **(D) Personal** — toggles your heatmap (in *blue*); it follows the sport
  selected in Global.
- Opacity slider.

The keys mirror the buttons: `A` master · `S` global sport · `D` personal ·
`[` / `]` opacity. When planning a route, **⌘-click (Mac) / Ctrl-click (PC)** the
map to add a point.

### How it works

- A **service worker** (`background.js`) fetches Strava heatmap tiles with your
  logged-in cookies (`host_permissions` for `*.strava.com`) — content scripts
  can't do credentialed cross-origin fetches in MV3, the worker can.
- `content.js` renders two stacked tile layers over Mapy's map, caches global
  tiles in IndexedDB (instant on reopen) and everything in memory, and
  canvas-recolors the personal tiles (Strava serves them as opaque black) to a
  transparent blue overlay.
- Endpoints: global `content-a.strava.com/identified/globalheat/sport_*/hot/...`,
  personal `personal-heatmaps-external.strava.com/tiles/<athleteId>/...`.

### Privacy

The extension only talks to Strava (to fetch your heatmap tiles, using cookies
already in your browser) and stores small settings locally. It sends nothing to
any third party. See [PRIVACY.md](PRIVACY.md).

---

## Userscript (Tampermonkey)

### Setup

1. Install Tampermonkey in your browser.
2. Create a new userscript and paste `mapy_strava_overlay.user.js`.
3. Open `https://www.strava.com/maps/global-heatmap` once **in a normal tab
   while logged in**, and pan/zoom once so heatmap tiles load. This makes Strava
   set the CloudFront signed cookies (scoped to `.strava.com`, ~1-week expiry)
   that gate the high-resolution `tiles-auth` tiles. Do this in a real tab, not
   just rely on the background refresh — third-party cookie partitioning can
   stop an iframe's cookies from being usable.
4. Open `https://mapy.com/` and pan/zoom — the overlay tracks the URL.

### Hotkeys

Two independent overlays — a **global** heatmap (`S`) and your **personal**
heatmap (`D`) — that can be shown together (personal blue on top of global hot).
Main controls are a left-hand cluster: **A S D**.

- `A` — master on/off (turns both the global and personal layers off, and back)
- `S` — cycle the **global** heatmap (remembered across reloads):
  **MTB** (hot) → **Ride** (hot) → **off**.
- `D` — toggle your **personal** heatmap on/off (blue). Its sport follows `S`
  (MTB global → MTB personal, Ride global → Ride personal); when global is off it
  uses the last sport you looked at.
- `E` — export current Mapy planner route as GPX and open Ride with GPS upload
- `[` / `]` — decrease / increase opacity in 10% steps
- `Alt + D` — toggle debug panel

Colors are **fixed**: global heatmaps are `hot`; personal is **blue**. The
personal endpoint returns **opaque-black** tiles (background black, heat in
grayscale) regardless of the requested color, so each personal tile is
**canvas-recolored** at render time — black background keyed to transparent,
heat painted blue (`alpha = intensity`, `rgb = PERSONAL_RGB`). Processed tiles
are cached in memory. No color hotkey. Waymarked Trails route layers were removed.

### Tile sources

| Layer | URL pattern | Max zoom | Auth |
| --- | --- | --- | --- |
| Global per-sport heatmap (`S`) | `content-a.strava.com/identified/globalheat/sport_{MountainBikeRide,Ride}/hot/{z}/{x}/{y}.png?v=19&missing=empty` | ~15 | CloudFront **cookie** (logged-in `.strava.com`, via `GM_xmlhttpRequest`) |
| Personal heatmap (`D`) | `personal-heatmaps-external.strava.com/tiles/<athleteId>/blue/{z}/{x}/{y}.png?...&filter_type=sport_{MountainBikeRide,Ride}&...` | ~15 | CloudFront **cookie** |

The **global per-sport heatmap** is the endpoint the Strava web app itself uses,
and — unlike the public `heatmap-external/.../ride/...` tiles — it **separates
disciplines** (`sport_Ride` = road, `sport_MountainBikeRide`). It authenticates by
cookie, fetched through Tampermonkey (`@connect content-*.strava.com` +
`strava.com`, `withCredentials`) so the browser attaches your `.strava.com`
cookies. No query-string signature or capture step is involved.

### Personal heatmap setup

The personal heatmap tile URL contains your **athlete id**, so it's baked into
`PERSONAL_HEAT_URL_TEMPLATE` near the top of the script (currently Matěj's,
`4568015`). To use a different account, open your personal heatmap on Strava
(`https://www.strava.com/maps/personal-heatmap`, logged in), grab a tile URL from
DevTools → Network, and swap the athlete id / template in. Placeholders `{z}`
`{x}` `{y}` `{sport}` `{color}` are substituted at render time (`{sport}` =
`sport_MountainBikeRide` / `sport_Ride`, `{color}` = `blue`).

### Caching & performance

Tiles are cached so panning/switching/reopening is fast instead of re-fetching
every tile through the (rate-limited) cookie path:

- **In-memory** object-URL cache (this session) — switching `S`/`D` or panning
  back is instant.
- **IndexedDB** cache for **global** tiles (`mapyStravaTileCache`, 30-day TTL) —
  re-opening mapy renders cached areas immediately, no network. This is lazy
  "pre-download": whatever you look at is cached and stays fast. Personal tiles
  are **not** persisted (they change often) — memory-only for the session.
- **Stale-request abort** — when a render is superseded (you panned or toggled),
  its in-flight tile requests are cancelled so they stop clogging the request
  pool, which is what made old tiles keep trickling in.

Global heat barely changes, so the 30-day TTL is fine; bump
`GLOBAL_TILE_TTL_MS` to refresh more/less often. (A full bulk "download all of
Czechia" prefetch is intentionally avoided — at useful zoom it's thousands of
tiles per sport; the lazy IndexedDB cache gives the same instant feel for the
areas you actually browse.)

### Auth — it just needs your logged-in Strava cookies

Open the heatmap once in a normal tab while logged in (`https://www.strava.com/maps/global-heatmap`)
so Strava sets the CloudFront cookies, then use mapy. If heatmap tiles come back
`403`, your cookies are missing/expired — reload the Strava heatmap page (logged
in) to refresh them. Diagnose with `Alt+D`: the `gm ok/fail` and `last=` lines
show the tile HTTP status (`200` = working, `403` = cookie problem). High-res
(z>11) heatmap needs a Strava **subscription**; a free login is capped at z11.

> Legacy: an older path used `heatmap-external-*.strava.com/tiles{,-auth}` with a
> signed-query capture + cookie probe (`tryRefreshStravaAuth`,
> `probeStravaCookieAuth`). That endpoint returned `InvalidKey` for this account,
> so the script moved to the `content-*` per-sport endpoint above. The legacy
> code remains but isn't wired into the active source list.

**Diagnose:** press `Alt+D` and read the `gm ok/fail` and `last=` lines —
`200` means heatmap tiles are flowing, `403` means a cookie problem (reload the
Strava heatmap page logged in to refresh the CloudFront cookies).

### MTB vs road: actually split

The Strava per-sport heatmap *can* be split by discipline. The web app's
`content-*.strava.com/identified/globalheat/sport_<X>/...` endpoint serves
per-discipline heat — `sport_Ride` (road) vs `sport_MountainBikeRide` — which the
public `heatmap-external/.../ride/...` tiles do not (those aggregate every ride
sub-type into `ride`). `S` cycles MTB → Road → off, and the personal layer (`D`)
follows the same discipline. This needs your logged-in Strava cookies (and a
subscription for z>11); the official Strava API / MCP can't help — the heatmap is
an internal tile service outside the public API.

## Demo app

For local experimentation only:

- `python -m http.server 5500`
- Open `http://localhost:5500`
