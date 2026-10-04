# AKP05 guided strip probe

Historical research: 2026-09-24.
Availability checked: 2026-10-03.
Guided probe scripts are absent here.
Their former task is also absent.
Instructions below describe historical experiments only.

Current input capture remains available:

```sh
mise run akp05-capture
```

This capture opens and initializes hardware.
It does not reproduce strip experiments.
Current model uses 800×112 strip geometry.
Slot origins are 0/204/406/610.
Current upload cap is 10,100 bytes.
See [current device notes](./devices.mdx#ajazz-akp05e).

## Research basis

- [Zeccola upload implementation](https://github.com/zeccola/ajazz-akp05/blob/8e1c16b586c352e13206caf10bfde175b764812f/akp05_device.py#L412)
  sleeps 50ms after every report.
  Upload termination uses `STP`.
  Its hardware notes describe 800×112.
  Refresh found no newer main commit.
- [Companion bridge upload implementation](https://github.com/dvortsis/ajazz-companion-bridge/blob/05630a9d0123b543d0575e40d42f35c6364b70cf/index.js#L384)
  sends full strips through wire-key 1.
  It also uses `STP` termination.
  Its pacing setting supports transport comparisons.
- [Background fork geometry](https://github.com/VibeCodyH/opendeck-akp05/blob/0f09344d7b72da6dd093b768a24f5a0542bfdb0c/tools/render_frames.py#L60)
  suggests x=0/208/416/624 for slot origins.
  Earlier tuning suggested x=0/203/406/609.
  Current model uses x=0/204/406/610.
- [Mirajazz firmware retrieval](https://github.com/4ndv/mirajazz/blob/5e3e1a4dd30f7cb2d914b534ae82bef9ab7b1368/src/device.rs#L304)
  reads 20-byte feature report `0x01`.
  This probe tries it last.

Earlier local findings establish 800px width.
They also establish compositing slot writes.
Those observations override conflicting upstream claims.
Those historical sources established no cap.
Later local captures established current limits.

## Controlled comparisons

All ruler uploads use wire-key 1.
Each condition reuses identical large-JPEG bytes.
Each trial starts with blue paint.
Answer confirms successful reset before proceeding.
Failed resets stop testing as inconclusive.
`CLE` isn't trusted for these resets.

| Condition | Report delay | Pre-termination pause | Terminator |
|---|---:|---:|---|
| Small ruler, ≤9500 bytes | 50ms | 0ms extra | STP |
| Large ruler, fast | 0ms | 0ms | ULEND |
| Large ruler, alternate termination | 0ms | 0ms | STP |
| Large ruler, final settling | 0ms | 500ms | ULEND |
| Large ruler, paced | 50ms | 50ms from pacing | ULEND |
| Large ruler, paced alternate | 50ms | 50ms from pacing | STP |

Pacing includes headers and final chunks.
Every trial shares identical wake commands.
Every observation follows 300ms settling.
Synchronous uploads exclude interleaving keepalives.
Live keepalives continue while answering questions.
Protocol remains BE16 with 1024-byte chunks.
Large JPEGs stay below 60001 bytes.

Count only fully readable number rows.
Seven rows means complete ruler content.
Separately report visible noise or corruption.

Additional tests check `CLE` clearing.
Small orange markers check slot origins.
Estimate marker edges against ruler ticks.
Tick spacing represents ten pixels.
Coordinates are upright, left-to-right values.
Unusable rulers skip coordinate questions.
Feature retrieval precedes final responsiveness verification.

## Interpretation limits

Paced success implicates timing or throughput.
STP-only success implicates termination behavior.
Final-settling success implicates completion timing.
Small-only success leaves several explanations open.
Buffer limits and decoder constraints remain.
It doesn't prove exactly 10240 bytes.
Historical 9500-byte limit was provisional.
Current model supersedes that provisional limit.

This probe changes visible images.
Initialization and CLE can clear keys.
It uses 50% brightness throughout.
Closing doesn't restore previous display contents.
No persistent `LOG` writes occur.
Unsupported `BGPIC` isn't retried.
Production drivers remain unchanged.
