# deckbridge-native

Rust cdylib that provides native-OS capabilities for `deckbridge`: JPEG/BMP image transforms
and (behind the `usb` Cargo feature) HID device-path enumeration. Loaded in-process at runtime
over txiki.js FFI. The image transform replaces the former subprocess sidecar (TCP reverse-connect
+ JSON/base64 protocol).

## Loading

The compiled shared library (`libdeckbridge_native.dylib` on macOS, `libdeckbridge_native.so` on Linux,
`deckbridge_native.dll` on Windows) is loaded at runtime by `ts/src/ffi/image-proc.ts` (and
`ts/src/ffi/hidapi.ts` for the HID export) using `FFI.dlopen(process.env.DECKBRIDGE_NATIVE_LIB)`. The
`DECKBRIDGE_NATIVE_LIB` environment variable must point to the absolute path of the library; `mise run
start` sets it automatically via `mise.toml`.

The library is embedded inside the compiled `deckbridge` binary and extracted at runtime to a
per-version cache directory (`ts/src/native-libs.ts`), which sets `DECKBRIDGE_NATIVE_LIB` itself. The
env var is otherwise an optional override for dev/power-user use.

## Build

```bash
cd rust/deckbridge-native
cargo build --release
# Output: target/release/libdeckbridge_native.dylib  (macOS)
#         target/release/libdeckbridge_native.so      (Linux)
#         target/release/deckbridge_native.dll        (Windows)
```

Default build (no `usb` feature) is pure Rust — no C/system library dependencies. Cross-compiles
with a plain `cargo build --release --target <triple>` on all three platforms. The `usb` feature
(enables `mirabox_hid_find_path`) adds a dependency on `hidapi`.

**Crate type:** `crate-type = ["cdylib"]`

**Panic strategy:** `panic = "unwind"` (required so that `catch_unwind` at the FFI boundary can
catch panics from third-party codec code and return `-3` instead of aborting the host process).

**JPEG encoder backend (cargo feature, exactly one):** output is always baseline 4:2:0 with a
single interleaved scan — the only format every supported device decodes (K1 Pro probe round 5).

- `jpeg-upstream` (default) — crates.io `jpeg-encoder 0.6.1`, standard Huffman tables.
- `jpeg-fork` — vendored `../jpeg-encoder` fork: optimized Huffman tables kept in the single
  interleaved scan (~20 % smaller files, identical pixels). Build via `JPEG_FORK=1 mise run build`
  (= `cargo build --release --no-default-features --features jpeg-fork`).

Upstream's `set_optimized_huffman_tables(true)` must never be used directly: it emits one scan per
component, which the K1 Pro firmware renders as chroma garbage. See
`.claude/plans/K1Pro/jpeg-artifact-findings.md`.

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
    uint8_t       *out_buf,
    size_t         out_cap,
    uint8_t       *err_buf,
    size_t         err_cap
);
```

No heap ownership crosses the boundary — the caller owns all buffers.

### TypeScript binding

`ts/src/ffi/image-proc.ts` loads the symbol via `FFI.dlopen` (the same pattern as
`ts/src/ffi/hidapi.ts` — both `dlopen` `DECKBRIDGE_NATIVE_LIB`). The caller allocates a reusable 256 KB
output scratch buffer (`new Uint8Array(256 * 1024)`) which covers all current paths — worst case
is a Mini 80×80 BMP at ~19 KB. On a `-2` return the caller may allocate a larger buffer and retry.

## Calling model

`image_proc_transform` is a **synchronous** call that blocks the calling thread's event loop for
the duration of the transform (~1–5 ms for the small key images used by supported devices). It runs
on the USB worker thread alongside the CORA TCP servers and WebUI on the main thread. Because the
call is synchronous, the single reusable output buffer is safe: the result is copied into a fresh
`Buffer` before any `await` point, so two queued transform tasks cannot share the buffer mid-flight.

The image cache (`ts/src/image-cache.ts`, FNV-1a keyed by device model + image hash) short-circuits
repeated transforms, so steady-state usage issues very few FFI calls.

## Output size bounds

| Path | Worst-case output |
|------|-------------------|
| JPEG resize (Mirabox-293) | `max_bytes` cap = 10,240 bytes |
| BMP (Stream Deck Mini 80×80) | `54 + 80×80×3` = 19,254 bytes |
| JPEG splash (MK.2 72×72, Mirabox 112×112) | a few KB |

A 256 KB scratch buffer covers all of these with ample headroom.

## EXIF auto-rotation

EXIF-based auto-rotation (`kamadak-exif` dependency) was intentionally dropped to reduce binary
size (~33 KB saving). CORA key images are rendered by the Elgato desktop software and are not
expected to carry an EXIF Orientation tag. Explicit rotate/flip via the `rotate`/`flip_h`/`flip_v`
parameters are unaffected and work normally.

If a future use-case requires EXIF auto-rotation, re-add `kamadak-exif = "0.5"` to `Cargo.toml`
and restore the `read_exif_orientation` + orientation-match logic in `lib.rs`.

## Exported C function (usb feature): mirabox_hid_find_path

Behind the `usb` Cargo feature, the crate also exports HID device-path enumeration (source in
`src/hid.rs`):

```c
int32_t mirabox_hid_find_path(
    uint16_t vid,
    uint16_t pid,        // 0 = match any product ID
    uint16_t usage_page,
    uint16_t usage,
    char    *out_buf,
    size_t   out_len
);
// Returns 1 + writes null-terminated path into out_buf, or 0 if not found.
```

`libhidapi` exposes `hid_open(vid, pid)` which opens the **first** matching interface. On macOS
this picks whichever IOKit interface the kernel serves first — often the system-claimed one, not
the data interface. `mirabox_hid_find_path` wraps the full `hid_enumerate()` loop so the
TypeScript side can filter by `usage_page` and `usage` before opening, then opens by path via
`hid_open_path()`.

`ts/src/ffi/hidapi.ts` (`loadHidEnum()` / `findHidPath()`) loads this symbol from the same
`DECKBRIDGE_NATIVE_LIB`. If the lib is unavailable, `findHidPath()` returns `null` and the caller falls
back to plain `hid_open(VID, PID)` with retries. See `rust/README.md` for the full open-fallback
flow.
