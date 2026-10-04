# deckbridge-native

Rust cdylib that provides native-OS capabilities for `deckbridge`: JPEG/BMP image transforms
and (behind the `usb` Cargo feature) HID device-path enumeration. Loaded in-process at runtime
over txiki.js FFI. The image transform replaces the former subprocess sidecar (TCP reverse-connect
+ JSON/base64 protocol).

## Loading

The compiled shared library (`libdeckbridge_native.dylib` on macOS, `libdeckbridge_native.so` on Linux,
`deckbridge_native.dll` on Windows) is loaded at runtime by `ts/src/ffi/image-proc.ts` (and
`ts/src/ffi/hidapi.ts` / `ts/src/ffi/hid-discovery.ts` for HID exports) using `FFI.dlopen(tjs.env.DECKBRIDGE_NATIVE_LIB)`. The
`DECKBRIDGE_NATIVE_LIB` environment variable must point to the absolute path of the library; `mise run
start` sets it automatically via `mise.toml`.

The library is embedded inside the compiled `deckbridge` binary and extracted at runtime to a
per-version cache directory (`ts/src/infra/native-libs.ts`), which sets `DECKBRIDGE_NATIVE_LIB` itself. The
env var is otherwise an optional override for dev/power-user use.

## Build

```bash
cd rust/deckbridge-native
cargo build --release
# Cargo workspace (rust/Cargo.toml) — output lands in the shared workspace target dir:
# Output: ../target/release/libdeckbridge_native.dylib  (macOS)
#         ../target/release/libdeckbridge_native.so      (Linux)
#         ../target/release/deckbridge_native.dll        (Windows)
```

Default features include `jpeg-upstream` and `usb`.
USB discovery therefore builds by default.
Image-only builds can disable USB explicitly:

```bash
cargo build --release --no-default-features --features jpeg-upstream
```

**Crate type:** `crate-type = ["cdylib"]`

**Panic strategy:** `panic = "unwind"` (required so that `catch_unwind` at the FFI boundary can
catch panics from third-party codec code and return `-3` instead of aborting the host process).

**JPEG encoder backend (cargo feature, exactly one):** output is always baseline 4:2:0 with a
single interleaved scan — the only format every supported device decodes (K1 Pro probe round 5).

- `jpeg-upstream` (default) — crates.io `jpeg-encoder 0.7.1`, standard Huffman tables.
- `jpeg-fork` — vendored `../jpeg-encoder` fork: optimized Huffman tables kept in the single
  interleaved scan (~20 % smaller files, identical pixels). Build via `JPEG_FORK=1 mise run build`
  (= `cargo build --release --no-default-features --features jpeg-fork,usb`).

Upstream's `set_optimized_huffman_tables(true)` must never be used directly: it emits one scan per
component, which the K1 Pro firmware renders as chroma garbage. See internal probe notes
(K1 Pro JPEG artifact investigation).

## Exported C function: image_proc_transform

```c
/**
 * Transform an image: explicit rotate/flip, optional resize to width×height,
 * then encode as JPEG (iterative quality reduction down to <= max_bytes) or BMP.
 * Result is written into the caller-owned out_buf.
 *
 * EXIF auto-rotation is intentionally NOT performed (kamadak-exif dependency
 * was dropped as a size optimization; see "Binary size" in the design plan).
 * Only the explicit rotate/flip parameters are applied.
 *
 * Parameters:
 *   jpeg_in      — pointer to input image bytes (JPEG or BMP)
 *   jpeg_in_len  — length of input in bytes
 *   width        — target width in pixels
 *   height       — target height in pixels
 *   max_bytes    — maximum encoded JPEG size in bytes (0 = no cap; ignored for BMP)
 *   quality      — JPEG quality percent, 1..=100 (ignored for BMP)
 *   skip_resize  — 0 = resize to width×height; 1 = skip resize (pass through decoded image)
 *   rotate       — clockwise rotation in degrees: 0, 90, 180, or 270
 *   flip_h       — 0 = no horizontal flip; 1 = flip horizontally
 *   flip_v       — 0 = no vertical flip; 1 = flip vertically
 *   format       — 0 = JPEG output; 1 = BMP output
 *   bmp_ppm      — BMP BITMAPINFOHEADER pixels-per-meter (e.g. 2835 = 72 DPI; ignored for JPEG)
 *   out_buf      — caller-allocated output buffer
 *   out_cap      — capacity of out_buf in bytes
 *   err_buf      — caller-allocated error message buffer (NUL-terminated UTF-8 on error)
 *   err_cap      — capacity of err_buf in bytes
 *
 * Return value:
 *   >= 0   number of bytes written into out_buf (success)
 *   -1     transform or encode error; NUL-terminated UTF-8 message written into err_buf
 *   -2     out_buf too small (out_cap < required output size); caller may grow and retry
 *   -3     panic caught at the FFI boundary (malformed input triggered a codec panic)
 */
int32_t image_proc_transform(
    const uint8_t *jpeg_in,
    size_t         jpeg_in_len,
    uint32_t       width,
    uint32_t       height,
    size_t         max_bytes,
    uint32_t       quality,
    int32_t        skip_resize,
    uint32_t       rotate,
    int32_t        flip_h,
    int32_t        flip_v,
    int32_t        format,
    int32_t        bmp_ppm,
    uint32_t       blur_sigma_tenths,
    uint32_t       resize_filter,
    uint32_t       sharpen_sigma_tenths,
    uint32_t       fill_mode,
    uint32_t       crop_px,
    uint32_t       crop_x,
    uint32_t       crop_y,
    uint32_t       crop_w,
    uint32_t       crop_h,
    uint8_t       *out_buf,
    size_t         out_cap,
    uint8_t       *err_buf,
    size_t         err_cap
);
```

No heap ownership crosses the boundary — the caller owns all buffers.

Additional parameters follow current `src/transform.rs`.
TypeScript signatures live in `ffi/image-proc.ts`.

| Parameters | Interpretation |
|---|---|
| `blur_sigma_tenths`, `sharpen_sigma_tenths` | Sigma multiplied by ten |
| `resize_filter` | 0 triangle; 1 nearest; 2 Lanczos3 |
| `fill_mode` | 0 resize; 1–3 padding modes |
| `fill_mode` bit 4 | Centre-crop oversized source axes |
| `crop_px` | Symmetric source-edge crop |
| `crop_x`, `crop_y`, `crop_w`, `crop_h` | Source region; zero dimensions disable |

Region crop precedes symmetric crop selection.
Padding runs before rotation and flips.
Ordinary resizing runs after those transforms.
Blur and sharpening precede encoding.


### TypeScript binding

`ts/src/ffi/image-proc.ts` declares both image exports.
`ts/src/transform/translator.ts` owns reusable output scratch.
Scratch starts at 256 KiB.
Return `-2` doubles capacity before retrying.
Growth stops at 4 MiB.
Successful bytes copy into owned buffers.

## Calling model

`image_proc_transform` is a **synchronous** call that blocks the calling thread's event loop for
the duration of the transform (~1–5 ms for the small key images used by supported devices). It runs
on the USB worker thread alongside the CORA TCP servers and WebUI on the main thread. Because the
call is synchronous, the single reusable output buffer is safe: the result is copied into a fresh
`Buffer` before any `await` point, so two queued transform tasks cannot share the buffer mid-flight.

The image cache (`ts/src/transform/image-cache.ts`, keyed by model, mode, spec revision, and image hash) short-circuits
repeated transforms, so steady-state usage issues very few FFI calls.

## Output size bounds

| Path | Worst-case output |
|------|-------------------|
| JPEG resize (Mirabox-293) | `max_bytes` cap = 10,240 bytes |
| BMP (Stream Deck Mini 80×80) | `54 + 80×80×3` = 19,254 bytes |
| JPEG splash (MK.2 72×72, Mirabox 112×112) | a few KB |

These examples fit initial scratch capacity.
Larger supported outputs use bounded growth.
Decode limits remain independent of output capacity.
Current limits: 800×500; 900 KiB allocation.

## EXIF auto-rotation

EXIF-based auto-rotation (`kamadak-exif` dependency) was intentionally dropped to reduce binary
size (~33 KB saving). CORA key images are rendered by the Elgato desktop software and are not
expected to carry an EXIF Orientation tag. Explicit rotate/flip via the `rotate`/`flip_h`/`flip_v`
parameters are unaffected and work normally.

If a future use-case requires EXIF auto-rotation, re-add `kamadak-exif = "0.5"` to `Cargo.toml`
and restore the `read_exif_orientation` + orientation-match logic in `lib.rs`.

## HID exports

Declarations live in `src/hid.rs`.
Operational discovery uses these exports:

```c
int32_t mirabox_hid_list_supported(
    const char *filter_spec, char *out_buf, size_t out_len
);
int32_t mirabox_hid_list_all(char *out_buf, size_t out_len);
int32_t mirabox_hid_reset(void);
```

Filters contain comma-separated hexadecimal VID/PID pairs.
Inventory output contains tab-separated device rows.
TypeScript applies model-specific usage matching afterward.
Scan-worker reset preserves native thread affinity.

Legacy exports remain for path/presence lookup:
`mirabox_hid_find_path`, `mirabox_hid_list_paths`,
`mirabox_hid_serial_for_path`, and `mirabox_hid_present`.
Production discovery bypasses those legacy helpers.
No production VID/PID opening fallback exists.

## Strip composition export

`src/blit.rs` defines `image_proc_blit`.
It decodes JPEG/BMP into RGB24 canvases.
Caller supplies dimensions and destination offsets.
Writes clip against canvas bounds.
`ffi/image-proc.ts` declares matching parameter order.
`transform/translator.ts` exposes `blitImage()`.

## Validation

Checked against source: 2026-10-03.
ABI edits require matching Rust/TypeScript signatures.
Fixture tests cannot establish device compatibility.
Hardware captures must verify new protocol behavior.
