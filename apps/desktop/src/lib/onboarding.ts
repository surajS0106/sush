// The welcome tour (components/onboarding.tsx): shown at launch on a fresh
// install, after signing in, until it's finished or skipped. Settings → General
// turns it back on for the next launch, or opens it right away.

import { useSyncExternalStore } from "react";

import { createStore } from "@/lib/store";

const KEY = "sush.onboarding";

/**
 * An install from before the tour existed has seen a release's notes but never had this key:
 * those people already know their way around, so it starts off for them.
 */
function existingInstall() {
  try {
    return localStorage.getItem(KEY) === null && localStorage.getItem("sush.changelog-seen") !== null;
  } catch {
    return false;
  }
}

/** Whether the tour opens at launch. Shared by every window. */
const atLaunch = createStore<boolean>(KEY, !existingInstall());
/** Whether the tour is on screen in this window. */
const open = createStore<boolean>("sush.onboarding-open", false, false);

export const useOnboardingAtLaunch = () => useSyncExternalStore(atLaunch.subscribe, atLaunch.get);
export const setOnboardingAtLaunch = (on: boolean) => atLaunch.set(on);
export const useOnboardingOpen = () => useSyncExternalStore(open.subscribe, open.get);

/** At launch, from the leader window: open the tour if it's due. */
export function checkOnboarding() {
  if (atLaunch.get()) open.set(true);
}

export const openOnboarding = () => open.set(true);

/** Close the tour, finished or skipped; it won't open at launch again unless turned back on. */
export function finishOnboarding() {
  open.set(false);
  atLaunch.set(false);
}
