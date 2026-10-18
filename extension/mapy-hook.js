// Runs in the PAGE's MAIN world (not the isolated content-script world) so it can
// see Mapy.com's own objects and network calls, which content scripts can't.
// Two jobs, both read-only — it never blocks or alters anything of Mapy's:
//
//  1. Live camera feed. Mapy now draws the map with a WebAssembly/WebGL engine
//     and only writes x/y/z into the URL once a pan or zoom animation has
//     finished, so following the URL left the heat frozen mid-gesture. The
//     engine's MapControl exposes the camera as it moves; read it every frame
//     and hand it to the content script (content.js, "msh-camera" event).
//  2. GPX export URL. Spot the planner's export request
//     (/api/tplannerexport?...export=gpx) and forward it via window.postMessage.
(function () {
    "use strict";

    // ---- 1. Live camera ------------------------------------------------------
    const CAMERA_EVENT = "msh-camera";
    const HEARTBEAT_MS = 1000; // re-send an unchanged camera so content.js knows the feed is alive
    const PROBE_M = 1000; // east offset (meters) used to measure on-screen scale + rotation

    let control = null; // Mapy's wasm MapControl
    let geo = null; // its GeoMath (WGS84 <-> Web Mercator meters)
    let busy = false;
    let lastKey = "";
    let lastSentAt = 0;

    // Mapy._wasm.wasm only exists once the engine has booted (and is replaced if
    // it reboots after a lost GL context), so look it up lazily and re-check.
    function resolveControl() {
        try {
            const w = window.Mapy && window.Mapy._wasm && window.Mapy._wasm.wasm;
            const mc = w && w.mapControl;
            const gm = w && w.module && w.module.GeoMath;
            if (mc && gm && typeof mc.mapPosToScreenPos === "function") {
                control = mc;
                geo = gm;
                return true;
            }
        } catch (_) { /* engine not ready */ }
        control = null;
        geo = null;
        return false;
    }

    function mapCanvasRect() {
        const c = document.getElementById("wasm-canvas");
        if (!c) {
            return null;
        }
        const r = c.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? r : null;
    }

    async function readCamera() {
        if (!control && !resolveControl()) {
            return null;
        }
        const rect = mapCanvasRect();
        if (!rect) {
            return null; // engine hidden (e.g. the separate 3D view) — content.js falls back to the URL
        }
        const pos = await control.getPositionWgs();
        const merc = geo.wgsToMercator(pos);
        const [center, east, tilt] = await Promise.all([
            control.mapPosToScreenPos(merc),
            control.mapPosToScreenPos({ x: merc.x + PROBE_M, y: merc.y }),
            control.getTiltAngle(),
        ]);
        // Screen px per Mercator meter -> standard web-map zoom (256 px tiles).
        const dx = east.x - center.x;
        const dy = east.y - center.y;
        const pxPerM = Math.hypot(dx, dy) / PROBE_M;
        if (!(pxPerM > 0)) {
            return null;
        }
        // Rounded so an integer zoom (the usual resting state) comes out exactly
        // integer, not 12.9999999 — content.js floors it to pick the tile level.
        const zoom = Math.round(Math.log2((pxPerM * 2 * Math.PI * 6378137) / 256) * 1e6) / 1e6;
        return {
            lon: pos.x,
            lat: pos.y,
            zoom,
            rot: Math.atan2(dy, dx), // CSS rotation of the map, radians (clockwise)
            tilt: Number(tilt) || 0, // degrees; a tilted (perspective) map can't be matched by a flat overlay
            // center of the view, in viewport CSS px
            cx: rect.left + center.x,
            cy: rect.top + center.y,
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
        };
    }

    function send(cam) {
        const key = [
            cam.lon.toFixed(9), cam.lat.toFixed(9), cam.zoom.toFixed(6), cam.rot.toFixed(5),
            cam.tilt.toFixed(2), cam.cx.toFixed(2), cam.cy.toFixed(2), cam.width, cam.height,
        ].join("|");
        const now = performance.now();
        if (key === lastKey && now - lastSentAt < HEARTBEAT_MS) {
            return;
        }
        lastKey = key;
        lastSentAt = now;
        // Synchronous, and a string `detail` is readable from the content script's
        // isolated world in both Chrome and Firefox (objects are not).
        document.dispatchEvent(new CustomEvent(CAMERA_EVENT, { detail: JSON.stringify(cam) }));
    }

    function frame() {
        requestAnimationFrame(frame);
        if (busy || document.hidden) {
            return;
        }
        busy = true;
        readCamera()
            .then((cam) => {
                if (cam) {
                    send(cam);
                }
            })
            .catch(() => {
                control = null; // engine torn down / rebooted — look it up again next frame
            })
            .finally(() => {
                busy = false;
            });
    }
    requestAnimationFrame(frame);

    // ---- 2. GPX export URL ---------------------------------------------------
    function isExportUrl(u) {
        return typeof u === "string"
            && u.indexOf("tplannerexport") !== -1
            && u.indexOf("export=gpx") !== -1;
    }
    function report(u) {
        try {
            const abs = new URL(u, location.origin).toString();
            window.postMessage({ source: "msh-mapy-export", url: abs }, location.origin);
        } catch (_) { /* ignore */ }
    }

    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
        window.fetch = function (input, init) {
            try {
                const u = typeof input === "string" ? input : (input && input.url);
                if (isExportUrl(u)) {
                    report(u);
                }
            } catch (_) { /* ignore */ }
            return origFetch.apply(this, arguments);
        };
    }

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        try {
            if (isExportUrl(url)) {
                report(url);
            }
        } catch (_) { /* ignore */ }
        return origOpen.apply(this, arguments);
    };
})();
