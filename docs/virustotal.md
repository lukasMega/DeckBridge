---
sidebar_label: VirusTotal comparison
title: VirusTotal PoC comparison
slug: /virustotal
description: Isolated scanner results before DeckBridge release 0.20.0.
---

# VirusTotal PoC comparison

Release candidate: `deckbridge-v0.20.0`.
These isolated samples were scanned before release.
They are not DeckBridge release downloads.
Detection scores can change over time.
Samples uploaded to VirusTotal are public.

## Windows x64

Scanned: 2026-10-09T09:37:13.918Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c.exe | `1b54b3188754b0343b2ba5c040f095481337fe3bd929a6e0dd2e0c575c17bbfe` | 1/70 | APEX: Malicious | [report](https://www.virustotal.com/gui/file/1b54b3188754b0343b2ba5c040f095481337fe3bd929a6e0dd2e0c575c17bbfe) |
| hello-native.dll | `8483836eef25ad06a7f9163488c80fc24c9ae9dc74b291b7bab5629275461cd0` | 1/71 | Cynet: Malicious (score: 100) | [report](https://www.virustotal.com/gui/file/8483836eef25ad06a7f9163488c80fc24c9ae9dc74b291b7bab5629275461cd0) |
| hello-tauri-setup.exe | `38cdc5fbb8429018213ec7d24dedb8a5f81aa950a928c254db9a6ab290d07a14` | 3/71 | Cylance: Unsafe; Sophos: Generic ML PUA (PUA); APEX: Malicious | [report](https://www.virustotal.com/gui/file/38cdc5fbb8429018213ec7d24dedb8a5f81aa950a928c254db9a6ab290d07a14) |
| hello-tauri.exe | `40aab61433ecfaa5451330ea79d7aee80c893db987c46c758dd23b55338c04f7` | 0/71 | None | [report](https://www.virustotal.com/gui/file/40aab61433ecfaa5451330ea79d7aee80c893db987c46c758dd23b55338c04f7) |
| hello-tray.exe | `a220907eba8df2fd6ab9a336da1d3bb17b07c3ba50f8e705ff6544d3c76614fb` | 3/71 | Symantec: ML.Attribute.HighConfidence; DeepInstinct: MALICIOUS; APEX: Malicious | [report](https://www.virustotal.com/gui/file/a220907eba8df2fd6ab9a336da1d3bb17b07c3ba50f8e705ff6544d3c76614fb) |
| hello-txiki-library.exe | `ebefb9b5d44b5d96b51e1d364afd04dd6b4676fdb2ba9aa88119b61f65dac3d6` | 3/71 | Bkav: W32.Malware.F0AA43C0; CrowdStrike: win/malicious_confidence_60% (D); Kingsoft: malware.kb.a.795 | [report](https://www.virustotal.com/gui/file/ebefb9b5d44b5d96b51e1d364afd04dd6b4676fdb2ba9aa88119b61f65dac3d6) |
| hello-txiki.exe | `c9d598c72988df676856e633da1449e0723e4282cb4e57abbb3067a1600df90b` | 3/68 | Bkav: W32.Malware.F6E0652F; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!07C5787DF6A1 | [report](https://www.virustotal.com/gui/file/c9d598c72988df676856e633da1449e0723e4282cb4e57abbb3067a1600df90b) |
| tjs.exe | `384f683fb0333cb53503d18192b7c381062c0d2404d78efb1360e82ccd7537ef` | 1/71 | Bkav: W32.Malware.60C57FAC | [report](https://www.virustotal.com/gui/file/384f683fb0333cb53503d18192b7c381062c0d2404d78efb1360e82ccd7537ef) |

## macOS arm64

Scanned: 2026-10-09T09:37:13.919Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c | `ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120` | 0/62 | None | [report](https://www.virustotal.com/gui/file/ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120) |
| hello-tauri | `eb65047a414a453111ee918aa590c0065be751f552f62793813c3ffed52ef56c` | 0/63 | None | [report](https://www.virustotal.com/gui/file/eb65047a414a453111ee918aa590c0065be751f552f62793813c3ffed52ef56c) |
| hello-tauri.dmg | `fd3ca6383104d782bdc856dc656ea75137294a3ead79337bfd189ffd4882d217` | 0/56 | None | [report](https://www.virustotal.com/gui/file/fd3ca6383104d782bdc856dc656ea75137294a3ead79337bfd189ffd4882d217) |
| hello-txiki | `eaee96a1ad4d676b86ce49bf481ddd753ae0f790d4fe3ab73778902abebae979` | 0/48 | None | [report](https://www.virustotal.com/gui/file/eaee96a1ad4d676b86ce49bf481ddd753ae0f790d4fe3ab73778902abebae979) |
| hello-txiki-library | `18b624fceedf0523c69b33616435929c27157eb2ee6c9b79d575a2e0fc7d1b39` | 0/63 | None | [report](https://www.virustotal.com/gui/file/18b624fceedf0523c69b33616435929c27157eb2ee6c9b79d575a2e0fc7d1b39) |
| libhello-native.dylib | `ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e) |
| tjs | `dba8f1f4da2fbc692744d48e411ad733ddee9825227f8c2c26d03321199b1708` | 0/63 | None | [report](https://www.virustotal.com/gui/file/dba8f1f4da2fbc692744d48e411ad733ddee9825227f8c2c26d03321199b1708) |

See [PoC source](https://github.com/lukasMega/DeckBridge/tree/main/.github/virustotal-poc).
See [0.17.0 release investigation](./virustotal-v0.17.0.md).
Few detections alone cannot establish safety or malware.
