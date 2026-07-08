# DeckBridge — Distribution & Release Guide

Bridges a Mirabox/Ajazz USB stream deck to Elgato Stream Deck software over TCP/CORA, replacing a >$60 Network Dock. Standalone binary — no Node.js, no runtime installer.

---

## Install (recommended — per platform)

| Platform | Recommended channel |
|----------|---------------------|
| macOS | Homebrew tap (`brew install`, no Gatekeeper prompt) — or the native `.dmg` (drag-install, unsigned) |
| Linux | Homebrew tap (`brew install`) |
| Windows | NSIS installer (`-setup.exe`) or Scoop |

> **Note:** `OWNER`/`REPO` below are placeholders — the real tap/bucket URLs are filled in when they go live.

### macOS & Linux — Homebrew

Homebrew installs the binary directly, so macOS does **not** apply the Gatekeeper quarantine flag — there is no "developer cannot be verified" prompt and no `xattr` step. No Apple Developer ID is required.

```bash
brew tap OWNER/tap
brew install OWNER/tap/deckbridge
```

To run in the background and start at login (user LaunchAgent, no sudo):
```bash
brew services start deckbridge
```

To stop and remove it:
```bash
brew services stop deckbridge
brew uninstall deckbridge
```

### macOS — native `.dmg` (alternative to Homebrew)

For a clickable app instead of the CLI, download the `.dmg` for your Mac from the [Releases page](../../releases):

| Mac | File |
|-----|------|
| Apple Silicon (M1/M2/M3/M4) | `deckbridge_X.Y.Z_aarch64.dmg` |
| Intel | `deckbridge_X.Y.Z_x64.dmg` |

It's the same [Tauri](https://v2.tauri.app) tray-supervisor as the Windows build, packaged for macOS: open the `.dmg`, drag **DeckBridge** to Applications. There's no window — it runs in the tray and serves the web UI at http://localhost:3000.

The `.dmg` is **unsigned** (no Apple Developer ID, no notarization — each bundled binary carries only its own ad-hoc signature), so Gatekeeper blocks the first launch ("cannot be verified" / "damaged" on Apple Silicon). One-time fix — **right-click the app → Open → Open**, or strip the quarantine flag:
```bash
xattr -dr com.apple.quarantine /Applications/deckbridge.app
```
Homebrew (above) avoids this entirely — it installs without the quarantine flag, so there's no prompt.

### Windows — installer or Scoop

The Windows build ships as a small [Tauri](https://v2.tauri.app) NSIS installer that **supervises** the same relay binary: it spawns `deckbridge` plus the `deckbridge-tray` system-tray sidecar in the background and cleanly tears them down on quit. There is no separate window — the app lives in the tray and serves its web UI at http://localhost:3000.

**Option A — installer (`.exe`):** download `deckbridge_X.Y.Z_x64-setup.exe` from the [Releases page](../../releases) and run it. It installs per-user (no admin). Unsigned downloads show a one-click SmartScreen prompt — **More info → Run anyway**.

**Option B — Scoop (no SmartScreen prompt):**
```powershell
scoop bucket add deckbridge https://github.com/OWNER/scoop-bucket
scoop install deckbridge
```

Both put a Start Menu entry and a `deckbridge` shim. Launch it, then quit from the tray icon. See [`packaging/scoop/README.md`](packaging/scoop/README.md) for bucket details.

> WebView2 ships with Windows 10/11; no extra runtime install is required.

---

## Manual download (alternative to Homebrew)

### macOS

**1. Download and extract** the latest release for your Mac from the [Releases page](../../releases):

| Mac | File |
|-----|------|
| Apple Silicon (M1/M2/M3/M4) | `deckbridge-vX.Y.Z-macos-arm64.zip` |
| Intel | `deckbridge-vX.Y.Z-macos-x86_64.zip` |

**2. Handle Gatekeeper** (one-time — macOS blocks unnotarized downloads):

Right-click `deckbridge` → **Open** → click **Open** in the dialog. You only need to do this once per file. Alternatively, strip the quarantine attribute from the whole folder:
```bash
xattr -dr com.apple.quarantine deckbridge-vX.Y.Z-macos-arm64/
```

**3. Run:**
```bash
cd deckbridge-vX.Y.Z-macos-arm64
./deckbridge
```

Open the web UI at **http://localhost:3000** to verify the device is connected. Elgato Stream Deck software will auto-discover the dock via mDNS.

> libhidapi and the deckbridge-native helper library are embedded in the binary and auto-extracted to a per-version cache directory at startup — no `brew install` required.

---

### Linux

**1. Install avahi** for mDNS auto-discovery (optional but recommended):
```bash
# Debian / Ubuntu
sudo apt install avahi-daemon avahi-utils
```

Without avahi, Elgato software won't auto-discover the dock. You'd need to add it manually by IP.

**2. Download and extract** the latest release from the [Releases page](../../releases):

| CPU | File |
|-----|------|
| x86_64 (most PCs/servers) | `deckbridge-vX.Y.Z-linux-x86_64.zip` |
| arm64 (Raspberry Pi 4+, etc.) | `deckbridge-vX.Y.Z-linux-arm64.zip` |

**3. Run:**
```bash
cd deckbridge-vX.Y.Z-linux-x86_64
./deckbridge
```

> libhidapi and the deckbridge-native helper library are embedded in the binary and auto-extracted to a per-version cache directory at startup — no `apt install` required.

---

### Windows

Windows is not distributed as a zip. Download the **`deckbridge_X.Y.Z_x64-setup.exe`** NSIS installer from the [Releases page](../../releases) and run it (per-user; one-click SmartScreen on the unsigned `.exe`), or use Scoop (no SmartScreen — see the Install section above). The installer bundles the relay binary and the `deckbridge-tray` sidecar; everything else (libhidapi, deckbridge-native) is embedded as on the other platforms.

---

## What's in the release zip (macOS / Linux)

```
deckbridge-vX.Y.Z-<platform>/
├── deckbridge          main binary (~2.2 MB, QuickJS bytecode + native libs embedded)
├── deckbridge-tray            system-tray sidecar: status icon + menu (optional; degrades gracefully)
├── icon-full.png        tray icons — embedded in deckbridge-tray; place custom PNGs here to override
├── icon-usb-only.png
├── icon-disconnected.png
└── LICENSE-hidapi.txt   BSD license for the bundled libhidapi
```

Run the app directly: `./deckbridge`. The native libraries (`libhidapi` and `libdeckbridge_native`)
are embedded inside the binary (gzip+base64) and extracted at startup to a per-version cache
directory (`ts/src/native-libs.ts`), which sets `DECKBRIDGE_NATIVE_LIB` / `HIDAPI_LIB` automatically.
`deckbridge-tray` is launched automatically from the directory next to the binary if present.

`DECKBRIDGE_NATIVE_LIB`, `HIDAPI_LIB`, and `DECKBRIDGE_TRAY_BIN` are optional env-var overrides for dev/power-user
use — if already set in the environment, they take precedence over the embedded/extracted libs.

Each release also includes a `SHA256SUMS.txt` — verify your download with:
```bash
sha256sum --check SHA256SUMS.txt
```

---

## Ports used

| Port | Purpose |
|------|---------|
| 3000 | Web UI (browser dashboard) |
| 5343 | CORA primary — Elgato Stream Deck software connects here |
| 5344 | CORA child — button events and images flow here |

mDNS (`_elg._tcp`) advertises the dock on the LAN so Elgato software finds it automatically.

---

## System tray

`deckbridge` also launches `deckbridge-tray`, a small sidecar that shows a status icon and menu in your system tray:

| Icon | Meaning |
|------|---------|
| green | USB device open **and** Elgato client connected |
| yellow | USB device open, no Elgato client yet |
| gray | no USB device |

The menu offers **Open Web UI**, **Check Requirements** (opens http://localhost:3000/requirements), and **Quit**. The tray is optional — if `deckbridge-tray` is missing, or the OS has no tray available (e.g. a headless Linux box), the app logs a warning and keeps running normally.

---

## Troubleshooting: missing dependencies

### libhidapi not found

```
hidapi not found (tried: /opt/homebrew/lib/libhidapi.dylib, /usr/local/lib/libhidapi.dylib, ...).
Install with: brew install hidapi (macOS) | sudo apt install libhidapi-dev (Linux)
```

The app keeps running and retrying every few seconds. Install libhidapi and the device connects automatically — no restart needed.

---

### USB device not found (Mirabox/Ajazz not plugged in)

```
[hid] no device found — retrying in 2s
```

Normal when the device is unplugged. The app auto-reconnects within 2 seconds of plugging in. No restart needed.

---

### mDNS not working on Linux (avahi missing)

```
[elgato] mDNS subprocess failed to start (spawn avahi-publish-service ENOENT);
         running without mDNS discovery
```

The app keeps running without mDNS. Either install avahi (`sudo apt install avahi-daemon avahi-utils`) or manually enter your machine's IP and port 5343 in Elgato software.

---

### deckbridge-native library missing or fails to load

```
[native-libs] extraction failed: <underlying filesystem error, e.g. permission denied>
```

The native libraries are embedded in the binary and extracted to a per-version cache directory at
startup. This error means extraction or `dlopen` failed (e.g. corrupted download, unsupported
platform, or a stale `DECKBRIDGE_NATIVE_LIB` env override pointing at a missing file). Re-download the
release archive, and check that no `DECKBRIDGE_NATIVE_LIB`/`HIDAPI_LIB` env vars are set to a bad path.

---

### macOS Gatekeeper: "cannot be opened because the developer cannot be verified"

Right-click `deckbridge` → **Open** → click **Open** in the dialog. This is the easiest path — one dialog, no terminal.

Alternatively, strip the quarantine attribute from the whole folder in one shot:
```bash
xattr -dr com.apple.quarantine deckbridge-vX.Y.Z-macos-arm64/
```

---

### USB permission denied on Linux

```
[ffi] hid_open failed: Permission denied
```

Add a udev rule so non-root users can open the HID device:
```bash
sudo tee /etc/udev/rules.d/99-mirabox.rules <<'EOF'
# Mirabox/Ajazz stream deck (293V3 / K1 Pro = 6603, 293S = 5548)
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="6603", MODE="0666"
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="5548", MODE="0666"
EOF
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Unplug and replug the device.

---

## Release process (maintainers)

### Automated releases (recommended)

Push a version tag from the repo root:
```bash
git tag deckbridge-v1.2.3
git push origin deckbridge-v1.2.3
```

This triggers `.github/workflows/release.yml`, which:
1. Builds natively on all four Unix platforms in parallel (macOS arm64, macOS x86_64, Linux x86_64, Linux arm64), plus a separate **Windows x86_64** job, plus a separate **macOS Tauri `.dmg`** job (arm64 + x86_64)
2. Runs `mise run compile` on each runner, then **ad-hoc-signs `deckbridge-tray`** (`codesign --sign -`) — free, no Apple Developer ID. The relay binary is **not** re-signed: `tjs compile` appends its payload after the Mach-O and ships a linker-signed ad-hoc signature; `codesign --force` would fail strict validation on it. The as-compiled signature is what ships and avoids the Apple Silicon "is damaged" error
3. macOS/Linux (`build`): packages each build into a zip via `scripts/package.mjs` (binary with embedded libhidapi/deckbridge-native + deckbridge-tray + icons + license)
4. Windows (`build-windows`): builds `deckbridge-tray.exe`, renames both binaries to the MSVC target triple (`-x86_64-pc-windows-msvc.exe`), and runs `cargo tauri build` (in `src-tauri/`) to produce a Tauri NSIS `-setup.exe`. The crate's hard-coded `0.1.0` is overridden with the tag's version via `-c '{"version":"X.Y.Z"}'`
5. macOS Tauri (`build-macos-tauri`): for arm64 and x86_64, renames both binaries to the `*-apple-darwin` triple, `chmod +x`'s them, ad-hoc-signs **only** `deckbridge-tray`, and runs `cargo tauri build --bundles dmg` to produce a `.dmg`. `tauri.macos.conf.json` sets **no** `signingIdentity`, so the Tauri bundler skips its deep codesign pass (which would otherwise fail on the appended-payload relay sidecar) — the `.dmg`/`.app` ship unsigned, each Mach-O carrying its own ad-hoc signature. `CI=true` (auto-set on Actions) skips `bundle_dmg.sh`'s Finder styling. This is **additive** — the zips and Homebrew path are unchanged
6. Runs `scripts/e2e-smoke.sh` on the Unix zips — the packaged binary must boot cleanly, serve all ports, and shut down with exit 0 before upload
7. Creates a GitHub Release with the four zips, the Windows `-setup.exe`, the two macOS `.dmg`s, `SHA256SUMS.txt`, and auto-generated release notes

The version embedded in each zip filename is derived from the tag by stripping the `deckbridge-` prefix (e.g. tag `deckbridge-v1.2.3` → version `v1.2.3`). The Windows installer is named `deckbridge_<X.Y.Z>_x64-setup.exe` by the Tauri bundler.

---

### Local build and package (single platform)

```bash
cd deckbridge

# Build everything and package in one step:
mise run package -- v1.2.3
# → dist/deckbridge-v1.2.3-macos-arm64.zip  (on Apple Silicon)

# Or step by step:
mise run compile
node scripts/package.mjs v1.2.3
```

---

### Release checklist

- [ ] `mise run beforeCommit` passes (format + lint + typecheck + test + compile)
- [ ] Manual smoke test: plug in the device, open http://localhost:3000, press a key, watch Elgato software respond
- [ ] `mise run e2e` passes locally on the packaged zip (`mise run package -- vX.Y.Z` first)
- [ ] Push the tag: `git tag deckbridge-vX.Y.Z && git push origin deckbridge-vX.Y.Z`
- [ ] Verify the GitHub Actions run succeeds for all four Unix platforms (smoke test is part of CI), the Windows Tauri NSIS job, and the macOS Tauri `.dmg` job (arm64 + x86_64)
- [ ] Release is published automatically; verify the four zips, the `-setup.exe`, the two `.dmg`s, and `SHA256SUMS.txt` are attached
- [ ] Bump the Scoop manifest (`packaging/scoop/deckbridge.json`): update `version`, the `url`, and `hash` from the release's `SHA256SUMS.txt` (see `packaging/scoop/README.md`)
- [ ] Bump the Homebrew tap formula (`packaging/homebrew/deckbridge.rb`): update `version` + the four `sha256` values from the release's `SHA256SUMS.txt` (see `packaging/homebrew/README.md`)
