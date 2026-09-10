// Builds the extension for Chrome and Firefox into dist/<target>/.
//
// The two stores need genuinely different manifests, so rather than keep two
// copies in sync, extension/manifest.json is the single source of truth (in its
// Chrome form, so `Load unpacked` on extension/ keeps working) and the per-target
// deltas live in TARGETS below.
//
//   node scripts/build.mjs            # both targets
//   node scripts/build.mjs firefox    # one target
//
// Firefox-specific differences and why:
//   - background: Firefox has no MV3 service workers — it uses a non-persistent
//     event page via `background.scripts`. Chrome only accepts `service_worker`.
//   - browser_specific_settings.gecko: AMO requires a stable add-on id and (as of
//     2025) a data-collection disclosure. strict_min_version is 128.0 because
//     content_scripts `"world": "MAIN"` — which mapy-hook.js needs to see the
//     page's own fetch/XHR — only landed in Firefox 128.

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "extension");
const DIST = join(ROOT, "dist");

// Everything that ships. Dev-only files (STORE.md, store-assets/, icons/icon.svg)
// are deliberately absent — an unexpected file is a store-review flag.
const FILES = [
    "background.js",
    "content.js",
    "mapy-hook.js",
    "panel.css",
    "popup.html",
    "popup.js",
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
];

const TARGETS = {
    chrome: (m) => m,
    firefox: (m) => {
        // Firefox: event page, not a service worker.
        m.background = { scripts: ["background.js"] };
        // Firefox withholds SameSite cookies from extension-initiated requests, so
        // background.js re-attaches them via blocking webRequest (which Firefox MV3
        // still supports and Chrome does not). Chrome must not get these.
        m.permissions = [...m.permissions, "webRequest", "webRequestBlocking"];
        m.browser_specific_settings = {
            gecko: {
                id: "heatmapy@matejcermak.github.io",
                strict_min_version: "128.0",
                data_collection_permissions: { required: ["none"] },
            },
        };
        return m;
    },
};

async function build(target) {
    const out = join(DIST, target);
    await rm(out, { recursive: true, force: true });
    await mkdir(join(out, "icons"), { recursive: true });

    for (const f of FILES) {
        await cp(join(SRC, f), join(out, f));
    }

    const base = JSON.parse(await readFile(join(SRC, "manifest.json"), "utf8"));
    const manifest = TARGETS[target](base);
    await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

    console.log(`built dist/${target} (v${manifest.version})`);
    return manifest.version;
}

const requested = process.argv.slice(2);
const targets = requested.length ? requested : Object.keys(TARGETS);
for (const t of targets) {
    if (!TARGETS[t]) {
        console.error(`unknown target: ${t} (expected: ${Object.keys(TARGETS).join(", ")})`);
        process.exit(1);
    }
    await build(t);
}
