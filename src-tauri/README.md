 # src-tauri — Windows + macOS installer/supervisor for deckbridge

**Windows (NSIS `.exe`) and macOS (`.dmg`).** This is the Tauri shell of the
distribution plan (`.claude/plans/2026-06-18_deckbridge-tauri-wrapper.md`).
Windows = Track W. macOS = added **additively** on 2026-06-20 (user override of
the original "macOS = Homebrew only" lock): the native `.dmg` is an **extra**
option alongside the still-shipped Homebrew formula + manual zip. Linux still
ships only via Homebrew/zip and never builds this crate.

macOS specifics: **Model A, no Apple Developer ID.** The Tauri bundler does
**not** codesign the app (`tauri.macos.conf.json` sets *no* `signingIdentity`).
This is deliberate: the bundler's deep-sign pass would `codesign --force` the
relay sidecar, and the relay is a `tjs compile` binary with its bytecode payload
appended after the Mach-O — re-signing it fails strict validation ("main
executable failed strict validation"). So instead each Mach-O ships its own
ad-hoc signature: the relay keeps its as-compiled **linker-signed** signature
(kernel runs it leniently; the appended bytes are never mapped), the Tauri exe
gets rustc's linker-signed signature, and `deckbridge-tray` is explicitly `codesign
--force --sign -`'d (it's a plain Mach-O, signs fine). The `.app`/`.dmg` are
therefore **unsigned bundles**. Hardened runtime is irrelevant without signing,
but conceptually it stays off so the relay's runtime extract-and-`dlopen` of
`libhidapi`/`libdeckbridge_native` would not be rejected by library validation (plan
gotcha **G3**). The cost is unsigned-Gatekeeper friction: the first launch needs
**right-click → Open** (or `xattr -dr com.apple.quarantine
/Applications/deckbridge.app`). Homebrew avoids this entirely — it stays the
friction-free macOS path.

## What it is

A thin Tauri v2 **tray-supervisor** (plan Model A) around the existing
`deckbridge` standalone binary. It exists only to give users a real installer
(`.exe` on Windows, `.dmg`/`.app` on macOS). It reimplements **none** of the
relay / web UI / USB logic.

On launch it:

1. Shows **no window** (`app.windows: []`). The dashboard stays the existing
   browser page at `http://localhost:3000`, served by the sidecar.
2. Spawns the real `deckbridge` binary as a **sidecar** (`externalBin`).
3. Points the sidecar's `DECKBRIDGE_TRAY_BIN` env var at the bundled `deckbridge-tray`
   (`deckbridge-tray.exe` on Windows), so the binary spawns **deckbridge-tray** exactly as it
   does standalone — `deckbridge-tray` remains the single tray (no competing Tauri
   tray; locked decision).
4. On quit (deckbridge-tray's Quit shuts the sidecar down → its process exits → the
   supervisor sees `Terminated` and calls `app.exit(0)`), and on
   `RunEvent::ExitRequested`/`Exit`, kills the **whole sidecar process tree** so
   no orphan `deckbridge` / `deckbridge-tray` lingers and ports 3000/5343 are freed
   (gotcha G1). Windows uses `taskkill /F /T`; macOS/Linux SIGTERM the relay
   (which cooperatively tears down deckbridge-tray + ports via its own shutdown
   handler) and then SIGTERM any surviving descendants found via `pgrep -P`.

## Files

```
src-tauri/
  Cargo.toml            crate (tauri 2, tauri-plugin-shell 2); windows_subsystem in main.rs
  build.rs              tauri_build::build()
  tauri.conf.json       no window, bundle.active, targets=["nsis"] (base/Windows), externalBin, identifier com.lukas.deckbridge
  tauri.macos.conf.json macOS override (auto-merged via RFC 7396): targets=["app","dmg"], minimumSystemVersion (no signingIdentity → bundler skips codesign)
  src/
    main.rs             #![windows_subsystem="windows"] → lib::run()
    lib.rs              supervisor: spawn sidecar + kill-on-exit (process tree; per-OS kill_tree)
  capabilities/
    default.json        shell:allow-execute/allow-spawn for the two sidecars only (platforms: windows + macOS)
  icons/                PLACEHOLDER app icon set (icon.ico + PNGs) — replace before release
  frontend/index.html   placeholder frontendDist (never shown; window-less app)
  binaries/             sidecars, NOT committed — produced by CI per target triple (see binaries/README.md)
```

## Target-triple naming (gotcha G2)

`externalBin` entries (`binaries/deckbridge`, `binaries/deckbridge-tray`) are
bundled by matching the **target triple** of the build. CI must place, before
`tauri build`:

- Windows: `binaries/deckbridge-x86_64-pc-windows-msvc.exe` (the `mise run
  compile` output, renamed +`.exe`) and
  `binaries/deckbridge-tray-x86_64-pc-windows-msvc.exe` (copy of
  `rust/target/release/deckbridge-tray.exe`).
- macOS: `binaries/deckbridge-<arch>-apple-darwin` and
  `binaries/deckbridge-tray-<arch>-apple-darwin`, where `<arch>` is `aarch64`
  (Apple Silicon) or `x86_64` (Intel) — no `.exe` suffix. `chmod +x` both (a
  `cp` over a stale dest can drop the execute bit). Ad-hoc sign **only**
  `deckbridge-tray` before `cargo tauri build`; leave the relay's linker-signed
  signature alone (see the macOS note above).

deckbridge-tray embeds its own status icons via `include_bytes!`, so the icon PNGs do
**not** need to be bundled alongside it.

## How CI builds it

The Tauri CLI (`cargo-tauri`) is the build driver — it is not installed here;
CI installs it (`cargo install tauri-cli --version '^2' --locked`). Both jobs
live in `.github/workflows/release.yml` (`build-windows`, `build-macos-tauri`).

Windows runner (`mise run tauri-build` mirrors this locally):

```sh
# from deckbridge/
mise run compile                                  # → ./deckbridge (txiki binary)
mise run tray-rs                                  # → rust/target/release/deckbridge-tray.exe
mkdir -p src-tauri/binaries
cp deckbridge                              src-tauri/binaries/deckbridge-x86_64-pc-windows-msvc.exe
cp rust/target/release/deckbridge-tray.exe src-tauri/binaries/deckbridge-tray-x86_64-pc-windows-msvc.exe
cd src-tauri
cargo tauri build                                 # → target/release/bundle/nsis/*-setup.exe
```

Unsigned is acceptable (one-click SmartScreen "Run anyway"); no signing
dependency.

macOS runner (`mise run tauri-build-macos` mirrors this locally):

```sh
# from deckbridge/ (TRIPLE = aarch64-apple-darwin or x86_64-apple-darwin)
mise run compile && mise run tray-rs
mkdir -p src-tauri/binaries
cp deckbridge                             src-tauri/binaries/deckbridge-$TRIPLE
cp rust/target/release/deckbridge-tray src-tauri/binaries/deckbridge-tray-$TRIPLE
chmod +x src-tauri/binaries/deckbridge-$TRIPLE src-tauri/binaries/deckbridge-tray-$TRIPLE
codesign --force --sign - src-tauri/binaries/deckbridge-tray-$TRIPLE   # relay: do NOT re-sign
cd src-tauri
CI=true cargo tauri build --bundles app,dmg       # → target/release/bundle/dmg/*.dmg + bundle/macos/*.app
```

`CI=true` skips `bundle_dmg.sh`'s AppleScript/Finder window-styling pass (needs a
GUI/Automation grant; GitHub Actions sets `CI` automatically). Unsigned bundle —
no Apple Developer ID, no notarization. Downloads hit Gatekeeper (right-click →
Open / `xattr -dr`).

## Local check on non-Windows

`cargo check` (or `mise run tauri-check`) works on any host (Tauri compiles
cross-platform). The `binaries/` dir needs same-triple stubs first — see
`binaries/README.md`. Full NSIS install + sidecar spawn + process-tree kill are
**not** verifiable off the target OS; the macOS `.app`/`.dmg` bundle is
verifiable on a Mac via `mise run tauri-build-macos`.
