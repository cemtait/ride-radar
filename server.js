import express from "express";
import * as cheerio from "cheerio";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

const EVENTS_URL = "https://silverbullet.co.nz/events.php";

// -----------------------------
const LOG = {
  success: (msg) => console.log("\x1b[32m%s\x1b[0m", msg),
  warn: (msg) => console.log("\x1b[33m%s\x1b[0m", msg),
  fail: (msg) => console.log("\x1b[31m%s\x1b[0m", msg),
  info: (msg) => console.log("\x1b[36m%s\x1b[0m", msg),
};

// -----------------------------
// Address cache
// -----------------------------
const CACHE_FILE = "./addressCache.json";
const RIDES_FILE = "./rides.json";
const DRIVE_CACHE_FILE = "./driveCache.json";

let addressCache = {};
if (fs.existsSync(CACHE_FILE)) {
  addressCache = JSON.parse(fs.readFileSync(CACHE_FILE));
}

let rideCache = [];
if (fs.existsSync(RIDES_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(RIDES_FILE));
    if (Array.isArray(saved) && saved.length > 0) rideCache = saved;
  } catch {}
}

let driveCache = {};
if (fs.existsSync(DRIVE_CACHE_FILE)) {
  try { driveCache = JSON.parse(fs.readFileSync(DRIVE_CACHE_FILE)); } catch {}
}

app.use(express.json());

// -----------------------------
const JUNK_WORDS = [
  "start","finish","signposted","campground","trail ride","ride",
  "domain","reserve","clubrooms","showgrounds","motorcamp",
  "school","hall","a&p",
];

// -----------------------------
const LOCALITY_CORRECTIONS = {
  "south head": "South Head, Auckland",
  waimauk: "Waimauku, Auckland",
};

// -----------------------------
// Rides whose titles match these strings are permanently excluded —
// they never have useful location details.
// -----------------------------
const OMIT_TITLES = [
  "NI Champs",
  "MOMCC",
  "Hamilton TC/AC Trial",
  "Taranaki Club Trial",
  "HMCC/BOP",
];

function shouldOmit(title) {
  const t = title.toLowerCase();
  return OMIT_TITLES.some(o => t.includes(o.toLowerCase()));
}

// -----------------------------
// Hardcoded GPS coordinates for rides where we have exact coords.
// Keys matched case-insensitively against the final ride title.
// These bypass geocoding entirely.
// -----------------------------
const HARDCODED_COORDS = {
  "IXION": { lat: -40.949000, lon: 175.032472, address: "Maungakotukutuku Road" },
};

function getHardcodedCoords(title) {
  const t = title.toLowerCase();
  const entry = Object.entries(HARDCODED_COORDS)
    .find(([key]) => t.includes(key.toLowerCase()));
  return entry ? entry[1] : null;
}

// -----------------------------
// Hardcoded addresses for rides that consistently fail geocoding.
// Keys are matched case-insensitively against the final ride title.
// The address is passed through the normal geocode + cache flow.
// -----------------------------
const HARDCODED_ADDRESSES = {
  "Steel Horse Trail Ride":        "598 State Highway 4, Upokongaro 4575, New Zealand",
  "Waikato Warrior Adventure Ride":"423 Alexandra Street, Te Awamutu 3800, New Zealand",
  "Whangamomona Trail ride":       "59 Whangamomona Road, Whangamōmona 4396, New Zealand",
  "Tunnels Trail Ride":            "Ngatira Rd, Litchfield, New Zealand",
  "Redwoods Trail Ride":           "Ngatira Rd, Litchfield, New Zealand",
  "Mighty Mokau Trail Bike Ride":  "4775 State Highway 3, Awakino 4376, New Zealand",
};

function getHardcodedAddress(title) {
  const t = title.toLowerCase();
  const entry = Object.entries(HARDCODED_ADDRESSES)
    .find(([key]) => t.includes(key.toLowerCase()));
  return entry ? entry[1] : null;
}

// -----------------------------
// DRIVING ROUTE FUNCTION
// -----------------------------
async function getDriveInfo(lat, lon) {

  const ORIGIN = {
    lat: -36.8485,
    lon: 174.7633
  };

  try {

    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${ORIGIN.lon},${ORIGIN.lat};${lon},${lat}?overview=false`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json();

    if (!data.routes || data.routes.length === 0) return null;

    const route = data.routes[0];

    return {
      distance_km: (route.distance / 1000).toFixed(1),
      drive_time_minutes: Math.round(route.duration / 60)
    };

  } catch {
    return null;
  }
}

// -----------------------------
// Extract Google Map embed data
// -----------------------------
function extractGoogleMapData(html) {
  if (!html) return null;

  const coordMatch = html.match(/!2d([-0-9.]+)!3d([-0-9.]+)/);
  const addressMatch = html.match(/!2s([^!]+)!/);

  if (!coordMatch) return null;

  let address = null;
  if (addressMatch) {
    address = decodeURIComponent(addressMatch[1]).replace(/\+/g, " ").trim();
    if (!address.toLowerCase().includes("new zealand"))
      address += " New Zealand";
  }

  return { lat: parseFloat(coordMatch[2]), lon: parseFloat(coordMatch[1]), address };
}

// -----------------------------
function cleanRideLocation(str) {
  if (!str) return null;
  str = str.toLowerCase().replace(/\(.*?\)/g, "").replace(/@/g, " ");
  JUNK_WORDS.forEach((word) => {
    str = str.replace(new RegExp("\\b" + word + "\\b", "g"), "");
  });
  return str.replace(/\s+/g, " ").trim();
}

// -----------------------------
function normalizeAddress(addr) {
  if (!addr) return null;
  let str = addr.replace(/\s+/g, " ").trim().replace(/\(.*?\)/g, "").replace(/@/g, "");
  if (!str.toLowerCase().includes("new zealand")) str += " New Zealand";
  return str.trim();
}

// -----------------------------
function extractStreetTown(addr) {
  if (!addr) return {};
  const str = addr.replace(/\(.*?\)/g, "").replace(/@/g, "").trim();
  const parts = str.split(",");
  return { street: parts[0]?.trim() || "", town: parts[1]?.trim() || "" };
}

// -----------------------------
// Geocode
// -----------------------------
async function geocodeAddress(address) {
  if (!address) return null;

  let normalized = address.replace(/\s+/g, " ").trim();
  if (!normalized.toLowerCase().includes("new zealand"))
    normalized += " New Zealand";

  if (addressCache[normalized]) return addressCache[normalized];

  const attempts = [{ query: normalized }];

  const cleaned = cleanRideLocation(address);
  if (cleaned && cleaned !== normalized)
    attempts.push({ query: cleaned + ", New Zealand" });

  const { town, street } = extractStreetTown(address);

  if (town && street)
    attempts.push({ query: `${town}, ${street}, New Zealand` });

  if (street)
    attempts.push({ query: `${street}, New Zealand` });

  for (const key in LOCALITY_CORRECTIONS) {
    if (address.toLowerCase().includes(key)) {
      const corrected = address.toLowerCase().replace(key, LOCALITY_CORRECTIONS[key]);
      attempts.push({ query: corrected + ", New Zealand" });
    }
  }

  for (const attempt of attempts) {
    try {

      const url =
        "https://nominatim.openstreetmap.org/search?q=" +
        encodeURIComponent(attempt.query) +
        "&format=json&limit=1&countrycodes=nz";

      const res = await fetch(url, {
        headers: { "User-Agent": "RideRadar/1.0" }
      });

      const data = await res.json();

      if (data.length > 0) {

        const coords = {
          lat: parseFloat(data[0].lat),
          lon: parseFloat(data[0].lon),
          original: normalized
        };

        addressCache[normalized] = coords;

        fs.writeFileSync(CACHE_FILE, JSON.stringify(addressCache, null, 2));

        return coords;
      }

    } catch {}

    await new Promise((r) => setTimeout(r, 1100));
  }

  return null;
}

// -----------------------------
async function scrapeRidePage(link) {

  try {

    const res = await fetch(link);
    const html = await res.text();

    const $ = cheerio.load(html);

    const page = { title: null, where: null, district: null, directions: null, html };

    const h1 = $("h1").first().text().trim();
    if (h1) page.title = h1;

    $(".event_row").each((i, el) => {

      const label = $(el).find(".row_desc").text().trim().toLowerCase();
      const detail = $(el).find(".row_detail").text().trim();

      if (label.includes("where")) page.where = detail;
      if (label.includes("district")) page.district = detail;
      if (label.includes("directions")) page.directions = detail;
    });

    return page;

  } catch {

    return { title: null, where: null, district: null, directions: null, html: null };

  }
}

// -----------------------------
// Main scraper
// -----------------------------
async function refreshRideCache() {

  console.log("\nFetching Silver Bullet events page...");

  try {

    const res = await fetch(EVENTS_URL);
    const html = await res.text();

    const $ = cheerio.load(html);

    const rides = [];
    const seenLinks = new Set();

    $("a[href*='event.php?id']").each((i, el) => {

      const title = $(el).text().trim();
      if (!title) return;

      const href = $(el).attr("href");
      if (!href || seenLinks.has(href)) return;

      seenLinks.add(href);

      const row = $(el).closest("tr");
      const cells = row.find("td");

      if (cells.length < 4) return;

      const date = $(cells[0]).text().trim();
      const district = $(cells[1]).text().trim();
      const type = $(cells[2]).text().trim();

      if (!date || date.includes("-") || date.toLowerCase().includes("most")) return;

      rides.push({
        title,
        type,
        date,
        district,
        link: "https://silverbullet.co.nz/" + href
      });
    });

    const omitted = rides.filter(r => shouldOmit(r.title));
    const toProcess = rides.filter(r => !shouldOmit(r.title));

    console.log(`Found rides: ${rides.length} (${omitted.length} omitted)\n`);
    omitted.forEach(r => LOG.info(`OMIT     | ${r.title}`));
    if (omitted.length) console.log("");

    const failedRides = [];

    for (const ride of toProcess) {

      let status = "FAIL";

      const page = await scrapeRidePage(ride.link);

      if (page.title) ride.title = page.title;

      const mapData = extractGoogleMapData(page.html);

      if (mapData) {

        ride.lat = mapData.lat;
        ride.lon = mapData.lon;
        ride.originalAddress = mapData.address;

        status = "MAP";

      } else {

        const hardcodedCoords = getHardcodedCoords(ride.title);

        if (hardcodedCoords) {

          ride.lat = hardcodedCoords.lat;
          ride.lon = hardcodedCoords.lon;
          if (hardcodedCoords.address) ride.originalAddress = hardcodedCoords.address;
          status = "GEOCODE";

        } else {

        const hardcoded = getHardcodedAddress(ride.title);
        let candidateAddress = hardcoded || page.where;

        if (!candidateAddress && page.directions && page.district) {

          const lastRoadMatch = page.directions.match(/([\w\s]+) road/gi);

          candidateAddress = lastRoadMatch
            ? `${lastRoadMatch[lastRoadMatch.length - 1]}, ${page.district}`
            : page.district;
        }

        ride.originalAddress = candidateAddress
          ? normalizeAddress(candidateAddress)
          : null;

        if (ride.originalAddress) {

          const coords = await geocodeAddress(ride.originalAddress);

          if (coords) {

            ride.lat = coords.lat;
            ride.lon = coords.lon;

            status = "GEOCODE";
          }
        }

        if (status === "FAIL") {
          failedRides.push({
            title: ride.title,
            district: ride.district,
            where: page.where || null,
            addressAttempted: ride.originalAddress || null,
            link: ride.link
          });
        }

        } // end inner else (no hardcoded coords)
      }

      // -----------------------------
      // ADD DRIVING DISTANCE/TIME
      // -----------------------------
      if (ride.lat && ride.lon) {

        const drive = await getDriveInfo(ride.lat, ride.lon);

        if (drive) {

          ride.distance_km = drive.distance_km;
          ride.drive_time_minutes = drive.drive_time_minutes;

        }
      }

      if (status === "MAP") LOG.success(`MAP      | ${ride.title}`);
      else if (status === "GEOCODE") LOG.warn(`GEOCODE  | ${ride.title}`);
      else LOG.fail(`FAIL     | ${ride.title}`);
    }

    rideCache = toProcess;

    fs.writeFileSync(RIDES_FILE, JSON.stringify(toProcess, null, 2));
    fs.writeFileSync("./failedGeocodes.json", JSON.stringify(failedRides, null, 2));

    console.log(`\n--- FAILED RIDES (${failedRides.length}) ---`);
    failedRides.forEach(f => {
      console.log(`  ${f.title}`);
      console.log(`    District:  ${f.district || "—"}`);
      console.log(`    Where:     ${f.where || "—"}`);
      console.log(`    Attempted: ${f.addressAttempted || "—"}`);
      console.log(`    Link:      ${f.link}`);
    });

    console.log("\nRide cache refreshed.\n");

  } catch (err) {

    console.log("Error refreshing rides:", err.message);

  }
}

// -----------------------------
app.get("/rides", (req, res) => res.json(rideCache));

// -----------------------------
// Drive-time endpoint (OSRM, cached per origin)
// -----------------------------
function originKey(lat, lon) {
  return `${Math.round(lat * 1000) / 1000}_${Math.round(lon * 1000) / 1000}`;
}

app.post("/drive-time", async (req, res) => {
  const { originLat, originLon, rideLat, rideLon, rideLink } = req.body;
  if (originLat == null || originLon == null || rideLat == null || rideLon == null) {
    return res.status(400).json({ error: "Missing params" });
  }

  const key = originKey(originLat, originLon);
  if (!driveCache[key]) driveCache[key] = {};

  if (driveCache[key][rideLink]) {
    return res.json(driveCache[key][rideLink]);
  }

  try {
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${originLon},${originLat};${rideLon},${rideLat}?overview=false`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const osrmRes = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await osrmRes.json();

    if (!data.routes || data.routes.length === 0) return res.json(null);

    const route = data.routes[0];
    const result = {
      distance_km: (route.distance / 1000).toFixed(1),
      drive_time_minutes: Math.round(route.duration / 60)
    };

    driveCache[key][rideLink] = result;
    fs.writeFileSync(DRIVE_CACHE_FILE, JSON.stringify(driveCache, null, 2));

    return res.json(result);
  } catch {
    return res.json(null);
  }
});

// -----------------------------
app.listen(PORT, "0.0.0.0", () => {

  console.log(`Ride Radar server running on port ${PORT}`);

  refreshRideCache().catch((err) => console.error(err));

});

// -----------------------------
setInterval(refreshRideCache, 1000 * 60 * 60);