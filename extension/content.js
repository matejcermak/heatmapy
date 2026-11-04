// Strava Heatmap for Mapy.cz — content script.
// Renders two composited tile layers over the Mapy map:
//   - GLOBAL per-sport heatmap (content-a.strava.com/identified/globalheat) in "hot"
//   - PERSONAL heatmap (personal-heatmaps-external.strava.com) recolored blue
// Cross-origin tiles are fetched (with your Strava cookies) by the service
// worker; this script handles geometry, caching, recolor, the on-map panel,
// and hotkeys. Adapted from the Tampermonkey userscript.
(function () {
    "use strict";

    // Promise-based extension APIs: `browser` in Firefox, `chrome` in Chrome MV3.
    // (Firefox also exposes a callback-only `chrome`, so don't use that one.)
    const api = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
    if (!api || !api.runtime || !api.runtime.id) {
        return; // not running as an extension content script
    }

    // ---- Config --------------------------------------------------------------
    const GLOBAL_HOST = "content-a.strava.com";
    const GLOBAL_COLOR = "hot";
    const GLOBAL_MAX_ZOOM = 15;
    const PERSONAL_HOST = "personal-heatmaps-external.strava.com";
    const PERSONAL_RGB = [30, 144, 255]; // dodger blue
    const PERSONAL_ALPHA_GAIN = 2.5;
    const PERSONAL_ALPHA_FLOOR = 90;
    const PERSONAL_ALPHA_THRESHOLD = 8;
    const SPORT_TOKEN = {
        mtb: "sport_MountainBikeRide",
        gravel: "sport_GravelRide",
        ride: "sport_Ride",
        run: "sport_Run",
        trail: "sport_TrailRun",
    };
    const SPORT_LABEL = { mtb: "MTB", gravel: "Gravel", ride: "Road", run: "Run", trail: "Trail" };
    const SPORT_ORDER = ["ride", "mtb", "gravel", "run", "trail"]; // Road, MTB, Gravel, Run, Trail Run
    const MIN_ZOOM = 0;
    const MAX_ZOOM = 22;
    const GLOBAL_TILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    const MEM_CACHE_MAX = 4000;
    const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
    const ADD_POINT_HINT = (IS_MAC ? "⌘-click" : "Ctrl-click") + " the map to add a route point";

    // ---- State ---------------------------------------------------------------
    let masterOff = false; // A: mute everything (the per-layer states are remembered)
    let globalSport = "mtb"; // shared discipline: "mtb" | "gravel" | "ride" | "run" (S cycles)
    let globalOn = true; // D: global heatmap layer on/off (independent)
    let personalOn = false; // F: personal heatmap layer on/off (independent)
    let opacity = 100;
    let panelMin = false; // panel collapsed to just its title row
    let athleteId = "";

    let overlayRoot = null;
    let panelRoot = null;
    let rafId = null;
    let pendingTiles = 0; // tiles currently fetching from the network (not cache)
    let loadingHideTimer = null;

    function clamp(v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    // Show a spinner in the panel while tiles are being fetched (first load is
    // slow until they're cached). Cache hits don't count, so it only spins on
    // real network activity.
    function updateLoading() {
        if (!panelRoot) {
            return;
        }
        const load = panelRoot.querySelector(".msh-load");
        if (!load) {
            return;
        }
        if (pendingTiles > 0) {
            if (loadingHideTimer) {
                clearTimeout(loadingHideTimer);
                loadingHideTimer = null;
            }
            load.classList.add("is-loading");
        } else if (!loadingHideTimer) {
            // brief debounce so it doesn't flicker between renders
            loadingHideTimer = window.setTimeout(() => {
                loadingHideTimer = null;
                if (pendingTiles === 0) {
                    load.classList.remove("is-loading");
                }
            }, 250);
        }
    }

    // ---- Persistence (localStorage on the mapy origin) -----------------------
    function lsGet(key, fallback) {
        try {
            const v = window.localStorage.getItem("mapyStrava:" + key);
            return v === null ? fallback : v;
        } catch (_) {
            return fallback;
        }
    }
    function lsSet(key, value) {
        try {
            window.localStorage.setItem("mapyStrava:" + key, String(value));
        } catch (_) {
            // ignore
        }
    }

    let legacyMode = lsGet("globalMode", "");
    if (legacyMode === "road") {
        legacyMode = "ride"; // migrate the old name
    }
    const storedSport = lsGet("globalSport", "");
    globalSport = SPORT_ORDER.includes(storedSport)
        ? storedSport
        : (SPORT_ORDER.includes(legacyMode) ? legacyMode : "mtb");
    masterOff = lsGet("masterOff", "") === "1" || legacyMode === "off";
    globalOn = lsGet("globalOn", "1") !== "0"; // default on (matches old always-on behavior)
    personalOn = lsGet("personalOn", "") === "1";
    opacity = clamp(parseInt(lsGet("opacity", "100"), 10) || 100, 0, 100);
    panelMin = lsGet("panelMin", "") === "1";

    // ---- Athlete id (for the personal heatmap) -------------------------------
    function applyAthleteId(id) {
        const next = String(id || "");
        if (next !== athleteId) {
            athleteId = next;
            requestRender();
            renderPanel();
        }
    }
    (async () => {
        try {
            const res = await api.storage.local.get("stravaAthleteId");
            if (res && res.stravaAthleteId) {
                applyAthleteId(res.stravaAthleteId);
            }
            // Ask the worker to (re)detect in the background.
            const r = await api.runtime.sendMessage({ type: "detectAthlete" });
            if (r && r.ok && r.athleteId) {
                applyAthleteId(r.athleteId);
            }
        } catch (_) {
            // ignore
        }
    })();
    try {
        api.storage.onChanged.addListener((changes, area) => {
            if (area === "local" && changes.stravaAthleteId) {
                applyAthleteId(changes.stravaAthleteId.newValue || "");
            }
        });
    } catch (_) {
        // ignore
    }

    // ---- Mapy map state ------------------------------------------------------
    function parseMapyState() {
        const url = new URL(window.location.href);
        const hash = window.location.hash.replace(/^#/, "");
        const candidates = [];
        const decimalDigits = (text) => {
            const m = String(text || "").match(/\.(\d+)/);
            return m ? m[1].length : 0;
        };
        const add = (z, y, x) => {
            const zoom = Number(z);
            const lat = Number(y);
            const lon = Number(x);
            if (!Number.isFinite(zoom) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
                return;
            }
            candidates.push({
                zoom,
                lat,
                lon,
                score: decimalDigits(z) + decimalDigits(y) + decimalDigits(x),
            });
        };
        add(url.searchParams.get("z"), url.searchParams.get("y"), url.searchParams.get("x"));
        const slash = hash.split("/");
        if (slash.length >= 3) {
            add(slash[0], slash[1], slash[2]);
        }
        const hp = new URLSearchParams(hash);
        add(hp.get("z"), hp.get("y"), hp.get("x"));
        if (!candidates.length) {
            return null;
        }
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];
        return { zoom: best.zoom, lat: best.lat, lon: best.lon };
    }

    function getMapViewportRect() {
        const canvases = Array.from(document.querySelectorAll("canvas"));
        let best = null;
        let bestArea = 0;
        for (const c of canvases) {
            const r = c.getBoundingClientRect();
            const area = Math.max(0, r.width) * Math.max(0, r.height);
            if (area > bestArea) {
                bestArea = area;
                best = c;
            }
        }
        const el = best || document.body;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, width: Math.max(0, r.width), height: Math.max(0, r.height) };
    }

    function lonToTileX(lon, zoom) {
        return ((lon + 180) / 360) * Math.pow(2, zoom);
    }
    function latToTileY(lat, zoom) {
        const rad = (lat * Math.PI) / 180;
        const n = Math.PI - Math.log(Math.tan(Math.PI / 4 + rad / 2));
        return (n / Math.PI / 2) * Math.pow(2, zoom);
    }

    // ---- Tile URLs -----------------------------------------------------------
    function wrapX(x, z) {
        const world = Math.pow(2, z);
        return ((x % world) + world) % world;
    }
    function buildGlobalUrl(sport, z, x, y) {
        const token = SPORT_TOKEN[sport] || SPORT_TOKEN.mtb;
        return (
            `https://${GLOBAL_HOST}/identified/globalheat/${token}/${GLOBAL_COLOR}/` +
            `${z}/${wrapX(x, z)}/${y}.png?v=19&missing=empty`
        );
    }
    function buildPersonalUrl(sport, z, x, y) {
        if (!athleteId) {
            return "";
        }
        const token = SPORT_TOKEN[sport] || SPORT_TOKEN.mtb;
        return (
            `https://${PERSONAL_HOST}/tiles/${athleteId}/grayscale/${z}/${wrapX(x, z)}/${y}.png` +
            `?missing=empty&filter_type=${token}&include_everyone=true&include_followers_only=true` +
            `&include_only_me=true&respect_privacy_zones=false&include_commutes=false`
        );
    }

    // ---- Caches --------------------------------------------------------------
    // A tile with no heat in it is cached as EMPTY_TILE so it's neither drawn
    // nor fetched again.
    const EMPTY_TILE = "empty";
    const memCache = new Map(); // url -> objectURL | EMPTY_TILE
    function memGet(url) {
        const v = memCache.get(url);
        if (v) {
            memCache.delete(url);
            memCache.set(url, v);
        }
        return v || "";
    }
    function memPut(url, objectUrl) {
        if (memCache.has(url)) {
            return;
        }
        memCache.set(url, objectUrl);
        while (memCache.size > MEM_CACHE_MAX) {
            const k = memCache.keys().next().value;
            const u = memCache.get(k);
            memCache.delete(k);
            if (u === EMPTY_TILE) {
                continue;
            }
            try {
                URL.revokeObjectURL(u);
            } catch (_) {
                // ignore
            }
        }
    }

    const DB_NAME = "mapyStravaTileCache";
    const DB_STORE = "tiles";
    // Bumped when what we store changes. v2: tiles pass through cleanGlobalTile
    // first; v1 entries may hold the opaque-black tiles from issue #9, so they
    // count as misses and get re-fetched (and overwritten).
    const TILE_CACHE_VERSION = 2;
    let dbPromise = null;
    function openDb() {
        if (dbPromise) {
            return dbPromise;
        }
        dbPromise = new Promise((resolve) => {
            let req;
            try {
                req = indexedDB.open(DB_NAME, 1);
            } catch (_) {
                resolve(null);
                return;
            }
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(DB_STORE)) {
                    db.createObjectStore(DB_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
        return dbPromise;
    }
    async function idbGet(url) {
        try {
            const db = await openDb();
            if (!db) {
                return null;
            }
            return await new Promise((resolve) => {
                const tx = db.transaction(DB_STORE, "readonly");
                const r = tx.objectStore(DB_STORE).get(url);
                r.onsuccess = () => resolve(r.result || null);
                r.onerror = () => resolve(null);
            });
        } catch (_) {
            return null;
        }
    }
    // blob = null stores "this tile is empty".
    function idbPut(url, blob) {
        (async () => {
            try {
                const db = await openDb();
                if (!db) {
                    return;
                }
                const tx = db.transaction(DB_STORE, "readwrite");
                tx.objectStore(DB_STORE).put(
                    { blob, empty: !blob, ts: Date.now(), v: TILE_CACHE_VERSION },
                    url
                );
            } catch (_) {
                // best-effort
            }
        })();
    }

    // ---- Tile fetch (via service worker, with Strava cookies) ----------------
    const STRAVA_HEATMAP_URL = "https://www.strava.com/maps/global-heatmap";
    // Tile 401/403s mean two different things, and they need different UI
    // (issues #2, #7 — a 9s toast was easy to miss, and with no Strava login
    // the extension looked simply broken):
    //  - no login at all -> NOTHING loads; show a persistent banner that stays
    //    until a tile actually loads (cleared in loadTile), with retries on
    //    tab focus so it disappears by itself right after the user logs in;
    //  - logged in without a subscription -> only detail past ~2 km scale and
    //    the personal heat are gated; a throttled transient toast is enough.
    let loginBanner = null;
    let subNotifiedAt = 0;
    // kind/z disambiguate a stored athleteId whose session has expired: a free
    // logged-in account CAN load global tiles at z<=11, so a global 401/403
    // there means the login itself is gone -> banner, not the sub toast.
    function noteAuthFailure(kind, z) {
        if (athleteId && (kind === "personal" || z > 11)) {
            const now = Date.now();
            if (now - subNotifiedAt < 60000) {
                return;
            }
            subNotifiedAt = now;
            toast(
                "Heatmap detail past ~2 km map scale (and the personal heatmap) " +
                "needs a Strava subscription — zoom out to keep the free global heat."
            );
            return;
        }
        showLoginBanner();
    }
    function showLoginBanner() {
        if (loginBanner) {
            return;
        }
        loginBanner = document.createElement("div");
        loginBanner.id = "msh-login-banner";
        loginBanner.innerHTML =
            '<button class="msh-login-banner__close" ' +
            'title="Hide and turn Heatmapy off (press A to turn it back on)">×</button>' +
            "<b>Heatmapy needs a Strava login</b>" +
            "Log in to Strava in this browser to load the heatmap. A free account " +
            "shows the global heat down to ~2&nbsp;km map scale; a subscription " +
            "unlocks full detail and your personal heatmap." +
            '<br><a href="' + STRAVA_HEATMAP_URL + '" target="_blank" rel="noopener noreferrer">' +
            "Log in on strava.com ↗</a>";
        loginBanner.querySelector(".msh-login-banner__close").addEventListener("click", () => {
            clearLoginBanner();
            if (!masterOff) {
                masterToggle(); // dismissing = "not now": stop fetching (and failing)
            }
        });
        document.body.appendChild(loginBanner);
    }
    function clearLoginBanner() {
        if (loginBanner) {
            loginBanner.remove();
            loginBanner = null;
        }
    }
    // The user logs in on strava.com in another tab and comes back: retry the
    // tiles so the banner clears on its own, no manual reload needed.
    function retryAfterLogin() {
        if (loginBanner && !document.hidden) {
            resetTiles();
            requestRender();
        }
    }
    document.addEventListener("visibilitychange", retryAfterLogin);
    window.addEventListener("focus", retryAfterLogin);
    // Firefox lets the user revoke the strava.com host permission at any time; the
    // background worker reports that back so we can say what to actually do.
    let permNotifiedAt = 0;
    function notePermissionMissing() {
        const now = Date.now();
        if (now - permNotifiedAt < 60000) {
            return;
        }
        permNotifiedAt = now;
        const el = document.createElement("div");
        el.className = "msh-toast";
        el.textContent =
            "Heatmapy needs permission to access strava.com — click the Heatmapy " +
            "toolbar icon and grant access, then reload this page.";
        positionToastAbovePanel(el);
        document.body.appendChild(el);
        window.setTimeout(() => el.remove(), 9000);
    }
    async function fetchTileViaSW(url) {
        let resp;
        try {
            resp = await api.runtime.sendMessage({ type: "fetchTile", url });
        } catch (_) {
            return { ok: false, status: 0 };
        }
        if (!resp) {
            return { ok: false, status: 0 };
        }
        if (resp.needPermission) {
            notePermissionMissing();
            return { ok: false, status: 0 };
        }
        if (resp.ok && resp.dataUrl) {
            try {
                const blob = await (await fetch(resp.dataUrl)).blob();
                return { ok: true, status: resp.status, blob };
            } catch (_) {
                return { ok: false, status: resp.status || 0 };
            }
        }
        return { ok: false, status: resp.status || 0 };
    }

    // ---- Tile pixels ---------------------------------------------------------
    // createImageBitmap(blob) is always origin-clean, so reading the pixels back
    // can't throw the way drawing an <img> from a blob: URL can.
    async function tilePixels(blob) {
        const bmp = await createImageBitmap(blob);
        const w = bmp.width || 256;
        const h = bmp.height || 256;
        let canvas;
        if (typeof OffscreenCanvas === "function") {
            canvas = new OffscreenCanvas(w, h);
        } else {
            canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
        }
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(bmp, 0, 0);
        if (bmp.close) {
            bmp.close();
        }
        return { canvas, ctx, data: ctx.getImageData(0, 0, w, h) };
    }
    function canvasToBlob(canvas) {
        if (canvas.convertToBlob) {
            return canvas.convertToBlob({ type: "image/png" });
        }
        return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    }

    // Personal tiles arrive opaque-black with grayscale heat; key black ->
    // transparent and paint the heat blue (alpha = boosted intensity).
    // Resolves to an objectURL, EMPTY_TILE, or "" on failure — never to the raw
    // tile, whose opaque black would cover the map.
    async function recolorToBlue(blob) {
        try {
            const { canvas, ctx, data } = await tilePixels(blob);
            const d = data.data;
            let any = false;
            for (let i = 0; i < d.length; i += 4) {
                const intensity = Math.max(d[i], d[i + 1], d[i + 2]);
                d[i] = PERSONAL_RGB[0];
                d[i + 1] = PERSONAL_RGB[1];
                d[i + 2] = PERSONAL_RGB[2];
                if (intensity <= PERSONAL_ALPHA_THRESHOLD) {
                    d[i + 3] = 0;
                } else {
                    d[i + 3] = Math.min(
                        255,
                        Math.round(intensity * PERSONAL_ALPHA_GAIN) + PERSONAL_ALPHA_FLOOR
                    );
                    any = true;
                }
            }
            if (!any) {
                return EMPTY_TILE;
            }
            ctx.putImageData(data, 0, 0);
            const out = await canvasToBlob(canvas);
            return out ? URL.createObjectURL(out) : "";
        } catch (_) {
            return "";
        }
    }

    // Global "hot" tiles have a transparent background, but some come back
    // opaque black instead — whole black squares over the map (issue #9,
    // reported with Trail Run). The hot palette has no black in it, so key
    // opaque near-black to transparent. Resolves to { blob }, or { empty: true }
    // when nothing visible is left.
    const OPAQUE_BLACK_MAX = 8;
    function isOpaqueBlack(d, i) {
        return d[i + 3] >= 250 &&
            d[i] <= OPAQUE_BLACK_MAX && d[i + 1] <= OPAQUE_BLACK_MAX && d[i + 2] <= OPAQUE_BLACK_MAX;
    }
    async function cleanGlobalTile(blob) {
        let px;
        try {
            px = await tilePixels(blob);
        } catch (_) {
            return { blob }; // can't inspect it — draw it as is, like before
        }
        const d = px.data.data;
        let black = 0;
        let heat = 0;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] === 0) {
                continue;
            }
            if (isOpaqueBlack(d, i)) {
                black += 1;
            } else {
                heat += 1;
            }
        }
        if (heat === 0) {
            return { empty: true };
        }
        if (black === 0) {
            return { blob }; // the normal case: keep Strava's bytes as they are
        }
        for (let i = 0; i < d.length; i += 4) {
            if (isOpaqueBlack(d, i)) {
                d[i + 3] = 0;
            }
        }
        px.ctx.putImageData(px.data, 0, 0);
        const out = await canvasToBlob(px.canvas);
        return out ? { blob: out } : { empty: true };
    }

    // ---- Tile loading --------------------------------------------------------
    // One job per URL, however many tiles are waiting on it. Jobs run a few at a
    // time, newest first — so after a fast pan the tiles now on screen load
    // before the ones you flew past, and a job whose tiles have all scrolled away
    // before its turn is dropped without a request.
    const MAX_TILE_JOBS = 8;
    const jobQueue = [];
    const jobsByUrl = new Map(); // url -> job (queued or running)
    let jobsRunning = 0;

    function tileUrl(kind, sport, z, x, y) {
        return kind === "personal" ? buildPersonalUrl(sport, z, x, y) : buildGlobalUrl(sport, z, x, y);
    }
    function jobWanted(job) {
        return job.tiles.some((t) => !t.dead);
    }
    function requestTile(layer, z, tile) {
        const url = tileUrl(layer.kind, layer.sport, z, tile.x, tile.y);
        if (!url) {
            tile.done = true;
            return;
        }
        const mem = memGet(url);
        if (mem) {
            showTile(tile, mem);
            return;
        }
        let job = jobsByUrl.get(url);
        if (!job) {
            job = { url, kind: layer.kind, z, tiles: [] };
            jobsByUrl.set(url, job);
            jobQueue.push(job);
        }
        job.tiles.push(tile);
        pumpJobs();
    }
    function pumpJobs() {
        while (jobsRunning < MAX_TILE_JOBS && jobQueue.length) {
            const job = jobQueue.pop();
            if (!jobWanted(job)) {
                jobsByUrl.delete(job.url);
                continue;
            }
            jobsRunning += 1;
            runJob(job).finally(() => {
                jobsRunning -= 1;
                pumpJobs();
            });
        }
    }
    async function runJob(job) {
        let value = "";
        try {
            value = (await loadTileData(job)) || "";
        } catch (_) {
            value = "";
        }
        jobsByUrl.delete(job.url);
        if (value) {
            memPut(job.url, value);
        }
        for (const t of job.tiles) {
            showTile(t, value);
        }
    }
    // Resolves to an objectURL, EMPTY_TILE, or "" (failed — nothing to draw).
    async function loadTileData(job) {
        const { url, kind, z } = job;
        if (kind === "global") {
            const hit = await idbGet(url);
            if (
                hit && hit.v === TILE_CACHE_VERSION &&
                Date.now() - (hit.ts || 0) < GLOBAL_TILE_TTL_MS &&
                (hit.empty || hit.blob)
            ) {
                return hit.empty ? EMPTY_TILE : URL.createObjectURL(hit.blob);
            }
        }
        if (!jobWanted(job)) {
            return ""; // scrolled away while we checked the cache
        }
        // From here it's a real network fetch -> reflect it in the spinner.
        pendingTiles += 1;
        updateLoading();
        try {
            const res = await fetchTileViaSW(url);
            if (!res.ok || !res.blob) {
                if (res.status === 401 || res.status === 403) {
                    noteAuthFailure(kind, z);
                }
                return "";
            }
            // A tile came back over the network -> the Strava session works
            // (logged out, every tile 403s), so the login nag is done.
            clearLoginBanner();
            if (kind === "personal") {
                return await recolorToBlue(res.blob);
            }
            const clean = await cleanGlobalTile(res.blob);
            idbPut(url, clean.empty ? null : clean.blob);
            return clean.empty ? EMPTY_TILE : URL.createObjectURL(clean.blob);
        } finally {
            pendingTiles -= 1;
            updateLoading();
        }
    }
    function showTile(tile, value) {
        if (tile.dead) {
            return;
        }
        if (value && value !== EMPTY_TILE) {
            tile.img.src = value; // done once it decodes (see addTile)
        } else {
            tile.done = true;
        }
    }

    // ---- Overlay: tile layers that follow the camera ---------------------------
    // Each layer (global, personal) keeps one <div> per tile zoom level, holding
    // 256px <img> tiles laid out in that level's own pixel grid. Following the
    // map is then just one CSS transform per level per frame: tiles are created
    // once and reused while you pan, zoom or rotate, rather than rebuilt on every
    // move. The previous level stays underneath until the new one has loaded,
    // so crossing a zoom level doesn't blank the heat.
    const TILE = 256;
    const TILE_MARGIN = 1; // extra ring of tiles around the view: prefetch, less churn
    const MAX_TILES_PER_LEVEL = 600; // sanity cap on a degenerate view
    const MAX_TILT_DEG = 1; // a tilted (perspective) map can't be matched by a flat overlay
    const tileLayers = { global: null, personal: null };

    function createTileLayer(kind) {
        const el = document.createElement("div");
        Object.assign(el.style, { position: "absolute", inset: "0", overflow: "hidden" });
        return { kind, el, sport: "", athlete: "", levels: new Map() }; // z -> level
    }

    function createLevel(layer, z, ox, oy) {
        const el = document.createElement("div");
        Object.assign(el.style, {
            position: "absolute",
            left: "0px",
            top: "0px",
            width: "0px",
            height: "0px",
            transformOrigin: "0 0",
            willChange: "transform",
        });
        el.dataset.z = String(z);
        layer.el.appendChild(el); // newest level on top
        // Tiles sit at (x - ox, y - oy) * 256, i.e. relative to a tile near where
        // the level was created — absolute pixel offsets at z15 run into the
        // millions, which is beyond what CSS transforms place precisely.
        const level = { z, ox, oy, el, tiles: new Map(), transform: "" };
        layer.levels.set(z, level);
        return level;
    }

    function removeLevel(layer, level) {
        for (const t of level.tiles.values()) {
            t.dead = true;
        }
        level.tiles.clear();
        level.el.remove();
        layer.levels.delete(level.z);
    }

    function resetTileLayer(layer) {
        for (const level of Array.from(layer.levels.values())) {
            removeLevel(layer, level);
        }
    }

    // Drop every tile so they're requested again (e.g. after logging in).
    function resetTiles() {
        for (const layer of Object.values(tileLayers)) {
            if (layer) {
                resetTileLayer(layer);
            }
        }
    }

    function addTile(layer, level, x, y) {
        const img = document.createElement("img");
        img.alt = "";
        img.draggable = false;
        img.decoding = "async";
        Object.assign(img.style, {
            position: "absolute",
            left: `${(x - level.ox) * TILE}px`,
            top: `${(y - level.oy) * TILE}px`,
            width: `${TILE}px`,
            height: `${TILE}px`,
            userSelect: "none",
            visibility: "hidden", // until it has decoded
        });
        const tile = { img, x, y, done: false, dead: false };
        img.onload = () => {
            img.style.visibility = "";
            tile.done = true;
        };
        img.onerror = () => {
            tile.done = true;
        };
        level.tiles.set(`${x}/${y}`, tile);
        level.el.appendChild(img);
        requestTile(layer, level.z, tile);
    }

    // World pixel position of the view centre at tile zoom z.
    function centerWorldPx(view, z) {
        return { x: lonToTileX(view.lon, z) * TILE, y: latToTileY(view.lat, z) * TILE };
    }

    // Lay a level out under the camera: rotate + scale about the view centre.
    function placeLevel(level, view) {
        const s = Math.pow(2, view.zoom - level.z);
        const c = centerWorldPx(view, level.z);
        const ux = c.x - level.ox * TILE;
        const uy = c.y - level.oy * TILE;
        const a = Math.cos(view.rot) * s;
        const b = Math.sin(view.rot) * s;
        const e = view.cx - view.left - (a * ux - b * uy);
        const f = view.cy - view.top - (b * ux + a * uy);
        const t = `matrix(${a}, ${b}, ${-b}, ${a}, ${e}, ${f})`;
        if (t !== level.transform) {
            level.transform = t;
            level.el.style.transform = t;
        }
    }

    // Tile index range covering the view at zoom z (rotation-aware), widened by
    // `margin` tiles on each side.
    function tileRange(view, z, margin) {
        const s = Math.pow(2, view.zoom - z);
        const c = centerWorldPx(view, z);
        const cos = Math.cos(view.rot);
        const sin = Math.sin(view.rot);
        const ox = view.cx - view.left;
        const oy = view.cy - view.top;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const [px, py] of [[0, 0], [view.width, 0], [0, view.height], [view.width, view.height]]) {
            // screen -> world: undo the rotation, then the scale
            const dx = px - ox;
            const dy = py - oy;
            const wx = c.x + (cos * dx + sin * dy) / s;
            const wy = c.y + (-sin * dx + cos * dy) / s;
            minX = Math.min(minX, wx);
            maxX = Math.max(maxX, wx);
            minY = Math.min(minY, wy);
            maxY = Math.max(maxY, wy);
        }
        const maxTile = Math.pow(2, z) - 1;
        return {
            x0: Math.floor(minX / TILE) - margin,
            x1: Math.floor(maxX / TILE) + margin,
            y0: Math.max(0, Math.floor(minY / TILE) - margin),
            y1: Math.min(maxTile, Math.floor(maxY / TILE) + margin),
        };
    }
    function inRange(r, x, y) {
        return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
    }

    function updateTileLayer(layer, view) {
        if (layer.sport !== globalSport || layer.athlete !== athleteId) {
            resetTileLayer(layer); // different tiles altogether
            layer.sport = globalSport;
            layer.athlete = athleteId;
        }
        const z = clamp(Math.floor(view.zoom + 1e-6), MIN_ZOOM, GLOBAL_MAX_ZOOM);
        const c = centerWorldPx(view, z);
        let target = layer.levels.get(z);
        // Re-anchor a level we've panned very far across (keeps offsets small).
        if (target && Math.max(Math.abs(c.x / TILE - target.ox), Math.abs(c.y / TILE - target.oy)) > 4096) {
            removeLevel(layer, target);
            target = null;
        }
        if (!target) {
            target = createLevel(layer, z, Math.floor(c.x / TILE), Math.floor(c.y / TILE));
        } else if (layer.el.lastChild !== target.el) {
            layer.el.appendChild(target.el); // back on top
        }

        // Target level: keep exactly the tiles in view (+ margin), add missing ones
        // centre-last so they're fetched first (jobs run newest first).
        const keep = tileRange(view, z, TILE_MARGIN);
        for (const [key, t] of target.tiles) {
            if (!inRange(keep, t.x, t.y)) {
                t.dead = true;
                t.img.remove();
                target.tiles.delete(key);
            }
        }
        if ((keep.x1 - keep.x0 + 1) * (keep.y1 - keep.y0 + 1) <= MAX_TILES_PER_LEVEL) {
            const cx = c.x / TILE;
            const cy = c.y / TILE;
            const missing = [];
            for (let y = keep.y0; y <= keep.y1; y += 1) {
                for (let x = keep.x0; x <= keep.x1; x += 1) {
                    if (!target.tiles.has(`${x}/${y}`)) {
                        missing.push([x, y, (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2]);
                    }
                }
            }
            missing.sort((p, q) => q[2] - p[2]);
            for (const [x, y] of missing) {
                addTile(layer, target, x, y);
            }
        }

        // Older levels are only a stand-in while the target loads: drop their
        // off-screen tiles, and drop them entirely once the target covers the view.
        const visible = tileRange(view, z, 0);
        let ready = true;
        for (const t of target.tiles.values()) {
            if (!t.done && inRange(visible, t.x, t.y)) {
                ready = false;
                break;
            }
        }
        for (const level of Array.from(layer.levels.values())) {
            if (level === target) {
                continue;
            }
            if (ready || Math.abs(level.z - z) > 2) {
                removeLevel(layer, level);
                continue;
            }
            const r = tileRange(view, level.z, 0);
            for (const [key, t] of level.tiles) {
                if (!inRange(r, t.x, t.y)) {
                    t.dead = true;
                    t.img.remove();
                    level.tiles.delete(key);
                }
            }
            if (!level.tiles.size) {
                removeLevel(layer, level);
            }
        }
        for (const level of layer.levels.values()) {
            placeLevel(level, view);
        }
    }

    function ensureElements() {
        if (!overlayRoot) {
            overlayRoot = document.createElement("div");
            overlayRoot.id = "msh-overlay-root";
            Object.assign(overlayRoot.style, {
                position: "fixed",
                left: "0px",
                top: "0px",
                width: "0px",
                height: "0px",
                pointerEvents: "none",
                // Above Mapy's tile canvas (whose container is z-index 1) but
                // below all Mapy UI: controls/dialog covers sit at z 300-302,
                // so the heat never covers a dialog (issue #4) or the controls.
                zIndex: "2",
                opacity: String(clamp(opacity / 100, 0, 1)),
                display: "block",
            });
            document.body.appendChild(overlayRoot);
        }
        if (!tileLayers.global) {
            tileLayers.global = createTileLayer("global");
            overlayRoot.appendChild(tileLayers.global.el);
        }
        if (!tileLayers.personal) {
            tileLayers.personal = createTileLayer("personal");
            overlayRoot.appendChild(tileLayers.personal.el); // on top of global
        }
        ensurePanel();
    }

    function getActiveLayers() {
        if (masterOff) {
            return [];
        }
        const layers = [];
        if (globalOn) {
            layers.push({ kind: "global", sport: globalSport });
        }
        if (personalOn && athleteId) {
            layers.push({ kind: "personal", sport: globalSport });
        }
        return layers;
    }

    // ---- Camera --------------------------------------------------------------
    // Primary source: the live camera mapy-hook.js reads from Mapy's map engine
    // every frame, so the heat moves with the map during a drag, a zoom
    // animation, inertia or rotation. Fallback (engine not found, or the feed
    // went quiet): the x/y/z Mapy writes into the URL once a move has finished.
    const LIVE_CAMERA_STALE_MS = 2500; // the hook re-sends at least every 1 s
    let liveCamera = null;
    let liveCameraAt = 0;
    document.addEventListener("msh-camera", (event) => {
        let cam = null;
        try {
            cam = JSON.parse(event.detail);
        } catch (_) {
            return;
        }
        if (!cam || !Number.isFinite(cam.zoom) || !Number.isFinite(cam.lon) || !Number.isFinite(cam.lat)) {
            return;
        }
        liveCamera = cam;
        liveCameraAt = Date.now();
        render(); // synchronously, in the frame the hook read the camera
    });

    function currentView() {
        // Mapy's 3D view is a separate engine; the 2D one collapses its canvas
        // meanwhile. A flat heatmap can't follow a perspective globe, so hide it.
        const wasmCanvas = document.getElementById("wasm-canvas");
        if (wasmCanvas) {
            const r = wasmCanvas.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) {
                return { hidden: true };
            }
        }
        if (liveCamera && Date.now() - liveCameraAt < LIVE_CAMERA_STALE_MS) {
            return liveCamera;
        }
        const state = parseMapyState();
        if (!state) {
            return null;
        }
        const rect = getMapViewportRect();
        return {
            lon: state.lon,
            lat: state.lat,
            zoom: state.zoom,
            rot: 0,
            tilt: 0,
            cx: rect.left + rect.width / 2,
            cy: rect.top + rect.height / 2,
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
        };
    }

    function render() {
        ensureElements();
        const raw = currentView();
        const active = raw ? getActiveLayers() : [];
        if (active.length === 0) {
            // Nothing active (e.g. A turned both off): hide + free old tiles.
            overlayRoot.style.display = "none";
            resetTiles();
            return;
        }
        if (raw.hidden || raw.tilt > MAX_TILT_DEG || !(raw.width > 0) || !(raw.height > 0)) {
            overlayRoot.style.display = "none"; // keep the tiles for when it's flat again
            return;
        }
        const view = Object.assign({}, raw, { zoom: clamp(raw.zoom, MIN_ZOOM, MAX_ZOOM) });
        overlayRoot.style.display = "block";
        overlayRoot.style.opacity = String(clamp(opacity / 100, 0, 1));
        overlayRoot.style.left = `${view.left}px`;
        overlayRoot.style.top = `${view.top}px`;
        overlayRoot.style.width = `${view.width}px`;
        overlayRoot.style.height = `${view.height}px`;
        for (const kind of ["global", "personal"]) {
            const layer = tileLayers[kind];
            if (active.some((l) => l.kind === kind)) {
                updateTileLayer(layer, view);
            } else if (layer.levels.size) {
                resetTileLayer(layer);
            }
        }
    }

    function requestRender() {
        if (rafId !== null) {
            return;
        }
        rafId = requestAnimationFrame(() => {
            rafId = null;
            render();
        });
    }

    // ---- On-map control panel ------------------------------------------------
    function ensurePanel() {
        if (panelRoot) {
            return;
        }
        panelRoot = document.createElement("div");
        panelRoot.id = "msh-panel";
        panelRoot.innerHTML = [
            '<div class="msh-title">' +
            '<svg class="msh-logo" viewBox="0 0 40 40" aria-hidden="true">' +
            '<rect width="40" height="40" rx="11" fill="#15151a"/>' +
            '<path d="M7 27C16 20 17 12 24 10 31 8 33 19 38 13" fill="none" stroke="#fc5200" stroke-width="4.5" stroke-linecap="round"/>' +
            '<path d="M6 33C16 30 22 22 28 23 34 24 35 31 39 29" fill="none" stroke="#1e90ff" stroke-width="3.4" stroke-linecap="round"/>' +
            "</svg>" +
            "Heatmapy" +
            '<span class="msh-load" aria-hidden="true"><span class="msh-spin"></span><span class="msh-loadlabel">loading…</span></span>' +
            '<button class="msh-master-btn" data-act="master" title="Toggle all heatmaps (A)" aria-label="Toggle all heatmaps"><kbd class="msh-key">A</kbd><span class="msh-power">⏻</span></button>' +
            '<button class="msh-min-btn" data-act="min">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>' +
            "</button>" +
            "</div>",
            '<div class="msh-row msh-sport" role="group" aria-label="Sport">',
            '<kbd class="msh-key">S</kbd>',
            SPORT_ORDER.map((s) =>
                '<button class="msh-seg" data-sport="' + s + '">' + SPORT_LABEL[s] + "</button>"
            ).join(""),
            "</div>",
            '<div class="msh-row msh-row--layers">',
            '  <span class="msh-layer">',
            '    <kbd class="msh-key">D</kbd>',
            '    <span class="msh-switch msh-switch--global" data-act="global" role="switch" tabindex="0"><span class="msh-knob"></span></span>',
            '    <span class="msh-toggle-label msh-label--global">Global</span>',
            "  </span>",
            '  <span class="msh-layer">',
            '    <kbd class="msh-key">F</kbd>',
            '    <span class="msh-switch msh-switch--personal" data-act="personal" role="switch" tabindex="0"><span class="msh-knob"></span></span>',
            '    <span class="msh-toggle-label msh-label--personal">Personal</span>',
            "  </span>",
            "</div>",
            '<div class="msh-row msh-op">',
            '  <span class="msh-eye" aria-hidden="true" title="Heatmap opacity">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>' +
            "</span>",
            '  <input class="msh-slider" type="range" min="0" max="100" step="10" aria-label="Heatmap opacity" />',
            "</div>",
            '<div class="msh-row msh-actions">',
            '  <button class="msh-send" data-act="send">',
            '    <span class="msh-send-label">Sync to Strava</span>',
            '    <svg class="msh-send-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="6" width="10" height="12" rx="3"/><path d="M9 6V3.5h6V6M9 18v2.5h6V18"/><path d="M12 9.8v2.3l1.4.9"/></svg>',
            '    <svg class="msh-send-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="4" width="12" height="16" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/></svg>',
            "  </button>",
            '  <button class="msh-export" data-act="export" title="Download GPX">⬇</button>',
            "</div>",
            '<div class="msh-hint"></div>',
        ].join("");
        document.body.appendChild(panelRoot);

        panelRoot.querySelector('[data-act="master"]').addEventListener("click", masterToggle);
        panelRoot.querySelector('[data-act="min"]').addEventListener("click", togglePanelMin);
        panelRoot.querySelector('[data-act="global"]').addEventListener("click", toggleGlobal);
        panelRoot.querySelector('[data-act="personal"]').addEventListener("click", togglePersonal);
        panelRoot.querySelector('[data-act="export"]').addEventListener("click", exportRoute);
        panelRoot.querySelector('[data-act="send"]').addEventListener("click", sendRouteToStrava);
        panelRoot.querySelectorAll(".msh-seg").forEach((b) =>
            b.addEventListener("click", () => setSport(b.getAttribute("data-sport")))
        );
        const slider = panelRoot.querySelector(".msh-slider");
        slider.value = String(opacity);
        slider.addEventListener("input", (e) => setOpacity(parseInt(e.target.value, 10)));
        renderPanel();
        layoutPanel();
    }

    function renderPanel() {
        if (!panelRoot) {
            return;
        }
        const master = panelRoot.querySelector('[data-act="master"]');
        const min = panelRoot.querySelector('[data-act="min"]');
        const g = panelRoot.querySelector('[data-act="global"]');
        const p = panelRoot.querySelector('[data-act="personal"]');
        const hint = panelRoot.querySelector(".msh-hint");
        panelRoot.classList.toggle("msh-panel--min", panelMin);
        if (min) {
            const label = panelMin ? "Expand panel" : "Minimize panel";
            min.title = label;
            min.setAttribute("aria-label", label);
            min.setAttribute("aria-expanded", panelMin ? "false" : "true");
        }
        if (master) {
            master.classList.toggle("msh-master--off", masterOff);
        }
        panelRoot.querySelectorAll(".msh-seg").forEach((b) => {
            b.classList.toggle("msh-seg--active", b.getAttribute("data-sport") === globalSport);
        });
        if (g) {
            g.classList.toggle("msh-switch--on", globalOn && !masterOff);
        }
        if (p) {
            p.classList.toggle("msh-switch--on", personalOn && !masterOff);
        }
        const slider = panelRoot.querySelector(".msh-slider");
        if (slider) {
            slider.value = String(opacity);
        }
        if (hint) {
            const login = athleteId
                ? ""
                : '<a href="' + STRAVA_HEATMAP_URL + '" target="_blank" rel="noopener">Log in to Strava ↗</a> to enable personal · ';
            hint.innerHTML = login + ADD_POINT_HINT;
        }
    }

    // ---- Actions -------------------------------------------------------------
    // "S" — cycle the shared discipline (both layers follow it). Never turns layers off.
    function cycleSport() {
        const i = SPORT_ORDER.indexOf(globalSport);
        setSport(SPORT_ORDER[(i + 1) % SPORT_ORDER.length]);
    }
    function setSport(sport) {
        if (!SPORT_ORDER.includes(sport)) {
            return;
        }
        globalSport = sport;
        lsSet("globalSport", globalSport);
        renderPanel();
        requestRender();
    }
    // "D" — global heatmap on/off (independent). Toggling while muted un-mutes onto it.
    function toggleGlobal() {
        if (masterOff) {
            masterOff = false;
            globalOn = true;
        } else {
            globalOn = !globalOn;
        }
        lsSet("globalOn", globalOn ? "1" : "0");
        lsSet("masterOff", masterOff ? "1" : "0");
        renderPanel();
        requestRender();
    }
    // "F" — personal heatmap on/off (independent).
    function togglePersonal() {
        if (masterOff) {
            masterOff = false;
            personalOn = true;
        } else {
            personalOn = !personalOn;
        }
        lsSet("personalOn", personalOn ? "1" : "0");
        lsSet("masterOff", masterOff ? "1" : "0");
        if (personalOn && !athleteId) {
            toast("Personal heatmap: log in to Strava (Subscriber) and reload to enable.");
        }
        renderPanel();
        requestRender();
    }
    // "G" — flip Mapy's base map between aerial and the map you were on (outdoor), by
    // pressing Mapy's own "Aerial" control. A plain click on the host element is enough;
    // match on its class, since the aria-label is translated ("Aerial" / "Letecká").
    function toggleAerial() {
        const btn = document.querySelector("mapy-map-toggle.map-controls__ophoto");
        if (btn) {
            btn.click();
        } else {
            toast("Couldn't find Mapy's Aerial button.");
        }
    }
    // "A" = master mute: hide every layer (per-layer choices remembered) or restore them.
    function masterToggle() {
        masterOff = !masterOff;
        lsSet("masterOff", masterOff ? "1" : "0");
        renderPanel();
        requestRender();
    }
    // Collapse the panel to its title row (logo + master toggle) so it stays out
    // of the way while browsing; the layers keep rendering — issue #9.
    function togglePanelMin() {
        panelMin = !panelMin;
        lsSet("panelMin", panelMin ? "1" : "0");
        renderPanel();
    }
    function setOpacity(v) {
        opacity = clamp(v || 0, 0, 100);
        lsSet("opacity", opacity);
        if (overlayRoot) {
            overlayRoot.style.opacity = String(opacity / 100);
        }
        renderPanel();
    }

    // ---- Route export (GPX) --------------------------------------------------
    // Drives Mapy.com's own planner Export → GPX UI so Mapy generates and
    // downloads the file itself. (Content scripts can't hook Mapy's network like
    // the userscript did, so this is purely DOM-driven.)
    function elementIsClickable(el) {
        if (!el) {
            return false;
        }
        const style = window.getComputedStyle(el);
        if (!style || style.display === "none" || style.visibility === "hidden") {
            return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }
    function simulateUserClick(el) {
        if (!el) {
            return false;
        }
        try {
            el.scrollIntoView({ block: "center", inline: "center" });
        } catch (_) { /* ignore */ }
        try {
            const rect = el.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            const under = document.elementFromPoint(x, y);
            const secondary = under && under !== el ? under : null;
            const mkMouse = (type) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
            const mkPointer = (type) =>
                typeof PointerEvent === "function"
                    ? new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y })
                    : null;
            // Pointer/mouse sequence WITHOUT a synthetic "click" — the actual click
            // comes from el.click() below. Dispatching both fired the handler twice
            // (e.g. Mapy downloaded the GPX twice).
            const events = [mkPointer("pointerdown"), mkMouse("mousedown"), mkPointer("pointerup"), mkMouse("mouseup")].filter(Boolean);
            for (const ev of events) {
                el.dispatchEvent(ev);
                if (secondary) {
                    secondary.dispatchEvent(ev);
                }
            }
        } catch (_) { /* ignore */ }
        try {
            el.click();
        } catch (_) { /* ignore */ }
        return true;
    }
    function clickFirstElementByText(needles) {
        const norm = (Array.isArray(needles) ? needles : [needles]).map((t) => String(t || "").toLowerCase()).filter(Boolean);
        if (!norm.length) {
            return false;
        }
        const candidates = Array.from(document.querySelectorAll("button, a, [role='button'], [type='button']"));
        for (const el of candidates) {
            if (!elementIsClickable(el)) {
                continue;
            }
            const text = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`.toLowerCase();
            if (text.trim() && norm.some((n) => text.includes(n))) {
                simulateUserClick(el);
                return true;
            }
        }
        return false;
    }
    function clickMapyExportButton() {
        const direct = document.querySelector("div.icon-action[title='Export'] button");
        if (elementIsClickable(direct)) {
            simulateUserClick(direct);
            return true;
        }
        const alt = document.querySelector("div.icon-action[title='Exportovat'] button")
            || document.querySelector("div.icon-action[title='Stahnout'] button");
        if (elementIsClickable(alt)) {
            simulateUserClick(alt);
            return true;
        }
        return clickFirstElementByText(["export", "exportovat", "download", "stáhnout", "stahnout"]);
    }
    function clickMapyExportDialogSave() {
        const span = document.querySelector("span.mymaps-dialog__saveBtnText");
        const btn = document.querySelector("button.mymaps-dialog__saveBtn") || (span ? span.closest("button,[role='button'],a") : null);
        if (elementIsClickable(btn)) {
            simulateUserClick(btn);
            return true;
        }
        if (elementIsClickable(span)) {
            simulateUserClick(span);
            return true;
        }
        return false;
    }
    async function waitForElement(selector, timeoutMs) {
        const start = Date.now();
        while (Date.now() - start < (timeoutMs || 1500)) {
            const el = document.querySelector(selector);
            if (el) {
                return el;
            }
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => window.setTimeout(r, 50));
        }
        return null;
    }
    let exportBusy = false;
    async function exportRoute() {
        if (exportBusy) {
            return;
        }
        exportBusy = true;
        try {
            if (!clickMapyExportButton()) {
                toast("Plan a route on Mapy first (⌘/Ctrl-click to add points), then Export.");
                return;
            }
            const dialog = await waitForElement("button.mymaps-dialog__saveBtn, span.mymaps-dialog__saveBtnText", 1500);
            if (!dialog) {
                toast("Couldn't open Mapy's export dialog — plan a route first, then try again.");
                return;
            }
            await new Promise((r) => window.setTimeout(r, 150));
            if (clickMapyExportDialogSave()) {
                toast("Exporting route GPX from Mapy — import it into Garmin Connect or the Wahoo app.");
            } else {
                toast("Opened Mapy's export — pick GPX to download.");
            }
        } finally {
            window.setTimeout(() => { exportBusy = false; }, 800);
        }
    }

    // ---- Send route to Strava ------------------------------------------------
    // The MAIN-world hook (mapy-hook.js) posts the planner's GPX export URL here.
    let mapyExportUrlWaiter = null;
    window.addEventListener("message", (e) => {
        if (e.source !== window || !e.data || e.data.source !== "msh-mapy-export") {
            return;
        }
        const url = String(e.data.url || "");
        if (url && mapyExportUrlWaiter) {
            mapyExportUrlWaiter(url);
            mapyExportUrlWaiter = null;
        }
    });
    function awaitMapyExportUrl(timeoutMs) {
        return new Promise((resolve) => {
            let done = false;
            mapyExportUrlWaiter = (u) => { if (!done) { done = true; resolve(u); } };
            window.setTimeout(() => {
                if (!done) { done = true; mapyExportUrlWaiter = null; resolve(""); }
            }, timeoutMs || 5000);
        });
    }
    // Drive Mapy's export so it fetches the GPX URL (captured by the hook), then
    // fetch that URL ourselves (same-origin, with cookies) to get the GPX text.
    async function getMapyGpxText() {
        if (!clickMapyExportButton()) {
            return { ok: false, error: "no-route" };
        }
        const dialog = await waitForElement("button.mymaps-dialog__saveBtn, span.mymaps-dialog__saveBtnText", 1500);
        if (!dialog) {
            return { ok: false, error: "no-dialog" };
        }
        const urlPromise = awaitMapyExportUrl(5000);
        await new Promise((r) => window.setTimeout(r, 150));
        clickMapyExportDialogSave();
        const url = await urlPromise;
        if (!url) {
            return { ok: false, error: "no-url" };
        }
        try {
            const resp = await fetch(url, { credentials: "include" });
            if (!resp.ok) {
                return { ok: false, error: "fetch-" + resp.status };
            }
            const gpx = await resp.text();
            if (!gpx || gpx.indexOf("<gpx") === -1) {
                return { ok: false, error: "bad-gpx" };
            }
            return { ok: true, gpx };
        } catch (err) {
            return { ok: false, error: String(err && err.message ? err.message : err) };
        }
    }
    // Build the Strava route name: local-time timestamp + Mapy's own export name.
    // Mapy writes that name as the GPX track name (<trk><name>…</name>) — the same
    // text shown in its Save dialog and the page <title>.
    function decodeXmlEntities(s) {
        return String(s)
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
            .replace(/&amp;/g, "&");
    }
    function mapyRouteName(gpx) {
        if (!gpx) {
            return "";
        }
        const m =
            gpx.match(/<trk\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/i) ||
            gpx.match(/<name>([\s\S]*?)<\/name>/i);
        return m ? decodeXmlEntities(m[1]).trim() : "";
    }
    function composeRouteName(gpx) {
        const d = new Date();
        const p = (n) => String(n).padStart(2, "0");
        const ts =
            d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
            " " + p(d.getHours()) + ":" + p(d.getMinutes());
        const name = mapyRouteName(gpx);
        // Strava caps route names at 200 chars.
        return (name ? ts + " " + name : ts).slice(0, 200);
    }
    let sendBusy = false;
    async function sendRouteToStrava() {
        if (sendBusy) {
            return;
        }
        sendBusy = true;
        const btn = panelRoot && panelRoot.querySelector('[data-act="send"]');
        const restore = btn ? btn.innerHTML : "";
        if (btn) { btn.textContent = "Syncing…"; btn.disabled = true; }
        try {
            toast("Preparing route from Mapy…");
            const g = await getMapyGpxText();
            if (!g.ok) {
                toast("Couldn't get the route — plan one on Mapy first (⌘/Ctrl-click to add points), then try again.");
                return;
            }
            const res = await api.runtime.sendMessage({
                type: "uploadStravaRoute",
                gpx: g.gpx,
                name: composeRouteName(g.gpx),
                sport: globalSport,
            });
            if (res && res.ok) {
                toast("Synced to Strava ✓ (starred) — it'll appear on your connected Garmin/Wahoo on the next device sync.");
            } else if (res && res.needPermission) {
                toast("Heatmapy needs permission to access strava.com — click the Heatmapy toolbar icon and grant access.");
            } else if (res && res.needLogin) {
                toast("Log in to Strava (Subscriber) in this browser to send routes.");
            } else {
                toast("Strava upload failed" + (res && res.error ? " (" + res.error + ")" : "") + ". The ⬇ GPX download still works.");
            }
        } catch (err) {
            toast("Send failed: " + String(err && err.message ? err.message : err));
        } finally {
            if (btn) { btn.innerHTML = restore; btn.disabled = false; }
            window.setTimeout(() => { sendBusy = false; }, 800);
        }
    }

    // ---- Keep clear of Mapy's elevation profile -------------------------------
    // Mapy's route elevation profile ("Výškový profil") is a full-width drawer
    // along the bottom of the map, inside Mapy's controls layer (z 301) — above
    // the panel. While it's open, lift the panel to just above it. Closed, the
    // drawer collapses to zero height at the bottom edge, so its rect alone
    // tells us whether it's open — issue #11.
    const PANEL_MIN_BOTTOM = 12;
    const PANEL_GAP = 8;
    let profileObserver = null;
    let observedProfile = null;

    function profileDrawerTop() {
        const drawer = document.querySelector(".mapDrawer__container");
        if (drawer !== observedProfile) {
            // Mapy may re-create the drawer; follow its open/close animation.
            if (profileObserver) {
                profileObserver.disconnect();
            }
            observedProfile = drawer;
            if (drawer && typeof ResizeObserver === "function") {
                profileObserver = profileObserver || new ResizeObserver(layoutPanel);
                profileObserver.observe(drawer);
            }
        }
        if (!drawer) {
            return null;
        }
        const r = drawer.getBoundingClientRect();
        const p = panelRoot.getBoundingClientRect();
        if (r.height < 1 || r.top >= window.innerHeight || r.left >= p.right || r.right <= p.left) {
            return null;
        }
        // Mapy moves its scale bar + attribution up to sit on the open drawer;
        // clear those too.
        let top = r.top;
        const scale = document.querySelector(".bottom-left-controls");
        if (scale) {
            const s = scale.getBoundingClientRect();
            if (s.height > 0 && s.left < p.right && s.right > p.left) {
                top = Math.min(top, s.top);
            }
        }
        return top;
    }

    function layoutPanel() {
        if (!panelRoot) {
            return;
        }
        const top = profileDrawerTop();
        let bottom = "";
        if (top !== null) {
            // Never push the panel off the top of a short window; overlapping the
            // drawer beats losing the panel's top row.
            const h = panelRoot.offsetHeight || 0;
            const lifted = window.innerHeight - top + PANEL_GAP;
            bottom = Math.max(PANEL_MIN_BOTTOM, Math.min(lifted, window.innerHeight - h - PANEL_MIN_BOTTOM)) + "px";
        }
        if (panelRoot.style.bottom !== bottom) {
            panelRoot.style.bottom = bottom; // "" falls back to the stylesheet
        }
    }

    // ---- Toast ---------------------------------------------------------------
    // The panel's height and position are dynamic, so pin the toast just above
    // where it actually is rather than a fixed offset the panel would overlap.
    function positionToastAbovePanel(el) {
        const panel = panelRoot || document.getElementById("msh-panel");
        if (!panel) {
            return;
        }
        const top = panel.getBoundingClientRect().top;
        if (top) {
            el.style.bottom = window.innerHeight - top + PANEL_GAP + "px";
        }
    }
    function toast(message) {
        const text = String(message || "");
        if (!text) {
            return;
        }
        const el = document.createElement("div");
        el.className = "msh-toast";
        el.textContent = text;
        positionToastAbovePanel(el);
        document.body.appendChild(el);
        window.setTimeout(() => el.remove(), 4000);
    }

    // ---- Observers + hotkeys -------------------------------------------------
    // Camera moves arrive from mapy-hook.js ("msh-camera"). These only drive the
    // URL fallback and layout changes. (Patching history.pushState from here
    // never worked: a content script's `window` is its own isolated copy, so
    // Mapy's calls didn't go through the patch.)
    function installObservers() {
        window.addEventListener("popstate", requestRender);
        window.addEventListener("hashchange", requestRender);
        window.addEventListener("resize", requestRender);
        window.addEventListener("resize", layoutPanel);
        window.setInterval(requestRender, 250);
        window.setInterval(layoutPanel, 250);
    }

    function installHotkeys() {
        window.addEventListener(
            "keydown",
            (event) => {
                if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) {
                    return;
                }
                const t = event.target;
                const tag = t && t.tagName ? String(t.tagName).toLowerCase() : "";
                if (tag === "input" || tag === "textarea" || tag === "select" || (t && t.isContentEditable)) {
                    return;
                }
                const key = String(event.key || "").toLowerCase();
                if (key === "a") {
                    event.preventDefault();
                    masterToggle();
                } else if (key === "s") {
                    event.preventDefault();
                    cycleSport();
                } else if (key === "d") {
                    event.preventDefault();
                    toggleGlobal();
                } else if (key === "f") {
                    event.preventDefault();
                    togglePersonal();
                } else if (key === "g") {
                    event.preventDefault();
                    toggleAerial();
                } else if (event.key === "[") {
                    event.preventDefault();
                    setOpacity(opacity - 10);
                } else if (event.key === "]") {
                    event.preventDefault();
                    setOpacity(opacity + 10);
                }
            },
            { capture: true }
        );
    }

    // ---- Boot ----------------------------------------------------------------
    installObservers();
    installHotkeys();
    requestRender();
})();
