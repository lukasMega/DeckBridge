---
sidebar_label: VirusTotal comparison
title: VirusTotal PoC comparison
slug: /virustotal
description: Isolated scanner results before DeckBridge release 0.21.2.
---

# VirusTotal PoC comparison

Release candidate: `deckbridge-v0.21.2`.
These isolated samples were scanned before release.
They are not DeckBridge release downloads.
Detection scores can change over time.
Samples uploaded to VirusTotal are public.

## Windows x64

Scanned: 2026-11-07T10:08:55.014Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c.exe | `7f19dcf262afa321725c2eba0fc81cf834ef89a9aaacd67a73766970d88abd2a` | 1/71 | APEX: Malicious | [report](https://www.virustotal.com/gui/file/7f19dcf262afa321725c2eba0fc81cf834ef89a9aaacd67a73766970d88abd2a) |
| hello-native.dll | `40d70b2be75f906c1101129e7398903c6dee0be69cd89883e845471e2b79f4aa` | 1/70 | Cynet: Malicious (score: 100) | [report](https://www.virustotal.com/gui/file/40d70b2be75f906c1101129e7398903c6dee0be69cd89883e845471e2b79f4aa) |
| hello-tauri-setup.exe | `97de018974c8f2104369e036192e9e7dbb7ad17e4935d1a587a7a91749e6bd37` | 3/71 | Cylance: Unsafe; APEX: Malicious; Sophos: Generic ML PUA (PUA) | [report](https://www.virustotal.com/gui/file/97de018974c8f2104369e036192e9e7dbb7ad17e4935d1a587a7a91749e6bd37) |
| hello-tauri.exe | `230cbd6432219c4887fb57e48104eda7b5e46b7f70eeb800b91dc1c9fb9a4f89` | 0/71 | None | [report](https://www.virustotal.com/gui/file/230cbd6432219c4887fb57e48104eda7b5e46b7f70eeb800b91dc1c9fb9a4f89) |
| hello-tray.exe | `4786094ddc857444521628bb888695843c3b069904c59c7d59bdabd7c237a6bb` | 3/71 | Symantec: ML.Attribute.HighConfidence; DeepInstinct: MALICIOUS; APEX: Malicious | [report](https://www.virustotal.com/gui/file/4786094ddc857444521628bb888695843c3b069904c59c7d59bdabd7c237a6bb) |
| hello-txiki-library.exe | `a08b8d14c99eaaf8bb877bb95ab6801f69385014c0b8d7bb0143d979560d3d7f` | 2/70 | Bkav: W32.Malware.5B1BEBA7; CrowdStrike: win/malicious_confidence_60% (D) | [report](https://www.virustotal.com/gui/file/a08b8d14c99eaaf8bb877bb95ab6801f69385014c0b8d7bb0143d979560d3d7f) |
| hello-txiki.exe | `c9d598c72988df676856e633da1449e0723e4282cb4e57abbb3067a1600df90b` | 3/71 | Bkav: W32.Malware.F6E0652F; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!07C5787DF6A1 | [report](https://www.virustotal.com/gui/file/c9d598c72988df676856e633da1449e0723e4282cb4e57abbb3067a1600df90b) |
| tjs.exe | `384f683fb0333cb53503d18192b7c381062c0d2404d78efb1360e82ccd7537ef` | 1/71 | Bkav: W32.Malware.60C57FAC | [report](https://www.virustotal.com/gui/file/384f683fb0333cb53503d18192b7c381062c0d2404d78efb1360e82ccd7537ef) |

## macOS arm64

Scanned: 2026-11-07T10:08:55.015Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c | `ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120) |
| hello-tauri | `069e4c73758bf9820835661bececcde89f569b6f8474fea1c17d829d0c2094ad` | 0/59 | None | [report](https://www.virustotal.com/gui/file/069e4c73758bf9820835661bececcde89f569b6f8474fea1c17d829d0c2094ad) |
| hello-tauri.dmg | `0d38a65e94b1dfa61f9242b8cca6b8b58425e8d0165329c701b321cc1dc7c6e5` | 0/61 | None | [report](https://www.virustotal.com/gui/file/0d38a65e94b1dfa61f9242b8cca6b8b58425e8d0165329c701b321cc1dc7c6e5) |
| hello-txiki | `eaee96a1ad4d676b86ce49bf481ddd753ae0f790d4fe3ab73778902abebae979` | 0/63 | None | [report](https://www.virustotal.com/gui/file/eaee96a1ad4d676b86ce49bf481ddd753ae0f790d4fe3ab73778902abebae979) |
| hello-txiki-library | `18b624fceedf0523c69b33616435929c27157eb2ee6c9b79d575a2e0fc7d1b39` | 0/63 | None | [report](https://www.virustotal.com/gui/file/18b624fceedf0523c69b33616435929c27157eb2ee6c9b79d575a2e0fc7d1b39) |
| libhello-native.dylib | `ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e) |
| tjs | `dba8f1f4da2fbc692744d48e411ad733ddee9825227f8c2c26d03321199b1708` | 0/63 | None | [report](https://www.virustotal.com/gui/file/dba8f1f4da2fbc692744d48e411ad733ddee9825227f8c2c26d03321199b1708) |

See [PoC source](https://github.com/lukasMega/DeckBridge/tree/main/.github/virustotal-poc).
See [0.17.0 release investigation](./virustotal-v0.17.0.md).
Few detections alone cannot establish safety or malware.
