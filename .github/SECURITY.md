# Security Policy

> **Disclaimer:** This is a hobby project maintained in spare time, with no
> warranty. Security reports and all other requests are handled on a best-effort
> basis with **no guaranteed priority, response time, or fix**. Do not rely on
> deckbridge in security-sensitive deployments.

## Supported versions

This is an actively developed hobbyist project. Security fixes are applied to
the `main` branch only. There are no long-term support releases; please track
`main`.

## Reporting a vulnerability

**Do not report security vulnerabilities through public issues, pull requests,
or discussions.**

Instead, report privately by email to **bag.i.can [at] gmail [dot] com**. If the repository
host supports private vulnerability reporting (e.g. GitHub Security Advisories),
you may use that instead.

Please include:

- The affected version or commit.
- A description of the vulnerability and its impact.
- Steps to reproduce, including any proof-of-concept.
- Affected device/OS if relevant.

## What to expect

Best-effort only — there is no guaranteed response time or fix timeline.

- **Acknowledgement** when a maintainer next has time (may take a while).
- An assessment and, if confirmed and time permits, a fix.
- Credit for the report once a fix is released, unless you prefer to remain
  anonymous.

## Scope

deckbridge bridges a USB stream deck to Elgato software over the network
(CORA / Elgato legacy). Relevant concerns include, but are not limited to:

- Unauthenticated network access to the emulated dock (TCP 5343/5344, mDNS) and
  the web UI (port 3000).
- Buffer handling of fixed-size protocol packets and HID reports.
- Memory safety in the Rust FFI image pipeline (`deckbridge-native`).

Note that by design deckbridge exposes a device on the local network without
authentication, mirroring Elgato's own protocols. Deploy it only on trusted
networks.
