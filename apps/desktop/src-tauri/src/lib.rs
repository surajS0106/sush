#[cfg(target_os = "android")]
mod android;
#[cfg(all(desktop, not(debug_assertions)))]
mod auth_server;
#[cfg_attr(mobile, path = "mobile/browser.rs")]
mod browser;
mod commands;
mod connector_auth;
mod connectors;
mod crm;
mod docs;
mod engine_bridge;
#[cfg(target_os = "macos")]
mod dock_icon;
mod error;
mod files;
mod flights;
mod images;
mod library;
mod location;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod login_env;
mod maps;
#[cfg(target_os = "macos")]
mod menu;
mod notebooks;
mod paths;
mod reports;
mod runs;
mod secrets;
mod share;
mod speech;
mod state;
mod store;
mod terminal;
mod topic;
mod voice;
mod web;
mod weather;
#[cfg_attr(mobile, path = "mobile/whisper.rs")]
mod whisper;
mod widgets;
#[cfg_attr(mobile, path = "mobile/windows.rs")]
mod windows;
mod workspaces;
#[cfg_attr(mobile, path = "mobile/deep_link.rs")]
mod deep_link;
mod yammer;

use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    login_env::init();
    paths::init();
    let builder = tauri::Builder::default();
    // First, so a second launch hands its arguments (a sush:// link on Windows and Linux) to this
    // copy and exits. Not for a second profile in a debug build, which runs beside the first (paths.rs).
    #[cfg(desktop)]
    let builder = match paths::profile() {
        None => builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| deep_link::focus(app))),
        Some(_) => builder,
    };
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(android::plugin());
    builder
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol(sush_core::store::BLOB_SCHEME, store::serve_blob)
        .register_uri_scheme_protocol(widgets::SCHEME, widgets::serve)
        // Dictation records in the webview; the OS still asks the user for mic access.
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Microphone => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .setup(|app| {
            let config_dir = paths::config_dir(app.handle())?;
            secrets::init(&config_dir);
            app.manage(state::AppState::load(config_dir, paths::data_dir(app.handle())?)?);
            #[cfg(desktop)]
            deep_link::init(app.handle());
            #[cfg(target_os = "macos")]
            menu::init(app.handle())?;
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
            app.manage(voice::VoiceSessions::default());
            #[cfg(all(desktop, not(debug_assertions)))]
            {
                let server = auth_server::AuthServer::default();
                server.start(auth_server::Dirs {
                    data: app.path().app_data_dir()?,
                    log: app.path().app_log_dir()?,
                    viewer: app.path().resource_dir().ok().map(|d| d.join("viewer")),
                })?;
                app.manage(server);
                // Installing an update on Windows exits through `std::process::exit` without
                // `RunEvent::Exit`; the updater calls `cleanup_before_exit` first, which drops this.
                app.resources_table().add(auth_server::StopOnCleanup(app.handle().clone()));
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
            commands::engines_list,
            commands::chat_stream,
            commands::cancel_stream,
            runs::runs_subscribe,
            runs::run_start,
            runs::run_cancel,
            runs::agent_spawn,
            runs::thread_rewind,
            runs::thread_compact,
            runs::run_interrupt,
            runs::tool_result,
            share::share_account,
            share::share_account_sign_in,
            share::share_account_use_token,
            share::share_account_sign_out,
            share::share_lan_address,
            share::local_relay,
            share::local_relay_set_lan,
            share::share_start,
            share::share_invite_create,
            share::share_invites_list,
            share::share_invite_revoke,
            share::share_admit,
            share::share_kick,
            share::share_set_policy,
            share::share_set_role,
            share::share_control,
            share::share_step_away,
            share::share_suggestion_accept,
            share::share_suggestion_drop,
            share::share_comment,
            share::share_config_result,
            share::share_end,
            share::share_join,
            share::share_leave,
            share::share_rejoin,
            share::share_forget,
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
            workspaces::workspace_git_rebase,
            workspaces::workspace_git_log,
            workspaces::workspace_git_commit,
            workspaces::workspace_branch_status,
            workspaces::workspace_pr_checks,
            workspaces::workspace_check_failure,
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
            notebooks::notebooks_list,
            notebooks::notebook_create,
            notebooks::notebook_rename,
            notebooks::notebook_customize,
            notebooks::notebook_set_overview,
            notebooks::notebook_set_chat,
            notebooks::notebook_card_review,
            notebooks::notebook_search,
            notebooks::notebook_pick_cover,
            notebooks::notebook_source_set_guide,
            notebooks::notebook_set_reader,
            notebooks::notebook_note_create,
            notebooks::notebook_note_update,
            notebooks::notebook_note_delete,
            notebooks::notebook_note_set_data,
            notebooks::notebook_studio_start,
            notebooks::notebook_delete,
            notebooks::notebook_add_thread,
            notebooks::notebook_add_text,
            notebooks::notebook_add_link,
            notebooks::notebook_add_files,
            notebooks::notebook_add_file_data,
            notebooks::notebook_add_chat,
            notebooks::notebook_add_workspace_file,
            notebooks::notebook_source_update,
            notebooks::notebook_source_delete,
            notebooks::notebook_source_retry,
            notebooks::notebook_source_text,
            docs::docs_list,
            docs::doc_tool,
            docs::doc_create,
            docs::doc_update,
            docs::doc_restore,
            docs::doc_set_date,
            docs::doc_delete,
            crm::crm_load,
            crm::crm_save,
            crm::crm_save_many,
            crm::crm_delete,
            crm::crm_restore,
            crm::crm_activities,
            crm::crm_activity_add,
            crm::crm_activity_delete,
            crm::crm_view_save,
            crm::crm_view_delete,
            crm::crm_settings_save,
            crm::crm_import_pick,
            crm::crm_import,
            crm::crm_sample,
            crm::crm_search,
            connectors::connector_read,
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
            store::docx_edit,
            store::docx_pdf,
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
            connectors::swiggy_order_preview,
            connectors::instamart_cart_read,
            connectors::instamart_cart_write,
            widgets::connector_widget,
            connector_auth::connector_authorize,
            connector_auth::connector_cancel_authorize,
            connector_auth::connector_save_secrets,
            speech::transcribe,
            speech::tts_speak,
            voice::voice_keys,
            voice::voice_key_set,
            voice::voice_key_delete,
            voice::voice_catalog,
            voice::voice_speak,
            voice::voice_transcribe,
            voice::voice_think,
            voice::voice_realtime_start,
            voice::voice_realtime_audio,
            voice::voice_realtime_interrupt,
            voice::voice_realtime_end,
            images::image_generate,
            maps::maps_key_status,
            maps::maps_key_set,
            maps::maps_key_delete,
            maps::maps_details,
            flights::flights_key_status,
            flights::flights_key_set,
            flights::flights_key_delete,
            flights::flights_search,
            flights::flights_booking_links,
            flights::flights_weather,
            flights::flights_locate,
            flights::flights_rates,
            location::location_read,
            #[cfg(target_os = "android")]
            android::android_bars,
            #[cfg(target_os = "android")]
            android::android_update_check,
            #[cfg(target_os = "android")]
            android::android_update_install,
            topic::topic_lookup,
            web::web_key_status,
            web::web_key_set,
            web::web_key_delete,
            web::web_search,
            web::web_fetch,
            weather::weather_now,
            whisper::whisper_model_status,
            whisper::whisper_model_download,
            whisper::transcribe_local,
            windows::tab_drop,
            windows::tab_hover,
            windows::session_window,
            yammer::yammer_status,
            yammer::yammer_toggle,
            yammer::yammer_open,
            deep_link::deep_link_take,
            yammer::yammer_mcp_server,
            yammer::yammer_meeting,
            yammer::yammer_open_meeting,
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
            if let tauri::RunEvent::Exit = _event {
                if let Some(state) = _app.try_state::<state::AppState>() {
                    if let Err(e) = state.store.forget_session_locations() {
                        eprintln!("Could not remove session-only locations: {e:?}");
                    }
                }
            }
            #[cfg(all(desktop, not(debug_assertions)))]
            if let tauri::RunEvent::Exit = _event {
                _app.state::<auth_server::AuthServer>().stop();
            }
        });
}
