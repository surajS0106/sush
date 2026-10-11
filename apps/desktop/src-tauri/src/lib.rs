#[cfg(not(debug_assertions))]
mod auth_server;
mod commands;
mod connector_auth;
mod connectors;
mod error;
mod library;
mod runs;
mod secrets;
mod speech;
mod state;
mod store;
mod whisper;

use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol(sush_core::store::BLOB_SCHEME, store::serve_blob)
        // Dictation records in the webview; the OS still asks the user for mic access.
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Microphone => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            app.manage(state::AppState::load(config_dir, app.path().app_data_dir()?)?);
            app.manage(whisper::Whisper::default());
            #[cfg(not(debug_assertions))]
            {
                let server = auth_server::AuthServer::default();
                server.start(&app.path().app_data_dir()?, &app.path().app_log_dir()?)?;
                app.manage(server);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_presets,
            commands::list_providers,
            commands::save_provider,
            commands::delete_provider,
            commands::list_models,
            commands::chat_stream,
            commands::cancel_stream,
            runs::runs_subscribe,
            runs::run_start,
            runs::run_cancel,
            runs::tool_result,
            store::threads_load,
            store::thread_save,
            store::thread_delete,
            store::threads_import,
            store::blob_put,
            store::chats_search,
            store::memory_list,
            store::memory_write,
            store::memory_delete,
            store::memory_clear,
            library::read_folder,
            library::save_text_file,
            library::load_plugin,
            connectors::connector_connect,
            connectors::connector_disconnect,
            connectors::connector_forget,
            connector_auth::connector_authorize,
            connector_auth::connector_cancel_authorize,
            connector_auth::connector_save_secrets,
            speech::transcribe,
            whisper::whisper_model_status,
            whisper::whisper_model_download,
            whisper::transcribe_local,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Sush")
        .run(|_app, _event| {
            #[cfg(not(debug_assertions))]
            if let tauri::RunEvent::Exit = _event {
                _app.state::<auth_server::AuthServer>().stop();
            }
        });
}
