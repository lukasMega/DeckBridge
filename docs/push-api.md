# Push API

Other tools can write text onto DeckBridge's display-only keys: the side keys and the AKP05/AKP05E touch strip zones. OBS scripts, Home Assistant, Bitfocus Companion, cron jobs and shell scripts send one HTTP request. The key shows the text. When the sender stops, the text expires after a time-to-live (TTL).

## How it works

1. Pick a **channel** name, such as `obs-rec`.
2. In the [Web UI](http://localhost:3000), choose **Push API (external)** as a key's widget and enter the channel name.
3. In **Settings → Push API**, create a token.
4. `POST` text to `/api/push/<channel>` with the token.

A token can only reach keys you bound to a channel. A value pushed before any key is bound is kept and appears as soon as one is.

```bash
export DECKBRIDGE_PUSH_TOKEN=dbp_…
curl -X POST http://127.0.0.1:3000/api/push/obs-rec \
  -H "Authorization: Bearer $DECKBRIDGE_PUSH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"REC\n00:05","ttl":5,"background":"#b00020"}'

curl -X DELETE http://127.0.0.1:3000/api/push/obs-rec \
  -H "Authorization: Bearer $DECKBRIDGE_PUSH_TOKEN"
```

Or from the command line: `deckbridge push obs-rec 'hi' --ttl 10`.

## Requests

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/push/:channel` | Set the channel's value (replaces the old one) |
| `DELETE` | `/api/push/:channel` | Drop the value now (always `204`) |

Channel names: 1–32 characters of `a-z 0-9 . _ -`, starting with a letter or digit. Upper case is lower-cased.

`POST` body (`Content-Type: application/json`, at most 4096 bytes):

| Field | Rule |
| --- | --- |
| `text` | Required string. At most 256 characters after cleanup. `\n` starts a new line; four lines are drawn. |
| `ttl` | Optional whole seconds, `1`–`86400`; default `600`; `0` never expires. |
| `color`, `background` | Optional `#rrggbb`, for this value only. |

Unknown fields are rejected. Success returns `{ "ok": true, "channel", "expiresAt", "bound", "replaced", "truncated" }`. `bound` counts keys on connected decks that show the channel; `0` is not an error.

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid_json`, `invalid_field`, `invalid_channel` | Bad body, field or channel name |
| 401 | `unauthorized` | Missing or unknown token |
| 403 | `forbidden_origin`, `insufficient_scope` | Browser request, or token lacks `push` |
| 404 / 405 | `not_found`, `method_not_allowed` | Wrong path or method |
| 409 | `channel_limit` | 64 channels hold live values |
| 413 / 415 | `payload_too_large`, `unsupported_media_type` | Body over 4096 bytes, or not JSON |
| 429 | `rate_limited` | Slow down; see `Retry-After` |

Concurrent senders are last-write-wins.

## Expiry

| State | The key shows |
| --- | --- |
| Waiting (nothing pushed since start, or `DELETE`d) | `…` |
| Live | The pushed text |
| Expired | Per key: **Dim last value** (default), **Blank**, or **Show text** (your fallback) |

Pushed values live in memory only; they are gone after a restart. To show the fallback on purpose, push with a short TTL: `DELETE` returns the key to `…`.

## Text

The key font covers ASCII, Latin-1 and `…`. Common typography is folded (curly quotes, dashes, `€` → `EUR`). Anything else, such as emoji or CJK, shows as `?`; the response reports how many in `replaced`.

## Limits

- Per token: 20 requests burst, 10 per second.
- All tokens: 50 burst, 25 per second.
- Failed authentication: 10 per minute per address, then `429`.
- 16 tokens, 64 channels.

## Security

- Tokens look like `dbp_…` and are stored only as SHA-256 hashes in `settings.json`. They are never exported, imported or put in diagnostics reports. The plaintext is shown once, at creation or rotation.
- Without a token the API is closed. A token works on `/api/push/*` only, never on the admin routes.
- A request with a browser `Origin` header is refused, so a web page cannot push.
- The Web UI binds `127.0.0.1` unless you pass `--bind`. With `--bind 0.0.0.0` LAN clients can push, over **plain HTTP**: a token can be sniffed. Use one token per integration, revoke the one that leaks, and rotate after exposure. The admin Web UI has no authentication on a LAN bind.

## Examples

- `examples/push/push.sh` — curl.
- `examples/push/home-assistant.yaml` — a `rest_command` and an automation.
- `examples/push/obs-rec-timer.py` — an OBS Python script (untested in OBS).
- Bitfocus Companion: use its generic HTTP request action with a custom `Authorization` header and a JSON body (not tested).
