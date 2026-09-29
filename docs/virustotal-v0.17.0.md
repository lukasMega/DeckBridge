---
sidebar_label: VirusTotal results
title: VirusTotal results for DeckBridge 0.17.0
slug: /virustotal-v0.17.0
description: Antivirus findings for DeckBridge 0.17.0 downloads.
---

# VirusTotal results: DeckBridge 0.17.0

Results checked September 29, 2026.
VirusTotal scores may change.

## Detection details

| Download | Detections | Vendors and labels |
| --- | --- | --- |
| [Windows portable ZIP](https://www.virustotal.com/gui/file/0222989a41d85d10a39c31dbfa9d5d03c7bbfff254b015d8a5f5af407ed3b493) | 1/51 | Bkav Pro: `W32.Malware.A8967BE6` |
| [Windows installer](https://www.virustotal.com/gui/file/222cdc96420cd29802f2d38699f8fe97d5e91015ca2ef33dd52d2b7b63ab3c2e) | 3/68 | Arctic Wolf: `Unsafe`; Bkav Pro: `W32.Malware.A8967BE6`; SecureAge: `Malicious` |
| [macOS Intel DMG](https://www.virustotal.com/gui/file/be7bae75feb6681027644545f32d835988ba8c5f1209a5ed429f1a64bb782855) | 1/58 | Microsoft: `Trojan:Script/Wacatac.C!ml` |

Windows ZIP scan recorded thirteen timeouts.

## Bundled components

| Component | Detections | Finding |
| --- | --- | --- |
| [Windows Tauri launcher](https://www.virustotal.com/gui/file/31240fb02bb852cc05d696eebb4ec1ca08ba763ccb61e85fec7695a8d16163cd) | 3/71 | MaxSecure, Microsoft, Trapmine |
| [Tauri NSIS utility DLL](https://www.virustotal.com/gui/file/5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709) | 2/71 | Cynet, MaxSecure |
| [Windows relay](https://www.virustotal.com/gui/file/88f1068edd95e380ecd58533ec5da7c7559f28f28d22368a3282227b2f0c05ca) | 2/71 | Bkav Pro, Elastic |
| [Windows tray](https://www.virustotal.com/gui/file/f813921469f01d1f052cee35caa21f1251c84d48836e0d41d7dbe5c75a34224b) | 1/71 | SecureAge |
| [Windows native DLL](https://www.virustotal.com/gui/file/116980b87adc68de5d7eeacca410e889b9dadaa4fd7e738543693ac8f5922cac) | 0/67 | Extracted during relay startup |
| [Windows HIDAPI DLL](https://www.virustotal.com/gui/file/3337f297280bde1b5b55a29cac37217f0c0ebd95f63bcd957be9a3e479381e39) | 0/70 | Extracted during relay startup |
| macOS relay, launcher, tray | 0/63 each | Bundled inside flagged DMG |
| macOS native and HIDAPI dylibs | 0/57, 0/63 | Extracted during relay startup |

[Tauri builds NSIS installers](https://v2.tauri.app/distribute/windows-installer/).
Its utility DLL received two detections.
Windows launcher received three detections.
Windows portable ZIP omits Tauri packaging.
Its relay still received detections.
NSIS alone cannot explain every alert.

[Txiki compiles DeckBridge's relay](https://github.com/lukasMega/DeckBridge/blob/deckbridge-v0.17.0/scripts/compile.mjs).
QuickJS runs inside Txiki.
No separate QuickJS binary ships.
Compiled bytecode and compressed libraries ship embedded.
[Relay extracts libraries into cache](https://github.com/lukasMega/DeckBridge/blob/deckbridge-v0.17.0/ts/src/infra/native-libs.ts).
Those extracted libraries scanned clean.
Such packaging could trigger heuristics.
Current scans cannot isolate causes.

VirusTotal also displays `d9jf6.exe`.
That alias refers to installer.
Matching SHA-256 confirms file identity.

## Assessment

Few scanners agree on detections.
Labels alone cannot establish malware.
These detections are likely false positives.
Reviewed source explains observed update checks.
Reviewed source explains mDNS advertisement.
No clear malicious behavior appeared.
This assessment cannot prove safety.

Installer sandbox showed no network traffic.
ZIP sandbox contacted GitHub releases.
DeckBridge [checks updates through GitHub](https://github.com/lukasMega/DeckBridge/blob/deckbridge-v0.17.0/ts/src/infra/update-check.ts).
macOS sandbox also showed startup activity.
Some macOS traffic remained unattributed.
DeckBridge [advertises mDNS services](https://github.com/lukasMega/DeckBridge/blob/deckbridge-v0.17.0/ts/src/infra/mdns-advertiser.ts).

Release workflow requires ClamAV scanning.
Published artifacts passed that check.
Windows installer remains unsigned.
Its NSIS packaging can trigger heuristics.

## Verify your download

Download files from [official 0.17.0 release](https://github.com/lukasMega/DeckBridge/releases/tag/deckbridge-v0.17.0).
Compare SHA-256 against [release checksums](https://github.com/lukasMega/DeckBridge/releases/download/deckbridge-v0.17.0/SHA256SUMS.txt).

```text
0222989a41d85d10a39c31dbfa9d5d03c7bbfff254b015d8a5f5af407ed3b493  deckbridge-v0.17.0-windows-x86_64.zip
222cdc96420cd29802f2d38699f8fe97d5e91015ca2ef33dd52d2b7b63ab3c2e  DeckBridge_0.17.0_x64-setup.exe
be7bae75feb6681027644545f32d835988ba8c5f1209a5ed429f1a64bb782855  DeckBridge_0.17.0_x64.dmg
```

Matching hashes confirm identical bytes.
They cannot prove malware absence.
Keep antivirus protection enabled.
Report unexpected warnings through [GitHub issues](https://github.com/lukasMega/DeckBridge/issues).
Include filename, hash, vendor, and label.
