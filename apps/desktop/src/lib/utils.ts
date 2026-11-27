import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** The Android app (docs/android.md): Back key, system bars, in-app updates. */
export const isAndroid = /Android/.test(navigator.userAgent);

/** The iOS app (docs/ios.md). Its user agent also says "Mac OS X", so check this before any Mac test. */
export const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);

/** A phone app, Android or iOS: no folders, shell, extra windows or local programs. */
export const isMobile = isAndroid || isIOS;

/** The Mac desktop app (an iPhone's user agent says "like Mac OS X" too). */
export const isMac = navigator.userAgent.includes("Mac") && !isIOS;

/** A phone-sized window in a phone app, where a side panel covers the chat. */
export const isPhone = () => isMobile && window.innerWidth < 768;

/** Focus the chat composer with the caret at the end. Returns false if there's no composer, or on a phone, where it would bring up the keyboard. */
export function focusComposer(): boolean {
  if (isPhone()) return false;
  const el = document.querySelector<HTMLTextAreaElement>("textarea[name=message]");
  if (!el) return false;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
  return true;
}
