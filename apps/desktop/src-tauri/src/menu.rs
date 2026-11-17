//! The app menu on macOS: Tauri's default menu, with Edit → Select All handed to the page.
//!
//! The default Select All runs the webview's native select-all, and as a menu key equivalent
//! it takes Cmd+A before the page sees the key. In a doc that native selection means nothing
//! to the editor (ProseMirror), so inside a code block Cmd+A selected nothing. Here Select All
//! keeps its place and shortcut but tells the focused window instead (`menu-select-all`),
//! and `lib/select-all.ts` picks: the doc editor's own select-all, else the native one.

use tauri::menu::{Menu, MenuItem};
use tauri::{AppHandle, Emitter, Runtime};

const SELECT_ALL: &str = "sush-select-all";

/// Sets the app menu and routes its Select All to the page.
pub fn init<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = Menu::default(app)?;
    for kind in menu.items()? {
        let Some(edit) = kind.as_submenu() else { continue };
        if edit.text()? != "Edit" {
            continue;
        }
        for (i, item) in edit.items()?.iter().enumerate() {
            // Its default label is "Select &All" (the & marks a Windows mnemonic).
            let is_select_all = item.as_predefined_menuitem().is_some_and(|p| p.text().unwrap_or_default().replace('&', "") == "Select All");
            if is_select_all {
                edit.remove_at(i)?;
                edit.insert(&MenuItem::with_id(app, SELECT_ALL, "Select All", true, Some("CmdOrCtrl+A"))?, i)?;
                break;
            }
        }
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if *event.id() == SELECT_ALL {
            // Every window hears it; only the focused one acts (document.hasFocus()).
            let _ = app.emit("menu-select-all", ());
        }
    });
    Ok(())
}
