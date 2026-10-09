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

3.8× faster for +192 KB of dylib. The dylib was gzip+base64-embedded then, so the shipped
cost was smaller: `mise run compile` gave 2 451 572 B → 2 522 364 B, i.e. **+69 KB**.
Output bytes are identical between the two builds. (Numbers above are from the original
measurement; the re-measure below uses today's code and embed.)

The dylib is now embedded as raw bytes (a latin1 string) and deflated together with the
bytecode, so what it costs in `./deckbridge` is about its deflate size, not its file size.
Re-measured after the dylib audit below (same harness, 3 alternating rounds, machine busy,
so absolute times are higher than in the table above; `mini-bmp` = 80×80 BMP → BMP):

| build | dylib | deflate -9 | `./deckbridge` | perf72 | mini-bmp |
|---|---|---|---|---|---|
| **`opt-level = 3`** (committed) | **653 216 B** | 326 926 B | **2 694 079 B** | **0.88 ms** | **0.059 ms** |
| `opt-level = "z"` | 505 600 B | 267 318 B | 2 637 391 B | 2.11 ms | 0.408 ms |

"z" saves 148 KB of dylib and **57 KB of binary** (2.1 %) for a transform that is 2.4× (perf72)
to 6.9× (mini-bmp) slower. Same conclusion, smaller price than before.

A Cargo profile applies to the **whole resolved build graph**, not just workspace
members — so `"z"` was also de-vectorizing `image`, `zune-jpeg` and the jpeg-encoder:
DCT, quantize, Huffman bit-packing, resize kernels, colour conversion.

Per-package overrides were measured and **rejected**: same speed, *larger* binary than
going global (fat LTO across mixed opt-levels bloats the output).

## What the dylib is made of (cargo-bloat)

`cargo install cargo-bloat` (a dev tool, never a dependency). It rebuilds with `strip = false`
into the **same** target dir, so afterwards rebuild (`cargo build --release`) or give it its own
`CARGO_TARGET_DIR`. `.text` is 564 188 B of the 735 808 B dylib before the audit.

```bash
cd rust/deckbridge-native
CARGO_TARGET_DIR=/tmp/bloat cargo bloat --release --lib --crates
CARGO_TARGET_DIR=/tmp/bloat cargo bloat --release --lib -n 40
```

| `.text` by crate (before) | KiB | |
|---|---|---|
| `std` | 231 | of which **≈ 143 KiB is the backtrace symbolizer** (gimli, addr2line, object, rustc-demangle, `_print_fmt`) |
| `image` | 119 | `DynamicImage::resize_exact` alone 41 KiB (10 pixel types), cicp conversions 12 KiB |
| `zune_jpeg` | 110 | baseline + progressive decoder, with two copies of `decode_headers_internal` (12 KiB each) |
| `deckbridge_native` | 37 | `transform` 34 KiB (rotate/flip/crop for every pixel type inlined) |
| `jpeg_encoder` | 22 | |
| `[Unknown]` (hidapi C) + `hidapi` | 16 | |

Embedded cost is the **deflate -9** of the file (raw size is misleading: page-aligned segments,
and code that repeats compresses well). Measure with `gzip -9 -c libdeckbridge_native.dylib | wc -c`
or `node -e` + `zlib.deflateRawSync(buf, {level: 9})`, then `mise run compile` + `size-report`
(`binary − runtime`).

### Kept: one pixel type through the whole transform

`transform` used `DynamicImage`, so every `resize`/`rotate`/`flip`/`crop` was compiled for all
ten pixel layouts (L8…Rgba32F) although JPEG and BMP decode only to L8/LA8/RGB8/RGBA8. The
pipeline now widens to `RgbaImage` right after decode (`decode_limited`) and calls `imageops`
directly; encoders read the RGB triples out of it. `pad_to_canvas` already worked in RGBA.
Output is **bit-identical** (resize, rotate, flip, crop and blur treat channels independently;
alpha was always dropped, not blended) and the unit test `gray_source_resizes_like_luma` pins
that. Verified with the golden battery below, JPEG backend upstream and `jpeg-fork`.

| | dylib | deflate -9 | `./deckbridge` | payload (`binary − runtime`) |
|---|---|---|---|---|
| before (main @ 4b877e3) | 735 808 | 360 709 | 2 729 410 | 702 466 |
| RGBA8 pipeline (`into_rgba8()`, encoder fed RGBA) | 669 760 | 340 337 | 2 708 700 | 681 756 |
| **+ 4-layout `decode_limited` and own RGBA→RGB copy (kept)** | **653 216** | **326 926** | **2 694 079** | **667 135 (−35 331)** |

Per image, A/B alternating 9 rounds × 400 iterations (median, busy machine), before → after:
perf72 0.963 → 0.876 ms (**−9.1 %**), mini-bmp −7.1 %, k1pro −6.6 %, blur-sharp −6.3 %,
progressive −5.5 %, sdplus −8.2 %, gray-jpeg +0.5 %, rgba-bmp −0.8 %, pad (fill 2/3) +2.3 / +2.1 %
(the one place the old vectorized `to_rgba8`/`to_rgb8` beat a plain loop; inside the 3 % gate).
`ColorType::Rgba` straight into the encoder was 0.8 KB larger and about 5 % slower on the pad
paths, so the encoder gets packed RGB.

### Levers measured and not kept (each on top of the kept state)

| lever | dylib | deflate -9 | `./deckbridge` Δ | verdict |
|---|---|---|---|---|
| `image` without `bmp` | 636 656 | 311 978 | −12 312 | **needed**: the app sends gen1/Mini BMP (`image-render.ts`), so only a hand-written BMP reader could drop it (behavior change for exotic BMPs) |
| remove the 4 unused legacy HID exports (`find_path`, `list_paths`, `present`, `serial_for_path`) | 652 992 | 324 643 | −3 242 | no TS caller, but documented C API: left to a maintainer decision |
| drop the `usb` feature (hidapi inside the cdylib) | 616 448 | 307 378 | −16 528 | enumeration would move to TS FFI over `libhidapi`: platform `wchar_t` structs, not a size-only change |
| drop the separate `libhidapi` embed (macOS 58 752 B) | | 9 543 | −8 378 | would need the cdylib to export `hid_open_path`/`read`/`write`: +4 408 B deflate there, and one hidapi instance shared by scan and USB workers (they are separate on purpose, see `mirabox_hid_reset`): net ≈ −4 KB |
| `--remap-path-prefix` (panic location paths) | 653 216 | 326 829 | −129 | noise (`trim-paths` needs a newer cargo) |
| `-Wl,-no_function_starts` | 651 920 | 325 684 | −1 615 | macOS only, costs crash symbolication |
| LLVM machine outliner | 605 424 | 338 532 | +11 906 | smaller file, **larger** deflate, 4–12 % slower |
| duplicate crate versions | | | 0 | `cargo tree -d` is empty |
| exported symbols | | | 0 | exactly the nine `#[no_mangle]` fns; hidapi C symbols are not exported and dead-stripped |
| `strip`, `lto = true`, `codegen-units = 1` | | | 0 | already set |

Not buildable here: dropping std's backtrace symbolizer needs `-Zbuild-std` without std's
`backtrace` feature (nightly, or `RUSTC_BOOTSTRAP=1`, plus the `rust-src` component, an explicit
`--target`, and the same flags in `release.yml`'s five jobs). Estimate by zeroing the 208
backtrace functions (147 252 B) in the dylib and re-deflating: **−83 883 B deflate, −78 418 B
binary (2.9 %)**, with the same `panic = "unwind"`. Windows (dbghelp) would gain less, Linux
(gimli plus miniz_oxide) more.

## HID enumeration cost

> Historical benchmark. Operational discovery now uses
> `mirabox_hid_list_supported` inside a dedicated worker. Full
> `mirabox_hid_list_all` enumeration remains diagnostics-only.

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
libloading = "0.8"   # or declare dlopen/dlsym by hand on unix
image = { version = "=0.25.10", default-features = false, features = ["jpeg", "bmp"] }  # decode + BMP encode
jpeg-encoder = { version = "=0.7.1", default-features = false, features = ["std"] }     # JPEG sources

[profile.release]
opt-level = 3
```

`src/main.rs` generates a busy, high-entropy 72×72 RGB source (so the encoder does real
work, like a real icon), encodes it to JPEG q90, `dlopen`s the cdylib and calls
`image_proc_transform` in a loop. The 25-argument signature is at
`deckbridge-native/src/transform.rs`; argument values mirror
`ts/src/transform/translator.ts` (`transformImageForDevice`). `src/bin/allbench.rs` times
18 × `mirabox_hid_list_paths` against 1 × `mirabox_hid_list_all`.

Two modes, both over a battery of 43 cases (JPEG and BMP in; gray, RGBA, 8-bit palette,
top-down and progressive sources; pad/crop fill modes 1–7; rotate/flip/blur/sharpen/region
crop; zero, 1 px and 65 536 px outputs; garbage, truncated, over-limit and too-small-buffer
errors; `image_proc_blit`): `golden` prints a hash of each return code, output and error
message, so before/after dylibs compare with `diff`; `bench` times the main cases (400
iterations after 20 warmup). For A/B, alternate the two dylibs for ≥ 5 rounds and compare
medians; one run is ±1 %, and a busy machine scales every number but not the ratios.

```bash
cd rust && cargo build --release -p deckbridge-native
/tmp/dbbench/target/release/dbbench bench target/release/libdeckbridge_native.dylib 400
/tmp/dbbench/target/release/dbbench golden target/release/libdeckbridge_native.dylib > after.txt
/tmp/dbbench/target/release/allbench target/release/libdeckbridge_native.dylib

# A/B the profile without touching the manifest:
CARGO_PROFILE_RELEASE_OPT_LEVEL=z cargo build --release -p deckbridge-native
```

Rebuild at the committed settings afterwards so the working dylib matches the manifest.

## End-to-end evidence

The repo instruments a 15-key batch at `info` from both sides — `ts/src/main/image-perf.ts`
(main: first CORA arrival → last WebUI broadcast) and `ts/src/image-render.ts` (worker:
device 15-key batch). That is the number a user feels; the microbenchmarks above only
explain it. Capture both with a real device and a real profile load.
