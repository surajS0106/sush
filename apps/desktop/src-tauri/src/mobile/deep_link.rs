//! `sush://` links come from desktop Yammer (`deep_link.rs` on desktop).

#[tauri::command]
pub fn deep_link_take() -> Vec<()> {
    Vec::new()
}
