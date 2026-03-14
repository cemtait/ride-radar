let rides = [];
let currentRide = null;
let activeFilters = new Set();
let maxDriveMinutes = null;
let showBermBuster = true;
let driveDisplay = "time";
let reminderDays = 7;
let searchQuery = "";
let userOrigin = null;
let lastFetched = null;

const driveInfo = new Map();
const imageOrientations = new Map();
let fetchQueue = [];
let fetchRunning = false;

const MAP_PIN_SVG = `<svg class="ride-map-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;

const RIDE_TYPES = ["trail","cross","enduro","moto","other"];

const TYPE_COLOURS = {
  trail:  "#5c8a3c",
  cross:  "#4a7fa8",
  enduro: "#c8952a",
  moto:   "#b04520",
  other:  "#909090"
};

const TYPE_BG_COLOURS = {
  trail:  "rgba(92,138,60,0.25)",
  cross:  "rgba(74,127,168,0.25)",
  enduro: "rgba(200,149,42,0.25)",
  moto:   "rgba(176,69,32,0.25)",
  other:  "rgba(144,144,144,0.25)"
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


function updateHeaderSub() {
  const el = document.getElementById("headerSub");
  if (!el) return;
  const count = visibleRides().length;
  const total = rides.length;
  if (searchQuery) {
    el.textContent = `${count} result${count !== 1 ? "s" : ""} for "${searchQuery}"`;
    return;
  }
  const timeStr = lastFetched
    ? lastFetched.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "…";
  el.textContent = `${count} of ${total} rides · updated ${timeStr}`;
}

function formatDriveValue(distanceKm, driveTimeMinutes) {
  if (driveDisplay === "distance") return `${distanceKm} km`;
  const hrs = Math.floor(driveTimeMinutes / 60);
  const mins = driveTimeMinutes % 60;
  return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
}

function formatDrive(ride) {
  if (userOrigin) {
    if (!ride.lat || !ride.lon) return null;
    if (driveInfo.has(ride.link)) {
      const d = driveInfo.get(ride.link);
      if (!d) return null;
      return formatDriveValue(d.distance_km, d.drive_time_minutes);
    }
    return "calculating…";
  }
  if (!ride.distance_km || !ride.drive_time_minutes) return null;
  return formatDriveValue(ride.distance_km, ride.drive_time_minutes);
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
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    return rides.filter(r => r.title.toLowerCase().includes(q));
  }
  let result = activeFilters.size === 0 ? rides : rides.filter(r => activeFilters.has(rideTypeKey(r.type)));
  return result.filter(driveTimeOk);
}

function safeLink(link) {
  return encodeURIComponent(link);
}

function noteKey(title) {
  return (title || "").toLowerCase().trim();
}

function getNote(title) {
  const notes = JSON.parse(localStorage.getItem("rideRadarNotes") || "{}");
  return notes[noteKey(title)] || "";
}

function saveNote(title, text) {
  const notes = JSON.parse(localStorage.getItem("rideRadarNotes") || "{}");
  const k = noteKey(title);
  if (text.trim()) {
    notes[k] = text;
  } else {
    delete notes[k];
  }
  localStorage.setItem("rideRadarNotes", JSON.stringify(notes));
}

// ── Page system ──────────────────────────────────────────────────
let activePages = [0, 2];
let currentPage = 0;

function getMapUrl(ride) {
  if (ride.googleMapUrl && !ride.googleMapUrl.includes('!1m18!')) {
    return ride.googleMapUrl;
  }
  if (ride.lat && ride.lon) {
    return `https://maps.google.com/maps?q=${ride.lat},${ride.lon}&z=8&output=embed`;
  }
  return ride.googleMapUrl || "";
}

function setPage(pageNum, animated) {
  if (animated === undefined) animated = true;
  const track = document.getElementById("cardTrack");
  track.style.transition = animated
    ? "transform 0.32s cubic-bezier(0.4, 0, 0.2, 1)"
    : "none";
  track.style.transform = `translateX(${-pageNum * 100}%)`;
  currentPage = pageNum;
  document.querySelectorAll(".page-nav-btn").forEach(btn => {
    btn.classList.toggle("active", parseInt(btn.dataset.page) === pageNum);
  });
  if (pageNum === 1 && currentRide) {
    const frame = document.getElementById("rideMapFrame");
    if (frame.getAttribute("data-loaded") !== currentRide.link) {
      frame.src = getMapUrl(currentRide);
      frame.setAttribute("data-loaded", currentRide.link);
    }
  }
}

function initPageNav() {
  document.querySelectorAll(".page-nav-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const p = parseInt(btn.dataset.page);
      if (activePages.includes(p)) setPage(p);
    });
  });
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

  const poster = document.getElementById("ridePoster");
  const rideInfo = document.querySelector(".rideInfo");
  if (ride.imageUrl) {
    poster.src = ride.imageUrl;
    poster.classList.remove("hidden");
    rideInfo.classList.add("hidden");
  } else {
    poster.src = "";
    poster.classList.add("hidden");
    rideInfo.classList.remove("hidden");
  }

  const navMap = document.getElementById("navPage1");
  const hasMap = !!(ride.lat && ride.lon) || !!ride.googleMapUrl;
  navMap.style.display = hasMap ? "" : "none";
  activePages = hasMap ? [0, 1, 2] : [0, 2];

  const frame = document.getElementById("rideMapFrame");
  frame.removeAttribute("data-loaded");
  frame.src = "";

  const notesEl = document.getElementById("rideNotes");
  const note = getNote(ride.title);
  notesEl.value = note;
  notesEl.classList.toggle("has-note", note.length > 0);

  document.querySelectorAll(".card-page").forEach(p => { p.scrollTop = 0; });
  setPage(0, false);
  document.getElementById("rideCard").classList.add("open");
}

// ── Dismiss gesture (drag down anywhere on card) ───────────────
(function () {
  const card = document.getElementById("rideCard");
  let startX = 0, startY = 0, lastY = 0;
  let lockDir = null, dismissing = false;

  card.addEventListener("touchstart", (e) => {
    if (e.target.closest("textarea, input")) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    lastY = startY;
    lockDir = null;
    dismissing = false;
    card.style.transition = "none";
  }, { passive: true });

  card.addEventListener("touchmove", (e) => {
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    lastY = e.touches[0].clientY;
    if (!lockDir && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      lockDir = Math.abs(dx) >= Math.abs(dy) ? "h" : "v";
    }
    if (lockDir !== "v") return;
    const pageEl = document.getElementById("cardPage" + currentPage);
    const scrolled = pageEl ? pageEl.scrollTop : 0;
    if (dy > 0 && scrolled === 0) {
      e.preventDefault();
      dismissing = true;
      card.style.transform = `translateY(${dy}px)`;
    }
  }, { passive: false });

  card.addEventListener("touchend", (e) => {
    if (!dismissing) {
      card.style.transition = "";
      card.style.transform = "";
      return;
    }
    const dy = e.changedTouches[0].clientY - startY;
    dismissing = false;
    if (dy > 80) {
      card.style.transform = "";
      card.style.transition = "";
      card.classList.remove("open");
    } else {
      card.style.transition = "";
      card.style.transform = "";
    }
  });
})();

// ── Horizontal page swipe (on viewport) ───────────────────────
(function () {
  const viewport = document.getElementById("cardViewport");
  const track = document.getElementById("cardTrack");
  let startX = 0, startY = 0, lockDir = null, baseOffset = 0;

  viewport.addEventListener("touchstart", (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    lockDir = null;
    const m = track.style.transform.match(/translateX\(([-0-9.]+)%\)/);
    baseOffset = m ? parseFloat(m[1]) : 0;
    track.style.transition = "none";
  }, { passive: true });

  viewport.addEventListener("touchmove", (e) => {
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (!lockDir && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      lockDir = Math.abs(dx) >= Math.abs(dy) ? "h" : "v";
    }
    if (lockDir !== "h") return;
    e.preventDefault();
    const pct = (dx / viewport.offsetWidth) * 100;
    let offset = baseOffset + pct;
    const minOff = -(activePages[activePages.length - 1] * 100);
    if (offset > 0) offset *= 0.2;
    if (offset < minOff) offset = minOff + (offset - minOff) * 0.2;
    track.style.transform = `translateX(${offset}%)`;
  }, { passive: false });

  viewport.addEventListener("touchend", (e) => {
    if (lockDir !== "h") return;
    const dx = e.changedTouches[0].clientX - startX;
    const idx = activePages.indexOf(currentPage);
    if (dx < -50 && idx < activePages.length - 1) {
      setPage(activePages[idx + 1]);
    } else if (dx > 50 && idx > 0) {
      setPage(activePages[idx - 1]);
    } else {
      setPage(currentPage);
    }
  });
})();

document.getElementById("openEventBtn").onclick = () => {
  if (currentRide) window.open(currentRide.link, "_blank");
};

document.getElementById("calendarBtn").onclick = () => {
  if (!currentRide) return;
  const date = currentRide.date.replace(/[a-z]/gi, "");
  const note = getNote(currentRide.title);
  const desc = [currentRide.type, note].filter(Boolean).join("\\n\\n");
  const alarm = reminderDays > 0
    ? `BEGIN:VALARM\nTRIGGER:-P${reminderDays}D\nACTION:DISPLAY\nDESCRIPTION:Reminder: ${currentRide.title}\nEND:VALARM\n`
    : "";
  const ics = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nSUMMARY:${currentRide.title}\nDESCRIPTION:${desc}\nLOCATION:${currentRide.originalAddress || currentRide.district}\nURL:${currentRide.link}\nDTSTART:${date}\n${alarm}END:VEVENT\nEND:VCALENDAR`;
  const blob = new Blob([ics], { type: "text/calendar" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ride.ics";
  a.click();
  URL.revokeObjectURL(url);
};

document.getElementById("rideNotes").addEventListener("input", () => {
  if (!currentRide) return;
  const notesEl = document.getElementById("rideNotes");
  saveNote(currentRide.title, notesEl.value);
  notesEl.classList.toggle("has-note", notesEl.value.trim().length > 0);
});

function updateRideDriveSpan(ride) {
  if (!driveTimeOk(ride)) {
    const row = document.querySelector(`.ride-item[data-link="${CSS.escape(ride.link)}"]`);
    if (row) row.remove();
    updateHeaderSub();
    return;
  }

  const el = document.querySelector(`.ride-item[data-link="${CSS.escape(ride.link)}"] .ride-drive`);
  if (!el) return;
  const drive = formatDrive(ride);
  el.textContent = drive || "";
  el.style.display = drive ? "" : "none";
  updateHeaderSub();

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
  });
}

function buildCard(ride, idx, layout) {
  const colour = rideColour(ride.type);
  const drive = formatDrive(ride);
  const hasMap = !!(ride.lat && ride.lon) || !!ride.googleMapUrl;
  const mapPin = hasMap ? MAP_PIN_SVG : "";
  const driveSpan = `<span class="ride-drive"${drive ? "" : ' style="display:none"'}>${drive || ""}</span>`;
  const bg = rideBgColour(ride.type);
  const base = `data-link="${ride.link}" style="border-left:4px solid ${colour};background:${bg}" onclick="openRideCard(rides[${idx}])"`;

  const meta = `<div class="ride-content">
    <div class="ride-item-title">${ride.title}</div>
    <div class="ride-meta-line">${ride.date} · ${ride.district}</div>
    <div class="ride-drive-line">${driveSpan}${mapPin}</div>
  </div>`;

  if (layout === "landscape") {
    return `<div class="ride-item ride-item--landscape" ${base}>
      <img class="ride-hero" src="${ride.imageUrl}" alt="" loading="lazy">
      ${meta}
    </div>`;
  }
  if (layout === "portrait") {
    return `<div class="ride-item ride-item--portrait" ${base}>
      <div class="ride-thumb-wrap"><img class="ride-thumb" src="${ride.imageUrl}" alt="" loading="lazy"></div>
      ${meta}
    </div>`;
  }
  return `<div class="ride-item ride-item--text" ${base}>${meta}</div>`;
}

function loadImageOrientation(ride, idx) {
  const img = new Image();
  img.onload = () => {
    const layout = img.naturalWidth >= img.naturalHeight ? "landscape" : "portrait";
    imageOrientations.set(ride.imageUrl, layout);
    const el = document.querySelector(`.ride-item[data-link="${CSS.escape(ride.link)}"]`);
    if (!el) return;
    el.outerHTML = buildCard(ride, idx, layout);
  };
  img.onerror = () => imageOrientations.set(ride.imageUrl, "text");
  img.src = ride.imageUrl;
}

function renderList() {
  const container = document.getElementById("rideList");
  const visible = visibleRides();
  updateHeaderSub();
  if (visible.length === 0) {
    container.innerHTML = "<p style='color:#888;padding:20px'>No rides to show.</p>";
    return;
  }
  container.innerHTML = visible.map(ride => {
    const idx = rides.indexOf(ride);
    let layout = "text";
    if (ride.imageUrl) {
      layout = imageOrientations.has(ride.imageUrl)
        ? imageOrientations.get(ride.imageUrl)
        : "text";
    }
    return buildCard(ride, idx, layout);
  }).join("");

  visible.forEach(ride => {
    const idx = rides.indexOf(ride);
    if (ride.imageUrl && !imageOrientations.has(ride.imageUrl)) {
      loadImageOrientation(ride, idx);
    }
  });
}


function renderTypeFilters() {
  const container = document.getElementById("typeFilters");
  container.innerHTML = RIDE_TYPES.map(t => {
    const label = TYPE_LABELS[t] || (t.charAt(0).toUpperCase() + t.slice(1));
    const colour = TYPE_COLOURS[t];
    const bg = TYPE_BG_COLOURS[t];
    return `<button class="type-filter-btn on" data-type="${t}" style="--tc:${colour};--tb:${bg}">${label}</button>`;
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

function closeSearch() {
  const searchBar = document.getElementById("searchBar");
  const searchInput = document.getElementById("searchInput");
  const toggleBtn = document.getElementById("searchToggleBtn");
  searchBar.classList.add("hidden");
  toggleBtn.classList.remove("active");
  searchQuery = "";
  searchInput.value = "";
  renderList();
}

function showList() {
  document.getElementById("tab-prefs").classList.remove("active");
  document.getElementById("tab-list").classList.add("active");
  document.getElementById("settingsBtn").classList.remove("active");
  document.getElementById("rideCard").classList.remove("open");
}

function initDriveDisplay() {
  const saved = localStorage.getItem("rideRadarDriveDisplay");
  driveDisplay = saved === "distance" ? "distance" : "time";

  document.querySelectorAll(".dd-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.display === driveDisplay);
    btn.addEventListener("click", () => {
      driveDisplay = btn.dataset.display;
      localStorage.setItem("rideRadarDriveDisplay", driveDisplay);
      document.querySelectorAll(".dd-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.display === driveDisplay)
      );
      renderList();
    });
  });
}

function initReminder() {
  const saved = localStorage.getItem("rideRadarReminderDays");
  reminderDays = saved !== null ? parseInt(saved, 10) : 7;

  document.querySelectorAll(".reminder-btn").forEach(btn => {
    const val = parseInt(btn.dataset.days, 10);
    btn.classList.toggle("active", val === reminderDays);
    btn.addEventListener("click", () => {
      reminderDays = val;
      localStorage.setItem("rideRadarReminderDays", val);
      document.querySelectorAll(".reminder-btn").forEach(b =>
        b.classList.toggle("active", parseInt(b.dataset.days, 10) === reminderDays)
      );
    });
  });
}

async function loadRides() {
  const res = await fetch("/rides");
  rides = await res.json();
  lastFetched = new Date();
  initDriveFilter();
  initBermBusterPref();
  initDriveDisplay();
  initReminder();
  initPageNav();
  renderList();
  renderTypeFilters();
  initPrefs();
}

function initSearch() {
  const toggleBtn = document.getElementById("searchToggleBtn");
  const searchBar = document.getElementById("searchBar");
  const searchInput = document.getElementById("searchInput");
  const clearBtn = document.getElementById("searchClearBtn");

  let ttxStart = 0, ttyStart = 0;

  function handleSearchToggle() {
    const isOpen = !searchBar.classList.contains("hidden");
    if (isOpen) {
      closeSearch();
    } else {
      showList();
      searchBar.classList.remove("hidden");
      toggleBtn.classList.add("active");
      searchInput.focus();
    }
  }

  toggleBtn.addEventListener("touchstart", (e) => {
    ttxStart = e.touches[0].clientX;
    ttyStart = e.touches[0].clientY;
  }, { passive: true });

  toggleBtn.addEventListener("touchend", (e) => {
    const dx = Math.abs(e.changedTouches[0].clientX - ttxStart);
    const dy = Math.abs(e.changedTouches[0].clientY - ttyStart);
    if (dx < 10 && dy < 10) {
      e.preventDefault();
      handleSearchToggle();
    }
  });

  toggleBtn.addEventListener("click", handleSearchToggle);

  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value.trim();
    renderList();
  });

  let ctxStart = 0, ctyStart = 0;

  clearBtn.addEventListener("touchstart", (e) => {
    ctxStart = e.touches[0].clientX;
    ctyStart = e.touches[0].clientY;
  }, { passive: true });

  clearBtn.addEventListener("touchend", (e) => {
    const dx = Math.abs(e.changedTouches[0].clientX - ctxStart);
    const dy = Math.abs(e.changedTouches[0].clientY - ctyStart);
    if (dx < 10 && dy < 10) {
      e.preventDefault();
      closeSearch();
    }
  });

  clearBtn.addEventListener("click", closeSearch);

  const settingsBtn = document.getElementById("settingsBtn");
  let stxStart = 0, styStart = 0;

  function openSettings() {
    closeSearch();
    if (settingsBtn.classList.contains("active")) {
      showList();
      return;
    }
    document.getElementById("tab-list").classList.remove("active");
    document.getElementById("tab-prefs").classList.add("active");
    document.getElementById("rideCard").classList.remove("open");
    settingsBtn.classList.add("active");
  }

  settingsBtn.addEventListener("touchstart", (e) => {
    stxStart = e.touches[0].clientX;
    styStart = e.touches[0].clientY;
  }, { passive: true });

  settingsBtn.addEventListener("touchend", (e) => {
    const dx = Math.abs(e.changedTouches[0].clientX - stxStart);
    const dy = Math.abs(e.changedTouches[0].clientY - styStart);
    if (dx < 10 && dy < 10) {
      e.preventDefault();
      openSettings();
    }
  });

  settingsBtn.addEventListener("click", openSettings);
}

loadRides();
initSearch();
