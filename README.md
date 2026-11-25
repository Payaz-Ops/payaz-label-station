# Payaz Label Station (tablet version)

## Install the Android app

On the Lenovo tablet, open this link in Chrome and install the file it downloads:

**https://github.com/Payaz-Ops/payaz-label-station/releases/latest/download/payaz-labels.apk**

The first time, Android asks you to allow installing apps from Chrome: tap **Settings**,
turn on **Allow from this source**, then go back and tap **Install**. Open **Payaz Labels**,
tap **Connect printer**, allow **Nearby devices**, and choose the printer (it starts with **T0**).

The app reconnects to the same printer by itself each time it opens, runs full screen
and keeps the screen on. To update it, download and install the latest APK the same way.
Your settings are kept.

The APK is built automatically by GitHub Actions (`.github/workflows/android.yml`) on every
push to `main`, and published under **Releases**. It's signed with the key in the
`ANDROID_KEYSTORE_BASE64` / `ANDROID_KEYSTORE_PASSWORD` repository secrets. Without them,
the build makes a test app with a temporary key.

## Or use it as a web app

Prints Payaz order, SumUp reader and tablet serial labels on a **SUPVAN T50M Pro**
from a **Lenovo tablet**, over Bluetooth. No Raspberry Pi, cables or computer needed.

It's a web app: it runs in Google Chrome on the tablet and can be added to the home
screen so it opens full screen like a normal app. Once opened it also works without
internet.

## What you need

- The Lenovo tablet (Android) with **Google Chrome**
- The SUPVAN T50M Pro, charged and switched on, with 40 × 30 mm labels
- A barcode scanner, either:
  - a **Bluetooth** scanner (recommended, because it leaves the tablet's charging port free), paired in
    the tablet's Bluetooth settings like a keyboard, or
  - a USB scanner plugged in with a **USB‑C OTG adapter**
- Or just use the tablet's **camera**: tap **Use camera** on any scan screen

## The app's web address

**https://payaz-ops.github.io/payaz-label-station/**

It's hosted free on GitHub Pages from this repository's `gh-pages` branch. To update the
app, push changes to `main`, then update `gh-pages` to match:

```bash
git push origin main main:gh-pages
```

Then bump `VERSION` in `sw.js` so tablets pick up the change.

## Step 2: Set up the tablet

1. Open **Chrome** on the tablet and go to **payaz-ops.github.io/payaz-label-station**.
2. Tap Chrome's **⋮** menu, then **Add to Home screen** (or **Install app**).
3. Open **Payaz Labels** from the home screen. It opens full screen.
4. Switch the printer on and tap **Connect printer** (top right). Allow **Nearby devices**
   if Android asks, then choose the printer. Its name starts with **T0**.
5. Tap **⚙ Settings**, then **Print a test label**.

Next time, open the app and it reconnects to the same printer. If it doesn't, tap
**Connect printer** again.

**Optional: lock the tablet to this app.** In Android **Settings → Security → App pinning**
(it may be called *Screen pinning*), turn it on. Then open Recent apps, tap the Payaz Labels
icon and choose **Pin**.

## Using it

**Who's using the tablet?** The app opens on a list of names. Tap yours and enter your
4-digit PIN; everything you do is saved in Payaz Stock under your name. First time: tap
**Add me**, sign in with your Payaz Stock email and password, and choose a PIN. Forgot it
(or 5 wrong tries)? Tap **Forgot PIN?** and sign in with your password to choose a new one.
Tap your name at the top to switch person. The tablet locks itself after 5 minutes untouched
(change this in Settings, where you can also take people off the tablet). Passwords aren't
kept on the tablet; each person's sign-in is kept separately and the PIN only as a salted hash.

| Button | What it does |
|---|---|
| **Log** | Every Order Label printed: order number, date, card reader, tablet and **warranty expiry** (12 months after printing; expired dates show in red). Scan or type a serial to find it, tap a row to delete it, and **Export CSV** to email it or save it to Drive. |
| **Stock** | **Stock take** linked to the Payaz Stock app. Choose **Stock take**, **Add stock** or **Remove stock**, then scan: each scan of an item (or its shelf label) counts 1, or use + / − or type the number. **Save**, or just scan the next item, and the new quantity goes into Payaz Stock with the same history entry the stock app writes ("Stock Take Audit (Recorded: 12, Counted: 9) (Old: 12 → New: 9)"). Unknown barcodes can be added as new items. | **Book in serials**: scan the product barcode (or tap Find an item), choose **New delivery** (each unit adds 1 to stock; add the delivery note or PO number if you like) or **Already on the shelf** (already counted), then scan the serial number on each tablet or card reader. Same records as Payaz Stock's Serials page. Products tracked by serial number can't be counted, added or removed here: their stock changes only through their serials. **Spot check**: a quick blind count of about 10 random items (always some tablets and card readers), due on the 1st and 15th or when a manager asks (an orange **Spot check due** button appears at the top). You're never shown how many there should be; a count that doesn't match is counted again, and a big difference adds a deeper count. Managers see the results in Payaz Stock > Spot checks.
| **Stock Label** | **Shelf labels** for Payaz Stock items: search or scan, tap an item and print. The barcode on the label is the item's own code in Payaz Stock (its barcode, or its SKU if it has none), so scanning the shelf label in a stock take finds the item. **✎ Edit item & label** changes the item in Payaz Stock (name, SKU, barcode, category, location, notes, photo) and prints the new label, so a new code is saved in the system too. **+ New item** adds a product with a photo. **Custom label** prints a one-off label you type yourself (no sign-in needed). |
| **Order Label** | Type the order number (tap **PZ** for numbers like 48374PZ, or **RR** first for numbers like RR-2026-0004: the dashes go in by themselves), tap **Next**, and scan the card reader and/or tablet in any order: each scan goes into the right box (card reader serials are all numbers, tablet serials have letters; a unit booked in to Payaz Stock goes by its product). One box filled prints that on its own; two or three print one combined label. If the order number has been printed before (in the Log on this tablet), the box says when, and **Print** asks before printing again. Each one is added to the Log. Each scanned unit shows whether it's in stock, and printing an order label marks it **sent on that order** in Payaz Stock (stock goes down by 1). A unit that was never booked in is still recorded on the order, without changing the stock count. No internet? The label still prints and the units wait on the tablet (a yellow **waiting to send** button shows at the top); they are sent automatically, under the person who printed them, as soon as the connection is back. Don't print again. Units never booked in, or already sent on another order, are flagged to managers. |
| **Production** | The same tiles as Payaz Stock's **Production Floor** (set up and edited on the website). Tap one, e.g. **Giving Station**, choose how many and **Build**: every part in its recipe comes off stock under your name, with the same records as the website (they show in its Production history). It won't build if a part is short, and **Undo** puts the parts back. Tablets and card readers aren't in tiles: tap **Next: Order Label** for those. |
| **Damage** | Scan the damaged item (or a tablet / card reader serial number; serial-tracked products must have it), choose why, add a note and **Log damage**. Same record as Payaz Stock's Report Damage: stock goes down, a DMG code is made, and the damage box label prints. |

The log is saved on the tablet. In the Android app it's also copied to
**Documents/PayazLabels/payaz-label-log.csv** after every print, so you can find it with the
Files app. Uninstalling the app deletes the in-app log, so export it first.

**⚙ Settings** has the label size (including **50 × 80 mm**), the **stock label orientation** (Upright, Landscape ↻ or Landscape ↺, also on the stock label pop-up), print darkness (1–9), flip upside down and the test print. If a code is too long for the label, the preview warns that the barcode lines will be very thin.

## Payaz Stock link (for someone technical)

`js/stock.js` uses the Payaz Stock app's Firebase project (`oceanic-cache-418312`, database
`stock`) and its security rules. Order Labels write to `serial_units` and `serial_events` (see
`dispatchSerial`, kept in step with Payaz Stock's `src/lib/serials.ts`): any signed-in user can read items, locations and categories;
adding items needs an active `staff_accounts` profile. New items are written exactly like the
stock app's own Add Item (`items/{itm_…}` plus a `movements/{mov_…}` "in" record).
Sign-in is email and password only (Google sign-in doesn't work inside the Android app); staff
who normally use Google can set a password with "Forgot your password".
`js/firebase.js` is a bundle of the Firebase SDK: rebuild it with `npm run build:firebase`.

## If something goes wrong

- **"The printer didn't answer"**: make sure the printer is on and near the tablet. Close the
  SUPVAN or Katasymbol phone app on any other phone, because the printer only takes one
  connection at a time.
- **Printer not in the list**: switch the printer off and on, and check Bluetooth and
  Location are on in the tablet's quick settings.
- **Faint print**: raise **Darkness** in Settings.
- **Upside down**: turn on **Flip label upside down**.
- **After uploading a new version**: open the app with internet on, then tap
  Settings → **Restart app**.

## How it works (for someone technical)

- Plain HTML/JavaScript, with no build step. `js/labels.js` draws the labels at 203 dpi with Code 128
  barcodes; `js/printer.js` talks to the printer over Web Bluetooth (BLE GATT service
  `e0ff`). It's a trimmed port of the MIT-licensed T50/T80 driver from
  [Supvan & Katasymbol web print studio](https://github.com/khromov/supvan-katasymbol-printer-web-ui),
  which was tested on a T50M Pro. `js/lzma.js` is Supvan's modified LZMA-JS (MIT), which the
  printer firmware needs.
- Settings are saved on the tablet (browser storage). `sw.js` keeps it working offline.
- Fonts: Montserrat (screen) and Atkinson Hyperlegible (labels), both SIL Open Font Licence.
