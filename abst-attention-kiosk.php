<?php
/**
 * Plugin Name:       AB Split Test — Attention Kiosk
 * Plugin URI:        https://github.com/SiteSpot/abst-attention-kiosk
 * Description:       Add-on for AB Split Test. Runs tests on kiosk and signage screens using the device's webcam: passers-by are the visitors, people who look at the screen are the conversions. Face detection runs on the device; no images are stored or sent.
 * Version:           0.2.1
 * Requires at least: 6.0
 * Requires PHP:      7.0
 * Author:            AB Split Test
 * Author URI:        https://absplittest.com
 * License:           GPL-2.0+
 * License URI:       http://www.gnu.org/licenses/gpl-2.0.txt
 * Text Domain:       abst-attention-kiosk
 */

if ( ! defined( 'ABSPATH' ) ) {
  exit;
}

define( 'ABST_ATTENTION_VERSION', '0.2.1' );
define( 'ABST_ATTENTION_OPTION', 'abst_attention_kiosk' );
define( 'ABST_ATTENTION_MEDIAPIPE', '1.0.1' );

function abst_attention_defaults() {
  return [
    'key'                => '',
    'conversion_seconds' => 2,
    'conversion_mode'    => 'first',
    'goal_seconds'       => '5, 15',
    'max_yaw'            => 25,
    'max_pitch'          => 20,
    'pitch_offset'       => 0,
    'min_face_width'     => 8,
    'leave_seconds'      => 5,
    'max_faces'          => 3,
    'test_ids'           => '',
    'show_notice'        => '1',
    'notice_text'        => 'Camera on: this screen counts glances. No images are recorded.',
    'debug'              => '0',
    'qr_url'             => '',
    'qr_label'           => 'Scan me',
    'qr_size'            => 160,
  ];
}

function abst_attention_settings() {
  $settings = wp_parse_args( get_option( ABST_ATTENTION_OPTION, [] ), abst_attention_defaults() );
  if ( $settings['key'] === '' ) {
    $settings['key'] = wp_generate_password( 24, false );
    update_option( ABST_ATTENTION_OPTION, $settings );
  }
  return $settings;
}

// "5, 15, x" -> [5, 15]
function abst_attention_parse_numbers( $value ) {
  $numbers = [];
  foreach ( preg_split( '/[\s,]+/', (string) $value, -1, PREG_SPLIT_NO_EMPTY ) as $part ) {
    if ( is_numeric( $part ) && (float) $part > 0 ) {
      $numbers[] = (float) $part;
    }
  }
  return $numbers;
}

function abst_attention_capability() {
  return apply_filters( 'abst_settings_capability', 'manage_options' );
}

add_action( 'plugins_loaded', function () {
  if ( ! defined( 'BT_AB_TEST_VERSION' ) ) {
    add_action( 'admin_notices', function () {
      echo '<div class="notice notice-warning"><p>' . esc_html__( 'AB Split Test — Attention Kiosk needs the AB Split Test plugin to be active.', 'abst-attention-kiosk' ) . '</p></div>';
    } );
    return;
  }

  add_action( 'admin_menu', 'abst_attention_admin_menu', 20 );
  add_action( 'admin_init', 'abst_attention_register_setting' );
  add_action( 'admin_post_abst_attention_rotate_key', 'abst_attention_rotate_key' );
  add_action( 'wp_enqueue_scripts', 'abst_attention_enqueue' );
  add_action( 'template_redirect', 'abst_attention_handoff_lookup' );
  // After ABST enqueues bt_conversion_scripts (priority 10).
  add_action( 'wp_enqueue_scripts', 'abst_attention_handoff_script', 20 );
} );

// ---------------------------------------------------------------------------
// Front end
// ---------------------------------------------------------------------------

function abst_attention_enqueue() {
  $s = abst_attention_settings();
  $base = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' . ABST_ATTENTION_MEDIAPIPE;

  $config = [
    'keyHash'           => hash( 'sha256', $s['key'] ),
    'conversionSeconds' => max( 0.5, (float) $s['conversion_seconds'] ),
    'conversionValue'   => $s['conversion_mode'] === 'seconds',
    'goalSeconds'       => abst_attention_parse_numbers( $s['goal_seconds'] ),
    'maxYaw'            => (float) $s['max_yaw'],
    'maxPitch'          => (float) $s['max_pitch'],
    'pitchOffset'       => (float) $s['pitch_offset'],
    'minFaceWidth'      => max( 0, (float) $s['min_face_width'] ) / 100,
    'leaveSeconds'      => max( 1, (float) $s['leave_seconds'] ),
    'maxFaces'          => max( 1, min( 10, (int) $s['max_faces'] ) ),
    'testIds'           => array_map( 'intval', abst_attention_parse_numbers( $s['test_ids'] ) ),
    'showNotice'        => $s['show_notice'] === '1',
    'noticeText'        => $s['notice_text'],
    'debug'             => $s['debug'] === '1',
    'reloadOnLeave'     => true,
    'qrUrl'             => $s['qr_url'],
    // Without it ABST keeps no visitor table, so a scan has nothing to look up.
    'advancedTracking'  => function_exists( 'ab_get_admin_setting' ) && ab_get_admin_setting( 'ab_use_uuid' ) == '1',
    'qrLabel'           => $s['qr_label'],
    'qrSize'            => (int) $s['qr_size'],
    'qrLibraryUrl'      => apply_filters( 'abst_attention_qr_library_url', 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js' ),
    // Point these at your own copies to run kiosks without the CDNs.
    'visionBundleUrl'   => apply_filters( 'abst_attention_vision_bundle_url', $base . '/vision_bundle.mjs' ),
    'wasmUrl'           => apply_filters( 'abst_attention_wasm_url', $base . '/wasm' ),
    'modelUrl'          => apply_filters( 'abst_attention_model_url', 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task' ),
  ];

  wp_enqueue_script( 'abst-attention-kiosk', plugins_url( 'js/attention-kiosk.js', __FILE__ ), [], ABST_ATTENTION_VERSION, true );
  wp_add_inline_script( 'abst-attention-kiosk', 'window.ABST_ATTENTION = ' . wp_json_encode( apply_filters( 'abst_attention_config', $config ) ) . ';', 'before' );
}

// ---------------------------------------------------------------------------
// QR handoff: the phone that scans a kiosk's QR code becomes that kiosk visitor
// ---------------------------------------------------------------------------

// The kiosk's QR code opens a page with ?abst_scan=<the kiosk visitor's
// advanced-tracking UUID>. The variation comes from ABST's own visitor table,
// never from the link, so a made-up link can't pick a variation, and one for a
// UUID that never visited adopts nothing.
function abst_attention_handoff_lookup() {
  // A public link parameter for a read-only lookup, so there is no nonce to check.
  $uuid = isset( $_GET['abst_scan'] ) ? strtolower( sanitize_text_field( wp_unslash( $_GET['abst_scan'] ) ) ) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended
  if ( ! preg_match( '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $uuid ) || ! function_exists( 'abst_lookup_visitor_test_data' ) ) {
    return;
  }

  // The page now carries one visitor's assignment; a page cache must not keep it.
  if ( ! defined( 'DONOTCACHEPAGE' ) ) {
    define( 'DONOTCACHEPAGE', true );
  }
  nocache_headers();

  $found = abst_lookup_visitor_test_data( $uuid );
  if ( is_wp_error( $found ) || empty( $found['tests'] ) ) {
    return;
  }
  $cookies = abst_attention_handoff_cookies( $found['tests'] );
  if ( $cookies ) {
    $GLOBALS['abst_attention_handoff'] = [ 'uuid' => $uuid, 'cookies' => $cookies ];
  }
}

// ABST's btab_<test> assignment cookie, per running test the visitor is in,
// in the shape bt_experiment_w() writes: conversion and goals already logged
// for the kiosk visit are marked so the phone doesn't send them again.
function abst_attention_handoff_cookies( $tests ) {
  $cookies = [];
  foreach ( (array) $tests as $test ) {
    if ( ( $test['test_status'] ?? '' ) !== 'publish' || empty( $test['test_id'] ) || (string) ( $test['variation'] ?? '' ) === '' ) {
      continue;
    }
    // Goal keys are stored from event data, so only plausible goal numbers pass.
    $done = array_filter( array_map( 'intval', array_filter( (array) ( $test['goals'] ?? [] ), 'is_numeric' ) ), function ( $goal ) {
      return $goal >= 0 && $goal <= 50;
    } );
    $goals = $done ? array_fill( 0, max( $done ) + 1, null ) : [];
    foreach ( $done as $goal ) {
      $goals[ $goal ] = 1;
    }
    $cookies[ 'btab_' . (int) $test['test_id'] ] = wp_json_encode( [
      'eid'        => (int) $test['test_id'],
      'variation'  => (string) $test['variation'],
      'conversion' => empty( $test['converted'] ) ? 0 : 1,
      'goals'      => $goals,
      'size'       => (string) ( $test['device_size'] ?? '' ),
      'audiences'  => (string) ( $test['audience_ids'] ?? '' ),
    ] );
  }
  return $cookies;
}

// Runs right after ABST's tracker is parsed and before its DOMContentLoaded
// setup, so page and URL sub goals on this page already see the assignment.
function abst_attention_handoff_script() {
  if ( empty( $GLOBALS['abst_attention_handoff'] ) || ! wp_script_is( 'bt_conversion_scripts', 'enqueued' ) ) {
    return;
  }
  $handoff = $GLOBALS['abst_attention_handoff'];
  $script  = '(function(c,id){try{'
    . 'Object.keys(c).forEach(function(n){abstSetCookie(n,c[n],1000);});'
    // sessionStorage wins in abstGetAdvancedId(), so this tab reports as the
    // kiosk visitor without replacing an ID the phone already keeps.
    . 'try{sessionStorage.setItem("ab-advanced-id",id);}catch(e){}'
    . 'if(window.abst){window.abst.visitorId=id;if(window.abst.hasApproval)abstSetCookie("ab-advanced-id",id,365);}'
    . 'var u=new URL(location.href);u.searchParams.delete("abst_scan");history.replaceState(history.state,"",u.toString());'
    . '}catch(e){console.error("ABST attention: QR handoff failed",e);}})('
    . wp_json_encode( $handoff['cookies'] ) . ',' . wp_json_encode( $handoff['uuid'] ) . ');';
  wp_add_inline_script( 'bt_conversion_scripts', $script, 'after' );
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

function abst_attention_admin_menu() {
  add_submenu_page(
    'edit.php?post_type=bt_experiments',
    'Attention Kiosk',
    'Attention Kiosk',
    abst_attention_capability(),
    'abst-attention-kiosk',
    'abst_attention_settings_page'
  );
}

function abst_attention_register_setting() {
  register_setting( 'abst_attention_kiosk', ABST_ATTENTION_OPTION, [
    'type'              => 'array',
    'sanitize_callback' => 'abst_attention_sanitize',
  ] );
}

// Runs on every update_option() of the setting, including the key writes in
// abst_attention_settings() and abst_attention_rotate_key(), so it keeps a key
// it is given and must not call abst_attention_settings() itself.
function abst_attention_sanitize( $input ) {
  $current = wp_parse_args( get_option( ABST_ATTENTION_OPTION, [] ), abst_attention_defaults() );
  $input   = is_array( $input ) ? $input : [];
  $key     = preg_replace( '/[^A-Za-z0-9]/', '', (string) ( $input['key'] ?? '' ) );
  $number  = function ( $field, $min, $max ) use ( $input, $current ) {
    if ( ! isset( $input[ $field ] ) || ! is_numeric( $input[ $field ] ) ) {
      return $current[ $field ];
    }
    return max( $min, min( $max, (float) $input[ $field ] ) );
  };

  return [
    'key'                => $key !== '' ? $key : $current['key'],
    'conversion_seconds' => $number( 'conversion_seconds', 0.5, 120 ),
    'conversion_mode'    => ( $input['conversion_mode'] ?? $current['conversion_mode'] ) === 'seconds' ? 'seconds' : 'first',
    'goal_seconds'       => implode( ', ', abst_attention_parse_numbers( $input['goal_seconds'] ?? '' ) ),
    'max_yaw'            => $number( 'max_yaw', 1, 90 ),
    'max_pitch'          => $number( 'max_pitch', 1, 90 ),
    'pitch_offset'       => $number( 'pitch_offset', -45, 45 ),
    'min_face_width'     => $number( 'min_face_width', 0, 100 ),
    'leave_seconds'      => $number( 'leave_seconds', 1, 300 ),
    'max_faces'          => (int) $number( 'max_faces', 1, 10 ),
    'test_ids'           => implode( ', ', array_map( 'intval', abst_attention_parse_numbers( $input['test_ids'] ?? '' ) ) ),
    'show_notice'        => empty( $input['show_notice'] ) ? '0' : '1',
    'notice_text'        => sanitize_text_field( $input['notice_text'] ?? '' ),
    'debug'              => empty( $input['debug'] ) ? '0' : '1',
    'qr_url'             => abst_attention_sanitize_url( $input['qr_url'] ?? $current['qr_url'] ),
    'qr_label'           => sanitize_text_field( $input['qr_label'] ?? $current['qr_label'] ),
    'qr_size'            => (int) $number( 'qr_size', 80, 600 ),
  ];
}

// Web addresses only; a relative path is resolved against the site on the kiosk.
function abst_attention_sanitize_url( $url ) {
  $url = trim( (string) $url );
  if ( $url === '' ) {
    return '';
  }
  if ( $url[0] === '/' && ( strlen( $url ) === 1 || $url[1] !== '/' ) ) {
    return esc_url_raw( home_url( $url ) );
  }
  return preg_match( '#^https?://#i', $url ) ? esc_url_raw( $url ) : '';
}

// A new key un-enrolls every kiosk that used the old one.
function abst_attention_rotate_key() {
  if ( ! current_user_can( abst_attention_capability() ) ) {
    wp_die( esc_html__( 'Sorry, you are not allowed to do that.', 'abst-attention-kiosk' ) );
  }
  check_admin_referer( 'abst_attention_rotate_key' );
  $settings        = abst_attention_settings();
  $settings['key'] = wp_generate_password( 24, false );
  update_option( ABST_ATTENTION_OPTION, $settings );
  wp_safe_redirect( admin_url( 'edit.php?post_type=bt_experiments&page=abst-attention-kiosk&rotated=1' ) );
  exit;
}

function abst_attention_settings_page() {
  if ( ! current_user_can( abst_attention_capability() ) ) {
    return;
  }
  $s      = abst_attention_settings();
  $name   = ABST_ATTENTION_OPTION;
  $enroll = add_query_arg( 'abst_kiosk', $s['key'], home_url( '/' ) );
  $field  = function ( $key, $label, $help, $attrs = '' ) use ( $s, $name ) {
    printf(
      '<tr><th scope="row"><label for="abst-att-%1$s">%2$s</label></th><td><input id="abst-att-%1$s" name="%3$s[%1$s]" value="%4$s" %5$s><p class="description">%6$s</p></td></tr>',
      esc_attr( $key ), esc_html( $label ), esc_attr( $name ), esc_attr( $s[ $key ] ), $attrs, wp_kses_post( $help ) // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- $attrs are fixed literals from this file.
    );
  };
  ?>
  <div class="wrap">
    <h1>Attention Kiosk</h1>
    <?php settings_errors(); ?>
    <?php if ( isset( $_GET['rotated'] ) ) : // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- display only. ?>
      <div class="notice notice-success"><p>New kiosk key created. Kiosks enrolled with the old key have stopped tracking until you enroll them again.</p></div>
    <?php endif; ?>

    <p>Test which screen gets looked at. On an enrolled kiosk, the webcam counts the people who walk up and the people who actually look at the screen, and reports them to your tests. Face detection runs in the kiosk's browser; no images are stored or sent anywhere.</p>

    <h2>Set up</h2>
    <ol>
      <li>Create the test on the page your kiosk shows, as usual. Set its <strong>Conversion</strong> to <strong>JavaScript</strong>.</li>
      <li>Optional: add <strong>JavaScript Event</strong> sub goals. They fire, in order, at the longer attention times below.</li>
      <li>On the kiosk itself, open the kiosk page once with <code>?abst_kiosk=<?php echo esc_html( $s['key'] ); ?></code> added to the address, and allow the camera. Kiosk pages need HTTPS.</li>
      <li>Add <code>?abst_kiosk_debug=1</code> on the kiosk to see the camera preview and the head angles while you tune the numbers below. <code>?abst_kiosk=off</code> un-enrolls the device.</li>
    </ol>
    <p>Enrollment link for the home page: <code><?php echo esc_html( $enroll ); ?></code></p>

    <h2>How the results read</h2>
    <ul style="list-style:disc;padding-left:20px">
      <li><strong>Visits</strong> are passers-by: each time the kiosk is clear of people for the "gone" time, it forgets the visitor and reloads, so the next person gets a fresh variation.</li>
      <li><strong>Conversions</strong> are passers-by who looked at the screen for the conversion time (looks add up across the visit). In "seconds looking" mode each one is worth the seconds that person looked, so the test's order value report shows average attention per passer-by.</li>
      <li><strong>QR scans</strong>, with the QR code on, count toward the kiosk visitor: add a Page or URL sub goal for the page the code opens, and any other goals on your site (sign-ups, orders) credit the variation that person saw on the kiosk.</li>
      <li>A group standing together counts as one visitor. The page load that starts the kiosk counts one visit before anyone walks up.</li>
    </ul>

    <form method="post" action="options.php">
      <?php settings_fields( 'abst_attention_kiosk' ); ?>
      <h2>Attention</h2>
      <table class="form-table" role="presentation">
        <?php
        $field( 'conversion_seconds', 'Conversion after (seconds)', 'Seconds of looking before the test logs a conversion.', 'type="number" step="0.5" min="0.5" class="small-text"' );
        ?>
        <tr>
          <th scope="row"><label for="abst-att-conversion_mode">Conversion value</label></th>
          <td>
            <select id="abst-att-conversion_mode" name="<?php echo esc_attr( $name ); ?>[conversion_mode]">
              <option value="first" <?php selected( $s['conversion_mode'], 'first' ); ?>>Count it as soon as they reach the conversion time</option>
              <option value="seconds" <?php selected( $s['conversion_mode'], 'seconds' ); ?>>Seconds looking: count it when they leave, worth their total seconds</option>
            </select>
            <p class="description">For "seconds looking", switch on <strong>Use order value</strong> in the test's conversion settings, or every conversion counts as 1.</p>
          </td>
        </tr>
        <?php
        $field( 'goal_seconds', 'Sub goals after (seconds)', 'Comma-separated, e.g. 1, 2, 3, 4, 6, 8, 10. The first number fires the test\'s first JavaScript Event sub goal, the second number the second, and so on (a test has up to 10 sub goals). They can be shorter or longer than the conversion time.', 'type="text" class="regular-text"' );
        $field( 'max_yaw', 'Left/right tolerance (degrees)', 'How far a head can turn sideways and still count as looking.', 'type="number" min="1" max="90" class="small-text"' );
        $field( 'max_pitch', 'Up/down tolerance (degrees)', 'How far a head can tilt up or down and still count as looking.', 'type="number" min="1" max="90" class="small-text"' );
        $field( 'pitch_offset', 'Camera height correction (degrees)', 'If the camera sits above or below the screen, look at the middle of the screen with the debug overlay on and enter the pitch it shows.', 'type="number" min="-45" max="45" class="small-text"' );
        $field( 'min_face_width', 'Minimum face size (% of frame)', 'Ignores people further away. Around 8% is roughly 2–3 m with a typical webcam.', 'type="number" step="0.5" min="0" max="100" class="small-text"' );
        $field( 'leave_seconds', 'Gone after (seconds)', 'How long nobody has to be in view before the visit ends and the next variation loads.', 'type="number" min="1" max="300" class="small-text"' );
        $field( 'max_faces', 'Faces to track', 'Up to this many faces at once. Anyone looking counts for the group.', 'type="number" min="1" max="10" class="small-text"' );
        $field( 'test_ids', 'Only these tests', 'Test IDs, comma-separated. Leave empty to report to every running test on the page whose conversion is JavaScript.', 'type="text" class="regular-text"' );
        ?>
      </table>

      <h2>QR code</h2>
      <p>Show a QR code on the kiosk that is different for every passer-by. The phone that scans it continues as that kiosk visitor, so what they do next on your site counts toward the variation they saw.</p>
      <?php if ( function_exists( 'ab_get_admin_setting' ) && ab_get_admin_setting( 'ab_use_uuid' ) != '1' ) : ?>
        <div class="notice notice-warning inline"><p>Scans can only be credited with <strong>Advanced Tracking (UUID)</strong> enabled in AB Split Test's settings. Without it the QR code still opens the page, but the phone starts as a new visitor.</p></div>
      <?php endif; ?>
      <table class="form-table" role="presentation">
        <?php
        $field( 'qr_url', 'Page the QR code opens', 'A page on this site, e.g. /offer/ or https://example.com/offer/. Leave empty for no QR code.', 'type="text" class="regular-text"' );
        $field( 'qr_label', 'Text under the QR code', 'E.g. "Scan for 10% off".', 'type="text" class="regular-text"' );
        $field( 'qr_size', 'QR code size (pixels)', 'Bigger codes scan from further away.', 'type="number" min="80" max="600" class="small-text"' );
        ?>
        <tr>
          <th scope="row">Placing it</th>
          <td><p class="description">The code appears in the bottom-left corner. To put it somewhere in your design instead, add an empty element with the class <code>abst-kiosk-qr</code> to each variation.</p></td>
        </tr>
      </table>

      <h2>On screen</h2>
      <table class="form-table" role="presentation">
        <tr>
          <th scope="row">Camera notice</th>
          <td>
            <label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[show_notice]" value="1" <?php checked( $s['show_notice'], '1' ); ?>> Show a small notice on the kiosk while the camera is on</label>
            <p><input type="text" class="large-text" name="<?php echo esc_attr( $name ); ?>[notice_text]" value="<?php echo esc_attr( $s['notice_text'] ); ?>"></p>
            <p class="description">Many places require telling people a camera is in use, even when nothing is recorded. Check what applies where your kiosks are.</p>
          </td>
        </tr>
        <tr>
          <th scope="row">Debug overlay</th>
          <td><label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[debug]" value="1" <?php checked( $s['debug'], '1' ); ?>> Show the camera preview and live numbers on every enrolled kiosk</label></td>
        </tr>
      </table>
      <?php submit_button(); ?>
    </form>

    <h2>Kiosk key</h2>
    <form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
      <input type="hidden" name="action" value="abst_attention_rotate_key">
      <?php wp_nonce_field( 'abst_attention_rotate_key' ); ?>
      <p>Anyone with the key can turn a browser into a kiosk and add data to your tests. Make a new key if it gets out; you will need to enroll your kiosks again.</p>
      <?php submit_button( 'Make a new key', 'secondary', 'submit', false ); ?>
    </form>
  </div>
  <?php
}
