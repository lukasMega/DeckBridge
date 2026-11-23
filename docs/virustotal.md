---
sidebar_label: VirusTotal comparison
title: VirusTotal PoC comparison
slug: /virustotal
description: Isolated scanner results before DeckBridge release 0.25.0.
---

# VirusTotal PoC comparison

Release candidate: `deckbridge-v0.25.0`.
These isolated samples were scanned before release.
They are not DeckBridge release downloads.
Detection scores can change over time.
Samples uploaded to VirusTotal are public.

## Windows x64

Scanned: 2026-11-23T22:55:45.953Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c.exe | `147ec0e773ecd65108a7f57cdb1db58786fceb2e79493a824ae49546a13e13c4` | 1/70 | APEX: Malicious | [report](https://www.virustotal.com/gui/file/147ec0e773ecd65108a7f57cdb1db58786fceb2e79493a824ae49546a13e13c4) |
| hello-native.dll | `8e5010ff7d9349f2e823a0dd637dd412ee29012d4c40dc427c813e5df286a56a` | 2/69 | Cynet: Malicious (score: 100); AhnLab-V3: Trojan/Win.Generic.C5980531 | [report](https://www.virustotal.com/gui/file/8e5010ff7d9349f2e823a0dd637dd412ee29012d4c40dc427c813e5df286a56a) |
| hello-tauri-setup.exe | `cd63f2abb85b46f99e60b2f180e948522a0f3903952a95889213d37924abe2a2` | 3/70 | APEX: Malicious; Sophos: Generic ML PUA (PUA); Cylance: Unsafe | [report](https://www.virustotal.com/gui/file/cd63f2abb85b46f99e60b2f180e948522a0f3903952a95889213d37924abe2a2) |
| hello-tauri.exe | `171cecf319ead538c197a48f586b1678455b54112c9388c8e2ebb25d66613e6d` | 0/70 | None | [report](https://www.virustotal.com/gui/file/171cecf319ead538c197a48f586b1678455b54112c9388c8e2ebb25d66613e6d) |
| hello-tray.exe | `31b6effe041a4d761f02bfee20654a969c0fd0dba82cb72275f836d6d994905b` | 2/43 | Symantec: ML.Attribute.HighConfidence; APEX: Malicious | [report](https://www.virustotal.com/gui/file/31b6effe041a4d761f02bfee20654a969c0fd0dba82cb72275f836d6d994905b) |
| hello-txiki-library.exe | `41b5edb6d7305a620ce18a067258424abe3855eeca447bc5680a8f40ce9a8671` | 3/70 | Bkav: W32.Malware.569E13E1; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!CAAA1A249EA8 | [report](https://www.virustotal.com/gui/file/41b5edb6d7305a620ce18a067258424abe3855eeca447bc5680a8f40ce9a8671) |
| hello-txiki.exe | `41f72b3c894bce7cea0ba572cd27469c8cab2ba40b36ed75ae89d8e1fd44b70b` | 3/70 | Bkav: W32.Malware.17D7AA82; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!AD1C6C90FD6B | [report](https://www.virustotal.com/gui/file/41f72b3c894bce7cea0ba572cd27469c8cab2ba40b36ed75ae89d8e1fd44b70b) |
| tjs.exe | `a6d4e25aafcce619b8a48e424c4086cd3f363c8e792a6635691142baa35d2376` | 0/70 | None | [report](https://www.virustotal.com/gui/file/a6d4e25aafcce619b8a48e424c4086cd3f363c8e792a6635691142baa35d2376) |

## macOS arm64

Scanned: 2026-11-23T22:55:45.954Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c | `ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120) |
| hello-tauri | `05014107f6f1054ef41e248809c46c42a9c0fd36b1635a7411765f39f92c441f` | 0/63 | None | [report](https://www.virustotal.com/gui/file/05014107f6f1054ef41e248809c46c42a9c0fd36b1635a7411765f39f92c441f) |
| hello-tauri.dmg | `bee558082e6254f60fbc47cab5c6a2a507299620889f1ad530b46771f2c854ba` | 0/61 | None | [report](https://www.virustotal.com/gui/file/bee558082e6254f60fbc47cab5c6a2a507299620889f1ad530b46771f2c854ba) |
| hello-txiki | `c2ea26ff2f556ad0ed2c8434b37f13317be98fe444b82710f72719f4fed1e870` | 0/63 | None | [report](https://www.virustotal.com/gui/file/c2ea26ff2f556ad0ed2c8434b37f13317be98fe444b82710f72719f4fed1e870) |
| hello-txiki-library | `021b70f64534b4816de70ed81c052f9f23afec85402bcd7f8104ed8ec6052e3d` | 0/63 | None | [report](https://www.virustotal.com/gui/file/021b70f64534b4816de70ed81c052f9f23afec85402bcd7f8104ed8ec6052e3d) |
| libhello-native.dylib | `ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e) |
| tjs | `3cfafce692abb5845d26ba3fe9ab494299857c5d396000041bb9341515b517ec` | 0/63 | None | [report](https://www.virustotal.com/gui/file/3cfafce692abb5845d26ba3fe9ab494299857c5d396000041bb9341515b517ec) |

See [PoC source](https://github.com/lukasMega/DeckBridge/tree/main/.github/virustotal-poc).
See [0.17.0 release investigation](./virustotal-v0.17.0.md).
Few detections alone cannot establish safety or malware.
