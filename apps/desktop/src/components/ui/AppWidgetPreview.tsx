"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Figma, Spotify, type Icon as GrommetIcon } from "grommet-icons";
import {
  PlayIcon as PhPlay,
  PauseIcon as PhPause,
  ArrowUpRightIcon as PhArrowUpRight,
  LinkIcon as PhLink,
  PlusIcon as PhPlus,
  CheckIcon as PhCheck,
  ThumbsUpIcon as PhThumbsUp,
  ThumbsDownIcon as PhThumbsDown,
  DevicesIcon as PhDevices,
  CircleNotchIcon as PhCircleNotch,
} from "@phosphor-icons/react";

const EASE = [0.22, 1, 0.36, 1] as const;
const CONNECTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function connectionStorageKey(appName: string) {
  return `app-widget:connected:${appName}`;
}

function readPersistedConnection(appName: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const stored = window.localStorage.getItem(connectionStorageKey(appName));
    if (!stored) return false;
    const lastUsed = Number(stored);
    if (Number.isNaN(lastUsed) || Date.now() - lastUsed > CONNECTION_TTL_MS) {
      window.localStorage.removeItem(connectionStorageKey(appName));
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function touchPersistedConnection(appName: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(connectionStorageKey(appName), String(Date.now()));
  } catch {
    // Storage unavailable (e.g. private browsing): connection just won't persist across visits.
  }
}

function ShimmerBlock({ className }: { className: string }) {
  return (
    <div className={`relative overflow-hidden rounded-md bg-stone-200 dark:bg-stone-700 ${className}`}>
      <motion.span
        aria-hidden
        className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/60 to-transparent dark:via-white/10"
        animate={{ x: ["-100%", "100%"] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: "linear" }}
      />
    </div>
  );
}

function PlayIcon() {
  return <PhPlay size={14} weight="fill" aria-hidden />;
}

function PauseIcon() {
  return <PhPause size={14} weight="fill" aria-hidden />;
}

function ArrowUpRightIcon() {
  return <PhArrowUpRight size={13} weight="bold" aria-hidden />;
}

function LinkIcon() {
  return <PhLink size={14} aria-hidden />;
}

function PlusIcon() {
  return <PhPlus size={16} weight="bold" aria-hidden />;
}

function CheckIcon() {
  return <PhCheck size={16} weight="bold" aria-hidden />;
}

function ThumbIcon({ direction }: { direction: "up" | "down" }) {
  return direction === "up" ? <PhThumbsUp size={13} aria-hidden /> : <PhThumbsDown size={13} aria-hidden />;
}

function DevicesIcon() {
  return <PhDevices size={14} aria-hidden />;
}

function SpinnerIcon() {
  return (
    <motion.span
      className="inline-flex"
      aria-hidden
      animate={{ rotate: 360 }}
      transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
    >
      <PhCircleNotch size={14} weight="bold" />
    </motion.span>
  );
}

function EqualizerBars({ active }: { active: boolean }) {
  const shouldReduceMotion = useReducedMotion();
  const bars = [0, 1, 2];
  return (
    <span className="flex h-3 items-end gap-[2px]" aria-hidden>
      {bars.map((i) => (
        <motion.span
          key={i}
          className="w-[2.5px] rounded-full bg-white"
          animate={
            active && !shouldReduceMotion
              ? { height: ["30%", "100%", "55%", "90%", "30%"] }
              : { height: "35%" }
          }
          transition={active && !shouldReduceMotion ? { duration: 0.9, repeat: Infinity, delay: i * 0.12, ease: "easeInOut" } : { duration: 0.2 }}
        />
      ))}
    </span>
  );
}

export type AppWidgetItem = {
  id: string;
  title: string;
  subtitle: string;
  swatch: string;
  icon?: string;
  meta?: string;
};

export type AppWidgetApp = {
  name: string;
  glyph: string;
  accent: string;
  accentButton: string;
  loginUrl?: string;
  // The real brand mark (e.g. grommet-icons' `Spotify`/`Figma`), shown instead of
  // the colored-initial fallback when the app has one available.
  logo?: GrommetIcon;
  // grommet-icons ships every mark on a declared 24x24 viewBox regardless of the
  // artwork's real bounding box: Spotify's circle genuinely fills it, but Figma's
  // portrait mark only occupies the left two-thirds, leaving invisible padding
  // that makes it render smaller and left-shifted next to a true full-bleed icon
  // at the same size. Overriding the viewBox per app crops tightly to that app's
  // actual artwork so every logo fills its badge edge-to-edge the same way. Omit
  // for logos that already fill their default viewBox.
  logoViewBox?: string;
};

function AppIdentityMark({ app, className }: { app: AppWidgetApp; className: string }) {
  if (app.logo) {
    const Logo = app.logo;
    return (
      <span className={`flex shrink-0 items-center justify-center rounded-full bg-white shadow-sm ring-1 ring-black/5 ${className}`} aria-hidden>
        {/* grommet-icons' own `size` prop parses the unit off the end of the string
            with a letters-only regex, so a percentage like "60%" silently becomes a
            literal 60px, the same fixed pixel size regardless of which badge it's
            in: the actual bug behind logos looking mismatched next to each other.
            Sizing via inline style on the SVG itself bypasses that parser and lets
            it scale relative to this wrapper instead, correctly for both the 24px
            header chip and the 44px sign-in avatar. */}
        <span className="flex h-[60%] w-[60%] items-center justify-center">
          <Logo color="plain" viewBox={app.logoViewBox} style={{ width: "100%", height: "100%" }} />
        </span>
      </span>
    );
  }
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-full font-bold text-white ${app.accent} ${className}`} aria-hidden>
      {app.glyph}
    </span>
  );
}

export type AppWidgetHero = { title: string; subtitle: string; gradient: string; icon?: string };

export type AppWidgetHeaderAction = { kind: "devices"; devices: string[] } | { kind: "copyLink"; label?: string };

type AppWidgetCommonProps = {
  app: AppWidgetApp;
  headerAction?: AppWidgetHeaderAction;
};

export type AppWidgetDemoProps = AppWidgetCommonProps & {
  mode?: "demo";
  hero: AppWidgetHero;
  items: AppWidgetItem[];
  resultKind?: "audio" | "document";
  addLabel?: string;
  addedLabel?: string;
};

export type AppWidgetLiveProps = AppWidgetCommonProps & {
  mode: "live";
  embedUrl: string;
  embedTitle: string;
  embedHeight?: number;
};

export type AppWidgetProps = AppWidgetDemoProps | AppWidgetLiveProps;

function AppWidgetHeaderBar({ appName, headerAction }: { appName: string; headerAction?: AppWidgetHeaderAction }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState(() => (headerAction?.kind === "devices" ? headerAction.devices[0] : ""));
  const [copied, setCopied] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const copyTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) window.clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (menuRef.current?.contains(e.target as Node) || menuButtonRef.current?.contains(e.target as Node)) {
        return;
      }
      setMenuOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <div className="flex items-center justify-between border-b border-stone-100 px-4 py-2.5 dark:border-stone-800">
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-stone-500 dark:text-stone-500">From {appName}</span>
      {headerAction && (
        <div className="relative">
          {headerAction.kind === "devices" ? (
            <>
              <button
                ref={menuButtonRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
                className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium text-stone-500 transition-colors duration-150 hover:bg-stone-100 hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-200"
              >
                <DevicesIcon />
                Devices
              </button>
              <AnimatePresence>
                {menuOpen && (
                  <motion.div
                    ref={menuRef}
                    role="menu"
                    aria-label="Playback devices"
                    initial={{ opacity: 0, scale: 0.95, y: -4 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: -4 }}
                    transition={{ duration: 0.15, ease: EASE }}
                    className="absolute right-0 top-full z-10 mt-1.5 min-w-40 rounded-xl border border-stone-200 bg-white p-1 shadow-[0_1px_2px_-1px_rgba(0,0,0,0.06),0_4px_12px_-4px_rgba(0,0,0,0.08)] dark:shadow-none dark:border-stone-700 dark:bg-stone-900"
                  >
                    {headerAction.devices.map((device) => (
                      <button
                        key={device}
                        type="button"
                        role="menuitemradio"
                        aria-checked={device === selectedDevice}
                        onClick={() => {
                          setSelectedDevice(device);
                          setMenuOpen(false);
                          menuButtonRef.current?.focus();
                        }}
                        className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs text-stone-600 transition-colors duration-100 hover:bg-emerald-500/10 dark:text-stone-300 dark:hover:bg-emerald-500/15"
                      >
                        {device}
                        {device === selectedDevice && <CheckIcon />}
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          ) : (
            <button
              type="button"
              aria-label={copied ? "Link copied" : (headerAction.label ?? "Copy link")}
              onClick={() => {
                setCopied(true);
                if (copyTimeoutRef.current) window.clearTimeout(copyTimeoutRef.current);
                copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 1600);
              }}
              className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium text-stone-500 transition-colors duration-150 hover:bg-stone-100 hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-200"
            >
              {copied ? <CheckIcon /> : <LinkIcon />}
              {copied ? "Copied" : (headerAction.label ?? "Copy link")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AppWidgetLiveBody({
  resolved,
  embedUrl,
  embedTitle,
  embedHeight = 352,
  onLoad,
}: {
  resolved: boolean;
  embedUrl: string;
  embedTitle: string;
  embedHeight?: number;
  onLoad: () => void;
}) {
  return (
    <div className="p-3">
      <div className="relative overflow-hidden rounded-xl" style={{ height: embedHeight }}>
        <iframe
          src={embedUrl}
          title={embedTitle}
          width="100%"
          height={embedHeight}
          style={{ display: "block", border: 0 }}
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
          allowFullScreen
          loading="lazy"
          onLoad={onLoad}
        />
        <AnimatePresence>
          {!resolved && (
            <motion.div key="live-loading" exit={{ opacity: 0 }} transition={{ duration: 0.3 }} className="absolute inset-0">
              <ShimmerBlock className="h-full w-full rounded-xl" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function AppWidgetDemoBody({
  resolved,
  shouldReduceMotion,
  app,
  hero,
  items,
  resultKind = "audio",
  addLabel = "Add to library",
  addedLabel = "Added to library",
}: {
  resolved: boolean;
  shouldReduceMotion: boolean | null;
  app: AppWidgetApp;
  hero: AppWidgetHero;
  items: AppWidgetItem[];
  resultKind?: "audio" | "document";
  addLabel?: string;
  addedLabel?: string;
}) {
  const [added, setAdded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const listVariants = {
    hidden: {},
    show: { transition: { staggerChildren: shouldReduceMotion ? 0 : 0.05, delayChildren: shouldReduceMotion ? 0 : 0.05 } },
  };
  const itemVariants = {
    hidden: shouldReduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 },
    show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: EASE } },
  };

  const isHeroActive = activeId === "hero";
  const heroIdleLabel = resultKind === "audio" ? "Play" : "Open";
  const heroActiveLabel = resultKind === "audio" ? "Pause" : "Opened";

  return (
    <>
      <div className="p-4">
        <AnimatePresence mode="wait">
          {resolved ? (
            <motion.div
              key="hero-resolved"
              initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="flex items-center gap-3"
            >
              <div className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-2xl ${hero.gradient}`} aria-hidden>
                {hero.icon}
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-[15px] font-semibold text-stone-900 dark:text-stone-100">{hero.title}</h3>
                <p className="mt-0.5 truncate text-sm text-stone-500 dark:text-stone-400">{hero.subtitle}</p>
              </div>
              <button
                type="button"
                aria-pressed={added}
                aria-label={added ? addedLabel : addLabel}
                onClick={() => setAdded((v) => !v)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-stone-300 text-stone-500 transition-colors duration-150 hover:border-stone-400 hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:border-stone-600 dark:text-stone-400 dark:hover:border-stone-500 dark:hover:text-stone-200"
              >
                {added ? <CheckIcon /> : <PlusIcon />}
              </button>
              {resultKind === "audio" ? (
                <button
                  type="button"
                  aria-pressed={isHeroActive}
                  aria-label={`${isHeroActive ? heroActiveLabel : heroIdleLabel} ${hero.title}`}
                  onClick={() => setActiveId((prev) => (prev === "hero" ? null : "hero"))}
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 ${app.accentButton}`}
                >
                  {isHeroActive ? <PauseIcon /> : <PlayIcon />}
                </button>
              ) : (
                <button
                  type="button"
                  aria-pressed={isHeroActive}
                  aria-label={`${isHeroActive ? heroActiveLabel : heroIdleLabel} ${hero.title}`}
                  onClick={() => setActiveId((prev) => (prev === "hero" ? null : "hero"))}
                  className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 ${app.accentButton}`}
                >
                  {isHeroActive ? <CheckIcon /> : <ArrowUpRightIcon />}
                  {isHeroActive ? heroActiveLabel : heroIdleLabel}
                </button>
              )}
            </motion.div>
          ) : (
            <motion.div key="hero-loading" exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="flex items-center gap-3">
              <ShimmerBlock className="h-16 w-16 shrink-0" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <ShimmerBlock className="h-3.5 w-2/3" />
                <ShimmerBlock className="h-3 w-1/3" />
              </div>
              <ShimmerBlock className="h-8 w-8 shrink-0 rounded-full" />
              <ShimmerBlock className={resultKind === "audio" ? "h-9 w-9 shrink-0 rounded-full" : "h-9 w-20 shrink-0 rounded-full"} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="border-t border-stone-100 dark:border-stone-800">
        <AnimatePresence mode="wait">
          {resolved ? (
            <motion.ul key="items-resolved" variants={listVariants} initial="hidden" animate="show" className="divide-y divide-stone-100 dark:divide-stone-800">
              {items.map((item) => {
                const isActive = activeId === item.id;
                const itemIdleLabel = resultKind === "audio" ? "Preview" : "Open";
                const itemActiveLabel = resultKind === "audio" ? "Pause" : "Opened";
                return (
                  <motion.li key={item.id} variants={itemVariants} className={`flex items-center gap-3 px-4 py-2.5 transition-colors duration-150 ${isActive ? "bg-stone-50 dark:bg-stone-900" : ""}`}>
                    <div className={`relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-gradient-to-br text-base ${item.swatch}`} aria-hidden>
                      {item.icon && !isActive && <span>{item.icon}</span>}
                      {isActive && (
                        <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-white">
                          {resultKind === "audio" ? <EqualizerBars active={isActive} /> : <CheckIcon />}
                        </span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className={`truncate text-sm font-medium ${isActive ? "text-emerald-700 dark:text-emerald-400" : "text-stone-800 dark:text-stone-100"}`}>{item.title}</p>
                      <p className="truncate text-xs text-stone-500 dark:text-stone-400">{item.subtitle}</p>
                    </div>
                    {item.meta && <span className="shrink-0 text-xs text-stone-500 dark:text-stone-500">{item.meta}</span>}
                    <button
                      type="button"
                      aria-pressed={isActive}
                      aria-label={`${isActive ? itemActiveLabel : itemIdleLabel} ${item.title}`}
                      onClick={() => setActiveId((prev) => (prev === item.id ? null : item.id))}
                      className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 ${
                        isActive
                          ? "border-emerald-600 bg-emerald-700 text-white"
                          : "border-stone-300 text-stone-600 hover:border-stone-400 dark:border-stone-600 dark:text-stone-300 dark:hover:border-stone-500"
                      }`}
                    >
                      {resultKind === "audio" ? (
                        isActive ? <PauseIcon /> : <PlayIcon />
                      ) : isActive ? (
                        <CheckIcon />
                      ) : (
                        <ArrowUpRightIcon />
                      )}
                      {isActive ? itemActiveLabel : itemIdleLabel}
                    </button>
                  </motion.li>
                );
              })}
            </motion.ul>
          ) : (
            <motion.div key="items-loading" exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="divide-y divide-stone-100 dark:divide-stone-800">
              {items.slice(0, 3).map((item) => (
                <div key={item.id} className="flex items-center gap-3 px-4 py-2.5">
                  <ShimmerBlock className="h-9 w-9 shrink-0" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <ShimmerBlock className="h-3 w-3/5" />
                    <ShimmerBlock className="h-2.5 w-2/5" />
                  </div>
                  <ShimmerBlock className="h-6 w-16 shrink-0 rounded-full" />
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}

function AppWidgetAuthGate({ app, connecting, onConnect }: { app: AppWidgetApp; connecting: boolean; onConnect: () => void }) {
  const shouldReduceMotion = useReducedMotion();
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <AppIdentityMark app={app} className="h-11 w-11 text-base" />
      <div>
        <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">Sign in to {app.name}</p>
        <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">Connect your account to see results here.</p>
      </div>
      <motion.button
        type="button"
        disabled={connecting}
        onClick={onConnect}
        aria-label={connecting ? "Connecting…" : app.loginUrl ? `Sign in to ${app.name} (opens in a new tab)` : `Sign in to ${app.name}`}
        whileTap={connecting || shouldReduceMotion ? undefined : { scale: 0.97 }}
        className={`mt-1 flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-opacity duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 disabled:pointer-events-none disabled:opacity-50 ${app.accentButton}`}
      >
        {connecting && <SpinnerIcon />}
        {connecting ? "Connecting…" : `Sign in to ${app.name}`}
      </motion.button>
      {app.loginUrl && !connecting && <p className="text-[11px] text-stone-500 dark:text-stone-500">Opens {app.name}&rsquo;s real sign-in in a new tab.</p>}
    </div>
  );
}

function subscribeNever() {
  return () => {};
}

function getServerConnectionSnapshot() {
  return false;
}

export function AppWidget(props: AppWidgetProps) {
  const { app, headerAction } = props;
  const isLive = props.mode === "live";
  const shouldReduceMotion = useReducedMotion();
  // Reading localStorage safely across server/client (no hydration mismatch) is exactly
  // what useSyncExternalStore is for: the server snapshot always renders the sign-in gate.
  const persistedConnected = useSyncExternalStore(subscribeNever, () => readPersistedConnection(app.name), getServerConnectionSnapshot);
  const [connectedByUser, setConnectedByUser] = useState(false);
  const connected = connectedByUser || persistedConnected;
  const [connecting, setConnecting] = useState(false);
  const [timerResolved, setTimerResolved] = useState(false);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const resolved = shouldReduceMotion === true || (isLive ? iframeLoaded : timerResolved);
  const [liked, setLiked] = useState<"up" | "down" | null>(null);
  const connectTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (!connected || isLive || shouldReduceMotion) return;
    const timer = window.setTimeout(() => setTimerResolved(true), 1300);
    return () => window.clearTimeout(timer);
  }, [connected, isLive, shouldReduceMotion]);

  useEffect(() => {
    return () => {
      if (connectTimeoutRef.current) window.clearTimeout(connectTimeoutRef.current);
    };
  }, []);

  // A returning visit within the 30-day window refreshes the rolling expiry: only
  // 30 days of disuse (not 30 days since the original sign-in) triggers the gate again.
  useEffect(() => {
    if (persistedConnected) touchPersistedConnection(app.name);
  }, [persistedConnected, app.name]);

  function handleConnect() {
    // Open synchronously, inside the click handler itself: deferring this into the
    // setTimeout below would detach it from the user gesture and popup-blockers would
    // silently swallow it.
    if (app.loginUrl) {
      window.open(app.loginUrl, "_blank", "noopener,noreferrer");
    }
    setConnecting(true);
    connectTimeoutRef.current = window.setTimeout(() => {
      setConnecting(false);
      setConnectedByUser(true);
      touchPersistedConnection(app.name);
    }, 900);
  }

  const resolvedHeaderAction = headerAction ?? (isLive ? undefined : { kind: "devices" as const, devices: ["This device"] });
  const contentReady = connected && resolved;

  return (
    <div className="w-full max-w-md" aria-busy={!contentReady}>
      <span className="sr-only" role="status">
        {!connected ? `Sign in required to use ${app.name}` : resolved ? `${app.name} result loaded` : `Loading result from ${app.name}`}
      </span>

      <div className="mb-2 flex items-center gap-2 px-1">
        <AppIdentityMark app={app} className="h-6 w-6 text-[11px]" />
        <span className="text-sm font-medium text-stone-700 dark:text-stone-300">{app.name}</span>
        <span className="ml-auto flex items-center gap-1">
          <motion.button
            type="button"
            aria-label="Like this result"
            aria-pressed={liked === "up"}
            whileTap={shouldReduceMotion ? undefined : { scale: 0.8 }}
            onClick={() => setLiked((prev) => (prev === "up" ? null : "up"))}
            className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 ${
              liked === "up" ? "text-emerald-700 dark:text-emerald-400" : "text-stone-500 hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300"
            }`}
          >
            <ThumbIcon direction="up" />
          </motion.button>
          <motion.button
            type="button"
            aria-label="Dislike this result"
            aria-pressed={liked === "down"}
            whileTap={shouldReduceMotion ? undefined : { scale: 0.8 }}
            onClick={() => setLiked((prev) => (prev === "down" ? null : "down"))}
            className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 ${
              liked === "down" ? "text-red-500 dark:text-red-400" : "text-stone-500 hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300"
            }`}
          >
            <ThumbIcon direction="down" />
          </motion.button>
        </span>
      </div>

      <motion.div
        transition={{ type: "spring", stiffness: 380, damping: 28 }}
        className="overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm dark:border-stone-700 dark:bg-stone-900"
      >
        <AnimatePresence mode="wait">
          {!connected ? (
            <motion.div key="gate" exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
              <AppWidgetAuthGate app={app} connecting={connecting} onConnect={handleConnect} />
            </motion.div>
          ) : (
            <motion.div
              key="content"
              initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.25, ease: EASE }}
            >
              <AppWidgetHeaderBar appName={app.name} headerAction={resolvedHeaderAction} />
              {props.mode === "live" ? (
                <AppWidgetLiveBody
                  resolved={resolved}
                  embedUrl={props.embedUrl}
                  embedTitle={props.embedTitle}
                  embedHeight={props.embedHeight}
                  onLoad={() => setIframeLoaded(true)}
                />
              ) : (
                <AppWidgetDemoBody
                  resolved={resolved}
                  shouldReduceMotion={shouldReduceMotion}
                  app={app}
                  hero={props.hero}
                  items={props.items}
                  resultKind={props.resultKind}
                  addLabel={props.addLabel}
                  addedLabel={props.addedLabel}
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

export function AppWidgetPreview() {
  return (
    <div className="flex w-full flex-col items-center gap-8">
      <AppWidget
        app={{
          name: "Spotify",
          glyph: "S",
          logo: Spotify,
          accent: "bg-emerald-500",
          accentButton: "bg-emerald-400 hover:bg-emerald-300 text-black",
          loginUrl: "https://accounts.spotify.com/login",
        }}
        mode="live"
        embedUrl="https://open.spotify.com/embed/playlist/37i9dQZF1DWXRqgorJj26U?utm_source=oembed"
        embedTitle="Spotify Embed: Rock Classics"
        embedHeight={352}
      />
      <AppWidget
        app={{
          name: "Figma",
          glyph: "F",
          logo: Figma,
          logoViewBox: "0 0 16 24",
          accent: "bg-amber-500",
          accentButton: "bg-amber-500 hover:bg-amber-400 text-black",
          loginUrl: "https://www.figma.com/login",
        }}
        mode="live"
        embedUrl="https://embed.figma.com/design/nrPSsILSYjesyc5UHjYYa4?embed-host=shruti-portfolio"
        embedTitle="Figma Embed: Embed Kit 2.0 examples"
        embedHeight={360}
      />
    </div>
  );
}
