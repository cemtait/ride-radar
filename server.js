// server.js
const express = require("express");
const cheerio = require("cheerio");

// Modern Node.js fetch workaround
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const PORT = 3000;

// --- Route: get all rides ---
app.get("/api/rides", async (req, res) => {
  try {
    const url = "https://silverbullet.co.nz/events.php";
    const response = await fetch(url);
    const html = await response.text();

    const $ = cheerio.load(html);
    const rides = [];

    $("table tr").each((i, row) => {
      const cols = $(row).find("td");
      if (cols.length === 5) {
        const when = $(cols[0]).text().trim();
        const district = $(cols[1]).text().trim();
        const type = $(cols[2]).text().trim();
        const title = $(cols[3]).text().trim();
        let link = $(cols[3]).find("a").attr("href");

        // Convert relative link to full absolute URL
        if (link && !link.startsWith("http")) {
          link = "https://silverbullet.co.nz/" + link.replace(/^\//, "");
        }

        rides.push({ when, district, type, title, link });
      }
    });

    res.json(rides);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch rides" });
  }
});

// --- Route: get ride details using .event_row structure ---
app.get("/api/ride-details", async (req, res) => {
  const rideUrl = req.query.url;
  if (!rideUrl) return res.status(400).json({ error: "Missing url parameter" });

  try {
    const response = await fetch(rideUrl);
    const html = await response.text();
    const $ = cheerio.load(html);

    let when = "";
    let where = "";

    $(".event_row").each((i, el) => {
      const label = $(el).find(".row_desc").text().trim().toLowerCase();
      const value = $(el).find(".row_detail").text().trim();

      if (label === "when:" && !when) {
        when = value;
      }

      if (label === "where:" && !where) {
        where = value;
      }
    });

    res.json({ when, where });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch ride details" });
  }
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`Ride Radar server running on port ${PORT}`);
});