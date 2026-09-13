pub mod session;

use session::{default_sessions_root, list_projects, list_sessions, load_session};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            load_session,
            default_sessions_root,
            list_projects,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
