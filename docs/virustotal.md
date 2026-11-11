---
sidebar_label: VirusTotal comparison
title: VirusTotal PoC comparison
slug: /virustotal
description: Isolated scanner results before DeckBridge release 0.22.0.
---

# VirusTotal PoC comparison

Release candidate: `deckbridge-v0.22.0`.
These isolated samples were scanned before release.
They are not DeckBridge release downloads.
Detection scores can change over time.
Samples uploaded to VirusTotal are public.

## Windows x64

Scanned: 2026-11-11T23:35:40.033Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c.exe | `65bb3cc8f0277e895ce2a14a671d0cf7cb0d89646d6a2cfed21da884eff0e513` | 1/71 | APEX: Malicious | [report](https://www.virustotal.com/gui/file/65bb3cc8f0277e895ce2a14a671d0cf7cb0d89646d6a2cfed21da884eff0e513) |
| hello-native.dll | `abf281185b55506d278ef1c94df351e13b6548dd763e64dd85faea8e2a946975` | 1/70 | Cynet: Malicious (score: 100) | [report](https://www.virustotal.com/gui/file/abf281185b55506d278ef1c94df351e13b6548dd763e64dd85faea8e2a946975) |
| hello-tauri-setup.exe | `6d43b91db0cd8078c7d80851eb6063d74aa69f99db42a56a923cc526b74e970a` | 2/71 | Cylance: Unsafe; APEX: Malicious | [report](https://www.virustotal.com/gui/file/6d43b91db0cd8078c7d80851eb6063d74aa69f99db42a56a923cc526b74e970a) |
| hello-tauri.exe | `d20aad2d163d78188394abe75fd2da0aa1ea00239502d191d3dbbbb375978950` | 0/71 | None | [report](https://www.virustotal.com/gui/file/d20aad2d163d78188394abe75fd2da0aa1ea00239502d191d3dbbbb375978950) |
| hello-tray.exe | `61e4f5a0a602b4509b4c4f079f6e6c39c6b084558932b32217d6c27ca3778ce4` | 3/71 | Symantec: ML.Attribute.HighConfidence; DeepInstinct: MALICIOUS; APEX: Malicious | [report](https://www.virustotal.com/gui/file/61e4f5a0a602b4509b4c4f079f6e6c39c6b084558932b32217d6c27ca3778ce4) |
| hello-txiki-library.exe | `2d93549b32e945ebd84dd4f6c11122044d78fe6688934d56e1c200e6445d3ca5` | 3/70 | Bkav: W32.Malware.9C2C960A; CrowdStrike: win/malicious_confidence_60% (D); Kingsoft: malware.kb.a.795 | [report](https://www.virustotal.com/gui/file/2d93549b32e945ebd84dd4f6c11122044d78fe6688934d56e1c200e6445d3ca5) |
| hello-txiki.exe | `c9d598c72988df676856e633da1449e0723e4282cb4e57abbb3067a1600df90b` | 3/71 | Bkav: W32.Malware.F6E0652F; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!07C5787DF6A1 | [report](https://www.virustotal.com/gui/file/c9d598c72988df676856e633da1449e0723e4282cb4e57abbb3067a1600df90b) |
| tjs.exe | `384f683fb0333cb53503d18192b7c381062c0d2404d78efb1360e82ccd7537ef` | 1/71 | Bkav: W32.Malware.60C57FAC | [report](https://www.virustotal.com/gui/file/384f683fb0333cb53503d18192b7c381062c0d2404d78efb1360e82ccd7537ef) |

## macOS arm64

Scanned: 2026-11-11T23:35:40.040Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c | `ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120) |
| hello-tauri | `069e4c73758bf9820835661bececcde89f569b6f8474fea1c17d829d0c2094ad` | 0/62 | None | [report](https://www.virustotal.com/gui/file/069e4c73758bf9820835661bececcde89f569b6f8474fea1c17d829d0c2094ad) |
| hello-tauri.dmg | `af1bad11d9edb2a861a91d2cf1ab29db1376bbaf850731104681bbf55d494369` | 1/61 | Microsoft: Trojan:Script/Wacatac.B!ml | [report](https://www.virustotal.com/gui/file/af1bad11d9edb2a861a91d2cf1ab29db1376bbaf850731104681bbf55d494369) |
| hello-txiki | `eaee96a1ad4d676b86ce49bf481ddd753ae0f790d4fe3ab73778902abebae979` | 0/63 | None | [report](https://www.virustotal.com/gui/file/eaee96a1ad4d676b86ce49bf481ddd753ae0f790d4fe3ab73778902abebae979) |
| hello-txiki-library | `18b624fceedf0523c69b33616435929c27157eb2ee6c9b79d575a2e0fc7d1b39` | 0/62 | None | [report](https://www.virustotal.com/gui/file/18b624fceedf0523c69b33616435929c27157eb2ee6c9b79d575a2e0fc7d1b39) |
| libhello-native.dylib | `ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e` | 0/61 | None | [report](https://www.virustotal.com/gui/file/ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e) |
| tjs | `dba8f1f4da2fbc692744d48e411ad733ddee9825227f8c2c26d03321199b1708` | 0/63 | None | [report](https://www.virustotal.com/gui/file/dba8f1f4da2fbc692744d48e411ad733ddee9825227f8c2c26d03321199b1708) |

See [PoC source](https://github.com/lukasMega/DeckBridge/tree/main/.github/virustotal-poc).
See [0.17.0 release investigation](./virustotal-v0.17.0.md).
Few detections alone cannot establish safety or malware.
