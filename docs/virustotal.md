---
sidebar_label: VirusTotal comparison
title: VirusTotal PoC comparison
slug: /virustotal
description: Isolated scanner results before DeckBridge release 0.17.0.
---

# VirusTotal PoC comparison

Release candidate: `deckbridge-v0.17.0`.
These isolated samples were scanned before release.
They are not DeckBridge release downloads.
Detection scores can change over time.
Samples uploaded to VirusTotal are public.

## Windows x64

Scanned: 2026-09-29T14:26:22.875Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c.exe | `2720b1de8bc56ae0c44c81641061ea94df1ca203ed2c527a4e85ca7d229fe37a` | 2/71 | APEX: Malicious; Microsoft: Trojan:Win32/Wacatac.C!ml | [report](https://www.virustotal.com/gui/file/2720b1de8bc56ae0c44c81641061ea94df1ca203ed2c527a4e85ca7d229fe37a) |
| hello-native.dll | `3d59c234cd702eeab23e1a894b727a9730e73b2adfdf7ca49ea27f2819b1207d` | 2/64 | Cynet: Malicious (score: 100); Microsoft: Trojan:Win32/Wacatac.C!ml | [report](https://www.virustotal.com/gui/file/3d59c234cd702eeab23e1a894b727a9730e73b2adfdf7ca49ea27f2819b1207d) |
| hello-tauri-setup.exe | `7029c45dd8a4a95dd09f541ee9c34aa8a4c31e9883ba5e8eadf2eced243dec83` | 3/71 | Cylance: Unsafe; APEX: Malicious; Sophos: Generic ML PUA (PUA) | [report](https://www.virustotal.com/gui/file/7029c45dd8a4a95dd09f541ee9c34aa8a4c31e9883ba5e8eadf2eced243dec83) |
| hello-tauri.exe | `a6d2b40199ac27597cca0219fb24af61520c8753941e35d3c690f3421cd0e612` | 0/68 | None | [report](https://www.virustotal.com/gui/file/a6d2b40199ac27597cca0219fb24af61520c8753941e35d3c690f3421cd0e612) |
| hello-tray.exe | `fbef6b7ffc41309d90edfa8f8c0f2d0cab9a9dd107e4aee605c7b2bbdb296d84` | 4/71 | Symantec: ML.Attribute.HighConfidence; APEX: Malicious; Microsoft: Trojan:Win32/Wacatac.C!ml; DeepInstinct: MALICIOUS | [report](https://www.virustotal.com/gui/file/fbef6b7ffc41309d90edfa8f8c0f2d0cab9a9dd107e4aee605c7b2bbdb296d84) |
| hello-txiki-library.exe | `442d5f0950a3a7b24634b08409bc19204d6d5a821802b218a9c47fcb4716516f` | 5/71 | Bkav: W32.Malware.4AD0E76E; CrowdStrike: win/malicious_confidence_60% (D); Kingsoft: malware.kb.a.795; Microsoft: Trojan:Win32/Wacatac.C!ml; Cylance: Unsafe | [report](https://www.virustotal.com/gui/file/442d5f0950a3a7b24634b08409bc19204d6d5a821802b218a9c47fcb4716516f) |
| hello-txiki.exe | `c9d598c72988df676856e633da1449e0723e4282cb4e57abbb3067a1600df90b` | 4/71 | Bkav: W32.Malware.F6E0652F; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!07C5787DF6A1; Microsoft: Trojan:Win32/Wacatac.C!ml | [report](https://www.virustotal.com/gui/file/c9d598c72988df676856e633da1449e0723e4282cb4e57abbb3067a1600df90b) |
| tjs.exe | `384f683fb0333cb53503d18192b7c381062c0d2404d78efb1360e82ccd7537ef` | 1/71 | Bkav: W32.Malware.60C57FAC | [report](https://www.virustotal.com/gui/file/384f683fb0333cb53503d18192b7c381062c0d2404d78efb1360e82ccd7537ef) |

## macOS arm64

Scanned: 2026-09-29T14:46:39.685Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c | `ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120` | 0/59 | None | [report](https://www.virustotal.com/gui/file/ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120) |
| hello-tauri | `e29d3d248f3c353658b1ae7fb2a07cfd5cb1a28062af585d64c766cb885470c5` | 0/62 | None | [report](https://www.virustotal.com/gui/file/e29d3d248f3c353658b1ae7fb2a07cfd5cb1a28062af585d64c766cb885470c5) |
| hello-tauri.dmg | `b555db6ec69095a4d22f5803c5aa9f08847268ba3b22542a8f4c49ae3ffe20f2` | 0/61 | None | [report](https://www.virustotal.com/gui/file/b555db6ec69095a4d22f5803c5aa9f08847268ba3b22542a8f4c49ae3ffe20f2) |
| hello-txiki | `eaee96a1ad4d676b86ce49bf481ddd753ae0f790d4fe3ab73778902abebae979` | 0/63 | None | [report](https://www.virustotal.com/gui/file/eaee96a1ad4d676b86ce49bf481ddd753ae0f790d4fe3ab73778902abebae979) |
| hello-txiki-library | `18b624fceedf0523c69b33616435929c27157eb2ee6c9b79d575a2e0fc7d1b39` | 0/63 | None | [report](https://www.virustotal.com/gui/file/18b624fceedf0523c69b33616435929c27157eb2ee6c9b79d575a2e0fc7d1b39) |
| libhello-native.dylib | `ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e` | 0/62 | None | [report](https://www.virustotal.com/gui/file/ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e) |
| tjs | `dba8f1f4da2fbc692744d48e411ad733ddee9825227f8c2c26d03321199b1708` | 0/63 | None | [report](https://www.virustotal.com/gui/file/dba8f1f4da2fbc692744d48e411ad733ddee9825227f8c2c26d03321199b1708) |

See [PoC source](https://github.com/lukasMega/DeckBridge/tree/main/.github/virustotal-poc).
See [0.17.0 release investigation](./virustotal-v0.17.0.md).
Few detections alone cannot establish safety or malware.
