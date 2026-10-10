# Adding a New Device

Most new decks are rebadges or siblings of a board DeckBridge already drives. Adding one
is configuration only: three files you author, everything else generated. For a deck
that speaks a protocol DeckBridge does not know yet, see
[Adding a new protocol](./new-protocol.md).

Validated against source: 2026-10-06.

## Known families

| `--from` | Board |
|---|---|
| `mirabox-293` | Mirabox v3: 1024-byte packets, press + release |
| `mirabox-293s` | Mirabox v1: 512-byte packets, keydown only |
| `akp153-v1-clone` | the v1 board as rebadged by Ajazz, Mars Gaming, Mad Dog and others |
| `fifine-d6` | Mirabox v3 with the packet size read from the report descriptor |

Not sure? Compare with [Device specs](./device-specs.mdx), or ask in an issue first.

## 1. Find the USB ids

```bash
system_profiler SPUSBDataType   # macOS
lsusb                           # Linux
```

Note the **VID** and every **PID** (hex). The template supplies the HID interface
(`usagePage`/`usage`).

## 2. Scaffold

```bash
mise run device-new -- --from <template> --id <new-id> --name "<Name>" \
  --vendor <slug> --vid 0x.... --pid 0x....[,0x....] [--dry-run]
```

It writes `ts/src/devices/<vendor>/<id>.ts` and a `device-notes.json` stub, then prints two
lines for `registry.ts`. It refuses an id or VID/PID the registry already owns. Batching
and CORA emulations stay off until measured on hardware.

## 3. Register

Paste the printed import and array entry into `ts/src/devices/registry.ts`, at the end
of `DEVICE_MODELS` (array order is primary-device priority).

## 4. Fill in the notes

Edit the stub in `ts/src/devices/device-notes.json`: summary, quirks, sources. A summary
still starting with `TODO` fails the generators. Record each PID you tested under
`variants` — copy the shape of the `mk2` entry; unknown firmware stays `null`.

## 5. Generate

```bash
mise run devices-generate
```

Regenerates the device pages, homepage art and Linux udev rules from the registry.
Commit the results; `devices-check` in CI fails if they are stale.

## 6. Calibrate on hardware

No rebuild per guess: open **Settings → Device tuning** with the deck connected.

- **Image orientation.** Show an asymmetric icon (an arrow) and adjust rotate and flip
  until it is upright and not mirrored. Rotation applies clockwise, before flips.
- **Key map.** **Key-map learn mode** walks the grid and records which wire code each
  physical key sends. Check that images and presses land on the same key.

Then **Copy overrides as JSON** and paste the values into your model file: the registry
is the source of truth, runtime tuning is only the way to find the values. Without
hardware access, ask the owner for **Copy for bug report** output instead.

## 7. Capture a replay fixture

```bash
mise run device-capture -- --model <id>
```

Writes an empty packet-fixture skeleton for the connected deck (`ts/test/fixtures/packets/<id>/`).
It only enumerates: it never opens or writes to the device, and exits non-zero with no
hardware. Steps are still added by hand from the model-specific probes (`d6-capture`,
`akp05-capture`); `ts/test/packet-replay.test.ts` then replays them through the real driver.

## 8. Check and open a PR

```bash
mise run beforeCommit
```

Update `e2e/helpers/devices.ts` if the deck needs a browser-matrix row.

## Checklist

```
[ ] VID and all PIDs collected
[ ] Model scaffolded with the right template and registered
[ ] Notes filled in, tested PIDs under variants
[ ] devices-generate output committed
[ ] Orientation and key map verified on hardware and baked into the model
[ ] Packet fixture captured (device-capture) and replayed
[ ] Elgato software connects and receives key presses
[ ] mise run beforeCommit passes
```

## Pitfalls

- **Deck not found, or reads are all zeros** → wrong HID interface or a missing PID.
  `deckbridge devices` lists what DeckBridge matches.
- **Another model claims the deck** → overlapping PIDs; the validator names both models.
- **Red and blue swapped** → not fixable by configuration; see
  [Color order](./new-protocol.md#color-order-is-not-implemented-known-limitation).
