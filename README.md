# Mapy + Strava Heatmap Overlay

This repo now includes two options:

- `index.html` demo app (simulated planner + Strava overlay)
- `mapy_strava_overlay.user.js` userscript that runs on real `mapy.com`

## Run

Open `index.html` in a browser.

For best behavior with map tiles, serve it via a static server:

- Python: `python -m http.server 5500`
- Then open: `http://localhost:5500`

## Features

- Map style switcher (outdoor, aerial, winter)
- Planner-like toggles (POI, contours, traffic simulation)
- Route planning simulation by clicking the map
- Distance and point stats with undo/clear actions
- Strava heatmap overlay:
  - toggle on/off
  - sport + color style selection
  - opacity slider
  - auto-sync on `moveend` and `zoomend`

## Real Mapy Overlay (what you asked for)

Use `mapy_strava_overlay.user.js` with Tampermonkey to keep full Mapy controls
and place Strava heatmap tiles on top.

### Setup

1. Install Tampermonkey in your browser.
2. Create a new userscript and paste `mapy_strava_overlay.user.js`.
3. Open Strava heatmap once at `https://www.strava.com/maps/global-heatmap`
   while logged in. This lets the script capture signed tile query params.
4. Open `https://mapy.com/`.
5. Pan/zoom on Mapy; overlay follows URL center/zoom updates.

### Controls

- `Alt + H`: toggle overlay on/off
- `Alt + ]`: increase heatmap opacity
- `Alt + [`: decrease heatmap opacity

### Config

Edit constants in `mapy_strava_overlay.user.js`:

- `FILTERS.sport` (currently `MountainBikeRide`)
- `FILTERS.gColor` (currently `bluered`)
- `FILTERS.gOpacity` (currently `100`)
- `STRAVA_AUTH_QUERY` for signed/auth tile query if required

When `STRAVA_AUTH_QUERY` is empty, the script automatically uses the latest
signed query captured from Strava map requests.

## Strava Tile Notes

The app uses Strava heatmap tile endpoints. Depending on Strava restrictions,
some tiles may require an authenticated session or signed query parameters.

If tiles fail to load:

- demo app: update `stravaConfig.authQuery` in `app.js`
- real Mapy userscript: update `STRAVA_AUTH_QUERY`
