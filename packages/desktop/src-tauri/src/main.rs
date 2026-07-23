#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[derive(Clone, Serialize)]
struct ServerReady {
    url: String,
    username: String,
    password: String,
}

struct SidecarState(Mutex<Option<ServerReady>>);

// Mirrors sidecar.ts's ensureLoopbackNoProxy(): force 127.0.0.1/localhost/::1 into
// NO_PROXY so the sidecar's own outbound requests don't loop through a configured
// proxy. Pure string manipulation, portable as-is from the Electron original.
fn merge_loopback_no_proxy(existing: Option<String>) -> String {
    const LOOPBACK: [&str; 3] = ["127.0.0.1", "localhost", "::1"];
    let mut items: Vec<String> = existing
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    for host in LOOPBACK {
        if !items.iter().any(|v| v.eq_ignore_ascii_case(host)) {
            items.push(host.to_string());
        }
    }
    items.join(",")
}

// Mirrors packages/desktop/src/main/index.ts's awaitInitialization: resolve once the
// real sidecar reports its listening URL, not before. Verified against this exact
// mechanism in the throwaway 260723 prototype (see tauri-migration-plan.md §7.2) —
// this is the real (non-stub) port of that fix.
//
// Env injection ported from sidecar.ts's prepareSidecarEnv/ensureLoopbackNoProxy —
// but NOT all of it. Confirmed by reading the actual source before porting:
//   - REDCODE_SERVER_USERNAME/PASSWORD: plain process.env reads on the server side
//     (packages/core/src/flag/flag.ts, server/auth.ts) — ported below as-is.
//   - loopback NO_PROXY/no_proxy: pure env-var string merging — ported below as-is.
//   - XDG_STATE_HOME: NOT ported. packages/core/src/global.ts (since commit 55ab646)
//     hardcodes all state under ~/.redcode regardless of this env var — Electron
//     still sets it but it's a no-op today. Setting it here would just be dead code.
//   - useSystemCertificates()/useEnvProxy() from sidecar.ts: NOT portable at all.
//     Those are in-process Node API calls (tls.setDefaultCACertificates,
//     http.setGlobalProxyFromEnv) that only work because Electron's sidecar forks
//     a JS file in-process and calls them before importing the server. A Tauri
//     sidecar is a separate compiled exe — there's no in-process hook to call them
//     from here. The compiled `redcode.exe serve` doesn't call any equivalent
//     itself either, so this is a real (pre-existing, not newly introduced) gap
//     for anyone running the plain CLI standalone, Tauri or not. Fixing it for
//     real means adding the equivalent Bun API calls inside serve.ts/the CLI
//     bootstrap itself, not something this Rust wrapper can paper over.
#[tauri::command]
async fn await_initialization(app: AppHandle) -> Result<ServerReady, String> {
    {
        let state = app.state::<SidecarState>();
        let guard = state.0.lock().unwrap();
        if let Some(ready) = guard.clone() {
            return Ok(ready);
        }
    }

    let username = "redcode".to_string();
    let password = uuid::Uuid::new_v4().to_string();
    let no_proxy = merge_loopback_no_proxy(std::env::var("NO_PROXY").ok());
    let no_proxy_lower = merge_loopback_no_proxy(std::env::var("no_proxy").ok());

    let shell = app.shell();
    let (mut rx, _child) = shell
        .sidecar("redcode")
        .map_err(|e| e.to_string())?
        .args(["serve"])
        .env("REDCODE_SERVER_USERNAME", &username)
        .env("REDCODE_SERVER_PASSWORD", &password)
        .env("NO_PROXY", &no_proxy)
        .env("no_proxy", &no_proxy_lower)
        .spawn()
        .map_err(|e| e.to_string())?;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let text = String::from_utf8_lossy(&line);
                if let Some(idx) = text.find("listening on ") {
                    let url = text[idx + "listening on ".len()..].trim().to_string();
                    let ready = ServerReady {
                        url,
                        username: username.clone(),
                        password: password.clone(),
                    };
                    let state = app.state::<SidecarState>();
                    *state.0.lock().unwrap() = Some(ready.clone());
                    return Ok(ready);
                }
            }
            CommandEvent::Error(err) => {
                return Err(format!("sidecar spawn error: {}", err));
            }
            CommandEvent::Terminated(payload) => {
                return Err(format!("sidecar exited before reporting a URL: {:?}", payload));
            }
            _ => {}
        }
    }
    Err("sidecar event stream ended unexpectedly".into())
}

// Mirrors server.ts's getDefaultServerUrl(): no tauri-plugin-store wiring yet
// (that's task #4 in the migration TODO, alongside the rest of the A-tier IPC),
// so this honestly returns None rather than faking a persisted default.
#[tauri::command]
fn get_default_server_url() -> Option<String> {
    None
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            await_initialization,
            get_default_server_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
