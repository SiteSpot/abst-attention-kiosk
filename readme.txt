=== AB Split Test — Attention Kiosk ===
Requires plugins: AB Split Test
Stable tag: 0.2.0
License: GPLv2 or later

Test which kiosk or signage screen actually gets looked at, using the device's webcam.

== What it does ==

On an enrolled kiosk the webcam watches for faces, in the browser, and reports to your AB Split Test tests:

* Someone walks into range: the visitor for the variation on screen.
* They look at the screen for the conversion time (default 2s): the test's JavaScript conversion.
* They look for the sub goal times (default 5s, 15s): the test's JavaScript Event sub goals, in order. These can be shorter than the conversion time, e.g. a goal every second with a 5s conversion.
* Nobody in view for a few seconds: the kiosk forgets the visitor and reloads, so the next person gets a fresh variation.
* Optional "seconds looking" mode: instead of converting at the conversion time, each visit that reached it converts when the person leaves, worth their total seconds looking. Switch on "Use order value" in the test, and its revenue report shows average attention per passer-by.
* Optional QR code: a code unique to each passer-by. The phone that scans it continues as that kiosk visitor, so sign-ups or orders on your site count toward the variation they saw.

"Looking" is head pose: a face turned towards the camera within the left/right and up/down tolerances. It is a proxy for attention, not eye tracking.

== Privacy ==

Face detection runs in the kiosk's browser with Google's MediaPipe Face Landmarker. No images or face data are stored or sent; only the normal AB Split Test visit, conversion and goal events leave the device. The QR code carries only the random visitor ID AB Split Test already uses; scanning it links the phone's visit on your site to that anonymous kiosk visit, under your site's normal cookie consent. The camera only starts on browsers enrolled with the kiosk key, never for ordinary site visitors. A small on-screen notice is shown by default; check what notice the law requires where your kiosks are.

== Setup ==

1. Install AB Split Test, then copy this folder to wp-content/plugins/abst-attention-kiosk and activate it.
2. Create the test on the page the kiosk shows. Set its Conversion to JavaScript. Add JavaScript Event sub goals for the longer attention times if you want them.
3. On the kiosk, open that page once with ?abst_kiosk=YOUR_KEY (the key is on AB Split Test > Attention Kiosk) and allow the camera. The site must use HTTPS.
4. Tune with ?abst_kiosk_debug=1 on the kiosk: it shows the camera preview, head angles, face size and frame rate, on a panel that is green while someone is looking and red otherwise. ?abst_kiosk=off un-enrolls a device.
5. For the QR code: enable Advanced Tracking (UUID) in AB Split Test's settings, set the page the code opens, and add a Page or URL sub goal for that page to the test. The code sits bottom-left unless a variation has an element with the class abst-kiosk-qr.

== Reading results ==

Visits are passers-by and conversions are passers-by who looked. A group standing together counts as one visitor. The page load that starts the kiosk counts one visit before anyone arrives.

== Developers ==

* document event `abst-attention` with detail.type `arrive`, `conversion` (detail.seconds), `goal` (detail.goal, detail.seconds) or `leave` (detail.dwellMs, detail.attentionMs, detail.converted, detail.goals), e.g. to animate the screen when someone walks up.
* Filters `abst_attention_vision_bundle_url`, `abst_attention_wasm_url`, `abst_attention_model_url` and `abst_attention_qr_library_url` to self-host MediaPipe and the QR library (offline kiosks), and `abst_attention_config` for the whole front-end config.
