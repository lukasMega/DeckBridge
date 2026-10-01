---
sidebar_label: VirusTotal comparison
title: VirusTotal PoC comparison
slug: /virustotal
description: Isolated scanner results before DeckBridge release 0.18.0.
---

# VirusTotal PoC comparison

Release candidate: `deckbridge-v0.18.0`.
These isolated samples were scanned before release.
They are not DeckBridge release downloads.
Detection scores can change over time.
Samples uploaded to VirusTotal are public.

## Windows x64

Scanned: 2026-10-01T15:17:42.731Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c.exe | `34fe888fdcf877dafe635794f0560fb9ba69983bba652c245f0cd700fd4f9bfd` | 2/70 | Microsoft: Trojan:Win32/Wacatac.B!ml; APEX: Malicious | [report](https://www.virustotal.com/gui/file/34fe888fdcf877dafe635794f0560fb9ba69983bba652c245f0cd700fd4f9bfd) |
| hello-native.dll | `8d7c3178d7624682fd3795e6e199d40b6d4b02866ce2dd22e3c9c9a7463574e5` | 2/70 | Microsoft: Trojan:Win32/Wacatac.B!ml; Cynet: Malicious (score: 100) | [report](https://www.virustotal.com/gui/file/8d7c3178d7624682fd3795e6e199d40b6d4b02866ce2dd22e3c9c9a7463574e5) |
| hello-tauri-setup.exe | `d09f2577b67716df4e13b3ce180b423625bb58a67a4ed00ecebe850a6dfd2347` | 4/71 | Cylance: Unsafe; APEX: Malicious; Sophos: Generic ML PUA (PUA); Microsoft: Trojan:Win32/Wacatac.C!ml | [report](https://www.virustotal.com/gui/file/d09f2577b67716df4e13b3ce180b423625bb58a67a4ed00ecebe850a6dfd2347) |
| hello-tauri.exe | `777af3422addfb1396f45cd3997d724ee33ba6f0fefd7aa86c61180193eb5adb` | 1/71 | Microsoft: Trojan:Win32/Wacatac.C!ml | [report](https://www.virustotal.com/gui/file/777af3422addfb1396f45cd3997d724ee33ba6f0fefd7aa86c61180193eb5adb) |
| hello-tray.exe | `a0529c6de0c775bd0d387280790a81b7b9d9bcc973623ba52795c8032b3966da` | 4/71 | Symantec: ML.Attribute.HighConfidence; Microsoft: Trojan:Win32/Wacatac.C!ml; DeepInstinct: MALICIOUS; APEX: Malicious | [report](https://www.virustotal.com/gui/file/a0529c6de0c775bd0d387280790a81b7b9d9bcc973623ba52795c8032b3966da) |
| hello-txiki-library.exe | `6363a0fe45cf0981dda8619b0b458a313febd31f8d089c79ba6efba06fcae269` | 5/71 | Bkav: W32.Malware.5B4AE95E; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!226DF35CFD40; Kingsoft: malware.kb.a.795; Microsoft: Trojan:Win32/Wacatac.B!ml | [report](https://www.virustotal.com/gui/file/6363a0fe45cf0981dda8619b0b458a313febd31f8d089c79ba6efba06fcae269) |
| hello-txiki.exe | `c9d598c72988df676856e633da1449e0723e4282cb4e57abbb3067a1600df90b` | 4/71 | Bkav: W32.Malware.F6E0652F; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!07C5787DF6A1; TrellixENS: Artemis!07C5787DF6A1 | [report](https://www.virustotal.com/gui/file/c9d598c72988df676856e633da1449e0723e4282cb4e57abbb3067a1600df90b) |
| tjs.exe | `384f683fb0333cb53503d18192b7c381062c0d2404d78efb1360e82ccd7537ef` | 1/71 | Bkav: W32.Malware.60C57FAC | [report](https://www.virustotal.com/gui/file/384f683fb0333cb53503d18192b7c381062c0d2404d78efb1360e82ccd7537ef) |

## macOS arm64

Scanned: 2026-10-01T15:17:42.732Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c | `ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120) |
| hello-tauri | `eb65047a414a453111ee918aa590c0065be751f552f62793813c3ffed52ef56c` | 1/63 | Microsoft: Trojan:Script/Wacatac.C!ml | [report](https://www.virustotal.com/gui/file/eb65047a414a453111ee918aa590c0065be751f552f62793813c3ffed52ef56c) |
| hello-tauri.dmg | `3c90d6800bfe52ce32f1fc1e4c0a2cf5d390e61ea781639ff7501ef44d66c1d5` | 0/61 | None | [report](https://www.virustotal.com/gui/file/3c90d6800bfe52ce32f1fc1e4c0a2cf5d390e61ea781639ff7501ef44d66c1d5) |
| hello-txiki | `eaee96a1ad4d676b86ce49bf481ddd753ae0f790d4fe3ab73778902abebae979` | 0/50 | None | [report](https://www.virustotal.com/gui/file/eaee96a1ad4d676b86ce49bf481ddd753ae0f790d4fe3ab73778902abebae979) |
| hello-txiki-library | `18b624fceedf0523c69b33616435929c27157eb2ee6c9b79d575a2e0fc7d1b39` | 0/63 | None | [report](https://www.virustotal.com/gui/file/18b624fceedf0523c69b33616435929c27157eb2ee6c9b79d575a2e0fc7d1b39) |
| libhello-native.dylib | `ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e) |
| tjs | `dba8f1f4da2fbc692744d48e411ad733ddee9825227f8c2c26d03321199b1708` | 0/63 | None | [report](https://www.virustotal.com/gui/file/dba8f1f4da2fbc692744d48e411ad733ddee9825227f8c2c26d03321199b1708) |

See [PoC source](https://github.com/lukasMega/DeckBridge/tree/main/.github/virustotal-poc).
See [0.17.0 release investigation](./virustotal-v0.17.0.md).
Few detections alone cannot establish safety or malware.
