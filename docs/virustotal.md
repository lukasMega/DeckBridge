---
sidebar_label: VirusTotal comparison
title: VirusTotal PoC comparison
slug: /virustotal
description: Isolated scanner results before DeckBridge release 0.24.2.
---

# VirusTotal PoC comparison

Release candidate: `deckbridge-v0.24.2`.
These isolated samples were scanned before release.
They are not DeckBridge release downloads.
Detection scores can change over time.
Samples uploaded to VirusTotal are public.

## Windows x64

Scanned: 2026-11-21T11:34:22.270Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c.exe | `c6725d1a76cd65c71da2e940aa16f40c1ed1cdbe0f31a7a824e96cf88a03db3c` | 1/69 | APEX: Malicious | [report](https://www.virustotal.com/gui/file/c6725d1a76cd65c71da2e940aa16f40c1ed1cdbe0f31a7a824e96cf88a03db3c) |
| hello-native.dll | `a32878060a3a0f43d1d3f4551284b11ed5dc339b76faa725bff086492d65501b` | 1/71 | Cynet: Malicious (score: 100) | [report](https://www.virustotal.com/gui/file/a32878060a3a0f43d1d3f4551284b11ed5dc339b76faa725bff086492d65501b) |
| hello-tauri-setup.exe | `1b8d8dba70ec8cd99289772cb4fa32afe3cd2cb6f586faa689ab14508c66d3ae` | 2/71 | APEX: Malicious; Cylance: Unsafe | [report](https://www.virustotal.com/gui/file/1b8d8dba70ec8cd99289772cb4fa32afe3cd2cb6f586faa689ab14508c66d3ae) |
| hello-tauri.exe | `28ad1e07f10113d541855c894d43fc11fb2188f919c06c592d93171c15d41812` | 0/71 | None | [report](https://www.virustotal.com/gui/file/28ad1e07f10113d541855c894d43fc11fb2188f919c06c592d93171c15d41812) |
| hello-tray.exe | `04855b3f105aa031e85378f5f14902733d39b046cb9d23cac787257c4dfbb672` | 3/71 | Symantec: ML.Attribute.HighConfidence; APEX: Malicious; DeepInstinct: MALICIOUS | [report](https://www.virustotal.com/gui/file/04855b3f105aa031e85378f5f14902733d39b046cb9d23cac787257c4dfbb672) |
| hello-txiki-library.exe | `3a5c02b7303410836296feaabf0d9462ea91a192eb885705320a3782c575e146` | 3/71 | Bkav: W32.Malware.EF72D729; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!8C9C65503F25 | [report](https://www.virustotal.com/gui/file/3a5c02b7303410836296feaabf0d9462ea91a192eb885705320a3782c575e146) |
| hello-txiki.exe | `41f72b3c894bce7cea0ba572cd27469c8cab2ba40b36ed75ae89d8e1fd44b70b` | 3/70 | Bkav: W32.Malware.17D7AA82; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!AD1C6C90FD6B | [report](https://www.virustotal.com/gui/file/41f72b3c894bce7cea0ba572cd27469c8cab2ba40b36ed75ae89d8e1fd44b70b) |
| tjs.exe | `a6d4e25aafcce619b8a48e424c4086cd3f363c8e792a6635691142baa35d2376` | 0/71 | None | [report](https://www.virustotal.com/gui/file/a6d4e25aafcce619b8a48e424c4086cd3f363c8e792a6635691142baa35d2376) |

## macOS arm64

Scanned: 2026-11-21T11:34:22.272Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c | `ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120` | 0/62 | None | [report](https://www.virustotal.com/gui/file/ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120) |
| hello-tauri | `05014107f6f1054ef41e248809c46c42a9c0fd36b1635a7411765f39f92c441f` | 0/63 | None | [report](https://www.virustotal.com/gui/file/05014107f6f1054ef41e248809c46c42a9c0fd36b1635a7411765f39f92c441f) |
| hello-tauri.dmg | `f1d24ffefa28a3ac7d1ae4632928faa4e3f6cafa4ad4749f873f544793545f4d` | 0/61 | None | [report](https://www.virustotal.com/gui/file/f1d24ffefa28a3ac7d1ae4632928faa4e3f6cafa4ad4749f873f544793545f4d) |
| hello-txiki | `c2ea26ff2f556ad0ed2c8434b37f13317be98fe444b82710f72719f4fed1e870` | 0/63 | None | [report](https://www.virustotal.com/gui/file/c2ea26ff2f556ad0ed2c8434b37f13317be98fe444b82710f72719f4fed1e870) |
| hello-txiki-library | `021b70f64534b4816de70ed81c052f9f23afec85402bcd7f8104ed8ec6052e3d` | 0/62 | None | [report](https://www.virustotal.com/gui/file/021b70f64534b4816de70ed81c052f9f23afec85402bcd7f8104ed8ec6052e3d) |
| libhello-native.dylib | `ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e) |
| tjs | `3cfafce692abb5845d26ba3fe9ab494299857c5d396000041bb9341515b517ec` | 0/63 | None | [report](https://www.virustotal.com/gui/file/3cfafce692abb5845d26ba3fe9ab494299857c5d396000041bb9341515b517ec) |

See [PoC source](https://github.com/lukasMega/DeckBridge/tree/main/.github/virustotal-poc).
See [0.17.0 release investigation](./virustotal-v0.17.0.md).
Few detections alone cannot establish safety or malware.
