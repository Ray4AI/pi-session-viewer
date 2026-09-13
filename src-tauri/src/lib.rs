pub mod session;

use session::{
    count_sessions, default_sessions_root, list_projects, list_sessions, load_session, ProjectGroup,
    SessionDetail, SessionSummary,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            load_session,
            default_sessions_root,
            count_sessions,
            list_projects,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// Keep the imports referenced so future command additions compile cleanly.
#[allow(dead_code)]
fn _type_anchors(_: Option<SessionDetail>, _: Option<SessionSummary>, _: Option<ProjectGroup>) {}
