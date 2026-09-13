# Native perf: measurements and how to re-run them

Numbers behind two deliberate choices that look wrong at a glance — `opt-level = 3` in a
size-conscious project, and a process-lifetime `HidApi`. Re-measure before reverting
either. Apple Silicon, macOS 25.6; absolute values are machine-specific, the ratios are
the point.

## Transform cost vs. Cargo opt-level

72×72 JPEG source → 112×112 JPEG, `resize_filter=2` (lanczos3),
`sharpen_sigma_tenths=6`, `max_bytes=10240`, quality 90. 400 iterations after 20 warmup.

| build | per-image | dylib |
|---|---|---|
| `opt-level = "z"` | 3.50 ms | 522 256 B |
| **`opt-level = 3`** (committed) | **0.91 ms** | 719 136 B |

3.8× faster for +192 KB of dylib. The dylib is gzip+base64-embedded into the binary, so
the shipped cost is smaller: `mise run compile` gives 2 451 572 B → 2 522 364 B, i.e.
**+69 KB**. Output bytes are identical between the two builds.

A Cargo profile applies to the **whole resolved build graph**, not just workspace
members — so `"z"` was also de-vectorizing `image`, `zune-jpeg` and the jpeg-encoder:
DCT, quantize, Huffman bit-packing, resize kernels, colour conversion.

Per-package overrides were measured and **rejected**: same speed, *larger* binary than
going global (fat LTO across mixed opt-levels bloats the output).

## HID enumeration cost

`HidApi::new()` is a full `hid_init()` + system-wide `hid_enumerate()`. It used to run
inside every one of the four exported HID fns.

| | per scan tick |
|---|---|
| 18 × `mirabox_hid_list_paths` (one per model×PID) | 56.84 ms |
| 1 × `mirabox_hid_list_all` (one snapshot, matched in TS) | 3.16 ms |

18× less blocking, on the CORA ACK thread, every 2 s for the life of the process.

Two findings worth recording, because they invalidate the obvious fixes:

- **Hoisting `HidApi` alone gains nothing.** `refresh_devices()` still enumerates;
  measured 3.38 ms/call vs 3.31 ms before hoisting. `hid_init()` was never the cost.
- **Gating on a presence check gains nothing.** `mirabox_hid_present` is itself a full
  enumeration, so checking presence before listing just trades 18 enumerations for 16.

The win only comes from doing **one** enumeration per tick and matching all models
against that snapshot in TS (`listAllHidDevices` → `defaultListModelPaths`).

## Harness

Out-of-tree, nothing added to the repo. Recreate at `/tmp/dbbench`:

```toml
# /tmp/dbbench/Cargo.toml
[package]
name = "dbbench"
version = "0.1.0"
edition = "2021"

[dependencies]
libloading = "0.8"
image = { version = "0.25", default-features = false, features = ["jpeg"] }

[profile.release]
opt-level = 3
```

`src/main.rs` generates a busy, high-entropy 72×72 RGB source (so the encoder does real
work, like a real icon), encodes it to JPEG q90, `dlopen`s the cdylib and calls
`image_proc_transform` in a loop. The 21-argument signature is at
`deckbridge-native/src/transform.rs`; argument values mirror `ts/src/translator.ts`
`callImageProc`. `src/bin/allbench.rs` times 18 × `mirabox_hid_list_paths` against
1 × `mirabox_hid_list_all`.

```bash
cd rust && cargo build --release -p deckbridge-native
/tmp/dbbench/target/release/dbbench target/release/libdeckbridge_native.dylib 400
/tmp/dbbench/target/release/allbench target/release/libdeckbridge_native.dylib

# A/B the profile without touching the manifest:
CARGO_PROFILE_RELEASE_OPT_LEVEL=z cargo build --release -p deckbridge-native
```

Rebuild at the committed settings afterwards so the working dylib matches the manifest.

## End-to-end evidence

The repo instruments a 15-key batch at `info` from both sides — `ts/src/image-pipeline.ts`
(main: first CORA arrival → last WebUI broadcast) and `ts/src/image-render.ts` (worker:
device 15-key batch). That is the number a user feels; the microbenchmarks above only
explain it. Capture both with a real device and a real profile load.
