---
sidebar_label: VirusTotal comparison
title: VirusTotal PoC comparison
slug: /virustotal
description: Isolated scanner results before DeckBridge release 0.26.5.
---

# VirusTotal PoC comparison

Release candidate: `deckbridge-v0.26.5`.
These isolated samples were scanned before release.
They are not DeckBridge release downloads.
Detection scores can change over time.
Samples uploaded to VirusTotal are public.

## Windows x64

Scanned: 2026-11-27T18:39:50.656Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c.exe | `2102afbac6d3173033d3fe15bd84b62546ca27a645a75a3b2fe4f361a6af5fa9` | 1/68 | APEX: Malicious | [report](https://www.virustotal.com/gui/file/2102afbac6d3173033d3fe15bd84b62546ca27a645a75a3b2fe4f361a6af5fa9) |
| hello-native.dll | `2a19b650b3a7c631cdd805edc706290a88b29578bdbdf546d833541867960303` | 1/68 | Cynet: Malicious (score: 100) | [report](https://www.virustotal.com/gui/file/2a19b650b3a7c631cdd805edc706290a88b29578bdbdf546d833541867960303) |
| hello-tauri-setup.exe | `806b807916eae98de22f839b4c33a4fd7da621e7f7f6dbaf5537f3af86c70403` | 3/67 | APEX: Malicious; Sophos: Generic ML PUA (PUA); Cylance: Unsafe | [report](https://www.virustotal.com/gui/file/806b807916eae98de22f839b4c33a4fd7da621e7f7f6dbaf5537f3af86c70403) |
| hello-tauri.exe | `ae4f1b2ad6a041a0429c9a85849538f0984acc9535054ea24fc5f2c4d97c0042` | 0/68 | None | [report](https://www.virustotal.com/gui/file/ae4f1b2ad6a041a0429c9a85849538f0984acc9535054ea24fc5f2c4d97c0042) |
| hello-tray.exe | `0c831df4b205eb93c6521134d62f643d60d3446b541fa15807a32ce0ebe90eb7` | 3/68 | Symantec: ML.Attribute.HighConfidence; DeepInstinct: MALICIOUS; APEX: Malicious | [report](https://www.virustotal.com/gui/file/0c831df4b205eb93c6521134d62f643d60d3446b541fa15807a32ce0ebe90eb7) |
| hello-txiki-library.exe | `6c7477f42073f18311fc0d7a6ee1d3e48a045d753ddaf1c377aeaeb210afbf58` | 2/68 | Bkav: W32.Malware.C3ECA9D4; CrowdStrike: win/malicious_confidence_60% (D) | [report](https://www.virustotal.com/gui/file/6c7477f42073f18311fc0d7a6ee1d3e48a045d753ddaf1c377aeaeb210afbf58) |
| hello-txiki.exe | `41f72b3c894bce7cea0ba572cd27469c8cab2ba40b36ed75ae89d8e1fd44b70b` | 3/68 | Bkav: W32.Malware.17D7AA82; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!AD1C6C90FD6B | [report](https://www.virustotal.com/gui/file/41f72b3c894bce7cea0ba572cd27469c8cab2ba40b36ed75ae89d8e1fd44b70b) |
| tjs.exe | `a6d4e25aafcce619b8a48e424c4086cd3f363c8e792a6635691142baa35d2376` | 0/67 | None | [report](https://www.virustotal.com/gui/file/a6d4e25aafcce619b8a48e424c4086cd3f363c8e792a6635691142baa35d2376) |

## macOS arm64

Scanned: 2026-11-27T18:39:50.667Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c | `ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120` | 0/62 | None | [report](https://www.virustotal.com/gui/file/ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120) |
| hello-tauri | `22748f8a2d41f77cc85bcefe0903953a3d3e005677a453d9db71da33c1371c27` | 0/62 | None | [report](https://www.virustotal.com/gui/file/22748f8a2d41f77cc85bcefe0903953a3d3e005677a453d9db71da33c1371c27) |
| hello-tauri.dmg | `65525268c19da85c84a9783717488f7e918d962781f70a966adbb695d134b383` | 0/61 | None | [report](https://www.virustotal.com/gui/file/65525268c19da85c84a9783717488f7e918d962781f70a966adbb695d134b383) |
| hello-txiki | `c2ea26ff2f556ad0ed2c8434b37f13317be98fe444b82710f72719f4fed1e870` | 0/63 | None | [report](https://www.virustotal.com/gui/file/c2ea26ff2f556ad0ed2c8434b37f13317be98fe444b82710f72719f4fed1e870) |
| hello-txiki-library | `021b70f64534b4816de70ed81c052f9f23afec85402bcd7f8104ed8ec6052e3d` | 0/63 | None | [report](https://www.virustotal.com/gui/file/021b70f64534b4816de70ed81c052f9f23afec85402bcd7f8104ed8ec6052e3d) |
| libhello-native.dylib | `ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e) |
| tjs | `3cfafce692abb5845d26ba3fe9ab494299857c5d396000041bb9341515b517ec` | 0/63 | None | [report](https://www.virustotal.com/gui/file/3cfafce692abb5845d26ba3fe9ab494299857c5d396000041bb9341515b517ec) |

See [PoC source](https://github.com/lukasMega/DeckBridge/tree/main/.github/virustotal-poc).
See [0.17.0 release investigation](./virustotal-v0.17.0.md).
Few detections alone cannot establish safety or malware.
