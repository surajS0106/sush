// Edit → Select All (Cmd+A) on macOS. The menu item is Sush's own (src-tauri/src/menu.rs), so
// the native select-all doesn't run first: the page decides. The focused window sends a
// cancelable `sush:select-all` event from the focused element; whatever handles it (the doc
// editor) calls preventDefault, and otherwise the native select-all runs as before.

import { listen } from "@tauri-apps/api/event";

/** The DOM event a component handles to own Select All for the elements inside it. */
export const SELECT_ALL_EVENT = "sush:select-all";

export function initSelectAll() {
  void listen("menu-select-all", () => {
    // Every window hears the menu; only the one the user is in acts.
    if (!document.hasFocus()) return;
    const target = document.activeElement ?? document.body;
    const unhandled = target.dispatchEvent(new CustomEvent(SELECT_ALL_EVENT, { bubbles: true, cancelable: true }));
    if (unhandled) document.execCommand("selectAll");
  });
}
