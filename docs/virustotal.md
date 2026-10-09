---
sidebar_label: VirusTotal comparison
title: VirusTotal PoC comparison
slug: /virustotal
description: Isolated scanner results before DeckBridge release 0.20.1.
---

# VirusTotal PoC comparison

Release candidate: `deckbridge-v0.20.1`.
These isolated samples were scanned before release.
They are not DeckBridge release downloads.
Detection scores can change over time.
Samples uploaded to VirusTotal are public.

## Windows x64

Scanned: 2026-10-09T15:35:46.241Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c.exe | `e5a202974ee7b401bfe1173f14e0edb2504f92c7fd50bf3b516b88ffebef1bba` | 1/69 | APEX: Malicious | [report](https://www.virustotal.com/gui/file/e5a202974ee7b401bfe1173f14e0edb2504f92c7fd50bf3b516b88ffebef1bba) |
| hello-native.dll | `adccfc3656e977fcee1e339dcd24b0daaeae3d7df53ebff291b55e0bbbef2d0f` | 1/70 | Cynet: Malicious (score: 100) | [report](https://www.virustotal.com/gui/file/adccfc3656e977fcee1e339dcd24b0daaeae3d7df53ebff291b55e0bbbef2d0f) |
| hello-tauri-setup.exe | `3f395303d208a935a47cd5c0a76a4638985c3c8ff85468c9e71281c9f68ad809` | 3/71 | Cylance: Unsafe; APEX: Malicious; Sophos: Generic ML PUA (PUA) | [report](https://www.virustotal.com/gui/file/3f395303d208a935a47cd5c0a76a4638985c3c8ff85468c9e71281c9f68ad809) |
| hello-tauri.exe | `5f754b1f31750c2d8c0714f4a8994e9c505cf89f33fe685eee6787de3d02dfb3` | 0/71 | None | [report](https://www.virustotal.com/gui/file/5f754b1f31750c2d8c0714f4a8994e9c505cf89f33fe685eee6787de3d02dfb3) |
| hello-tray.exe | `019b7281c97cff4556085edcafed1db592ec141e4f49faeb2d748b1414051518` | 3/70 | Symantec: ML.Attribute.HighConfidence; DeepInstinct: MALICIOUS; APEX: Malicious | [report](https://www.virustotal.com/gui/file/019b7281c97cff4556085edcafed1db592ec141e4f49faeb2d748b1414051518) |
| hello-txiki-library.exe | `fbbcfeafb679e4319fcf7d713c318689b460c66ee2c0747e808af38db9b32f7b` | 4/70 | Bkav: W32.Malware.555D155B; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!E1B2799E7518; Kingsoft: malware.kb.a.795 | [report](https://www.virustotal.com/gui/file/fbbcfeafb679e4319fcf7d713c318689b460c66ee2c0747e808af38db9b32f7b) |
| hello-txiki.exe | `c9d598c72988df676856e633da1449e0723e4282cb4e57abbb3067a1600df90b` | 3/64 | Bkav: W32.Malware.F6E0652F; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!07C5787DF6A1 | [report](https://www.virustotal.com/gui/file/c9d598c72988df676856e633da1449e0723e4282cb4e57abbb3067a1600df90b) |
| tjs.exe | `384f683fb0333cb53503d18192b7c381062c0d2404d78efb1360e82ccd7537ef` | 1/70 | Bkav: W32.Malware.60C57FAC | [report](https://www.virustotal.com/gui/file/384f683fb0333cb53503d18192b7c381062c0d2404d78efb1360e82ccd7537ef) |

## macOS arm64

Scanned: 2026-10-09T15:35:46.242Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c | `ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120) |
| hello-tauri | `eb65047a414a453111ee918aa590c0065be751f552f62793813c3ffed52ef56c` | 0/62 | None | [report](https://www.virustotal.com/gui/file/eb65047a414a453111ee918aa590c0065be751f552f62793813c3ffed52ef56c) |
| hello-tauri.dmg | `55c4f9541a0847c3dce1cfb12e7f869a6f335016c27c5f4534ae128e60a6d387` | 0/61 | None | [report](https://www.virustotal.com/gui/file/55c4f9541a0847c3dce1cfb12e7f869a6f335016c27c5f4534ae128e60a6d387) |
| hello-txiki | `eaee96a1ad4d676b86ce49bf481ddd753ae0f790d4fe3ab73778902abebae979` | 0/63 | None | [report](https://www.virustotal.com/gui/file/eaee96a1ad4d676b86ce49bf481ddd753ae0f790d4fe3ab73778902abebae979) |
| hello-txiki-library | `18b624fceedf0523c69b33616435929c27157eb2ee6c9b79d575a2e0fc7d1b39` | 0/61 | None | [report](https://www.virustotal.com/gui/file/18b624fceedf0523c69b33616435929c27157eb2ee6c9b79d575a2e0fc7d1b39) |
| libhello-native.dylib | `ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e) |
| tjs | `dba8f1f4da2fbc692744d48e411ad733ddee9825227f8c2c26d03321199b1708` | 0/57 | None | [report](https://www.virustotal.com/gui/file/dba8f1f4da2fbc692744d48e411ad733ddee9825227f8c2c26d03321199b1708) |

See [PoC source](https://github.com/lukasMega/DeckBridge/tree/main/.github/virustotal-poc).
See [0.17.0 release investigation](./virustotal-v0.17.0.md).
Few detections alone cannot establish safety or malware.
