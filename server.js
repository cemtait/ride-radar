import express from "express";
import * as cheerio from "cheerio";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});
app.use(express.static("public"));

const EVENTS_URL = "https://silverbullet.co.nz/events.php";
const MYRIDES_URL = "https://www.myrides.co.nz/events";

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
  "IXION": { lat: -40.949000, lon: 175.032472, address: "Maungakotukutuku Road", district: "Manawatu" },
  "Berm Buster": { lat: -38.921848, lon: 176.270546, district: "Taupo" },
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
const driveInfoCache = {};

async function getDriveInfo(lat, lon) {

  const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (driveInfoCache[cacheKey]) return driveInfoCache[cacheKey];

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

    const result = {
      distance_km: (route.distance / 1000).toFixed(1),
      drive_time_minutes: Math.round(route.duration / 60)
    };

    driveInfoCache[cacheKey] = result;
    return result;

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

  for (let i = 0; i < attempts.length; i++) {
    try {

      const url =
        "https://nominatim.openstreetmap.org/search?q=" +
        encodeURIComponent(attempts[i].query) +
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

    // Only pause between attempts — not after the last one
    if (i < attempts.length - 1) {
      await new Promise((r) => setTimeout(r, 1100));
    }
  }

  return null;
}

// -----------------------------
async function scrapeRidePage(link) {

  try {

    const res = await fetch(link);
    const raw = await res.text();
    const html = raw.replace(/<!--[\s\S]*?-->/g, "");

    const $ = cheerio.load(html);

    const page = { title: null, where: null, district: null, directions: null, imageUrl: null, googleMapUrl: null, html };

    const h1 = $("h1").first().text().trim();
    if (h1) page.title = h1;

    $(".event_row").each((i, el) => {

      const label = $(el).find(".row_desc").text().trim().toLowerCase();
      const detail = $(el).find(".row_detail").text().trim();

      if (label.includes("where")) page.where = detail;
      if (label.includes("district")) page.district = detail;
      if (label.includes("directions")) page.directions = detail;
    });

    const imgSrc = $('img[src*="media/images/events"]').last().attr("src");
    if (imgSrc) {
      page.imageUrl = imgSrc.startsWith("http")
        ? imgSrc
        : "https://www.silverbullet.co.nz/" + imgSrc.replace(/^\//, "");
    }

    $("iframe").each((_, el) => {
      let src = $(el).attr("src") || "";
      if (src.includes("google.com/maps") || src.includes("maps.google.com")) {
        if (src.startsWith("//")) src = "https:" + src;
        if (src) page.googleMapUrl = src;
        return false;
      }
    });

    return page;

  } catch {

    return { title: null, where: null, district: null, directions: null, imageUrl: null, googleMapUrl: null, html: null };

  }
}

// -----------------------------
// My Rides type inference
// -----------------------------
function inferMyRidesType(title, excerpt) {
  const t = (title + " " + (excerpt || "")).toLowerCase();
  if (t.includes("enduro")) return "Enduro";
  if (t.includes("cross country") || /\bxc\b/.test(t)) return "Cross Country";
  if (t.includes("motocross") || /\bmx\b/.test(t)) return "Motocross";
  if (t.includes("adventure")) return "Adventure Ride";
  return "Trail Ride";
}

// -----------------------------
// My Rides scraper (myrides.co.nz)
// -----------------------------
async function scrapeMyRides() {

  console.log("\nFetching My Rides events page...");

  try {

    const res = await fetch(MYRIDES_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; RideRadar/1.0)" }
    });
    const html = await res.text();
    const $ = cheerio.load(html);

    const rides = [];
    const seenLinks = new Set();

    $("article.eventlist-event").each((_, el) => {

      const titleEl = $(el).find("h1.eventlist-title a.eventlist-title-link");
      const title = titleEl.text().trim();
      const href = titleEl.attr("href");
      if (!title || !href) return;

      const link = "https://www.myrides.co.nz" + href;
      if (seenLinks.has(link)) return;
      seenLinks.add(link);

      // Date — first event-date time element
      const dateText = $(el).find("time.event-date").first().attr("datetime") || "";
      const dateDisplay = $(el).find("time.event-date").first().text().trim();

      // Address lines — skip the bare "New Zealand" line
      const addrLines = [];
      $(el).find("span.eventlist-meta-address-line").each((_, line) => {
        const txt = $(line).text().trim();
        if (txt && txt !== "New Zealand") addrLines.push(txt);
      });
      const address = addrLines.length ? addrLines.join(", ") : null;

      // District — last part of address before ", Region"
      let district = null;
      if (address) {
        const parts = address.split(",").map(p => p.trim());
        const regionPart = parts[parts.length - 1].replace(/\s*Region$/i, "").trim();
        district = regionPart || parts[0];
      }

      // Poster image — prefer data-src, fall back to src
      const imgEl = $(el).find("a.eventlist-column-thumbnail img").first();
      const imageUrl = imgEl.attr("data-src") || imgEl.attr("src") || null;

      // Excerpt
      const excerpt = $(el).find(".eventlist-excerpt p").first().text().trim() || null;

      // Type
      const type = inferMyRidesType(title, excerpt);

      rides.push({
        title,
        type,
        date: dateDisplay,
        district,
        link,
        imageUrl: imageUrl || null,
        originalAddress: address ? address + ", New Zealand" : null,
        source: "myrides",
      });
    });

    console.log(`My Rides found: ${rides.length} events\n`);
    return rides;

  } catch (err) {
    console.log("Error scraping My Rides:", err.message);
    return [];
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

      if (!date || date.toLowerCase().includes("most")) return;
      // Allow multi-day events like "Sat 25th - Sun 26th Apr" but reject bare "-" placeholder dates
      if (date === "-") return;
      // Omit trials events entirely
      if (type.toLowerCase() === "trials") return;

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
    // Cache resolved locations by final ride title within this scrape run.
    // Duplicate-title rides (e.g. 20× Burt's Trail Ride) reuse the first result
    // without re-scraping the page or re-geocoding.
    const titleLocationCache = {};

    for (const ride of toProcess) {

      let status = "FAIL";

      // --- Fast path: initial title already resolved this run ---
      if (titleLocationCache[ride.title]) {
        const cached = titleLocationCache[ride.title];
        ride.lat = cached.lat;
        ride.lon = cached.lon;
        ride.originalAddress = cached.originalAddress;
        if (cached.district) ride.district = cached.district;
        if (cached.googleMapUrl) ride.googleMapUrl = cached.googleMapUrl;
        status = cached.status;
        LOG.info(`CACHED   | ${ride.title}`);
        // Still need drive time
        if (ride.lat && ride.lon) {
          const drive = await getDriveInfo(ride.lat, ride.lon);
          if (drive) { ride.distance_km = drive.distance_km; ride.drive_time_minutes = drive.drive_time_minutes; }
        }
        continue;
      }

      const page = await scrapeRidePage(ride.link);

      if (page.title) ride.title = page.title;
      if (page.imageUrl) ride.imageUrl = page.imageUrl;
      if (page.googleMapUrl) ride.googleMapUrl = page.googleMapUrl;

      // --- Fast path: h1 title already resolved this run ---
      if (titleLocationCache[ride.title]) {
        const cached = titleLocationCache[ride.title];
        ride.lat = cached.lat;
        ride.lon = cached.lon;
        ride.originalAddress = cached.originalAddress;
        if (cached.district) ride.district = cached.district;
        if (cached.googleMapUrl) ride.googleMapUrl = cached.googleMapUrl;
        status = cached.status;
        LOG.info(`CACHED   | ${ride.title}`);
        if (ride.lat && ride.lon) {
          const drive = await getDriveInfo(ride.lat, ride.lon);
          if (drive) { ride.distance_km = drive.distance_km; ride.drive_time_minutes = drive.drive_time_minutes; }
        }
        continue;
      }

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
          if (hardcodedCoords.district) ride.district = hardcodedCoords.district;
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

      // Store in title cache so duplicate-title rides skip straight to drive time
      if (status !== "FAIL") {
        titleLocationCache[ride.title] = {
          lat: ride.lat, lon: ride.lon,
          originalAddress: ride.originalAddress || null,
          district: ride.district || null,
          googleMapUrl: ride.googleMapUrl || null,
          status
        };
      }

      if (status === "MAP") LOG.success(`MAP      | ${ride.title}`);
      else if (status === "GEOCODE") LOG.warn(`GEOCODE  | ${ride.title}`);
      else LOG.fail(`FAIL     | ${ride.title}`);
    }

    // -----------------------------------------------
    // MY RIDES — scrape + geocode + drive time
    // -----------------------------------------------
    const myRidesRaw = await scrapeMyRides();

    for (const ride of myRidesRaw) {

      let status = "FAIL";

      // Reuse title cache if a Silver Bullet ride shares the same location key
      if (titleLocationCache[ride.title]) {
        const cached = titleLocationCache[ride.title];
        ride.lat = cached.lat;
        ride.lon = cached.lon;
        ride.originalAddress = ride.originalAddress || cached.originalAddress;
        if (cached.district) ride.district = ride.district || cached.district;
        status = cached.status;
        LOG.info(`CACHED   | ${ride.title}`);
      } else if (ride.originalAddress) {

        const hardcodedCoords = getHardcodedCoords(ride.title);
        if (hardcodedCoords) {
          ride.lat = hardcodedCoords.lat;
          ride.lon = hardcodedCoords.lon;
          if (hardcodedCoords.address) ride.originalAddress = hardcodedCoords.address;
          if (hardcodedCoords.district) ride.district = hardcodedCoords.district;
          status = "GEOCODE";
        } else {
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
            where: ride.originalAddress || null,
            addressAttempted: ride.originalAddress || null,
            link: ride.link,
            source: "myrides",
          });
        }
      } else {
        failedRides.push({
          title: ride.title,
          district: ride.district,
          where: null,
          addressAttempted: null,
          link: ride.link,
          source: "myrides",
        });
      }

      if (ride.lat && ride.lon) {
        const drive = await getDriveInfo(ride.lat, ride.lon);
        if (drive) {
          ride.distance_km = drive.distance_km;
          ride.drive_time_minutes = drive.drive_time_minutes;
        }
      }

      if (status !== "FAIL") {
        titleLocationCache[ride.title] = {
          lat: ride.lat, lon: ride.lon,
          originalAddress: ride.originalAddress || null,
          district: ride.district || null,
          googleMapUrl: ride.googleMapUrl || null,
          status,
        };
      }

      if (status === "MAP") LOG.success(`MAP      | ${ride.title} [myrides]`);
      else if (status === "GEOCODE") LOG.warn(`GEOCODE  | ${ride.title} [myrides]`);
      else LOG.fail(`FAIL     | ${ride.title} [myrides]`);
    }

    // Deduplicate by title + date — same ride listed twice (e.g. duplicate event IDs)
    const seen = new Set();
    const dedupedRides = [...toProcess, ...myRidesRaw].filter(ride => {
      const key = `${ride.title.toLowerCase().trim()}|${ride.date.toLowerCase().trim()}`;
      if (seen.has(key)) {
        LOG.info(`DEDUP    | ${ride.title} (${ride.date})`);
        return false;
      }
      seen.add(key);
      return true;
    });

    rideCache = dedupedRides;

    fs.writeFileSync(RIDES_FILE, JSON.stringify(dedupedRides, null, 2));
    fs.writeFileSync("./failedGeocodes.json", JSON.stringify(failedRides, null, 2));

    console.log(`\n--- FAILED RIDES (${failedRides.length}) ---`);
    failedRides.forEach(f => {
      console.log(`  ${f.title}${f.source ? " [" + f.source + "]" : ""}`);
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
// ICS calendar endpoint — iOS Safari compatible
// -----------------------------
function formatIcsDate(dateStr) {
  if (!dateStr) return "20260101";
  const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  const MONTHS_LONG = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };

  // "Saturday, 14 March 2026" or "Sunday, 26 April 2026"
  let m = dateStr.match(/(\d+)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i);
  if (m) {
    return `${m[3]}${String(MONTHS_LONG[m[2].toLowerCase()]).padStart(2,"0")}${m[1].padStart(2,"0")}`;
  }

  // "Fri, 13 Mar 2026"
  m = dateStr.match(/(\d+)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})/i);
  if (m) {
    return `${m[3]}${String(MONTHS[m[2].toLowerCase()]).padStart(2,"0")}${m[1].padStart(2,"0")}`;
  }

  // "Sat 14th Mar" or "Sun 26th Apr" — Silver Bullet format (no year, assume current/next year)
  m = dateStr.match(/(\d+)(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    const day = parseInt(m[1], 10);
    const now = new Date();
    let year = now.getFullYear();
    // If this month/day is already in the past this year, assume next year
    if (new Date(year, month - 1, day) < now) year++;
    return `${year}${String(month).padStart(2,"0")}${String(day).padStart(2,"0")}`;
  }

  return "20260101";
}

app.get("/calendar.ics", (req, res) => {
  const link = req.query.link;
  const ride = rideCache.find(r => r.link === link);
  if (!ride) return res.status(404).send("Ride not found");

  const dateStr = formatIcsDate(ride.date);
  const days = parseInt(req.query.reminderDays || "0", 10);
  const note = (req.query.note || "").replace(/\\n/g, "\n");
  const desc = [ride.type, note].filter(Boolean).join("\\n\\n");
  const alarm = days > 0
    ? `BEGIN:VALARM\r\nTRIGGER:-P${days}D\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder: ${ride.title}\r\nEND:VALARM\r\n`
    : "";

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Ride Radar//NZ//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `SUMMARY:${ride.title}`,
    `DTSTART;VALUE=DATE:${dateStr}`,
    `DESCRIPTION:${desc}`,
    `LOCATION:${ride.originalAddress || ride.district || ""}`,
    `URL:${ride.link}`,
    `UID:${link}@rideradar`,
    alarm.trim(),
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");

  const filename = ride.title.replace(/[^a-z0-9]/gi, "_").replace(/_+/g, "_") + ".ics";
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(ics);
});

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