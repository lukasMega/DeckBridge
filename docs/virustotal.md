---
sidebar_label: VirusTotal comparison
title: VirusTotal PoC comparison
slug: /virustotal
description: Isolated scanner results before DeckBridge release 0.26.3.
---

# VirusTotal PoC comparison

Release candidate: `deckbridge-v0.26.3`.
These isolated samples were scanned before release.
They are not DeckBridge release downloads.
Detection scores can change over time.
Samples uploaded to VirusTotal are public.

## Windows x64

Scanned: 2026-11-24T17:01:27.051Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c.exe | `ec6054dde0809263884fe3d03a566deceb7cb28f6ade3680e631daee8f3bd19d` | 1/70 | APEX: Malicious | [report](https://www.virustotal.com/gui/file/ec6054dde0809263884fe3d03a566deceb7cb28f6ade3680e631daee8f3bd19d) |
| hello-native.dll | `6add1bd2d527c3be69d3764f9301ba3351b3ea27b57382f0b3802a4e2632b25c` | 1/56 | Cynet: Malicious (score: 100) | [report](https://www.virustotal.com/gui/file/6add1bd2d527c3be69d3764f9301ba3351b3ea27b57382f0b3802a4e2632b25c) |
| hello-tauri-setup.exe | `6d0203c2ee051bb7a87258481fa8cd95d2029b9c39d0bedc932b2aa19ea5e978` | 3/60 | APEX: Malicious; Sophos: Generic ML PUA (PUA); Cylance: Unsafe | [report](https://www.virustotal.com/gui/file/6d0203c2ee051bb7a87258481fa8cd95d2029b9c39d0bedc932b2aa19ea5e978) |
| hello-tauri.exe | `8e7ba7af97cdaf63a2dac8004ab77a34a4aaad9dffefc4ced77934ec3c0a5213` | 0/70 | None | [report](https://www.virustotal.com/gui/file/8e7ba7af97cdaf63a2dac8004ab77a34a4aaad9dffefc4ced77934ec3c0a5213) |
| hello-tray.exe | `c1cdc491b2ce5f0771cb70ec82dabcc96d2ae0e118cb0009adb55be81a12910f` | 3/70 | Symantec: ML.Attribute.HighConfidence; DeepInstinct: MALICIOUS; APEX: Malicious | [report](https://www.virustotal.com/gui/file/c1cdc491b2ce5f0771cb70ec82dabcc96d2ae0e118cb0009adb55be81a12910f) |
| hello-txiki-library.exe | `b89077f3f87058760589beb97832f69abe711ce70ef70ee83b6388ec713dce35` | 2/70 | Bkav: W32.Malware.7B4AD25E; CrowdStrike: win/malicious_confidence_60% (D) | [report](https://www.virustotal.com/gui/file/b89077f3f87058760589beb97832f69abe711ce70ef70ee83b6388ec713dce35) |
| hello-txiki.exe | `41f72b3c894bce7cea0ba572cd27469c8cab2ba40b36ed75ae89d8e1fd44b70b` | 3/70 | Bkav: W32.Malware.17D7AA82; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!AD1C6C90FD6B | [report](https://www.virustotal.com/gui/file/41f72b3c894bce7cea0ba572cd27469c8cab2ba40b36ed75ae89d8e1fd44b70b) |
| tjs.exe | `a6d4e25aafcce619b8a48e424c4086cd3f363c8e792a6635691142baa35d2376` | 0/70 | None | [report](https://www.virustotal.com/gui/file/a6d4e25aafcce619b8a48e424c4086cd3f363c8e792a6635691142baa35d2376) |

## macOS arm64

Scanned: 2026-11-24T17:01:27.051Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c | `ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120` | 0/62 | None | [report](https://www.virustotal.com/gui/file/ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120) |
| hello-tauri | `22748f8a2d41f77cc85bcefe0903953a3d3e005677a453d9db71da33c1371c27` | 1/63 | Microsoft: Trojan:Script/Wacatac.B!ml | [report](https://www.virustotal.com/gui/file/22748f8a2d41f77cc85bcefe0903953a3d3e005677a453d9db71da33c1371c27) |
| hello-tauri.dmg | `1b3d21edd73cf037eea5892665c1a2c3732a65251b9cee37ac15937628c43c12` | 0/51 | None | [report](https://www.virustotal.com/gui/file/1b3d21edd73cf037eea5892665c1a2c3732a65251b9cee37ac15937628c43c12) |
| hello-txiki | `c2ea26ff2f556ad0ed2c8434b37f13317be98fe444b82710f72719f4fed1e870` | 0/63 | None | [report](https://www.virustotal.com/gui/file/c2ea26ff2f556ad0ed2c8434b37f13317be98fe444b82710f72719f4fed1e870) |
| hello-txiki-library | `021b70f64534b4816de70ed81c052f9f23afec85402bcd7f8104ed8ec6052e3d` | 0/63 | None | [report](https://www.virustotal.com/gui/file/021b70f64534b4816de70ed81c052f9f23afec85402bcd7f8104ed8ec6052e3d) |
| libhello-native.dylib | `ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e) |
| tjs | `3cfafce692abb5845d26ba3fe9ab494299857c5d396000041bb9341515b517ec` | 0/62 | None | [report](https://www.virustotal.com/gui/file/3cfafce692abb5845d26ba3fe9ab494299857c5d396000041bb9341515b517ec) |

See [PoC source](https://github.com/lukasMega/DeckBridge/tree/main/.github/virustotal-poc).
See [0.17.0 release investigation](./virustotal-v0.17.0.md).
Few detections alone cannot establish safety or malware.
