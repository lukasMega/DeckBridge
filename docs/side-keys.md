# Display widgets

DeckBridge can show widgets on keys outside the Elgato app's grid. Mirabox 293S has three display-only side keys. AJAZZ AKP05E adds four touch strip zones. Stream Deck + pairing also exposes two side keys.

Widgets update without an open browser. Choose a clock, date, text, weather, command output, or [JavaScript plugin](./plugin-widgets.md).

## Assign a widget

1. Open the [Web UI](http://localhost:3000) and select a dock.
2. Find **Side keys** or **Touch strip**. Choose a widget from its dropdown.
3. Enter any requested value. Changes apply immediately and survive reconnects.

Side keys show live previews. Touch strip previews also work as tabs: select a zone, then edit its widget below.

## Built-in widgets

| Widget | What it shows | Input |
| --- | --- | --- |
| **Empty** | Blank display | None |
| **Clock (24h)** | Current time | None |
| **Date** | Weekday and date | None |
| **Custom text** | Your text | Type text; `\n` starts a new line |
| **Weather (°C)** | Current temperature | Coordinates such as `50.08,14.43` |
| **Command output** | Shell command output | Enter a command |
| **Plugin (JS)** | Custom value | Choose a plugin file |

### Weather

Weather uses [Open-Meteo](https://open-meteo.com/) without an API key. The value updates about every ten minutes.

### Command output

Command output displays text from a shell command. Use ⚙ to set its interval, timeout, or **Run now**.

<details>
<summary>Command timing and limits</summary>

- **Run every (s):** 1–3600 seconds; 10 by default.
- **Timeout (s):** 1–60 seconds; 5 by default.
- **Run now:** refreshes output immediately.

</details>

## Text size

Use **A−** and **A+** to resize text. **A** restores default size. **Fit** picks the largest size that fits. A **clipped** badge warns when text runs out of space.

<details>
<summary>More text controls</summary>

- **▦** previews every available size.
- **Wrap** breaks long text by words or characters. It applies to custom text, command output, and plugins.
- Text can use up to four lines. Oversized lines end with `…` when wrapping is off.

</details>

## Text style

Select **Aa** beside size controls. Choose font, colours, alignment, padding, bold, outline, or line spacing. **Reset style** restores defaults.

<details>
<summary>Font and style details</summary>

**Regular** uses a monospace font. **Narrow** fits more characters on each line. Choose preset colours or a custom colour. **Ellipsis on cut text** adds `…` to lines that do not fit. Both fonts cover ASCII and Latin-1 characters.

</details>

## Touch strip modes

AKP05E's **Touch strip** menu chooses who paints its four zones:

| Mode | Result |
| --- | --- |
| **Elgato app only** | Elgato paints the strip. This is the default. |
| **DeckBridge overrides (ignore)** | Widgets paint assigned zones. App strip images are ignored. |
| **DeckBridge overrides (repaint)** | App images appear first. Widgets return after app activity stops. |

Select a zone preview to edit its widget. Side key widgets stay active in every mode.

<details>
<summary>Repaint timing and empty zones</summary>

**Repaint after (s)** controls when widgets return after Elgato feedback. The default is 5 seconds. Each zone keeps its own widget. Unassigned zones show **Blank** in ignore mode and **App controls** in repaint mode.

</details>

## Knobs

AKP05E knobs normally reach the Elgato app. In a DeckBridge override mode, turn off **Connect knobs to Elgato app** to assign press, left-turn, and right-turn commands. A press without a command [refreshes](#tap-to-refresh) its zone.

<details>
<summary>Knob command behavior</summary>

Commands run once per action. Fast turns queue at most one follow-up run. **Elgato app only** mode always forwards knobs to the app.

</details>

## Press commands

AKP05E's right-column side keys can react to presses. Choose **Refresh**, **Command**, or **Both** under **On press**. Displayed widget and press action are independent. Mirabox 293S side keys have no switches.

<details>
<summary>Press command behavior</summary>

Commands run once per press. Another press during a run queues at most one follow-up. An empty command does nothing.

</details>

## Tap to refresh

Refresh widgets from a side key press, touch strip tap, or knob press. Knob refresh works when Elgato forwarding is off and no press command is set.

<details>
<summary>Refresh behavior and feedback</summary>

Command output runs immediately. Plugins poll immediately. Weather refetches at most once per minute. Clock, date, and text repaint. Refreshes during a command or plugin run queue one follow-up.

Taps on widget zones refresh them. Other taps, holds, and swipes reach the Elgato app.

</details>

## Security

Command widgets and press actions run shell commands on your host. The Web UI has no authentication. Use these features only on a trusted personal network.

## Going further

For custom APIs or computed values, write a [plugin widget](./plugin-widgets.md).
