# VirusTotal Investigation: DeckBridge 0.13.3

Date: 2026-09-15

## Conclusion

Likely false-positive cluster.

VirusTotal reports malware suspicion.
No vulnerability finding exists.
Compromise evidence remains absent.
Absolute certainty requires deeper auditing.

## Reported Result

[VirusTotal report][vt-installer] shows 5/69 detections.
Sixty-four engines report clean.
ClamAV release gate passed.

Installer details:

- Name: `DeckBridge_0.13.3_x64-setup.exe`
- Size: 3,264,148 bytes
- SHA-256: `5d2b6d648308259b682b68ec206c533ca6c87af68da29b0dc62eb1c0c4d0d46b`
- Signature: missing
- Package format: Tauri NSIS

GitHub release digest matches exactly.
VirusTotal scanned official release bytes.

## Detection Breakdown

Installer detections remain generic:

- Arctic Wolf: `Unsafe`
- Bkav Pro: `W32.Malware.676E0832`
- DeepInstinct: `MALICIOUS`
- SecureAge: `Malicious`
- Sophos: `Generic ML PUA`

Bundled `deckbridge.exe` scores 5/70.

Core detections also remain generic:

- Bkav Pro: `W32.Malware.676E0832`
- CrowdStrike: `malicious_confidence_60%`
- Elastic: `Malicious (moderate Confidence)`
- McAfee: `Real Protect-LS!3326CBEC7A01`
- Microsoft: `Trojan:Win32/Wacatac.B!ml`

Different engines flag each layer.
Such instability suggests heuristic scoring.

Other bundled results:

- `deckbridge-tauri.exe`: 1/70
- `deckbridge-tray.exe`: 1/70
- `nsis_tauri_utils.dll`: 2/68
- `libdeckbridge_native.dll`: 0/68
- `libhidapi.dll`: 0/69

## NSIS YARA Match

[CAPE NSIS rule][cape-nsis] matches integrity-check bytes.
It identifies NSIS packaging.
It never asserts malware.

DeckBridge uses Tauri NSIS packaging.
Therefore, this match remains expected.
Code signing cannot remove it.

## Sigma Matches

### Executable Creation

[Sysmon rule][sigma-pe] matches Event 29.
Event 29 records PE creation.
Installer extraction creates PE files.
Therefore, this match remains expected.

### Unsigned LSASS Image

[LSASS rule][sigma-lsass] watches unsigned loads.
Sandbox process tree separates LSASS.
DeckBridge never parented LSASS.
No DeckBridge LSASS code exists.

Likely cause involves sandbox noise.
Installer-wide event grouping worsens attribution.

## Primary Heuristic Triggers

### Custom Runtime

`deckbridge.exe` begins with `tjs.exe`.
Prefix size equals 2,486,784 bytes.
Prefix SHA-256 matches runtime release:

`a0b69531fc98325fdc5b341609ca4fcdccecfb4cb0dee6be1d1e5bb8e060d64e`

Runtime profile uses aggressive slimming.
Build profile reports following settings:

- `smallest-compressed-ffi`
- MinSize optimization
- compressed bytecode
- stripped symbols
- FFI enabled
- TLS disabled

Standalone runtime lacks VirusTotal history.
Low prevalence weakens reputation signals.

### High-Entropy Overlay

`deckbridge.exe` adds 495,912 bytes.
Overlay entropy reaches 7.998.
Such entropy resembles packed malware.

Txiki compilation appends application payload.
This behavior remains legitimate here.
Heuristic scanners cannot know intent.

### Runtime DLL Extraction

Application embeds compressed native DLLs.
Runtime writes them into cache.
Runtime then loads them through FFI.

Relevant implementation:

- [`native-libs.ts`](../ts/src/native-libs.ts)
- [`build.mjs`](../ts/build.mjs)

Malware often uses similar patterns.
Both extracted DLLs scan clean.

### Missing Signatures

Windows artifacts remain unsigned.
Missing signatures reduce publisher trust.
Missing reputation increases ML sensitivity.

Relevant configuration:

- [`tauri.conf.json`](../src-tauri/tauri.conf.json)
- [`release.yml`](../.github/workflows/release.yml)

## Supply-Chain Review

Official installer hash matches GitHub.
Extracted payload hashes match VirusTotal.
Runtime prefix matches published release.
No unexpected payload appeared.

One real gap remains.
Runtime archive lacks hash verification.
CI caches downloaded runtime afterward.
Compromised assets could persist silently.

Current archive digest:

`4981d800cbe53b7a196788c316d82b6e45106707f63ef23a6037e3c575a35efa`

Pin this digest immediately.
Verify digest before extraction.

## Recommended Fixes

### 1. Add Authenticode Signing

Sign every Windows PE.
Include installer, sidecars, native DLLs.
Reuse one stable certificate.

[Tauri signing guidance][tauri-signing] explains configuration.
Signing improves publisher reputation.
Signing cannot guarantee clearance.

### 2. Ship Native DLLs Separately

Avoid compressed DLL embedding.
Bundle signed DLLs as resources.
Set library paths during startup.

This removes runtime PE creation.
It also reduces overlay entropy.

### 3. Pin Runtime Digests

Store expected archive SHA-256.
Verify before extraction.
Include digest inside cache key.

### 4. Compare Runtime Variants

Test stock txiki builds.
Test uncompressed bytecode builds.
Compare fresh scanner results.

This isolates strongest trigger.

### 5. Submit False Positives

Submit core executable first.
Prioritize Microsoft, CrowdStrike, Elastic.
Provide source repository links.
Provide deterministic hash evidence.

## Final Assessment

No malware proof surfaced.
No vulnerability evidence surfaced.
Signals fit heuristic false positives.

Unsigned packed-style runtime drives suspicion.
Runtime DLL extraction adds suspicion.
NSIS and Sigma matches remain incidental.

Signing probably helps most.
Packaging changes help next.
Digest verification remains mandatory.

[vt-installer]: https://www.virustotal.com/gui/file/5d2b6d648308259b682b68ec206c533ca6c87af68da29b0dc62eb1c0c4d0d46b
[cape-nsis]: https://github.com/kevoreilly/CAPEv2/blob/master/analyzer/windows/data/yara/NSIS.yar
[sigma-pe]: https://github.com/SigmaHQ/sigma/blob/master/rules/windows/sysmon/sysmon_file_executable_detected.yml
[sigma-lsass]: https://github.com/SigmaHQ/sigma/blob/master/rules/windows/image_load/image_load_lsass_unsigned_image_load.yml
[tauri-signing]: https://v2.tauri.app/distribute/sign/windows/
