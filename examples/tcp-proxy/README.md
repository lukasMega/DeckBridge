# tcp-proxy

A TCP relay for DeckBridge's CORA ports (5343 primary, 5344 child). Run it on a
second machine so the Elgato app sees a dock at a foreign IP instead of its own
computer. It also logs each connection's lifecycle and a one-line summary of every
CORA frame. Background: [issue #257](https://github.com/lukasMega/DeckBridge/issues/257).

```
Elgato (Mac A) -> proxy (machine B :5343/:5344) -> DeckBridge (Mac A :5343/:5344)
```

## Requirements

Node 24 on the proxy host (runs the TypeScript directly, no build, no dependencies).

## Run

```sh
node src/index.ts --target-host <deckbridge-ip> [options]
```

Options: `--listen-host` (default `0.0.0.0`), `--main-port`, `--child-port`,
`--target-main-port`, `--target-child-port`, `--frames main|all|off` (default `main`;
the child port carries the image stream, so it is off by default), `--hex`,
`--advertise`, `--advertise-name`, `--sn`, `--pid`. See `--help`.

At startup it prints this host's IPv4 addresses (add one in Elgato) and probes the
target. DeckBridge logs that probe as a short primary connection.

## Reading the close line

```
12:01:09.120 [main #3] closed: first=E how=FIN duration=8123ms bytes E->D=412 D->E=980 frames E->D=5 D->E=5
```

`first` is who closed first: `E` is Elgato, `D` is DeckBridge. `how` is `FIN`, `RST`,
`error <code>`, `timeout` or `local shutdown`. An RST is passed on to the other side
as an RST.

## macOS permissions

On first run allow incoming connections for `node`. On macOS 15+ also allow Local
Network access for your terminal app; without it the connection to the target fails
with `EHOSTUNREACH` or `ENETUNREACH`.

## --advertise (macOS only)

Runs `dns-sd -R` so Elgato discovers the proxy automatically. Copy `sn` and `pid`
from DeckBridge's own advert, taken before you disable its mDNS:

```sh
dns-sd -B _elg._tcp                                # find DeckBridge's instance name
dns-sd -L "Network Stream Deck" _elg._tcp local.   # TXT shows pid=... sn=...
node src/index.ts --target-host <ip> --advertise --sn <sn> --pid <pid>
```
