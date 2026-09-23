<?php
/**
 * Settings tests for the Attention Kiosk add-on.
 *
 * Runs standalone (no WordPress install needed):
 *   php tests/settings.test.php
 *
 * The sanitize callback runs on every update_option() of the setting, including
 * the plugin's own key writes, so it has to keep a key it is given (rotation),
 * keep the stored key when the settings form posts without one, and never
 * recurse into the key generator.
 */

error_reporting( E_ALL );
define( 'ABSPATH', dirname( __DIR__ ) . '/' );

$GLOBALS['abst_att_option'] = false;
$GLOBALS['abst_att_writes'] = 0;

function add_action() {}
function apply_filters( $hook, $value ) { return $value; }
function wp_parse_args( $args, $defaults ) { return array_merge( $defaults, is_array( $args ) ? $args : array() ); }
function get_option( $name, $default = false ) { return $GLOBALS['abst_att_option'] === false ? $default : $GLOBALS['abst_att_option']; }
function update_option( $name, $value ) {
	$GLOBALS['abst_att_writes']++;
	// What register_setting() does: run the sanitize callback, then store.
	$GLOBALS['abst_att_option'] = abst_attention_sanitize( $value );
	return true;
}
function wp_generate_password( $length ) { return substr( str_repeat( 'Kx9', $length ), 0, $length ); }
function sanitize_text_field( $value ) { return trim( strip_tags( (string) $value ) ); }
function wp_unslash( $value ) { return $value; }
function esc_url_raw( $url ) { return (string) $url; }
function home_url( $path = '' ) { return 'https://site.test' . $path; }
function wp_json_encode( $value ) { return json_encode( $value ); }
function is_wp_error( $value ) { return $value instanceof WP_Error; }
class WP_Error {}
function nocache_headers() { $GLOBALS['abst_att_nocache'] = true; }
function wp_script_is( $handle, $list ) { return $handle === 'bt_conversion_scripts'; }
function wp_add_inline_script( $handle, $js, $where ) { $GLOBALS['abst_att_inline'][] = [ $handle, $js, $where ]; }
// Stand-in for ABST core's lookup: one known visitor.
function abst_lookup_visitor_test_data( $uuid ) {
	if ( $uuid !== '0f8fad5b-d9cb-469f-a165-70867728950e' ) {
		return [ 'uuid' => $uuid, 'found' => false, 'tests' => [] ];
	}
	return [ 'uuid' => $uuid, 'found' => true, 'tests' => [
		[ 'test_id' => 42, 'test_status' => 'publish', 'variation' => 'b', 'converted' => true, 'goals' => [ '2', '5' ], 'device_size' => 'desktop', 'audience_ids' => '' ],
		[ 'test_id' => 43, 'test_status' => 'draft', 'variation' => 'a', 'converted' => false, 'goals' => [] ],
	] ];
}

require dirname( __DIR__ ) . '/abst-attention-kiosk.php';

$failures = 0;
function check( $label, $condition ) {
	global $failures;
	echo ( $condition ? 'ok   ' : 'FAIL ' ) . $label . "\n";
	if ( ! $condition ) {
		$failures++;
	}
}

// First read generates and stores a key, once.
$first = abst_attention_settings();
check( 'first read generates a 24 character key', strlen( $first['key'] ) === 24 );
check( 'the generated key is stored', $GLOBALS['abst_att_option']['key'] === $first['key'] );
check( 'reading again does not write', ( function () { $before = $GLOBALS['abst_att_writes']; abst_attention_settings(); return $GLOBALS['abst_att_writes'] === $before; } )() );

// The settings form never posts the key; saving it keeps the stored one.
update_option( ABST_ATTENTION_OPTION, array(
	'conversion_seconds' => '3',
	'goal_seconds'       => '8, nope, 20, -1',
	'max_yaw'            => '500',
	'pitch_offset'       => '-12',
	'test_ids'           => '42, abc, 7',
	'notice_text'        => '<b>Camera</b> on',
	'show_notice'        => '1',
) );
$saved = $GLOBALS['abst_att_option'];
check( 'saving the form keeps the key', $saved['key'] === $first['key'] );
check( 'conversion seconds saved', (float) $saved['conversion_seconds'] === 3.0 );
check( 'goal seconds keep only positive numbers', $saved['goal_seconds'] === '8, 20' );
check( 'yaw is clamped to 90', (float) $saved['max_yaw'] === 90.0 );
check( 'negative pitch offset allowed', (float) $saved['pitch_offset'] === -12.0 );
check( 'missing numbers keep their current value', (float) $saved['leave_seconds'] === 5.0 );
check( 'test IDs keep only numbers', $saved['test_ids'] === '42, 7' );
check( 'notice text is stripped of HTML', $saved['notice_text'] === 'Camera on' );
check( 'unchecked debug box saves as off', $saved['debug'] === '0' );

// Rotation writes a new key through the same callback; it must stick.
$rotated        = abst_attention_settings();
$rotated['key'] = 'NewKey123';
update_option( ABST_ATTENTION_OPTION, $rotated );
check( 'a rotated key is kept', $GLOBALS['abst_att_option']['key'] === 'NewKey123' );
check( 'rotation keeps the other settings', $GLOBALS['abst_att_option']['goal_seconds'] === '8, 20' );

// Conversion mode, QR settings.
update_option( ABST_ATTENTION_OPTION, [ 'conversion_mode' => 'seconds', 'qr_url' => '/offer/', 'qr_label' => '<i>Scan</i> me', 'qr_size' => '5000' ] );
$saved = $GLOBALS['abst_att_option'];
check( 'seconds-looking mode saved', $saved['conversion_mode'] === 'seconds' );
check( 'a QR path becomes a full address on this site', $saved['qr_url'] === 'https://site.test/offer/' );
check( 'QR label is stripped of HTML', $saved['qr_label'] === 'Scan me' );
check( 'QR size is clamped', (int) $saved['qr_size'] === 600 );
update_option( ABST_ATTENTION_OPTION, [ 'conversion_mode' => 'bogus', 'qr_url' => 'javascript:alert(1)' ] );
check( 'unknown conversion mode falls back to first look', $GLOBALS['abst_att_option']['conversion_mode'] === 'first' );
check( 'non-web QR link is dropped', $GLOBALS['abst_att_option']['qr_url'] === '' );
check( 'protocol-relative QR link is dropped', abst_attention_sanitize_url( '//evil.test/x' ) === '' );
check( 'an https QR link is kept', abst_attention_sanitize_url( ' https://shop.test/o?a=1 ' ) === 'https://shop.test/o?a=1' );

// QR handoff: the scanning phone gets the kiosk visitor's assignment cookies.
$cookies = abst_attention_handoff_cookies( abst_lookup_visitor_test_data( '0f8fad5b-d9cb-469f-a165-70867728950e' )['tests'] );
check( 'only running tests are handed off', array_keys( $cookies ) === [ 'btab_42' ] );
$btab = json_decode( $cookies['btab_42'], true );
check( 'handoff keeps the variation', $btab['variation'] === 'b' && $btab['eid'] === 42 );
check( 'handoff marks the kiosk conversion as done', $btab['conversion'] === 1 );
check( 'handoff marks logged goals at their index', $btab['goals'] === [ null, null, 1, null, null, 1 ] );
check( 'handoff goals are a JSON array (abstGoal needs one)', strpos( $cookies['btab_42'], '"goals":[' ) !== false );
$odd = json_decode( abst_attention_handoff_cookies( [ [ 'test_id' => 8, 'test_status' => 'publish', 'variation' => 'a', 'goals' => [ '-1', '99999999', 'x', '1' ] ] ] )['btab_8'], true );
check( 'implausible goal numbers are ignored', $odd['goals'] === [ null, 1 ] );
check( 'no goals is an empty array', json_decode( abst_attention_handoff_cookies( [ [ 'test_id' => 7, 'test_status' => 'publish', 'variation' => 'a' ] ] )['btab_7'], true )['goals'] === [] );

$_GET = [ 'abst_scan' => 'not-a-uuid' ];
abst_attention_handoff_lookup();
check( 'a malformed scan ID is ignored', empty( $GLOBALS['abst_attention_handoff'] ) && empty( $GLOBALS['abst_att_nocache'] ) );

$_GET = [ 'abst_scan' => '11111111-2222-4333-8444-555555555555' ];
abst_attention_handoff_lookup();
check( 'an unknown visitor adopts nothing', empty( $GLOBALS['abst_attention_handoff'] ) );
check( 'but the page is still kept out of page caches', ! empty( $GLOBALS['abst_att_nocache'] ) && defined( 'DONOTCACHEPAGE' ) );

$_GET = [ 'abst_scan' => '0F8FAD5B-D9CB-469F-A165-70867728950E' ];
abst_attention_handoff_lookup();
abst_attention_handoff_script();
$inline = $GLOBALS['abst_att_inline'][0] ?? [ '', '', '' ];
check( 'a known visitor is handed off (ID case-insensitive)', $GLOBALS['abst_attention_handoff']['uuid'] === '0f8fad5b-d9cb-469f-a165-70867728950e' );
check( 'handoff script runs right after the ABST tracker', $inline[0] === 'bt_conversion_scripts' && $inline[2] === 'after' );
check( 'handoff script carries the cookies and the ID', strpos( $inline[1], 'btab_42' ) !== false && strpos( $inline[1], '"0f8fad5b-d9cb-469f-a165-70867728950e"' ) !== false );

check( 'number list parsing', abst_attention_parse_numbers( ' 1.5,2  3 ' ) === array( 1.5, 2.0, 3.0 ) );

exit( $failures ? 1 : 0 );
