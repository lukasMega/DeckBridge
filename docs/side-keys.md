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

## Touch strip modes

On AKP05E the strip has two possible painters — DeckBridge widgets and the Elgato Stream
Deck + app (when the device is paired as a Plus). The **Touch strip** panel picks who owns
it, saved per device:

| Mode                               | Strip                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Elgato app only** (default)      | The app paints all four zones. DeckBridge draws nothing there and the widget rows are hidden.      |
| **DeckBridge overrides (ignore)**  | DeckBridge widgets. Everything the app sends to the strip is dropped; an unassigned zone is blank. |
| **DeckBridge overrides (repaint)** | DeckBridge widgets on assigned zones; the app keeps painting the unassigned ones.                  |

Each zone keeps its own widget in both override modes. The "no widget" choice reads
**Blank** under _ignore_ and **App controls** under _repaint_ — the zone is cleared, or
left to the app. Leaving an override hands every zone back to the app. Side keys (293S)
are not affected: they are DeckBridge widgets in every mode.

> **No migration.** The earlier **"Elgato app controls it"** switch (`touchStripDisabled`
> in settings.json) is gone and its value is dropped on load. Every strip starts in
> **Elgato app only**; widgets you had assigned are kept, so picking an override mode
> brings them back.

## Knobs

In an override mode the panel also shows a **Knobs** section for the AKP05/AKP05E rotary
encoders. **Connect knobs to Elgato app** (on by default) forwards presses and turns to
the app as usual. Turn it off and every knob stops reaching the app; each gets a row with
three shell commands:

- **press** — runs once per press.
- **turn right** / **turn left** — runs per clockwise / counter-clockwise detent. A fast
  spin coalesces: while a command is still running, further detents queue at most one
  follow-up run.

A field commits on blur or Enter; an empty field does nothing (the knob event is still
kept from the app). Commands run like the [command widget](#command-output) — `sh -c` /
`cmd /c`, killed after **5 s**, capped at **512 characters** — and their output is
discarded. In **Elgato app only** mode the knobs always go to the app, whatever is saved.

> **⚠ Security.** Same posture as the command widget below: the web UI has **no
> authentication**, so anyone who can reach it can set a command that runs on this host.
> Keep it on a **trusted personal LAN**.

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
