const map = L.map('map').setView([-41.2, 174.7], 6);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
attribution: '© OpenStreetMap'
}).addTo(map);

let rides = [];
let currentRide = null;

function rideColour(type){

type = type.toLowerCase();

if(type.includes("trail")) return "green";
if(type.includes("cross")) return "blue";
if(type.includes("enduro")) return "orange";
if(type.includes("moto")) return "red";
if(type.includes("trial")) return "purple";

return "grey";
}

function createMarker(ride){

if(!ride.lat || !ride.lon) return;

const colour = rideColour(ride.type);

const marker = L.circleMarker([ride.lat, ride.lon],{
radius:8,
color:colour,
fillColor:colour,
fillOpacity:0.9
}).addTo(map);

marker.on("click",()=>openRideCard(ride));
}

function openRideCard(ride){

currentRide = ride;

document.getElementById("rideTitle").innerText = ride.title;
document.getElementById("rideDate").innerText = ride.date;
document.getElementById("rideType").innerText = ride.type;
document.getElementById("rideDistrict").innerText = ride.district;
document.getElementById("rideAddress").innerText = ride.address || "";

document.getElementById("rideCard").classList.remove("hidden");
}

document.getElementById("closeCard").onclick = () => {
document.getElementById("rideCard").classList.add("hidden");
};

document.getElementById("openEventBtn").onclick = () => {
if(currentRide) window.open(currentRide.link,"_blank");
};

document.getElementById("calendarBtn").onclick = () => {

if(!currentRide) return;

const date = currentRide.date.replace(/[a-z]/gi,'');

const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:${currentRide.title}
DESCRIPTION:${currentRide.type}
LOCATION:${currentRide.address || currentRide.district}
URL:${currentRide.link}
DTSTART:${date}
END:VEVENT
END:VCALENDAR`;

const blob = new Blob([ics],{type:"text/calendar"});
const url = URL.createObjectURL(blob);

const a = document.createElement("a");
a.href = url;
a.download = "ride.ics";
a.click();

URL.revokeObjectURL(url);
};

async function loadRides(){

const res = await fetch("/rides");
rides = await res.json();

rides.forEach(createMarker);
}

loadRides();