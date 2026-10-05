---
sidebar_label: VirusTotal comparison
title: VirusTotal PoC comparison
slug: /virustotal
description: Isolated scanner results before DeckBridge release 0.19.0.
---

# VirusTotal PoC comparison

Release candidate: `deckbridge-v0.19.0`.
These isolated samples were scanned before release.
They are not DeckBridge release downloads.
Detection scores can change over time.
Samples uploaded to VirusTotal are public.

## Windows x64

Scanned: 2026-10-05T22:33:12.442Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c.exe | `37c80929590a9d10529812db3c53fefe94baa4ef0e0ff6d2f3071b440486ceba` | 2/71 | Microsoft: Trojan:Win32/Wacatac.B!ml; APEX: Malicious | [report](https://www.virustotal.com/gui/file/37c80929590a9d10529812db3c53fefe94baa4ef0e0ff6d2f3071b440486ceba) |
| hello-native.dll | `781c5ae18b2b094efa44952e56a2643ef10434f6bd1e4bd07c80f5a7341cfccf` | 1/71 | Cynet: Malicious (score: 100) | [report](https://www.virustotal.com/gui/file/781c5ae18b2b094efa44952e56a2643ef10434f6bd1e4bd07c80f5a7341cfccf) |
| hello-tauri-setup.exe | `a6c7600034fcc90cbddc5d40d9e52098c244073ee94ca704ad9b8e69e71bb1ac` | 3/71 | Cylance: Unsafe; APEX: Malicious; Sophos: Generic ML PUA (PUA) | [report](https://www.virustotal.com/gui/file/a6c7600034fcc90cbddc5d40d9e52098c244073ee94ca704ad9b8e69e71bb1ac) |
| hello-tauri.exe | `0d88f76408e4639956b9cc2e35ad72eb63c93379fb6536c17db5ab22e9575dcf` | 0/71 | None | [report](https://www.virustotal.com/gui/file/0d88f76408e4639956b9cc2e35ad72eb63c93379fb6536c17db5ab22e9575dcf) |
| hello-tray.exe | `7667e68154573ae35438a021fe2748d0723349a3f12021a05dec5f0327ed3b03` | 4/71 | Symantec: ML.Attribute.HighConfidence; Microsoft: Trojan:Win32/Wacatac.C!ml; DeepInstinct: MALICIOUS; APEX: Malicious | [report](https://www.virustotal.com/gui/file/7667e68154573ae35438a021fe2748d0723349a3f12021a05dec5f0327ed3b03) |
| hello-txiki-library.exe | `20705fbe0fedabff398f52fb8bd329c0757731b362074774a1b6733a4a85384e` | 5/71 | Bkav: W32.Malware.2BBCCEB3; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!576804BFB6FB; Kingsoft: malware.kb.a.795; Microsoft: Trojan:Win32/Wacatac.B!ml | [report](https://www.virustotal.com/gui/file/20705fbe0fedabff398f52fb8bd329c0757731b362074774a1b6733a4a85384e) |
| hello-txiki.exe | `c9d598c72988df676856e633da1449e0723e4282cb4e57abbb3067a1600df90b` | 4/71 | Bkav: W32.Malware.F6E0652F; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!07C5787DF6A1; TrellixENS: Artemis!07C5787DF6A1 | [report](https://www.virustotal.com/gui/file/c9d598c72988df676856e633da1449e0723e4282cb4e57abbb3067a1600df90b) |
| tjs.exe | `384f683fb0333cb53503d18192b7c381062c0d2404d78efb1360e82ccd7537ef` | 1/71 | Bkav: W32.Malware.60C57FAC | [report](https://www.virustotal.com/gui/file/384f683fb0333cb53503d18192b7c381062c0d2404d78efb1360e82ccd7537ef) |

## macOS arm64

Scanned: 2026-10-05T22:33:12.443Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c | `ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120) |
| hello-tauri | `eb65047a414a453111ee918aa590c0065be751f552f62793813c3ffed52ef56c` | 1/63 | Microsoft: Trojan:Script/Wacatac.B!ml | [report](https://www.virustotal.com/gui/file/eb65047a414a453111ee918aa590c0065be751f552f62793813c3ffed52ef56c) |
| hello-tauri.dmg | `29eed0748915c7ab17aeee769882f21e5f75661dcbdb8871255aa7b80918bf0e` | 1/61 | Microsoft: Trojan:Script/Wacatac.C!ml | [report](https://www.virustotal.com/gui/file/29eed0748915c7ab17aeee769882f21e5f75661dcbdb8871255aa7b80918bf0e) |
| hello-txiki | `eaee96a1ad4d676b86ce49bf481ddd753ae0f790d4fe3ab73778902abebae979` | 0/63 | None | [report](https://www.virustotal.com/gui/file/eaee96a1ad4d676b86ce49bf481ddd753ae0f790d4fe3ab73778902abebae979) |
| hello-txiki-library | `18b624fceedf0523c69b33616435929c27157eb2ee6c9b79d575a2e0fc7d1b39` | 0/63 | None | [report](https://www.virustotal.com/gui/file/18b624fceedf0523c69b33616435929c27157eb2ee6c9b79d575a2e0fc7d1b39) |
| libhello-native.dylib | `ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e) |
| tjs | `dba8f1f4da2fbc692744d48e411ad733ddee9825227f8c2c26d03321199b1708` | 0/63 | None | [report](https://www.virustotal.com/gui/file/dba8f1f4da2fbc692744d48e411ad733ddee9825227f8c2c26d03321199b1708) |

See [PoC source](https://github.com/lukasMega/DeckBridge/tree/main/.github/virustotal-poc).
See [0.17.0 release investigation](./virustotal-v0.17.0.md).
Few detections alone cannot establish safety or malware.
