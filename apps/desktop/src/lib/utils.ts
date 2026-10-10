import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Focus the chat composer with the caret at the end. Returns false if there's no composer. */
export function focusComposer(): boolean {
  const el = document.querySelector<HTMLTextAreaElement>("textarea[name=message]");
  if (!el) return false;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
  return true;
}
