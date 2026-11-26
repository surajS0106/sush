// Android's Back key. MainActivity asks the page (`window.__sushBack`) before doing anything
// itself: each level of "something to go back from" holds a handler here, Back calls the newest,
// and with none left MainActivity sends the app to the background.
//
// This used to keep one webview history entry per level, but Chromium skips history entries a
// page adds without a tap first (a level restored on launch, one opened as another closed), and
// then reports nothing to go back to, so Back left the app from the middle of a chat.

import * as React from "react";

import { isAndroid } from "@/lib/utils";

type Handler = React.RefObject<() => void>;

/** One per level, newest last: Back goes to whatever opened most recently. */
const handlers: Handler[] = [];

if (isAndroid) {
  /** Called by MainActivity for each Back. False when there's nothing left to go back from. */
  (window as unknown as { __sushBack: () => boolean }).__sushBack = () => {
    const handler = handlers.pop();
    if (!handler) return false;
    handler.current();
    return true;
  };
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
  }, [depth]);

  React.useEffect(
    () => () => {
      for (let i = handlers.length - 1; i >= 0; i--) if (handlers[i] === latest) handlers.splice(i, 1);
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
