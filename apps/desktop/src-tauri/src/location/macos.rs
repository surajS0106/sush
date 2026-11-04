//! The device's position from CoreLocation. WKWebView on macOS refuses
//! `navigator.geolocation` by itself when its host has no private delegate for
//! it, without ever asking the user, so the position has to come from here.
//! Must run on the main thread, whose run loop delivers the delegate's calls.

use std::cell::{Cell, RefCell};

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_core_location::{
    kCLLocationAccuracyBest, CLAuthorizationStatus, CLError, CLLocation, CLLocationManager, CLLocationManagerDelegate,
};
use objc2_foundation::{NSArray, NSBundle, NSError, NSObject, NSObjectProtocol};

use super::Position;

const BLOCKED: &str =
    "Location access is off for Sush. Turn it on in System Settings → Privacy & Security → Location Services, then try again.";
const NOT_FOUND: &str = "Your Mac couldn't find its location. Check that Wi-Fi is on, then try again.";
const NOT_BUNDLED: &str = "Device location only works in a built copy of Sush, not a dev run. Save your address in Settings to use it here.";

pub type Done = Box<dyn FnOnce(Result<Position, String>) + Send>;

pub struct Ivars {
    done: Cell<Option<Done>>,
    asked: Cell<bool>,
    requested: Cell<bool>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "SushLocationDelegate"]
    #[ivars = Ivars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl CLLocationManagerDelegate for Delegate {
        #[unsafe(method(locationManagerDidChangeAuthorization:))]
        fn did_change_authorization(&self, manager: &CLLocationManager) {
            self.advance(manager);
        }

        #[unsafe(method(locationManager:didUpdateLocations:))]
        fn did_update_locations(&self, _manager: &CLLocationManager, locations: &NSArray<CLLocation>) {
            let Some(location) = locations.lastObject() else { return };
            // SAFETY: plain getters on a location CoreLocation gave us.
            let (coordinate, accuracy) = unsafe { (location.coordinate(), location.horizontalAccuracy()) };
            self.finish(Ok(Position { latitude: coordinate.latitude, longitude: coordinate.longitude, accuracy_meters: accuracy }));
        }

        #[unsafe(method(locationManager:didFailWithError:))]
        fn did_fail(&self, _manager: &CLLocationManager, error: &NSError) {
            self.finish(Err(if error.code() == CLError::Denied.0 { BLOCKED } else { NOT_FOUND }.to_string()));
        }
    }
);

impl Delegate {
    fn new(mtm: MainThreadMarker, done: Done) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Ivars { done: Cell::new(Some(done)), asked: Cell::new(false), requested: Cell::new(false) });
        // SAFETY: NSObject's `init`, on a class with no other initialiser.
        unsafe { msg_send![super(this), init] }
    }

    /// Ask for permission or for the position, whichever comes next. CoreLocation
    /// calls back on every change, so each step only ever runs once.
    fn advance(&self, manager: &CLLocationManager) {
        // SAFETY: plain calls on a live manager, on the main thread.
        unsafe {
            match manager.authorizationStatus() {
                CLAuthorizationStatus::NotDetermined => {
                    if !self.ivars().asked.replace(true) {
                        manager.requestWhenInUseAuthorization();
                    }
                }
                CLAuthorizationStatus::Restricted | CLAuthorizationStatus::Denied => self.finish(Err(BLOCKED.to_string())),
                _ => {
                    if !self.ivars().requested.replace(true) {
                        manager.requestLocation();
                    }
                }
            }
        }
    }

    fn finish(&self, result: Result<Position, String>) {
        if let Some(done) = self.ivars().done.take() {
            done(result);
        }
    }
}

thread_local! {
    /// The request in progress, kept alive here: the manager holds its delegate weakly.
    /// `requestLocation` delivers one position and stops, so nothing keeps tracking.
    static ACTIVE: RefCell<Option<(Retained<CLLocationManager>, Retained<Delegate>)>> = const { RefCell::new(None) };
}

/// Read the position once, asking for permission first if the user hasn't been asked.
pub fn read(done: Done) {
    let Some(mtm) = MainThreadMarker::new() else {
        return done(Err(NOT_FOUND.to_string()));
    };
    // `tauri dev` runs a bare executable. locationd can't verify one, so it neither
    // prompts nor answers, and the request would just sit there until it times out.
    if !NSBundle::mainBundle().bundlePath().to_string().ends_with(".app") {
        return done(Err(NOT_BUNDLED.to_string()));
    }
    let delegate = Delegate::new(mtm, done);
    // SAFETY: a new manager used on the main thread, with a delegate kept alive in `ACTIVE`.
    let manager = unsafe {
        let manager = CLLocationManager::new();
        manager.setDesiredAccuracy(kCLLocationAccuracyBest);
        manager.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        manager
    };
    delegate.advance(&manager);
    ACTIVE.with(|active| *active.borrow_mut() = Some((manager, delegate)));
}
