# Homebrew tap for DeckBridge

Distribute the `deckbridge` CLI through a custom Homebrew tap. Because Homebrew
places the binary itself (rather than a browser/`.dmg` download), macOS does not
apply the Gatekeeper quarantine flag — so there is **no Apple Developer ID, no
notarization, and no "developer cannot be verified" dialog**. This is the
no-Dev-ID, CLI-formula path.

The formula lives at [`deckbridge.rb`](./deckbridge.rb).

---

## Publish the tap (one-time, maintainer)

1. Create a GitHub repo named **`homebrew-tap`** under the same owner as the
   release repo (the `homebrew-` prefix is required; `brew tap OWNER/tap`
   expands to `OWNER/homebrew-tap`).
2. Add the formula at `Formula/deckbridge.rb` in that repo:
   ```bash
   git clone https://github.com/OWNER/homebrew-tap
   mkdir -p homebrew-tap/Formula
   cp deckbridge.rb homebrew-tap/Formula/deckbridge.rb
   cd homebrew-tap && git add Formula/deckbridge.rb && git commit -m "deckbridge X.Y.Z" && git push
   ```

---

## Install (end user)

```bash
brew tap OWNER/tap
brew install OWNER/tap/deckbridge
brew services start deckbridge   # run in background, autostart at login (no sudo)
```

`brew services start` installs a per-user LaunchAgent (macOS) / systemd user
service (Linux) that runs `deckbridge` at login. Logs go to
`$(brew --prefix)/var/log/deckbridge.log`. Stop/uninstall the service with
`brew services stop deckbridge`.

The app then serves the web UI on http://localhost:3000, runs CORA on ports
5343/5344, and advertises over mDNS so Elgato software auto-discovers it.

---

## Bump on each release

For each new tag `deckbridge-vX.Y.Z`, update `version` and the four `sha256`
lines in `deckbridge.rb`. The hashes are in the release's `SHA256SUMS.txt`.

The order of the four artifacts (top → bottom in the formula) is:
`macos-arm64`, `macos-x86_64`, `linux-arm64`, `linux-x86_64`.

Manual:

1. Set `version "X.Y.Z"` (no leading `v`) near the top of the formula.
2. Download `SHA256SUMS.txt` from the release:
   ```bash
   VER=1.2.3
   curl -fsSL -o SHA256SUMS.txt \
     "https://github.com/OWNER/REPO/releases/download/deckbridge-v${VER}/SHA256SUMS.txt"
   ```
   It lists one `<sha256>  <zip-filename>` line per artifact. Look up each
   platform's hash and paste it into the matching `sha256` line.

Quick lookup of a single hash (repeat per platform):

```bash
VER=1.2.3
for p in macos-arm64 macos-x86_64 linux-arm64 linux-x86_64; do
  awk -v f="deckbridge-v${VER}-${p}.zip" '$2==f {print f": "$1}' SHA256SUMS.txt
done
```

Paste each printed hash into the corresponding `sha256 "REPLACE_WITH_SHA"` line.

> This can later be automated: a CI step in the release workflow reads
> `SHA256SUMS.txt`, rewrites `version` + the four `sha256` lines, and commits the
> updated `Formula/deckbridge.rb` to the `homebrew-tap` repo.
