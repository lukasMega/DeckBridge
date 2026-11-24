---
sidebar_position: 5
sidebar_label: Browser deck
title: Browser deck — use your phone as a Stream Deck
slug: /browser-deck
description: Use your phone or tablet to control Stream Deck actions. Connect it to DeckBridge, then pair it with the Elgato app.
---

# Browser deck

Use your phone or tablet as a **15-key Stream Deck** (5 × 3, no dials or touch strip).
Tap keys to run actions from the Elgato app. **No USB deck needed.** It is off until you turn it on.

## What you need

- DeckBridge on your computer, and the Elgato Stream Deck app.
- Phone, DeckBridge and Elgato app on the **same network**.
- Safari on iOS / iPadOS **12.2+**, Chrome **80+** on Android **7+**, or any current desktop browser.

## Set it up

1. **Turn it on.** **Settings → Browser deck → Use a phone or tablet as a deck**.
2. **Connect your phone.** Press **Pair a device**. On the phone, open the address shown
   and enter the **6-digit code** (or scan the QR code). A code expires after five minutes.
3. **Connect the Elgato app.** Choose **Add Network Device…** and enter the IP address and
   port shown in DeckBridge. If the address is already in use, see **Need another address?** below.
4. **Add your actions.** Select the new deck in the Elgato app, set up its keys, then tap them on your phone.

DeckBridge shows **Browser: Connected** and **Elgato app: Paired**. You need both.

## QR code

The QR code is optional. The address and 6-digit code work without it.

<details>
<summary>What the QR code downloads</summary>

DeckBridge has no QR library built in. When you ask for a QR code, it downloads
**qrcode-generator 1.4.4** (MIT licence, about 55 kB) from the jsDelivr CDN:
`https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js`.

- The request leaves your computer, so jsDelivr sees it.
- The file is checked against a subresource-integrity hash
  (`sha384-8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k`) taken from the
  npm tarball, not only the CDN copy. A file that does not match is not run.
- It runs in an isolated frame that cannot reach DeckBridge.

</details>

### One dock per IP address

The Elgato app accepts one dock per IP address, so each deck needs its own address.
Open **Need another address?** in DeckBridge, follow the steps for your system,
press **Test**, then use the address shown. DeckBridge never runs commands for you.

## Using the deck

- **Tap** to press. **Hold** for long-press actions.
- **Green dot:** connected. **Amber dot:** reconnecting.
- Keep the screen awake with your phone's **Auto-Lock / Screen timeout** setting.
- **Add to Home Screen** gives quick access (full screen on iOS).

## Security

Use a **trusted private network**. The connection is plain HTTP (not encrypted),
so someone on that network could copy access and press your keys.
Remove devices in **Settings → Browser deck → Revoke**, or use **Revoke all**.

## Troubleshooting

| Problem | Try this |
|---|---|
| Phone cannot connect | Same network? Use the address shown in DeckBridge. Allow TCP **44660** in your computer's firewall. |
| Code expired | Press **Pair a device** again. Each code works once. |
| Elgato app refuses pairing | Follow [One dock per IP address](#one-dock-per-ip-address). |
| Address stopped working | Reopen Settings to see the current address. |
| Keys respond slowly | Improve the Wi-Fi signal or try 5 GHz. |

<details>
<summary>Advanced settings and limits</summary>

| Item | Default / limit |
|---|---|
| Browser page port | **44660**; change with `DECKBRIDGE_DECK_PORT` if occupied |
| Elgato connection ports | **5349 / 5350**; shift with `DECKBRIDGE_CORA_PORT` |
| Paired devices | **8** saved devices; **4** pages connected at once |
| Pairing code | Single-use; expires after **5 minutes** or **5 wrong attempts** |

- All open pages share the same keys and profile.
- If you lock your phone, held keys are released within about four seconds. Delayed presses are dropped.
- `--bind 127.0.0.1` blocks access from phones and tablets.
- Device access cannot change DeckBridge settings or use the [Push API](./push-api.md).
- You must turn this on in the web UI. Importing settings cannot turn it on.
- For connection timing, add `?debug=1` to the browser deck address.

</details>
