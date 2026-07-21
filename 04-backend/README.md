# Rhema Rides — Backend

This folder is the "brain" that connects the landing page and the dashboard, and that fires
the driver's notifications. Today it runs as a **front-end mock** so you can demo the whole
experience with zero setup and zero cost. This file also shows exactly how to make each piece
**real** when you're ready.

---

## 1. What's here now (the mock)

**`booking-store.js`** — a small JavaScript module loaded by both the landing page and the dashboard.

It does four jobs:

1. **Stores bookings** in the browser (`localStorage`) so a ride booked on the landing page
   instantly shows up on the dashboard (same browser).
2. **Holds the pricing** — the affordable flat rates by distance, in one place so the landing
   page price bar and the quotes always match.
3. **Creates the notifications** — when a booking comes in it builds the SMS text and the email,
   and the dashboard displays them in the "Notifications" panel.
4. **Pings the dashboard** so an open dashboard tab refreshes the moment a new booking lands.

> Because it's a mock, **no real text or email is sent yet** — they're shown on the dashboard so
> you can see precisely what the driver would receive.

### Flat-rate pricing (edit in one place)

In `booking-store.js`, change the `PRICING` array:

| Band | Up to | Price |
|------|-------|-------|
| Around town | 5 mi | $15 |
| Standard trip | 12 mi | $25 |
| Cross-town | 25 mi | $40 |
| Long distance | 40 mi | $60 |
| Airport / 40+ | — | $80 |

Edit those numbers and both the landing page and dashboard update automatically.

---

## 2. Going live — turn the mock into a real backend

To send real texts/emails and accept phone bookings, you'll run a tiny server (one file) that the
landing page and the AI phone agent post bookings to. The recommended stack:

- **Server:** a single Node/Express endpoint (or a serverless function on Vercel/Cloudflare)
- **Database:** Supabase (free tier) — or keep it simple and just send notifications
- **SMS:** **textbee** (free — sends through the driver's own Android phone/SIM)
- **Email:** **Resend** (free tier: 3,000 emails/month)

There are **two different texts** in this system, and textbee can send both:
1. **Booking alert → the driver** ("New booking!")
2. **Confirmation → the client** ("You're booked ✓")

### 2a. Real SMS with textbee (recommended — free)

**textbee** is an open-source Android SMS gateway. You install the textbee app on an Android
phone (the driver's, or a cheap dedicated one), and your server sends texts *through that phone's
own SIM*. That means **$0 per message** (it uses the phone's existing texting plan), **no phone
number to buy**, and **no A2P 10DLC registration** — perfect for a one-driver business.

**Setup:** install the textbee app → sign in at textbee.dev → register the device → copy your
**API key** and **device ID**.

```js
// no SDK needed — one POST per text
async function sendText(toPhone, message) {
  await fetch('https://api.textbee.dev/api/v1/gateway/devices/DEVICE_ID/send-sms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'YOUR_TEXTBEE_API_KEY' },
    body: JSON.stringify({ recipients: [toPhone], message: message })
  });
}

// Text #1 — alert the driver
await sendText('+15551234567', smsText);      // booking-store.js builds this
// Text #2 — confirm to the client
await sendText(booking.phone, clientText);    // booking-store.js builds this too
```

> Trade-off: texts depend on that Android phone being on and having signal. For a solo chauffeur
> that's usually fine — and it's free. If you ever need guaranteed cloud delivery, swap to one of
> the paid options below without changing anything else.

**Paid / cloud alternatives for SMS (if you outgrow textbee):**
- **AWS SNS** — first 100 US texts/month free, then ~$0.0065 each.
- **TextBelt** — simple HTTP POST, ~$0.01/text, no monthly fee, no number (1 free test text/day).
- **Telnyx / Bandwidth** — ~$0.004/text, best at high volume (requires 10DLC registration).

### 2b. Real email with Resend

```js
// npm install resend
const { Resend } = require('resend');
const resend = new Resend(API_KEY);

await resend.emails.send({
  from: 'bookings@rhemarides.com',
  to:   'hello@rhemarides.com',  // the DRIVER's inbox
  subject: emailSubject,
  text: emailBody
});
```

### 2c. The booking endpoint

```js
// POST /api/booking  — called by the website form AND the AI phone agent
app.post('/api/booking', async (req, res) => {
  const b = req.body;                 // name, phone, pickup, dropoff, when, miles...
  // 1) save to your database (optional)
  // 2) text the DRIVER an alert (2a) + email the driver (2b)
  // 3) text the CLIENT a confirmation (2a)
  // 4) respond
  res.json({ ok: true, id: b.id });
});
```

When this is live, change the landing page form and the dashboard to `fetch('/api/booking', …)`
instead of the local mock — the data shape is identical to what `booking-store.js` already uses.

---

## 3. AI phone agent — Vapi (recommended, free tier)

Goal: someone **calls a number**, an **AI voice agent** answers 24/7, collects the trip details,
quotes the flat rate, and **creates the booking** — so phone calls land in the **same dashboard**
with the same text + email as web bookings.

**Why Vapi:** 1,000 free minutes/month to start, then ~$0.05/min platform fee (plus your own
voice/AI provider costs). It can call your booking endpoint via a "tool" / webhook.

### Setup steps

1. **Create a Vapi account** at vapi.ai and get a phone number (or connect your Twilio number).
2. **Create an Assistant** and paste the system prompt below.
3. **Add a "tool" (function)** named `create_booking` that does an HTTP **POST** to your
   `/api/booking` endpoint (section 2c) with these fields:
   `name, phone, pickup, dropoff, when, miles`.
4. Point your phone number at the assistant. Done — calls now create bookings.

### Suggested assistant prompt

```
You are the booking assistant for Rhema Rides, a personal chauffeur service.
Greet the caller warmly. Collect, one at a time:
  1) their name
  2) a callback phone number
  3) pickup location
  4) drop-off location
  5) date and time (or "as soon as possible")
Estimate the distance if you can. Quote the FLAT rate using these bands:
  up to 5 mi = $15, up to 12 mi = $25, up to 25 mi = $40, up to 40 mi = $60, 40+ mi = $80.
Confirm all details back to the caller, then call the create_booking tool.
Tell them the driver will get the request right away and will confirm shortly.
Keep it short, friendly, and clear.
```

### Webhook payload the tool should send

```json
{
  "name": "Alex Carter",
  "phone": "(555) 123-9876",
  "pickup": "123 Main St",
  "dropoff": "Intl Airport, Terminal 2",
  "when": "2026-07-01T15:30",
  "miles": 22,
  "source": "Phone (AI agent)"
}
```

> The dashboard already recognizes `"source": "Phone (AI agent)"` and tags those bookings with a
> 📞 **Phone (AI agent)** badge. Use the **🤖 Simulate phone booking** button on the dashboard to
> preview exactly how a Vapi call will appear before you wire it up.

### Alternatives if you'd rather not self-host

- **Retell AI** — $10 free credit, ~$0.07/min, very similar webhook setup.
- **Bland AI** — $0.14/min, no API keys needed (simplest), lighter integration.
- **Upfirst / Rosie** (~$25–49/mo) — fully turnkey, but bookings stay in their app and won't
  appear on this dashboard without extra work.

---

## 4. Maps, directions & live tracking

The dashboard and the rider tracking page use **`maps.js`** — free maps with **no API key**:

- **Display:** OpenStreetMap tiles via **Leaflet**.
- **Geocoding** (address → coordinates): **Nominatim** (free).
- **Route line:** **OSRM** public demo server.
- All three fall back gracefully (to a Dallas-area demo route) if you're offline, so the
  map always draws something.

**Driver side (dashboard):** every booking has a **🧭 Navigate** button that opens a map with the
pickup → drop-off route, plus two real **Google Maps** links:

- *Directions to pickup* — opens turn-by-turn from the driver's current location.
- *Pickup → drop-off* — the full trip.

There's also **Copy rider tracking link**, which gives the rider a `track.html?id=…` URL.

**Rider side (`track.html`):** shows a live map of the driver approaching, an ETA countdown,
the driver card (name, Kia Sportage, rating) and a call button. The booking confirmation on the
landing page and the client SMS both include this tracking link.

### Making the driver location REAL (not simulated)

Right now the driver marker is animated for the demo. To show the **actual** driver position:

1. **On the driver's phone** (a simple page the driver keeps open while driving), read GPS with the
   browser Geolocation API and push it to your backend every few seconds:
   ```js
   navigator.geolocation.watchPosition(function (pos) {
     fetch('/api/driver-location', { method:'POST',
       headers:{'Content-Type':'application/json'},
       body: JSON.stringify({ bookingId, lat: pos.coords.latitude, lng: pos.coords.longitude }) });
   }, null, { enableHighAccuracy:true });
   ```
2. **On the rider's `track.html`**, replace the simulated `animateAlong(...)` with a poll (or a
   websocket) that reads the latest driver location and moves the marker:
   ```js
   setInterval(async () => {
     const r = await (await fetch('/api/driver-location?bookingId='+id)).json();
     driver.setLatLng([r.lat, r.lng]);
   }, 4000);
   ```
3. Keep the Google Maps links for the driver's own turn-by-turn navigation — those already work.

That's the whole change: the map, markers, route and ETA UI all stay the same.

## Quick reference

| Piece | Mock (now) | Real (later) |
|-------|------------|--------------|
| Booking store | `localStorage` | Supabase / your DB |
| Web booking | form → `booking-store.js` | form → `POST /api/booking` |
| Phone booking | "Simulate" button | Vapi → `POST /api/booking` |
| Text → driver (alert) | shown on dashboard | textbee (free) |
| Text → client (confirmation) | shown on dashboard | textbee (free) |
| Email to driver | shown on dashboard | Resend |
