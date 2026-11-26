---
sidebar_label: VirusTotal comparison
title: VirusTotal PoC comparison
slug: /virustotal
description: Isolated scanner results before DeckBridge release 0.26.4.
---

# VirusTotal PoC comparison

Release candidate: `deckbridge-v0.26.4`.
These isolated samples were scanned before release.
They are not DeckBridge release downloads.
Detection scores can change over time.
Samples uploaded to VirusTotal are public.

## Windows x64

Scanned: 2026-11-26T22:49:06.157Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c.exe | `d7083fae97d525276eb09226766ce0dfe5e7e018530878b063dac363d4cff400` | 1/70 | APEX: Malicious | [report](https://www.virustotal.com/gui/file/d7083fae97d525276eb09226766ce0dfe5e7e018530878b063dac363d4cff400) |
| hello-native.dll | `1179b1296892a8876be59ee06110b0e9ac50e5b767dc9432f846d32da10421aa` | 1/70 | Cynet: Malicious (score: 100) | [report](https://www.virustotal.com/gui/file/1179b1296892a8876be59ee06110b0e9ac50e5b767dc9432f846d32da10421aa) |
| hello-tauri-setup.exe | `2a3273f35082ca9ea7985dd8d233962ec6fc48d55c77feb65c1b6153f37404c9` | 2/69 | Cylance: Unsafe; APEX: Malicious | [report](https://www.virustotal.com/gui/file/2a3273f35082ca9ea7985dd8d233962ec6fc48d55c77feb65c1b6153f37404c9) |
| hello-tauri.exe | `daf91f27587e11fe82efcc955029ffe23da8b0aa2de1101d49c9682b9d2bcd92` | 0/70 | None | [report](https://www.virustotal.com/gui/file/daf91f27587e11fe82efcc955029ffe23da8b0aa2de1101d49c9682b9d2bcd92) |
| hello-tray.exe | `8777993fc14a5d5d84cac08ca2354078d3e4d74d350ccc3b13ffd336d8e29410` | 4/70 | Symantec: ML.Attribute.HighConfidence; DeepInstinct: MALICIOUS; APEX: Malicious; Fortinet: W64/MALD2.HWLU!tr | [report](https://www.virustotal.com/gui/file/8777993fc14a5d5d84cac08ca2354078d3e4d74d350ccc3b13ffd336d8e29410) |
| hello-txiki-library.exe | `17868383f70084ffecea1d2d72b49d8a3f00a9ddd648593581c390ae4c95f272` | 2/70 | Bkav: W32.Malware.8CB15C0B; CrowdStrike: win/malicious_confidence_60% (D) | [report](https://www.virustotal.com/gui/file/17868383f70084ffecea1d2d72b49d8a3f00a9ddd648593581c390ae4c95f272) |
| hello-txiki.exe | `41f72b3c894bce7cea0ba572cd27469c8cab2ba40b36ed75ae89d8e1fd44b70b` | 3/70 | Bkav: W32.Malware.17D7AA82; CrowdStrike: win/malicious_confidence_60% (D); McAfeeD: Real Protect-LS!AD1C6C90FD6B | [report](https://www.virustotal.com/gui/file/41f72b3c894bce7cea0ba572cd27469c8cab2ba40b36ed75ae89d8e1fd44b70b) |
| tjs.exe | `a6d4e25aafcce619b8a48e424c4086cd3f363c8e792a6635691142baa35d2376` | 0/70 | None | [report](https://www.virustotal.com/gui/file/a6d4e25aafcce619b8a48e424c4086cd3f363c8e792a6635691142baa35d2376) |

## macOS arm64

Scanned: 2026-11-26T22:49:06.159Z.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
| hello-c | `ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120` | 0/62 | None | [report](https://www.virustotal.com/gui/file/ef7961cec69676e69cb1337d85e6c7d69430924e9c685d2b7e6b7d132b300120) |
| hello-tauri | `22748f8a2d41f77cc85bcefe0903953a3d3e005677a453d9db71da33c1371c27` | 0/63 | None | [report](https://www.virustotal.com/gui/file/22748f8a2d41f77cc85bcefe0903953a3d3e005677a453d9db71da33c1371c27) |
| hello-tauri.dmg | `66d2a09ac073538bbf524b209ef153a53b6adfc0118db5916c776d8dc7832252` | 0/61 | None | [report](https://www.virustotal.com/gui/file/66d2a09ac073538bbf524b209ef153a53b6adfc0118db5916c776d8dc7832252) |
| hello-txiki | `c2ea26ff2f556ad0ed2c8434b37f13317be98fe444b82710f72719f4fed1e870` | 0/63 | None | [report](https://www.virustotal.com/gui/file/c2ea26ff2f556ad0ed2c8434b37f13317be98fe444b82710f72719f4fed1e870) |
| hello-txiki-library | `021b70f64534b4816de70ed81c052f9f23afec85402bcd7f8104ed8ec6052e3d` | 0/63 | None | [report](https://www.virustotal.com/gui/file/021b70f64534b4816de70ed81c052f9f23afec85402bcd7f8104ed8ec6052e3d) |
| libhello-native.dylib | `ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e` | 0/63 | None | [report](https://www.virustotal.com/gui/file/ae504ecc69c07e9d1442f1d81846dcf8ba1a00216f5eeca8c204d2d8abcbb60e) |
| tjs | `3cfafce692abb5845d26ba3fe9ab494299857c5d396000041bb9341515b517ec` | 0/63 | None | [report](https://www.virustotal.com/gui/file/3cfafce692abb5845d26ba3fe9ab494299857c5d396000041bb9341515b517ec) |

See [PoC source](https://github.com/lukasMega/DeckBridge/tree/main/.github/virustotal-poc).
See [0.17.0 release investigation](./virustotal-v0.17.0.md).
Few detections alone cannot establish safety or malware.
