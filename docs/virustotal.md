---
sidebar_label: VirusTotal comparison
title: VirusTotal PoC comparison
slug: /virustotal
description: Isolated scanner results before DeckBridge release 0.26.0.
---

# VirusTotal PoC comparison

Release candidate: `deckbridge-v0.26.0`.
These isolated samples were scanned before release.
They are not DeckBridge release downloads.
Detection scores can change over time.
Samples uploaded to VirusTotal are public.

## Windows x64

Scanned: 2026-11-24T12:59:44.171Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c.exe | `256eb01373600c81a3532d4a5d01dfbc956264f4b2f287fd46814fef95078039` | 1/70 | APEX: Malicious | [report](https://www.virustotal.com/gui/file/256eb01373600c81a3532d4a5d01dfbc956264f4b2f287fd46814fef95078039) |
| hello-native.dll | `cbfc75d42f4039815a2bbbd78ae1923deb04be858baf8aea0b99c1d6e4c8c406` | 2/70 | Cynet: Malicious (score: 100); AhnLab-V3: Trojan/Win.Generic.C5980531 | [report](https://www.virustotal.com/gui/file/cbfc75d42f4039815a2bbbd78ae1923deb04be858baf8aea0b99c1d6e4c8c406) |
| hello-tauri-setup.exe | `393aeb06086b3aaa934525b4692685f8aadb676e1461ed6ce58f2603e4484a24` | 3/70 | APEX: Malicious; Sophos: Generic ML PUA (PUA); Cylance: Unsafe | [report](https://www.virustotal.com/gui/file/393aeb06086b3aaa934525b4692685f8aadb676e1461ed6ce58f2603e4484a24) |
| hello-tauri.exe | `c48c8ae5e5be046a5f39c67b7fe66fc5437fbd7a00ca78560582b33c66487606` | 0/70 | None | [report](https://www.virustotal.com/gui/file/c48c8ae5e5be046a5f39c67b7fe66fc5437fbd7a00ca78560582b33c66487606) |
| hello-tray.exe | `6865b299209afb68eae774dea02af38224fee230af9d6a5ce4312913908c6ebc` | 3/70 | Symantec: ML.Attribute.HighConfidence; APEX: Malicious; DeepInstinct: MALICIOUS | [report](https://www.virustotal.com/gui/file/6865b299209afb68eae774dea02af38224fee230af9d6a5ce4312913908c6ebc) |
| hello-txiki-library.exe | `5c8cfa5ccc3cb9e309f16efa788ec99f3a783b7d057181a906245a09f7b2a38a` | 2/70 | Bkav: W32.Malware.43899554; CrowdStrike: win/malicious_confidence_60% (D) | [report](https://www.virustotal.com/gui/file/5c8cfa5ccc3cb9e309f16efa788ec99f3a783b7d057181a906245a09f7b2a38a) |
| hello-txiki.exe | `41f72b3c894bce7cea0ba572cd27469c8cab2ba40b36ed75ae89d8e1fd44b70b` | 3/70 | Bkav: W32.Malware.17D7AA82; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!AD1C6C90FD6B | [report](https://www.virustotal.com/gui/file/41f72b3c894bce7cea0ba572cd27469c8cab2ba40b36ed75ae89d8e1fd44b70b) |
| tjs.exe | `a6d4e25aafcce619b8a48e424c4086cd3f363c8e792a6635691142baa35d2376` | 0/70 | None | [report](https://www.virustotal.com/gui/file/a6d4e25aafcce619b8a48e424c4086cd3f363c8e792a6635691142baa35d2376) |

## macOS arm64

Scanned: 2026-11-24T12:59:44.173Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c | `ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120) |
| hello-tauri | `22748f8a2d41f77cc85bcefe0903953a3d3e005677a453d9db71da33c1371c27` | 0/60 | None | [report](https://www.virustotal.com/gui/file/22748f8a2d41f77cc85bcefe0903953a3d3e005677a453d9db71da33c1371c27) |
| hello-tauri.dmg | `387f9fd4ae5e35d94a1973f396bb47519ccf00e4cfd3353566b52853007b669f` | 0/60 | None | [report](https://www.virustotal.com/gui/file/387f9fd4ae5e35d94a1973f396bb47519ccf00e4cfd3353566b52853007b669f) |
| hello-txiki | `c2ea26ff2f556ad0ed2c8434b37f13317be98fe444b82710f72719f4fed1e870` | 0/63 | None | [report](https://www.virustotal.com/gui/file/c2ea26ff2f556ad0ed2c8434b37f13317be98fe444b82710f72719f4fed1e870) |
| hello-txiki-library | `021b70f64534b4816de70ed81c052f9f23afec85402bcd7f8104ed8ec6052e3d` | 0/63 | None | [report](https://www.virustotal.com/gui/file/021b70f64534b4816de70ed81c052f9f23afec85402bcd7f8104ed8ec6052e3d) |
| libhello-native.dylib | `ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e) |
| tjs | `3cfafce692abb5845d26ba3fe9ab494299857c5d396000041bb9341515b517ec` | 0/62 | None | [report](https://www.virustotal.com/gui/file/3cfafce692abb5845d26ba3fe9ab494299857c5d396000041bb9341515b517ec) |

See [PoC source](https://github.com/lukasMega/DeckBridge/tree/main/.github/virustotal-poc).
See [0.17.0 release investigation](./virustotal-v0.17.0.md).
Few detections alone cannot establish safety or malware.
