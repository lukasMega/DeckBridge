# Sidecar binaries (not committed)

Tauri bundles the binary whose name matches the build's target triple
(gotcha G2). CI must place, before `tauri build`:

**Windows** (`build-windows` job):

- `deckbridge-x86_64-pc-windows-msvc.exe` — copy of the `mise run compile`
  output (`deckbridge/deckbridge`, renamed + `.exe`).
- `deckbridge-tray-x86_64-pc-windows-msvc.exe` — copy of
  `rust/target/release/deckbridge-tray.exe`.

**macOS** (`build-macos-tauri` job; `<arch>` = `aarch64` on Apple Silicon,
`x86_64` on Intel — no `.exe` suffix):

- `deckbridge-<arch>-apple-darwin` — copy of the `mise run compile` output.
- `deckbridge-tray-<arch>-apple-darwin` — copy of
  `rust/target/release/deckbridge-tray`.

Both macOS sidecars are ad-hoc signed (`codesign --force --sign -`) before
`cargo tauri build`.

All are referenced by `bundle.externalBin` in `../tauri.conf.json` as
`binaries/deckbridge` and `binaries/deckbridge-tray` (the triple, and `.exe` suffix
on Windows, are appended by the bundler).

To run `cargo check` on a non-Windows host, create empty same-triple stubs so
the Tauri config validates, e.g. on macOS arm64:

```sh
touch binaries/deckbridge-aarch64-apple-darwin binaries/deckbridge-tray-aarch64-apple-darwin
```

These stubs are git-ignored.
