/*
  RHEMA RIDES — LIVE NOTIFICATION SERVER  (ready to activate)
  ------------------------------------------------------------
  This small server turns the SIMULATED texts + email in booking-store.js
  into REAL ones, AND receives ride requests from the AI phone line (Vapi).
  It is written and ready — it just needs the account keys (below) to go live.

  It can send:
    • TEXT #1  -> the DRIVER   (new-booking / new-request alert)  via textbee (free SMS)
    • EMAIL    -> the DRIVER   (full record)                      via Resend
    • TEXT #2  -> the CLIENT   (confirmation / "we'll confirm")    via textbee (free SMS)

  Endpoints:
    POST /api/booking   -> website booking form (fires "you're booked ✓")
    POST /api/vapi      -> AI phone line (Vapi custom tools): quote_fare + submit_ride_request
    POST /api/request   -> plain ride REQUEST (same as vapi, non-Vapi shape) — handy for testing
    GET  /health        -> uptime check

  ---------------------------------------------------------------------------
  ONE-TIME SETUP (when the keys are ready)
  ---------------------------------------------------------------------------
  1. Install:   npm init -y && npm install express      (Node 18+; uses built-in fetch)
  2. .env:      TEXTBEE_API_KEY, TEXTBEE_DEVICE_ID  (textbee.dev — the Android)
                RESEND_API_KEY                       (resend.com)
                DRIVER_PHONE, DRIVER_EMAIL           (defaulted below)
  3. Deploy this to a Node host (Render/Railway/Fly — free tiers work) so it has
     a public HTTPS URL, then point the Vapi tool's Server URL at  <that-url>/api/vapi
  4. Missing keys are skipped gracefully, so SMS and email can be turned on
     independently and you can test everything before the keys exist.
*/

const express = require('express');
const { quoteForMiles } = require('./pricing');
const app = express();
app.use(express.json());

/* ---- allow the dashboard (hosted on a different domain) to call this API ---- */
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const CONFIG = {
  business:     'Rhema Rides',
  driverPhone:  process.env.DRIVER_PHONE  || '(469) 360-0916',
  driverEmail:  process.env.DRIVER_EMAIL  || 'michaelherron@rhemataxservices.com',
  emailFrom:    process.env.EMAIL_FROM    || 'bookings@rhemarides.com',
  textbeeKey:   process.env.TEXTBEE_API_KEY  || '',
  textbeeDevice:process.env.TEXTBEE_DEVICE_ID || '',
  resendKey:    process.env.RESEND_API_KEY || '',
  // Twilio SMS (Option B) — if these are set, SMS goes through Twilio instead of textbee.
  twilioSid:    process.env.TWILIO_ACCOUNT_SID || '',
  twilioToken:  process.env.TWILIO_AUTH_TOKEN  || '',
  twilioFrom:   process.env.TWILIO_FROM_NUMBER || '',
  // Supabase (shared bookings database) — powers the cross-device dashboard.
  supabaseUrl:  process.env.SUPABASE_URL || '',
  supabaseKey:  process.env.SUPABASE_SERVICE_KEY || '',
  dashToken:    process.env.DASHBOARD_TOKEN || '',
};

/* ---- send one SMS — Twilio if configured, otherwise textbee ----
   Provider is chosen automatically:
     • If TWILIO_* env vars are set  -> send via Twilio (business number, texts anyone incl. the driver)
     • else if TEXTBEE_* are set     -> send via textbee (free, from the gateway phone's SIM)
     • else                          -> skip gracefully (logged) */
async function sendText(toPhone, message) {
  if (CONFIG.twilioSid && CONFIG.twilioToken && CONFIG.twilioFrom) {
    return sendTextTwilio(toPhone, message);
  }
  if (CONFIG.textbeeKey && CONFIG.textbeeDevice) {
    return sendTextTextbee(toPhone, message);
  }
  console.log('[SMS skipped — no SMS provider configured] ->', toPhone, '::', message);
}

/* ---- Twilio SMS (from the business number; can text the driver too) ---- */
async function sendTextTwilio(toPhone, message) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${CONFIG.twilioSid}/Messages.json`;
  const form = new URLSearchParams({ To: toPhone, From: CONFIG.twilioFrom, Body: message });
  const auth = Buffer.from(`${CONFIG.twilioSid}:${CONFIG.twilioToken}`).toString('base64');
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + auth,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    console.error('[Twilio SMS failed]', resp.status, '->', toPhone, '::', detail);
  }
}

/* ---- textbee SMS (free, sends from the gateway phone's Android SIM) ---- */
async function sendTextTextbee(toPhone, message) {
  const resp = await fetch(`https://api.textbee.dev/api/v1/gateway/devices/${CONFIG.textbeeDevice}/send-sms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.textbeeKey },
    body: JSON.stringify({ recipients: [toPhone], message }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    console.error('[textbee SMS failed]', resp.status, '->', toPhone, '::', detail);
  }
}

/* ---- send the driver email through Resend ---- */
async function sendEmail(subject, body) {
  if (!CONFIG.resendKey) {
    console.log('[email skipped — no Resend key] ->', CONFIG.driverEmail, '::', subject);
    return;
  }
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.resendKey}` },
    body: JSON.stringify({ from: CONFIG.emailFrom, to: CONFIG.driverEmail, subject, text: body }),
  });
}

/* ---- short request/booking id like R-7Q3K8 ---- */
function genId(prefix) {
  const s = Math.random().toString(36).slice(2, 7).toUpperCase();
  return (prefix || 'R') + '-' + s;
}

/* ===========================================================
   SUPABASE — shared bookings database (powers the dashboard)
   Uses the REST (PostgREST) API with the service key. If the
   keys aren't set, these no-op gracefully so the server still
   runs and sends notifications.
   =========================================================== */
function supaHeaders() {
  return {
    'Content-Type': 'application/json',
    apikey: CONFIG.supabaseKey,
    Authorization: 'Bearer ' + CONFIG.supabaseKey,
  };
}

// Save one booking/request into the rhema_bookings table.
async function saveBooking(b, source) {
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) {
    console.log('[DB skipped — no Supabase key] ->', source, b.id || '');
    return;
  }
  const row = {
    ref:        b.id || null,
    source:     source || 'website',
    status:     'new',
    name:       b.name || null,
    phone:      b.phone || null,
    email:      b.email || null,
    pickup:     b.pickup || null,
    dropoff:    b.dropoff || null,
    when_text:  b.when || null,
    passengers: (b.passengers != null ? String(b.passengers) : null),
    miles:      (b.miles != null && b.miles !== '' ? Number(b.miles) : null),
    price:      (b.price != null && b.price !== '' ? Number(b.price) : null),
    notes:      b.notes || null,
  };
  try {
    const resp = await fetch(CONFIG.supabaseUrl + '/rest/v1/rhema_bookings', {
      method: 'POST',
      headers: Object.assign(supaHeaders(), { Prefer: 'return=minimal' }),
      body: JSON.stringify(row),
    });
    if (!resp.ok) console.error('[Supabase save failed]', resp.status, await resp.text().catch(() => ''));
  } catch (err) {
    console.error('[Supabase save error]', String(err));
  }
}

// Read all bookings (newest first) for the dashboard.
async function listBookings() {
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) return [];
  const url = CONFIG.supabaseUrl +
    '/rest/v1/rhema_bookings?select=*&order=created_at.desc&limit=500';
  const resp = await fetch(url, { headers: supaHeaders() });
  if (!resp.ok) throw new Error('list failed ' + resp.status);
  return resp.json();
}

// Update a booking's status by its database id.
async function updateBookingStatus(id, status) {
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) return;
  const url = CONFIG.supabaseUrl + '/rest/v1/rhema_bookings?id=eq.' + encodeURIComponent(id);
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: Object.assign(supaHeaders(), { Prefer: 'return=minimal' }),
    body: JSON.stringify({ status: status }),
  });
  if (!resp.ok) throw new Error('update failed ' + resp.status);
}

/* ===========================================================
   WEBSITE BOOKING (confirmed) — "you're booked ✓"
   =========================================================== */
function buildMessages(b) {
  const priceTxt = b.price ? ('$' + b.price) : 'TBD';
  const driverSms =
    CONFIG.business + ': New booking ' + b.id + ' from ' + b.name +
    '. ' + (b.pickup || '?') + ' → ' + (b.dropoff || '?') +
    (b.when ? (' @ ' + b.when) : '') + '. Fare ' + priceTxt +
    '. Call ' + b.phone + '.';
  const emailSubject = 'New booking ' + b.id + ' — ' + b.name;
  const emailBody =
    'You have a new ride request.\n\n' +
    'Booking: ' + b.id + '\n' +
    'Customer: ' + b.name + '  (' + b.phone + ')\n' +
    (b.email ? ('Email: ' + b.email + '\n') : '') +
    'Pickup: ' + b.pickup + '\n' +
    'Drop-off: ' + b.dropoff + '\n' +
    'When: ' + (b.when || 'ASAP') + '\n' +
    (b.miles ? ('Distance: ~' + b.miles + ' mi\n') : '') +
    'Fare (flat): ' + priceTxt + '\n' +
    (b.notes ? ('Notes: ' + b.notes + '\n') : '') +
    '\n— ' + CONFIG.business;
  const clientSms =
    'Hi ' + (b.name ? b.name.split(' ')[0] : 'there') + ', ' + CONFIG.business +
    ' here ✓ Your ride ' + b.id + ' is booked: ' + (b.pickup || '?') +
    ' → ' + (b.dropoff || '?') + (b.when ? (' @ ' + b.when) : '') +
    '. Flat fare ' + priceTxt + '. Track your driver live: rhemarides.com/track?id=' + b.id +
    ' — we will text when the driver is on the way.';
  return { driverSms, emailSubject, emailBody, clientSms };
}

app.post('/api/booking', async (req, res) => {
  try {
    const b = req.body || {};
    const m = buildMessages(b);
    await saveBooking(b, 'website');
    await sendText(CONFIG.driverPhone, m.driverSms);
    await sendEmail(m.emailSubject, m.emailBody);
    if (b.phone) await sendText(b.phone, m.clientSms);
    res.json({ ok: true, id: b.id });
  } catch (err) {
    console.error('booking notify failed:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ===========================================================
   RIDE REQUEST (unconfirmed) — from the AI phone line.
   Michael gets the details and TEXTS THE RIDER BACK to confirm.
   =========================================================== */
function buildRequestMessages(b) {
  const estTxt = b.price ? ('~$' + b.price + ' flat (est.)') : 'TBD';
  const driverSms =
    CONFIG.business + ' — NEW PHONE REQUEST ' + b.id + ' (please confirm): ' +
    b.name + ' ' + (b.phone || '') + '. ' + (b.pickup || '?') + ' → ' +
    (b.dropoff || '?') + (b.when ? (' @ ' + b.when) : ' (ASAP)') +
    '. Est ' + estTxt + '. Text them back to confirm.';
  const emailSubject = 'Phone ride REQUEST ' + b.id + ' — ' + b.name + ' (confirm needed)';
  const emailBody =
    'A caller left a ride request through the AI phone line.\n' +
    'ACTION: text the rider back to confirm the trip and the flat rate.\n\n' +
    'Request: ' + b.id + '\n' +
    'Caller: ' + b.name + '  (' + (b.phone || 'no number given') + ')\n' +
    'Pickup: ' + (b.pickup || '?') + '\n' +
    'Drop-off: ' + (b.dropoff || '?') + '\n' +
    'When: ' + (b.when || 'ASAP') + '\n' +
    (b.passengers ? ('Passengers: ' + b.passengers + '\n') : '') +
    (b.miles ? ('Distance: ~' + b.miles + ' mi\n') : '') +
    'Estimated flat fare: ' + estTxt + '\n' +
    (b.notes ? ('Notes: ' + b.notes + '\n') : '') +
    '\n— ' + CONFIG.business + ' (AI phone line)';
  const clientSms =
    'Hi ' + (b.name ? b.name.split(' ')[0] : 'there') + ', thanks for calling ' +
    CONFIG.business + '! We have your ride request (' + b.id + '). Michael will text ' +
    'you shortly to confirm the trip and your flat rate.';
  return { driverSms, emailSubject, emailBody, clientSms };
}

// Take a ride REQUEST, notify the driver, acknowledge the rider. Returns the id + estimate.
async function handleRideRequest(raw) {
  const b = Object.assign({}, raw);
  b.id = b.id || genId('R');
  if (!b.price && b.miles) b.price = quoteForMiles(b.miles).price; // estimate only
  const m = buildRequestMessages(b);
  await saveBooking(b, 'phone');
  await sendText(CONFIG.driverPhone, m.driverSms);
  await sendEmail(m.emailSubject, m.emailBody);
  if (b.phone) await sendText(b.phone, m.clientSms);
  return { id: b.id, price: b.price || null };
}

// Plain (non-Vapi) request shape — useful for testing.
app.post('/api/request', async (req, res) => {
  try {
    const out = await handleRideRequest(req.body || {});
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error('request failed:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ===========================================================
   VAPI WEBHOOK — the AI phone line calls this.
   Handles two custom tools:
     • quote_fare          { miles }                         -> speak the flat band
     • submit_ride_request { name, phone, pickup, dropoff,
                             when, passengers, miles, notes } -> notify Michael
   Returns Vapi's expected  { results: [{ toolCallId, result }] }
   =========================================================== */
function normalizeToolCall(tc) {
  const fn = tc.function || tc;
  let args = fn.arguments;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch (_) { args = {}; } }
  return {
    id: tc.id || tc.toolCallId || (fn && fn.id) || '',
    name: fn.name || tc.name || '',
    args: args || {},
  };
}

app.post('/api/vapi', async (req, res) => {
  try {
    const msg = (req.body && req.body.message) || {};
    const calls = msg.toolCallList || msg.toolCalls || [];

    // Caller ID from the Vapi call, as a fallback when the AI didn't capture the phone.
    const callerNumber =
      (msg.call && msg.call.customer && msg.call.customer.number) ||
      (msg.customer && msg.customer.number) ||
      (msg.call && msg.call.from) || null;

    const results = [];

    for (const rawCall of calls) {
      const c = normalizeToolCall(rawCall);
      let result;

      if (c.name === 'quote_fare') {
        const band = quoteForMiles(c.args.miles);
        const range = band.maxMiles === Infinity ? '40+ miles' : ('up to ' + band.maxMiles + ' miles');
        result = 'The flat rate for a trip ' + range + ' is about $' + band.price +
                 '. Michael confirms the exact flat rate when he texts you back.';
      } else if (c.name === 'submit_ride_request') {
        // Tolerate mis-labeled fields from the assistant (e.g. "Drop-off", "Passengers",
        // "name.") by mapping common variants onto the keys the notifier expects.
        const a = c.args;
        a.name     = a.name     || a['name.'] || a.fullName || a.customer || '';
        a.dropoff  = a.dropoff  || a['Drop-off'] || a.dropOff || a.destination || a.dropoff_location || '';
        a.pickup   = a.pickup   || a.Pickup || a.pickup_location || '';
        a.passengers = a.passengers || a.Passengers || '';

        // Only trust a phone value that actually looks like a number; otherwise use caller ID.
        const digits = String(a.phone || '').replace(/\D/g, '');
        if (digits.length < 10) a.phone = callerNumber || '';
        if (!a.name) a.name = 'Caller';

        const out = await handleRideRequest(a);
        result = 'Got it — request ' + out.id + ' has been sent to Michael. ' +
                 'He will text the caller shortly to confirm the ride' +
                 (out.price ? (' and the flat rate, about $' + out.price + '.') : '.');
      } else {
        result = 'Unknown tool: ' + c.name;
      }

      results.push({ toolCallId: c.id, result });
    }

    res.json({ results });
  } catch (err) {
    console.error('vapi webhook failed:', err);
    res.status(500).json({ results: [{ toolCallId: '', result: 'Sorry, something went wrong saving that request.' }] });
  }
});

/* ===========================================================
   DASHBOARD DATA — the driver dashboard reads/writes here.
   Protected by a shared token (?token=...).
   =========================================================== */
function tokenOk(req) {
  if (!CONFIG.dashToken) return true; // no token configured = open
  const t = (req.query && req.query.token) || (req.body && req.body.token) || '';
  return t === CONFIG.dashToken;
}

app.get('/api/bookings', async (req, res) => {
  if (!tokenOk(req)) return res.status(401).json({ ok: false, error: 'bad token' });
  try {
    const bookings = await listBookings();
    res.json({ ok: true, bookings });
  } catch (err) {
    console.error('list bookings failed:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.post('/api/bookings/update', async (req, res) => {
  if (!tokenOk(req)) return res.status(401).json({ ok: false, error: 'bad token' });
  try {
    const b = req.body || {};
    if (!b.id || !b.status) return res.status(400).json({ ok: false, error: 'id and status required' });
    await updateBookingStatus(b.id, b.status);
    res.json({ ok: true });
  } catch (err) {
    console.error('update booking failed:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, service: 'rhema-notify' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Rhema Rides notify server on :' + PORT));
