// 由 scripts/gen-tauri-commands.ts 从 src-tauri/src/main.rs 生成，请勿手改。
// 重新生成：bun --cwd packages/desktop run gen:tauri-commands
//
// 这份文件的作用是把「Rust 有哪些 command、参数叫什么、返回什么」变成编译期约束，
// 让 tauri-api-shim.ts 里那些字符串字面量不再是无人校验的运行时赌博。

/** 对应 main.rs 的 `struct ServerReady` */
export interface RustServerReady {
  url: string
  username: string
  password: string
}

/** 对应 main.rs 的 `struct WslConfig` */
export interface RustWslConfig {
  enabled: boolean
}

/** 对应 main.rs 的 `struct WindowConfig` */
export interface RustWindowConfig {
  updaterEnabled: boolean
}

/** 对应 main.rs 的 `struct PickerOpts` */
export interface RustPickerOpts {
  multiple?: boolean | null
  title?: string | null
  defaultPath?: string | null
  extensions?: string[] | null
}

/** 每个 command 的 invoke payload。键名 = Tauri 把 snake_case 参数转成的 camelCase。 */
export interface TauriCommandArgs {
  await_initialization: undefined
  get_default_server_url: undefined
  set_default_server_url: { url?: string | null }
  get_wsl_config: undefined
  set_wsl_config: { config: RustWslConfig }
  store_get: { name: string; key: string }
  store_set: { name: string; key: string; value: string }
  store_delete: { name: string; key: string }
  store_clear: { name: string }
  store_keys: { name: string }
  store_length: { name: string }
  app_version: undefined
  get_window_count: undefined
  get_window_config: undefined
  get_display_backend: undefined
  set_display_backend: undefined
  check_app_exists: undefined
  resolve_app_path: { appName: string }
  wsl_path: { path: string; mode?: string | null }
  set_background_color: { color: string }
  open_directory_picker: { opts?: RustPickerOpts | null }
  open_file_picker: { opts?: RustPickerOpts | null }
  save_file_picker: { opts?: RustPickerOpts | null }
  open_link: { url: string }
  open_path: { path: string; appName?: string | null }
  show_notification: { title: string; body?: string | null }
  write_attachment: { sessionDir: string; filename: string; data: number[] }
  record_fatal_renderer_error: { error: unknown }
}

/** 每个 command resolve 出来的类型。Rust 的 Err 走 reject，不出现在这里。 */
export interface TauriCommandResult {
  await_initialization: RustServerReady
  get_default_server_url: string | null
  set_default_server_url: void
  get_wsl_config: RustWslConfig
  set_wsl_config: void
  store_get: string | null
  store_set: void
  store_delete: void
  store_clear: void
  store_keys: string[]
  store_length: number
  app_version: string
  get_window_count: number
  get_window_config: RustWindowConfig
  get_display_backend: string | null
  set_display_backend: void
  check_app_exists: boolean
  resolve_app_path: string | null
  wsl_path: string
  set_background_color: void
  open_directory_picker: unknown
  open_file_picker: unknown
  save_file_picker: string | null
  open_link: void
  open_path: void
  show_notification: void
  write_attachment: string
  record_fatal_renderer_error: void
}

export type TauriCommand = keyof TauriCommandArgs

/** generate_handler![] 里登记过、因而真正可调用的 command，按登记顺序。 */
export const TAURI_COMMANDS = [
  "await_initialization",
  "get_default_server_url",
  "set_default_server_url",
  "get_wsl_config",
  "set_wsl_config",
  "store_get",
  "store_set",
  "store_delete",
  "store_clear",
  "store_keys",
  "store_length",
  "app_version",
  "get_window_count",
  "get_window_config",
  "get_display_backend",
  "set_display_backend",
  "check_app_exists",
  "resolve_app_path",
  "wsl_path",
  "set_background_color",
  "open_directory_picker",
  "open_file_picker",
  "save_file_picker",
  "open_link",
  "open_path",
  "show_notification",
  "write_attachment",
  "record_fatal_renderer_error",
] as const satisfies readonly TauriCommand[]
