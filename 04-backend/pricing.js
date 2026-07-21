/*
  RHEMA RIDES — shared flat-rate pricing
  ------------------------------------------------------------
  Single source of truth for the flat-rate bands, used by both the
  website (booking-store.js) and the AI phone line (server.js /api/vapi).
  Keep this in sync with the PRICING array in booking-store.js.

  From Michael's intake: $20 flat for a local Denton ride (~10 mi covers
  most of Denton), then flat bands by distance. >>> The 11–25 mi band is
  pending final confirmation on the call.
*/
const PRICING = [
  { id: "town",    label: "Local / Denton",   maxMiles: 10,       price: 20 },
  { id: "cross",   label: "Cross-town",       maxMiles: 25,       price: 40 },
  { id: "long",    label: "Long distance",    maxMiles: 40,       price: 60 },
  { id: "airport", label: "Airport / 40+ mi", maxMiles: Infinity, price: 80 },
];

// Return the flat-rate band for a trip distance in miles.
function quoteForMiles(miles) {
  const m = Number(miles) || 0;
  for (const b of PRICING) {
    if (m <= b.maxMiles) return b;
  }
  return PRICING[PRICING.length - 1];
}

module.exports = { PRICING, quoteForMiles };
