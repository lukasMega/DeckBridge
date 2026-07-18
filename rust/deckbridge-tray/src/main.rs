// No console window on Windows (this is a GUI tray app, not a CLI tool) — a
// plain `#[cfg(windows)]` attribute on the crate isn't valid syntax for this;
// windows_subsystem is a crate-level attribute that must be unconditionally
// present, so it's cfg_attr'd instead. No-op on macOS/Linux.
#![cfg_attr(windows, windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use tao::event::Event;
#[cfg(target_os = "linux")]
use tao::event::StartCause;
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    Icon, TrayIconBuilder,
};

#[cfg(target_os = "macos")]
use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};

// ── embedded icon bytes ─────────────────────────────────────────────────────

const ICON_FULL_BYTES: &[u8] = include_bytes!("../icons/icon-full.png");
const ICON_USB_ONLY_BYTES: &[u8] = include_bytes!("../icons/icon-usb-only.png");
const ICON_DISCONNECTED_BYTES: &[u8] = include_bytes!("../icons/icon-disconnected.png");

// ── types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayState {
    #[serde(default)]
    icon: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    reconnect_attempts: u32,
}

#[derive(Debug, Serialize)]
struct TrayEvent {
    event: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
}

#[derive(Debug)]
enum UserEvent {
    State(TrayState),
    Menu(tray_icon::menu::MenuEvent),
    Quit,
}

// ── helpers ─────────────────────────────────────────────────────────────────

// Tray lifecycle chatter (waiting/connected/disconnected) is only useful when
// debugging — gated behind DECKBRIDGE_LOG=debug (set by the `mise run d` task), which
// the tray process inherits from its parent. Errors always print.
fn debug_log_enabled() -> bool {
    std::env::var("DECKBRIDGE_LOG")
        .map(|v| v.eq_ignore_ascii_case("debug"))
        .unwrap_or(false)
}

fn emit(event: &'static str, port: Option<u16>) {
    let ev = TrayEvent { event, port };
    let mut line = serde_json::to_string(&ev).unwrap();
    line.push('\n');
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let _ = out.write_all(line.as_bytes());
    let _ = out.flush();
}

fn open_browser(url: &str) {
    use std::process::Command;
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let _ = Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = Command::new("xdg-open").arg(url).spawn();
}

/// Load a PNG file from bytes and return an `Icon`.
fn icon_from_bytes(data: &[u8]) -> Option<Icon> {
    let decoder = png::Decoder::new(std::io::Cursor::new(data));
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    let bytes = &buf[..info.buffer_size()];

    // Convert to RGBA if needed
    let rgba = match info.color_type {
        png::ColorType::Rgba => bytes.to_vec(),
        png::ColorType::Rgb => {
            let mut out = Vec::with_capacity(bytes.len() / 3 * 4);
            for chunk in bytes.chunks(3) {
                out.extend_from_slice(chunk);
                out.push(255);
            }
            out
        }
        _ => return None,
    };

    Icon::from_rgba(rgba, info.width, info.height).ok()
}

/// Load icon: try next to executable first, fall back to embedded bytes.
fn load_icon(name: &str, embedded: &[u8]) -> Option<Icon> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Ok(data) = std::fs::read(dir.join(name)) {
                if let Some(icon) = icon_from_bytes(&data) {
                    return Some(icon);
                }
            }
        }
    }
    icon_from_bytes(embedded)
}

struct Icons {
    full: Icon,
    usb_only: Icon,
    disconnected: Icon,
}

impl Icons {
    fn load() -> Self {
        Icons {
            full: load_icon("icon-full.png", ICON_FULL_BYTES)
                .expect("failed to load icon-full.png"),
            usb_only: load_icon("icon-usb-only.png", ICON_USB_ONLY_BYTES)
                .expect("failed to load icon-usb-only.png"),
            disconnected: load_icon("icon-disconnected.png", ICON_DISCONNECTED_BYTES)
                .expect("failed to load icon-disconnected.png"),
        }
    }

    fn for_name(&self, name: &str) -> &Icon {
        match name {
            "full" => &self.full,
            "usb_only" => &self.usb_only,
            _ => &self.disconnected,
        }
    }
}

// ── tray builder ─────────────────────────────────────────────────────────────

struct TrayHandles {
    tray: tray_icon::TrayIcon,
    status_item: MenuItem,
    open_ui_id: tray_icon::menu::MenuId,
    check_req_id: tray_icon::menu::MenuId,
    quit_id: tray_icon::menu::MenuId,
}

fn build_tray(icons: &Icons) -> TrayHandles {
    let tray_menu = Menu::new();

    let header_item = MenuItem::new("DeckBridge", false, None);
    let status_item = MenuItem::new("Status: \u{2014}", false, None);
    let open_ui_item = MenuItem::new("Open Web UI", true, None);
    let check_req_item = MenuItem::new("Check Requirements", true, None);
    let quit_item = MenuItem::new("Quit", true, None);

    let open_ui_id = open_ui_item.id().clone();
    let check_req_id = check_req_item.id().clone();
    let quit_id = quit_item.id().clone();

    tray_menu
        .append_items(&[
            &header_item,
            &status_item,
            &PredefinedMenuItem::separator(),
            &open_ui_item,
            &check_req_item,
            &PredefinedMenuItem::separator(),
            &quit_item,
        ])
        .expect("failed to build tray menu");

    let tray = TrayIconBuilder::new()
        .with_menu(Box::new(tray_menu))
        .with_tooltip("DeckBridge")
        .with_icon(icons.disconnected.clone())
        .build()
        .expect("failed to build tray icon");

    TrayHandles {
        tray,
        status_item,
        open_ui_id,
        check_req_id,
        quit_id,
    }
}

// ── main ─────────────────────────────────────────────────────────────────────

fn main() {
    // Bind listener before touching the event loop so accept() is ready
    let listener = TcpListener::bind("127.0.0.1:0").expect("failed to bind TCP listener");
    let port = {
        use std::net::SocketAddr;
        match listener.local_addr().expect("no local addr") {
            SocketAddr::V4(a) => a.port(),
            SocketAddr::V6(a) => a.port(),
        }
    };

    // Build event loop
    let mut event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();

    #[cfg(target_os = "macos")]
    event_loop.set_activation_policy(ActivationPolicy::Accessory);
    let proxy = event_loop.create_proxy();

    // Forward menu events into our event loop
    let proxy_menu = proxy.clone();
    MenuEvent::set_event_handler(Some(move |ev: tray_icon::menu::MenuEvent| {
        let _ = proxy_menu.send_event(UserEvent::Menu(ev));
    }));

    // Accept thread: parse state lines, send to event loop; quit on EOF
    let proxy_accept = proxy.clone();
    std::thread::spawn(move || {
        if debug_log_enabled() {
            eprintln!(
                "[deckbridge-tray] waiting for TS connection on port {}",
                port
            );
        }
        match listener.accept() {
            Err(e) => {
                eprintln!("[deckbridge-tray] accept error: {}", e);
                let _ = proxy_accept.send_event(UserEvent::Quit);
            }
            Ok((conn, _)) => {
                if debug_log_enabled() {
                    eprintln!("[deckbridge-tray] TS connected");
                }
                let reader = BufReader::new(conn);
                for line in reader.lines() {
                    match line {
                        Err(_) => break,
                        Ok(l) => match serde_json::from_str::<TrayState>(&l) {
                            Ok(state) => {
                                let _ = proxy_accept.send_event(UserEvent::State(state));
                            }
                            Err(e) => {
                                eprintln!("[deckbridge-tray] parse error: {}", e);
                            }
                        },
                    }
                }
                if debug_log_enabled() {
                    eprintln!("[deckbridge-tray] TS disconnected");
                }
                let _ = proxy_accept.send_event(UserEvent::Quit);
            }
        }
    });

    // Load icons
    let icons = Icons::load();

    // On macOS/Windows: build tray before run; on Linux: defer to NewEvents(Init)
    #[allow(unused_mut, unused_assignments)]
    let mut tray_handles: Option<TrayHandles> = None;

    #[cfg(not(target_os = "linux"))]
    {
        tray_handles = Some(build_tray(&icons));
        // Emit ready after tray is built and accept thread is running
        emit("ready", Some(port));
    }

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            #[cfg(target_os = "linux")]
            Event::NewEvents(StartCause::Init) => {
                tray_handles = Some(build_tray(&icons));
                emit("ready", Some(port));
            }

            Event::UserEvent(UserEvent::State(state)) => {
                if let Some(handles) = &tray_handles {
                    let icon = icons.for_name(&state.icon);
                    let _ = handles.tray.set_icon(Some(icon.clone()));
                    let label = if state.reconnect_attempts > 0 {
                        format!(
                            "Status: {} (retry #{})",
                            state.status, state.reconnect_attempts
                        )
                    } else {
                        format!("Status: {}", state.status)
                    };
                    handles.status_item.set_text(&label);
                }
            }

            Event::UserEvent(UserEvent::Menu(ev)) => {
                if let Some(handles) = &tray_handles {
                    if ev.id == handles.open_ui_id {
                        open_browser("http://localhost:3000");
                        emit("open_webui", None);
                    } else if ev.id == handles.check_req_id {
                        open_browser("http://localhost:3000/requirements");
                        emit("check_requirements", None);
                    } else if ev.id == handles.quit_id {
                        emit("quit", None);
                        tray_handles.take();
                        *control_flow = ControlFlow::Exit;
                    }
                }
            }

            Event::UserEvent(UserEvent::Quit) => {
                emit("quit", None);
                tray_handles.take();
                *control_flow = ControlFlow::Exit;
            }

            _ => {}
        }
    });
}
