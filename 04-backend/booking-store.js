/* ============================================================
   RHEMA RIDES — MOCK BACKEND + NOTIFICATION ENGINE
   ------------------------------------------------------------
   Front-end mock: connects the landing page to the dashboard
   using the browser's localStorage, and SIMULATES the texts +
   email that would notify the driver and confirm to the client
   when a booking comes in.

   Two different texts are produced for every booking:
     • TEXT #1  -> the DRIVER  ("New booking!")
     • TEXT #2  -> the CLIENT  ("You're booked ✓")
   Plus one EMAIL -> the DRIVER (full record).

   Nothing is really sent yet. See README.md for how to swap the
   simulated parts for real textbee (SMS) + Resend (email).
   ============================================================ */
(function (global) {
  "use strict";

  var BOOKINGS_KEY = "rhema_bookings";
  var NOTIFY_KEY   = "rhema_notifications";
  var BLOCKS_KEY   = "rhema_blocks";
  var EMAILS_KEY   = "rhema_emails";

  /* ---- Driver / business config ---- */
  var CONFIG = {
    business:     "Rhema Rides",
    driverName:   "Michael Herron",
    driverPhone:  "(469) 360-0916",        // where the driver alert text goes
    driverEmail:  "michaelherron@rhemataxservices.com",  // where the driver email goes
    tagline:      "Your ride, your time",
    trustLine:    "A ride you can depend on.",
    vehicle:      "Black 2025 Kia Sportage · plate WFL 7873",
    serviceArea:  "Denton, Dallas & Fort Worth (the Metroplex). Longer trips can be discussed.",
    // Hours vary. Core windows: morning rush + airport 8am–12pm; late nights 8pm–1am.
    businessHours: "8am–12pm and 8pm–1am (varies)"
  };

  /* ---- FLAT-RATE pricing by distance band ----
     UPDATED from Michael's intake: $20 flat for a local Denton ride, and ~10 miles
     covers most of Denton, so the two lowest bands are merged into one $20 local band.
     >>> PENDING CONFIRMATION on the call — the mid-range (11–25 mi) is the one number
         to review together; everything 25 mi+ is unchanged from the original plan. */
  var PRICING = [
    { id: "town",    label: "Local / Denton",     maxMiles: 10,       price: 20 },
    { id: "cross",   label: "Cross-town",         maxMiles: 25,       price: 40 },
    { id: "long",    label: "Long distance",      maxMiles: 40,       price: 60 },
    { id: "airport", label: "Airport / 40+ mi",   maxMiles: Infinity, price: 80 }
  ];

  function quoteForMiles(miles) {
    for (var i = 0; i < PRICING.length; i++) {
      if (miles <= PRICING[i].maxMiles) return PRICING[i];
    }
    return PRICING[PRICING.length - 1];
  }

  /* estimated ride length in minutes (no buffer — just the ride) */
  function estimateDuration(miles) {
    if (!miles) return 45;                 // unknown trip -> assume 45 min
    return Math.max(15, Math.round(miles * 2.5)); // ~25 mph city average
  }
  function tms(dateStr, timeStr) { return new Date(dateStr + "T" + (timeStr || "00:00")).getTime(); }
  function overlaps(aS, aE, bS, bE) { return aS < bE && bS < aE; }

  /* ---- low-level storage helpers ---- */
  function read(key) {
    try { return JSON.parse(global.localStorage.getItem(key)) || []; }
    catch (e) { return []; }
  }
  function write(key, val) {
    global.localStorage.setItem(key, JSON.stringify(val));
  }

  function rand(n) { return Math.random().toString(36).toUpperCase().slice(2, 2 + n); }
  function newId() {
    return "RR-" + Date.now().toString(36).toUpperCase().slice(-5) + rand(2);
  }

  /* ---- public API ---- */
  var Store = {
    CONFIG: CONFIG,
    PRICING: PRICING,
    quoteForMiles: quoteForMiles,

    getBookings: function () {
      return read(BOOKINGS_KEY).sort(function (a, b) {
        return b.createdAt - a.createdAt;
      });
    },

    /* Called by the landing-page booking form and the AI phone agent */
    addBooking: function (data) {
      var bookings = read(BOOKINGS_KEY);
      var booking = {
        id:        newId(),
        name:      data.name || "",
        phone:     data.phone || "",
        email:     data.email || "",
        pickup:    data.pickup || "",
        dropoff:   data.dropoff || "",
        when:      data.when || "",
        source:    data.source || "Website",
        promo:     data.promo || "",
        miles:     data.miles || null,
        price:     data.price || null,
        durationMin: data.durationMin || estimateDuration(data.miles),
        notes:     data.notes || "",
        status:    "New",
        createdAt: Date.now()
      };
      bookings.push(booking);
      write(BOOKINGS_KEY, bookings);

      /* fire the (simulated) notifications */
      this._notify(booking);
      return booking;
    },

    updateStatus: function (id, status) {
      var bookings = read(BOOKINGS_KEY);
      for (var i = 0; i < bookings.length; i++) {
        if (bookings[i].id === id) { bookings[i].status = status; break; }
      }
      write(BOOKINGS_KEY, bookings);
    },

    removeBooking: function (id) {
      write(BOOKINGS_KEY, read(BOOKINGS_KEY).filter(function (b) { return b.id !== id; }));
    },

    clearAll: function () {
      write(BOOKINGS_KEY, []);
      write(NOTIFY_KEY, []);
    },

    getNotifications: function () {
      return read(NOTIFY_KEY).sort(function (a, b) { return b.at - a.at; });
    },

    /* ---- availability blocks (driver marks dates/times unavailable) ---- */
    getBlocks: function () {
      return read(BLOCKS_KEY).sort(function (a, b) {
        return (a.date + a.start).localeCompare(b.date + b.start);
      });
    },
    addBlock: function (b) {
      var blocks = read(BLOCKS_KEY);
      var blk = {
        id: "BL-" + Date.now().toString(36).toUpperCase().slice(-4) + rand(2),
        date: b.date || "", start: b.start || "00:00", end: b.end || "23:59",
        allDay: !!b.allDay, reason: b.reason || "Unavailable", createdAt: Date.now()
      };
      blocks.push(blk); write(BLOCKS_KEY, blocks); return blk;
    },
    removeBlock: function (id) {
      write(BLOCKS_KEY, read(BLOCKS_KEY).filter(function (x) { return x.id !== id; }));
    },

    /* ---- overbooking protection ---- */
    estimateDuration: estimateDuration,

    bookingWindow: function (b) {
      if (!b || !b.when) return null;
      var s = new Date(b.when).getTime(); if (isNaN(s)) return null;
      return { start: s, end: s + (b.durationMin || estimateDuration(b.miles)) * 60000 };
    },

    /* First conflicting {type, item, label} for a proposed time, or null.
       opts.statuses = booking statuses that count as "committed" (default Accepted + On the way).
       opts.excludeId = a booking id to ignore (itself). Blocked times are always checked. */
    conflictFor: function (when, durationMin, opts) {
      opts = opts || {};
      if (!when) return null;
      var s = new Date(when).getTime(); if (isNaN(s)) return null;
      var e = s + (durationMin || 45) * 60000;
      var statuses = opts.statuses || ["Accepted", "On the way"];
      var blocks = read(BLOCKS_KEY), i;
      for (i = 0; i < blocks.length; i++) {
        var bk = blocks[i];
        var bs = bk.allDay ? tms(bk.date, "00:00") : tms(bk.date, bk.start);
        var be = bk.allDay ? tms(bk.date, "23:59") : tms(bk.date, bk.end);
        if (overlaps(s, e, bs, be)) return { type: "block", item: bk, label: "blocked time (" + (bk.reason || "off") + ")" };
      }
      var books = read(BOOKINGS_KEY);
      for (i = 0; i < books.length; i++) {
        var b = books[i];
        if (b.id === opts.excludeId || !b.when) continue;
        if (statuses.indexOf(b.status) === -1) continue;
        var w = this.bookingWindow(b); if (!w) continue;
        if (overlaps(s, e, w.start, w.end)) return { type: "booking", item: b, label: b.name + " (" + b.id + ")" };
      }
      return null;
    },

    /* Up to `limit` open start times "HH:MM" on dateStr for a durationMin ride */
    suggestSlots: function (dateStr, durationMin, limit) {
      limit = limit || 3; var out = [];
      for (var h = 6; h <= 22 && out.length < limit; h++) {
        for (var m = 0; m < 60 && out.length < limit; m += 30) {
          var hh = String(h).padStart(2, "0"), mm = String(m).padStart(2, "0");
          var when = dateStr + "T" + hh + ":" + mm;
          if (new Date(when).getTime() < Date.now()) continue;
          if (!this.conflictFor(when, durationMin)) out.push(hh + ":" + mm);
        }
      }
      return out;
    },

    /* ---- email capture (landing-page early access) ---- */
    addEmail: function (email, promo) {
      email = (email || "").trim().toLowerCase(); if (!email) return null;
      var list = read(EMAILS_KEY);
      if (list.some(function (e) { return e.email === email; })) return null; // dedupe
      var rec = { email: email, promo: promo || "WELCOME10", at: Date.now() };
      list.push(rec); write(EMAILS_KEY, list); return rec;
    },
    getEmails: function () { return read(EMAILS_KEY); },

    /* ---- the simulated notification layer ---- */
    _notify: function (b) {
      var priceTxt = b.price ? ("$" + b.price) : "TBD";

      /* TEXT #1 — booking alert FROM the system TO the driver */
      var smsText =
        CONFIG.business + ": New booking " + b.id + " from " + b.name +
        ". " + (b.pickup || "?") + " → " + (b.dropoff || "?") +
        (b.when ? (" @ " + b.when) : "") + ". Fare " + priceTxt +
        ". Call " + b.phone + ".";

      /* EMAIL — full booking record TO the driver */
      var emailSubject = "New booking " + b.id + " — " + b.name;
      var emailBody =
        "You have a new ride request.\n\n" +
        "Booking: " + b.id + "\n" +
        "Customer: " + b.name + "  (" + b.phone + ")\n" +
        (b.email ? ("Email: " + b.email + "\n") : "") +
        "Pickup: " + b.pickup + "\n" +
        "Drop-off: " + b.dropoff + "\n" +
        "When: " + (b.when || "ASAP") + "\n" +
        (b.miles ? ("Distance: ~" + b.miles + " mi\n") : "") +
        "Fare (flat): " + priceTxt + "\n" +
        (b.notes ? ("Notes: " + b.notes + "\n") : "") +
        "\n— " + CONFIG.business;

      /* TEXT #2 — confirmation FROM Rhema Rides TO the customer */
      var clientText =
        "Hi " + (b.name ? b.name.split(" ")[0] : "there") + ", " + CONFIG.business +
        " here ✓ Your ride " + b.id + " is booked: " + (b.pickup || "?") +
        " → " + (b.dropoff || "?") + (b.when ? (" @ " + b.when) : "") +
        ". Flat fare " + priceTxt + ". Track your driver live: rhemarides.com/track?id=" + b.id +
        " — we'll text when the driver is on the way.";

      var notes = read(NOTIFY_KEY);
      notes.push({ bookingId: b.id, channel: "sms",   audience: "driver", to: CONFIG.driverPhone, text: smsText,    at: Date.now() });
      notes.push({ bookingId: b.id, channel: "email", audience: "driver", to: CONFIG.driverEmail, subject: emailSubject, body: emailBody, at: Date.now() + 1 });
      notes.push({ bookingId: b.id, channel: "sms",   audience: "client", to: b.phone,            text: clientText,  at: Date.now() + 2 });
      write(NOTIFY_KEY, notes);

      /* tell any open dashboard tab to refresh */
      try { global.localStorage.setItem("rhema_ping", String(Date.now())); } catch (e) {}
    }
  };

  global.RhemaStore = Store;
})(window);
