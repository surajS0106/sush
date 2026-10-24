#[cfg(not(debug_assertions))]
mod auth_server;
mod browser;
mod commands;
mod connector_auth;
mod connectors;
#[cfg(target_os = "macos")]
mod dock_icon;
mod error;
mod images;
mod library;
mod paths;
mod reports;
mod runs;
mod secrets;
mod share;
mod speech;
mod state;
mod store;
mod terminal;
mod whisper;
mod windows;
mod workspaces;

use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    paths::init();
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
            let config_dir = paths::config_dir(app.handle())?;
            secrets::init(&config_dir);
            app.manage(state::AppState::load(config_dir, paths::data_dir(app.handle())?)?);
            if let (Some(profile), Some(window)) = (paths::profile(), app.get_webview_window("main")) {
                let _ = window.set_title(&format!("Sush ({profile})"));
            }
            // Check the sandbox now, so the first Cowork command doesn't wait for it.
            let sandbox = app.state::<state::AppState>().sandbox.clone();
            tauri::async_runtime::spawn(async move {
                sandbox.status().await;
            });
            app.manage(whisper::Whisper::default());
            app.manage(browser::Browser::default());
            #[cfg(not(debug_assertions))]
            {
                let server = auth_server::AuthServer::default();
                server.start(&app.path().app_data_dir()?, &app.path().app_log_dir()?)?;
                app.manage(server);
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { .. } => windows::closing(window),
            tauri::WindowEvent::Destroyed => windows::destroyed(window),
            #[cfg(target_os = "macos")]
            tauri::WindowEvent::ThemeChanged(theme) => dock_icon::apply(*theme),
            _ => {}
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
            runs::agent_spawn,
            runs::thread_rewind,
            runs::run_interrupt,
            runs::tool_result,
            share::share_account,
            share::share_account_sign_in,
            share::share_account_use_token,
            share::share_account_sign_out,
            share::share_start,
            share::share_invite_create,
            share::share_invites_list,
            share::share_invite_revoke,
            share::share_admit,
            share::share_kick,
            share::share_set_policy,
            share::share_end,
            share::share_join,
            share::share_leave,
            share::share_request,
            share::shares_state,
            workspaces::workspaces_list,
            workspaces::workspace_add,
            workspaces::workspace_update,
            workspaces::workspace_remove,
            workspaces::workspace_tree,
            workspaces::turn_changes,
            workspaces::turn_diff,
            workspaces::workspace_git,
            workspaces::workspace_git_switch,
            workspaces::workspace_git_log,
            workspaces::workspace_git_commit,
            workspaces::workspace_branch_status,
            workspaces::worktree_create,
            workspaces::undo_turn,
            workspaces::workspace_read_file,
            workspaces::workspace_find,
            workspaces::workspace_write_file,
            workspaces::workspace_reveal,
            workspaces::workspace_open_in,
            workspaces::sandbox_status,
            reports::reports_list,
            reports::report_create,
            reports::report_rerun,
            reports::report_ask_thread,
            reports::report_delete,
            browser::browser_subscribe,
            browser::browser_open,
            browser::browser_go,
            browser::browser_set_view,
            terminal::terminal_open,
            terminal::terminal_run,
            terminal::terminal_write,
            terminal::terminal_interrupt,
            terminal::terminal_complete,
            terminal::terminal_close,
            store::threads_load,
            store::thread_save,
            store::thread_delete,
            store::threads_import,
            store::blob_put,
            store::image_fetch,
            store::image_search,
            store::blob_data_url,
            store::chats_search,
            store::memory_list,
            store::memory_write,
            store::memory_delete,
            store::memory_clear,
            library::pick_folder_attachment,
            library::save_text_file_as,
            library::save_bytes_file_as,
            library::load_plugin,
            connectors::connector_connect,
            connectors::connector_disconnect,
            connectors::connector_forget,
            connector_auth::connector_authorize,
            connector_auth::connector_cancel_authorize,
            connector_auth::connector_save_secrets,
            speech::transcribe,
            images::image_generate,
            whisper::whisper_model_status,
            whisper::whisper_model_download,
            whisper::transcribe_local,
            windows::tab_drop,
            windows::tab_hover,
            windows::session_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Sush")
        .run(|_app, _event| {
            // After Ready: in dev, Tauri sets its own Dock icon while handling it.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Ready = _event {
                if let Some(window) = _app.get_webview_window("main") {
                    dock_icon::apply(window.theme().unwrap_or(tauri::Theme::Light));
                }
            }
            #[cfg(not(debug_assertions))]
            if let tauri::RunEvent::Exit = _event {
                _app.state::<auth_server::AuthServer>().stop();
            }
        });
}
