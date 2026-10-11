//! Dock icon that follows the system appearance (macOS only).
//!
//! macOS 26 swaps app icons itself from the compiled `Assets.car` (release
//! builds, see icons/build-mac-icon.sh). Everywhere else (`tauri dev`, older
//! macOS, local builds without Xcode) the bundle only has the light
//! `icon.icns`, so the running app sets the matching Dock tile itself.

use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSImage};
use objc2_foundation::{ns_string, NSBundle, NSData, NSOperatingSystemVersion, NSProcessInfo};
use tauri::Theme;

const LIGHT: &[u8] = include_bytes!("../icons/dock-light.png");
const DARK: &[u8] = include_bytes!("../icons/dock-dark.png");

/// Set the Dock icon for `theme`. Must run on the main thread.
pub fn apply(theme: Theme) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    if system_swaps_icon() {
        return;
    }
    let bytes = if theme == Theme::Dark { DARK } else { LIGHT };
    let Some(image) = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(bytes)) else { return };
    // SAFETY: on the main thread, with a valid image.
    unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&image)) };
}

/// Whether macOS already switches the icon: 26+ with an asset-catalog icon.
fn system_swaps_icon() -> bool {
    let tahoe = NSOperatingSystemVersion { majorVersion: 26, minorVersion: 0, patchVersion: 0 };
    NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(tahoe)
        && NSBundle::mainBundle().objectForInfoDictionaryKey(ns_string!("CFBundleIconName")).is_some()
}
