#!/usr/bin/env bash
# Upload release artifacts to VirusTotal; emit `<file>=<url>` lines to $VT_OUT.
# Per-file retries: one artifact's 5xx must not cost the others their scan links.
set -uo pipefail

: "${VT_API_KEY:?VT_API_KEY is required}"
VT_OUT="${VT_OUT:-vt-analysis.txt}"
MAX_ATTEMPTS="${VT_MAX_ATTEMPTS:-4}"
RATE_SLEEP="${VT_RATE_SLEEP:-16}" # free tier: 4 requests/min

: > "$VT_OUT"
failed=0
total=0

# VT's plain /files endpoint caps at 32 MB; a per-file upload_url has no such cap
# and works for small files too, so always take that path.
upload_one() {
  local file=$1 upload_url id
  upload_url=$(curl -sS --fail-with-body --max-time 60 \
    -H "x-apikey: $VT_API_KEY" \
    https://www.virustotal.com/api/v3/files/upload_url | jq -r '.data // empty')
  [ -n "$upload_url" ] || return 1

  id=$(curl -sS --fail-with-body --max-time 900 \
    -H "x-apikey: $VT_API_KEY" \
    -F "file=@${file}" "$upload_url" | jq -r '.data.id // empty')
  [ -n "$id" ] || return 1

  printf '%s=%s\n' "$file" "https://www.virustotal.com/gui/file-analysis/${id}/detection" >> "$VT_OUT"
}

for file in "$@"; do
  [ -f "$file" ] || continue
  total=$((total + 1))
  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    if upload_one "$file"; then
      echo "uploaded: $file"
      break
    fi
    if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
      echo "::warning::VirusTotal upload failed after ${MAX_ATTEMPTS} attempts: $file"
      failed=$((failed + 1))
      break
    fi
    backoff=$((RATE_SLEEP * attempt))
    echo "retry ${attempt}/${MAX_ATTEMPTS} for $file in ${backoff}s"
    sleep "$backoff"
  done
  sleep "$RATE_SLEEP"
done

echo "VirusTotal: $((total - failed))/${total} uploaded"
# Never fail the release on scan-link trouble; the release body degrades instead.
exit 0
