// home-assistant.js — show a Home Assistant entity's state on a side key.
//
// Fetches the entity via the HA REST API
//   GET {baseUrl}/api/states/{entity}
// with a long-lived access token, and displays the state plus its unit.
//
// Usage: drop this file in the plugins dir, assign the "plugin" widget to a
//        side key with this file, and set the per-key argument (ctx.param) to
//        three fields separated by "|":
//          "http://ha.local:8123|LONG_LIVED_TOKEN|sensor.living_room_temp"
//           └ baseUrl ──────────┘└ token ────────┘└ entity_id ───────────┘
// Suggested interval: 30000 (30 s).
//
// PLAIN HTTP ONLY: the DeckBridge runtime has no TLS, so ctx.fetch accepts
// http:// URLs only — your Home Assistant must be reachable over http (e.g. on
// the LAN, or via a local http proxy). https:// URLs are rejected.
export default {
  interval: 30_000,
  async fetch(ctx) {
    const [baseUrl, token, entity] = ctx.param.split('|');
    if (!baseUrl || !token || !entity) {
      throw new Error('param must be "baseUrl|token|entity"');
    }
    const res = await ctx.fetch(`${baseUrl}/api/states/${entity}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`HA ${res.status}`);
    const data = await res.json();
    const unit = data.attributes && data.attributes.unit_of_measurement;
    return unit ? `${data.state}\n${unit}` : String(data.state);
  },
};
