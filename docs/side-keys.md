# Display widgets

Some decks have keys **outside** the grid the Elgato app drives — most notably the
Mirabox **293S**, whose sixth column is three keys down the right edge. These keys have
**no switches**, so the Elgato app never sees them. DeckBridge uses them as small
**display widgets** instead.

Rendering is **server-side**: the value is drawn on the host and uploaded to the key, so
widgets keep updating with **no browser open**. A key only re-uploads when its content
changes (e.g. a clock repaints once a minute).

AJAZZ AKP05E adds four **Touch strip** zones beneath its encoders. They use the same
widgets, including command output and JavaScript plugins. When the AKP05E is paired as a
**Stream Deck +**, the Plus grid covers only its left four columns: the two keys of the
right column become side keys too — and these have switches, so each can also
[run a command on press](#press-commands).

## Assign a widget

Open the web UI (`http://localhost:3000`), select the dock, and use the **Side keys** or
**Touch strip** panel. It appears only for a connected supported dock (not mock mode). Each
display has a row — **Top / Middle / Bottom** on the 293S, **Top / Bottom** for the AKP05E
right column, or four left-to-right zones on the AKP05E strip — with a widget dropdown and,
for some, a parameter field or gear (⚙) button.

Pick a widget and fill its parameter; it takes effect immediately, saved per key and
restored on reconnect.

### Text size

Every display with a widget has a **size** control:

- **A− / A+** move the text one step smaller or larger (−2 … +2). Each line keeps its role —
  the date's day number stays bigger than its weekday and month.
- **A** returns to the default size.
- **Fit** picks the largest size at which all the text fits, and re-picks it whenever the
  value changes (e.g. command output).
- **▦** opens a picker with the widget rendered at every size; click one to use it.
- **Wrap** (custom text, command output, plugin only) splits a line too wide for the
  display: **words** breaks at spaces and splits a single over-long word mid-word;
  **characters** fills each row and breaks anywhere. Off (the default) cuts the line at the
  right edge. With **Fit**, the size is chosen after wrapping.

The side-key tile updates as soon as the key repaints. When text does not fit at the
chosen size, the tile (or the strip zone's label) shows a **clipped** badge — pick a
smaller size or **Fit**.

## Touch strip modes

On AKP05E the strip has two possible painters — DeckBridge widgets and the Elgato Stream
Deck + app (when the device is paired as a Plus). The mode select in the **Touch strip**
panel head picks who owns it, saved per device; the line under it describes the selected
mode:

| Mode                               | Strip                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Elgato app only** (default)      | The app paints all four zones. DeckBridge draws nothing there and the widget rows are hidden.      |
| **DeckBridge overrides (ignore)**  | DeckBridge widgets. Everything the app sends to the strip is dropped; an unassigned zone is blank. |
| **DeckBridge overrides (repaint)** | App images always show. A widget comes back once the app stops drawing on its zone.                |

Under _repaint_, every image the app sends reaches the strip, including dial feedback
on a zone that has a widget. The **Repaint after (s)** field (default **5 s**, range
1–3600 s) sets how long after the app's last image on a zone DeckBridge paints the widget
there again. Turn a knob and you see the app's feedback; stop and the widget returns.
A change applies on the next widget tick, with no reconnect.

Each zone keeps its own widget in both override modes. The "no widget" choice reads
**Blank** under _ignore_ and **App controls** under _repaint_ — the zone is cleared, or
left to the app. Leaving an override hands every zone back to the app. Side keys (293S,
AKP05E right column) are not affected: they are DeckBridge widgets in every mode.

### Strip geometry and uploads

The AKP05E strip is one 800×112 panel (measured on firmware `V3.AKP05E.02.007`). It
has four **slot windows**, each 176×112, at x = 0 / 204 / 406 / 610, with 26–28 px gaps.
The positions were matched by eye on hardware. The upstream 208 px pitch drew
partial updates shifted left. Partial updates never reach x 786–800.
Each window sits above one encoder. An upload to a slot draws over the strip in place.
The rest of the strip is not cleared.

- **Full-strip upload.** A whole-strip image from the app is sent once, as one 800×112
  image. This is the only upload that reaches the gaps.
- **Per-slot upload.** A partial image (dial feedback) only re-sends the slots it
  touches. The same applies when DeckBridge widgets own a zone (_ignore_ mode).
- **Height.** The app's strip is 800×100. It is padded 1:1 to 112 rows with its own
  edge colour, so text stays sharp.
- **Upload cap.** The firmware decodes only the first **~10 100 B** of an
  upload and drops the rest. The part it drops shows as noise or old content at the
  top. DeckBridge lowers the JPEG quality until each strip image fits.

Two settings.json options per device (no web UI control) tune this. They apply on the
next connect:

| Key                 | Values                                  | Effect                                                                                                                                          |
| ------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `touchStripZoneFit` | `"crop"` (default), `"scale"`           | How a 200 px app zone fills a 176 px slot. `crop` shows the strip pixels under the slot, the same as a full-strip upload. `scale` fits the whole zone. |
| `touchStripUpload`  | `"full-frames"` (default), `"always"`   | `always` sends every app image as a full-strip upload, so the gaps stay current. That is about 5× more USB traffic per dial tick. It is not used while a zone is masked. |

> **No migration.** The earlier **"Elgato app controls it"** switch (`touchStripDisabled`
> in settings.json) is gone and its value is dropped on load. Every strip starts in
> **Elgato app only**; widgets you had assigned are kept, so picking an override mode
> brings them back.

## Knobs

In an override mode the panel also shows a **Knobs** section for the AKP05/AKP05E rotary
encoders. **Connect knobs to Elgato app** (on by default) forwards presses and turns to
the app as usual. Turn it off and every knob stops reaching the app; each gets a row with
three shell commands, in the **Press**, **Turn right** and **Turn left** columns:

- **Press** — runs once per press. Left empty, a press
  [refreshes](#tap-to-refresh) the widget on the zone above the knob.
- **Turn right** / **Turn left** — runs per clockwise / counter-clockwise detent. A fast
  spin coalesces: while a command is still running, further detents queue at most one
  follow-up run.

A field commits on blur or Enter; an empty field does nothing (the knob event is still
kept from the app). Commands run like the [command widget](#command-output) — `sh -c` /
`cmd /c`, killed after **5 s**, capped at **512 characters** — and their output is
discarded. In **Elgato app only** mode the knobs always go to the app, whatever is saved.

> **⚠ Security.** Same posture as the command widget below: the web UI has **no
> authentication**, so anyone who can reach it can set a command that runs on this host.
> Keep it on a **trusted personal LAN**.

## Press commands

On the AKP05/AKP05E paired as a **Stream Deck +**, each right-column side key has an
**On press** line under its widget row: an action select and a shell command.

- **Refresh** — [refreshes](#tap-to-refresh) the key's widget. The command field is
  greyed out but keeps its text.
- **Command** — runs the shell command once per press.
- **Both** — refreshes the widget and runs the command.

When no action is saved, a key with a press command runs it (**Command**) and a key
without one refreshes (**Refresh**).

The press side is independent of the widget — the key can show a clock and open an app
on press, and changing either one keeps the other. The command runs like a
[knob command](#knobs): `sh -c` / `cmd /c`, killed after **5 s**, capped at
**512 characters**, output discarded; presses during a run queue at most one follow-up
run. An empty field does nothing. Unlike the knobs, these keys never reach the Elgato
app, so there is no mode to switch.

The 293S side keys have no switches and show no press field.

> **⚠ Security.** Same posture as the command widget below: the web UI has **no
> authentication**, so anyone who can reach it can set a command that runs on this host.
> Keep it on a **trusted personal LAN**.

## Tap to refresh

A widget can be refreshed from the device:

- **Side key press** — with the **Refresh** or **Both** [press action](#press-commands).
- **Strip tap** — a tap on a zone that shows a DeckBridge widget refreshes it. The tap is
  not sent to the Elgato app. Taps on other zones, and holds and swipes anywhere, reach
  the app as before. Under _repaint_, a zone showing the app's image passes its taps to
  the app.
- **Knob press** — with **Connect knobs to Elgato app** off, pressing a knob that has no
  **Press** command refreshes the zone above it.

What a refresh does depends on the widget:

| Widget             | Refresh                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| **Command output** | Runs the command now, like **Run now**.                                    |
| **Plugin (JS)**    | Polls the plugin now.                                                      |
| **Weather**        | Refetches, at most once a minute per location; otherwise only repaints.    |
| Clock, date, text  | Repaints only.                                                             |

A command or plugin runs one at a time per key: taps during a run queue one follow-up
run.

### Feedback

Two settings.json flags per device (next to `touchStripMode`, no web UI control) set what
a refreshed widget shows:

```jsonc
"tapFeedback": { "flash": true, "placeholder": false }   // the defaults
```

- `flash` — the widget shows inverted colours for about **150 ms** on the tap.
- `placeholder` — the widget shows `…` until the command, plugin or weather refetch
  finishes (at most 15 s, or twice the command timeout).

Both can be on: the flash comes first, then `…`. An absent flag takes its default; an
invalid `tapFeedback` is ignored.

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

- Values are drawn with packed **Spleen** bitmap fonts (BSD-2) in six sizes — 5×8, 6×12,
  8×16, 12×24, 16×32 and 32×64 pixels per character, sharp with no smoothing — then
  transformed to each display's native format like any other key image.
- Up to **4 centered lines**, split on `\n`. Short single lines use a larger font.
  A line too wide for the display is cut off unless wrapping is on (see [Text size](#text-size)).
- The parameter is capped at **128 characters**.

## Going further

For anything the built-ins don't cover — a home-automation entity, custom API, or
computed value — write a small JavaScript **plugin** and assign it to a display. See
[Plugin widgets](./plugin-widgets.md).
