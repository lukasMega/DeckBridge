# Display widgets

Some decks have keys **outside** the grid the Elgato app drives — most notably the
Mirabox **293S**, whose sixth column is three keys down the right edge. These keys have
**no switches**, so the Elgato app never sees them. DeckBridge uses them as small
**display widgets** instead.

Rendering is **server-side**: the value is drawn on the host and uploaded to the key, so
widgets keep updating with **no browser open**. A key only re-uploads when its content
changes (e.g. a clock repaints once a minute).

AJAZZ AKP05E adds four **Touch strip** zones beneath its encoders. They use the same
widgets, including command output and JavaScript plugins.

## Assign a widget

Open the web UI (`http://localhost:3000`), select the dock, and use the **Side keys** or
**Touch strip** panel. It appears only for a connected supported dock (not mock mode). Each
display has a row — **Top / Middle / Bottom** on the 293S, or four left-to-right zones on
AKP05E — with a widget dropdown and, for some, a parameter field or gear (⚙) button.

Pick a widget and fill its parameter; it takes effect immediately, saved per key and
restored on reconnect.

The **Touch strip** panel (AKP05E) also has an **"Elgato app controls it"** switch.
Turn it on to stop DeckBridge driving the strip's zones, so the Elgato Stream Deck +
app (when the device is re-paired as a Plus) owns them instead.

## Built-in widgets

| Widget             | Parameter                      | What it shows                                                                                    |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| **Empty**          | —                              | Nothing (clears the key).                                                                        |
| **Clock (24h)**    | —                              | Current time as `HH:MM`. Repaints once a minute.                                                 |
| **Date**           | —                              | Weekday, day, and month.                                                                         |
| **Custom text**    | text (`\n` = new line)         | Whatever you type, as up to 4 centered lines.                                                    |
| **Weather (°C)**   | `lat,lon` (e.g. `50.08,14.43`) | Current temperature in °C.                                                                       |
| **Command output** | a shell command                | The command's stdout.                                                                            |
| **Plugin (JS)**    | a plugin file                  | The value returned by a JavaScript plugin you write — see [Plugin widgets](./plugin-widgets.md). |

### Weather

Uses [Open-Meteo](https://open-meteo.com/)'s current-weather endpoint — **no API key**.
Cached per location, refreshed at most every **10 minutes**, shared across docks; shows
`--` until the first fetch returns.

Fetched over **plain HTTP** (the runtime has no TLS). A failed fetch is logged at `warn`
and the last value stays on the key.

### Command output

Runs the parameter as a shell command (`sh -c` on macOS/Linux, `cmd /c` on Windows) on a
timer and shows its stdout as up to 4 centered lines (`…` until the first run). The gear
(⚙) popup has:

- **Run every (s)** — re-run interval, **1–3600 s** (default **10 s**).
- **Timeout (s)** — kill the process after this long, **1–60 s** (default **5 s**).
- **Run now** — force an immediate run.

Only one run per command is in flight at a time, and the result is cached per command
string.

> **⚠ Security.** The command runs **arbitrary shell** from the web UI, which has **no
> authentication**. It is **opt-in per key** and meant for a **trusted personal LAN** —
> the same posture as the weather widget's cleartext HTTP and the [plugin
> widgets](./plugin-widgets.md#security). Only point a key at a command you trust.

## Rendering details

- Values are drawn with a packed **Spleen** bitmap font (BSD-2), then transformed to each
  display's native format like any other key image.
- Up to **4 centered lines**, split on `\n`. Short single lines use a larger font.
- The parameter is capped at **128 characters**.

## Going further

For anything the built-ins don't cover — a home-automation entity, custom API, or
computed value — write a small JavaScript **plugin** and assign it to a display. See
[Plugin widgets](./plugin-widgets.md).
