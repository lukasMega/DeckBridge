# AKP05 guided strip probe

Research refreshed: 2026-09-24.
Hardware observations remain pending.

Run with DeckBridge stopped:

```sh
mise run akp05-strip-guided-probe
```

Answer directly inside your terminal.
Each question accepts yes/no or numbers.
Press Enter after each answer.
Device buttons never advance tests.
Enter `-1` for unknown numbers.
Ctrl+C saves partial results.

Results save after each answer.
Terminal prints `results.json` location.
Matching JPEGs accompany that file.
JPEGs contain device-oriented, rotated pixels.
Upload metadata records sizes and timings.
Firmware feature bytes also get recorded.

No-hardware rehearsal:

```sh
mise run akp05-strip-guided-probe -- --dry-run
```

Rehearsal still requires native image conversion.
It never opens USB hardware.
Results explicitly mark `dryRun: true`.
Rehearsal answers provide no hardware evidence.

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
  Local hardware tuning corrected them to x=0/203/406/609.
- [Mirajazz firmware retrieval](https://github.com/4ndv/mirajazz/blob/5e3e1a4dd30f7cb2d914b534ae82bef9ab7b1368/src/device.rs#L304)
  reads 20-byte feature report `0x01`.
  This probe tries it last.

Earlier local findings establish 800px width.
They also establish compositing slot writes.
Those observations override conflicting upstream claims.
Reviewed sources establish no 10KB cap.

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
Keep 9500 bytes provisional until verified.

This probe changes visible images.
Initialization and CLE can clear keys.
It uses 50% brightness throughout.
Closing doesn't restore previous display contents.
No persistent `LOG` writes occur.
Unsupported `BGPIC` isn't retried.
Production drivers remain unchanged.
