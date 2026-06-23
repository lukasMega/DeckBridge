# JPEG encoder — deckbridge vendored fork

> **FORK (deckbridge)** of upstream [jpeg-encoder 0.6.1](https://crates.io/crates/jpeg-encoder).
> Package renamed `jpeg-encoder-fork` (lib name stays `jpeg_encoder`). One functional change,
> marked `FORK (deckbridge)` in the source: `encode_image_interleaved_optimized()` — with
> optimized Huffman tables the encoder stays in a **single interleaved scan** (upstream switches
> to one scan per component, which the Mirabox K1 Pro firmware cannot decode; ~20 % smaller files
> than standard tables). Opt-in dep of `../image-proc` via its `jpeg-fork` feature
> (`JPEG_FORK=1 mise run build`); the default build uses upstream from crates.io.
> Background: `.claude/plans/K1Pro/jpeg-artifact-findings.md`. Upstream README follows.

[![docs.rs badge](https://docs.rs/jpeg-encoder/badge.svg)](https://docs.rs/jpeg-encoder/)
[![crates.io badge](https://img.shields.io/crates/v/jpeg-encoder.svg)](https://crates.io/crates/jpeg-encoder/)
[![Rust](https://github.com/vstroebel/jpeg-encoder/actions/workflows/rust.yml/badge.svg)](https://github.com/vstroebel/jpeg-encoder/actions/workflows/rust.yml)

A JPEG encoder written in Rust featuring:

- Baseline and progressive compression
- Chroma subsampling
- Optimized huffman tables
- 1, 3 and 4 component colorspaces
- Restart interval
- Custom quantization tables
- AVX2 based optimizations (Optional)
- Support for no_std + alloc
- No `unsafe` by default (Enabling the `simd` feature adds unsafe code)

## Example
```rust
use jpeg_encoder::{Encoder, ColorType};

// An array with 4 pixels in RGB format.
let data = [
    255, 0, 0,
    0, 255, 0,
    0, 0, 255,
    255, 255, 255,
];

// Create new encoder that writes to a file with maximum quality (100)
let mut encoder = Encoder::new_file("some.jpeg", 100)?;

// Encode the data with dimension 2x2
encoder.encode(&data, 2, 2, ColorType::Rgb)?;
```

## Crate features
- `std` (default): Enables functionality dependent on the std lib
- `simd`: Enables SIMD optimizations (implies `std` and only AVX2 as for now)

## Minimum Supported Version of Rust (MSRV)

This crate needs at least 1.61 or higher.

## License

This project is licensed under either of

* Apache License, Version 2.0, ([LICENSE-APACHE](LICENSE-APACHE) or https://www.apache.org/licenses/LICENSE-2.0)
* MIT license ([LICENSE-MIT](LICENSE-MIT) or https://opensource.org/licenses/MIT)

## Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted 
for inclusion in jpeg-encoder by you, as defined in the Apache-2.0 license, 
shall be dual licensed as above, without any additional terms or conditions.
