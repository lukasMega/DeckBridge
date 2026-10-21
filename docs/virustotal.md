---
sidebar_label: VirusTotal comparison
title: VirusTotal PoC comparison
slug: /virustotal
description: Isolated scanner results before DeckBridge release 0.21.0.
---

# VirusTotal PoC comparison

Release candidate: `deckbridge-v0.21.0`.
These isolated samples were scanned before release.
They are not DeckBridge release downloads.
Detection scores can change over time.
Samples uploaded to VirusTotal are public.

## Windows x64

Scanned: 2026-10-21T23:24:31.040Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c.exe | `61117676543dcf9a40506e1f40af8e422da1194d1e4ad85313d3f9bfceea08dc` | 1/70 | APEX: Malicious | [report](https://www.virustotal.com/gui/file/61117676543dcf9a40506e1f40af8e422da1194d1e4ad85313d3f9bfceea08dc) |
| hello-native.dll | `f0c151fd11126a39a71726ba4c61a8cf81ba2426bba2890f255eb1025f4f0700` | 1/71 | Cynet: Malicious (score: 100) | [report](https://www.virustotal.com/gui/file/f0c151fd11126a39a71726ba4c61a8cf81ba2426bba2890f255eb1025f4f0700) |
| hello-tauri-setup.exe | `0d31f1478031a6010b1f1f2609f47e616a2d47beac75a952b5b5681b9d5d8444` | 2/71 | Cylance: Unsafe; APEX: Malicious | [report](https://www.virustotal.com/gui/file/0d31f1478031a6010b1f1f2609f47e616a2d47beac75a952b5b5681b9d5d8444) |
| hello-tauri.exe | `40615d9dfc143624521aeb7a6ebd5380b54b9ddbef554f8f0d2146bcf64030cb` | 0/71 | None | [report](https://www.virustotal.com/gui/file/40615d9dfc143624521aeb7a6ebd5380b54b9ddbef554f8f0d2146bcf64030cb) |
| hello-tray.exe | `02854b6820dc89558a78bdfcf1f4365cbb737e6374ca2f15c1aa6d704835a385` | 4/71 | Symantec: ML.Attribute.HighConfidence; Microsoft: Trojan:Win32/Wacatac.B!ml; DeepInstinct: MALICIOUS; APEX: Malicious | [report](https://www.virustotal.com/gui/file/02854b6820dc89558a78bdfcf1f4365cbb737e6374ca2f15c1aa6d704835a385) |
| hello-txiki-library.exe | `b212c67e72f411849c540b25cc034ace3ec60bcc4d10d1bfd78a8053ec9fbb3c` | 5/68 | Bkav: W32.Malware.6A1826DF; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!D2533BAC3DA7; Kingsoft: malware.kb.a.795; Microsoft: Trojan:Win32/Wacatac.B!ml | [report](https://www.virustotal.com/gui/file/b212c67e72f411849c540b25cc034ace3ec60bcc4d10d1bfd78a8053ec9fbb3c) |
| hello-txiki.exe | `c9d598c72988df676856e633da1449e0723e4282cb4e57abbb3067a1600df90b` | 3/71 | Bkav: W32.Malware.F6E0652F; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!07C5787DF6A1 | [report](https://www.virustotal.com/gui/file/c9d598c72988df676856e633da1449e0723e4282cb4e57abbb3067a1600df90b) |
| tjs.exe | `384f683fb0333cb53503d18192b7c381062c0d2404d78efb1360e82ccd7537ef` | 1/71 | Bkav: W32.Malware.60C57FAC | [report](https://www.virustotal.com/gui/file/384f683fb0333cb53503d18192b7c381062c0d2404d78efb1360e82ccd7537ef) |

## macOS arm64

Scanned: 2026-10-21T23:24:31.043Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c | `ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120) |
| hello-tauri | `069e4c73758bf9820835661bececcde89f569b6f8474fea1c17d829d0c2094ad` | 0/62 | None | [report](https://www.virustotal.com/gui/file/069e4c73758bf9820835661bececcde89f569b6f8474fea1c17d829d0c2094ad) |
| hello-tauri.dmg | `06b6a4f8e2d43c5599cae16dbbc151d6e98f8d03a39d252943f2896049394bb1` | 0/58 | None | [report](https://www.virustotal.com/gui/file/06b6a4f8e2d43c5599cae16dbbc151d6e98f8d03a39d252943f2896049394bb1) |
| hello-txiki | `eaee96a1ad4d676b86ce49bf481ddd753ae0f790d4fe3ab73778902abebae979` | 0/63 | None | [report](https://www.virustotal.com/gui/file/eaee96a1ad4d676b86ce49bf481ddd753ae0f790d4fe3ab73778902abebae979) |
| hello-txiki-library | `18b624fceedf0523c69b33616435929c27157eb2ee6c9b79d575a2e0fc7d1b39` | 0/63 | None | [report](https://www.virustotal.com/gui/file/18b624fceedf0523c69b33616435929c27157eb2ee6c9b79d575a2e0fc7d1b39) |
| libhello-native.dylib | `ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e) |
| tjs | `dba8f1f4da2fbc692744d48e411ad733ddee9825227f8c2c26d03321199b1708` | 0/61 | None | [report](https://www.virustotal.com/gui/file/dba8f1f4da2fbc692744d48e411ad733ddee9825227f8c2c26d03321199b1708) |

See [PoC source](https://github.com/lukasMega/DeckBridge/tree/main/.github/virustotal-poc).
See [0.17.0 release investigation](./virustotal-v0.17.0.md).
Few detections alone cannot establish safety or malware.
