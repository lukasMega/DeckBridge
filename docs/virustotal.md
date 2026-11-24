---
sidebar_label: VirusTotal comparison
title: VirusTotal PoC comparison
slug: /virustotal
description: Isolated scanner results before DeckBridge release 0.26.1.
---

# VirusTotal PoC comparison

Release candidate: `deckbridge-v0.26.1`.
These isolated samples were scanned before release.
They are not DeckBridge release downloads.
Detection scores can change over time.
Samples uploaded to VirusTotal are public.

## Windows x64

Scanned: 2026-11-24T13:50:32.481Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c.exe | `107cc22bd775a7ea212c3684f44a3b9707082764739903c9e67e80b81ced6e37` | 1/70 | APEX: Malicious | [report](https://www.virustotal.com/gui/file/107cc22bd775a7ea212c3684f44a3b9707082764739903c9e67e80b81ced6e37) |
| hello-native.dll | `9505153f47a96ea049a9de4a3eb1d6681fa57113bf0d1d5fdcac50f44f5016ba` | 1/70 | Cynet: Malicious (score: 100) | [report](https://www.virustotal.com/gui/file/9505153f47a96ea049a9de4a3eb1d6681fa57113bf0d1d5fdcac50f44f5016ba) |
| hello-tauri-setup.exe | `2c73c5d5c204fc2c3564396fae386f7b3835247948d2f6a8412c3852427820e8` | 3/70 | Cylance: Unsafe; Sophos: Generic ML PUA (PUA); APEX: Malicious | [report](https://www.virustotal.com/gui/file/2c73c5d5c204fc2c3564396fae386f7b3835247948d2f6a8412c3852427820e8) |
| hello-tauri.exe | `f4f16569045f3427c7c607f73ce5b5dd56c17e3f9b43e0f4316c3343808380f0` | 0/70 | None | [report](https://www.virustotal.com/gui/file/f4f16569045f3427c7c607f73ce5b5dd56c17e3f9b43e0f4316c3343808380f0) |
| hello-tray.exe | `c940780d3db20d3f998434837e443721b43a03d68f42cbb4601f915fad222b7f` | 3/70 | Symantec: ML.Attribute.HighConfidence; APEX: Malicious; DeepInstinct: MALICIOUS | [report](https://www.virustotal.com/gui/file/c940780d3db20d3f998434837e443721b43a03d68f42cbb4601f915fad222b7f) |
| hello-txiki-library.exe | `f9919001768bba75599dc089bd68b79384f25b2ec906ef9b677c63ce6b31d488` | 2/67 | Bkav: W32.Malware.A57DA8D7; CrowdStrike: win/malicious_confidence_60% (D) | [report](https://www.virustotal.com/gui/file/f9919001768bba75599dc089bd68b79384f25b2ec906ef9b677c63ce6b31d488) |
| hello-txiki.exe | `41f72b3c894bce7cea0ba572cd27469c8cab2ba40b36ed75ae89d8e1fd44b70b` | 3/70 | Bkav: W32.Malware.17D7AA82; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!AD1C6C90FD6B | [report](https://www.virustotal.com/gui/file/41f72b3c894bce7cea0ba572cd27469c8cab2ba40b36ed75ae89d8e1fd44b70b) |
| tjs.exe | `a6d4e25aafcce619b8a48e424c4086cd3f363c8e792a6635691142baa35d2376` | 0/70 | None | [report](https://www.virustotal.com/gui/file/a6d4e25aafcce619b8a48e424c4086cd3f363c8e792a6635691142baa35d2376) |

## macOS arm64

Scanned: 2026-11-24T13:50:32.482Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c | `ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120) |
| hello-tauri | `22748f8a2d41f77cc85bcefe0903953a3d3e005677a453d9db71da33c1371c27` | 1/63 | Microsoft: Trojan:Script/Wacatac.B!ml | [report](https://www.virustotal.com/gui/file/22748f8a2d41f77cc85bcefe0903953a3d3e005677a453d9db71da33c1371c27) |
| hello-tauri.dmg | `f435e34329bc99054dfef4e5b4f0d879fbe176081b4251613f5530c411262c12` | 1/61 | Microsoft: Trojan:Script/Wacatac.B!ml | [report](https://www.virustotal.com/gui/file/f435e34329bc99054dfef4e5b4f0d879fbe176081b4251613f5530c411262c12) |
| hello-txiki | `c2ea26ff2f556ad0ed2c8434b37f13317be98fe444b82710f72719f4fed1e870` | 0/63 | None | [report](https://www.virustotal.com/gui/file/c2ea26ff2f556ad0ed2c8434b37f13317be98fe444b82710f72719f4fed1e870) |
| hello-txiki-library | `021b70f64534b4816de70ed81c052f9f23afec85402bcd7f8104ed8ec6052e3d` | 0/63 | None | [report](https://www.virustotal.com/gui/file/021b70f64534b4816de70ed81c052f9f23afec85402bcd7f8104ed8ec6052e3d) |
| libhello-native.dylib | `ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e) |
| tjs | `3cfafce692abb5845d26ba3fe9ab494299857c5d396000041bb9341515b517ec` | 0/63 | None | [report](https://www.virustotal.com/gui/file/3cfafce692abb5845d26ba3fe9ab494299857c5d396000041bb9341515b517ec) |

See [PoC source](https://github.com/lukasMega/DeckBridge/tree/main/.github/virustotal-poc).
See [0.17.0 release investigation](./virustotal-v0.17.0.md).
Few detections alone cannot establish safety or malware.
