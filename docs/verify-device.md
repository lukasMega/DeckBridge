---
sidebar_position: 6
sidebar_label: Device check
title: Device check — fix the key images of an untested deck
slug: /verify-device
description: Use the device check wizard to fix rotated, mirrored, shuffled, cut-off or black key images on an untested deck, then send the report.
---

# Device check

Many decks in the [supported devices](./devices.mdx) list are marked *untested*: their
settings come from a sibling board or from documentation, not from the physical deck. If
yours shows rotated, mirrored, shuffled, cut-off or black keys, the device check fixes it
by asking you which picture matches your deck. It saves the result as device tuning and
gives you a report to send back, so a later release can ship the right values.

## Where to find it

- **The banner.** When an untested deck connects, a banner above its preview asks
  **Untested deck. Check its images?** Choose **Check my device** to start. **Not now**
  hides the banner until DeckBridge restarts; **Don't ask again** remembers the choice for
  that model.
- **Device tuning.** **Settings → Device tuning → Check images step by step** opens the
  same wizard for any deck it supports, tested or not.

The check works only for USB decks whose images DeckBridge converts. It is not offered
for Elgato's own decks (they use the app's images unchanged), for the
[browser deck](./browser-deck.md), or in safe mode. Only one check per model can run at a
time.

## What happens to your deck

While the check runs, your deck shows test images instead of your Stream Deck app
images: numbered coloured keys with an arrow and an **F**, three colour bars, and
coloured rings. The deck does not dim or sleep during the check, and the Stream Deck app
does not need to be connected.

When you save or press **Cancel**, the app's images come back. If you close the page
instead, the check ends by itself after about 30 seconds. A check that ended this way
shows **Session ended. Your deck shows its normal images again.** and a **Start again**
button.

## The steps

The wizard opens as **Check your deck**. A bar at the top shows **Step n of N**; the
number of steps depends on your deck (the buttons and own-images steps are not always
offered).

The first screen shows a picture of your deck. The numbered, coloured keys are the keys
the Stream Deck app draws, and only those are checked; the test images use the same
numbers and colours. Dashed parts are not part of the check: keys that DeckBridge drives
itself as [side keys](./side-keys.md) (the right column of an AKP05 or a 293S-type deck),
dials and the touch strip. So a deck shown as a Stream Deck + checks 8 keys even if it has
10: the app's 4 × 2 grid sits on the left four columns.

Press **Start** to put the test images on your deck. Until you save, every step has
**Back** and **Cancel**. Answer with what you see on
the deck itself. Most answers show a small picture of what your keys might look like, so
you pick the one that matches. If the wizard says **This browser can't draw test images.**, open the
DeckBridge page in another browser.

1. **Visible keys.** *Do all keys show a number?* If some or all keys are black or
   garbled, the wizard lowers the image size limit and the JPEG quality one step at a time
   and asks *All keys show a number now?* If the keys are still black at the lowest
   setting, the check stops with **Not fixed**. Nothing is saved, but the report still
   helps.
2. **Orientation.** *Which one matches your keys?* Pick the picture whose arrow and **F**
   look like the ones on your keys. The wizard turns the image and asks *Upright now?*
3. **Colours.** *Colours, left to right?* This answer is only recorded (see
   [What the wizard cannot fix](#what-the-wizard-cannot-fix)).
4. **Key order.** *Which layout matches your deck?* Pick the grid of numbers that your
   deck shows. If none matches, choose **None**, tap where your deck shows each number in
   turn, then press **Continue**. The wizard reorders the keys and asks *Numbers in order
   now?*
5. **Size.** *What do the rings show?* Answer **Outer ring cut off** or
   **Black gap outside** until the deck shows **All rings, no gap**. The wizard changes the
   image size after each answer. If even the smallest size cuts the outer ring, it keeps
   the saved size. **Other** is recorded, and the wizard moves on.
6. **Confirm.** *All keys look right?* **Yes, save** saves the result. **No** asks *What is
   wrong?* and takes you back to that step.
7. **Your own images.** If the Stream Deck app had already sent images, the wizard asks
   *Do your Stream Deck images look right?* This answer is only recorded. If the save
   reconnects your deck, wait for it to come back before you answer.
8. **Buttons.** *Does each press act on the right key?* **No** opens key-map learn mode:
   press **Start learn mode**, press each key as prompted, then **Save this map**.
   **Skip** keeps the current key map. This step appears only for the first deck.

After the save there is no going back into the check. The last screen says **Saved** and
closes with **Done**.

## What gets saved

**Yes, save** stores the result as [device tuning](./troubleshooting.md#device-tuning)
for that model, under `modelOverrides` in `settings.json`, so it applies to every deck of
the same model. Depending on your answers, it holds the image rotation and flip, the image
size, the JPEG quality and size limit, the key order, the key map from the Buttons step,
and the startup splash orientation (only when the image orientation changed). If the
orientation or the key order changed, the deck reconnects once; a new key map from the
Buttons step reconnects it again. Saving also turns off the banner for that model.

To undo it:

- **Settings → Device tuning → Reset** returns the model to its built-in defaults.
- Safe mode ignores all device tuning for one session: start with
  `./deckbridge run --no-overrides`, or set `DECKBRIDGE_NO_OVERRIDES=1`. The saved tuning
  stays in `settings.json` and applies again on the next normal start.

## What the wizard cannot fix

- **Crop and image fit.** The test images cannot show a dead border or off-centre art in
  the app's images. Use **Image fit** and **Crop…** in
  [Device tuning](./troubleshooting.md#device-tuning) for that.
- **Colours.** If red and blue are swapped, the wizard records it in the report, but no
  setting can fix it yet.
- **Touch strips, dials and extra keys.** The check covers the keys the Stream Deck app
  draws. The first screen marks the rest as dashed.

## The report

The last screen offers **Copy report** and **Open GitHub issue**. **Open GitHub issue**
opens a prefilled *Device check report* issue in your browser, which you review and submit
yourself. If the report is too long for the link, the wizard copies it to your clipboard
instead, and you paste it into the **Wizard report** field.

Nothing is sent automatically. The report is a short JSON text that holds:

- the model id, the Stream Deck model it is shown as (if it emulates one) and the
  DeckBridge version;
- your answers at each step, and a result per area (`pass`, `fixed`, `fail` or `unknown`);
- the device tuning saved for that model (the override JSON);
- the raw codes of your last few key presses on the first deck, if there are any.

It does not include the rest of `settings.json`, your key commands or file paths.
Maintainers use the report to correct the model in DeckBridge and mark it as tested.
