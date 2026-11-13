---
slug: performance-audit
title: 'Four findings from a performance audit'
authors: [lukas]
tags: [performance]
date: 2026-09-18T12:00
---

DeckBridge sits between your USB panel and the Elgato app, so it must never be slow in the
middle. I profiled the hot paths and found four problems. Three were one-line fixes.

<!-- truncate -->

## 1. The build was optimizing for the wrong thing

Rust was set to optimize for size. That setting applies to **every** dependency too — so
the JPEG encoder and image resizer were built for size as well, losing the optimizations
that make their number-crunching fast.

```
time to process one image
  for size   ████████████████████  3.50 ms
  for speed  █████                 0.91 ms  ← 3.8×
```

Cost: 69 KB of extra binary.

## 2. Frozen 55 ms, every 2 seconds, forever

DeckBridge scans for extra decks every 2 seconds. It asked the OS about each supported
device separately — 18 questions, each making the OS walk through every USB device you have
plugged in.

```
time frozen, per scan
  18 lookups  ████████████████████  56.84 ms
  ask once    █                      3.16 ms  ← 18×
```

Worse, it froze the same thread that acknowledges incoming images, and the Elgato app waits
for each acknowledgement before sending more. So a badly timed scan delayed images reaching
your deck.

The fix was to ask once and answer all 18 questions from that one answer. It now runs on a
background thread too.

## 3. An acknowledgement stuck behind a log nobody reads

One spot wrote a log line *before* sending the acknowledgement — a log line then thrown
away, because it's debug detail and DeckBridge ships at normal logging. Build a message,
pass it around, discard it, all while the Elgato app waits. Hundreds of times per profile
load. Swapping two lines fixed it.

## 4. The shortcut was slower than the work

DeckBridge caches processed images. To check the cache it first computes a "fingerprint" of
the incoming image — and after fix #1, that fingerprint cost more than the processing it
was meant to skip:

```
  processing   ███████████           0.91 ms
  fingerprint  ████████████████████  1.60 ms
```

Reading four bytes at a time instead of one fixed it, still reading every byte:

```
fingerprinting cost
  one byte    ████████████████████  1.60 ms
  four bytes  █████                 0.38 ms  ← 4.2×
```

A 15-key profile load went from 24 ms to 5.7 ms. Details in
[the image-flow docs](/image-flow#image-cache-hash).

## Also worth saying

Several good-looking ideas didn't survive measurement and were dropped, including a faster
resize filter (saved 0.17 ms, risked visible quality) and avoiding a copy between threads
(the runtime copies anyway).

And the docs claimed image processing took "50–200 ms", used to justify DeckBridge's
two-thread design. The real number is under a millisecond. The design is still right, but
for a different reason — it's the burst of USB writes *after* processing that would block
things. All four places quoting the wrong figure have been fixed.

Full numbers and how to reproduce them: `rust/PERF.md`.
