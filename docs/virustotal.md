---
sidebar_label: VirusTotal comparison
title: VirusTotal PoC comparison
slug: /virustotal
description: Isolated scanner results before DeckBridge release 0.26.2.
---

# VirusTotal PoC comparison

Release candidate: `deckbridge-v0.26.2`.
These isolated samples were scanned before release.
They are not DeckBridge release downloads.
Detection scores can change over time.
Samples uploaded to VirusTotal are public.

## Windows x64

Scanned: 2026-11-24T15:07:03.524Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c.exe | `31865fbd6e856bc9276574d88eb437c6cb8c081ee67126f3254fa43184d07495` | 1/70 | APEX: Malicious | [report](https://www.virustotal.com/gui/file/31865fbd6e856bc9276574d88eb437c6cb8c081ee67126f3254fa43184d07495) |
| hello-native.dll | `2e0e27547e675d52821bb169e964dcbdd5d331320fa207aab5e56760c0b12c90` | 1/70 | Cynet: Malicious (score: 100) | [report](https://www.virustotal.com/gui/file/2e0e27547e675d52821bb169e964dcbdd5d331320fa207aab5e56760c0b12c90) |
| hello-tauri-setup.exe | `6c9ef3d4269766dd2b65e812a47e60d2f5c23d935f230729301ec4eac4493310` | 3/70 | Sophos: Generic ML PUA (PUA); Cylance: Unsafe; APEX: Malicious | [report](https://www.virustotal.com/gui/file/6c9ef3d4269766dd2b65e812a47e60d2f5c23d935f230729301ec4eac4493310) |
| hello-tauri.exe | `8db8a454c78afc27f08af8c6000bbc4364a01da5be2080a706288925b811ec3b` | 0/70 | None | [report](https://www.virustotal.com/gui/file/8db8a454c78afc27f08af8c6000bbc4364a01da5be2080a706288925b811ec3b) |
| hello-tray.exe | `26a14c3434bdc66efbfb8cd6221d201ea4cb90d6786ef4cadd66f24bf0f58817` | 3/70 | Symantec: ML.Attribute.HighConfidence; DeepInstinct: MALICIOUS; APEX: Malicious | [report](https://www.virustotal.com/gui/file/26a14c3434bdc66efbfb8cd6221d201ea4cb90d6786ef4cadd66f24bf0f58817) |
| hello-txiki-library.exe | `7abccf61780b504199e36bf48e672783aa699fcf39ce5680242c2341f2c505c5` | 2/70 | Bkav: W32.Malware.9CB078AB; CrowdStrike: win/malicious_confidence_60% (D) | [report](https://www.virustotal.com/gui/file/7abccf61780b504199e36bf48e672783aa699fcf39ce5680242c2341f2c505c5) |
| hello-txiki.exe | `41f72b3c894bce7cea0ba572cd27469c8cab2ba40b36ed75ae89d8e1fd44b70b` | 3/70 | Bkav: W32.Malware.17D7AA82; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!AD1C6C90FD6B | [report](https://www.virustotal.com/gui/file/41f72b3c894bce7cea0ba572cd27469c8cab2ba40b36ed75ae89d8e1fd44b70b) |
| tjs.exe | `a6d4e25aafcce619b8a48e424c4086cd3f363c8e792a6635691142baa35d2376` | 0/70 | None | [report](https://www.virustotal.com/gui/file/a6d4e25aafcce619b8a48e424c4086cd3f363c8e792a6635691142baa35d2376) |

## macOS arm64

Scanned: 2026-11-24T15:07:03.530Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c | `ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120` | 0/62 | None | [report](https://www.virustotal.com/gui/file/ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120) |
| hello-tauri | `22748f8a2d41f77cc85bcefe0903953a3d3e005677a453d9db71da33c1371c27` | 0/62 | None | [report](https://www.virustotal.com/gui/file/22748f8a2d41f77cc85bcefe0903953a3d3e005677a453d9db71da33c1371c27) |
| hello-tauri.dmg | `9a5647c003df270cb3d516d7d610dd944ffd47217cd86fc361fde1fcc0715839` | 0/61 | None | [report](https://www.virustotal.com/gui/file/9a5647c003df270cb3d516d7d610dd944ffd47217cd86fc361fde1fcc0715839) |
| hello-txiki | `c2ea26ff2f556ad0ed2c8434b37f13317be98fe444b82710f72719f4fed1e870` | 0/63 | None | [report](https://www.virustotal.com/gui/file/c2ea26ff2f556ad0ed2c8434b37f13317be98fe444b82710f72719f4fed1e870) |
| hello-txiki-library | `021b70f64534b4816de70ed81c052f9f23afec85402bcd7f8104ed8ec6052e3d` | 0/63 | None | [report](https://www.virustotal.com/gui/file/021b70f64534b4816de70ed81c052f9f23afec85402bcd7f8104ed8ec6052e3d) |
| libhello-native.dylib | `ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e` | 0/62 | None | [report](https://www.virustotal.com/gui/file/ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e) |
| tjs | `3cfafce692abb5845d26ba3fe9ab494299857c5d396000041bb9341515b517ec` | 0/63 | None | [report](https://www.virustotal.com/gui/file/3cfafce692abb5845d26ba3fe9ab494299857c5d396000041bb9341515b517ec) |

See [PoC source](https://github.com/lukasMega/DeckBridge/tree/main/.github/virustotal-poc).
See [0.17.0 release investigation](./virustotal-v0.17.0.md).
Few detections alone cannot establish safety or malware.
