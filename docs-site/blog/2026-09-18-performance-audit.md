---
slug: performance-audit
title: 'Four findings from a performance audit'
authors: [lukas]
tags: [performance]
date: 2026-09-18T12:00
---

DeckBridge sits between a USB panel and the Elgato app, and the thing it must never do is
be slow in the middle. A recent audit of the hot paths turned up four problems worth
writing down — not because the fixes were clever, but because three of them were one line
each, and the measurements kept contradicting the obvious explanation.

{/* truncate */}

## One line made the hottest path 4× slower

`rust/Cargo.toml` had `opt-level = "z"`. That is a sensible default for a project that
ships a single binary and cares about size — except a Cargo profile applies to the
**entire resolved build graph**, not just your own crates. So `image`, `zune-jpeg` and the
vendored jpeg-encoder were all being compiled for size too: DCT, quantize, Huffman
bit-packing, resize kernels and colour conversion, every tight numeric loop in the image
pipeline, with inlining and vectorization suppressed.

| build | per image | dylib |
|---|---|---|
| `opt-level = "z"` | 3.50 ms | 522 KB |
| `opt-level = 3` | **0.91 ms** | 719 KB |

The +192 KB of dylib is gzip+base64-embedded into the binary, so the shipped cost is
+69 KB. Output bytes are byte-identical between the two builds.

We also measured the "obvious" compromise — per-package `opt-level` overrides, keeping
`"z"` global — and rejected it: same speed, and a *larger* binary than going global,
because fat LTO across mixed opt-levels bloats the output.

## 55 ms of blocking, every 2 seconds, forever

Every exported HID function called `HidApi::new()` internally, which in hidapi is
`hid_init()` plus a system-wide `hid_enumerate()` — on macOS, an IOKit walk over every HID
device attached to the machine. Measured 3.06 ms.

That would be fine once. But the multi-dock scan ran every 2 seconds, and for each of the
16 device models it queried one path list per USB product id — 18 native calls per tick.
Roughly 55 ms of contiguous blocking on the thread that also runs the CORA ACK loop. CORA
image chunks are ACK-paced (the Elgato app waits for our ACK before sending the next
chunk), so a tick landing mid-burst directly stalls image delivery.

Both obvious fixes turned out to be worthless, which is why they are written down:

- **Hoisting `HidApi` into a `OnceLock` gains nothing.** You still have to call
  `refresh_devices()`, which still enumerates. 3.38 ms/call after hoisting vs 3.31 ms
  before. `hid_init()` was never the cost.
- **Gating on a presence check gains nothing.** The presence check is *itself* a full
  enumeration, so it trades 18 enumerations for 16.

The win only comes from changing the shape: do **one** enumeration per tick and match all
models against that snapshot in TypeScript. 56.84 ms → 3.16 ms. Enumeration now also lives
in a dedicated worker, so it cannot block the ACK loop at all.

## The ACK was queued behind a log line nobody read

In the child server's frame path, the log emit ran *before* the socket write:

```ts
this.emitLog(isNoisy ? 'debug' : 'info', `child tx: ${desc} (${frame.length}B)`);
this.client?.write(frame); // the ACK bytes, finally
```

Building the template string, dispatching an EventEmitter event and forwarding it into the
logger — all of which then **discarded** it, because these entries are debug-level and the
shipped default is `info`. Pure waste, per ACK, hundreds of times per profile load,
directly in front of the write. The base class already had it the right way round.

The same theme showed up three more times: strings interpolated before a level check
(JavaScript has no lazy argument evaluation, so gating inside the logger does not help —
you have to gate the *call site*), log entries broadcast one-at-a-time while comm entries
were correctly batched, and `JSON.stringify` running for WebSocket clients that did not
exist. That last one is now a one-line `if (this.clients.size === 0) return;`.

## The cache key cost more than the work it was avoiding

This one only became visible *because* of the first fix. The image cache is keyed on an
FNV-1a hash of the incoming frame, computed on the USB worker for every image — and
critically, **before** the cache lookup, so a cache *hit* pays it in full.

Byte-at-a-time in QuickJS, which has no JIT:

| input | hash | the transform it guards |
|---|---|---|
| 8 KB CORA JPEG | 1.60 ms | 0.91 ms |
| 19 KB gen1 BMP | 3.72 ms | 0.91 ms |

The guard had become more expensive than the thing it was guarding. Reading the aligned
prefix through a `Uint32Array` instead — same full-buffer coverage, four bytes per
interpreter iteration — measured **4.2×**: 0.38 ms and 0.88 ms. On a 15-key profile load
that is 24 ms → 5.7 ms, and 56 ms → 13 ms.

The interesting part was the bug in the middle. The first version consumed a whole word
per step and finished with a murmur3 avalanche, which looks fine and is badly broken:
**5053 collisions in 20 000 single-byte variants**, where the byte-wise version had zero.

The cause is arithmetic. `FNV_PRIME` is `0x01000193`, which is 2²⁴ + 0x193, so multiplying
carries bits *upward only*. Consume four bytes at once and a difference confined to a
word's top byte lane can never leave that lane — `(d<<24)·P mod 2³²` collapses to
`(d·0x93 mod 256)<<24`, just 256 reachable digests for every such change. Roughly a
quarter of all single-byte edits land there. Byte-wise FNV never has this problem because
every byte enters at lane 0 with the whole remaining chain to diffuse through.

A final avalanche cannot rescue it, which is the part worth internalising: `fmix32` is a
bijection, so by the time you apply it the collisions have already happened. The fix is one
operation *inside* the loop — `h ^= h >>> 15` — which diffuses high bits back down. Zero
collisions, and the speedup survives.

For a cache key, a collision is not a slow path. It is a wrong image on a key, silently.
The hash had already been reverted once before for exactly that reason: an earlier version
sampled the first and last 4 KB for large buffers, which for a 19 KB gen1 BMP is the top
and bottom border rows, so a small centred icon on a black background hashed identically to
a blank black frame and the key rendered black.

## What this cost, and what it did not

The two-thread split that the architecture is built around was justified in the docs by a
"50–200 ms transform". That figure was wrong by 10–40×; the real number is under a
millisecond. The split is still right, but for a different reason — the burst of blocking
`hid_write` chunk uploads that follows the transform stalls the ACK loop far longer than
the transform ever did. A rationale that names the wrong cause will eventually send someone
optimizing the wrong thing, so all four places that quoted it have been corrected.

Several plausible-looking findings did not survive measurement and were dropped: switching
the Lanczos3 resize filter to Triangle (0.17 ms, against a real quality risk), replacing
byte-arithmetic buffer accessors with `DataView` (not faster in an interpreter), and using
a `postMessage` transfer list to avoid copying image bytes across the thread boundary —
txiki accepts one but detaches the buffers and clones the contents regardless, so it is
equal-or-slower at every size from 4 KB to 1 MB.

The numbers, the harness to reproduce them, and the rejected alternatives are in
`rust/PERF.md` and [the image-flow docs](/image-flow#image-cache-hash).
