# Mirabox 293S image-transfer investigation

Investigated September 17, 2026.

Software improvements look plausible. USB-side work likely dominates. Firmware limits remain unproven.

## Observed evidence

Connected hardware reports VID:PID `5548:6670`. IORegistry confirms 512-byte output reports. Report descriptor declares 512-byte payloads. Larger reports lack hardware support evidence.

Active bridge uses default settings. Output JPEG dimensions remain 85×85. Input uses MK.2 geometry, 72×72. Quality remains 70%. Padding uses edge replication. No chunk delay is configured.

Existing logs show substantial worker lag:

| Log timestamp | WebUI arrival batch | Worker render batch |
| --- | ---: | ---: |
| 09:48:46–47 | 70 ms | 888 ms |
| 10:38:41–42 | 37 ms | 891 ms |
| 11:09:17–18 | 68 ms | 889 ms |

These counters count 15 render events. They do not identify unique keys. Counters may span unrelated updates. They cannot prove panel-completion latency.

Image debug timestamps often advance 67–69ms. Cached transforms also incur worker lag. This suggests USB-side blocking. Individual write timings remain unavailable.

## Offline transform benchmark

Benchmark inputs: 15 current CORA frames. Frames came from local WebUI GETs. Encoder: existing release native library. Each frame received 21 transforms. First transform was excluded from timing. Rotation, padding, geometry remained unchanged.

| JPEG quality | Total JPEG bytes | Data reports | Current total reports | Batched total reports | Transform median | Transform p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 70% | 20,465 | 46 | 76 | 62 | 0.116 ms | 0.157 ms |
| 60% | 19,076 | 46 | 76 | 62 | 0.105 ms | 0.130 ms |
| 50% | 18,063 | 45 | 75 | 61 | 0.102 ms | 0.130 ms |
| 40% | 17,111 | 40 | 70 | 56 | 0.101 ms | 0.130 ms |

Report counts include zero-padding overhead. Each image requires one BAT report. Current behavior adds STP per image. Batched estimates use one final STP.

Formula: `data_reports = Σ ceil(jpeg_bytes / 512)`.

Transforms cost roughly 2ms per page. Timing excludes cache lookup and messaging. Lower quality barely saves report writes. Quality 60 saves zero writes. Quality 50 saves only one. Quality 40 saves six writes. This trades away visible image fidelity.

## Concrete optimization candidates

1. **Batch STP across page updates.** Current [`MiraboxDriver.sendImage`](../ts/src/mirabox.ts) always sends STP. Model flag `sendStpAfterImage: false` does not affect image transfers. It controls initialization and clear operations. Fifteen images therefore send fifteen STPs. One final STP saves fourteen reports. This sample saves 18.4% of writes. Elapsed-time savings could differ substantially.

   Upstream [Mirajazz flush implementation](https://github.com/4ndv/mirajazz/blob/main/src/device.rs) sends pending images together. It then sends one STP. [OpenDeck flush scheduling](https://github.com/4ndv/opendeck-akp153/blob/main/src/device.rs) uses notification-based batching. Its current quiet window is 50ms. Copying that delay would add latency. Bounded batching needs animation-aware scheduling.

2. **Skip unchanged key images.** Transform cache currently saves encoding work. [`renderImage`](../ts/src/image-render.ts) still sends cached bytes. Per-key deduplication could remove entire transfers. Benefits depend on repeated image traffic. Clears, reconnects, reinitialization require invalidation. One hash collision must not suppress updates. Extra-key widgets already skip unchanged content.

3. **Coalesce superseded animation frames.** Worker currently processes FIFO messages. Backlogs retain obsolete frames per key. Latest-frame scheduling could improve responsiveness. It would intentionally drop intermediate frames. Clear, settings, splash ordering must survive.

4. **Compare encoder backends.** Native library offers `jpeg-fork` Huffman optimization. Smaller JPEGs help across 512-byte boundaries. Current images already use baseline 4:2:0. Decoder compatibility needs device verification. Lower byte counts alone prove nothing.

## Measurement defect

[`perfOnRender`](../ts/src/image-render.ts) runs before `driver.sendImage`. Thus current timing excludes final image writes. First-image transformation is also excluded. Gaps between arrivals remain included. Reported batches cannot isolate USB time.

Useful instrumentation separates these intervals:

- Worker arrival → transform start.
- Transform start → transform completion.
- BAT write start → BAT completion.
- Each chunk start → chunk completion.
- STP start → STP completion.
- First arrival → final write completion.

Panel completion requires separate visual measurement. Input ACK packets report key events. They do not acknowledge image rendering.

## Initial hardware benchmark status

Active bridge holds exclusive HID access. Nonexclusive diagnostic opening was attempted. macOS returned `0xE00002C5`, exclusive access. Diagnostic sent no image reports. Bridge configuration remained unchanged.

Actual speedup remains unverified. No production USB behavior was changed. Other comparison devices were not connected. Comparative write timings remain missing.

[HIDAPI macOS implementation](https://github.com/libusb/hidapi/blob/master/mac/hid.c) uses synchronous `IOHIDDeviceSetReport`. Nonblocking read settings do not accelerate writes. macOS defaults to exclusive device opening.

## Next hardware experiment

Pause active bridge before exclusive testing. Resend identical cached frames for consistency. Measure BAT, chunks, STP independently. Compare per-image STP against batched STP. Retain final STP in every trial. Verify all keys finish correctly. Include single-key updates and animations. Record host completion and panel completion. Repeat with each comparison device.

Do not enlarge reports speculatively. Do not remove STP without verification. Current [upstream protocol description](https://github.com/4ndv/mirajazz#protocol_version--1) confirms 512-byte v1 framing.

Best first experiment: bounded STP batching. Best redundant-traffic optimization: per-key deduplication. JPEG quality reduction looks low-value here.

## Implemented batching and measured results

Batching defaults enabled only on `mirabox-293s`. Device tuning exposes “Batch image transfers” for this board and its seven v1 rebadges. Rebadges default disabled and can opt in. Apply saves each model's choice and reconnects USB without restarting the bridge. Fifine and Elgato behavior remains unchanged.

Worker collects images for 16ms. Fifteen arrivals trigger immediate batch dispatch. Deadline never resets on later arrivals. Each batch retains one final STP. Control commands first commit preceding images. Completion notifications follow final STP. Transform errors still commit earlier images.

Isolated updates incur 16ms collection delay. Partial pages can produce multiple batches. No frame deduplication was added.

Connected hardware received alternating wire sequences. Both modes used identical native JPEGs. Initialization sent production CRT DIS. Each mode received twelve page trials. First two repetitions were excluded. Ten measured samples remained per mode.

| Measurement | Original | Batched |
| --- | ---: | ---: |
| Median USB page writes | 1,022.002 ms | 461.040 ms |
| Mean USB page writes | 1,024.356 ms | 461.071 ms |
| Minimum | 1,020.708 ms | 459.484 ms |
| Maximum | 1,041.003 ms | 463.509 ms |
| Reports per page | 76 | 62 |
| STP reports per page | 15 | 1 |

Median transfer time fell **54.9%**. Throughput increased roughly **2.22×**. Savings exceed report-count reduction substantially.

Individual STP writes cost roughly 0.5ms. Subsequent BAT/chunk writes incur firmware stalls. Fewer STPs apparently reduce subsequent stalls. This interpretation remains firmware-level inference.

Timings measure synchronous host USB writes. They exclude worker collection and transformation. They exclude visible panel completion. Complete 15-message bursts dispatch immediately. Partial batches add collection delay.

Standalone production-worker benchmarking crashed during opening. Original worker also hit this crash. USB timings therefore used standalone HIDAPI. Regression tests verify actual worker framing. No end-to-end application speedup was measured.

Bridge API became offline before measurement. Benchmark did not pause active bridge. Final trial resent original cached profile. No brightness changes were requested.

Raw measurements: [benchmark samples](./benchmarks/mirabox-293s-stp.json).

Validation: 37 relevant tests passed. Batching suite includes 21 regression cases. Tests cover every other Mirabox model. Type checking, targeted lint, build passed.
