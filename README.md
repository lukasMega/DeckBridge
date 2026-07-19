# DeckBridge

Use a USB Stream Deck with the Elgato Stream Deck app **over your local network** — no
[Elgato Network Dock](https://www.elgato.com/us/en/p/network-dock-stream-deck) (>60 USD)
required.

Plug your deck into any computer, run DeckBridge there, and the Elgato app on any machine
on the same network finds it like real Elgato hardware. One small program (<5 MB), nothing
else to install.

**📖 Documentation:** <https://lukasmega.github.io/DeckBridge/>

## Supported devices

- Mirabox 293V3 / Ajazz
- Mirabox 293S
- Mirabox K1 Pro
- Stream Deck MK.2
- Stream Deck Mini

Hardware-tested on macOS: 293V3, 293S, K1 Pro, and Stream Deck Mini. MK.2 and the
Linux/Windows builds are implemented but not hardware-verified.

> **Platform status:** DeckBridge is currently **tested on macOS only**, and the
> GitHub releases currently ship **macOS builds only**. Linux and Windows support
> exists in the code but is untested and not yet released — build from source at
> your own risk.

## Quick start

1. Download the release for your OS, unzip, and run `deckbridge`.
2. Plug in your deck.
3. Open the Elgato Stream Deck app on any machine on the same network — it discovers
   DeckBridge automatically.

A web page at <http://localhost:3000> shows your deck's keys and a live log.

Full install and troubleshooting steps:
[Getting Started](https://lukasmega.github.io/DeckBridge/getting-started).

## CLI usage

```
deckbridge [command] [flags]

Commands:
  run                 Start the bridge (default when no command given)
  devices             List detected stream deck HID devices, then exit
  version             Print version/build info, then exit
  help                Print usage, then exit

Flags (for run):
  --mock                    Start with the mock driver (no hardware)
  --bind <addr>             Listen address for CORA + WebUI  [default 0.0.0.0]
  --webui-port <n>          WebUI HTTP/WS port               [default 3000]
  --no-webui                Do not start the WebUI server
  --open                    Auto-open browser (desktop convenience)
  --headless                Shorthand: no tray, no browser open, skip Elgato-app poll
  --log-level <lvl>         debug|info|warn|error|silent (runtime override)
  --cache-dir <path>        Settings + native-lib extraction root (default: XDG cache dir)
  -h, --help                Show this help
  -V, --version             Show version
```

For unattended Linux (Raspberry Pi / DietPi) under systemd, see
[Headless Linux](https://lukasmega.github.io/DeckBridge/headless-linux) and
`packaging/linux/`.

## ⚠ Hobby use only

DeckBridge is a free community tool for personal and hobby use. It is not affiliated
with, endorsed by, or supported by Elgato / Corsair, and it does not replace the Elgato
Network Dock. For professional or reliable setups, use officially supported Elgato
hardware.

DeckBridge contains no reverse-engineered code — it reuses existing open-source projects
([credits](https://lukasmega.github.io/DeckBridge/references)).

## For developers

Build from source, architecture, protocols, and testing: [ARCHITECTURE.md](ARCHITECTURE.md).
Technical guides:
[Adding a device](https://lukasmega.github.io/DeckBridge/adding-a-device) ·
[Image flow](https://lukasmega.github.io/DeckBridge/image-flow) ·
[HID via FFI](https://lukasmega.github.io/DeckBridge/hidapi-ffi)

## License

[MIT](LICENSE). The vendored [`rust/jpeg-encoder`](rust/jpeg-encoder) fork keeps its
upstream license ((MIT OR Apache-2.0) AND IJG); third-party notices in
[`scripts/LICENSE-hidapi.txt`](scripts/LICENSE-hidapi.txt).
