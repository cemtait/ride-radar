let rides = [];
let currentRide = null;
let activeFilters = new Set();
let maxDriveMinutes = null;
let showBermBuster = true;
let mapInitialized = false;
let map = null;
let userOrigin = null;

const driveInfo = new Map();
let fetchQueue = [];
let fetchRunning = false;

const RIDE_TYPES = ["trail","cross","enduro","moto","other"];

const TYPE_COLOURS = {
  trail:  "#5c8a3c",
  cross:  "#4a7fa8",
  enduro: "#8b5e3c",
  moto:   "#a07835",
  other:  "#7a7460"
};

const TYPE_BG_COLOURS = {
  trail:  "rgba(92,138,60,0.18)",
  cross:  "rgba(74,127,168,0.18)",
  enduro: "rgba(139,94,60,0.18)",
  moto:   "rgba(160,120,53,0.18)",
  other:  "rgba(122,116,96,0.18)"
};

function rideBgColour(type) {
  return TYPE_BG_COLOURS[rideTypeKey(type)] || TYPE_BG_COLOURS.other;
}

const TYPE_LABELS = {
  trail: "Trail",
  cross: "XC",
  enduro: "Enduro",
  moto: "Moto",
  other: "Other"
};

function rideTypeKey(type) {
  if (!type) return "other";
  const t = type.toLowerCase();
  if (t.includes("trail")) return "trail";
  if (t.includes("cross")) return "cross";
  if (t.includes("enduro")) return "enduro";
  if (t.includes("moto")) return "moto";
  return "other";
}

function rideColour(type) {
  return TYPE_COLOURS[rideTypeKey(type)] || "grey";
}

function formatDrive(ride) {
  if (userOrigin) {
    if (!ride.lat || !ride.lon) return null;
    if (driveInfo.has(ride.link)) {
      const d = driveInfo.get(ride.link);
      if (!d) return null;
      const hrs = Math.floor(d.drive_time_minutes / 60);
      const mins = d.drive_time_minutes % 60;
      const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
      return `${d.distance_km} km · ${timeStr} drive`;
    }
    return "calculating…";
  }
  if (!ride.distance_km || !ride.drive_time_minutes) return null;
  const hrs = Math.floor(ride.drive_time_minutes / 60);
  const mins = ride.drive_time_minutes % 60;
  const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  return `${ride.distance_km} km · ${timeStr} drive`;
}

function isBermBuster(ride) {
  return ride.title && ride.title.toLowerCase().includes("berm buster");
}

function driveTimeOk(ride) {
  if (showBermBuster && isBermBuster(ride)) return true;
  if (!maxDriveMinutes || !userOrigin) return true;
  if (!ride.lat || !ride.lon) return true;
  if (!driveInfo.has(ride.link)) return true;
  const d = driveInfo.get(ride.link);
  if (!d) return true;
  return d.drive_time_minutes <= maxDriveMinutes;
}

function visibleRides() {
  let result = activeFilters.size === 0 ? rides : rides.filter(r => activeFilters.has(rideTypeKey(r.type)));
  return result.filter(driveTimeOk);
}

function safeLink(link) {
  return encodeURIComponent(link);
}

function openRideCard(ride) {
  currentRide = ride;
  document.getElementById("rideTitle").innerText = ride.title;
  document.getElementById("rideDate").innerText = "📅 " + ride.date;
  document.getElementById("rideType").innerText = "🏍️ " + ride.type;
  document.getElementById("rideDistrict").innerText = "📍 " + ride.district;
  document.getElementById("rideAddress").innerText = ride.originalAddress || "";
  const drive = formatDrive(ride);
  document.getElementById("rideDrive").innerText = drive ? "🚗 " + drive : "";
  document.getElementById("rideCard").classList.remove("hidden");
}

document.getElementById("closeCard").onclick = () => {
  document.getElementById("rideCard").classList.add("hidden");
};

document.getElementById("openEventBtn").onclick = () => {
  if (currentRide) window.open(currentRide.link, "_blank");
};

document.getElementById("calendarBtn").onclick = () => {
  if (!currentRide) return;
  const date = currentRide.date.replace(/[a-z]/gi, "");
  const ics = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nSUMMARY:${currentRide.title}\nDESCRIPTION:${currentRide.type}\nLOCATION:${currentRide.originalAddress || currentRide.district}\nURL:${currentRide.link}\nDTSTART:${date}\nEND:VEVENT\nEND:VCALENDAR`;
  const blob = new Blob([ics], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ride.ics";
  a.click();
  URL.revokeObjectURL(url);
};

function updateRideDriveSpan(ride) {
  if (!driveTimeOk(ride)) {
    const row = document.querySelector(`.ride-item[data-link="${CSS.escape(ride.link)}"]`);
    if (row) row.remove();
    return;
  }

  const el = document.querySelector(`.ride-item[data-link="${CSS.escape(ride.link)}"] .ride-drive`);
  if (!el) return;
  const drive = formatDrive(ride);
  el.textContent = drive ? "🚗 " + drive : "";
  el.style.display = drive ? "" : "none";

  if (currentRide && currentRide.link === ride.link) {
    document.getElementById("rideDrive").innerText = drive ? "🚗 " + drive : "";
  }
}

function initDriveFilter() {
  const saved = localStorage.getItem("rideRadarMaxDrive");
  maxDriveMinutes = saved ? parseInt(saved, 10) : null;

  document.querySelectorAll(".dt-btn").forEach(btn => {
    const val = btn.dataset.mins;
    const isActive = val === "" ? !maxDriveMinutes : parseInt(val, 10) === maxDriveMinutes;
    btn.classList.toggle("active", isActive);

    btn.addEventListener("click", () => {
      maxDriveMinutes = val === "" ? null : parseInt(val, 10);
      localStorage.setItem("rideRadarMaxDrive", val);
      document.querySelectorAll(".dt-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.mins === val)
      );
      renderList();
      renderMapMarkers();
    });
  });
}

function initBermBusterPref() {
  const saved = localStorage.getItem("rideRadarShowBermBuster");
  showBermBuster = saved === null ? true : saved === "true";

  const toggle = document.getElementById("showBermBuster");
  toggle.checked = showBermBuster;

  toggle.addEventListener("change", () => {
    showBermBuster = toggle.checked;
    localStorage.setItem("rideRadarShowBermBuster", showBermBuster ? "true" : "false");
    renderList();
    renderMapMarkers();
  });
}

function renderList() {
  const container = document.getElementById("rideList");
  const visible = visibleRides();
  if (visible.length === 0) {
    container.innerHTML = "<p style='color:#888;padding:20px'>No rides to show.</p>";
    return;
  }
  container.innerHTML = visible.map(ride => {
    const colour = rideColour(ride.type);
    const bg = rideBgColour(ride.type);
    const drive = formatDrive(ride);
    const idx = rides.indexOf(ride);
    return `<div class="ride-item" data-link="${ride.link}" style="background:${bg}; border-left:4px solid ${colour}" onclick="openRideCard(rides[${idx}])">
      <div class="ride-item-title">${ride.title}</div>
      <div class="ride-item-meta">
        <span>📅 ${ride.date}</span>
        <span>📍 ${ride.district}</span>
        <span>${ride.type}</span>
        <span class="ride-drive" ${drive ? "" : 'style="display:none"'}>${drive ? "🚗 " + drive : ""}</span>
      </div>
    </div>`;
  }).join("");
}

function initMap() {
  if (mapInitialized) return;
  mapInitialized = true;
  map = L.map("map").setView([-41.2, 174.7], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap"
  }).addTo(map);
  renderMapMarkers();
}

function renderMapMarkers() {
  if (!map) return;
  map.eachLayer(layer => {
    if (layer instanceof L.CircleMarker) map.removeLayer(layer);
  });
  const points = [];
  visibleRides().forEach(ride => {
    if (!ride.lat || !ride.lon) return;
    const colour = rideColour(ride.type);
    L.circleMarker([ride.lat, ride.lon], {
      radius: 8,
      color: colour,
      fillColor: colour,
      fillOpacity: 0.9
    }).addTo(map).on("click", () => openRideCard(ride));
    points.push([ride.lat, ride.lon]);
  });
  if (points.length > 0) {
    map.fitBounds(points, { padding: [24, 24], maxZoom: 12 });
  }
}

function renderTypeFilters() {
  const container = document.getElementById("typeFilters");
  container.innerHTML = RIDE_TYPES.map(t => {
    const label = TYPE_LABELS[t] || (t.charAt(0).toUpperCase() + t.slice(1));
    const colour = TYPE_COLOURS[t];
    return `<button class="type-filter-btn on" data-type="${t}" style="border-color:${colour}">
      <span class="ride-type-dot" style="background:${colour}"></span>${label}
    </button>`;
  }).join("");
  container.querySelectorAll(".type-filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.type;
      if (activeFilters.size === 0) {
        RIDE_TYPES.forEach(rt => activeFilters.add(rt));
        activeFilters.delete(t);
        btn.classList.remove("on");
      } else if (activeFilters.has(t)) {
        activeFilters.delete(t);
        btn.classList.remove("on");
        if (activeFilters.size === 0) {
          container.querySelectorAll(".type-filter-btn").forEach(b => b.classList.add("on"));
        }
      } else {
        activeFilters.add(t);
        btn.classList.add("on");
        if (activeFilters.size === RIDE_TYPES.length) {
          activeFilters.clear();
          container.querySelectorAll(".type-filter-btn").forEach(b => b.classList.add("on"));
        }
      }
      renderList();
      renderMapMarkers();
    });
  });
}

function buildFetchQueue(origin) {
  const visible = new Set(visibleRides().map(r => r.link));
  const withCoords = rides.filter(r => r.lat && r.lon);
  const prioritised = [
    ...withCoords.filter(r => visible.has(r.link)),
    ...withCoords.filter(r => !visible.has(r.link))
  ];
  return prioritised.filter(r => !driveInfo.has(r.link));
}

async function runFetchQueue(origin) {
  if (fetchRunning) return;
  fetchRunning = true;

  while (fetchQueue.length > 0) {
    if (!userOrigin || userOrigin.lat !== origin.lat || userOrigin.lon !== origin.lon) break;

    const ride = fetchQueue.shift();
    if (driveInfo.has(ride.link)) continue;

    try {
      const res = await fetch("/drive-time", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originLat: origin.lat,
          originLon: origin.lon,
          rideLat: ride.lat,
          rideLon: ride.lon,
          rideLink: ride.link
        })
      });
      const data = await res.json();
      driveInfo.set(ride.link, data);
      updateRideDriveSpan(ride);
    } catch {
      driveInfo.set(ride.link, null);
    }
  }

  fetchRunning = false;
}

function startDriveFetch(origin) {
  driveInfo.clear();
  fetchQueue = buildFetchQueue(origin);
  renderList();
  runFetchQueue(origin);
}

function setGpsStatus(msg, state) {
  const el = document.getElementById("gpsStatus");
  el.textContent = msg;
  el.className = "gps-status" + (state ? " " + state : "");
}

function applyOrigin(lat, lon, label) {
  userOrigin = { lat, lon, label };
  startDriveFetch(userOrigin);
}

function requestGPS() {
  if (!navigator.geolocation) {
    setGpsStatus("GPS not supported on this device.", "err");
    return;
  }
  setGpsStatus("Acquiring location…");
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude: lat, longitude: lon } = pos.coords;
      setGpsStatus(`📍 Using your current location (${lat.toFixed(4)}, ${lon.toFixed(4)})`, "ok");
      applyOrigin(lat, lon, "Your location");
    },
    err => {
      const msgs = { 1: "Location permission denied.", 2: "Location unavailable.", 3: "Location request timed out." };
      setGpsStatus((msgs[err.code] || "Could not get location.") + " Use the manual address below.", "err");
    },
    { timeout: 10000 }
  );
}

async function geocodeManualAddress() {
  const address = document.getElementById("prefAddress").value.trim();
  if (!address) return;
  const msgEl = document.getElementById("prefMsg");
  msgEl.style.color = "#aaa";
  msgEl.textContent = "Looking up address…";
  try {
    const url = "https://nominatim.openstreetmap.org/search?q=" +
      encodeURIComponent(address) + "&format=json&limit=1";
    const res = await fetch(url, { headers: { "User-Agent": "RideRadar/1.0" } });
    const data = await res.json();
    if (!data.length) {
      msgEl.style.color = "#e57373";
      msgEl.textContent = "Address not found. Try a more specific address.";
      return;
    }
    const lat = parseFloat(data[0].lat);
    const lon = parseFloat(data[0].lon);
    const found = data[0].display_name;
    msgEl.style.color = "#4caf50";
    msgEl.textContent = "✓ Found: " + found;
    localStorage.setItem("rideRadarManualOrigin", JSON.stringify({ lat, lon, address: found }));
    applyOrigin(lat, lon, found);
  } catch {
    msgEl.style.color = "#e57373";
    msgEl.textContent = "Error looking up address.";
  }
}

function initPrefs() {
  const gpsToggle = document.getElementById("useGPS");
  const manualDiv = document.getElementById("manualOrigin");

  const savedManual = JSON.parse(localStorage.getItem("rideRadarManualOrigin") || "null");
  const useGPSSaved = localStorage.getItem("rideRadarUseGPS");
  const gpsOn = useGPSSaved !== "false";

  gpsToggle.checked = gpsOn;

  if (!gpsOn) {
    manualDiv.classList.remove("disabled");
    if (savedManual) {
      document.getElementById("prefAddress").value = savedManual.address;
      applyOrigin(savedManual.lat, savedManual.lon, savedManual.address);
      setGpsStatus("GPS off — using manual address.");
    }
  } else {
    requestGPS();
  }

  gpsToggle.addEventListener("change", () => {
    const on = gpsToggle.checked;
    localStorage.setItem("rideRadarUseGPS", on ? "true" : "false");
    if (on) {
      manualDiv.classList.add("disabled");
      requestGPS();
    } else {
      manualDiv.classList.remove("disabled");
      setGpsStatus("GPS off — enter an address below.");
      userOrigin = null;
      driveInfo.clear();
      fetchQueue = [];
      renderList();
    }
  });

  document.getElementById("geocodeBtn").addEventListener("click", geocodeManualAddress);
}

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(target).classList.add("active");
    document.getElementById("rideCard").classList.add("hidden");
    if (target === "tab-map") {
      initMap();
      setTimeout(() => map && map.invalidateSize(), 50);
    }
  });
});

async function loadRides() {
  const res = await fetch("/rides");
  rides = await res.json();
  initDriveFilter();
  initBermBusterPref();
  renderList();
  renderTypeFilters();
  initPrefs();
}

loadRides();
