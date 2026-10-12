# Session organisation (incognito, projects, session actions) — Design Notes

Last updated: 2026-10-12

## What changed

### 2026-10-12 (session menu in the active tab)
- The session chevron now sits inside the active tab, between its title and ×, instead of after the + button. `SessionTabs` takes an `activeMenu` node and gives it to whichever tab is active; `App.tsx` passes `SessionMenu` for the open session and `AppHeader` no longer renders it (`components/session-tabs.tsx`, `App.tsx`).
- The trigger is a 20px icon button matching the tab's close button, and stops pointer-down from reaching the tab so a press opens the menu without selecting or dragging the tab (`components/session-actions.tsx`). The torn-off drag preview leaves it out.

### 2026-10-12 (tab rename and right-click menu)
- Menu shortcuts are now one window-level capture listener (`useMenuShortcuts`, mounted with `SessionDialogs`) instead of each menu's `onKeyDown`, so they work wherever focus is. It searches the focused open menu first, then any other open menu, for a `data-shortcut` item and clicks it (`components/session-actions.tsx`).
- Double-clicking a tab renames it in place (`TabTitleInput`): Enter or clicking away saves, Escape cancels, and the tab can't be dragged while editing (`dragListener`). Rename (`R`) in the tab's menu does the same; the sidebar's menu still uses the dialog (`SessionMenuItems`' `onRename`).
- Right-click on a tab (two-finger click or Control-click on macOS) selects it and opens its session menu at the chevron (`openTabMenu`), the same dropdown, now controlled (`components/session-tabs.tsx`).

### 2026-10-12 (session menu restyle)
- The title bar's session chevron moved from the far right to just after the tabs, before the drag spacer (`App.tsx`, `AppHeader`).
- `SessionMenuItems` rows are text only, grouped by separators, each with a single-key shortcut shown on the right: Open in (submenu), Rename `R`, Fork `F`, Add to project (submenu), Pin `P`, Delete `D`. Built from the existing Radix `components/ui/dropdown-menu.tsx` (`DropdownMenuShortcut`, `DropdownMenuLabel`, `DropdownMenuSub`); no new component (`components/session-actions.tsx`).
- `pickShortcut`: a menu's `onKeyDown` that clicks the item whose `data-shortcut` matches the key, in whichever menu or submenu has focus, skipping disabled items. Used by the title bar menu and the sidebar row menu (`components/app-sidebar.tsx`).
- Open in submenu: New window `1` (not for incognito chats), and for Cowork sessions VS Code `2` and Finder `3` (File Explorer / Files off macOS).
- New Rust commands: `session_window` opens a thread in a new window offset 32px from the current one, sharing the builder with `tab_drop` (`open_window` in `src-tauri/src/windows.rs`); `workspace_open_in` opens a workspace folder in VS Code or the file manager via the opener plugin (`src-tauri/src/workspaces.rs`). Bindings `sessionWindow`, `workspaceOpenIn` in `lib/tauri.ts`.

### 2026-10-12
- `ThreadMeta` gains `project_id` (stored; schema migration 3 adds `threads.project_id`) and `incognito` (never stored). `Store::save_thread` returns early for incognito threads, and `upsert_meta` lets `project_id` change, unlike `workspace_id` (`crates/sush-core/src/store.rs`).
- Incognito runs keep their messages in `Runs.incognito`, an in-memory map, instead of SQLite. `run_start` resumes from that map, `thread_delete` clears it (`Runs::forget`), and `prepare` gives incognito runs no workspace, so Cowork never writes checkpoints for them (`apps/desktop/src-tauri/src/runs.rs`, `store.rs`).
- `thread_save` calls `Runs::update_meta`, so renaming, pinning or moving a chat while its run is going is no longer undone by the run's next save.
- `lib/store.ts`: `renameConversation`, `forkConversation` (copies the last saved messages into a new thread titled "… (fork)"), `setConversationProject`, `createIncognitoConversation`. Incognito chats are never persisted from the UI.
- `lib/projects.ts`: projects (name and instructions) kept in localStorage like the rest of the library. Deleting a project keeps its chats and takes them out of it.
- `buildContext` (`lib/agent.ts`) adds the project's instructions to the system prompt. For incognito chats it leaves out memory and past-chat search, both the prompt sections and the tools. `readChat` (`lib/memory.ts`) never returns an incognito chat.
- `components/session-actions.tsx`: one session menu (Rename, Fork, Add/Move to project, Pin, Delete) used by the sidebar row and by a chevron in the title bar. It also holds the rename, project and delete-project dialogs, mounted once, and the ghost `IncognitoToggle`.
- Sidebar (`components/app-sidebar.tsx`): a Projects section. Each project folds open to show its chats, and hovering shows a new-chat button and an options menu. Chats in a project leave the Sessions list (unless pinned), and incognito chats are never listed.
- `App.tsx`: the ghost sits at the top right of every chat session. It opens an incognito chat (reusing the tab if the open chat is untouched) or leaves the open one. Leaving an incognito chat deletes it. "New" from a project chat starts another chat in that project.
- `ChatView`: "You’re incognito" greeting, a dashed composer outline and an explanation under it. A line at the top of the transcript says the chat isn't saved. Project chats show the project name above the greeting. Incognito tabs use the ghost icon (`session-tabs.tsx`).

## Why

Placed after the tab strip, the chevron sat past the + button and read as a menu for the strip or for new tabs, not for the open session. Inside the active tab it is attached to the thing it acts on, as in browsers that put a tab's controls on the tab. It moves with the tab when tabs are reordered and disappears from tabs that aren't open, so it never points at the wrong session.

Incognito is enforced in Rust, not just hidden in the UI. Runs save their own threads, so a UI-only flag would still have written messages and the search index to disk. Keeping the messages in the run manager means edit, regenerate and tool approvals still work mid-chat, and nothing is left behind once the chat is deleted. In exchange, an incognito chat can't be forked, since its history lives only in Rust's memory. Cowork is not offered either, because file checkpoints would persist.

Projects store their instructions in localStorage, where skills and design systems already live. Membership is a column on the thread, so moving a chat survives a reinstall of the UI cache and travels with the thread. Deleting a project never deletes chats: grouping should not put content at risk.

The session menu follows the layout of the title-adjacent menu in Claude's desktop app: the chevron sits next to what it acts on rather than in the far corner, and every common action has a one-key shortcut so the menu can be driven without the pointer. Shortcuts are bound by clicking the item, so the keyboard path runs the exact same `onSelect` and closes the menu the same way. Workspace paths never reach the webview, so opening a folder in another app goes through a Rust command keyed by workspace id.

The menu is shared between the sidebar and the title bar so the same actions are reachable whether or not the sidebar is open. Dialogs live outside the menus because Radix closes a menu when an item is picked.

## What makes it stand out

- The incognito guarantee is checked at the storage layer (`save_thread` refuses incognito metadata) and covered by a test, not just a UI filter.
- Incognito chats are left out of memory and past-chat search both ways: they are never added, and the model gets neither memory nor chat-search tools.
- Renames and pins made during a live run stick, fixing a race the earlier pin-only menu already had.
- Fork writes the copy as a normal saved thread, keeping model, project and folder, so the copy can be continued like any other chat.
- Tabs behave like the desktop conventions on each OS: double-click renames, the secondary click (right-click, two-finger click, Control-click) opens the same menu as the chevron rather than a second, divergent context menu.
- Single-key shortcuts work inside submenus too, and take precedence over Radix type-ahead only for keys that are actually bound.
- Project instructions are injected per run (`runConfig`), so editing them changes the next reply in every chat in the project without touching any stored thread.
