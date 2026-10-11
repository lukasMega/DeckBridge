# Extensions

An **extension** adds an optional feature to DeckBridge without making the app bigger for
everyone. DeckBridge itself ships without it. You download an extension separately, drop it
in a folder, and switch it on in the web UI. No restart and no rebuild are needed.

The first extension is **Statistics**: session counters for key and dial presses,
reconnects, key images and cache hits, with a 15-minute activity chart.

## Install an extension

1. Download `deckbridge-ext-<name>-v<version>.zip` from the
   [releases page](https://github.com/lukasMega/DeckBridge/releases).
2. Unzip it into the extensions folder. The zip holds one folder, for example
   `statistics/`, and that folder goes directly into the extensions folder:

   | OS      | Extensions folder                                                                          |
   | ------- | ------------------------------------------------------------------------------------------ |
   | macOS   | `~/Library/Caches/deckbridge/extensions/`                                                  |
   | Linux   | `$XDG_CACHE_HOME/deckbridge/extensions/` (or `~/.cache/deckbridge/extensions/`)            |
   | Windows | `%LOCALAPPDATA%\deckbridge\extensions\`                                                    |

   `--cache-dir` moves it with the rest of the cache. **Settings → Extensions** shows the
   folder DeckBridge actually reads.
3. In the web UI, open **Settings → Extensions** and click **Rescan**.
4. Switch the extension on. An extension with a page gets a button in the top bar.

To remove an extension, switch it off and delete its folder. To update one, replace its
folder. DeckBridge runs only the files you switched on: after a change, Settings shows
_Stopped: files changed…_. Switch it off and on to run the new files.

## Trust

An extension runs with **the same rights as DeckBridge itself**: it can read and write your
files and start programs. Its worker thread protects DeckBridge from crashes and endless
loops, not from malicious code. Switch on only extensions you trust, as you would install
any other program.

For the same reason, the on/off state lives only in your own `settings.json`, in the
`extensions` record: each switched-on id, with the digest of its folder and the events it
may receive. Settings export includes that record; importing a settings file ignores it and
never switches an extension on.

When you switch an extension on, DeckBridge records a SHA-256 digest of every file in its
folder. It checks that digest when it scans the folder (at start-up and on Rescan) and when
you switch the extension on. It does not notice a change made between scans while DeckBridge
runs, and it does not stop a program running as your user, which can also edit `settings.json`.

## What you see in Settings

| Shown           | Meaning                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------- |
| switch off      | Installed, not running.                                                                   |
| _Starting…_     | Switched on; its worker is loading.                                                       |
| switch on       | Running.                                                                                  |
| _Stopped: …_    | It failed to load, or its worker crashed three times. Switch it off and on to retry.      |
| _Stopped: files changed…_ | Its files changed after you switched it on. Switch it off and on to run them.  |
| _Cannot run: …_ | The folder has a bad `manifest.json`, needs another extension API version, lacks `server.js`, or breaks a [folder rule](#folder-rules). |

A worker that stops answering for about 4 seconds is restarted. The third failure stops the
extension until you switch it on again. Counters of a restarted extension start from zero.

## Writing an extension

The Statistics source in `ts/src/extensions/statistics/` is a complete example. An
extension is a folder named after its id:

```
statistics/
  manifest.json   what it is and which API it needs
  server.js       runs in its own worker thread; gets deck events, answers HTTP calls
  ui.js           optional: the page the web UI mounts
```

### manifest.json

```json
{
  "id": "statistics",
  "name": "Statistics",
  "version": "1.0.0",
  "apiVersion": 1,
  "description": "Session counters …",
  "permissions": { "events": ["deckAttached", "input", "imageProcessed"] },
  "page": { "title": "Statistics", "icon": "<svg …>…</svg>" }
}
```

| Field         | Rules                                                                          |
| ------------- | ------------------------------------------------------------------------------ |
| `id`          | Equals the folder name: lowercase letters, digits and `-`, up to 32 characters |
| `name`        | Up to 64 characters                                                            |
| `version`     | Up to 32 characters; the release zip carries it                                |
| `apiVersion`  | Must be `1`. Any other value is refused                                        |
| `description` | Optional, up to 280 characters; shown in Settings                              |
| `permissions` | Required. `events` lists the event types the extension receives: any of `deckAttached`, `input`, `imageProcessed`. DeckBridge drops every other type |
| `page`        | Optional. `title` (up to 32 characters) and an optional inline-SVG `icon`      |

### Folder rules

DeckBridge reads an extension folder only within these limits. A folder that breaks one
shows as _Cannot run_ and does not start:

- At most 64 files and 4 MB in total.
- At most 4 folder levels inside the extension folder.
- File and folder names use only `A-Z`, `a-z`, `0-9`, `.`, `_` and `-`, up to 64 characters.
- No symlinks inside the folder.
- `.DS_Store`, `Thumbs.db` and `desktop.ini` are ignored at any depth.

### server.js

An ES module whose default export is a factory. DeckBridge calls it once when the worker
starts:

```js
export default (ctx) => {
  let presses = 0;
  return {
    onEvents(events) {
      for (const e of events) if (e.type === 'input' && e.input.kind === 'key') presses++;
    },
    handle(req) {
      if (req.method === 'GET' && req.path === 'count') return { body: { presses } };
      return { status: 404, body: { error: 'not found' } };
    },
  };
};
```

`ctx` holds `id`, `appStartedAt` (epoch ms) and `log(message)`, which writes to the
DeckBridge log tagged `ext:<id>`. DeckBridge's own lines about an extension use the tag
`extensions`, and most start with the id (`<id>: …`). In a `ctx.log` line, control
characters become spaces.

`onEvents` gets events in order, in batches about every 250 ms. Every event has `at`
(epoch ms) and `deviceKey`. The extension receives only the types listed in its
`permissions.events`; DeckBridge drops every other type.

| `type`           | Other fields                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `deckAttached`   | `modelName`, `source` (`usb`, `browser`, `mock`), `hasEncoders`, `columns`, `extraKeys`        |
| `input`          | `input`: `key` (`mk2`, `state`), `extraKey` (`wireId`, `state`), `dialPress` (`index`, `state`), `dialRotate` (`index`, `delta`), `touch` |
| `imageProcessed` | `cached`: the image cache served the key image                                                |

An extension that starts while decks are connected first gets one `deckAttached` per deck.
A second `deckAttached` for a known `deviceKey` is a reconnect. A grid key's row is
`Math.floor(mk2 / columns)`; a side key's position is its index in `extraKeys`.

`handle` answers `GET` and `POST` on `/api/ext/<id>/<path>`, where `path` is one segment.
`req` holds `method`, `path`, `query` and the parsed JSON `body` of a POST. Return
`{ status?, body }`; `body` is sent as JSON.

Limits: a call gets 5 seconds, 8 calls may wait at once, and up to 5000 events queue while
the worker loads. The global `fetch` and `WebSocket` do not exist in the worker (in this
runtime they would abort the whole process).

A reply's JSON text is capped at 262,144 characters (256 * 1024); a larger reply fails the
call with HTTP 500. Each `ctx.log` line is cut to 500 characters, and at most 20 lines per
second are kept. The rest are counted and reported as one `suppressed N log lines` line.
GET must not change state: a browser or a link may repeat it. A call from another site is
refused with HTTP 403. A request is cross-site when its `Sec-Fetch-Site` header is neither
`same-origin` nor `none`; a request without that header is not refused.

### ui.js

An ES module that exports `mount`. The web UI draws the page title, the Back button and
Escape handling, then calls `mount` with the page body:

```js
export function mount(el, api) {
  const { h, render } = api.preact;
  function Count() {
    const [n, setN] = api.hooks.useState(null);
    api.hooks.useEffect(() => {
      api.getJson('count').then((r) => setN(r.presses));
    }, []);
    return h(api.kit.List, null, h(api.kit.Row, { label: 'Presses', value: String(n ?? '…') }));
  }
  render(h(Count), el);
  return () => render(null, el);
}
```

| `api`              | What it is                                                                 |
| ------------------ | -------------------------------------------------------------------------- |
| `preact`, `hooks`  | The web UI's own Preact (`h`, `Fragment`, `render`) and hooks. Use these; a second Preact copy breaks hooks |
| `kit`              | App components: `Lead`, `ErrorText`, `SectionLabel`, `List`, `Row`, `EmptyRow`, `Field`, `VisuallyHidden`, `StatusChip`, `ChipRadioGroup` |
| `getJson(path)`, `postJson(path, body)` | Calls to your own `/api/ext/<id>/<path>`                 |
| `useDocks()`       | Hook: the live deck list, as the home screen shows it                      |

Use the kit instead of the web UI's class names: the shipped web UI renames its CSS
classes, so a class name copied from the page source does not style anything.

The web UI's Content Security Policy blocks inline `<script>`, inline `style="…"` markup and
calls to other hosts. Use the kit, and `getJson`/`postJson` for your own routes.

### Building from this repository

`mise run extensions` builds every folder in `ts/src/extensions/` into
`ts/dist/extensions/`. TypeScript and JSX work: the build points `preact` imports at the
web UI's own copy (`ts/src/extensions/sdk/preact-shim.ts`). `mise run s` loads that folder,
so a dev run sees your extension after a Rescan. `mise run package-extensions` writes the
release zips to `dist/`.
