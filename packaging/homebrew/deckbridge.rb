# deckbridge — Homebrew formula (custom tap, NOT homebrew-core)
#
# Distributed through a personal tap (e.g. `OWNER/homebrew-tap`), installed via:
#   brew tap OWNER/tap && brew install OWNER/tap/deckbridge
#
# Why a tap and not homebrew-core?
#   This ships a prebuilt binary that is NOT signed/notarized with an Apple
#   Developer ID. Homebrew installs from a tap are placed by `brew` itself, so
#   macOS does NOT apply the Gatekeeper quarantine flag (com.apple.quarantine)
#   the way a browser download or .dmg would. That means no "developer cannot be
#   verified" dialog and no `xattr -dr` dance — the CLI just runs. This is the
#   no-Dev-ID, CLI-formula distribution path.
#
# Per-release maintenance:
#   `version`, the four `url`s, and the four `sha256`s below are bumped on every
#   release. CI (or `packaging/homebrew/README.md`) pulls the hashes from the
#   release's SHA256SUMS.txt. Search for REPLACE_WITH_SHA / X.Y.Z when bumping.
class Deckbridge < Formula
  desc "Bridge a Mirabox/Ajazz USB stream deck to Elgato software over CORA"
  homepage "https://github.com/OWNER/REPO"
  version "X.Y.Z"
  license "MIT"

  # Release zips are attached to the tag `deckbridge-vX.Y.Z`.
  # Pick the right artifact per OS + CPU. CI bumps url + sha256 on release.
  on_macos do
    on_arm do
      url "https://github.com/OWNER/REPO/releases/download/deckbridge-v#{version}/deckbridge-v#{version}-macos-arm64.zip"
      sha256 "REPLACE_WITH_SHA"
    end
    on_intel do
      url "https://github.com/OWNER/REPO/releases/download/deckbridge-v#{version}/deckbridge-v#{version}-macos-x86_64.zip"
      sha256 "REPLACE_WITH_SHA"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/OWNER/REPO/releases/download/deckbridge-v#{version}/deckbridge-v#{version}-linux-arm64.zip"
      sha256 "REPLACE_WITH_SHA"
    end
    on_intel do
      url "https://github.com/OWNER/REPO/releases/download/deckbridge-v#{version}/deckbridge-v#{version}-linux-x86_64.zip"
      sha256 "REPLACE_WITH_SHA"
    end
  end

  def install
    # Install the main binary, the deckbridge-tray helper, and the status icons all
    # into libexec so they sit NEXT TO each other. The app resolves its own
    # executable's realpath at startup and looks for `deckbridge-tray` (plus the PNG
    # icons) in that same directory — symlinking only the binary into bin would
    # break that adjacency, so we symlink bin -> libexec instead.
    libexec.install Dir["*"]
    libexec.glob("*").each { |f| chmod("+x", f) if f.file? && f.extname.empty? }
    bin.install_symlink libexec/"deckbridge"
  end

  service do
    run [opt_libexec/"deckbridge"]
    # Point the app straight at the tray sidecar. The app would otherwise locate
    # `deckbridge-tray` via the realpath of its own executable (libexec), which works —
    # but as a LaunchAgent we set it explicitly so tray resolution never depends
    # on exePath symlink behavior. app.ts honors DECKBRIDGE_TRAY_BIN before any path probe.
    environment_variables DECKBRIDGE_TRAY_BIN: opt_libexec/"deckbridge-tray"
    keep_alive true
    log_path var/"log/deckbridge.log"
    error_log_path var/"log/deckbridge.log"
  end

  test do
    # No release exists at authoring time and the binary has no documented
    # `--version` flag, so keep this conservative: assert the installed binary
    # is present and executable. Tighten to a `--version` smoke once a release
    # is published and the flag is confirmed.
    assert_path_exists libexec/"deckbridge"
    assert_predicate libexec/"deckbridge", :executable?
  end

  def caveats
    <<~EOS
      libhidapi is embedded in the binary (auto-extracted at startup) — nothing
      extra to install.

      deckbridge serves a web UI on http://localhost:3000, runs CORA servers on
      ports 5343/5344, and advertises itself over mDNS (_elg._tcp) so Elgato
      software auto-discovers it on your LAN.

      Run it in the background and start it at login (user LaunchAgent, no sudo):
        brew services start deckbridge
    EOS
  end
end
