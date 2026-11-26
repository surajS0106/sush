// Android's Back key. The webview goes back through its own history before the activity sees the
// key (and MainActivity sends the app to the background), so every level of "something to go back
// from" gets a history entry for the key to use up. With none left, Back leaves the app.
//
// Entries are only ever added as a level opens, never after a Back: the webview's goBack skips an
// entry whose page then added another without a tap, which would drop Back straight out of the app.

import * as React from "react";

import { isAndroid } from "@/lib/utils";

type Handler = React.RefObject<() => void>;

/** One per level, newest last: Back goes to whatever opened most recently. */
const handlers: Handler[] = [];
/** How many entries are on top of the page's first one. */
let entries = 0;
/** A `history.go` of ours is on its way; history can't be touched until it lands. */
let removing = false;

function sync() {
  if (removing) return;
  if (handlers.length < entries) {
    removing = true;
    history.go(handlers.length - entries);
  }
  while (entries < handlers.length) history.pushState({ entries: ++entries }, "");
}

if (isAndroid) {
  window.addEventListener("popstate", (e) => {
    const landed = (e.state as { entries?: number } | null)?.entries ?? 0;
    const used = entries - landed;
    entries = landed;
    if (removing) removing = false;
    // Usually one, but the webview may skip an entry that was opened along with another.
    else for (let i = 0; i < used; i++) handlers.pop()?.current();
    sync();
  });
}

/** Keeps `depth` levels for the Back key, which calls `onBack` once for each it uses up. Does nothing off Android. */
export function useBackKey(depth: number, onBack: () => void) {
  const latest = React.useRef(onBack);
  latest.current = onBack;

  React.useEffect(() => {
    if (!isAndroid) return;
    let held = handlers.filter((h) => h === latest).length;
    for (; held < depth; held++) handlers.push(latest);
    for (; held > depth; held--) handlers.splice(handlers.lastIndexOf(latest), 1);
    sync();
  }, [depth]);

  React.useEffect(
    () => () => {
      if (!isAndroid || !handlers.includes(latest)) return;
      for (let i = handlers.length - 1; i >= 0; i--) if (handlers[i] === latest) handlers.splice(i, 1);
      sync();
    },
    [],
  );
}

/** Rendered inside something that closes: Back closes it (by default as Escape would). */
export function BackCloses({ onBack = pressEscape }: { onBack?: () => void }) {
  useBackKey(1, onBack);
  return null;
}

/** Radix closes whatever is on top on Escape. */
function pressEscape() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}
