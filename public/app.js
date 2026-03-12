let rides = [];
let currentRide = null;
let activeFilters = new Set();
let mapInitialized = false;
let map = null;

const RIDE_TYPES = ["trail","cross","enduro","moto","trial","other"];

const TYPE_COLOURS = {
  trail: "green",
  cross: "blue",
  enduro: "orange",
  moto: "red",
  trial: "purple",
  other: "grey"
};

function rideTypeKey(type) {
  if (!type) return "other";
  const t = type.toLowerCase();
  if (t.includes("trail")) return "trail";
  if (t.includes("cross")) return "cross";
  if (t.includes("enduro")) return "enduro";
  if (t.includes("moto")) return "moto";
  if (t.includes("trial")) return "trial";
  return "other";
}

function rideColour(type) {
  return TYPE_COLOURS[rideTypeKey(type)] || "grey";
}

function formatDrive(ride) {
  if (!ride.distance_km || !ride.drive_time_minutes) return null;
  const hrs = Math.floor(ride.drive_time_minutes / 60);
  const mins = ride.drive_time_minutes % 60;
  const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  return `${ride.distance_km} km · ${timeStr} drive`;
}

function visibleRides() {
  if (activeFilters.size === 0) return rides;
  return rides.filter(r => activeFilters.has(rideTypeKey(r.type)));
}

function openRideCard(ride) {
  currentRide = ride;
  document.getElementById("rideTitle").innerText = ride.title;
  document.getElementById("rideDate").innerText = "📅 " + ride.date;
  document.getElementById("rideType").innerText = "🏍️ " + ride.type;
  document.getElementById("rideDistrict").innerText = "📍 " + ride.district;
  document.getElementById("rideAddress").innerText = ride.originalAddress ? ride.originalAddress : "";
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

function renderList() {
  const container = document.getElementById("rideList");
  const visible = visibleRides();
  if (visible.length === 0) {
    container.innerHTML = "<p style='color:#888;padding:20px'>No rides to show.</p>";
    return;
  }
  container.innerHTML = visible.map((ride, i) => {
    const colour = rideColour(ride.type);
    const drive = formatDrive(ride);
    return `<div class="ride-item" data-idx="${i}" onclick="openRideCard(rides[${rides.indexOf(ride)}])">
      <div class="ride-item-title">
        <span class="ride-type-dot" style="background:${colour}"></span>${ride.title}
      </div>
      <div class="ride-item-meta">
        <span>📅 ${ride.date}</span>
        <span>📍 ${ride.district}</span>
        <span>${ride.type}</span>
        ${drive ? `<span>🚗 ${drive}</span>` : ""}
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
  visibleRides().forEach(ride => {
    if (!ride.lat || !ride.lon) return;
    const colour = rideColour(ride.type);
    L.circleMarker([ride.lat, ride.lon], {
      radius: 8,
      color: colour,
      fillColor: colour,
      fillOpacity: 0.9
    }).addTo(map).on("click", () => openRideCard(ride));
  });
}

function renderTypeFilters() {
  const container = document.getElementById("typeFilters");
  container.innerHTML = RIDE_TYPES.map(t => {
    const label = t.charAt(0).toUpperCase() + t.slice(1);
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

function loadPrefs() {
  const prefs = JSON.parse(localStorage.getItem("rideRadarPrefs") || "{}");
  document.getElementById("prefOriginName").value = prefs.originName || "Auckland";
  document.getElementById("prefLat").value = prefs.lat || -36.8485;
  document.getElementById("prefLon").value = prefs.lon || 174.7633;
}

document.getElementById("savePrefs").onclick = async () => {
  const name = document.getElementById("prefOriginName").value.trim();
  const lat = parseFloat(document.getElementById("prefLat").value);
  const lon = parseFloat(document.getElementById("prefLon").value);
  if (isNaN(lat) || isNaN(lon)) {
    document.getElementById("prefMsg").innerText = "Please enter valid coordinates.";
    return;
  }
  localStorage.setItem("rideRadarPrefs", JSON.stringify({ originName: name, lat, lon }));
  document.getElementById("prefMsg").innerText = "Saved! Drive distances will update on next refresh.";
};

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
  renderList();
  renderTypeFilters();
  loadPrefs();
}

loadRides();
