// Tray-supervisor shell around the existing `deckbridge` binary.
// Windows (NSIS installer) and macOS (.dmg, ad-hoc signed) — same code path.
//
// Model A (see .claude/plans/2026-06-18_deckbridge-tauri-wrapper.md §3/§5):
// this Tauri app shows NO window and reimplements NONE of the relay/UI/USB
// logic. It bundles the real `deckbridge` binary as a sidecar (externalBin),
// bundles `deckbridge-tray` next to it, spawns the sidecar on startup, and is
// responsible only for clean process-tree teardown on quit (gotcha G1).
//
// The sidecar serves the web UI on localhost:3000, runs the CORA TCP servers,
// advertises mDNS, and — exactly as it does when run standalone — spawns
// `deckbridge-tray` as its own tray. We deliberately do NOT add a second Tauri
// TrayIconBuilder tray (locked decision: keep `deckbridge-tray`).

use std::sync::{Arc, Mutex};

use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// Sidecar base name as referenced by `app.shell().sidecar(..)`. Tauri matches
// `binaries/<this>-<target-triple>(.exe)` from the externalBin config and runs
// the triple-matched copy that the bundler installed next to the app exe.
const SIDECAR_NAME: &str = "deckbridge";

// The deckbridge-tray sidecar is bundled alongside the main binary. After install it
// sits next to the Tauri app exe with the target triple stripped, i.e.
// `deckbridge-tray.exe`. The main binary reads DECKBRIDGE_TRAY_BIN first (ts/src/app.ts), so we
// point it at the bundled copy explicitly rather than relying on its
// next-to-exe auto-detect (which looks for `deckbridge-tray` without the .exe
// suffix and would miss it on Windows).
#[cfg(windows)]
const TRAY_BIN_FILENAME: &str = "deckbridge-tray.exe";
#[cfg(not(windows))]
const TRAY_BIN_FILENAME: &str = "deckbridge-tray";

/// Holds the running sidecar child so the exit handler can kill its whole
/// process tree. `None` once it has exited or been taken for killing.
#[derive(Default)]
struct SidecarChild(Arc<Mutex<Option<CommandChild>>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let child_slot: Arc<Mutex<Option<CommandChild>>> = Arc::new(Mutex::new(None));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarChild(child_slot.clone()))
        .setup(move |app| {
            let handle = app.handle().clone();

            // Path to the bundled deckbridge-tray, next to this app's executable.
            let tray_bin = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.join(TRAY_BIN_FILENAME)));

            let mut command = handle.shell().sidecar(SIDECAR_NAME)?;
            if let Some(tray) = tray_bin {
                command = command.env("DECKBRIDGE_TRAY_BIN", tray.to_string_lossy().to_string());
            }

            let (mut rx, child) = command.spawn()?;
            *child_slot.lock().unwrap() = Some(child);

            // Drain the sidecar event stream. The only thing we act on is
            // termination: when the sidecar exits (e.g. the user picked Quit in
            // deckbridge-tray, which shuts the relay down), the supervisor must not
            // linger — exit the Tauri app too (plan §5 step 4). Stdout/stderr
            // are forwarded to our own stdout for log visibility.
            let slot = child_slot.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            print!("{}", String::from_utf8_lossy(&bytes));
                        }
                        CommandEvent::Stderr(bytes) => {
                            eprint!("{}", String::from_utf8_lossy(&bytes));
                        }
                        CommandEvent::Terminated(_) => {
                            // Sidecar gone — drop our handle (nothing left to
                            // kill) and quit the supervisor.
                            *slot.lock().unwrap() = None;
                            handle.exit(0);
                            break;
                        }
                        _ => {}
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building deckbridge tauri supervisor")
        .run(move |app, event| {
            // Kill-on-exit (gotcha G1). Tauri does not reliably reap spawned
            // children, and our sidecar itself spawns deckbridge-tray (and possibly
            // mDNS helpers), so we kill the entire process tree by PID rather
            // than just the direct child.
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                let state = app.state::<SidecarChild>();
                let child = state.0.lock().unwrap().take();
                if let Some(child) = child {
                    kill_tree(&child);
                }
            }
        });
}

/// Kill the sidecar and all of its descendants.
#[cfg(windows)]
fn kill_tree(child: &CommandChild) {
    use std::process::Command;
    let pid = child.pid();
    // /T = terminate the process tree (children too), /F = force.
    let _ = Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .status();
}

/// Unix (macOS/Linux) process-tree teardown — mirrors the intent of the Windows
/// `taskkill /F /T`. The relay is cooperative: on SIGTERM it runs its shutdown
/// handler (ts/src/app.ts → shutdown() → tray.close()), which SIGTERMs
/// `deckbridge-tray` and frees ports 3000/5343/5344. So we SIGTERM the relay first and
/// let it reap its own children cleanly. As a backstop against a hung/SIGKILLed
/// relay that never runs its handler, we then walk the descendant tree
/// (`pgrep -P`, recursively) and SIGTERM any survivors so no orphan
/// `deckbridge-tray`/mDNS helper lingers. tauri-plugin-shell does NOT put the child in
/// its own process group, so a single `kill -<pgid>` is not reliable here.
#[cfg(unix)]
fn kill_tree(child: &CommandChild) {
    use std::process::Command;
    let pid = child.pid();

    // Collect descendant PIDs before signalling, so the tree is still intact.
    let descendants = collect_descendants(pid);

    // Ask the relay to shut down cleanly (it tears down deckbridge-tray + ports).
    let _ = Command::new("kill").arg(pid.to_string()).status();

    // Backstop: SIGTERM any descendants the relay didn't reap (deepest first so
    // we don't re-parent grandchildren onto init mid-teardown).
    for d in descendants.into_iter().rev() {
        let _ = Command::new("kill").arg(d.to_string()).status();
    }
}

/// Best-effort walk of `pgrep -P <pid>` to collect the PIDs of all descendants
/// of `root`. Parents are pushed before their own children are discovered, so a
/// child always appears after its parent in the returned vec; `kill_tree`
/// reverses it to signal children before parents.
#[cfg(unix)]
fn collect_descendants(root: u32) -> Vec<u32> {
    use std::process::Command;
    let mut out = Vec::new();
    let mut queue = vec![root];
    while let Some(pid) = queue.pop() {
        let children = Command::new("pgrep")
            .args(["-P", &pid.to_string()])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .split_whitespace()
                    .filter_map(|s| s.parse::<u32>().ok())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for c in children {
            out.push(c);
            queue.push(c);
        }
    }
    out
}

/// Fallback for any non-Windows, non-Unix target (keeps the crate compiling
/// everywhere). Best-effort direct kill of the child only.
#[cfg(all(not(windows), not(unix)))]
fn kill_tree(child: &CommandChild) {
    let pid = child.pid();
    let _ = std::process::Command::new("kill")
        .arg(pid.to_string())
        .status();
}
