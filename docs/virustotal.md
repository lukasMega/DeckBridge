---
sidebar_label: VirusTotal comparison
title: VirusTotal PoC comparison
slug: /virustotal
description: Isolated scanner results before DeckBridge release 0.21.1.
---

# VirusTotal PoC comparison

Release candidate: `deckbridge-v0.21.1`.
These isolated samples were scanned before release.
They are not DeckBridge release downloads.
Detection scores can change over time.
Samples uploaded to VirusTotal are public.

## Windows x64

Scanned: 2026-11-06T14:26:30.648Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c.exe | `6031523c16bdfc40630e775cb5ec4f93702809716a93eee136536b7668ed17dc` | 1/71 | APEX: Malicious | [report](https://www.virustotal.com/gui/file/6031523c16bdfc40630e775cb5ec4f93702809716a93eee136536b7668ed17dc) |
| hello-native.dll | `ab59af13b044a6801ab33c6130e48ddde3de29b25b07aac1320d68802e0f0071` | 1/71 | Cynet: Malicious (score: 100) | [report](https://www.virustotal.com/gui/file/ab59af13b044a6801ab33c6130e48ddde3de29b25b07aac1320d68802e0f0071) |
| hello-tauri-setup.exe | `b639c210fe91f1fabd3ceaa987a88af0525228fbb5c579be1db598f4ef37f99d` | 3/70 | Sophos: Generic ML PUA (PUA); Cylance: Unsafe; APEX: Malicious | [report](https://www.virustotal.com/gui/file/b639c210fe91f1fabd3ceaa987a88af0525228fbb5c579be1db598f4ef37f99d) |
| hello-tauri.exe | `80819e09b4b4065504b5220016977f49b08bec4e07932fb403435905c36f6c78` | 0/50 | None | [report](https://www.virustotal.com/gui/file/80819e09b4b4065504b5220016977f49b08bec4e07932fb403435905c36f6c78) |
| hello-tray.exe | `342fb301e2148c919e8d92f8015cdc24fd5fa703d605d8ca00cbf924f0fe22e3` | 4/71 | Symantec: ML.Attribute.HighConfidence; APEX: Malicious; Microsoft: Trojan:Win32/Wacatac.B!ml; DeepInstinct: MALICIOUS | [report](https://www.virustotal.com/gui/file/342fb301e2148c919e8d92f8015cdc24fd5fa703d605d8ca00cbf924f0fe22e3) |
| hello-txiki-library.exe | `cd45175b56cd4fc71ff1d75ea9c1cf5541f84c180aad1063679f5373342f8a3c` | 4/71 | Bkav: W32.Malware.8364F40E; CrowdStrike: win/malicious_confidence_60% (D); Kingsoft: malware.kb.a.795; Cylance: Unsafe | [report](https://www.virustotal.com/gui/file/cd45175b56cd4fc71ff1d75ea9c1cf5541f84c180aad1063679f5373342f8a3c) |
| hello-txiki.exe | `c9d598c72988df676856e633da1449e0723e4282cb4e57abbb3067a1600df90b` | 3/71 | Bkav: W32.Malware.F6E0652F; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!07C5787DF6A1 | [report](https://www.virustotal.com/gui/file/c9d598c72988df676856e633da1449e0723e4282cb4e57abbb3067a1600df90b) |
| tjs.exe | `384f683fb0333cb53503d18192b7c381062c0d2404d78efb1360e82ccd7537ef` | 1/71 | Bkav: W32.Malware.60C57FAC | [report](https://www.virustotal.com/gui/file/384f683fb0333cb53503d18192b7c381062c0d2404d78efb1360e82ccd7537ef) |

## macOS arm64

Scanned: 2026-11-06T14:26:30.649Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c | `ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120) |
| hello-tauri | `069e4c73758bf9820835661bececcde89f569b6f8474fea1c17d829d0c2094ad` | 0/63 | None | [report](https://www.virustotal.com/gui/file/069e4c73758bf9820835661bececcde89f569b6f8474fea1c17d829d0c2094ad) |
| hello-tauri.dmg | `6e6f04ef182b795fd92629a223b27382755c4d1b135757695c95659d58d3e156` | 0/61 | None | [report](https://www.virustotal.com/gui/file/6e6f04ef182b795fd92629a223b27382755c4d1b135757695c95659d58d3e156) |
| hello-txiki | `eaee96a1ad4d676b86ce49bf481ddd753ae0f790d4fe3ab73778902abebae979` | 0/63 | None | [report](https://www.virustotal.com/gui/file/eaee96a1ad4d676b86ce49bf481ddd753ae0f790d4fe3ab73778902abebae979) |
| hello-txiki-library | `18b624fceedf0523c69b33616435929c27157eb2ee6c9b79d575a2e0fc7d1b39` | 0/63 | None | [report](https://www.virustotal.com/gui/file/18b624fceedf0523c69b33616435929c27157eb2ee6c9b79d575a2e0fc7d1b39) |
| libhello-native.dylib | `ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e) |
| tjs | `dba8f1f4da2fbc692744d48e411ad733ddee9825227f8c2c26d03321199b1708` | 0/62 | None | [report](https://www.virustotal.com/gui/file/dba8f1f4da2fbc692744d48e411ad733ddee9825227f8c2c26d03321199b1708) |

See [PoC source](https://github.com/lukasMega/DeckBridge/tree/main/.github/virustotal-poc).
See [0.17.0 release investigation](./virustotal-v0.17.0.md).
Few detections alone cannot establish safety or malware.
