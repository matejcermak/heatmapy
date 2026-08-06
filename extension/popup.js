// Promise-based extension APIs: `browser` in Firefox, `chrome` in Chrome MV3.
// (Firefox's `chrome` alias is callback-only, so awaiting it there returns
// undefined — always go through `api`.)
const api = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;

const ATHLETE_KEY = "stravaAthleteId";
const STRAVA_ORIGIN = "*://*.strava.com/*";
const statusEl = document.getElementById("athStatus");
const input = document.getElementById("athInput");
const permRow = document.getElementById("permRow");

function show(id, detail) {
    if (id) {
        statusEl.textContent = "ready (athlete " + id + ")";
        statusEl.className = "ok";
        input.value = id;
    } else {
        statusEl.textContent = detail || "not detected — log in to Strava";
        statusEl.className = "bad";
    }
}

// Firefox MV3 grants host permissions at install (127+) but the user can revoke
// them at any time, which silently breaks every Strava request. Offer a button to
// grant them back — `permissions.request` needs the popup's user gesture.
async function refreshPermissionRow() {
    if (!permRow) {
        return true;
    }
    let granted = true;
    try {
        if (api.permissions && api.permissions.contains) {
            granted = await api.permissions.contains({ origins: [STRAVA_ORIGIN] });
        }
    } catch (_) {
        granted = true; // can't tell — don't nag
    }
    permRow.hidden = granted;
    return granted;
}

document.getElementById("grantPerm").addEventListener("click", async () => {
    try {
        await api.permissions.request({ origins: [STRAVA_ORIGIN] });
    } catch (_) {
        // user dismissed the prompt
    }
    if (await refreshPermissionRow()) {
        detect();
    }
});

async function detect() {
    statusEl.textContent = "detecting…";
    statusEl.className = "muted";
    try {
        const r = await api.runtime.sendMessage({ type: "detectAthlete" });
        if (r && r.needPermission) {
            statusEl.textContent = "needs access to strava.com — grant it above";
            statusEl.className = "bad";
            refreshPermissionRow();
            return;
        }
        if (r && r.ok) {
            show(r.athleteId);
        } else if (r && r.loggedIn) {
            show("", "logged in, but couldn't read your ID — paste it below");
        } else {
            show("", "not detected — log in to Strava, then retry");
        }
    } catch (_) {
        show("");
    }
}

(async () => {
    await refreshPermissionRow();
    let stored = "";
    try {
        const res = await api.storage.local.get(ATHLETE_KEY);
        stored = (res && res[ATHLETE_KEY]) || "";
    } catch (_) {
        // fall through to detection
    }
    if (stored) {
        show(stored);
        return;
    }
    // Nothing stored yet (fresh profile, or install-time detection ran before the
    // Strava login existed) — detect now rather than showing a dead end.
    detect();
})();

document.getElementById("detect").addEventListener("click", detect);

document.getElementById("save").addEventListener("click", async () => {
    const id = (input.value || "").trim().replace(/[^0-9]/g, "");
    if (!id) {
        return;
    }
    try {
        await api.storage.local.set({ [ATHLETE_KEY]: id });
    } catch (_) {
        // ignore
    }
    show(id);
});
