# Scoop manifest for DeckBridge (Windows)

Distribute the Windows build of `deckbridge` through a custom [Scoop](https://scoop.sh)
bucket. The manifest installs the **Tauri NSIS installer** (`-setup.exe`) attached
to each GitHub release, runs it silently into Scoop's app directory, and exposes
the supervisor binary. Scoop installs without UAC prompts and side-steps the raw
`.exe` SmartScreen warning — **no code-signing certificate required**.

The manifest lives at [`deckbridge.json`](./deckbridge.json).

---

## Publish the bucket (one-time, maintainer)

1. Create a GitHub repo named **`scoop-bucket`** under the same owner as the
   release repo (the conventional name; `scoop bucket add` can point at any repo).
2. Add the manifest at `bucket/deckbridge.json` in that repo:
   ```powershell
   git clone https://github.com/OWNER/scoop-bucket
   New-Item -ItemType Directory -Force scoop-bucket\bucket
   Copy-Item deckbridge.json scoop-bucket\bucket\deckbridge.json
   cd scoop-bucket; git add bucket\deckbridge.json; git commit -m "deckbridge X.Y.Z"; git push
   ```

---

## Install (end user)

```powershell
scoop bucket add deckbridge https://github.com/OWNER/scoop-bucket
scoop install deckbridge
```

This runs the NSIS installer silently, then drops a `deckbridge` shim and a Start
Menu shortcut. Launch it from either; it runs as a tray supervisor — serving the
web UI on http://localhost:3000, CORA on ports 5343/5344, and advertising over
mDNS so Elgato software auto-discovers it. Quit it from the tray icon.

Update / remove:
```powershell
scoop update deckbridge
scoop uninstall deckbridge
```

---

## Bump on each release

For each new tag `deckbridge-vX.Y.Z`, update `version`, the `url` (the literal
`X.Y.Z` segments), and the `hash` in `deckbridge.json`. The hash is in the
release's `SHA256SUMS.txt` — the line for `deckbridge_X.Y.Z_x64-setup.exe`:

```powershell
$VER = "1.2.3"
$url = "https://github.com/OWNER/REPO/releases/download/deckbridge-v$VER/SHA256SUMS.txt"
(irm $url) -split "`n" | Select-String "deckbridge_${VER}_x64-setup.exe"
```

Paste the 64-char hash into the `hash` line.

> This is also automatable: the manifest ships with `checkver` (reads the latest
> `deckbridge-v*` GitHub release tag) and `autoupdate` (rewrites `url` + pulls the
> hash from `SHA256SUMS.txt`). Run `scoop` excavator / `bin/checkver.ps1 -Update`
> in the bucket repo, or wire it into CI, to bump `version` + `hash` automatically.
