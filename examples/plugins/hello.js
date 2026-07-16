// hello.js — the smallest possible DeckBridge plugin.
//
// Shows the per-key argument (or "hi") plus a tick counter, re-rendered every
// 5 s (the default interval). Copy this file to start a new plugin.
//
// Usage: drop in the plugins dir, assign the "plugin" widget to a side key,
//        pick this file; optional argument = the text to show on line 1.
let ticks = 0;

export default {
  async fetch(ctx) {
    ticks++;
    return `${ctx.param || 'hi'}\n${ticks}`;
  },
};
