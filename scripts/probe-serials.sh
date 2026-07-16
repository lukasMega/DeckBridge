#!/usr/bin/env bash
# Read-only USB serial probe for the deckbridge dock fleet.
# Enumerates IORegistry (never opens a device) and prints, per matching unit:
#   VID:PID  name  serial
# Vendors: 0x6603 (293V3 + K1Pro), 0x5548 (293S), 0x0fd9 (Elgato).
# Purpose: confirm each PHYSICAL dock reports a UNIQUE, per-unit serial before
# we switch deviceKey from the volatile IOKit path to VID:PID:serial.
set -euo pipefail

ioreg -p IOUSB -l -w0 | awk '
  /"idVendor"/            { v=$NF }
  /"idProduct"/           { p=$NF }
  /"USB Product Name"/    { gsub(/^[^"]*"USB Product Name" = /,""); name=$0 }
  /"USB Serial Number"/   { gsub(/^[^"]*"USB Serial Number" = /,""); serial=$0 }
  /\+-o / {
    if (v==26115 || v==21832 || v==4057) {
      printf "VID=0x%04x PID=0x%04x  name=%-28s serial=%s\n", v, p, name, serial
    }
    v=""; p=""; name=""; serial=""
  }
  END {
    if (v==26115 || v==21832 || v==4057) {
      printf "VID=0x%04x PID=0x%04x  name=%-28s serial=%s\n", v, p, name, serial
    }
  }
'
