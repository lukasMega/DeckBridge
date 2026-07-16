// worldclock.js — show HH:MM at a fixed UTC offset on a side key.
//
// The minimal DeckBridge plugin: pure computation, no network. Demonstrates the
// contract (`export default { interval, async fetch(ctx) }`) and returning a
// string that the key renders as centered text.
//
// Usage: drop this file in the plugins dir, assign the "plugin" widget to a
//        side key with this file, and set the per-key argument (ctx.param) to
//        the UTC offset in hours:
//          "-5"  → New York (EST)
//          "+9"  → Tokyo
//          "5.5" → India (IST, half-hour offset)
//          ""    → UTC
// Suggested interval: 30000 (30 s) — keeps the displayed minute fresh.
export default {
  interval: 30_000,
  async fetch(ctx) {
    const offsetHours = Number(ctx.param) || 0;
    const shifted = new Date(Date.now() + offsetHours * 3_600_000);
    const hh = String(shifted.getUTCHours()).padStart(2, '0');
    const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  },
};
