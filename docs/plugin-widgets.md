# Plugin widgets

A **plugin widget** shows the value returned by a small JavaScript file you write on
one of a deck's display-only side keys (the 293S sixth column). The plugin runs on a
poll loop, fetches or computes whatever it wants, and returns a short string;
DeckBridge renders that string on the key as centered text and refreshes it every
interval.

Plugins run in a **dedicated worker thread**, isolated from the network ACK loop, so a
slow, looping, or throwing plugin can never stall image delivery or the web UI.

## Where plugin files go

Drop your `*.js` files in the `plugins/` directory next to DeckBridge's cache/settings
store:

| OS | Plugins directory |
|---|---|
| macOS | `~/Library/Caches/deckbridge/plugins/` |
| Linux | `$XDG_CACHE_HOME/deckbridge/plugins/` (or `~/.cache/deckbridge/plugins/` if `XDG_CACHE_HOME` is unset) |

Each file is one plugin. The file name (e.g. `worldclock.js`) is what you assign to a
side key.

Alternatively, pick **Custom path…** in the plugin dropdown and enter an absolute path
to a plugin file anywhere on disk (e.g. a plugin kept in your dotfiles repo). Bare file
names resolve against the plugins directory; absolute paths are used as-is.

## The plugin contract

A plugin is an ES module with a **default export** object exposing an async `fetch`
function:

```js
// <plugins dir>/myplugin.js
export default {
  interval: 30_000,          // optional; poll period in ms (see below)
  async fetch(ctx) {
    const res = await ctx.fetch('http://example.local/api/value');
    const { value } = await res.json();
    return `Label\n${value}`; // string → up to 4 centered lines; null → clear the key
  },
};
```

The module is imported **once** when the key is configured, then `fetch(ctx)` is called
on every poll tick. It may be `async` (return a `Promise`) or synchronous.

### `ctx` reference

| Property | Type | Description |
|---|---|---|
| `ctx.param` | `string` | The per-key argument you set for this key. Empty string if none. Use it to parameterize one plugin file across keys (a location, an entity id, an offset…). |
| `ctx.fetch(url, init?)` | `(string, {method?, headers?, body?}) => Promise` | Proxied HTTP request. Resolves to `{ ok, status, text(), json() }` — `text()` returns the body string, `json()` parses it as JSON. **`http://` only** (see [Limitations](#limitations)). |
| `ctx.log(message)` | `(string) => void` | Write a line to DeckBridge's log, tagged `plugin:<filename>`. |

### Return value

- **`string`** — rendered as up to **4 centered lines** (split on `\n`); short single
  lines use a larger font. The string is capped at **256 characters** before rendering.
- **`null`** (or `undefined`) — clears the key (shows nothing).
- Anything else, or a thrown error, marks the key `ERR` (see below).

### Poll interval

The delay between polls, in milliseconds, is chosen as:

```
max(1000, perKeyOverride ?? plugin.interval ?? 5000)
```

- Default when unset: **5000 ms** (5 s).
- Minimum enforced: **1000 ms** (1 s) — smaller values are clamped up.
- A per-key interval override (if set for the key) takes precedence over the plugin's
  own `interval`.

## Lifecycle & key states

The worker starts lazily when the first plugin key is configured and stops when no
plugin keys remain. What the key shows reflects the plugin's state:

| On the key | Meaning |
|---|---|
| `…` | No value yet — the plugin has been configured but its first `fetch` hasn't returned. |
| *(your text)* | The most recent string the plugin returned. |
| *(blank)* | The plugin returned `null`. |
| `ERR` | The plugin failed to load, threw, returned a non-string, or was disabled (below). The failure is also warn-logged with the plugin name. |

Failure handling:

- A **load failure** (bad file, no default export, no `fetch`) is terminal for that
  plugin — it stops and the key stays `ERR` until the config changes.
- A **per-poll throw** (e.g. a network blip) is transient — the key shows `ERR`, but the
  plugin keeps polling and recovers on the next successful return.
- If the worker **hangs or crashes**, DeckBridge terminates and respawns it. After
  repeated respawns in a row (a crash-looping plugin), plugins are **disabled** (`ERR`)
  until you change the key's configuration — this stops a broken plugin from burning
  CPU.

## Limitations

- **Plain `http://` only.** The DeckBridge runtime has no TLS, so `ctx.fetch` rejects
  `https://` URLs. Talk to services over `http` on the LAN, or put a local http proxy in
  front of an https endpoint.
- **Do not use the global `fetch` or `WebSocket`.** They are removed from the plugin
  worker on startup — calling them throws (in the underlying runtime they would abort the
  whole process). Always use `ctx.fetch` for HTTP.
- **Value length cap.** Returned strings are truncated to 256 characters. A side key only
  fits a few short lines anyway.
- **Absolute paths only for imports.** DeckBridge imports your file by its on-disk path;
  don't rely on `file://` URLs or relative imports of sibling files.

## Security

A plugin is **arbitrary code with the same trust level as the command widget** — it runs
with full filesystem, process-spawn, and native-library access via the runtime. The
worker is a crash/CPU isolation boundary, **not a capability sandbox**. The web UI has no
authentication and binds all interfaces by default, so anyone who can reach it could, in
principle, point a key at a plugin file on the host. Plugin widgets are **opt-in per key**
and meant for a **trusted personal LAN** — the same local-tool pragmatism as the command
widget and the weather widget's cleartext HTTP. Only run plugin files you wrote or trust.

## Examples

Ready-to-use example plugins live in
[`examples/plugins/`](https://github.com/lukasMega/DeckBridge/tree/main/deckbridge/examples/plugins)
in the repository:

- **`worldclock.js`** — the minimal plugin: shows `HH:MM` at a fixed UTC offset passed via
  `ctx.param` (e.g. `-5`, `+9`, `5.5`). Pure computation, no network.
- **`home-assistant.js`** — fetches a Home Assistant entity's state over the REST API
  (`GET {baseUrl}/api/states/{entity}` with a bearer token) and shows its state and unit.
  `ctx.param` format: `baseUrl|token|entity` (plain http — no TLS).
