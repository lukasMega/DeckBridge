---
sidebar_label: VirusTotal comparison
title: VirusTotal PoC comparison
slug: /virustotal
description: Isolated scanner results before DeckBridge release 0.24.1.
---

# VirusTotal PoC comparison

Release candidate: `deckbridge-v0.24.1`.
These isolated samples were scanned before release.
They are not DeckBridge release downloads.
Detection scores can change over time.
Samples uploaded to VirusTotal are public.

## Windows x64

Scanned: 2026-11-20T13:06:23.141Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c.exe | `e4ad95571a4ab04e237fbebf672f9d8a541e2ad63281bdb664c241aa6bea15cb` | 1/71 | APEX: Malicious | [report](https://www.virustotal.com/gui/file/e4ad95571a4ab04e237fbebf672f9d8a541e2ad63281bdb664c241aa6bea15cb) |
| hello-native.dll | `29c72a46033ef4d248416f4844a64162b44d8eeb10af25ae7aa1f9597f113ec1` | 1/71 | Cynet: Malicious (score: 100) | [report](https://www.virustotal.com/gui/file/29c72a46033ef4d248416f4844a64162b44d8eeb10af25ae7aa1f9597f113ec1) |
| hello-tauri-setup.exe | `d2f16ef50bf4806be33b8e91b000041ad64a540e01216d5fe8b2d358cc44b49b` | 3/71 | APEX: Malicious; Sophos: Generic ML PUA (PUA); Cylance: Unsafe | [report](https://www.virustotal.com/gui/file/d2f16ef50bf4806be33b8e91b000041ad64a540e01216d5fe8b2d358cc44b49b) |
| hello-tauri.exe | `3330a0fc95ce0c53fa9d854e002ad1f95a60edc42886b427b01a4fe89f861df6` | 0/71 | None | [report](https://www.virustotal.com/gui/file/3330a0fc95ce0c53fa9d854e002ad1f95a60edc42886b427b01a4fe89f861df6) |
| hello-tray.exe | `8c51bade6d3196e7f423919bca3b0f2ab235ca1a9ac8ccfcf1b08bf12e05c722` | 3/71 | Symantec: ML.Attribute.HighConfidence; DeepInstinct: MALICIOUS; APEX: Malicious | [report](https://www.virustotal.com/gui/file/8c51bade6d3196e7f423919bca3b0f2ab235ca1a9ac8ccfcf1b08bf12e05c722) |
| hello-txiki-library.exe | `31a38c49e8b2bd9380470085d53fc4f90d35d499603da40ef35a5b5230ac485a` | 2/71 | Bkav: W32.Malware.5C9C6A1E; CrowdStrike: win/malicious_confidence_60% (D) | [report](https://www.virustotal.com/gui/file/31a38c49e8b2bd9380470085d53fc4f90d35d499603da40ef35a5b5230ac485a) |
| hello-txiki.exe | `41f72b3c894bce7cea0ba572cd27469c8cab2ba40b36ed75ae89d8e1fd44b70b` | 3/70 | Bkav: W32.Malware.17D7AA82; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!AD1C6C90FD6B | [report](https://www.virustotal.com/gui/file/41f72b3c894bce7cea0ba572cd27469c8cab2ba40b36ed75ae89d8e1fd44b70b) |
| tjs.exe | `a6d4e25aafcce619b8a48e424c4086cd3f363c8e792a6635691142baa35d2376` | 0/71 | None | [report](https://www.virustotal.com/gui/file/a6d4e25aafcce619b8a48e424c4086cd3f363c8e792a6635691142baa35d2376) |

## macOS arm64

Scanned: 2026-11-20T13:06:23.146Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c | `ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120) |
| hello-tauri | `05014107f6f1054ef41e248809c46c42a9c0fd36b1635a7411765f39f92c441f` | 0/62 | None | [report](https://www.virustotal.com/gui/file/05014107f6f1054ef41e248809c46c42a9c0fd36b1635a7411765f39f92c441f) |
| hello-tauri.dmg | `72f6da0ee44d5389f93087b2d4cb45ce0565bc04a7401a5bb96db4d2017d774b` | 0/61 | None | [report](https://www.virustotal.com/gui/file/72f6da0ee44d5389f93087b2d4cb45ce0565bc04a7401a5bb96db4d2017d774b) |
| hello-txiki | `c2ea26ff2f556ad0ed2c8434b37f13317be98fe444b82710f72719f4fed1e870` | 0/62 | None | [report](https://www.virustotal.com/gui/file/c2ea26ff2f556ad0ed2c8434b37f13317be98fe444b82710f72719f4fed1e870) |
| hello-txiki-library | `021b70f64534b4816de70ed81c052f9f23afec85402bcd7f8104ed8ec6052e3d` | 0/62 | None | [report](https://www.virustotal.com/gui/file/021b70f64534b4816de70ed81c052f9f23afec85402bcd7f8104ed8ec6052e3d) |
| libhello-native.dylib | `ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e) |
| tjs | `3cfafce692abb5845d26ba3fe9ab494299857c5d396000041bb9341515b517ec` | 0/63 | None | [report](https://www.virustotal.com/gui/file/3cfafce692abb5845d26ba3fe9ab494299857c5d396000041bb9341515b517ec) |

See [PoC source](https://github.com/lukasMega/DeckBridge/tree/main/.github/virustotal-poc).
See [0.17.0 release investigation](./virustotal-v0.17.0.md).
Few detections alone cannot establish safety or malware.
