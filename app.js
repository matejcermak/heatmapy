const map = L.map("map", {
  center: [49.8175, 15.473],
  zoom: 8,
});

// Use open map tiles to simulate Mapy-like outdoor planning styles.
const baseLayers = {
  outdoor: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    maxZoom: 19,
  }),
  aerial: L.tileLayer(
    "https://services.arcgisonline.com/ArcGIS/rest/services/" +
      "World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      attribution: "Tiles &copy; Esri",
      maxZoom: 18,
    }
  ),
  winter: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenTopoMap contributors",
    maxZoom: 17,
  }),
};

let activeBaseLayer = baseLayers.outdoor.addTo(map);

const poiLayer = L.layerGroup().addTo(map);
const contourLayer = L.tileLayer(
  "https://tile.opentopomap.org/{z}/{x}/{y}.png",
  {
    attribution: "&copy; OpenTopoMap",
    maxZoom: 17,
    opacity: 0.25,
  }
);
const trafficLayer = L.layerGroup();

const routePoints = [];
const routeMarkers = [];
let routeLine = L.polyline([], {
  color: "#14532d",
  weight: 4,
  opacity: 0.85,
}).addTo(map);

const ui = {
  baseStyle: document.getElementById("base-style"),
  togglePoi: document.getElementById("toggle-poi"),
  toggleContours: document.getElementById("toggle-contours"),
  toggleTraffic: document.getElementById("toggle-traffic"),
  toggleHeatmap: document.getElementById("toggle-heatmap"),
  heatmapSport: document.getElementById("heatmap-sport"),
  heatmapStyle: document.getElementById("heatmap-style"),
  heatmapOpacity: document.getElementById("heatmap-opacity"),
  statPoints: document.getElementById("stat-points"),
  statDistance: document.getElementById("stat-distance"),
  syncStatus: document.getElementById("sync-status"),
  undoPoint: document.getElementById("undo-point"),
  clearRoute: document.getElementById("clear-route"),
};

// Add sample POIs so POI toggle has visible behavior.
[
  [50.0755, 14.4378, "Prague center"],
  [49.1951, 16.6068, "Brno center"],
  [49.7384, 13.3736, "Pilsen center"],
].forEach(([lat, lng, label]) => {
  L.marker([lat, lng]).bindPopup(label).addTo(poiLayer);
});

// Simulated traffic overlay.
const trafficPath = [
  [50.08, 14.35],
  [50.02, 14.54],
  [49.95, 14.7],
];
L.polyline(trafficPath, {
  color: "#dc2626",
  weight: 6,
  opacity: 0.5,
  dashArray: "8,6",
}).addTo(trafficLayer);

const stravaConfig = {
  sport: "ride",
  style: "hot",
  // If needed, place personal Strava auth query params here, e.g.
  // "?Key-Pair-Id=...&Policy=...&Signature=..."
  authQuery: "",
};

let heatmapLayer = null;

function getHeatmapTemplate() {
  const { sport, style } = stravaConfig;
  return (
    "https://heatmap-external-{s}.strava.com/tiles/" +
    `${sport}/${style}/{z}/{x}/{y}.png${stravaConfig.authQuery}`
  );
}

function rebuildHeatmapLayer() {
  const isEnabled = ui.toggleHeatmap.checked;
  const opacity = Number(ui.heatmapOpacity.value) / 100;
  if (heatmapLayer) {
    map.removeLayer(heatmapLayer);
    heatmapLayer = null;
  }

  heatmapLayer = L.tileLayer(getHeatmapTemplate(), {
    attribution:
      '&copy; <a href="https://www.strava.com/maps/global-heatmap">Strava</a>',
    subdomains: "abc",
    opacity,
    maxZoom: 16,
    tileSize: 256,
    crossOrigin: true,
  });

  if (isEnabled) {
    heatmapLayer.addTo(map);
  }
}

function setSyncStatus(message) {
  ui.syncStatus.textContent = message;
}

function syncHeatmapToView() {
  if (!heatmapLayer || !ui.toggleHeatmap.checked) {
    setSyncStatus("Heatmap hidden");
    return;
  }
  heatmapLayer.redraw();
  setSyncStatus(`Synced @ z${map.getZoom()}`);
}

function updateRouteStats() {
  ui.statPoints.textContent = String(routePoints.length);
  let distanceKm = 0;
  for (let i = 1; i < routePoints.length; i += 1) {
    distanceKm += routePoints[i - 1].distanceTo(routePoints[i]) / 1000;
  }
  ui.statDistance.textContent = `${distanceKm.toFixed(1)} km`;
}

function rerenderRoute() {
  routeLine.setLatLngs(routePoints);
  routeMarkers.forEach((marker) => map.removeLayer(marker));
  routeMarkers.length = 0;
  routePoints.forEach((point, index) => {
    const marker = L.marker(point, {
      icon: L.divIcon({
        className: "route-point",
        html: String(index + 1),
        iconSize: [18, 18],
      }),
    }).addTo(map);
    routeMarkers.push(marker);
  });
  updateRouteStats();
}

map.on("click", (event) => {
  routePoints.push(event.latlng);
  rerenderRoute();
});

map.on("moveend zoomend", syncHeatmapToView);

ui.baseStyle.addEventListener("change", () => {
  const next = baseLayers[ui.baseStyle.value];
  if (!next || next === activeBaseLayer) {
    return;
  }
  map.removeLayer(activeBaseLayer);
  activeBaseLayer = next.addTo(map);
  syncHeatmapToView();
});

ui.togglePoi.addEventListener("change", () => {
  if (ui.togglePoi.checked) {
    poiLayer.addTo(map);
  } else {
    map.removeLayer(poiLayer);
  }
});

ui.toggleContours.addEventListener("change", () => {
  if (ui.toggleContours.checked) {
    contourLayer.addTo(map);
  } else {
    map.removeLayer(contourLayer);
  }
});

ui.toggleTraffic.addEventListener("change", () => {
  if (ui.toggleTraffic.checked) {
    trafficLayer.addTo(map);
  } else {
    map.removeLayer(trafficLayer);
  }
});

ui.toggleHeatmap.addEventListener("change", () => {
  if (!heatmapLayer) {
    rebuildHeatmapLayer();
  } else if (ui.toggleHeatmap.checked) {
    heatmapLayer.addTo(map);
  } else {
    map.removeLayer(heatmapLayer);
  }
  syncHeatmapToView();
});

ui.heatmapSport.addEventListener("change", () => {
  stravaConfig.sport = ui.heatmapSport.value;
  rebuildHeatmapLayer();
  syncHeatmapToView();
});

ui.heatmapStyle.addEventListener("change", () => {
  stravaConfig.style = ui.heatmapStyle.value;
  rebuildHeatmapLayer();
  syncHeatmapToView();
});

ui.heatmapOpacity.addEventListener("input", () => {
  if (!heatmapLayer) {
    return;
  }
  const opacity = Number(ui.heatmapOpacity.value) / 100;
  heatmapLayer.setOpacity(opacity);
});

ui.undoPoint.addEventListener("click", () => {
  if (routePoints.length === 0) {
    return;
  }
  routePoints.pop();
  rerenderRoute();
});

ui.clearRoute.addEventListener("click", () => {
  routePoints.length = 0;
  rerenderRoute();
});

rebuildHeatmapLayer();
syncHeatmapToView();
updateRouteStats();
