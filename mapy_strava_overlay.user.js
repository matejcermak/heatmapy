// ==UserScript==
// @name         Mapy + Strava Heatmap Overlay
// @namespace    mapy-strava-overlay
// @version      0.2.0
// @description  Overlay Strava global heatmap on mapy.com while keeping Mapy controls.
// @match        https://mapy.com/*
// @match        https://www.strava.com/maps/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      heatmap-external-a.strava.com
// @connect      heatmap-external-b.strava.com
// @connect      heatmap-external-c.strava.com
// ==/UserScript==

(function () {
    "use strict";

    // Defaults copied from your Strava URL request.
    const FILTERS = {
        sport: "MountainBikeRide",
        gColor: "hot",
        gOpacity: 100,
    };

    // Update this query string if Strava tiles require your signed auth params.
    // Example: "?Key-Pair-Id=...&Policy=...&Signature=..."
    const STRAVA_AUTH_QUERY = "";

    const TILE_SUBDOMAINS = ["a", "b", "c"];
    const MIN_ZOOM = 0;
    // Mapy can go beyond 16; keep this high so scaling stays correct.
    const MAX_ZOOM = 22;
    // Strava heatmap tiles are available only up to this zoom level (z=11).
    // Always request tiles at or below this zoom and scale them up for higher
    // Mapy zooms.
    const MAX_PUBLIC_TILE_ZOOM = 11;
    const BASE_PATH_PUBLIC = "tiles";
    const BASE_PATH_AUTH = "tiles-auth";

    const SPORT_ALIAS = {
        all: "all",
        ride: "ride",
        mountainbikeride: "ride",
        gravelride: "ride",
        ebikeride: "ride",
        virtualride: "ride",
        run: "run",
        walk: "run",
        hike: "run",
        water: "water",
        swim: "water",
        row: "water",
        wintersport: "winter",
        winter: "winter",
        nordicski: "winter",
        alpineski: "winter",
        snowshoe: "winter",
    };

    const COLOR_ALIAS = {
        hot: "hot",
        blue: "blue",
        purple: "purple",
        gray: "gray",
        grey: "gray",
        bluered: "blue",
    };

    let overlayEnabled = true;
    let overlayRoot = null;
    let tileLayer = null;
    let debugRoot = null;
    let debugEnabled = false;
    let rafId = null;
    let lastStateKey = "";
    let perfScanIndex = 0;
    let renderSeq = 0;

    const debugStats = {
        tilesCreated: 0,
        tilesLoaded: 0,
        tilesErrored: 0,
        gmFetchedOk: 0,
        gmFetchedFail: 0,
        lastGmStatus: "",
        lastGmStatusBeforeExhausted: "",
        lastGmUrl: "",
        lastCapturedAuthUrl: "",
        current: {
            renderSeq: 0,
            tilesCreated: 0,
            tilesLoaded: 0,
            tilesErrored: 0,
            gmOk: 0,
            gmFail: 0,
            lastStatus: "",
            lastUrl: "",
            okUrl: "",
        },
    };

    const STORAGE_KEY_AUTH = "stravaHeatmapAuthQuery";
    const STORAGE_KEY_AUTH_TS = "stravaHeatmapAuthTimestamp";
    const CAN_USE_GM_REQUEST =
        typeof GM_xmlhttpRequest === "function" ||
        (typeof GM === "object" && typeof GM !== null &&
            typeof GM.xmlHttpRequest === "function");

    function gmGetValue(key, fallbackValue) {
        if (typeof GM_getValue === "function") {
            try {
                return GM_getValue(key, fallbackValue);
            } catch (_) {
                // Ignore extension API errors and fallback.
            }
        }
        try {
            const value = window.localStorage.getItem(`mapyStrava:${key}`);
            return value === null ? fallbackValue : value;
        } catch (_) {
            return fallbackValue;
        }
    }

    function gmSetValue(key, value) {
        if (typeof GM_setValue === "function") {
            try {
                GM_setValue(key, value);
                return;
            } catch (_) {
                // Ignore extension API errors and fallback.
            }
        }
        try {
            window.localStorage.setItem(`mapyStrava:${key}`, String(value));
        } catch (_) {
            // Intentionally ignored.
        }
    }

    function extractAuthQueryFromUrl(urlText) {
        let parsed;
        try {
            parsed = new URL(urlText);
        } catch (_) {
            return "";
        }
        if (!parsed.hostname.includes("heatmap-external-")) {
            return "";
        }
        // Only accept heatmap tile URLs.
        if (!/\/tiles(-auth)?\//.test(parsed.pathname)) {
            return "";
        }
        if (!parsed.search) {
            return "";
        }
        const params = parsed.searchParams;
        // Strava commonly uses CloudFront signed URL params, but the exact
        // parameter set can change; accept a few known families.
        const hasCloudFrontSignedUrl =
            params.has("Policy") && params.has("Signature") && params.has("Key-Pair-Id");
        const hasCloudFrontAltCasing =
            params.has("policy") && params.has("signature") && params.has("key-pair-id");
        const hasSigV4 =
            params.has("X-Amz-Algorithm") && params.has("X-Amz-Signature");

        return (hasCloudFrontSignedUrl || hasCloudFrontAltCasing || hasSigV4) ? parsed.search : "";
    }

    function getActiveAuthQuery() {
        if (STRAVA_AUTH_QUERY) {
            return STRAVA_AUTH_QUERY;
        }
        return String(gmGetValue(STORAGE_KEY_AUTH, "") || "");
    }

    function getBasePathCandidates() {
        // When we don't have a signed query string, hitting tiles-auth is almost
        // always a guaranteed 403 and just burns time. Prefer public tiles first.
        const authQuery = getActiveAuthQuery();
        return authQuery ? [BASE_PATH_PUBLIC, BASE_PATH_AUTH] : [BASE_PATH_PUBLIC];
    }

    function saveAuthQueryIfPresent(urlText) {
        const authQuery = extractAuthQueryFromUrl(urlText);
        if (!authQuery) {
            return false;
        }
        const existing = String(gmGetValue(STORAGE_KEY_AUTH, "") || "");
        if (existing === authQuery) {
            return false;
        }
        gmSetValue(STORAGE_KEY_AUTH, authQuery);
        gmSetValue(STORAGE_KEY_AUTH_TS, String(Date.now()));
        debugStats.lastCapturedAuthUrl = urlText;
        return true;
    }

    function installStravaAuthCapture() {
        // Capture via Resource Timing (poll + observer), plus defensive hooks
        // because some resources won't show up in timing APIs reliably.
        const scanResources = () => {
            const entries = window.performance.getEntriesByType("resource");
            for (let i = perfScanIndex; i < entries.length; i += 1) {
                const entry = entries[i];
                if (!entry || typeof entry.name !== "string") {
                    continue;
                }
                saveAuthQueryIfPresent(entry.name);
            }
            perfScanIndex = entries.length;
        };

        // Existing entries plus continuous updates while user browses Strava map.
        scanResources();
        window.setInterval(scanResources, 1000);

        // Resource Timing observer (more immediate than polling).
        try {
            const obs = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (entry && typeof entry.name === "string") {
                        saveAuthQueryIfPresent(entry.name);
                    }
                }
            });
            obs.observe({ type: "resource", buffered: true });
        } catch (_) {
            // Ignore if PerformanceObserver is unavailable/blocked.
        }

        // Hook image src assignment - Strava heatmap uses lots of <img> tiles.
        try {
            const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
            if (desc && typeof desc.set === "function") {
                Object.defineProperty(HTMLImageElement.prototype, "src", {
                    configurable: true,
                    enumerable: desc.enumerable,
                    get: desc.get,
                    set: function (value) {
                        if (typeof value === "string") {
                            saveAuthQueryIfPresent(value);
                        }
                        return desc.set.call(this, value);
                    },
                });
            }
        } catch (_) {
            // Ignore if the environment disallows patching.
        }
    }

    function gmRequest(details) {
        if (typeof GM_xmlhttpRequest === "function") {
            GM_xmlhttpRequest(details);
            return;
        }
        if (
            typeof GM === "object" &&
            typeof GM !== null &&
            typeof GM.xmlHttpRequest === "function"
        ) {
            GM.xmlHttpRequest(details);
        }
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function getMapViewportElement() {
        // Mapy renders the map primarily via <canvas>. The largest canvas on the
        // page is typically the actual map viewport; anchoring to it fixes the
        // horizontal offset caused by side panels.
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
        return best || document.body;
    }

    function getMapViewportRect() {
        const el = getMapViewportElement();
        const r = el.getBoundingClientRect();
        return {
            el,
            left: r.left,
            top: r.top,
            width: Math.max(0, r.width),
            height: Math.max(0, r.height),
        };
    }

    function parseMapyState() {
        const url = new URL(window.location.href);
        const hash = window.location.hash.replace(/^#/, "");
        const candidates = [];

        const decimalDigits = (text) => {
            const m = String(text || "").match(/\.(\d+)/);
            return m ? m[1].length : 0;
        };

        const addCandidate = (zoomText, latText, lonText) => {
            const zoom = Number(zoomText);
            const lat = Number(latText);
            const lon = Number(lonText);
            if (!Number.isFinite(zoom) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
                return;
            }
            const precisionScore =
                decimalDigits(zoomText) + decimalDigits(latText) + decimalDigits(lonText);
            candidates.push({ zoom, lat, lon, precisionScore });
        };

        // Query params: ?x=...&y=...&z=...
        addCandidate(url.searchParams.get("z"), url.searchParams.get("y"), url.searchParams.get("x"));

        // Pattern A: #12.83/49.99098/14.43104
        const slashParts = hash.split("/");
        if (slashParts.length >= 3) {
            addCandidate(slashParts[0], slashParts[1], slashParts[2]);
        }

        // Pattern B: #x=14.43104&y=49.99098&z=12.83
        const hashParams = new URLSearchParams(hash);
        addCandidate(hashParams.get("z"), hashParams.get("y"), hashParams.get("x"));

        if (!candidates.length) {
            return null;
        }
        candidates.sort((a, b) => b.precisionScore - a.precisionScore);
        const best = candidates[0];
        return { zoom: best.zoom, lat: best.lat, lon: best.lon };
    }

    function lonToTileX(lon, zoom) {
        return ((lon + 180) / 360) * Math.pow(2, zoom);
    }

    function latToTileY(lat, zoom) {
        const latRad = (lat * Math.PI) / 180;
        const n = Math.PI - Math.log(Math.tan(Math.PI / 4 + latRad / 2));
        return (n / Math.PI / 2) * Math.pow(2, zoom);
    }

    function getSportSlug() {
        const key = String(FILTERS.sport || "").toLowerCase();
        return SPORT_ALIAS[key] || "ride";
    }

    function getColorCandidates() {
        // Always stick to hot; Strava commonly supports it and it matches the
        // requested behavior (gColor=hot).
        return ["hot"];
    }

    function getTileUrlCandidates(z, x, y) {
        const subdomain = TILE_SUBDOMAINS[Math.abs(x + y) % TILE_SUBDOMAINS.length];
        const sportSlug = getSportSlug();
        const colorCandidates = getColorCandidates();
        const worldSize = Math.pow(2, z);
        const wrappedX = ((x % worldSize) + worldSize) % worldSize;

        const authQuery = getActiveAuthQuery();
        const urls = [];
        for (const basePath of getBasePathCandidates()) {
            for (const colorSlug of colorCandidates) {
                urls.push(
                    `https://heatmap-external-${subdomain}.strava.com/${basePath}/` +
                    `${sportSlug}/${colorSlug}/${z}/${wrappedX}/${y}.png` +
                    `${authQuery}`
                );
            }
        }
        return urls;
    }

    function setTileSourceWithFallback(img, candidates, tileRenderSeq) {
        // Track basic load/error behavior (useful when tiles fetch OK but don't render).
        debugStats.tilesCreated += 1;
        if (debugStats.current.renderSeq === tileRenderSeq) {
            debugStats.current.tilesCreated += 1;
        }
        img.addEventListener("load", () => {
            debugStats.tilesLoaded += 1;
            if (debugStats.current.renderSeq === tileRenderSeq) {
                debugStats.current.tilesLoaded += 1;
            }
            updateDebugPanel();
        });
        img.addEventListener("error", () => {
            debugStats.tilesErrored += 1;
            if (debugStats.current.renderSeq === tileRenderSeq) {
                debugStats.current.tilesErrored += 1;
            }
            updateDebugPanel();
        });

        const previousBlobUrl = img.dataset.blobUrl || "";
        if (previousBlobUrl) {
            URL.revokeObjectURL(previousBlobUrl);
            delete img.dataset.blobUrl;
        }

        if (CAN_USE_GM_REQUEST) {
            let index = 0;
            const tryNextViaGm = () => {
                if (index >= candidates.length) {
                    debugStats.gmFetchedFail += 1;
                    debugStats.lastGmStatus = "exhausted";
                    if (debugStats.current.renderSeq === tileRenderSeq) {
                        debugStats.current.gmFail += 1;
                        debugStats.current.lastStatus = "exhausted";
                    }
                    if (debugStats.lastGmStatusBeforeExhausted) {
                        // keep previous
                    }
                    updateDebugPanel();
                    return;
                }
                const candidate = candidates[index];
                index += 1;

                gmRequest({
                    method: "GET",
                    url: candidate,
                    responseType: "blob",
                    timeout: 8000,
                    // Important: Strava may require signed cookies for higher zoom tiles.
                    // GM requests do not always include cookies unless explicitly enabled.
                    withCredentials: true,
                    anonymous: false,
                    headers: {
                        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                    },
                    onload: (response) => {
                        debugStats.lastGmUrl = candidate;
                        debugStats.lastGmStatus = String(response.status);
                        debugStats.lastGmStatusBeforeExhausted = debugStats.lastGmStatus;
                        if (debugStats.current.renderSeq === tileRenderSeq) {
                            debugStats.current.lastUrl = candidate;
                            debugStats.current.lastStatus = String(response.status);
                        }
                        const blob = response.response;
                        const isImageBlob =
                            blob &&
                            typeof blob.type === "string" &&
                            blob.type.startsWith("image/");
                        if (response.status >= 200 && response.status < 300 && isImageBlob) {
                            debugStats.gmFetchedOk += 1;
                            if (debugStats.current.renderSeq === tileRenderSeq) {
                                debugStats.current.gmOk += 1;
                                if (!debugStats.current.okUrl) {
                                    debugStats.current.okUrl = candidate;
                                }
                            }
                            const blobUrl = URL.createObjectURL(blob);
                            img.dataset.blobUrl = blobUrl;
                            img.src = blobUrl;
                            updateDebugPanel();
                            return;
                        }
                        debugStats.gmFetchedFail += 1;
                        if (debugStats.current.renderSeq === tileRenderSeq) {
                            debugStats.current.gmFail += 1;
                        }
                        updateDebugPanel();
                        tryNextViaGm();
                    },
                    onerror: () => {
                        debugStats.lastGmUrl = candidate;
                        debugStats.lastGmStatus = "error";
                        debugStats.lastGmStatusBeforeExhausted = debugStats.lastGmStatus;
                        debugStats.gmFetchedFail += 1;
                        if (debugStats.current.renderSeq === tileRenderSeq) {
                            debugStats.current.gmFail += 1;
                            debugStats.current.lastUrl = candidate;
                            debugStats.current.lastStatus = "error";
                        }
                        updateDebugPanel();
                        tryNextViaGm();
                    },
                    ontimeout: () => {
                        debugStats.lastGmUrl = candidate;
                        debugStats.lastGmStatus = "timeout";
                        debugStats.lastGmStatusBeforeExhausted = debugStats.lastGmStatus;
                        debugStats.gmFetchedFail += 1;
                        if (debugStats.current.renderSeq === tileRenderSeq) {
                            debugStats.current.gmFail += 1;
                            debugStats.current.lastUrl = candidate;
                            debugStats.current.lastStatus = "timeout";
                        }
                        updateDebugPanel();
                        tryNextViaGm();
                    },
                });
            };
            tryNextViaGm();
            return;
        }

        let index = 0;

        const tryNext = () => {
            if (index >= candidates.length) {
                img.removeEventListener("error", tryNext);
                return;
            }
            img.src = candidates[index];
            index += 1;
        };

        img.addEventListener("error", tryNext);
        tryNext();
    }

    function ensureOverlayElements() {
        if (!overlayRoot) {
            overlayRoot = document.createElement("div");
            overlayRoot.id = "mapy-strava-overlay-root";
            Object.assign(overlayRoot.style, {
                position: "fixed",
                left: "0px",
                top: "0px",
                width: "0px",
                height: "0px",
                pointerEvents: "none",
                // Use a very high z-index to stay above Mapy UI/canvas layers.
                zIndex: "2147483647",
                opacity: String(clamp(FILTERS.gOpacity / 100, 0, 1)),
                display: overlayEnabled ? "block" : "none",
            });
            document.body.appendChild(overlayRoot);
        }

        // Reposition the overlay to match the actual map viewport.
        const rect = getMapViewportRect();
        // Don't round here: at high zoom even a 1px rounding error becomes
        // noticeable and can appear to "drift" when Mapy pans/animates.
        overlayRoot.style.left = `${rect.left}px`;
        overlayRoot.style.top = `${rect.top}px`;
        overlayRoot.style.width = `${rect.width}px`;
        overlayRoot.style.height = `${rect.height}px`;

        if (!tileLayer) {
            tileLayer = document.createElement("div");
            tileLayer.id = "mapy-strava-overlay-tiles";
            Object.assign(tileLayer.style, {
                position: "absolute",
                inset: "0",
                overflow: "hidden",
            });
            overlayRoot.appendChild(tileLayer);
        }

        if (!debugRoot) {
            debugRoot = document.createElement("div");
            debugRoot.id = "mapy-strava-overlay-debug";
            Object.assign(debugRoot.style, {
                position: "fixed",
                right: "10px",
                top: "10px",
                zIndex: "2147483647",
                pointerEvents: "auto",
                fontFamily: "monospace",
                fontSize: "12px",
                lineHeight: "1.25",
                padding: "8px 10px",
                background: "rgba(0,0,0,0.72)",
                color: "#fff",
                borderRadius: "8px",
                maxWidth: "520px",
                whiteSpace: "pre-wrap",
                display: "none",
            });
            document.body.appendChild(debugRoot);
        }
    }

    function updateDebugPanel(extra) {
        if (!debugEnabled || !debugRoot) {
            return;
        }
        const state = parseMapyState();
        const mapRect = getMapViewportRect();
        const auth = getActiveAuthQuery();
        const authStatus = auth ? `auth=${auth.length} chars` : "auth=none";
        const authTs = String(gmGetValue(STORAGE_KEY_AUTH_TS, "") || "");
        const authAge =
            authTs && /^\d+$/.test(authTs)
                ? `authAgeSec=${Math.floor((Date.now() - Number(authTs)) / 1000)}`
                : "";
        const lines = [
            "Mapy+Strava overlay debug",
            `enabled=${overlayEnabled} debug=${debugEnabled} seq=${renderSeq}`,
            `state=${state ? `${state.zoom.toFixed(3)} / ${state.lat.toFixed(5)} / ${state.lon.toFixed(5)}` : "null"}`,
            `viewport=${window.innerWidth}x${window.innerHeight} mapRect=${Math.round(mapRect.width)}x${Math.round(mapRect.height)}@${Math.round(mapRect.left)},${Math.round(mapRect.top)}`,
            `filters sport=${String(FILTERS.sport)} tileSport=${getSportSlug()} color=hot opacity=${FILTERS.gOpacity}`,
            `tileZoomPolicy maxTileZoom=${MAX_PUBLIC_TILE_ZOOM} (always capped)`,
            [authStatus, authAge].filter(Boolean).join(" "),
            `tiles created=${debugStats.tilesCreated} loaded=${debugStats.tilesLoaded} errored=${debugStats.tilesErrored}`,
            `gm ok=${debugStats.gmFetchedOk} fail=${debugStats.gmFetchedFail} last=${debugStats.lastGmStatus} prev=${debugStats.lastGmStatusBeforeExhausted}`,
            `thisRender seq=${debugStats.current.renderSeq} basePaths=${getBasePathCandidates().join(",")} gmOk=${debugStats.current.gmOk} gmFail=${debugStats.current.gmFail} tiles=${debugStats.current.tilesCreated} loaded=${debugStats.current.tilesLoaded}`,
            debugStats.current.okUrl ? `okUrl=${debugStats.current.okUrl}` : "",
            debugStats.current.lastUrl ? `lastRenderUrl=${debugStats.current.lastUrl}` : "",
            debugStats.lastGmUrl ? `lastUrl=${debugStats.lastGmUrl}` : "",
            debugStats.lastCapturedAuthUrl ? `captured=${debugStats.lastCapturedAuthUrl}` : "",
            extra ? `note=${extra}` : "",
        ].filter(Boolean);
        debugRoot.textContent = lines.join("\n");
    }

    function clearTiles() {
        if (tileLayer) {
            tileLayer.replaceChildren();
        }
    }

    function drawTilesForState(state) {
        renderSeq += 1;
        debugStats.current = {
            renderSeq,
            tilesCreated: 0,
            tilesLoaded: 0,
            tilesErrored: 0,
            gmOk: 0,
            gmFail: 0,
            lastStatus: "",
            lastUrl: "",
            okUrl: "",
        };

        const mapRect = getMapViewportRect();
        const width = mapRect.width;
        const height = mapRect.height;

        const zoomFloat = clamp(state.zoom, MIN_ZOOM, MAX_ZOOM);
        const desiredTileZoom = Math.floor(zoomFloat);

        // Strava does not return tiles above z=11, so always cap and scale.
        const tileZoom = Math.min(desiredTileZoom, MAX_PUBLIC_TILE_ZOOM);

        const scale = Math.pow(2, zoomFloat - tileZoom);

        const centerTileX = lonToTileX(state.lon, tileZoom);
        const centerTileY = latToTileY(state.lat, tileZoom);
        const centerPxX = centerTileX * 256;
        const centerPxY = centerTileY * 256;

        const topLeftPxX = centerPxX - width / (2 * scale);
        const topLeftPxY = centerPxY - height / (2 * scale);

        const startX = Math.floor(topLeftPxX / 256) - 1;
        const startY = Math.floor(topLeftPxY / 256) - 1;
        const endX = Math.floor((topLeftPxX + width / scale) / 256) + 1;
        const endY = Math.floor((topLeftPxY + height / scale) / 256) + 1;

        clearTiles();

        const maxTileY = Math.pow(2, tileZoom) - 1;

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
                if (debugEnabled) {
                    img.style.outline = "1px solid rgba(255,0,0,0.35)";
                }
                setTileSourceWithFallback(img, getTileUrlCandidates(tileZoom, tx, ty), renderSeq);
                tileLayer.appendChild(img);
            }
        }

        if (overlayRoot) {
            overlayRoot.style.background = debugEnabled ? "rgba(255,0,255,0.04)" : "transparent";
        }
        if (tileLayer) {
            tileLayer.style.outline = debugEnabled ? "2px solid rgba(0,255,255,0.35)" : "none";
        }
        updateDebugPanel();
    }

    function computeStateKey(state) {
        const mapRect = getMapViewportRect();
        return [
            state.zoom.toFixed(4),
            state.lat.toFixed(6),
            state.lon.toFixed(6),
            Math.round(mapRect.width),
            Math.round(mapRect.height),
            Math.round(mapRect.left),
            Math.round(mapRect.top),
            overlayEnabled ? "1" : "0",
            FILTERS.sport,
            FILTERS.gOpacity,
            getActiveAuthQuery(),
        ].join("|");
    }

    function render() {
        const state = parseMapyState();
        ensureOverlayElements();

        if (!state || !overlayEnabled) {
            if (overlayRoot) {
                overlayRoot.style.display = "none";
            }
            if (debugRoot) {
                debugRoot.style.display = debugEnabled ? "block" : "none";
                updateDebugPanel(!state ? "state=null (URL parse failed)" : "overlay disabled");
            }
            return;
        }

        overlayRoot.style.display = "block";
        if (debugRoot) {
            debugRoot.style.display = debugEnabled ? "block" : "none";
        }
        const key = computeStateKey(state);
        if (key === lastStateKey) {
            return;
        }
        lastStateKey = key;
        drawTilesForState(state);
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

    function installObservers() {
        const origPushState = window.history.pushState;
        const origReplaceState = window.history.replaceState;

        window.history.pushState = function (...args) {
            const out = origPushState.apply(this, args);
            requestRender();
            return out;
        };

        window.history.replaceState = function (...args) {
            const out = origReplaceState.apply(this, args);
            requestRender();
            return out;
        };

        window.addEventListener("popstate", requestRender);
        window.addEventListener("hashchange", requestRender);
        window.addEventListener("resize", requestRender);

        // Also poll because some map UIs update URL frequently without always
        // triggering events we can rely on.
        window.setInterval(requestRender, 250);
    }

    function installHotkeys() {
        const onKeydown = (event) => {
            if (event.repeat) {
                return;
            }

            // Don't steal keystrokes while typing in inputs/search boxes.
            const target = event.target;
            const tag = target && target.tagName ? String(target.tagName).toLowerCase() : "";
            const isTypingTarget =
                tag === "input" ||
                tag === "textarea" ||
                tag === "select" ||
                (target && target.isContentEditable);
            if (isTypingTarget) {
                return;
            }

            // Avoid conflicting with browser/OS shortcuts.
            // Note: on some keyboard layouts (e.g. CZ), `[`/`]` can require
            // AltGr, which reports as Ctrl+Alt. Allow that through.
            const isAltGraph =
                typeof event.getModifierState === "function" &&
                event.getModifierState("AltGraph");
            if ((event.ctrlKey && !isAltGraph) || event.metaKey) {
                return;
            }

            const key = String(event.key || "");
            const consume = () => {
                event.preventDefault();
                event.stopPropagation();
                if (typeof event.stopImmediatePropagation === "function") {
                    event.stopImmediatePropagation();
                }
            };

            const togglePanorama = () => {
                const el =
                    document.querySelector("mapy-map-toggle.map-controls__panorama") ||
                    document.querySelector(".map-controls__panorama") ||
                    document.querySelector("[class*='map-controls__panorama']");
                if (!el) {
                    updateDebugPanel("panorama toggle not found");
                    return;
                }
                // Some custom elements react better to a real MouseEvent.
                el.dispatchEvent(
                    new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
                );
                updateDebugPanel("panorama toggled");
            };

            if (key.toLowerCase() === "h") {
                consume();
                overlayEnabled = !overlayEnabled;
                requestRender();
                return;
            }
            if (key.toLowerCase() === "g") {
                consume();
                FILTERS.sport = FILTERS.sport === "MountainBikeRide" ? "Ride" : "MountainBikeRide";
                // Force a redraw even if map state didn't change.
                lastStateKey = "";
                updateDebugPanel(`sport toggled to ${FILTERS.sport}`);
                requestRender();
                return;
            }
            if (event.altKey && (event.code === "KeyD" || key.toLowerCase() === "d")) {
                consume();
                debugEnabled = !debugEnabled;
                ensureOverlayElements();
                updateDebugPanel("toggled debug");
                requestRender();
                return;
            }
            if (key === "[" || event.code === "BracketLeft") {
                consume();
                FILTERS.gOpacity = clamp(FILTERS.gOpacity - 10, 0, 100);
                if (overlayRoot) {
                    overlayRoot.style.opacity = String(FILTERS.gOpacity / 100);
                }
                requestRender();
                return;
            }
            if (key === "]" || event.code === "BracketRight") {
                consume();
                FILTERS.gOpacity = clamp(FILTERS.gOpacity + 10, 0, 100);
                if (overlayRoot) {
                    overlayRoot.style.opacity = String(FILTERS.gOpacity / 100);
                }
                requestRender();
                return;
            }

            if (key.toLowerCase() === "p") {
                consume();
                togglePanorama();
                return;
            }
        };

        // Use capture so we receive keys even if the page's handlers stop bubbling.
        window.addEventListener("keydown", onKeydown, { capture: true });
    }

    function bootstrap() {
        if (window.location.hostname.includes("strava.com")) {
            installStravaAuthCapture();
            return;
        }
        installObservers();
        installHotkeys();
        requestRender();
    }

    bootstrap();
})();
