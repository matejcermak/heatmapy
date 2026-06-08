// ==UserScript==
// @name         Mapy + Strava Heatmap Overlay
// @namespace    mapy-strava-overlay
// @version      0.7.0
// @description  Overlay Strava global heatmap or Waymarked Trails MTB/road route layers on mapy.com, switchable, while keeping Mapy controls.
// @downloadURL  https://github.com/matejcermak/mapycz_strava/raw/refs/heads/main/mapy_strava_overlay.user.js
// @updateURL    https://github.com/matejcermak/mapycz_strava/raw/refs/heads/main/mapy_strava_overlay.user.js
// @match        https://mapy.com/*
// @match        https://www.strava.com/maps/*
// @match        https://ridewithgps.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      heatmap-external-a.strava.com
// @connect      heatmap-external-b.strava.com
// @connect      heatmap-external-c.strava.com
// @connect      content-a.strava.com
// @connect      content-b.strava.com
// @connect      content-c.strava.com
// @connect      strava.com
// @connect      tile.waymarkedtrails.org
// @connect      mapy.com
// @connect      ridewithgps.com
// ==/UserScript==

(function () {
    "use strict";

    // Defaults copied from your Strava URL request.
    const FILTERS = {
        gOpacity: 100,
    };

    // --- Layer state --------------------------------------------------------
    // J cycles the GLOBAL heatmap: MTB -> Road -> off  (color fixed "hot").
    // K toggles the PERSONAL heatmap on/off            (color fixed "blue").
    // The personal heatmap's sport follows the global selection (MTB global ->
    // MTB personal, Road global -> Road personal); when the global heatmap is
    // off it uses the last bike sport you looked at. Global + personal can be
    // shown at the same time (personal blue overlaid on global hot).
    let globalMode = "mtb";       // "mtb" | "road" | "off"
    let personalOn = false;
    let lastBikeSport = "mtb";    // "mtb" | "road"
    const GLOBAL_HEAT_COLOR = "hot";
    const PERSONAL_HEAT_COLOR = "blue";
    const BIKE_SPORT_TOKEN = {
        mtb: "sport_MountainBikeRide",
        road: "sport_Ride",
    };

    // Update this query string if Strava tiles require your signed auth params.
    // Example: "?Key-Pair-Id=...&Policy=...&Signature=..."
    const STRAVA_AUTH_QUERY = "";

    const TILE_SUBDOMAINS = ["a", "b", "c"];
    const MIN_ZOOM = 0;
    // Mapy can go beyond 16; keep this high so scaling stays correct.
    const MAX_ZOOM = 22;
    // Strava public /tiles/ stop at z=11. /tiles-auth/ (signed cookies) goes to z=15.
    // Waymarked Trails MTB tiles go to z=18.
    const STRAVA_MAX_PUBLIC_ZOOM = 11;
    const STRAVA_MAX_AUTH_ZOOM = 15;
    const WMT_MAX_ZOOM = 18;
    const BASE_PATH_PUBLIC = "tiles";
    const BASE_PATH_AUTH = "tiles-auth";
    const TILE_FETCH_TIMEOUT_MS = 3500;

    // --- content.strava.com per-sport "identified" heatmap ------------------
    // The endpoint the Strava web app itself uses:
    //   https://content-a.strava.com/identified/globalheat/<sportToken>/<color>/<z>/<x>/<y>.png?v=19&missing=empty
    // It supports per-discipline heat (sport_Ride, sport_MountainBikeRide,
    // sport_GravelRide, ...) and authenticates by CloudFront *cookie* (no signed
    // query in the URL). We fetch it via GM_xmlhttpRequest with credentials so
    // the browser's .strava.com cookies ride along cross-origin from mapy.com.
    const CONTENT_HEAT_HOST = "content-a.strava.com";
    const CONTENT_HEAT_MAX_ZOOM = 15;

    // --- Personal heatmap ---------------------------------------------------
    // Fill this with a personal-heatmap tile URL from your DevTools (it carries
    // your athlete id). Use placeholders {sport} {color} {z} {x} {y} where the
    // tile coords / sport_* token / color appear, e.g.:
    //   "https://personalized-heatmaps-external.strava.com/tiles/<ID>/{color}/{z}/{x}/{y}.png?filter_type={sport}&respect_privacy_zones=true&include_everyone=true&include_followers=true"
    // Until set, the K (personal) layer stays off with a hint.
    const PERSONAL_HEAT_URL_TEMPLATE = "";

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
        mobileblue: "mobileblue",
        purple: "purple",
        gray: "gray",
        grey: "gray",
        bluered: "blue",
    };

    let overlayEnabled = true;
    let overlayRoot = null;
    let globalTileLayer = null;
    let personalTileLayer = null;
    let debugRoot = null;
    let debugEnabled = false;
    let rafId = null;
    let lastStateKey = "";
    let perfScanIndex = 0;
    let renderSeq = 0;
    let automationLog = [];
    let internalMapyExportFetch = false;
    let pendingMapyExportCapture = null;

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

    const STORAGE_KEY_SOURCE = "mapyStravaActiveSource";
    const STORAGE_KEY_GLOBAL_MODE = "mapyStravaGlobalMode";
    const STORAGE_KEY_PERSONAL_ON = "mapyStravaPersonalOn";
    const STORAGE_KEY_AUTH = "stravaHeatmapAuthQuery";
    const STORAGE_KEY_AUTH_TS = "stravaHeatmapAuthTimestamp";
    const STORAGE_KEY_MAPY_LAST_GPX_EXPORT_URL = "mapyLastGpxExportUrl";
    const STORAGE_KEY_MAPY_LAST_GPX_EXPORT_SIG = "mapyLastGpxExportSignature";
    const STORAGE_KEY_RWGPS_PENDING_GPX_B64 = "rwgpsPendingGpxBase64";
    const STORAGE_KEY_RWGPS_PENDING_GPX_NAME = "rwgpsPendingGpxName";
    const STORAGE_KEY_RWGPS_PENDING_TS = "rwgpsPendingTimestamp";
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

    function showNotice(message) {
        // Lightweight toast so the user gets feedback even with debug off.
        const text = String(message || "");
        if (!text) {
            return;
        }
        try {
            const el = document.createElement("div");
            el.textContent = text;
            Object.assign(el.style, {
                position: "fixed",
                left: "12px",
                bottom: "12px",
                zIndex: "2147483647",
                padding: "8px 10px",
                borderRadius: "8px",
                background: "rgba(0,0,0,0.72)",
                color: "#fff",
                fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
                fontSize: "13px",
                pointerEvents: "none",
                maxWidth: "70vw",
                whiteSpace: "pre-wrap",
            });
            document.body.appendChild(el);
            window.setTimeout(() => el.remove(), 3500);
        } catch (_) {
            // ignore
        }
    }

    function shortText(text, maxLen = 140) {
        const s = String(text || "");
        if (s.length <= maxLen) {
            return s;
        }
        return `${s.slice(0, Math.max(0, maxLen - 3))}...`;
    }

    function logAutomation(message) {
        const msg = String(message || "").trim();
        if (!msg) {
            return;
        }
        const ts = new Date().toISOString().slice(11, 19);
        automationLog.push(`${ts} ${msg}`);
        if (automationLog.length > 12) {
            automationLog = automationLog.slice(-12);
        }
        updateDebugPanel();
    }

    function awaitNextMapyPlannerExportUrl(timeoutMs = 1500) {
        // Resolve with the next captured /api/tplannerexport?... URL.
        // This lets S prefer the export URL generated by the UI *right now*.
        if (pendingMapyExportCapture) {
            pendingMapyExportCapture.cancelled = true;
            pendingMapyExportCapture = null;
        }
        return new Promise((resolve) => {
            const startedAt = Date.now();
            const slot = { resolve, startedAt, cancelled: false };
            pendingMapyExportCapture = slot;
            window.setTimeout(() => {
                if (pendingMapyExportCapture === slot) {
                    pendingMapyExportCapture = null;
                }
                if (!slot.cancelled) {
                    resolve("");
                }
            }, timeoutMs);
        });
    }

    function isMapyPlannerExportUrl(urlText) {
        if (typeof urlText !== "string") {
            return false;
        }
        return urlText.includes("/api/tplannerexport") && urlText.includes("export=gpx");
    }

    function computeMapyPlannerSignatureFromUrl(urlText) {
        // Stable-ish signature so we don't reuse an old export URL for a new route.
        // We only use parameters that appear in both the planner URL and export URL.
        let parsed;
        try {
            parsed = new URL(urlText, window.location.origin);
        } catch (_) {
            return "";
        }
        const params = parsed.searchParams;

        const parts = [];
        for (const k of ["ri", "rs", "rut", "rp_c"]) {
            const values = params.getAll(k).filter(Boolean);
            if (values.length) {
                parts.push(`${k}=${values.join(",")}`);
            }
        }

        // Planner page often has rp_c embedded inside mrp JSON.
        if (!params.get("rp_c")) {
            const mrp = params.get("mrp") || "";
            if (mrp) {
                try {
                    const obj = JSON.parse(mrp);
                    if (obj && typeof obj.c === "number") {
                        parts.push(`rp_c=${obj.c}`);
                    }
                } catch (_) {
                    // ignore
                }
            }
        }

        return parts.join("&");
    }

    function captureMapyPlannerExportUrl(urlText) {
        if (internalMapyExportFetch) {
            // Don't let our own fetch() of the export endpoint "re-capture" and
            // pollute the cache/logs.
            return false;
        }
        if (!isMapyPlannerExportUrl(urlText)) {
            return false;
        }
        gmSetValue(STORAGE_KEY_MAPY_LAST_GPX_EXPORT_URL, urlText);
        gmSetValue(
            STORAGE_KEY_MAPY_LAST_GPX_EXPORT_SIG,
            computeMapyPlannerSignatureFromUrl(urlText)
        );
        logAutomation(`captured exportUrl=${shortText(urlText, 110)}`);
        updateDebugPanel("captured planner GPX export URL");
        if (pendingMapyExportCapture && !pendingMapyExportCapture.cancelled) {
            pendingMapyExportCapture.resolve(urlText);
            pendingMapyExportCapture = null;
        }
        return true;
    }

    function installMapyExportCapture() {
        // Capture export URLs so the S shortcut can reuse them.
        try {
            const origFetch = window.fetch;
            if (typeof origFetch === "function") {
                window.fetch = function (...args) {
                    try {
                        const input = args[0];
                        const urlText =
                            typeof input === "string"
                                ? input
                                : (input && typeof input.url === "string" ? input.url : "");
                        if (urlText) {
                            captureMapyPlannerExportUrl(urlText);
                        }
                    } catch (_) {
                        // ignore
                    }
                    return origFetch.apply(this, args);
                };
            }
        } catch (_) {
            // ignore
        }

        try {
            const origOpen = window.XMLHttpRequest && window.XMLHttpRequest.prototype.open;
            if (origOpen) {
                window.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                    try {
                        captureMapyPlannerExportUrl(String(url || ""));
                    } catch (_) {
                        // ignore
                    }
                    return origOpen.call(this, method, url, ...rest);
                };
            }
        } catch (_) {
            // ignore
        }

        // Some flows trigger the export as a navigation or window.open() rather
        // than XHR/fetch - capture those too.
        try {
            const origOpenWindow = window.open;
            if (typeof origOpenWindow === "function") {
                window.open = function (url, ...rest) {
                    try {
                        captureMapyPlannerExportUrl(String(url || ""));
                    } catch (_) {
                        // ignore
                    }
                    // eslint-disable-next-line prefer-rest-params
                    return origOpenWindow.apply(this, arguments);
                };
            }
        } catch (_) {
            // ignore
        }

        try {
            const origAnchorClick = HTMLAnchorElement && HTMLAnchorElement.prototype.click;
            if (origAnchorClick) {
                HTMLAnchorElement.prototype.click = function (...args) {
                    try {
                        captureMapyPlannerExportUrl(String(this.href || ""));
                    } catch (_) {
                        // ignore
                    }
                    return origAnchorClick.apply(this, args);
                };
            }
        } catch (_) {
            // ignore
        }
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const out = String(reader.result || "");
                const comma = out.indexOf(",");
                resolve(comma >= 0 ? out.slice(comma + 1) : out);
            };
            reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
            reader.readAsDataURL(blob);
        });
    }

    function base64ToBlob(b64, mimeType) {
        const bytes = Uint8Array.from(atob(String(b64 || "")), (c) => c.charCodeAt(0));
        return new Blob([bytes], { type: mimeType || "application/octet-stream" });
    }

    function findMapyPlannerGpxExportUrlFromDom() {
        // Try to find an existing download link without clicking anything.
        const anchors = Array.from(document.querySelectorAll("a[href]"));
        for (const a of anchors) {
            const href = String(a.getAttribute("href") || "");
            if (!href) {
                continue;
            }
            if (isMapyPlannerExportUrl(href)) {
                return new URL(href, window.location.origin).toString();
            }
        }
        return "";
    }

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
        } catch (_) {
            // ignore
        }

        try {
            const rect = el.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;

            const underPointer = document.elementFromPoint(x, y);
            // Prefer dispatching on the actual control we found; some handlers are
            // bound to the button itself and won't fire if we target an SVG/path.
            const primaryTarget = el;
            const secondaryTarget = underPointer && underPointer !== el ? underPointer : null;

            // In some userscript sandboxes, passing `view: window` can throw
            // ("Failed to convert value to 'Window'"). Omit it.
            const mkMouse = (type) =>
                new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    clientX: x,
                    clientY: y,
                });
            const mkPointer = (type) => {
                if (typeof PointerEvent !== "function") {
                    return null;
                }
                return new PointerEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    pointerType: "mouse",
                    isPrimary: true,
                    clientX: x,
                    clientY: y,
                });
            };

            // Some UIs rely on pointer/mouse sequences rather than click().
            const events = [
                mkPointer("pointerdown"),
                mkMouse("mousedown"),
                mkPointer("pointerup"),
                mkMouse("mouseup"),
                mkMouse("click"),
            ].filter(Boolean);

            for (const ev of events) {
                primaryTarget.dispatchEvent(ev);
                if (secondaryTarget) {
                    secondaryTarget.dispatchEvent(ev);
                }
            }
        } catch (err) {
            logAutomation(
                `simulateUserClick error: ${shortText(err && err.message ? err.message : err, 90)}`
            );
        }
        try {
            // Fallback: some apps still require click() on the button.
            el.click();
        } catch (_) {
            // ignore
        }
        return true;
    }

    function clickFirstElementByText(needles) {
        const parts = Array.isArray(needles) ? needles : [needles];
        const normNeedles = parts
            .map((t) => String(t || "").toLowerCase())
            .filter(Boolean);
        if (!normNeedles.length) {
            return false;
        }

        const candidates = Array.from(
            document.querySelectorAll("button, a, [role='button'], [type='button']")
        );
        for (const el of candidates) {
            if (!elementIsClickable(el)) {
                continue;
            }
            const text = `${String(el.textContent || "")} ${String(
                el.getAttribute("aria-label") || ""
            )} ${String(el.getAttribute("title") || "")}`.toLowerCase();
            if (!text.trim()) {
                continue;
            }
            if (normNeedles.some((n) => text.includes(n))) {
                simulateUserClick(el);
                return true;
            }
        }
        return false;
    }

    function clickMapyExportButton() {
        // Known Mapy planner export button:
        // <div class="icon-action" title="Export"><button>...</button></div>
        const direct = document.querySelector("div.icon-action[title='Export'] button");
        if (elementIsClickable(direct)) {
            simulateUserClick(direct);
            return true;
        }
        // Locale/fallbacks.
        const alt =
            document.querySelector("div.icon-action[title='Exportovat'] button") ||
            document.querySelector("div.icon-action[title='Stahnout'] button");
        if (elementIsClickable(alt)) {
            simulateUserClick(alt);
            return true;
        }
        return clickFirstElementByText(["export", "exportovat", "download", "stahnout"]);
    }

    function clickMapyExportDialogSave() {
        // In the export dialog, Mapy renders a span with this class inside a button.
        const span = document.querySelector("span.mymaps-dialog__saveBtnText");
        const btn =
            document.querySelector("button.mymaps-dialog__saveBtn") ||
            (span ? span.closest("button,[role='button'],a") : null);
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

    async function waitForElement(selector, timeoutMs = 1500, intervalMs = 50) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const el = document.querySelector(selector);
            if (el) {
                return el;
            }
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => window.setTimeout(r, intervalMs));
        }
        return null;
    }

    async function ensureMapyPlannerGpxExportUrl() {
        // First try passive discovery.
        let exportUrl = findMapyPlannerGpxExportUrlFromDom();
        if (exportUrl) {
            logAutomation("exportUrl found in DOM");
            return exportUrl;
        }
        const currentSig = computeMapyPlannerSignatureFromUrl(window.location.href);
        const cachedUrl = String(gmGetValue(STORAGE_KEY_MAPY_LAST_GPX_EXPORT_URL, "") || "");
        const cachedSig = String(gmGetValue(STORAGE_KEY_MAPY_LAST_GPX_EXPORT_SIG, "") || "");
        // Don't return the cached URL yet. For Mapy, the export endpoint can
        // sometimes serve the "last exported" route unless the export UI is
        // triggered for the current plan. We'll try to trigger and capture a
        // fresh URL first, and only fall back to cached if that fails.

        // If the signature doesn't match, avoid using a stale URL.
        if (cachedUrl) {
            logAutomation("exportUrl cache cleared (sig mismatch)");
        }
        gmSetValue(STORAGE_KEY_MAPY_LAST_GPX_EXPORT_URL, "");
        gmSetValue(STORAGE_KEY_MAPY_LAST_GPX_EXPORT_SIG, "");

        // Try to drive the UI: open Export, then pick GPX (or reveal a link).
        // This is heuristic (Mapy DOM changes), but avoids the manual click step.
        const tryOnce = async () => {
            const capturePromise = awaitNextMapyPlannerExportUrl(1600);

            // Step 1: click the toolbar Export button.
            logAutomation("click toolbar Export");
            clickMapyExportButton();
            const dialogEl = await waitForElement(
                "button.mymaps-dialog__saveBtn, span.mymaps-dialog__saveBtnText",
                1200
            );
            logAutomation(`dialog ${dialogEl ? "found" : "not found"}`);

            exportUrl = findMapyPlannerGpxExportUrlFromDom();
            if (exportUrl) {
                logAutomation("exportUrl found in DOM after toolbar click");
                return exportUrl;
            }

            // Step 2: click Export in the dialog (this triggers /api/tplannerexport).
            logAutomation("click dialog Export");
            clickMapyExportDialogSave();
            const captured = await capturePromise;
            if (captured) {
                logAutomation("exportUrl captured via hooks after dialog click");
                return captured;
            }
            await new Promise((r) => window.setTimeout(r, 400));

            exportUrl = findMapyPlannerGpxExportUrlFromDom();
            if (exportUrl) {
                return exportUrl;
            }

            logAutomation("exportUrl not captured");
            return "";
        };

        for (let i = 0; i < 6; i += 1) {
            exportUrl = await tryOnce();
            if (exportUrl) {
                return exportUrl;
            }
        }

        // Fall back to the last known URL if it looks like it's for this route.
        if (cachedUrl && (!currentSig || cachedSig === currentSig)) {
            logAutomation("exportUrl fallback to cached (sig matches)");
            return cachedUrl;
        }
        if (cachedUrl) {
            logAutomation("exportUrl cached exists but sig mismatch");
        }
        return "";
    }

    async function exportPlannerGpxAndOpenRwGps() {
        logAutomation("S: start export+upload");
        const exportUrl = await ensureMapyPlannerGpxExportUrl();
        if (!exportUrl) {
            showNotice(
                "Couldn't trigger/capture Mapy GPX export for this route.\n" +
                "If the export dialog opened, try clicking Export once manually and then press S again."
            );
            logAutomation("S: failed (no exportUrl)");
            return;
        }

        logAutomation(`S: fetch GPX url=${shortText(exportUrl, 110)}`);
        showNotice("Exporting GPX...");
        let blob;
        try {
            const exportUrlObj = new URL(exportUrl, window.location.origin);
            exportUrlObj.searchParams.set("rand", String(Math.random()));
            internalMapyExportFetch = true;
            const resp = await fetch(exportUrlObj.toString(), { credentials: "include" });
            if (!resp.ok) {
                throw new Error(`Mapy export failed: ${resp.status} ${resp.statusText}`);
            }
            blob = await resp.blob();
            logAutomation(`S: GPX fetched (${blob.size} bytes)`);
        } catch (err) {
            updateDebugPanel(`export error: ${String(err && err.message ? err.message : err)}`);
            showNotice(`GPX export failed: ${String(err && err.message ? err.message : err)}`);
            logAutomation(`S: fetch failed (${String(err && err.message ? err.message : err)})`);
            return;
        } finally {
            internalMapyExportFetch = false;
        }

        const b64 = await blobToBase64(blob);
        const name = `mapy-route-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.gpx`;
        gmSetValue(STORAGE_KEY_RWGPS_PENDING_GPX_B64, b64);
        gmSetValue(STORAGE_KEY_RWGPS_PENDING_GPX_NAME, name);
        gmSetValue(STORAGE_KEY_RWGPS_PENDING_TS, String(Date.now()));
        showNotice("GPX ready. Opening Ride with GPS upload...");
        logAutomation("S: opening ridewithgps.com/upload");
        window.open("https://ridewithgps.com/upload", "_blank", "noopener,noreferrer");
    }

    function installRideWithGpsUpload() {
        const pendingB64 = String(gmGetValue(STORAGE_KEY_RWGPS_PENDING_GPX_B64, "") || "");
        if (!pendingB64) {
            return;
        }

        if (window.location.pathname !== "/upload") {
            window.location.assign("https://ridewithgps.com/upload");
            return;
        }

        const pendingName = String(
            gmGetValue(STORAGE_KEY_RWGPS_PENDING_GPX_NAME, "route.gpx") || "route.gpx"
        );

        const tryAttachAndSubmit = () => {
            const input = document.querySelector("input[type='file']");
            if (!input) {
                return false;
            }

            try {
                const blob = base64ToBlob(pendingB64, "application/gpx+xml");
                const file = new File([blob], pendingName, { type: "application/gpx+xml" });
                const dt = new DataTransfer();
                dt.items.add(file);
                input.files = dt.files;
                input.dispatchEvent(new Event("change", { bubbles: true }));
            } catch (err) {
                showNotice(`RWGPS attach failed: ${String(err && err.message ? err.message : err)}`);
                return true;
            }

            // RWGPS currently renders a "Save as route" CTA (CSS-modules class).
            // Clicking it once makes the upload default to "route" instead of "activity".
            const saveAsRouteCta = document.querySelector(
                "._CTA_4wbn4_1._primaryCTA_4wbn4_49"
            );
            if (saveAsRouteCta && typeof saveAsRouteCta.click === "function") {
                saveAsRouteCta.click();
            }

            // Prefer "Save as Route" if there's an option.
            const labels = Array.from(document.querySelectorAll("label"));
            for (const label of labels) {
                const t = String(label.textContent || "").toLowerCase();
                if (t.includes("save as a route") || (t.includes("route") && t.includes("save"))) {
                    const forId = label.getAttribute("for");
                    const control = forId ? document.getElementById(forId) : null;
                    if (control && typeof control.click === "function") {
                        control.click();
                    } else if (typeof label.click === "function") {
                        label.click();
                    }
                    break;
                }
            }

            // Click an upload/submit button if present.
            const buttons = Array.from(document.querySelectorAll("button, input[type='submit']"));
            const pick = (predicate) =>
                buttons.find((b) => {
                    if (!b) {
                        return false;
                    }
                    const disabled =
                        (b instanceof HTMLButtonElement && b.disabled) ||
                        String(b.getAttribute("aria-disabled") || "") === "true";
                    if (disabled) {
                        return false;
                    }
                    const text =
                        b instanceof HTMLInputElement
                            ? String(b.value || "")
                            : String(b.textContent || "");
                    return predicate(String(text || "").toLowerCase());
                });
            const uploadBtn =
                pick((t) => t.trim() === "upload") ||
                pick((t) => t.includes("upload")) ||
                pick((t) => t.includes("import"));
            if (uploadBtn && typeof uploadBtn.click === "function") {
                uploadBtn.click();
                showNotice("Uploading to Ride with GPS...");
                gmSetValue(STORAGE_KEY_RWGPS_PENDING_GPX_B64, "");
                gmSetValue(STORAGE_KEY_RWGPS_PENDING_GPX_NAME, "");
                return true;
            }

            showNotice("GPX attached on RWGPS. Click Upload to finish.");
            // Keep pending so user can refresh if needed.
            return true;
        };

        let tries = 0;
        const timer = window.setInterval(() => {
            tries += 1;
            const done = tryAttachAndSubmit();
            if (done || tries >= 30) {
                window.clearInterval(timer);
            }
        }, 1000);
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
        // Newly captured: blow away tile cache so we re-render with auth.
        lastStateKey = "";
        requestRender();
        return true;
    }

    // --- Background Strava auth refresh -------------------------------------
    // When tiles-auth starts 403ing (signed URL/cookie expired), we briefly
    // load the Strava heatmap page in a hidden iframe. Our @match covers
    // strava.com, so the same userscript instance runs in the iframe and
    // captures a fresh signed query into GM storage.
    let authFailureCount = 0;
    let lastAuthFailureAt = 0;
    let authRefreshInFlight = false;
    let lastAuthRefreshAt = 0;
    const AUTH_REFRESH_COOLDOWN_MS = 90 * 1000;
    const AUTH_REFRESH_FAIL_THRESHOLD = 3;

    // --- Cookie-based Strava auth ------------------------------------------
    // Modern Strava heatmap auth is CloudFront *signed cookies* (set on
    // .strava.com when you open the heatmap page while logged in), NOT a signed
    // query string. There's nothing to "capture" from tile URLs anymore, so we
    // probe instead: fire one credentialed request at a tiles-auth tile and see
    // whether the browser's cookies make it return an image. If so, we can pull
    // z>11 tiles through the GM cookie path with no query string at all.
    let stravaCookieAuthOk = false;
    let stravaCookieProbeInFlight = false;
    let lastStravaCookieProbeAt = 0;
    const STRAVA_COOKIE_PROBE_COOLDOWN_MS = 60 * 1000;

    function stravaAuthAvailable() {
        return !!getActiveAuthQuery() || stravaCookieAuthOk;
    }

    function probeStravaCookieAuth(force) {
        // Needs GM_xmlhttpRequest to send cross-origin cookies to the heatmap
        // domain; a plain <img> on mapy.com can't (third-party cookies).
        if (!CAN_USE_GM_REQUEST || getActiveSource() !== "strava-ride") {
            return;
        }
        if (stravaCookieProbeInFlight) {
            return;
        }
        const now = Date.now();
        if (!force && now - lastStravaCookieProbeAt < STRAVA_COOKIE_PROBE_COOLDOWN_MS) {
            return;
        }
        lastStravaCookieProbeAt = now;
        stravaCookieProbeInFlight = true;
        const notifyOnFail = !!force;
        // Any in-range tile works; we only care about the HTTP status. z=12 is
        // the first zoom that requires auth (public tiles stop at 11).
        const url = buildStravaTileUrl(BASE_PATH_AUTH, 12, 2234, 1400, false);
        gmRequest({
            method: "GET",
            url,
            responseType: "blob",
            timeout: TILE_FETCH_TIMEOUT_MS,
            withCredentials: true,
            anonymous: false,
            headers: {
                Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            },
            onload: (response) => {
                stravaCookieProbeInFlight = false;
                const blob = response.response;
                const ok =
                    response.status >= 200 &&
                    response.status < 300 &&
                    blob &&
                    typeof blob.type === "string" &&
                    blob.type.startsWith("image/");
                const changed = stravaCookieAuthOk !== !!ok;
                stravaCookieAuthOk = !!ok;
                logAutomation(`cookie probe: ${response.status} -> auth ${ok ? "ok" : "no"}`);
                if (!ok && response.status === 403 && notifyOnFail) {
                    showNotice(
                        "Strava heatmap needs auth for z>11.\n" +
                        "Open https://www.strava.com/maps/global-heatmap in a tab (logged in),\n" +
                        "pan once, then reload this page."
                    );
                }
                if (changed) {
                    lastStateKey = "";
                    requestRender();
                }
                updateDebugPanel();
            },
            onerror: () => {
                stravaCookieProbeInFlight = false;
                logAutomation("cookie probe: network error");
                updateDebugPanel();
            },
            ontimeout: () => {
                stravaCookieProbeInFlight = false;
                logAutomation("cookie probe: timeout");
                updateDebugPanel();
            },
        });
    }

    function noteAuthTileFailure() {
        const now = Date.now();
        // Reset the counter if failures are sparse.
        if (now - lastAuthFailureAt > 8000) {
            authFailureCount = 0;
        }
        lastAuthFailureAt = now;
        authFailureCount += 1;
        if (authFailureCount >= AUTH_REFRESH_FAIL_THRESHOLD) {
            authFailureCount = 0;
            // Repeated 403s on heatmap tiles -> Strava cookies missing/expired.
            showNotice(
                "Strava heatmap tiles are 403ing.\n" +
                "Open the Strava heatmap page (logged in) to refresh your cookies, then reload."
            );
        }
    }

    function tryRefreshStravaAuth() {
        if (authRefreshInFlight) {
            return;
        }
        const now = Date.now();
        if (now - lastAuthRefreshAt < AUTH_REFRESH_COOLDOWN_MS) {
            return;
        }
        lastAuthRefreshAt = now;
        authRefreshInFlight = true;
        logAutomation("auth: refreshing via hidden iframe");
        showNotice("Refreshing Strava heatmap auth...");

        let iframe;
        let timeoutId;
        let pollId;
        const initialAuth = String(gmGetValue(STORAGE_KEY_AUTH, "") || "");
        const initialAuthTs = String(gmGetValue(STORAGE_KEY_AUTH_TS, "") || "");

        const cleanup = (note) => {
            authRefreshInFlight = false;
            if (pollId) {
                window.clearInterval(pollId);
                pollId = null;
            }
            if (timeoutId) {
                window.clearTimeout(timeoutId);
                timeoutId = null;
            }
            if (iframe && iframe.parentNode) {
                iframe.parentNode.removeChild(iframe);
            }
            iframe = null;
            if (note) {
                logAutomation(`auth: ${note}`);
            }
        };

        try {
            iframe = document.createElement("iframe");
            iframe.src = "https://www.strava.com/maps/global-heatmap";
            // Hidden but rendered (display:none can suppress resource loading).
            Object.assign(iframe.style, {
                position: "fixed",
                left: "-10000px",
                top: "0",
                width: "1024px",
                height: "768px",
                opacity: "0",
                pointerEvents: "none",
                border: "0",
            });
            iframe.setAttribute("aria-hidden", "true");
            iframe.setAttribute("tabindex", "-1");
            document.body.appendChild(iframe);
        } catch (err) {
            cleanup(`iframe create failed: ${shortText(err && err.message ? err.message : err, 60)}`);
            showNotice(
                "Couldn't open Strava in background.\n" +
                "Open https://www.strava.com/maps/global-heatmap once to refresh auth."
            );
            return;
        }

        // Poll for storage change instead of trying to read iframe DOM
        // (cross-origin). Auth-capture in the iframe writes via gmSetValue.
        pollId = window.setInterval(() => {
            const nowAuth = String(gmGetValue(STORAGE_KEY_AUTH, "") || "");
            const nowAuthTs = String(gmGetValue(STORAGE_KEY_AUTH_TS, "") || "");
            if (nowAuth && (nowAuth !== initialAuth || nowAuthTs !== initialAuthTs)) {
                cleanup("captured fresh auth via iframe");
                showNotice("Strava auth refreshed.");
                lastStateKey = "";
                requestRender();
            }
        }, 750);

        // Give the iframe up to 25s. If Strava's page hasn't shipped a signed
        // tile request by then, almost certainly it's blocked (X-Frame-Options
        // changed) or the user isn't logged in.
        timeoutId = window.setTimeout(() => {
            cleanup("iframe refresh timed out");
            showNotice(
                "Couldn't refresh Strava auth in background.\n" +
                "Open https://www.strava.com/maps/global-heatmap once (logged in) to refresh."
            );
        }, 25000);
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
        const key = String(FILTERS.gColor || "").toLowerCase();
        const primary = COLOR_ALIAS[key] || "hot";
        return [primary];
    }

    function personalConfigured() {
        return !!PERSONAL_HEAT_URL_TEMPLATE;
    }

    // The tile layers active for the current toggle state, bottom-to-top
    // (global hot underneath, personal blue on top).
    function getActiveLayers() {
        const layers = [];
        if (globalMode !== "off") {
            layers.push({ kind: "global", sport: globalMode });
        }
        if (personalOn && personalConfigured()) {
            const sport = globalMode === "off" ? lastBikeSport : globalMode;
            layers.push({ kind: "personal", sport });
        }
        return layers;
    }

    function getMaxTileZoom() {
        return CONTENT_HEAT_MAX_ZOOM;
    }

    function buildStravaTileUrl(basePath, z, x, y, includeAuth) {
        const subdomain = TILE_SUBDOMAINS[Math.abs(x + y) % TILE_SUBDOMAINS.length];
        const sportSlug = getSportSlug();
        const colorSlug = getColorCandidates()[0];
        const worldSize = Math.pow(2, z);
        const wrappedX = ((x % worldSize) + worldSize) % worldSize;
        const authQuery = includeAuth ? getActiveAuthQuery() : "";
        return `https://heatmap-external-${subdomain}.strava.com/${basePath}/` +
            `${sportSlug}/${colorSlug}/${z}/${wrappedX}/${y}.png${authQuery}`;
    }

    function buildContentHeatUrl(sportToken, color, z, x, y) {
        const worldSize = Math.pow(2, z);
        const wrappedX = ((x % worldSize) + worldSize) % worldSize;
        return `https://${CONTENT_HEAT_HOST}/identified/globalheat/` +
            `${sportToken}/${color}/${z}/${wrappedX}/${y}.png?v=19&missing=empty`;
    }

    function buildPersonalHeatUrl(sportToken, color, z, x, y) {
        if (!PERSONAL_HEAT_URL_TEMPLATE) {
            return "";
        }
        const worldSize = Math.pow(2, z);
        const wrappedX = ((x % worldSize) + worldSize) % worldSize;
        return PERSONAL_HEAT_URL_TEMPLATE
            .replace(/\{sport\}/g, sportToken)
            .replace(/\{color\}/g, color)
            .replace(/\{z\}/g, String(z))
            .replace(/\{x\}/g, String(wrappedX))
            .replace(/\{y\}/g, String(y));
    }

    // Fetch plan for one layer. Both global and personal heat are cookie-authed
    // strava endpoints, so both go through the GM_xmlhttpRequest cookie path.
    function getLayerFetchPlan(layer, z, x, y) {
        const sportToken = BIKE_SPORT_TOKEN[layer.sport] || BIKE_SPORT_TOKEN.mtb;
        if (layer.kind === "personal") {
            return {
                urls: [buildPersonalHeatUrl(sportToken, PERSONAL_HEAT_COLOR, z, x, y)],
                needsCookies: true,
            };
        }
        // Global: "hot" as requested, with a grayscale fallback per tile in case
        // the endpoint doesn't serve that color.
        return {
            urls: [
                buildContentHeatUrl(sportToken, GLOBAL_HEAT_COLOR, z, x, y),
                buildContentHeatUrl(sportToken, "grayscale", z, x, y),
            ],
            needsCookies: true,
        };
    }

    // theme: "mtb" (mountain bike routes) or "cycling" (road/touring cycle routes).
    function buildWmtTileUrl(theme, z, x, y) {
        const worldSize = Math.pow(2, z);
        const wrappedX = ((x % worldSize) + worldSize) % worldSize;
        return `https://tile.waymarkedtrails.org/${theme}/${z}/${wrappedX}/${y}.png`;
    }

    // Returns { urls: string[], needsCookies: boolean } so the fetcher can
    // choose direct <img> (fast, no GM round-trip) vs GM_xmlhttpRequest (cookies).
    function getTileFetchPlan(z, x, y) {
        const source = getActiveSource();
        if (source === "mtb-routes") {
            return { urls: [buildWmtTileUrl("mtb", z, x, y)], needsCookies: false };
        }
        if (source === "road-routes") {
            return { urls: [buildWmtTileUrl("cycling", z, x, y)], needsCookies: false };
        }
        if (isStravaContentSource(source)) {
            // Per-sport content heatmap, cookie-authed -> GM_xmlhttpRequest path.
            const sportToken = STRAVA_CONTENT_SPORT[source];
            const urls = getContentColorCandidates().map((c) =>
                buildContentHeatUrl(sportToken, c, z, x, y)
            );
            return { urls, needsCookies: true };
        }
        // Legacy heatmap-external path (kept as fallback; not in SOURCES).
        const authAvailable = stravaAuthAvailable();
        if (z > STRAVA_MAX_PUBLIC_ZOOM) {
            // Public would 404 here. Only the auth path makes sense.
            if (!authAvailable) {
                // No auth yet -> fall back to public (blank above z11, but the
                // cookie probe runs elsewhere and unlocks z>11 once it succeeds).
                return { urls: [buildStravaTileUrl(BASE_PATH_PUBLIC, z, x, y, false)], needsCookies: false };
            }
            // includeAuth=true appends the captured query string if we have one;
            // in cookie mode it's empty and the GM request carries cookies.
            return { urls: [buildStravaTileUrl(BASE_PATH_AUTH, z, x, y, true)], needsCookies: true };
        }
        // z <= 11: public is faster and reliable. Skip auth path entirely.
        return { urls: [buildStravaTileUrl(BASE_PATH_PUBLIC, z, x, y, false)], needsCookies: false };
    }

    // Kept for the debug panel; reflects what getTileFetchPlan would actually do.
    function getTileUrlCandidates(z, x, y) {
        return getTileFetchPlan(z, x, y).urls;
    }

    function setTileSourceFromPlan(img, plan, tileRenderSeq) {
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
            // For Strava auth tiles, repeated errors trigger a background re-auth.
            if (plan.needsCookies) {
                noteAuthTileFailure();
            }
            updateDebugPanel();
        });

        const previousBlobUrl = img.dataset.blobUrl || "";
        if (previousBlobUrl) {
            URL.revokeObjectURL(previousBlobUrl);
            delete img.dataset.blobUrl;
        }

        const candidates = plan.urls;

        // Fast path: when no cookies are needed, just point <img> at the URL.
        // Browser HTTP/2 + cache + connection coalescing makes this far faster
        // than going through GM_xmlhttpRequest (which has stricter concurrency).
        if (!plan.needsCookies) {
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
            return;
        }

        // Slow path: cookies required (Strava /tiles-auth/). Use GM_xmlhttpRequest
        // so cross-origin cookies actually get sent.
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
                    updateDebugPanel();
                    return;
                }
                const candidate = candidates[index];
                index += 1;

                gmRequest({
                    method: "GET",
                    url: candidate,
                    responseType: "blob",
                    timeout: TILE_FETCH_TIMEOUT_MS,
                    withCredentials: true,
                    anonymous: false,
                    headers: {
                        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                        Referer: "https://www.strava.com/",
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
                        // Accept image/*; Strava's CDN sometimes labels tiles
                        // application/octet-stream (or omits the type). The 2xx
                        // guard below already filters out 403/error XML bodies.
                        const isImageBlob =
                            blob &&
                            typeof blob.type === "string" &&
                            (blob.type.startsWith("image/") ||
                                blob.type === "application/octet-stream" ||
                                blob.type === "");
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
                        // 403 on tiles-auth means the signed cookie/query expired.
                        if (response.status === 401 || response.status === 403) {
                            noteAuthTileFailure();
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
                        noteAuthTileFailure();
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

        // Last resort: no GM_xmlhttpRequest and we need cookies. Direct img.src
        // will at least carry session cookies on same-site requests.
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

        if (!globalTileLayer) {
            globalTileLayer = document.createElement("div");
            globalTileLayer.id = "mapy-strava-overlay-tiles-global";
            Object.assign(globalTileLayer.style, {
                position: "absolute",
                inset: "0",
                overflow: "hidden",
            });
            overlayRoot.appendChild(globalTileLayer);
        }
        if (!personalTileLayer) {
            personalTileLayer = document.createElement("div");
            personalTileLayer.id = "mapy-strava-overlay-tiles-personal";
            Object.assign(personalTileLayer.style, {
                position: "absolute",
                inset: "0",
                overflow: "hidden",
            });
            // Appended after the global layer -> personal blue renders on top.
            overlayRoot.appendChild(personalTileLayer);
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
            `layers global=${globalMode} personal=${personalOn ? "on" : "off"} personalCfg=${personalConfigured() ? "yes" : "no"} activeSport=${globalMode === "off" ? lastBikeSport : globalMode}`,
            `colors global=${GLOBAL_HEAT_COLOR} personal=${PERSONAL_HEAT_COLOR} maxZoom=${getMaxTileZoom()} opacity=${FILTERS.gOpacity}`,
            [authStatus, authAge].filter(Boolean).join(" "),
            `tiles created=${debugStats.tilesCreated} loaded=${debugStats.tilesLoaded} errored=${debugStats.tilesErrored}`,
            `gm ok=${debugStats.gmFetchedOk} fail=${debugStats.gmFetchedFail} last=${debugStats.lastGmStatus} prev=${debugStats.lastGmStatusBeforeExhausted}`,
            `thisRender seq=${debugStats.current.renderSeq} basePaths=${getBasePathCandidates().join(",")} gmOk=${debugStats.current.gmOk} gmFail=${debugStats.current.gmFail} tiles=${debugStats.current.tilesCreated} loaded=${debugStats.current.tilesLoaded}`,
            debugStats.current.okUrl ? `okUrl=${debugStats.current.okUrl}` : "",
            debugStats.current.lastUrl ? `lastRenderUrl=${debugStats.current.lastUrl}` : "",
            debugStats.lastGmUrl ? `lastUrl=${debugStats.lastGmUrl}` : "",
            debugStats.lastCapturedAuthUrl ? `captured=${debugStats.lastCapturedAuthUrl}` : "",
            automationLog.length ? "recentActions:" : "",
            ...automationLog,
            extra ? `note=${extra}` : "",
        ].filter(Boolean);
        debugRoot.textContent = lines.join("\n");
    }

    function clearTiles() {
        if (globalTileLayer) {
            globalTileLayer.replaceChildren();
        }
        if (personalTileLayer) {
            personalTileLayer.replaceChildren();
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

        // Per-layer native zoom cap (content heatmap ~z15). Above the cap we
        // scale big tiles up; at or below it we request the matching zoom.
        const tileZoom = Math.min(desiredTileZoom, getMaxTileZoom());

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
        const layers = getActiveLayers();

        for (const layer of layers) {
            const layerDiv = layer.kind === "personal" ? personalTileLayer : globalTileLayer;
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
                        img.style.outline = layer.kind === "personal"
                            ? "1px solid rgba(0,128,255,0.35)"
                            : "1px solid rgba(255,0,0,0.35)";
                    }
                    setTileSourceFromPlan(img, getLayerFetchPlan(layer, tileZoom, tx, ty), renderSeq);
                    layerDiv.appendChild(img);
                }
            }
        }

        if (overlayRoot) {
            overlayRoot.style.background = debugEnabled ? "rgba(255,0,255,0.04)" : "transparent";
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
            globalMode,
            personalOn ? "1" : "0",
            lastBikeSport,
            FILTERS.gOpacity,
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

            const toggleMapySet = () => {
                const container =
                    document.querySelector("mapy-mapmenu-mapset-options") ||
                    document.querySelector("[class*='mapmenu-mapset-options']");
                if (!container) {
                    updateDebugPanel("mapset options not found");
                    return;
                }
                const root = container.shadowRoot || container;
                const options = Array.from(
                    root.querySelectorAll(
                        "[data-mapset], [data-id], button, [role='button'], li, a"
                    )
                );
                const matches = (el, patterns) => {
                    const hay = [
                        el.getAttribute && el.getAttribute("data-mapset"),
                        el.getAttribute && el.getAttribute("data-id"),
                        el.getAttribute && el.getAttribute("title"),
                        el.getAttribute && el.getAttribute("aria-label"),
                        el.textContent,
                    ]
                        .filter(Boolean)
                        .join(" ")
                        .toLowerCase();
                    return patterns.some((p) => hay.includes(p));
                };
                const aerial = options.find((el) =>
                    matches(el, ["letecká", "letecka", "aerial", "satellite", "ophoto"])
                );
                const outdoor = options.find((el) =>
                    matches(el, ["turistická", "turisticka", "outdoor", "hiking", "tourist"])
                );
                if (!aerial || !outdoor) {
                    updateDebugPanel("aerial/outdoor option not found");
                    return;
                }
                const isActive = (el) => {
                    const cls = (el.className && el.className.baseVal) || el.className || "";
                    const aria = el.getAttribute && el.getAttribute("aria-checked");
                    const sel = el.getAttribute && el.getAttribute("aria-selected");
                    return (
                        /\b(active|selected|is-active|is-selected)\b/i.test(String(cls)) ||
                        aria === "true" ||
                        sel === "true"
                    );
                };
                const target = isActive(aerial) ? outdoor : aerial;
                target.dispatchEvent(
                    new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
                );
                updateDebugPanel(
                    `mapset toggled to ${target === aerial ? "aerial" : "outdoor"}`
                );
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
                toggleMapySet();
                return;
            }
            if (key.toLowerCase() === "j") {
                consume();
                const order = ["mtb", "road", "off"];
                globalMode = order[(order.indexOf(globalMode) + 1) % order.length];
                if (globalMode !== "off") {
                    lastBikeSport = globalMode;
                }
                gmSetValue(STORAGE_KEY_GLOBAL_MODE, globalMode);
                lastStateKey = "";
                const labels = {
                    mtb: "Global heatmap: MTB (hot)",
                    road: "Global heatmap: Road (hot)",
                    off: "Global heatmap: off",
                };
                showNotice(labels[globalMode]);
                updateDebugPanel(`global -> ${globalMode}`);
                requestRender();
                return;
            }
            if (key.toLowerCase() === "k") {
                consume();
                personalOn = !personalOn;
                gmSetValue(STORAGE_KEY_PERSONAL_ON, personalOn ? "1" : "0");
                lastStateKey = "";
                if (personalOn && !personalConfigured()) {
                    showNotice(
                        "Personal heatmap not set up yet.\n" +
                        "Open your Strava personal heatmap, copy a tile URL from the\n" +
                        "Network tab, and add it to PERSONAL_HEAT_URL_TEMPLATE."
                    );
                } else {
                    const sport = globalMode === "off" ? lastBikeSport : globalMode;
                    showNotice(
                        personalOn
                            ? `Personal heatmap: ON — ${sport === "road" ? "Road" : "MTB"} (blue)`
                            : "Personal heatmap: off"
                    );
                }
                updateDebugPanel(`personal -> ${personalOn ? "on" : "off"}`);
                requestRender();
                return;
            }
            if (key.toLowerCase() === "s") {
                consume();
                exportPlannerGpxAndOpenRwGps().catch((err) => {
                    showNotice(`Export/upload failed: ${String(err && err.message ? err.message : err)}`);
                });
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
        if (window.location.hostname === "ridewithgps.com") {
            installRideWithGpsUpload();
            return;
        }
        // Restore J/K toggle state across reloads.
        const savedGlobal = String(gmGetValue(STORAGE_KEY_GLOBAL_MODE, "mtb") || "mtb").toLowerCase();
        globalMode = ["mtb", "road", "off"].includes(savedGlobal) ? savedGlobal : "mtb";
        if (globalMode !== "off") {
            lastBikeSport = globalMode;
        }
        personalOn = String(gmGetValue(STORAGE_KEY_PERSONAL_ON, "") || "") === "1";
        installObservers();
        installMapyExportCapture();
        installHotkeys();
        requestRender();
    }

    bootstrap();
})();
