// Service worker: the one thing a content script can't do in MV3 is a
// credentialed cross-origin fetch (CORS blocks it). With host_permissions for
// *.strava.com, the worker can fetch Strava heatmap tiles with the user's
// cookies attached and hand the bytes back to the content script.

const ATHLETE_KEY = "stravaAthleteId";

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

// The reliable source: Strava's `_strava_idcf` cookie is a JWT whose payload
// holds the logged-in athlete id. (Scraping a page can match the WRONG athlete.)
async function athleteIdFromCookie() {
    try {
        const c = await chrome.cookies.get({
            url: "https://www.strava.com",
            name: "_strava_idcf",
        });
        if (c && c.value && c.value.split(".").length >= 2) {
            const payload = JSON.parse(b64urlDecode(c.value.split(".")[1]));
            if (payload && payload.athleteId) {
                return String(payload.athleteId);
            }
        }
    } catch (_) {
        // ignore
    }
    return "";
}

async function detectAthlete() {
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
        await chrome.storage.local.set({ [ATHLETE_KEY]: id });
        console.log("[msh] athlete id detected:", id);
        return { ok: true, athleteId: id };
    }
    return { ok: false };
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
    if (msg.type === "uploadStravaRoute" && typeof msg.gpx === "string") {
        uploadStravaRoute(msg.gpx, msg.name, msg.sport).then(sendResponse);
        return true; // async
    }
    return false;
});

// Kick off detection on install/startup so personal heat is ready when possible.
chrome.runtime.onInstalled.addListener(() => detectAthlete());
chrome.runtime.onStartup.addListener(() => detectAthlete());
