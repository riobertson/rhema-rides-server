# Deploy the Rhema Rides server (gets your `/api/vapi` URL)

This puts `server.js` on the internet so (1) the website can send real texts/email and
(2) the AI phone line has a URL to call. Free host: **Render**.

## What you need first
- A free **GitHub** account (github.com) — the easiest way to get code onto Render.
- A free **Render** account (render.com) — sign in with GitHub.

## Step 1 — put the `04-backend` folder on GitHub
Easiest, no command line:
1. On github.com, click **New repository** → name it `rhema-rides-server` → **Create**.
2. On the new repo page, click **uploading an existing file**.
3. Drag in the contents of your `04-backend` folder: `server.js`, `pricing.js`,
   `booking-store.js`, `package.json`, `.gitignore`, `render.yaml`.
   (Do NOT upload a `.env` file or `node_modules`.)
4. Click **Commit changes**.

## Step 2 — deploy on Render
1. render.com → **New +** → **Web Service** → connect your GitHub and pick
   `rhema-rides-server`.
2. Settings (Render usually auto-fills these from `render.yaml`):
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
   - **Instance type:** Free
3. Click **Create Web Service** and wait for it to say **Live**.
4. Copy your URL — it looks like `https://rhema-notify.onrender.com`.
5. Test it: open `https://YOUR-URL/health` → you should see `{"ok":true}`.

**Your Vapi tool Server URL is:  `https://YOUR-URL/api/vapi`**  ← you'll paste this
into both tools in the Vapi assistant.

## Step 3 — add your keys (env vars) when ready
In Render → your service → **Environment** → add these (skip any you don't have yet —
the server runs fine without them, it just logs instead of sending):
- `DRIVER_PHONE`  = (469) 360-0916
- `DRIVER_EMAIL`  = michaelherron@rhemataxservices.com
- `TEXTBEE_API_KEY`, `TEXTBEE_DEVICE_ID`  (from textbee.dev)
- `RESEND_API_KEY`  (from resend.com)
Render redeploys automatically when you save.

## One caveat about the free plan (and the easy fix)
Render's free service **goes to sleep after ~15 minutes** of no traffic, and the next
request wakes it (can take ~30–50 seconds). For a live phone call that's too slow, so:
- Set up a free **UptimeRobot** (uptimerobot.com) monitor that pings
  `https://YOUR-URL/health` every 5 minutes. That keeps the server awake so calls
  answer instantly. (Or upgrade Render to a small paid instance later.)

## Then: finish the Vapi assistant
Once you have the `https://YOUR-URL/api/vapi` link, we'll create the assistant, paste
the system prompt from `../ai-phone-line/assistant-system-prompt.md`, and add the two
tools (`quote_fare`, `submit_ride_request`) pointing at that URL.
