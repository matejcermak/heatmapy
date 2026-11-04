// Background worker: the one thing a content script can't do in MV3 is a
// credentialed cross-origin fetch (CORS blocks it). With host_permissions for
// *.strava.com, the worker can fetch Strava heatmap tiles with the user's
// cookies attached and hand the bytes back to the content script.
//
// Runs as a service worker in Chrome and as an event page in Firefox (which has
// no MV3 service workers) — see scripts/build.mjs, which emits the per-browser
// `background` manifest key. Nothing here is service-worker specific.

// Promise-based extension APIs: `browser` in Firefox, `chrome` in Chrome MV3.
// (Firefox's `chrome` alias is callback-only, so awaiting it there returns
// undefined — always go through `api`.)
const api = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;

const ATHLETE_KEY = "stravaAthleteId";
const STRAVA_ORIGIN = "*://*.strava.com/*";

// Firefox MV3 grants host permissions at install (127+) but lets the user revoke
// them at any time; without them every credentialed fetch below fails opaquely.
// Check first so the content script can tell the user how to fix it.
async function hasStravaPermission() {
    try {
        if (!api.permissions || !api.permissions.contains) {
            return true;
        }
        return await api.permissions.contains({ origins: [STRAVA_ORIGIN] });
    } catch (_) {
        return true; // can't tell — let the request itself decide
    }
}

// ---- Firefox: find the cookie jar that holds the Strava login ---------------
// Firefox containers each have their own cookie store, and Zen's workspaces are
// containers — so a user can be logged in to Strava in a container while the
// *default* store (which both cookies.getAll() and background fetch use) is
// empty. Locate the store that actually has the session and use it everywhere.
//
// Markers of an authenticated session. `_strava4_session` is deliberately absent:
// Strava sets that for anonymous visitors too, so it proves nothing. The
// CloudFront-* pair is what authorizes the heatmap tile CDN.
const SESSION_MARKERS = ["_strava_idcf", "CloudFront-Signature"];
const IS_FIREFOX = !!globalThis.browser?.runtime?.id;
const STORE_TTL_MS = 60000;
let storeIdCache = null;
let storeIdCachedAt = 0;
let lastLoggedStoreId;

// Returns a storeId to pass to the cookies API, or null to use the default store
// (always the case in Chrome, which has no containers and already works).
async function stravaStoreId() {
    if (!IS_FIREFOX) {
        return null;
    }
    const now = Date.now();
    if (now - storeIdCachedAt < STORE_TTL_MS) {
        return storeIdCache;
    }
    let found = null;
    try {
        // getAllCookieStores() only lists stores with open tabs, so check the
        // default explicitly — it won't appear there if no tab is using it.
        const ids = ["firefox-default"];
        for (const s of await api.cookies.getAllCookieStores()) {
            if (!ids.includes(s.id)) {
                ids.push(s.id);
            }
        }
        for (const id of ids) {
            try {
                const jar = await api.cookies.getAll({
                    url: "https://www.strava.com/",
                    storeId: id,
                });
                if (jar.some((c) => SESSION_MARKERS.includes(c.name))) {
                    found = id;
                    break;
                }
            } catch (_) {
                // store not queryable — try the next
            }
        }
    } catch (_) {
        // fall through with found = null
    }
    storeIdCache = found;
    storeIdCachedAt = now;
    if (found !== lastLoggedStoreId) {
        lastLoggedStoreId = found;
        console.log("[msh] strava cookie store:", found || "(default / none found)");
    }
    return found;
}

// ---- Firefox: re-attach cookies to our own requests ------------------------
// A background request's initiator is the moz-extension:// origin, so Firefox
// treats it as cross-site and withholds Strava's SameSite cookies — every
// credentialed fetch then comes back 403 / logged-out even though the user is
// signed in and cookies.get() can see the session. Chrome exempts extension
// requests that hold host permissions; Firefox doesn't. Firefox MV3 keeps
// blocking webRequest, so put the Cookie header back on (fetch() itself can't —
// Cookie is a forbidden header name).
//
// Chrome never registers this: webRequest/webRequestBlocking are only in the
// Firefox manifest, so api.webRequest is undefined there. See scripts/build.mjs.
let lastInjectShape;
if (api.webRequest && api.webRequest.onBeforeSendHeaders) {
    api.webRequest.onBeforeSendHeaders.addListener(
        async (details) => {
            // Only our own requests. Page requests (tabId >= 0) already carry the
            // right cookies — rewriting those could break normal strava.com use.
            if (details.tabId !== -1) {
                return {};
            }
            if (details.originUrl && !details.originUrl.startsWith("moz-extension://")) {
                return {};
            }
            const headers = (details.requestHeaders || []).filter(
                (h) => h.name.toLowerCase() !== "cookie"
            );
            try {
                // getAll({url}) applies host/path/secure matching but not SameSite —
                // exactly the set the browser would have sent same-site.
                const storeId = await stravaStoreId();
                const jar = await api.cookies.getAll(
                    storeId ? { url: details.url, storeId } : { url: details.url }
                );
                const cookie = jar.map((c) => c.name + "=" + c.value).join("; ");
                if (cookie) {
                    headers.push({ name: "Cookie", value: cookie });
                }
                // One line per distinct cookie set, not per tile — a map pan is
                // hundreds of requests.
                const shape = jar.length + ":" + (storeId || "default");
                if (shape !== lastInjectShape) {
                    lastInjectShape = shape;
                    console.log(
                        "[msh] cookie inject from", storeId || "default store", "—",
                        jar.map((c) => c.name).join(",") || "(none)"
                    );
                }
            } catch (_) {
                return {}; // leave the request as-is rather than strip its cookies
            }
            return { requestHeaders: headers };
        },
        { urls: ["*://*.strava.com/*"] },
        ["blocking", "requestHeaders"]
    );
}

// runtime messaging serializes as JSON (not structured clone), so an ArrayBuffer
// would be lost in transit. Encode tiles as a base64 data URL string instead.
function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
}

async function fetchTile(url) {
    if (!(await hasStravaPermission())) {
        return { ok: false, status: 0, needPermission: true };
    }
    try {
        const resp = await fetch(url, {
            credentials: "include",
            headers: {
                Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            },
        });
        if (!resp.ok) {
            console.warn("[msh] tile fetch", resp.status, url);
            return { ok: false, status: resp.status };
        }
        const buf = await resp.arrayBuffer();
        const contentType = resp.headers.get("content-type") || "image/png";
        return {
            ok: true,
            status: resp.status,
            dataUrl: `data:${contentType};base64,${bufToBase64(buf)}`,
        };
    } catch (e) {
        const error = String(e && e.message ? e.message : e);
        console.warn("[msh] tile fetch error", error, url);
        return { ok: false, status: 0, error };
    }
}

function b64urlDecode(s) {
    let str = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) {
        str += "=";
    }
    return atob(str);
}

function jwtPayload(value) {
    try {
        const parts = String(value || "").split(".");
        return parts.length >= 2 ? JSON.parse(b64urlDecode(parts[1])) : null;
    } catch (_) {
        return null;
    }
}

// The reliable source: Strava's `_strava_idcf` cookie is a JWT whose payload
// holds the logged-in athlete id. (Scraping a page can match the WRONG athlete.)
async function athleteIdFromCookie() {
    try {
        const storeId = await stravaStoreId();
        const query = { url: "https://www.strava.com", name: "_strava_idcf" };
        if (storeId) {
            query.storeId = storeId; // the login may live in a container jar
        }
        const c = await api.cookies.get(query);
        const payload = c && jwtPayload(c.value);
        if (payload && payload.athleteId) {
            return String(payload.athleteId);
        }
    } catch (_) {
        // ignore
    }
    return "";
}

// Is the extension actually authenticated to Strava? Distinguishes "not logged in"
// from "logged in but the athlete id couldn't be read" — the two need different
// fixes, and a catch-all message sends people to re-log-in pointlessly.
//
// This must be a real request, not a cookie check: `_strava4_session` is a Rails
// session cookie that Strava sets for anonymous visitors too, so its presence
// proves nothing. A logged-in-only page bounces to /login when unauthenticated.
async function isStravaAuthenticated() {
    try {
        const r = await fetch("https://www.strava.com/settings/profile", {
            credentials: "include",
        });
        return r.ok && !/\/login/.test(r.url);
    } catch (_) {
        return false;
    }
}

async function detectAthlete() {
    if (!(await hasStravaPermission())) {
        return { ok: false, needPermission: true };
    }
    let id = await athleteIdFromCookie();
    if (!id) {
        // Fallback: scrape a page. Only patterns that name the OWN athlete.
        const sources = [
            "https://www.strava.com/maps/personal-heatmap",
            "https://www.strava.com/settings/profile",
        ];
        const patterns = [
            /personal-heatmaps-external\.strava\.com\/tiles\/(\d+)\//,
            /"athlete_?[iI]d"\s*:\s*(\d+)/,
            /\\"athleteId\\":(\d+)/,
        ];
        for (const src of sources) {
            try {
                const resp = await fetch(src, { credentials: "include" });
                if (!resp.ok) {
                    continue;
                }
                const text = await resp.text();
                for (const re of patterns) {
                    const m = text.match(re);
                    if (m && m[1]) {
                        id = m[1];
                        break;
                    }
                }
            } catch (_) {
                // try next source
            }
            if (id) {
                break;
            }
        }
    }
    if (id) {
        await api.storage.local.set({ [ATHLETE_KEY]: id });
        console.log("[msh] athlete id detected:", id);
        return { ok: true, athleteId: id };
    }
    const loggedIn = await isStravaAuthenticated();
    console.warn("[msh] athlete id not detected; authenticated to strava:", loggedIn);
    return { ok: false, loggedIn };
}

// ---- Heatmap access gate -----------------------------------------------------
// The heatmap only runs with the full Strava experience behind it: a logged-in
// session AND the CloudFront signed cookies that authorize the tile CDN, which
// Strava hands out when its own heatmap page loads. Without them the tile CDN
// serves at best a low-zoom subset, so rather than show that limited heat, the
// content script hides the overlay and shows a notice until both are present.
//
// Result: { ok: true } or { ok: false, reason } with reason one of
//   "permission" — Firefox: the strava.com host permission was revoked
//   "login"      — not logged in to Strava in this browser
//   "cookies"    — logged in, but the heatmap cookies are missing, expired, or
//                  the tile CDN refuses them (see markHeatmapDenied)
// The latest result is mirrored to storage.local[ACCESS_KEY] so every open Mapy
// tab flips the moment the user logs in on strava.com in another tab.
const ACCESS_KEY = "heatmapAccess";
const DENIED_KEY = "heatmapDeniedTile";
const STRAVA_TILE_URL = /^https:\/\/[a-z0-9-]+\.strava\.com\//;
const CF_SIGNATURE = "CloudFront-Signature";
const CF_KEY_PAIR = "CloudFront-Key-Pair-Id";
// Cookie changes that can flip the result. Strava touches plenty of others
// (analytics etc.) on every page view; those don't need a re-check.
const ACCESS_COOKIES = [
    "_strava_idcf",
    "_strava4_session",
    CF_SIGNATURE,
    CF_KEY_PAIR,
    "CloudFront-Policy",
    "CloudFront-Expires",
];

async function stravaCookieJar() {
    try {
        const storeId = await stravaStoreId();
        // `domain` matches strava.com and every subdomain, whatever the path —
        // the CloudFront cookies may be scoped to the tile host, not www.
        return await api.cookies.getAll(
            storeId ? { domain: "strava.com", storeId } : { domain: "strava.com" }
        );
    } catch (_) {
        return [];
    }
}

// CloudFront's cookie flavour of base64: + -> -, = -> _, / -> ~.
function cloudFrontPolicyExpiry(value) {
    try {
        const json = atob(String(value).replace(/-/g, "+").replace(/_/g, "=").replace(/~/g, "/"));
        const statements = JSON.parse(json).Statement || [];
        let latest = 0;
        for (const s of statements) {
            const t = Number(s && s.Condition && s.Condition.DateLessThan &&
                s.Condition.DateLessThan["AWS:EpochTime"]);
            if (t > latest) {
                latest = t;
            }
        }
        return latest * 1000; // 0 = unknown
    } catch (_) {
        return 0;
    }
}

// The cookie's own expiry usually covers it, but the signed policy is what the
// CDN actually enforces — trust whichever ends first.
function heatmapCookiesExpired(jar, now) {
    for (const c of jar) {
        let until = 0;
        if (c.name === "CloudFront-Policy") {
            until = cloudFrontPolicyExpiry(c.value);
        } else if (c.name === "CloudFront-Expires") {
            until = Number(c.value) * 1000 || 0;
        }
        if (until && until < now) {
            return true;
        }
    }
    return false;
}

async function isLoggedIn(jar) {
    const idcf = jar.find((c) => c.name === "_strava_idcf");
    const payload = idcf && jwtPayload(idcf.value);
    if (payload && !(payload.exp && payload.exp * 1000 < Date.now())) {
        return true;
    }
    // No (or a stale) id cookie: ask Strava itself before calling it a logout —
    // it may have just not re-issued the cookie yet, or renamed it.
    return await isStravaAuthenticated();
}

async function computeHeatmapAccess() {
    if (!(await hasStravaPermission())) {
        return { ok: false, reason: "permission" };
    }
    const jar = await stravaCookieJar();
    if (!(await isLoggedIn(jar))) {
        return { ok: false, reason: "login" };
    }
    const hasCookies =
        jar.some((c) => c.name === CF_SIGNATURE) && jar.some((c) => c.name === CF_KEY_PAIR);
    if (!hasCookies || heatmapCookiesExpired(jar, Date.now())) {
        return { ok: false, reason: "cookies" };
    }
    // The cookies look right, but a tile was refused with them earlier: the gate
    // only reopens once that very tile loads — i.e. the login really works.
    let denied = "";
    try {
        denied = (await api.storage.local.get(DENIED_KEY))[DENIED_KEY] || "";
    } catch (_) {
        // treat as not denied
    }
    if (denied) {
        const probe = await fetchTile(denied);
        // 401/403 = still refused; 0 = offline/unreachable, can't tell yet.
        if (!probe.ok && (probe.status === 401 || probe.status === 403 || probe.status === 0)) {
            return { ok: false, reason: "cookies" };
        }
        try {
            await api.storage.local.remove(DENIED_KEY);
        } catch (_) {
            // ignore
        }
    }
    return { ok: true };
}

const accessKey = (a) => (a ? (a.ok ? "ok" : a.reason || "?") : "");

async function refreshHeatmapAccess() {
    return await publishAccess(await computeHeatmapAccess());
}

async function publishAccess(access) {
    // Compare against the stored copy, not a variable: Chrome's service worker
    // is torn down between events, but storage survives.
    let prev = null;
    try {
        prev = (await api.storage.local.get(ACCESS_KEY))[ACCESS_KEY] || null;
    } catch (_) {
        // treat as unknown
    }
    if (accessKey(access) !== accessKey(prev)) {
        console.log("[msh] heatmap access:", accessKey(access));
        try {
            await api.storage.local.set({ [ACCESS_KEY]: access });
        } catch (_) {
            // tabs still get the direct reply
        }
        if (access.ok) {
            detectAthlete(); // just logged in: personal heat can start right away
        }
    }
    return access;
}

// The tile CDN refused a global tile although the login cookies looked fine, so
// they don't actually work for the heatmap. Keep that tile as the probe: every
// re-check (cookie change, tab focus, A back on) retries it, and the gate stays
// shut until it loads — i.e. until the user has really logged in on strava.com.
// The tile URL (sport/zoom/x/y) is all that's stored; no cookie values.
async function markHeatmapDenied(url) {
    if (typeof url !== "string" || !STRAVA_TILE_URL.test(url)) {
        return await refreshHeatmapAccess();
    }
    try {
        await api.storage.local.set({ [DENIED_KEY]: url });
    } catch (_) {
        // ignore — this tab still gets the reply below
    }
    // It was refused a moment ago: no need to probe it again right now.
    return await publishAccess({ ok: false, reason: "cookies" });
}

// Logging in / opening the Strava heatmap in another tab changes these cookies:
// re-check (debounced — a login sets several at once) and broadcast the result.
let accessTimer = null;
if (api.cookies && api.cookies.onChanged) {
    api.cookies.onChanged.addListener((info) => {
        const c = info && info.cookie;
        if (!c || !ACCESS_COOKIES.includes(c.name) || !/(^|\.)strava\.com$/.test(c.domain || "")) {
            return;
        }
        storeIdCachedAt = 0; // the login may have landed in another container
        clearTimeout(accessTimer);
        accessTimer = setTimeout(() => {
            accessTimer = null;
            refreshHeatmapAccess();
        }, 400);
    });
}

// ---- Send a planned route to Strava (the user's own session) -------------
// Strava's web app uploads a GPX-as-route to this internal endpoint. There's no
// public API for it, so we replicate the same request with the user's cookies
// (which the worker already has). Requires a Strava subscription.
async function getStravaCsrfToken() {
    const resp = await fetch("https://www.strava.com/", { credentials: "include" });
    if (!resp.ok) {
        return null;
    }
    const html = await resp.text();
    const m =
        html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
    return m ? m[1] : null;
}

// Strava's "next data" API uses string enums; /frontend/routes/file returns
// integer codes. Map them when transforming the parsed route into the save body.
const SR_EL_TYPE = { 1: "Waypoint" };
const SR_LEG_TYPE = { 2: "Search" };
const SR_PATH_TYPE = { 1: "Normal" };
const SR_POLY_ENC = { 2: "Google" };
const SR_ELEV_ENC = { 1: "DrewsBadIdea" };
const SR_SURFACE = { 1: "Paved", 2: "Unpaved", 3: "Unknown", 4: "Lift" };
const SR_DIRECTION = { 1: "TurnLeft", 2: "TurnRight", 3: "Straight", 4: "Proceed" };

function pt(p) {
    return { lat: p.lat, lng: p.lng };
}

// Turn the /file parse output into the create-route `props` shape.
function transformParsedRoute(parsed, sport) {
    const r = (parsed && parsed.route) || {};
    const elements = (r.elements || []).map((e) => ({
        elementType: SR_EL_TYPE[e.element_type] || "Waypoint",
        // create-route's waypoint input expects `snapUncertainty` (how far the
        // clicked point was from a snapped road). GPX points are exact, so 0.
        // Sending `metadata` instead — as update-route tolerates — makes
        // create-route fail with "Error resolving field".
        waypoint: { point: pt(e.waypoint.point), snapUncertainty: 0 },
    }));
    const legs = (r.legs || []).map((leg, i) => ({
        legType: SR_LEG_TYPE[leg.leg_type] || "Search",
        startElement: i,
        paths: (leg.paths || []).map((p) => {
            const path = {
                length: p.length,
                elevationGain: p.elevation_gain || 0,
                elevationLoss: p.elevation_loss || 0,
                gradeAdjustedLength: p.grade_adjusted_length,
                pathType: SR_PATH_TYPE[p.path_type] || "Normal",
                origin: pt(p.origin),
                target: pt(p.target),
                surfaceTypeOffsets: (p.surface_type_offsets || []).map((s) => ({
                    distanceOffset: s.distance_offset,
                    surfaceType: SR_SURFACE[s.surface_type] || "Unknown",
                })),
                directions: (p.directions || []).map((d) => ({
                    action: SR_DIRECTION[d.action] || "Straight",
                    distance: d.distance,
                    name: d.name,
                })),
            };
            if (p.elevation) {
                path.elevation = { encoding: SR_ELEV_ENC[p.elevation.encoding] || "DrewsBadIdea", data: p.elevation.data };
            }
            if (p.polyline) {
                path.polyline = { encoding: SR_POLY_ENC[p.polyline.encoding] || "Google", data: p.polyline.data };
            }
            return path;
        }),
    }));
    const routeType = sport === "run" ? "Run" : "Ride";
    return {
        elements,
        legs,
        routePrefs: { routeType, surfaceType: "Unknown", popularity: 0.5, elevation: 0, straightLine: false },
    };
}

async function postNextRoutes(endpoint, token, body) {
    const resp = await fetch("https://www.strava.com/api/next/data/routes/" + endpoint, {
        method: "POST",
        credentials: "include",
        headers: {
            "x-csrf-token": token,
            "x-requested-with": "XMLHttpRequest",
            "content-type": "application/json",
            accept: "application/json, text/plain, */*",
        },
        body: JSON.stringify(body),
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, text };
}

// Pull the route id out of a create-route response. Strava wraps the result in
// a key named after the endpoint ({createRoute: …}); the id may be that value
// itself, or an object carrying id / routeId / route.id. An explicit null means
// the call failed.
function pickRouteId(data) {
    if (!data || typeof data !== "object") {
        return null;
    }
    let inner;
    if ("createRoute" in data) {
        inner = data.createRoute;
    } else if (data.route !== undefined) {
        inner = data.route;
    } else {
        inner = data;
    }
    if (inner === null || inner === undefined) {
        return null;
    }
    if (typeof inner === "number") {
        return String(inner);
    }
    if (typeof inner === "string") {
        return inner;
    }
    if (typeof inner === "object") {
        const id =
            inner.id ||
            inner.routeId ||
            (inner.route && (inner.route.id || inner.route.routeId));
        if (id) {
            return String(id);
        }
    }
    return null;
}

// Persist the route via create-route. update-route only edits an existing route
// (it returns null for a route that doesn't exist yet); create-route makes a new
// one, with the server assigning the id and returning it. The body must carry
// the athleteId and use the snapUncertainty waypoint shape — see
// transformParsedRoute / uploadStravaRoute.
async function persistStravaRoute(token, props) {
    try {
        const res = await postNextRoutes("create-route", token, { props });
        let data = null;
        try { data = JSON.parse(res.text); } catch (_) {}
        const id = res.ok ? pickRouteId(data) : null;
        if (id) {
            return { ok: true, id, url: "https://www.strava.com/routes/" + id, via: "create-route" };
        }
        return { ok: false, error: "create-route " + res.status + ": " + (res.text || "").slice(0, 200) };
    } catch (e) {
        return { ok: false, error: "create-route: " + String(e && e.message ? e.message : e) };
    }
}

async function uploadStravaRoute(gpxText, name, sport) {
    if (!gpxText || gpxText.indexOf("<gpx") === -1) {
        return { ok: false, error: "no-gpx" };
    }
    if (!(await hasStravaPermission())) {
        return { ok: false, needPermission: true };
    }
    const token = await getStravaCsrfToken();
    if (!token) {
        return { ok: false, error: "no-csrf", needLogin: true };
    }
    // Step 1 — parse the GPX into Strava's route structure.
    let parsed;
    try {
        const fname = String(name || "mapy-route").replace(/[^\w.-]+/g, "-").slice(0, 60) + ".gpx";
        const fd = new FormData();
        fd.append("file", new Blob([gpxText], { type: "application/octet-stream" }), fname);
        fd.append("data_type", "gpx");
        fd.append("route_type", sport === "run" ? "2" : "1");
        const resp = await fetch("https://www.strava.com/frontend/routes/file", {
            method: "POST",
            credentials: "include",
            headers: {
                "x-csrf-token": token,
                "x-requested-with": "XMLHttpRequest",
                accept: "application/json, text/plain, */*",
            },
            body: fd,
        });
        const text = await resp.text();
        if (!resp.ok) {
            return { ok: false, status: resp.status, error: "parse: " + text.slice(0, 150) };
        }
        parsed = JSON.parse(text);
    } catch (e) {
        return { ok: false, error: "parse: " + String(e && e.message ? e.message : e) };
    }
    if (!parsed || !parsed.route || !(parsed.route.elements || []).length) {
        return { ok: false, error: "empty-parse" };
    }
    // Step 2 — transform + Step 3 — save (always starred + Only You).
    // create-route needs the athlete id; without it it fails to resolve.
    let athleteId = await athleteIdFromCookie();
    if (!athleteId) {
        const d = await detectAthlete();
        athleteId = (d && d.athleteId) || "";
    }
    if (!athleteId) {
        return { ok: false, error: "no-athlete", needLogin: true };
    }
    const t = transformParsedRoute(parsed, sport);
    const props = {
        name: name || parsed.name || "Mapy route",
        description: "Planned on Mapy.com",
        visibility: "OnlyMe",
        starred: true,
        elements: t.elements,
        legs: t.legs,
        routePrefs: t.routePrefs,
        athleteId: parseInt(athleteId, 10),
    };
    return await persistStravaRoute(token, props);
}

// `return true` + sendResponse for async replies is supported by both Chrome and
// Firefox (returning a Promise instead would work in Firefox but not Chrome).
api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") {
        return false;
    }
    if (msg.type === "fetchTile" && typeof msg.url === "string") {
        fetchTile(msg.url).then(sendResponse);
        return true; // async
    }
    if (msg.type === "detectAthlete") {
        detectAthlete().then(sendResponse);
        return true; // async
    }
    if (msg.type === "checkHeatmapAccess") {
        refreshHeatmapAccess().then(sendResponse);
        return true; // async
    }
    if (msg.type === "heatmapDenied") {
        markHeatmapDenied(msg.url).then(sendResponse);
        return true; // async
    }
    if (msg.type === "uploadStravaRoute" && typeof msg.gpx === "string") {
        uploadStravaRoute(msg.gpx, msg.name, msg.sport).then(sendResponse);
        return true; // async
    }
    return false;
});

// Kick off detection on install/startup so personal heat is ready when possible.
api.runtime.onInstalled.addListener(() => {
    detectAthlete();
    refreshHeatmapAccess();
});
api.runtime.onStartup.addListener(() => {
    detectAthlete();
    refreshHeatmapAccess();
});
// Firefox: the user can grant (or revoke) strava.com access at any time.
if (api.permissions && api.permissions.onAdded) {
    api.permissions.onAdded.addListener(() => {
        detectAthlete();
        refreshHeatmapAccess();
    });
}
if (api.permissions && api.permissions.onRemoved) {
    api.permissions.onRemoved.addListener(() => refreshHeatmapAccess());
}
