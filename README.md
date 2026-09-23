# AB Split Test — Attention Kiosk

**A/B test your kiosks, digital signage and public TV screens by what people actually look at.**

An add-on for the [AB Split Test](https://absplittest.com) WordPress plugin. Point a webcam at the people in front of the screen and it becomes a split test: people walking by are the visitors, and people who turn to look at the screen are the conversions. AB Split Test then tells you which screen design, headline or offer gets the most attention.

Face detection runs entirely in the kiosk's browser. No images or face data are stored or sent anywhere.

## Why we built it

We dogfood everything: AB Split Test runs on our own businesses' sites before it reaches anyone else's. One of them, [Whistler Bag Storage](https://whistlerbagstorage.com), has a TV facing out into a busy public area. It was showing a screen, but nobody could say whether anyone actually looked at it.

So we pointed a webcam at the people walking past and asked a simple question: is this person looking at the screen, and for how long? That turned the TV into a split test. Different screens take turns, and the one that holds attention wins. It's the same way you'd test a landing page.

The longer-term goal is to close the loop with AI: let an AI agent keep proposing new screen variations, test them on real passers-by, and keep whatever gets more people to scan the QR code. No human has to redesign the screen by hand.

## Good for

- Retail and shop-window displays: which promo stops people?
- Menu boards and in-store TVs: which layout gets read?
- Trade-show stands, lobbies, museums, waiting rooms
- Any always-on screen running a WordPress page in a browser

## How it works

| In front of the screen | In AB Split Test |
| --- | --- |
| Someone walks into range | A visit to the variation on screen |
| They look at the screen for 2 s (configurable) | The test's JavaScript conversion |
| They keep looking for 5 s, 15 s … (configurable) | The test's JavaScript Event sub goals, in order |
| Nobody in view for 5 s | The visit ends; the page reloads and the next person gets a fresh variation |
| They scan the on-screen QR code (optional) | Their phone continues as that visitor, so sign-ups or orders on your site credit the variation they saw |

"Looking" is head pose: a face turned towards the camera within the left/right and up/down tolerances you set. It is a good proxy for attention, not eye tracking. A minimum face size ignores people far away, and a group standing together counts as one visitor.

**Seconds-looking mode:** instead of converting at the threshold, each passer-by who reached it converts when they leave, worth their total seconds looking. Turn on *Use order value* in the test, and its revenue report reads as average attention per passer-by.

## Requirements

- WordPress 6.0+, PHP 7.0+
- [AB Split Test](https://absplittest.com) 2.6.8 or later
- The kiosk page served over **HTTPS** (browsers only give camera access to secure pages)
- A kiosk browser with a webcam (Chrome/Edge/Chromium recommended)
- For QR handoff: *Advanced Tracking (UUID)* enabled in AB Split Test's settings

## Install

1. Download this repo (**Code → Download ZIP**), unzip it and rename the folder to `abst-attention-kiosk`, then upload it to `wp-content/plugins/`. Or:
   ```bash
   git clone https://github.com/SiteSpot/abst-attention-kiosk.git wp-content/plugins/abst-attention-kiosk
   ```
2. Activate **AB Split Test — Attention Kiosk** in Plugins.
3. Go to **AB Split Test → Attention Kiosk** for your kiosk key and settings.

## Set up a kiosk test

1. Create a test on the page the kiosk shows, as usual. Set its **Conversion** to **JavaScript**.
2. Optional: add **JavaScript Event** sub goals for longer attention times.
3. On the kiosk, open that page once with `?abst_kiosk=YOUR_KEY` and allow the camera. The device is now enrolled; ordinary visitors to your site never trigger the camera.
4. Calibrate with `?abst_kiosk_debug=1`: a camera preview, live head angles, face size and frame rate on a panel that turns green while someone is looking. If the camera sits above or below the screen, look at the middle of the screen and enter the pitch it shows as the *camera height correction*.
5. `?abst_kiosk=off` un-enrolls a device. **Make a new key** in the settings un-enrolls every kiosk at once.

## Privacy

- Detection uses Google's [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) in the browser. Frames never leave the device; only AB Split Test's normal visit, conversion and goal events are sent.
- The camera only starts in browsers enrolled with the kiosk key.
- A small "camera on" notice shows on screen by default. Check what notice the law requires where your screens are (e.g. GDPR/UK GDPR signage rules, BIPA in Illinois).
- The QR code only carries the anonymous visitor ID AB Split Test already uses. The variation for a scan is looked up from AB Split Test's own visitor table, never taken from the link.

## Offline or self-hosted kiosks

MediaPipe, the face model and the QR library load from jsDelivr and Google's model CDN by default. Point these filters at your own copies to run without them:

```php
add_filter( 'abst_attention_vision_bundle_url', fn() => '/assets/mediapipe/vision_bundle.mjs' );
add_filter( 'abst_attention_wasm_url',          fn() => '/assets/mediapipe/wasm' );
add_filter( 'abst_attention_model_url',         fn() => '/assets/mediapipe/face_landmarker.task' );
add_filter( 'abst_attention_qr_library_url',    fn() => '/assets/qrcode.js' );
```

`abst_attention_config` filters the whole front-end config.

## Hooks for your screen design

The page gets an `abst-attention` DOM event for everything the camera sees, e.g. to animate the screen when someone walks up:

```js
document.addEventListener('abst-attention', (e) => {
  // e.detail.type: 'arrive' | 'conversion' | 'goal' | 'leave'
  // conversion: detail.seconds; goal: detail.goal, detail.seconds
  // leave: detail.dwellMs, detail.attentionMs, detail.converted, detail.goals
  if (e.detail.type === 'arrive') document.body.classList.add('someone-here');
});
```

Put an empty element with the class `abst-kiosk-qr` in a variation to place the QR code there instead of the bottom-left corner.

## Development

No build step. The decision logic (head pose, the per-visitor state machine, test and goal mapping, QR links) is pure JS and tested without a camera; the PHP tests stub WordPress.

```bash
npm test
php tests/settings.test.php
```

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
