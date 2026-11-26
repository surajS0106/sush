import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** The Android app: no folders, shell, extra windows or local programs (docs/android.md). */
export const isAndroid = /Android/.test(navigator.userAgent);

/** A phone-sized window on Android, where a side panel covers the chat. */
export const isPhone = () => isAndroid && window.innerWidth < 768;

/** Focus the chat composer with the caret at the end. Returns false if there's no composer, or on a phone, where it would bring up the keyboard. */
export function focusComposer(): boolean {
  if (isPhone()) return false;
  const el = document.querySelector<HTMLTextAreaElement>("textarea[name=message]");
  if (!el) return false;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
  return true;
}
