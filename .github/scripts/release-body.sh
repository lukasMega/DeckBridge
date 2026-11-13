#!/usr/bin/env bash
{
  echo "see docs: https://lukasmega.github.io/DeckBridge/"
  echo "VirusTotal component comparison: https://lukasmega.github.io/DeckBridge/virustotal"
  echo
  echo "## VirusTotal scans"
  echo
  echo "| Artifact | Report |"
  echo "| --- | --- |"
  for file in artifacts/*.zip artifacts/*-setup.exe artifacts/*.dmg; do
    [ -f "$file" ] || continue
    url=$(grep -F "${file}=" "$VT_OUT" 2>/dev/null | head -n1 | cut -d= -f2-)
    if [ -n "$url" ]; then
      echo "| \`$(basename "$file")\` | [analysis]($url) |"
    else
      echo "| \`$(basename "$file")\` | _scan unavailable_ |"
    fi
  done
  echo
  echo "Verify downloads against \`SHA256SUMS.txt\`."
} > release-body.md
cat release-body.md
