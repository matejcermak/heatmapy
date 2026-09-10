# Store submission — checklist & listing copy (Chrome Web Store + Firefox AMO)

## What you need to do (one-time)

1. **Register a developer account**: <https://chrome.google.com/webstore/devconsole>
   — one-time **$5 USD** fee, Google account.
2. **Privacy policy URL**: link to the repo's `PRIVACY.md` (raw GitHub URL is fine),
   or host it on a small page.
3. **Package**: `npm run zip` from the repo root → `heatmapy-chrome.zip` and
   `heatmapy-firefox.zip` (manifest.json at the zip root, dev-only files excluded).
4. **Create item** in the dev console → upload the zip → fill the listing (below) →
   add assets → submit for review (a few days).

## Assets (you'll provide the visuals)

- **Store icon**: 128×128 PNG (already in `icons/icon128.png`; replace with a nicer
  one if you want).
- **Screenshots** (ready in `store-assets/`, 1280×800 PNG — upload in this order):
  1. `screenshot-1-heatmap.png` — global + personal heat on Mapy.com
  2. `screenshot-2-route-planning.png` — planning a route on the heatmap
  3. `screenshot-3-sync-strava.png` — one-click Sync to Strava (→ Garmin/Wahoo)
- **Promo (optional)**: small 440×280 tile; marquee 1400×560. The GIF/video you
  shoot can seed these.
- **Category**: Tools / Productivity. **Language**: English (add Czech later).

## Listing copy (draft — edit freely)

**Name**: Heatmapy — Strava Heatmap for Mapy.com

**Short description** (≤132 chars):
> Strava heatmaps on Mapy.com — global + personal heat by sport, plan routes, and
> one-click Sync to Strava for your Garmin/Wahoo.

**Detailed description**:
> Plan routes on Mapy.com with Strava's heat on top of the map.
>
> • Global heatmap, split by sport — switch between Road, MTB, Gravel, and Run.
> • Your personal heatmap in blue, on top of the global heat — toggle each layer
>   independently, so you can spot the roads and trails you haven't done yet.
> • Sync to Strava — save your planned Mapy route to your Strava account in one
>   click (private + starred). From there it syncs to your Garmin or Wahoo, so you
>   can ride it on your device. Or use the plain GPX download (no account needed).
> • On-map controls plus keyboard shortcuts (A all / S sport / D global / F personal),
>   opacity, fast tile caching.
>
> Requires being logged in to Strava in the same browser. A Strava Subscription is
> required for the global heatmap above zoom 11, the personal heatmap, and Sync to
> Strava (saving a route). Route planning and the plain GPX download work on a free
> account. The extension only talks to Strava (using your existing login) and stores
> settings locally — nothing is sent anywhere else. See the privacy policy.

**Permission justifications** (the console asks per permission):
- *Host permission `*.strava.com`*: "To fetch the user's Strava heatmap tiles using
  their existing Strava login, detect their athlete ID for the personal heatmap, and
  save a planned route to their own Strava account (Sync to Strava). No data leaves
  the browser except these requests to Strava."
- *storage / unlimitedStorage*: "To save the user's settings and athlete ID, and to
  cache heatmap tiles locally for performance."
- *Remote code*: none — all scripts are bundled.

## Firefox (AMO) — the extra bits

Account: <https://addons.mozilla.org/developers/> (free). Upload
`heatmapy-firefox.zip`; the same listing copy above works.

- **Run the linter first**: `npm run lint:firefox`. Expect **0 errors**; the 4
  `UNSAFE_VAR_ASSIGNMENT` warnings are static `innerHTML` templates built from
  extension constants only (no page or user data) — reviewers accept these, but
  they'll ask if you interpolate anything dynamic later.
- **Add-on id** — `heatmapy@matejcermak.github.io`, in `scripts/build.mjs`. Change
  it *before* the first upload if you'd rather use another domain: it's permanent
  once AMO has it.
- **`strict_min_version: 128.0`** — required, not cosmetic. `mapy-hook.js` relies on
  `content_scripts` `"world": "MAIN"`, which Firefox only supports from 128.
- **Data collection disclosure** — declared as `"none"` in
  `browser_specific_settings.gecko.data_collection_permissions`. That's accurate:
  nothing goes to the developer or a third party. *Sync to Strava* sends route data
  to the user's **own** Strava account, on an explicit click. If a reviewer reads
  that as collection, the honest amendment is `["locationInfo"]` (with
  `"technicalAndInteraction"` left out) — it changes the install prompt, not the code.
- **`webRequest` + `webRequestBlocking`** (Firefox build only — Chrome's manifest
  doesn't have them) will draw reviewer scrutiny, so justify it precisely:
  > "Firefox does not attach SameSite cookies to requests initiated by the
  > extension's own background page (its initiator is the moz-extension:// origin,
  > making the request cross-site), and a user logged in inside a container has
  > their Strava session in a non-default cookie store that background fetch cannot
  > use. Every credentialed request to Strava therefore fails with 403 / a redirect
  > to /login. The single blocking listener re-attaches the user's own Strava
  > cookies to the extension's own requests only (`tabId === -1` and an
  > `moz-extension://` originUrl), scoped to `*://*.strava.com/*`. It never touches
  > page requests and never reads or modifies any other site."
- **Source code**: no minifier or bundler, so no "source code submission" step —
  what you upload is what runs.
- **Host permissions**: Firefox 127+ prompts for `*.strava.com` at install, but users
  can revoke it later. The popup detects that and shows a **Grant access** button;
  the background worker returns `needPermission` and the content script toasts.
  Worth a sentence in the listing so it doesn't read as a bug.

## Notes / caveats to mention in the listing

- This is an independent project, **not affiliated with Strava or Mapy.com**.
- Uses Strava's heatmap the same way the Strava website does (your session); if
  Strava changes their endpoints it may need an update.
