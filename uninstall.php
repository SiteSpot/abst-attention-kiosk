<?php
// Deleting the plugin removes its settings and kiosk key. Kiosk enrollment
// lives in each kiosk browser's localStorage and stops working with the key.
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
  exit;
}
delete_option( 'abst_attention_kiosk' );
