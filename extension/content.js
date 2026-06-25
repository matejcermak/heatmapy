// Strava Heatmap for Mapy.cz — content script.
// Renders two composited tile layers over the Mapy map:
//   - GLOBAL per-sport heatmap (content-a.strava.com/identified/globalheat) in "hot"
//   - PERSONAL heatmap (personal-heatmaps-external.strava.com) recolored blue
// Cross-origin tiles are fetched (with your Strava cookies) by the service
// worker; this script handles geometry, caching, recolor, the on-map panel,
// and hotkeys. Adapted from the Tampermonkey userscript.
(function () {
    "use strict";

    if (!window.chrome || !chrome.runtime || !chrome.runtime.id) {
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
    };
    const SPORT_LABEL = { mtb: "MTB", gravel: "Gravel", ride: "Road", run: "Run" };
    const SPORT_ORDER = ["ride", "mtb", "gravel", "run"]; // Road, MTB, Gravel, Run
    const MIN_ZOOM = 0;
    const MAX_ZOOM = 22;
    const GLOBAL_TILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
    const MEM_CACHE_MAX = 4000;
    const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
    const ADD_POINT_HINT = (IS_MAC ? "⌘-click" : "Ctrl-click") + " the map to add a route point";

    // ---- State ---------------------------------------------------------------
    let masterOff = false; // A: mute everything (the per-layer states are remembered)
    let globalSport = "mtb"; // shared discipline: "mtb" | "gravel" | "ride" | "run" (S cycles)
    let globalOn = true; // G: global heatmap layer on/off (independent)
    let personalOn = false; // F: personal heatmap layer on/off (independent)
    let opacity = 100;
    let athleteId = "";

    let overlayRoot = null;
    let globalLayer = null;
    let personalLayer = null;
    let panelRoot = null;
    let rafId = null;
    let renderSeq = 0;
    let lastStateKey = "";
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

    // ---- Athlete id (for the personal heatmap) -------------------------------
    function applyAthleteId(id) {
        const next = String(id || "");
        if (next !== athleteId) {
            athleteId = next;
            lastStateKey = "";
            requestRender();
            renderPanel();
        }
    }
    try {
        chrome.storage.local.get("stravaAthleteId", (res) => {
            if (res && res.stravaAthleteId) {
                applyAthleteId(res.stravaAthleteId);
            }
            // Ask the worker to (re)detect in the background.
            chrome.runtime.sendMessage({ type: "detectAthlete" }, (r) => {
                if (!chrome.runtime.lastError && r && r.ok && r.athleteId) {
                    applyAthleteId(r.athleteId);
                }
            });
        });
        chrome.storage.onChanged.addListener((changes, area) => {
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
    const memCache = new Map(); // url -> objectURL
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
            try {
                URL.revokeObjectURL(u);
            } catch (_) {
                // ignore
            }
        }
    }

    const DB_NAME = "mapyStravaTileCache";
    const DB_STORE = "tiles";
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
    function idbPut(url, blob) {
        (async () => {
            try {
                const db = await openDb();
                if (!db) {
                    return;
                }
                const tx = db.transaction(DB_STORE, "readwrite");
                tx.objectStore(DB_STORE).put({ blob, ts: Date.now() }, url);
            } catch (_) {
                // best-effort
            }
        })();
    }

    // ---- Tile fetch (via service worker, with Strava cookies) ----------------
    const STRAVA_HEATMAP_URL = "https://www.strava.com/maps/global-heatmap";
    let authNotifiedAt = 0;
    function noteAuthFailure() {
        const now = Date.now();
        if (now - authNotifiedAt < 60000) {
            return;
        }
        authNotifiedAt = now;
        const el = document.createElement("div");
        el.className = "msh-toast msh-toast--link";
        el.innerHTML =
            "Strava heatmap needs you logged in " +
            "(Subscription for zoom &gt; 11 / personal).<br>" +
            '<a href="' + STRAVA_HEATMAP_URL + '" target="_blank" rel="noopener noreferrer">' +
            "Open Strava heatmap ↗</a> — then reload this page.";
        positionToastAbovePanel(el);
        document.body.appendChild(el);
        window.setTimeout(() => el.remove(), 9000);
    }
    function fetchTileViaSW(url) {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage({ type: "fetchTile", url }, async (resp) => {
                    if (chrome.runtime.lastError || !resp) {
                        resolve({ ok: false, status: 0 });
                        return;
                    }
                    if (resp.ok && resp.dataUrl) {
                        try {
                            const blob = await (await fetch(resp.dataUrl)).blob();
                            resolve({ ok: true, status: resp.status, blob });
                        } catch (_) {
                            resolve({ ok: false, status: resp.status || 0 });
                        }
                    } else {
                        resolve({ ok: false, status: resp.status || 0 });
                    }
                });
            } catch (_) {
                resolve({ ok: false, status: 0 });
            }
        });
    }

    // Personal tiles arrive opaque-black with grayscale heat; key black ->
    // transparent and paint the heat blue (alpha = boosted intensity).
    function recolorToBlue(blob) {
        return new Promise((resolve) => {
            let srcUrl = "";
            const done = (out) => {
                if (srcUrl) {
                    try {
                        URL.revokeObjectURL(srcUrl);
                    } catch (_) {
                        // ignore
                    }
                }
                resolve(out);
            };
            try {
                srcUrl = URL.createObjectURL(blob);
                const im = new Image();
                im.onload = () => {
                    try {
                        const w = im.naturalWidth || 256;
                        const h = im.naturalHeight || 256;
                        const canvas = document.createElement("canvas");
                        canvas.width = w;
                        canvas.height = h;
                        const ctx = canvas.getContext("2d");
                        ctx.drawImage(im, 0, 0, w, h);
                        const data = ctx.getImageData(0, 0, w, h);
                        const d = data.data;
                        for (let i = 0; i < d.length; i += 4) {
                            const intensity = Math.max(d[i], d[i + 1], d[i + 2]);
                            d[i] = PERSONAL_RGB[0];
                            d[i + 1] = PERSONAL_RGB[1];
                            d[i + 2] = PERSONAL_RGB[2];
                            d[i + 3] =
                                intensity <= PERSONAL_ALPHA_THRESHOLD
                                    ? 0
                                    : Math.min(
                                          255,
                                          Math.round(intensity * PERSONAL_ALPHA_GAIN) + PERSONAL_ALPHA_FLOOR
                                      );
                        }
                        ctx.putImageData(data, 0, 0);
                        canvas.toBlob((out) => done(out ? URL.createObjectURL(out) : ""), "image/png");
                    } catch (_) {
                        done("");
                    }
                };
                im.onerror = () => done("");
                im.src = srcUrl;
            } catch (_) {
                done("");
            }
        });
    }

    function loadTile(img, layer, z, x, y, seq) {
        const url =
            layer.kind === "personal"
                ? buildPersonalUrl(layer.sport, z, x, y)
                : buildGlobalUrl(layer.sport, z, x, y);
        if (!url) {
            return;
        }
        const mem = memGet(url);
        if (mem) {
            img.src = mem;
            return;
        }
        const persist = layer.kind === "global";
        (async () => {
            if (persist) {
                const hit = await idbGet(url);
                if (seq !== renderSeq) {
                    return;
                }
                if (hit && hit.blob && Date.now() - (hit.ts || 0) < GLOBAL_TILE_TTL_MS) {
                    const u = URL.createObjectURL(hit.blob);
                    memPut(url, u);
                    img.src = u;
                    return;
                }
            }
            if (seq !== renderSeq) {
                return;
            }
            // From here it's a real network fetch -> reflect it in the spinner.
            pendingTiles += 1;
            updateLoading();
            try {
                const res = await fetchTileViaSW(url);
                if (seq !== renderSeq) {
                    return; // a newer render superseded this tile
                }
                if (!res.ok || !res.blob) {
                    if (res.status === 401 || res.status === 403) {
                        noteAuthFailure();
                    }
                    return;
                }
                if (layer.kind === "personal") {
                    const recolored = await recolorToBlue(res.blob);
                    if (seq !== renderSeq) {
                        return;
                    }
                    const u = recolored || URL.createObjectURL(res.blob);
                    memPut(url, u);
                    img.src = u;
                } else {
                    const u = URL.createObjectURL(res.blob);
                    memPut(url, u);
                    idbPut(url, res.blob);
                    img.src = u;
                }
            } finally {
                pendingTiles -= 1;
                updateLoading();
            }
        })();
    }

    // ---- Overlay elements ----------------------------------------------------
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
                zIndex: "2147483646",
                opacity: String(clamp(opacity / 100, 0, 1)),
                display: "block",
            });
            document.body.appendChild(overlayRoot);
        }
        const rect = getMapViewportRect();
        overlayRoot.style.left = `${rect.left}px`;
        overlayRoot.style.top = `${rect.top}px`;
        overlayRoot.style.width = `${rect.width}px`;
        overlayRoot.style.height = `${rect.height}px`;

        if (!globalLayer) {
            globalLayer = document.createElement("div");
            Object.assign(globalLayer.style, { position: "absolute", inset: "0", overflow: "hidden" });
            overlayRoot.appendChild(globalLayer);
        }
        if (!personalLayer) {
            personalLayer = document.createElement("div");
            Object.assign(personalLayer.style, { position: "absolute", inset: "0", overflow: "hidden" });
            overlayRoot.appendChild(personalLayer); // on top of global
        }
        ensurePanel();
    }

    function clearLayers() {
        if (globalLayer) {
            globalLayer.replaceChildren();
        }
        if (personalLayer) {
            personalLayer.replaceChildren();
        }
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

    function drawTiles(state) {
        renderSeq += 1;
        const seq = renderSeq;
        const rect = getMapViewportRect();
        const width = rect.width;
        const height = rect.height;
        const zoomFloat = clamp(state.zoom, MIN_ZOOM, MAX_ZOOM);
        const tileZoom = Math.min(Math.floor(zoomFloat), GLOBAL_MAX_ZOOM);
        const scale = Math.pow(2, zoomFloat - tileZoom);
        const centerPxX = lonToTileX(state.lon, tileZoom) * 256;
        const centerPxY = latToTileY(state.lat, tileZoom) * 256;
        const topLeftPxX = centerPxX - width / (2 * scale);
        const topLeftPxY = centerPxY - height / (2 * scale);
        const startX = Math.floor(topLeftPxX / 256) - 1;
        const startY = Math.floor(topLeftPxY / 256) - 1;
        const endX = Math.floor((topLeftPxX + width / scale) / 256) + 1;
        const endY = Math.floor((topLeftPxY + height / scale) / 256) + 1;
        const maxTileY = Math.pow(2, tileZoom) - 1;

        clearLayers();
        const layers = getActiveLayers();
        for (const layer of layers) {
            const div = layer.kind === "personal" ? personalLayer : globalLayer;
            for (let ty = startY; ty <= endY; ty += 1) {
                if (ty < 0 || ty > maxTileY) {
                    continue;
                }
                for (let tx = startX; tx <= endX; tx += 1) {
                    const img = document.createElement("img");
                    img.alt = "";
                    img.draggable = false;
                    Object.assign(img.style, {
                        position: "absolute",
                        left: `${(tx * 256 - topLeftPxX) * scale}px`,
                        top: `${(ty * 256 - topLeftPxY) * scale}px`,
                        width: `${256 * scale}px`,
                        height: `${256 * scale}px`,
                        imageRendering: "auto",
                        userSelect: "none",
                    });
                    loadTile(img, layer, tileZoom, tx, ty, seq);
                    div.appendChild(img);
                }
            }
        }
    }

    function stateKey(state) {
        const rect = getMapViewportRect();
        return [
            state.zoom.toFixed(4),
            state.lat.toFixed(6),
            state.lon.toFixed(6),
            Math.round(rect.width),
            Math.round(rect.height),
            Math.round(rect.left),
            Math.round(rect.top),
            masterOff ? "1" : "0",
            globalSport,
            globalOn ? "1" : "0",
            personalOn ? "1" : "0",
            opacity,
            athleteId,
        ].join("|");
    }

    function render() {
        const state = parseMapyState();
        ensureElements();
        const layers = state ? getActiveLayers() : [];
        if (layers.length === 0) {
            // Nothing active (e.g. A turned both off): hide + free old tiles.
            if (overlayRoot) {
                overlayRoot.style.display = "none";
            }
            clearLayers();
            lastStateKey = "";
            return;
        }
        overlayRoot.style.display = "block";
        overlayRoot.style.opacity = String(clamp(opacity / 100, 0, 1));
        const key = stateKey(state);
        if (key === lastStateKey) {
            return;
        }
        lastStateKey = key;
        drawTiles(state);
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
    }

    function renderPanel() {
        if (!panelRoot) {
            return;
        }
        const master = panelRoot.querySelector('[data-act="master"]');
        const g = panelRoot.querySelector('[data-act="global"]');
        const p = panelRoot.querySelector('[data-act="personal"]');
        const hint = panelRoot.querySelector(".msh-hint");
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
        lastStateKey = "";
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
        lastStateKey = "";
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
        lastStateKey = "";
        if (personalOn && !athleteId) {
            toast("Personal heatmap: log in to Strava (Subscriber) and reload to enable.");
        }
        renderPanel();
        requestRender();
    }
    // "A" = master mute: hide every layer (per-layer choices remembered) or restore them.
    function masterToggle() {
        masterOff = !masterOff;
        lsSet("masterOff", masterOff ? "1" : "0");
        lastStateKey = "";
        renderPanel();
        requestRender();
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
            const res = await chrome.runtime.sendMessage({
                type: "uploadStravaRoute",
                gpx: g.gpx,
                name: composeRouteName(g.gpx),
                sport: globalSport,
            });
            if (res && res.ok) {
                toast("Synced to Strava ✓ (starred) — it'll appear on your connected Garmin/Wahoo on the next device sync.");
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

    // ---- Toast ---------------------------------------------------------------
    // The panel's height is dynamic, so pin the toast just above its actual
    // height (panel sits at bottom:12px) rather than a fixed offset that the
    // taller panel would overlap.
    function positionToastAbovePanel(el) {
        const panel = panelRoot || document.getElementById("msh-panel");
        if (!panel) {
            return;
        }
        const h = panel.getBoundingClientRect().height || panel.offsetHeight || 0;
        if (h) {
            el.style.bottom = 12 + h + 8 + "px"; // panel bottom + height + gap
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
    function installObservers() {
        const op = window.history.pushState;
        const or = window.history.replaceState;
        window.history.pushState = function (...a) {
            const out = op.apply(this, a);
            requestRender();
            return out;
        };
        window.history.replaceState = function (...a) {
            const out = or.apply(this, a);
            requestRender();
            return out;
        };
        window.addEventListener("popstate", requestRender);
        window.addEventListener("hashchange", requestRender);
        window.addEventListener("resize", requestRender);
        window.setInterval(requestRender, 250);
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
