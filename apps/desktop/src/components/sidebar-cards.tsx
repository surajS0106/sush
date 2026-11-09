// The cards at the foot of the sidebar: "New in Sush" (a stack of this release's headline
// changes that cycles on its own and pauses on hover) and "Getting started" (a checklist read from what the
// user has already set up). What's been dismissed is kept per user, in every window.

import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { releasedUpTo, useAppVersion } from "@/lib/changelog";
import { useAutomations } from "@/lib/automations";
import { openSettings, useConnectors, useSettings, useSkills } from "@/lib/library";
import { useConversations, createStore } from "@/lib/store";
import { api } from "@/lib/tauri";
import { useWorkspaces } from "@/lib/workspaces";
import { cn } from "@/lib/utils";

interface CardsState {
  /** The release whose cards were dismissed, and which of them (indexes into its changes). */
  whatsNew?: { version: string; dismissed?: number[] };
  gettingStartedHidden?: boolean;
}

const cards = createStore<CardsState>("sush.sidebar-cards", {});
const useCards = () => useSyncExternalStore(cards.subscribe, cards.get);

const cardClass = "rounded-xl border bg-background text-sm shadow-xs";

export function SidebarCards(props: GettingStartedProps) {
  return (
    <div className="flex flex-col gap-2 px-0.5 pb-1">
      <WhatsNewStack />
      <GettingStarted {...props} />
    </div>
  );
}

// --- New in Sush ------------------------------------------------------------------

/** How far each card behind the front one peeks out above it, in px; more while hovered. */
const PEEK = 8;
const PEEK_HOVER = 13;
/** Cards drawn behind the front one. */
const BEHIND = 2;
/** How long each card stays in front before the stack moves on, in seconds. */
const CYCLE_SECONDS = 6;

const spring = { type: "spring", stiffness: 420, damping: 34 } as const;

function WhatsNewStack() {
  const version = useAppVersion();
  const state = useCards();
  const reduceMotion = useReducedMotion() || document.documentElement.dataset.motion === "reduced";
  const [cursor, setCursor] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // The card in front last render: when it moves to the back it dips out first, then settles in.
  const lastFront = useRef<number | null>(null);

  const release = version ? releasedUpTo(version)[0] : undefined;
  const items = release ? release.changes.flatMap((c, i) => (c.title ? [{ i, title: c.title, text: c.text }] : [])) : [];
  const saved = release && state.whatsNew?.version === release.version ? state.whatsNew.dismissed : undefined;
  // The first version of these cards saved a count here; start over from it.
  const dismissed = Array.isArray(saved) ? saved : [];
  const left = items.filter((c) => !dismissed.includes(c.i));
  const n = left.length;
  const at = n ? ((cursor % n) + n) % n : 0;
  const order = left.map((_, d) => left[(at + d) % n]);
  const frontKey = order[0]?.i ?? null;

  useEffect(() => {
    lastFront.current = frontKey;
  }, [frontKey]);

  if (!release || !n) return null;

  const paused = hovered || focused;
  const cycles = n > 1 && !reduceMotion;
  const peek = hovered ? PEEK_HOVER : PEEK;
  const depthShown = Math.min(n - 1, BEHIND);
  const step = (by: number) => setCursor((c) => c + by);
  const dismiss = () =>
    cards.set((s) => ({ ...s, whatsNew: { version: release.version, dismissed: [...dismissed, order[0].i] } }));
  const openChangelog = () => openSettings({ section: "changelog" });

  return (
    <motion.div
      className="relative"
      initial={false}
      animate={{ paddingTop: peek * depthShown }}
      transition={spring}
      onHoverStart={() => setHovered(true)}
      onHoverEnd={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFocused(false)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") step(-1);
        else if (e.key === "ArrowRight") step(1);
      }}
      role="region"
      aria-roledescription="carousel"
      aria-label={`New in Sush ${release.version}`}
    >
      <AnimatePresence initial={false}>
        {order
          .map((change, depth) => {
            const front = depth === 0;
            const y = -peek * Math.min(depth, BEHIND);
            const scale = 1 - 0.05 * Math.min(depth, BEHIND);
            const opacity = depth > BEHIND ? 0 : front ? 1 : 1 - 0.18 * depth;
            const sendBack = !front && lastFront.current === change.i;
            return (
              <motion.div
                key={change.i}
                className={cn(
                  cardClass,
                  "overflow-hidden",
                  front ? "relative" : "pointer-events-none absolute inset-x-0 bottom-0",
                )}
                style={{ zIndex: n - depth, transformOrigin: "top center", top: front ? undefined : peek * depthShown }}
                initial={{ opacity: 0, y: y - 6, scale }}
                animate={
                  sendBack
                    ? { opacity: [1, 0, opacity], y: [0, 14, y], scale: [1, 0.96, scale] }
                    : { opacity, y, scale }
                }
                exit={{ opacity: 0, x: 24, transition: { duration: 0.18 } }}
                transition={sendBack ? { duration: 0.45, times: [0, 0.4, 1], ease: "easeOut" } : spring}
                aria-hidden={!front}
              >
                <div className="flex h-6 items-center justify-between gap-2 px-3 pt-2.5">
                  <span className="text-xs font-medium text-brand">New in Sush</span>
                  {front && (
                    <span className="-mr-1 flex items-center gap-0.5 text-muted-foreground">
                      {n > 1 && (
                        // Arrows and the count show while the stack is hovered or focused (and so paused).
                        <motion.span
                          className="flex items-center gap-0.5"
                          initial={false}
                          animate={{ opacity: paused ? 1 : 0, x: paused ? 0 : 4 }}
                          transition={{ duration: 0.15 }}
                        >
                          <IconButton label="Previous" onClick={() => step(-1)}>
                            <ChevronLeftIcon className="size-3.5" />
                          </IconButton>
                          <span className="text-[11px] tabular-nums" aria-live="polite">
                            {at + 1}/{n}
                          </span>
                          <IconButton label="Next" onClick={() => step(1)}>
                            <ChevronRightIcon className="size-3.5" />
                          </IconButton>
                        </motion.span>
                      )}
                      <IconButton label="Dismiss" onClick={dismiss}>
                        <XIcon className="size-3.5" />
                      </IconButton>
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={openChangelog}
                  title={change.text}
                  className="block w-full px-3 pt-1 pb-2 text-left font-medium"
                >
                  {change.title}
                </button>
                <button
                  type="button"
                  onClick={openChangelog}
                  className="flex w-full items-center justify-between px-3 pt-1 pb-2.5 text-muted-foreground hover:text-foreground"
                >
                  <span>Full changelog</span>
                  <ChevronRightIcon className="size-4" />
                </button>
                {front && cycles && (
                  // Fills while the card is in front and pauses with the stack; when full, the stack moves on.
                  <span
                    key={cursor}
                    className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-brand/40"
                    style={{
                      animation: `card-cycle ${CYCLE_SECONDS}s linear forwards`,
                      animationPlayState: paused ? "paused" : "running",
                    }}
                    onAnimationEnd={() => step(1)}
                  />
                )}
              </motion.div>
            );
          })
          // Back cards first, so the front one paints over them.
          .reverse()}
      </AnimatePresence>
    </motion.div>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className="rounded-md p-0.5 hover:bg-accent hover:text-foreground">
      {children}
    </button>
  );
}

// --- Getting started ----------------------------------------------------------------

interface GettingStartedProps {
  onNew: () => void;
  onCowork: () => void;
  onAutomations: () => void;
}

interface Step {
  id: string;
  label: string;
  done: boolean;
  run: () => void;
}

/** Whether a model provider is set up; re-read whenever Settings closes. */
function useHasProvider(): boolean | null {
  const settingsOpen = useSettings() !== null;
  const [has, setHas] = useState<boolean | null>(null);
  useEffect(() => {
    if (settingsOpen) return;
    let live = true;
    api
      .listProviders()
      .then((p) => live && setHas(p.length > 0))
      .catch(() => live && setHas(false));
    return () => {
      live = false;
    };
  }, [settingsOpen]);
  return has;
}

function encouragement(done: number, total: number) {
  if (done === 0) return "Let's begin";
  if (done === total) return "All set!";
  if (done / total >= 0.5) return "Over halfway";
  return "Great start!";
}

function GettingStarted({ onNew, onCowork, onAutomations }: GettingStartedProps) {
  const { gettingStartedHidden } = useCards();
  const [open, setOpen] = useState(false);
  const hasProvider = useHasProvider();
  const chatted = useConversations().some((c) => c.messages.length > 0 && !c.incognito);
  const workspaces = useWorkspaces();
  const connectors = useConnectors();
  const automations = useAutomations();
  const skills = useSkills();
  const reduceMotion = useReducedMotion() || document.documentElement.dataset.motion === "reduced";
  const [leaving, setLeaving] = useState(false);
  // Whether the card has been seen with steps left: if everything was already done when it first
  // loaded, it hides at once instead of celebrating.
  const seenIncomplete = useRef(false);

  const complete =
    hasProvider === true &&
    chatted &&
    workspaces.length > 0 &&
    connectors.length > 0 &&
    automations.length > 0 &&
    skills.length > 0;
  const hide = () => cards.set((s) => ({ ...s, gettingStartedHidden: true }));

  // At 100% the card shows "All set!" for a moment, then folds away for good.
  useEffect(() => {
    if (gettingStartedHidden || hasProvider === null) return;
    if (!complete) {
      seenIncomplete.current = true;
      setLeaving(false);
      return;
    }
    if (!seenIncomplete.current) {
      hide();
      return;
    }
    const t = setTimeout(() => setLeaving(true), 1600);
    return () => clearTimeout(t);
  }, [complete, gettingStartedHidden, hasProvider]);

  if (gettingStartedHidden || hasProvider === null) return null;

  const steps: Step[] = [
    { id: "provider", label: "Add a model provider", done: hasProvider, run: () => openSettings({ section: "providers" }) },
    { id: "chat", label: "Start a chat", done: chatted, run: onNew },
    { id: "cowork", label: "Give Sush a folder in Cowork", done: workspaces.length > 0, run: onCowork },
    { id: "connector", label: "Connect an app", done: connectors.length > 0, run: () => openSettings({ section: "connectors" }) },
    { id: "automation", label: "Set up an automation", done: automations.length > 0, run: onAutomations },
    { id: "skill", label: "Teach Sush a skill", done: skills.length > 0, run: () => openSettings({ section: "skills" }) },
  ];
  const done = steps.filter((s) => s.done).length;
  const pct = Math.round((done / steps.length) * 100);

  return (
    <motion.div
      className={cn(cardClass, "overflow-hidden")}
      initial={false}
      animate={leaving ? { opacity: 0, height: 0, marginTop: -8, borderWidth: 0 } : { opacity: 1, height: "auto" }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
      onAnimationComplete={() => leaving && hide()}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="block w-full px-3 pt-2.5 pb-3 text-left"
      >
        <span className="flex items-center justify-between">
          <span className="font-medium">Getting started</span>
          <ChevronRightIcon className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")} />
        </span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {pct}% done · <span className="text-brand">{encouragement(done, steps.length)}</span>
        </span>
        <span className="mt-2 block h-1 overflow-hidden rounded-full bg-muted">
          <motion.span
            className="block h-full rounded-full bg-brand"
            initial={false}
            animate={{ width: `${Math.max(pct, 4)}%` }}
            transition={{ type: "spring", stiffness: 200, damping: 30 }}
          />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <ul className="flex flex-col border-t px-1.5 py-1.5">
              {steps.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={s.run}
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent"
                  >
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-full border",
                        s.done && "border-brand bg-brand text-white",
                      )}
                    >
                      {s.done && <CheckIcon className="size-2.5" strokeWidth={3} />}
                    </span>
                    <span className={cn("truncate", s.done && "text-muted-foreground line-through")}>{s.label}</span>
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={hide}
              className="w-full rounded-b-xl border-t px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
            >
              {done === steps.length ? "Done, hide this" : "Hide"}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
