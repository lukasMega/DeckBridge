// countdown.js — count down to a target (or up from a past one) on a side key.
//
// Usage: drop this file in the plugins dir, assign the "plugin" widget to a
//        side key, and set the per-key argument (ctx.param) to the target,
//        optionally followed by "|" and a label shown above the counter:
//          "2026-12-31T23:59"      → countdown to New Year's Eve
//          "2026-08-01|vacation"   → days until Aug 1, labeled
//          "15:30"                 → countdown to 15:30 TODAY (HH:MM[:SS])
//          "2026-07-01|sober"      → past target: counts UP, prefixed "+"
//        Full targets are parsed with Date() — local time unless you add a
//        zone. A bare time means today's date at that time.
// Suggested interval: 1000 (1 s) while counting hours; the default 5 s is fine
// for day-level countdowns. The key repaints only when the text changes.
export default {
  interval: 1_000,
  async fetch(ctx) {
    const [rawTarget, label] = (ctx.param || '').split('|');
    const target = (rawTarget ?? '').trim();

    // "HH:MM" / "HH:MM:SS" → that time today (a timer within the current day).
    let t;
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(target)) {
      const [hh, mm, ss] = target.split(':').map(Number);
      t = new Date().setHours(hh, mm, ss ?? 0, 0);
    } else {
      t = new Date(target).getTime();
    }
    if (Number.isNaN(t)) return 'set\ntarget';

    // Future → count down; past → count up with a "+" prefix.
    const diff = Math.round((t - Date.now()) / 1000);
    const up = diff < 0;
    let s = Math.abs(diff);

    const days = Math.floor(s / 86_400);
    s -= days * 86_400;
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');

    // ≥1 day: "Nd" + HH:MM (short lines render big); under a day: HH:MM:SS.
    const sign = up ? '+' : '';
    const time = days > 0 ? `${sign}${days}d\n${hh}:${mm}` : `${sign}${hh}:${mm}:${ss}`;
    // const time = days > 0 ? `${sign}${days}d\n${hh}:${mm}` : `${sign}${hh}:${mm}`;
    return label ? `${label.trim()}\n${time}` : time;
  },
};
