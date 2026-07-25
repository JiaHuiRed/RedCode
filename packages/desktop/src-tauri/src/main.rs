#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_store::StoreExt;

// 260724 Red task #4 (A-tier IPC): real tauri-plugin-store persistence, replacing
// the JSON-file-per-store-name hack from the throwaway prototype (see
// tauri-migration-plan.md §7.2 item 3 — that hack was verified necessary because
// the desktop sidebar's "recently opened projects" list depends on real
// persistence, not a no-op stub). Mirrors main/store.ts's getStore(name) +
// main/ipc.ts's store-get/set/delete/clear/keys/length exactly:
//   - one store (one file) per `name`, looked up lazily — same as Electron's
//     `cache.get(name) ?? new Store(...)` pattern, tauri-plugin-store's own
//     app.store(name) already caches by path so no extra Map needed here.
//   - values are always plain strings on the wire (the renderer's own
//     AsyncStorage-shaped wrapper stringifies before calling storeSet and
//     parses after storeGet) — store_get returns None for missing/non-string
//     values exactly like ipc.ts's `value === undefined || value === null` ?
//     null : (typeof value === "string" ? value : JSON.stringify(value))
//     branch, store_set always writes a bare JSON string.
//   - .save() is called explicitly after every mutation rather than relying on
//     tauri-plugin-store's debounced autosave, matching electron-store's
//     synchronous-write-on-set behavior — a killed process shouldn't lose a
//     write that already returned success to the renderer.
fn read_store_string(app: &AppHandle, name: &str, key: &str) -> Option<String> {
    let store = app.store(name).ok()?;
    match store.get(key)? {
        serde_json::Value::String(s) => Some(s),
        other => Some(other.to_string()),
    }
}

fn write_store_string(app: &AppHandle, name: &str, key: &str, value: String) -> Result<(), String> {
    let store = app.store(name).map_err(|e| e.to_string())?;
    store.set(key, serde_json::Value::String(value));
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn store_get(app: AppHandle, name: String, key: String) -> Option<String> {
    read_store_string(&app, &name, &key)
}

#[tauri::command]
fn store_set(app: AppHandle, name: String, key: String, value: String) -> Result<(), String> {
    write_store_string(&app, &name, &key, value)
}

#[tauri::command]
fn store_delete(app: AppHandle, name: String, key: String) -> Result<(), String> {
    let store = app.store(&name).map_err(|e| e.to_string())?;
    store.delete(&key);
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn store_clear(app: AppHandle, name: String) -> Result<(), String> {
    let store = app.store(&name).map_err(|e| e.to_string())?;
    store.clear();
    store.save().map_err(|e| e.to_string())
}

#[tauri::command]
fn store_keys(app: AppHandle, name: String) -> Vec<String> {
    app.store(&name).map(|store| store.keys()).unwrap_or_default()
}

#[tauri::command]
fn store_length(app: AppHandle, name: String) -> usize {
    app.store(&name).map(|s| s.length()).unwrap_or(0)
}

const SETTINGS_STORE: &str = "redcode.settings";
const DEFAULT_SERVER_URL_KEY: &str = "defaultServerUrl";

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

// Mirrors server.ts's getDefaultServerUrl/setDefaultServerUrl exactly, now wired
// to the real store (see store_get/store_set above) instead of a stub.
#[tauri::command]
fn get_default_server_url(app: AppHandle) -> Option<String> {
    read_store_string(&app, SETTINGS_STORE, DEFAULT_SERVER_URL_KEY)
}

#[tauri::command]
fn set_default_server_url(app: AppHandle, url: Option<String>) -> Result<(), String> {
    match url {
        Some(url) => write_store_string(&app, SETTINGS_STORE, DEFAULT_SERVER_URL_KEY, url),
        None => {
            let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
            store.delete(DEFAULT_SERVER_URL_KEY);
            store.save().map_err(|e| e.to_string())
        }
    }
}

const WSL_ENABLED_KEY: &str = "wslEnabled";

#[derive(Clone, Serialize, serde::Deserialize)]
struct WslConfig {
    enabled: bool,
}

// Mirrors server.ts's getWslConfig/setWslConfig — unlike the string-only generic
// store_get/set above, Electron stores this key's value as a real JS boolean
// (`typeof value === "boolean" ? value : false`), not a stringified one, so this
// bypasses read_store_string/write_store_string and reads/writes serde_json::Value::Bool
// directly.
#[tauri::command]
fn get_wsl_config(app: AppHandle) -> WslConfig {
    let enabled = app
        .store(SETTINGS_STORE)
        .ok()
        .and_then(|store| store.get(WSL_ENABLED_KEY))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    WslConfig { enabled }
}

#[tauri::command]
fn set_wsl_config(app: AppHandle, config: WslConfig) -> Result<(), String> {
    let store = app.store(SETTINGS_STORE).map_err(|e| e.to_string())?;
    store.set(WSL_ENABLED_KEY, serde_json::Value::Bool(config.enabled));
    store.save().map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(SidecarState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            await_initialization,
            get_default_server_url,
            set_default_server_url,
            get_wsl_config,
            set_wsl_config,
            store_get,
            store_set,
            store_delete,
            store_clear,
            store_keys,
            store_length
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
