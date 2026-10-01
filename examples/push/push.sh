#!/bin/sh
# Push text to a DeckBridge key bound to the channel "demo" (Settings → Push API).
# Needs: DECKBRIDGE_PUSH_TOKEN=dbp_…   (optional: DECKBRIDGE_URL, default http://127.0.0.1:3000)
set -eu
URL="${DECKBRIDGE_URL:-http://127.0.0.1:3000}/api/push/demo"
AUTH="Authorization: Bearer ${DECKBRIDGE_PUSH_TOKEN:?set DECKBRIDGE_PUSH_TOKEN}"

# Set, default TTL (10 minutes)
curl -sS -X POST "$URL" -H "$AUTH" -H 'Content-Type: application/json' -d '{"text":"Hello"}'

# Set with a 30 s TTL and colours
curl -sS -X POST "$URL" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"text":"ALERT\n42","ttl":30,"color":"#ffffff","background":"#b00020"}'

# Delete (the key goes back to "…")
curl -sS -X DELETE "$URL" -H "$AUTH"
