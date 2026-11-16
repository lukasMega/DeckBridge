---
sidebar_label: VirusTotal comparison
title: VirusTotal PoC comparison
slug: /virustotal
description: Isolated scanner results before DeckBridge release 0.23.0.
---

# VirusTotal PoC comparison

Release candidate: `deckbridge-v0.23.0`.
These isolated samples were scanned before release.
They are not DeckBridge release downloads.
Detection scores can change over time.
Samples uploaded to VirusTotal are public.

## Windows x64

Scanned: 2026-11-16T13:56:36.484Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c.exe | `88bf521abd8b6bc6c11f32de83026ea75d19d39a42ab2f831bb8b63dab32c07c` | 1/71 | APEX: Malicious | [report](https://www.virustotal.com/gui/file/88bf521abd8b6bc6c11f32de83026ea75d19d39a42ab2f831bb8b63dab32c07c) |
| hello-native.dll | `b9c7799758b4af1dc5ed3ed1d55f0c4b31be11c337ca70a97ce8b80ce7abcc9e` | 1/71 | Cynet: Malicious (score: 100) | [report](https://www.virustotal.com/gui/file/b9c7799758b4af1dc5ed3ed1d55f0c4b31be11c337ca70a97ce8b80ce7abcc9e) |
| hello-tauri-setup.exe | `052a8e4b4e9a72bbc3d64f9d4f27c3d4da4fc9c66e96a8a788765514d5229e0e` | 3/71 | APEX: Malicious; Sophos: Generic ML PUA (PUA); Cylance: Unsafe | [report](https://www.virustotal.com/gui/file/052a8e4b4e9a72bbc3d64f9d4f27c3d4da4fc9c66e96a8a788765514d5229e0e) |
| hello-tauri.exe | `30cae10c7618ab407217d365270607a329be42a972ed4a2d4e8aa636d99432bb` | 0/70 | None | [report](https://www.virustotal.com/gui/file/30cae10c7618ab407217d365270607a329be42a972ed4a2d4e8aa636d99432bb) |
| hello-tray.exe | `bb95480252163e0cf5f972cc214bc66cc702f5ab061bd038dbd8348255e197d3` | 3/71 | Symantec: ML.Attribute.HighConfidence; DeepInstinct: MALICIOUS; APEX: Malicious | [report](https://www.virustotal.com/gui/file/bb95480252163e0cf5f972cc214bc66cc702f5ab061bd038dbd8348255e197d3) |
| hello-txiki-library.exe | `070a7a512d2266bda62f57286655411cebe4f1d4072c05f08010a94338ad926a` | 3/70 | Bkav: W32.Malware.124C772; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!6B4B24B5DC06 | [report](https://www.virustotal.com/gui/file/070a7a512d2266bda62f57286655411cebe4f1d4072c05f08010a94338ad926a) |
| hello-txiki.exe | `41f72b3c894bce7cea0ba572cd27469c8cab2ba40b36ed75ae89d8e1fd44b70b` | 4/70 | Bkav: W32.Malware.17D7AA82; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!AD1C6C90FD6B; TrellixENS: Artemis!AD1C6C90FD6B | [report](https://www.virustotal.com/gui/file/41f72b3c894bce7cea0ba572cd27469c8cab2ba40b36ed75ae89d8e1fd44b70b) |
| tjs.exe | `a6d4e25aafcce619b8a48e424c4086cd3f363c8e792a6635691142baa35d2376` | 0/64 | None | [report](https://www.virustotal.com/gui/file/a6d4e25aafcce619b8a48e424c4086cd3f363c8e792a6635691142baa35d2376) |

## macOS arm64

Scanned: 2026-11-16T13:56:36.491Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c | `ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120) |
| hello-tauri | `05014107f6f1054ef41e248809c46c42a9c0fd36b1635a7411765f39f92c441f` | 0/63 | None | [report](https://www.virustotal.com/gui/file/05014107f6f1054ef41e248809c46c42a9c0fd36b1635a7411765f39f92c441f) |
| hello-tauri.dmg | `a2bac0e1a4baf9c4bcd3d65cacf505bd2f23e3568ad1af4cbc9f9e56792748d5` | 0/48 | None | [report](https://www.virustotal.com/gui/file/a2bac0e1a4baf9c4bcd3d65cacf505bd2f23e3568ad1af4cbc9f9e56792748d5) |
| hello-txiki | `c2ea26ff2f556ad0ed2c8434b37f13317be98fe444b82710f72719f4fed1e870` | 0/63 | None | [report](https://www.virustotal.com/gui/file/c2ea26ff2f556ad0ed2c8434b37f13317be98fe444b82710f72719f4fed1e870) |
| hello-txiki-library | `021b70f64534b4816de70ed81c052f9f23afec85402bcd7f8104ed8ec6052e3d` | 0/62 | None | [report](https://www.virustotal.com/gui/file/021b70f64534b4816de70ed81c052f9f23afec85402bcd7f8104ed8ec6052e3d) |
| libhello-native.dylib | `ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e) |
| tjs | `3cfafce692abb5845d26ba3fe9ab494299857c5d396000041bb9341515b517ec` | 0/63 | None | [report](https://www.virustotal.com/gui/file/3cfafce692abb5845d26ba3fe9ab494299857c5d396000041bb9341515b517ec) |

See [PoC source](https://github.com/lukasMega/DeckBridge/tree/main/.github/virustotal-poc).
See [0.17.0 release investigation](./virustotal-v0.17.0.md).
Few detections alone cannot establish safety or malware.
