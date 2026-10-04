---
sidebar_position: 5
sidebar_label: Browser deck
title: Browser deck — use your phone as a Stream Deck
slug: /browser-deck
description: Use your phone or tablet to control Stream Deck actions. Connect it to DeckBridge, then pair it with the Elgato app.
---

# Browser deck

Use your phone or tablet as a **15-key Stream Deck**. Tap the keys to run actions
from the Elgato app. **No USB deck needed.**

This feature stays off until you enable it.

## What you need

- DeckBridge running on your computer.
- The Elgato Stream Deck app.
- Your phone, DeckBridge and Elgato app on the **same network**.

<details>
<summary>Supported browsers</summary>

| Device | Browser |
|---|---|
| iPhone / iPad | Safari, iOS / iPadOS **12.2+** |
| Android | Chrome **80+**, Android **7+** |
| Computer | Any current desktop browser |

</details>

## Set it up

1. **Enable it.** In DeckBridge, open **Settings → Browser deck**.
   Turn on **Use a phone or tablet as a deck**.
2. **Connect your phone.** Press **Pair a device**.
   On your phone, open the shown address and enter the **6-digit code**.
   Or scan the QR code, if enabled. Codes expire after five minutes.
3. **Connect the Elgato app.** Choose **Add Network Device…**.
   Enter the IP address and port shown in DeckBridge.
   If that address is already used, follow **Need another address?** below.
4. **Add your actions.** Select your newly added deck in the Elgato app.
   Set up its keys, then tap them on your phone.

DeckBridge shows two separate checks: **Browser: Connected** and **Elgato app: Paired**.
Both are needed.

QR codes need an optional download. The address and code work without it.

### One dock per IP address

Each deck needs a different IP address in the Elgato app.
Open **Need another address?** in DeckBridge. Follow the steps for your system,
press **Test**, then use the address shown. DeckBridge never runs commands for you.

## Using the deck

- **Tap** to press. **Hold** for long-press actions.
- **Green dot:** connected. **Amber dot:** reconnecting.
- Keep the screen awake using your phone's **Auto-Lock / Screen timeout** settings.
- Use **Add to Home Screen** for quick access. On iOS, this also opens full screen.
- Layout: **15 keys (5 × 3)**, without dials or a touch strip.

## Security

Use a **trusted private network**. The connection uses unencrypted HTTP.
Someone monitoring that network could copy access and press your keys.

Remove lost or unwanted devices in **Settings → Browser deck → Revoke**.
Use **Revoke all** to disconnect everyone.

## Troubleshooting

| Problem | Try this |
|---|---|
| Phone cannot connect | Check both devices use the same network. Use the address shown in DeckBridge. Allow TCP **44660** through your computer's firewall. |
| Code expired | Press **Pair a device** again. Each code works once. |
| Elgato app refuses pairing | Follow [One dock per IP address](#one-dock-per-ip-address). |
| Address stopped working | Reopen Settings for the current address. |
| Keys respond slowly | Improve Wi-Fi signal or try 5 GHz. |

<details>
<summary>Advanced settings and limits</summary>

| Item | Default / limit |
|---|---|
| Browser page port | **44660**; change with `DECKBRIDGE_DECK_PORT` if occupied |
| Elgato connection ports | **5349 / 5350**; shift with `DECKBRIDGE_CORA_PORT` |
| Paired devices | **8** saved devices; **4** pages connected at once |
| Pairing code | Single-use; expires after **5 minutes** or **5 wrong attempts** |

- All open pages share the same keys and profile.
- Locking your phone releases held keys within about four seconds.
  Delayed presses are dropped.
- `--bind 127.0.0.1` blocks access from phones and tablets.
- Device access cannot control DeckBridge settings or the [Push API](./push-api.md).
- Enable this feature in the web UI. Importing settings cannot enable it.
- For connection timing, append `?debug=1` to the browser deck address.

</details>
