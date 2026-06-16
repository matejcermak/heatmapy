# Chrome Web Store — submission checklist & listing copy

## What you need to do (one-time)

1. **Register a developer account**: <https://chrome.google.com/webstore/devconsole>
   — one-time **$5 USD** fee, Google account.
2. **Privacy policy URL**: link to the repo's `PRIVACY.md` (raw GitHub URL is fine),
   or host it on a small page.
3. **Package**: zip the **contents of `extension/`** (manifest.json at the zip root,
   not the folder). From the repo:
   ```
   cd extension && zip -r ../strava-heatmap-mapy.zip . -x '*.DS_Store'
   ```
4. **Create item** in the dev console → upload the zip → fill the listing (below) →
   add assets → submit for review (a few days).

## Assets (you'll provide the visuals)

- **Store icon**: 128×128 PNG (already in `icons/icon128.png`; replace with a nicer
  one if you want).
- **Screenshots**: 1–5, **1280×800** or **640×400** PNG/JPG. Use the mapy.com overlay
  (MTB hot + personal blue), the on-map panel, aerial+heat, etc.
- **Promo (optional)**: small 440×280 tile; marquee 1400×560. The GIF/video you
  shoot can seed these.
- **Category**: Tools / Productivity. **Language**: English (add Czech later).

## Listing copy (draft — edit freely)

**Name**: Strava Heatmap for Mapy.com

**Short description** (≤132 chars):
> See your Strava heatmaps on Mapy.com — global MTB / Ride / Run popularity plus
> your own personal heatmap, for better route planning.

**Detailed description**:
> Plan routes on Mapy.com with Strava's heat on top of the map.
>
> • Global heatmap, split by sport — switch between MTB, Ride, and Run.
> • Your personal heatmap in blue, overlaid on the global heat, following the same
>   sport — so you can spot the roads and trails you haven't done yet.
> • On-map controls plus keyboard shortcuts (A master / S global / D personal),
>   opacity, fast tile caching.
>
> Requires being logged in to Strava in the same browser. The global heatmap above
> zoom 11 and the personal heatmap require a Strava Subscription. The extension only
> talks to Strava (using your existing login) and stores settings locally — nothing
> is sent anywhere else. See the privacy policy.

**Permission justifications** (the console asks per permission):
- *Host permission `*.strava.com`*: "To fetch the user's Strava heatmap tiles using
  their existing Strava login, and to detect their athlete ID for the personal
  heatmap. No data leaves the browser."
- *storage / unlimitedStorage*: "To save the user's settings and athlete ID, and to
  cache heatmap tiles locally for performance."
- *Remote code*: none — all scripts are bundled.

## Notes / caveats to mention in the listing

- This is an independent project, **not affiliated with Strava or Mapy.com**.
- Uses Strava's heatmap the same way the Strava website does (your session); if
  Strava changes their endpoints it may need an update.
