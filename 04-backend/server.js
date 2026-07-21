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

const CONFIG = {
  business:     'Rhema Rides',
  driverPhone:  process.env.DRIVER_PHONE  || '(469) 360-0916',
  driverEmail:  process.env.DRIVER_EMAIL  || 'michaelherron@rhemataxservices.com',
  emailFrom:    process.env.EMAIL_FROM    || 'bookings@rhemarides.com',
  textbeeKey:   process.env.TEXTBEE_API_KEY  || '',
  textbeeDevice:process.env.TEXTBEE_DEVICE_ID || '',
  resendKey:    process.env.RESEND_API_KEY || '',
};

/* ---- send one SMS through textbee (free, driver's Android SIM) ---- */
async function sendText(toPhone, message) {
  if (!CONFIG.textbeeKey || !CONFIG.textbeeDevice) {
    console.log('[SMS skipped — no textbee key] ->', toPhone, '::', message);
    return;
  }
  await fetch(`https://api.textbee.dev/api/v1/gateway/devices/${CONFIG.textbeeDevice}/send-sms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.textbeeKey },
    body: JSON.stringify({ recipients: [toPhone], message }),
  });
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
        const out = await handleRideRequest(c.args);
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

app.get('/health', (_req, res) => res.json({ ok: true, service: 'rhema-notify' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Rhema Rides notify server on :' + PORT));
