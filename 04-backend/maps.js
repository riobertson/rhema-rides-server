/* ============================================================
   RHEMA RIDES — MAP HELPERS  (free, no API key)
   ------------------------------------------------------------
   Uses OpenStreetMap tiles via Leaflet for display, Nominatim
   for geocoding addresses, and OSRM for the driving route line.
   All have free public endpoints (rate-limited) and work from a
   plain file:// page when you're online. Everything falls back
   gracefully so the demo still draws a map + route offline.

   The "driver location" is SIMULATED here (a marker animated
   along the route). See README.md §4 for turning it into real
   GPS tracking.
   ============================================================ */
(function (global) {
  "use strict";

  // Default city = Dallas, TX (matches the 469 area code)
  var BASE = { lat: 32.7767, lon: -96.7970 };
  var GEO_CACHE = "rhema_geocache";

  function readCache() { try { return JSON.parse(localStorage.getItem(GEO_CACHE)) || {}; } catch (e) { return {}; } }
  function writeCache(c) { try { localStorage.setItem(GEO_CACHE, JSON.stringify(c)); } catch (e) {} }

  // deterministic pseudo-coordinate from a string (stable per address)
  function hashCoord(str) {
    var h = 0; str = String(str || "x");
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffffffff;
    var dx = ((h % 1000) / 1000 - 0.5) * 0.16;        // ~±9 km
    var dy = (((h >> 10) % 1000) / 1000 - 0.5) * 0.16;
    return { lat: BASE.lat + dy, lon: BASE.lon + dx };
  }

  // Geocode a text address -> {lat,lon}. Tries Nominatim, falls back to hash.
  function geocode(q) {
    q = (q || "").trim();
    if (!q) return Promise.resolve(hashCoord("empty"));
    var cache = readCache();
    if (cache[q]) return Promise.resolve(cache[q]);
    var url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q);
    return fetch(url, { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var pt = (j && j[0]) ? { lat: +j[0].lat, lon: +j[0].lon } : hashCoord(q);
        cache[q] = pt; writeCache(cache);
        return pt;
      })
      .catch(function () { return hashCoord(q); });
  }

  // Driving route between two points -> array of [lat,lon]. OSRM, fallback curved line.
  function route(a, b) {
    var url = "https://router.project-osrm.org/route/v1/driving/" +
      a.lon + "," + a.lat + ";" + b.lon + "," + b.lat + "?overview=full&geometries=geojson";
    return fetch(url).then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.routes && j.routes[0]) {
          var coords = j.routes[0].geometry.coordinates.map(function (c) { return [c[1], c[0]]; });
          var dist = j.routes[0].distance, dur = j.routes[0].duration;
          return { line: coords, distance: dist, duration: dur };
        }
        return curved(a, b);
      })
      .catch(function () { return curved(a, b); });
  }
  function curved(a, b) {
    var pts = [], n = 24;
    var mx = (a.lat + b.lat) / 2 + (b.lon - a.lon) * 0.12;
    var my = (a.lon + b.lon) / 2 - (b.lat - a.lat) * 0.12;
    for (var i = 0; i <= n; i++) {
      var t = i / n, u = 1 - t;
      var lat = u*u*a.lat + 2*u*t*mx + t*t*b.lat;
      var lon = u*u*a.lon + 2*u*t*my + t*t*b.lon;
      pts.push([lat, lon]);
    }
    // rough haversine distance
    var d = haversine(a.lat, a.lon, b.lat, b.lon);
    return { line: pts, distance: d, duration: d / 11.5 }; // ~26 mph avg
  }
  function haversine(la1, lo1, la2, lo2) {
    var R = 6371000, p = Math.PI / 180;
    var dla = (la2 - la1) * p, dlo = (lo2 - lo1) * p;
    var x = Math.sin(dla/2)*Math.sin(dla/2) + Math.cos(la1*p)*Math.cos(la2*p)*Math.sin(dlo/2)*Math.sin(dlo/2);
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  // Google Maps turn-by-turn (real navigation), using the text addresses
  function gmapsDir(origin, dest) {
    return "https://www.google.com/maps/dir/?api=1" +
      "&origin=" + encodeURIComponent(origin || "") +
      "&destination=" + encodeURIComponent(dest || "") +
      "&travelmode=driving";
  }

  // Animate a marker along a [lat,lon] path. Returns {stop()}.
  function animateAlong(marker, line, opts) {
    opts = opts || {};
    var ms = opts.duration || 9000, onStep = opts.onStep, onDone = opts.onDone;
    if (!line || line.length < 2) { if (onDone) onDone(); return { stop: function(){} }; }
    var start = null, raf;
    function frame(ts) {
      if (!start) start = ts;
      var t = Math.min((ts - start) / ms, 1);
      var fi = t * (line.length - 1);
      var i = Math.floor(fi), f = fi - i;
      var a = line[i], b = line[Math.min(i + 1, line.length - 1)];
      var lat = a[0] + (b[0] - a[0]) * f, lon = a[1] + (b[1] - a[1]) * f;
      marker.setLatLng([lat, lon]);
      if (onStep) onStep(t, [lat, lon]);
      if (t < 1) raf = requestAnimationFrame(frame);
      else if (onDone) onDone();
    }
    raf = requestAnimationFrame(frame);
    return { stop: function () { if (raf) cancelAnimationFrame(raf); } };
  }

  function fmtMiles(m) { return (m / 1609.34).toFixed(1); }
  function fmtMins(s) { return Math.max(1, Math.round(s / 60)); }

  // simple coloured div marker
  function pin(color, label) {
    return L.divIcon({
      className: "", iconSize: [26, 26], iconAnchor: [13, 26],
      html: '<div style="width:26px;height:26px;transform:translateY(-2px)">' +
            '<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;background:' + color +
            ';transform:rotate(-45deg);border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);' +
            'display:flex;align-items:center;justify-content:center">' +
            '<span style="transform:rotate(45deg);color:#fff;font:700 11px Jost,sans-serif">' + (label || "") + '</span>' +
            '</div></div>'
    });
  }
  function carIcon() {
    return L.divIcon({
      className: "", iconSize: [34, 34], iconAnchor: [17, 17],
      html: '<div style="width:34px;height:34px;border-radius:50%;background:#0d1b2a;border:2px solid #c8a14a;' +
            'box-shadow:0 0 0 4px rgba(200,161,74,.25),0 4px 10px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;font-size:16px">🚙</div>'
    });
  }

  global.RhemaMaps = {
    BASE: BASE, geocode: geocode, route: route, gmapsDir: gmapsDir,
    animateAlong: animateAlong, fmtMiles: fmtMiles, fmtMins: fmtMins,
    pin: pin, carIcon: carIcon, hashCoord: hashCoord
  };
})(window);
