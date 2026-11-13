//! Native OS notification for the survey nudge. Blocking waits for the click run on a
//! spawned thread so the tray event loop never stalls.

use crate::{debug_log_enabled, open_browser};
use notify_rust::Notification;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Notify {
    pub title: String,
    pub body: String,
    pub url: String,
}

// The tray opens this in a browser, so accept only the local WebUI.
fn is_local_url(url: &str) -> bool {
    url.starts_with("http://localhost:") || url.starts_with("http://127.0.0.1:")
}

fn debug(msg: &str) {
    if debug_log_enabled() {
        eprintln!("[deckbridge-tray] notify: {msg}");
    }
}

// Set by the Tauri shell so a toast/notification carries the installed app's identity
// (bundle id on macOS, AUMID on Windows). Without it the sender is the OS fallback
// (Finder on macOS, "Windows PowerShell" on Windows).
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn app_id() -> Option<String> {
    std::env::var("DECKBRIDGE_APP_ID")
        .ok()
        .filter(|id| !id.is_empty())
}

pub fn show(n: Notify) {
    if !is_local_url(&n.url) {
        debug("ignored non-local url");
        return;
    }
    std::thread::spawn(move || {
        let mut note = Notification::new();
        note.summary(&n.title).body(&n.body);
        configure_identity(&mut note);
        #[cfg(target_os = "linux")]
        note.action("default", "Open");
        // No notification service (headless Linux, macOS without permission): not an error.
        match note.show() {
            Ok(handle) => wait_for_click(handle, &n.url),
            Err(e) => debug(&format!("not shown: {e}")),
        }
    });
}

#[cfg(target_os = "macos")]
fn configure_identity(_note: &mut Notification) {
    if let Some(id) = app_id() {
        let _ = notify_rust::set_application(&id);
    }
}

#[cfg(target_os = "windows")]
fn configure_identity(note: &mut Notification) {
    if let Some(id) = app_id() {
        note.app_id(&id);
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn configure_identity(note: &mut Notification) {
    note.appname("DeckBridge");
}

#[cfg(target_os = "linux")]
fn wait_for_click(handle: notify_rust::NotificationHandle, url: &str) {
    handle.wait_for_action(|action| {
        if action == "default" {
            open_browser(url);
        }
    });
}

#[cfg(not(target_os = "linux"))]
fn wait_for_click(handle: notify_rust::NotificationHandle, url: &str) {
    let res = handle.wait_for_response(|r: &notify_rust::NotificationResponse| {
        if matches!(r, notify_rust::NotificationResponse::Default) {
            open_browser(url);
        }
    });
    if let Err(e) = res {
        debug(&format!("no click response: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_local_urls_are_opened() {
        assert!(is_local_url("http://localhost:3000/?survey=1"));
        assert!(is_local_url("http://127.0.0.1:3001/?survey=1"));
        assert!(!is_local_url("https://example.com/"));
        assert!(!is_local_url("http://localhost.evil.com/"));
        assert!(!is_local_url("file:///etc/passwd"));
    }
}
