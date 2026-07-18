# Contributing

Thanks for your interest in improving **deckbridge** — a standalone binary (no
Node.js) that bridges a USB stream deck to Elgato software over TCP/CORA, built
on [txiki.js](https://github.com/saghul/txiki.js) (QuickJS-ng + libuv + libffi).
TypeScript source in `deckbridge/ts/src/`, Rust cdylib in
`deckbridge/rust/deckbridge-native/`.

Please read this guide before opening an issue or pull request.

> **Disclaimer:** This is a hobby project maintained in spare time. Issues, pull
> requests, and security reports are handled on a best-effort basis with no
> guaranteed response time, priority, or commitment to fix or merge. Thanks for
> your patience.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating you agree to uphold it. Report unacceptable behavior to
**bag.i.can@gmail.com**.

## Before you start

- Search existing [issues](../../issues) and
  [pull requests](../../pulls) to avoid duplicates.
- For anything larger than a small fix, open an issue first so we can agree on
  the approach before you invest time.
- Never report a security vulnerability in a public issue — see
  [SECURITY.md](SECURITY.md).

## Development setup

Requires `libhidapi`. From `deckbridge/`:

```bash
mise run build      # bundle TS + build Rust cdylib
mise run compile    # produce ./deckbridge binary
mise run test       # run the test suite
./deckbridge        # or: mise run start
```

Tests live in `deckbridge/ts/test/*.test.ts` and use `tjs:assert` (no external
framework).

## Making changes

- Keep changes surgical. Touch only what the fix or feature requires; don't
  reformat or refactor unrelated code.
- Match the existing style of the file you're editing.
- Update docs (`README.md`, `ARCHITECTURE.md`, `CLAUDE.md`) when behavior
  changes.
- Add or update tests where relevant.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add K1 Pro brightness control
fix: drop last byte of full 1024B JPEG chunk
docs: clarify libhidapi requirement
```

Keep the subject line under ~72 characters. Use the body to explain *why*, not
*what*, when it isn't obvious.

## Pull requests

1. Fork and create a branch off `main`.
2. Make your change; ensure the build and tests pass.
3. Fill out the pull request template.
4. Link any related issue (`Closes #123`).

We review for correctness, scope, and fit. Small, focused PRs merge fastest.

## Reporting bugs

Use the **Bug report** issue template. Include the device model, binary version,
and exact steps to reproduce. Quote error output verbatim.

## Requesting features

Use the **Feature request** issue template. Describe the problem you're trying
to solve, not just the solution you have in mind.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](../LICENSE) that covers this project.
