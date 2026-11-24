---
sidebar_position: 6
sidebar_label: Device check
title: Device check — fix the key images of an untested deck
slug: /verify-device
description: Use the device check wizard to fix rotated, mirrored, shuffled, cut-off or black key images on an untested deck, then send the report.
---

# Device check

Many decks in the [supported devices](./devices.mdx) list are *untested*: their settings come from a similar board or from documents. If your keys look rotated, mirrored, shuffled, cut off or black, the device check fixes it. You pick the picture that matches your deck. It saves the result as device tuning and gives you a report to send back.

## Where to find it

- **The banner.** When an untested deck connects, a banner asks **Untested deck. Check its images?** Choose **Check my device**. **Not now** hides it until DeckBridge restarts. **Don't ask again** remembers your choice for that model.
- **Settings → Device tuning → Check images step by step** opens the same wizard for any supported deck.

It works only for USB decks whose images DeckBridge converts. It is not offered for Elgato's own decks, for the [browser deck](./browser-deck.md), or in safe mode. Only one check per model can run at a time.

## What happens to your deck

Your deck shows test images instead of your Stream Deck app images: numbered coloured keys with an arrow and an **F**, three colour bars, and coloured rings. It does not dim or sleep, and the Stream Deck app does not need to be connected.

When you save or press **Cancel**, the app's images come back. If you just close the page, the check ends by itself after about 30 seconds. You then see **Session ended. Your deck shows its normal images again.** and a **Start again** button.

## The steps

The wizard is **Check your deck**, with **Step n of N** at the top (the number of steps depends on your deck). The first screen shows your deck. Only the numbered, coloured keys are checked. Dashed parts are not: [side keys](./side-keys.md) (the right column of an AKP05 or 293S-type deck), dials and the touch strip. So a Stream Deck + checks 8 keys even if it has 10: the app's 4 × 2 grid sits on the left four columns.

Press **Start**. Until you save, every step has **Back** and **Cancel**. Answer with what you see on the deck, and pick the small picture that matches. If you see **This browser can't draw test images.**, open the DeckBridge page in another browser.

1. **Visible keys.** *Do all keys show a number?* If keys are black or garbled, the wizard lowers the image size limit and JPEG quality step by step and asks *All keys show a number now?* If keys are still black at the lowest setting, the check stops with **Not fixed**. Nothing is saved, but the report still helps.
2. **Orientation.** *Which one matches your keys?* Pick the picture whose arrow and **F** look like your keys. The wizard turns the image and asks *Upright now?*
3. **Colours.** *Colours, left to right?* Only recorded (see [What the wizard cannot fix](#what-the-wizard-cannot-fix)).
4. **Key order.** *Which layout matches your deck?* Pick the matching grid. If none matches, choose **None**, tap where your deck shows each number in turn, then press **Continue**. The wizard asks *Numbers in order now?*
5. **Size.** *What do the rings show?* Answer **Outer ring cut off** or **Black gap outside** until the deck shows **All rings, no gap**. If even the smallest size cuts the outer ring, it keeps the saved size. **Other** is recorded.
6. **Confirm.** *All keys look right?* **Yes, save** saves. **No** asks *What is wrong?* and goes back to that step.
7. **Your own images.** If the Stream Deck app already sent images, the wizard asks *Do your Stream Deck images look right?* Only recorded. If saving reconnects your deck, wait for it to come back before you answer.
8. **Buttons.** *Does each press act on the right key?* **No** opens key-map learn mode: press **Start learn mode**, press each key as asked, then **Save this map**. **Skip** keeps the current map. Only for the first deck.

After you save, you cannot go back. The last screen says **Saved**. Close it with **Done**.

## What gets saved

**Yes, save** stores the result as [device tuning](./troubleshooting.md#device-tuning) under `modelOverrides` in `settings.json`. It applies to every deck of that model, and the banner for that model is turned off.

To undo it:

- **Settings → Device tuning → Reset** returns the model to its built-in defaults.
- Safe mode ignores all device tuning for one session: `./deckbridge run --no-overrides` or `DECKBRIDGE_NO_OVERRIDES=1`. The tuning stays in `settings.json` and applies again on the next normal start.

<details>
<summary>What the saved tuning contains</summary>

Depending on your answers: image rotation and flip, image size, JPEG quality and size limit, key order, the key map from the Buttons step, and the startup splash orientation (only when the image orientation changed). An orientation change also changes the splash and reconnects the deck once. Key order and a new key map apply without a reconnect.

</details>

## What the wizard cannot fix

- **Crop and image fit.** The test images cannot show a dead border or off-centre art in the app's images. Use **Image fit** and **Crop…** in [Device tuning](./troubleshooting.md#device-tuning).
- **Colours.** If red and blue are swapped, the report records it, but no setting can fix it yet.
- **Touch strips, dials and extra keys.** The first screen marks them as dashed.

## The report

The last screen offers **Copy report** and **Open GitHub issue**. The second opens a prefilled *Device check report* issue in your browser. You review and submit it yourself. If the report is too long for the link, the wizard copies it to your clipboard; paste it into the **Wizard report** field. Nothing is sent automatically. Maintainers use the report to correct the model and mark it as tested.

<details>
<summary>What the report contains</summary>

A short JSON text with the model id, the Stream Deck model it is shown as (if it emulates one) and the DeckBridge version; your answers at each step and a result per area (`pass`, `fixed`, `fail` or `unknown`); the device tuning saved for that model (the override JSON); and the raw codes of your last few key presses on the first deck, if any. It does not include the rest of `settings.json`, your key commands or file paths.

</details>
