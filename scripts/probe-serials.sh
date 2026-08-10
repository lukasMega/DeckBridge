#!/usr/bin/env bash
# Read-only USB serial probe for the deckbridge dock fleet.
# Enumerates IORegistry (never opens a device) and prints, per matching unit:
#   VID:PID  name  serial
# Vendors: 0x6603 (293V3/HSV293SV3 + K1Pro), 0x5548 (293S + Ajazz AKP153), 0x0300 (Ajazz
# AKP153E/R rev. 1 and rev. 2), 0x0fd9 (Elgato), 0x0b00 (Mars Gaming MSD-ONE),
# 0x0c00 (Mad Dog GK150K), 0x0a00 (Risemode Vision 01), 0x0500 (TMICE Stream Controller).
# Purpose: confirm each PHYSICAL dock reports a UNIQUE, per-unit serial before
# we switch deviceKey from the volatile IOKit path to VID:PID:serial.
set -euo pipefail

ioreg -p IOUSB -l -w0 | awk '
  /"idVendor"/            { v=$NF }
  /"idProduct"/           { p=$NF }
  /"USB Product Name"/    { gsub(/^[^"]*"USB Product Name" = /,""); name=$0 }
  /"USB Serial Number"/   { gsub(/^[^"]*"USB Serial Number" = /,""); serial=$0 }
  /\+-o / {
    if (v==26115 || v==21832 || v==768 || v==4057 || v==2816 || v==3072 || v==2560 || v==1280) {
      printf "VID=0x%04x PID=0x%04x  name=%-28s serial=%s\n", v, p, name, serial
    }
    v=""; p=""; name=""; serial=""
  }
  END {
    if (v==26115 || v==21832 || v==768 || v==4057 || v==2816 || v==3072 || v==2560 || v==1280) {
      printf "VID=0x%04x PID=0x%04x  name=%-28s serial=%s\n", v, p, name, serial
    }
  }
'
