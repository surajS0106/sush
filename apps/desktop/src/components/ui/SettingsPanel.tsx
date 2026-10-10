"use client";

import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  GearIcon as PhGear,
  BellIcon as PhBell,
  PaletteIcon as PhPalette,
  UserIcon as PhUser,
  ShieldIcon as PhShield,
  LockIcon as PhLock,
  MagnifyingGlassIcon as PhMagnifyingGlass,
  MonitorIcon as PhMonitor,
  SunIcon as PhSun,
  MoonIcon as PhMoon,
  CaretDownIcon as PhCaretDown,
  CheckIcon as PhCheck,
  XIcon as PhX,
} from "@phosphor-icons/react";

type SectionId = "general" | "notifications" | "personalization" | "profile" | "privacy" | "security";
type AccentValue = "emerald" | "amber" | "stone";

interface NavItem {
  id: SectionId;
  label: string;
  icon: (props: { className?: string }) => ReactNode;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

function GearIcon({ className }: { className?: string }) {
  return <PhGear size={16} aria-hidden className={className} />;
}

function BellIcon({ className }: { className?: string }) {
  return <PhBell size={16} aria-hidden className={className} />;
}

function SparkleIcon({ className }: { className?: string }) {
  return <PhPalette size={16} aria-hidden className={className} />;
}

function UserIcon({ className }: { className?: string }) {
  return <PhUser size={16} aria-hidden className={className} />;
}

function ShieldIcon({ className }: { className?: string }) {
  return <PhShield size={16} aria-hidden className={className} />;
}

function LockIcon({ className }: { className?: string }) {
  return <PhLock size={16} aria-hidden className={className} />;
}

function SearchIcon() {
  return <PhMagnifyingGlass size={14} aria-hidden />;
}

function MonitorIcon() {
  return <PhMonitor size={14} aria-hidden />;
}

function SunIcon() {
  return <PhSun size={14} aria-hidden />;
}

function MoonIcon() {
  return <PhMoon size={14} aria-hidden />;
}

function ChevronDownIcon({ open }: { open: boolean }) {
  const shouldReduceMotion = useReducedMotion();
  return (
    <motion.span
      animate={{ rotate: open ? 180 : 0 }}
      transition={shouldReduceMotion ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 30 }}
      className="flex shrink-0 text-stone-500"
    >
      <PhCaretDown size={14} weight="bold" aria-hidden />
    </motion.span>
  );
}

function CheckIcon() {
  return <PhCheck size={14} weight="bold" aria-hidden />;
}

function CloseIcon() {
  return <PhX size={16} aria-hidden />;
}

// Every color token below is a literal, statically-scannable Tailwind class,
// required so the JIT compiler picks it up, since a template-built class
// name like `bg-${accent}-50` is invisible to it.
const ACCENT_STYLES: Record<
  AccentValue,
  {
    dot: string;
    ring: string;
    bannerBorder: string;
    bannerBg: string;
    bannerIcon: string;
    bannerTitle: string;
    bannerBody: string;
    bannerDismiss: string;
    button: string;
    optionHighlightBg: string;
    optionHighlightText: string;
    check: string;
    activeIcon: string;
    switchOn: string;
  }
> = {
  emerald: {
    dot: "bg-emerald-500",
    ring: "focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400",
    bannerBorder: "border-emerald-200 dark:border-emerald-500/20",
    bannerBg: "bg-emerald-50 dark:bg-emerald-500/10",
    bannerIcon: "text-emerald-700 dark:text-emerald-400",
    bannerTitle: "text-emerald-900 dark:text-emerald-200",
    bannerBody: "text-emerald-800/80 dark:text-emerald-300/80",
    bannerDismiss:
      "text-emerald-700/60 hover:bg-emerald-100 hover:text-emerald-700 dark:text-emerald-300/60 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-300",
    button: "bg-emerald-700 hover:bg-emerald-800",
    optionHighlightBg: "bg-emerald-50 dark:bg-emerald-500/10",
    optionHighlightText: "text-emerald-700 dark:text-emerald-400",
    check: "text-emerald-700 dark:text-emerald-400",
    activeIcon: "text-emerald-700 dark:text-emerald-400",
    switchOn: "bg-emerald-600",
  },
  amber: {
    dot: "bg-emerald-600",
    ring: "focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400",
    bannerBorder: "border-amber-200 dark:border-emerald-500/20",
    bannerBg: "bg-emerald-50 dark:bg-emerald-500/10",
    bannerIcon: "text-emerald-700 dark:text-emerald-400",
    bannerTitle: "text-amber-900 dark:text-amber-200",
    bannerBody: "text-emerald-800/80 dark:text-emerald-400/80",
    bannerDismiss:
      "text-emerald-700/60 hover:bg-emerald-100 hover:text-emerald-700 dark:text-emerald-400/60 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-400",
    button: "bg-emerald-700 hover:bg-emerald-800",
    optionHighlightBg: "bg-emerald-50 dark:bg-emerald-500/10",
    optionHighlightText: "text-emerald-700 dark:text-emerald-400",
    check: "text-emerald-700 dark:text-emerald-400",
    activeIcon: "text-emerald-700 dark:text-emerald-400",
    switchOn: "bg-emerald-700",
  },
  stone: {
    dot: "bg-stone-500",
    ring: "focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400",
    bannerBorder: "border-stone-300 dark:border-stone-700",
    bannerBg: "bg-stone-100 dark:bg-white/[0.06]",
    bannerIcon: "text-stone-500 dark:text-stone-400",
    bannerTitle: "text-stone-900 dark:text-stone-100",
    bannerBody: "text-stone-700/80 dark:text-stone-300/80",
    bannerDismiss:
      "text-stone-600/60 hover:bg-stone-200 hover:text-stone-800 dark:text-stone-300/60 dark:hover:bg-white/10 dark:hover:text-stone-200",
    button: "bg-stone-700 hover:bg-stone-600",
    optionHighlightBg: "bg-stone-100 dark:bg-white/[0.06]",
    optionHighlightText: "text-stone-600 dark:text-stone-400",
    check: "text-stone-600 dark:text-stone-400",
    activeIcon: "text-stone-600 dark:text-stone-400",
    switchOn: "bg-stone-600",
  },
};

const AccentContext = createContext<AccentValue>("emerald");
function useAccent() {
  return ACCENT_STYLES[useContext(AccentContext)];
}

interface SettingsState {
  mfaVisible: boolean;
  mfaEnabled: boolean;
  appearance: "system" | "light" | "dark";
  accent: AccentValue;
  language: string;
  fullName: string;
  nickname: string;
  work: string;
  instructions: string;
  avatarIndex: number;
  analytics: boolean;
  suggestions: boolean;
}

const DEFAULT_SETTINGS: SettingsState = {
  mfaVisible: true,
  mfaEnabled: false,
  appearance: "dark",
  accent: "emerald",
  language: "auto",
  fullName: "Jordan Rivera",
  nickname: "Jordan",
  work: "design",
  instructions: "",
  avatarIndex: 0,
  analytics: true,
  suggestions: false,
};

type UpdateSetting = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;

const NAV_GROUPS: NavGroup[] = [
  {
    label: "General",
    items: [
      { id: "general", label: "General", icon: GearIcon },
      { id: "notifications", label: "Notifications", icon: BellIcon },
      { id: "personalization", label: "Personalization", icon: SparkleIcon },
    ],
  },
  {
    label: "Account",
    items: [
      { id: "profile", label: "Profile", icon: UserIcon },
      { id: "privacy", label: "Privacy", icon: ShieldIcon },
      { id: "security", label: "Security", icon: LockIcon },
    ],
  },
];

interface SelectOption {
  value: string;
  label: string;
  dot?: string;
}

function FieldSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const styles = useAccent();
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const [highlighted, setHighlighted] = useState(selectedIndex);
  const rootRef = useRef<HTMLDivElement>(null);
  const shouldReduceMotion = useReducedMotion();
  const reactId = useId();
  const listboxId = `settings-select-${reactId}`;
  const selected = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      if (!open) return setOpen(true);
      setHighlighted((h) => Math.min(h + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      if (open) {
        onChange(options[highlighted].value);
        setOpen(false);
      } else {
        setOpen(true);
      }
    } else if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-label={label}
        onClick={() => {
          setOpen((v) => !v);
          setHighlighted(selectedIndex);
        }}
        onKeyDown={handleKeyDown}
        className={`flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-sm text-stone-700 outline-none transition-colors hover:border-stone-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:border-stone-600 ${styles.ring}`}
      >
        {selected.dot && <span className={`h-2 w-2 shrink-0 rounded-full ${selected.dot}`} aria-hidden />}
        {selected.label}
        <ChevronDownIcon open={open} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={
              shouldReduceMotion
                ? { duration: 0 }
                : { height: { duration: 0.2, ease: [0.22, 1, 0.36, 1] }, opacity: { duration: 0.15 } }
            }
            className="absolute right-0 z-20 mt-1.5 w-40 overflow-hidden rounded-lg border border-stone-200 bg-white shadow-[0_1px_2px_-1px_rgba(0,0,0,0.06),0_4px_12px_-4px_rgba(0,0,0,0.08)] dark:shadow-none dark:border-stone-700 dark:bg-stone-900"
          >
            <ul id={listboxId} role="listbox" aria-label={label} data-lenis-prevent className="scrollbar-hide max-h-44 overflow-y-auto p-1">
              {options.map((option, i) => (
                <li
                  key={option.value}
                  role="option"
                  aria-selected={value === option.value}
                  onMouseEnter={() => setHighlighted(i)}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className="relative flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-stone-700 dark:text-stone-300"
                >
                  {highlighted === i && (
                    <motion.span
                      layoutId={`${listboxId}-highlight`}
                      className={`absolute inset-0 rounded-md ${styles.optionHighlightBg}`}
                      transition={shouldReduceMotion ? { duration: 0 } : { type: "spring", stiffness: 600, damping: 40 }}
                    />
                  )}
                  <span className={`relative flex flex-1 items-center gap-2 ${highlighted === i ? styles.optionHighlightText : ""}`}>
                    {option.dot && <span className={`h-2 w-2 shrink-0 rounded-full ${option.dot}`} aria-hidden />}
                    {option.label}
                  </span>
                  {value === option.value && (
                    <span className={`relative shrink-0 ${styles.check}`}>
                      <CheckIcon />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MiniToggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  const styles = useAccent();
  const shouldReduceMotion = useReducedMotion();
  return (
    <motion.button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      whileTap={{ scale: 0.93 }}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${styles.ring} ${
        checked ? styles.switchOn : "bg-stone-300 dark:bg-stone-600"
      }`}
    >
      <motion.span
        animate={{ x: checked ? 22 : 2 }}
        transition={shouldReduceMotion ? { duration: 0 } : { type: "spring", stiffness: 700, damping: 32 }}
        className="absolute top-0.5 block h-5 w-5 rounded-full bg-white shadow-md"
      />
    </motion.button>
  );
}

function SaveIndicator({ state }: { state: "idle" | "saving" | "saved" }) {
  const styles = useAccent();
  const shouldReduceMotion = useReducedMotion();
  return (
    <AnimatePresence mode="wait">
      {state !== "idle" && (
        <motion.span
          key={state}
          initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: -2 }}
          animate={{ opacity: 1, y: 0 }}
          exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 2 }}
          transition={{ duration: 0.15 }}
          className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-stone-500 dark:text-stone-500"
        >
          {state === "saving" ? (
            <>
              <motion.span
                className="h-1.5 w-1.5 rounded-full bg-stone-400 dark:bg-stone-500"
                animate={shouldReduceMotion ? undefined : { opacity: [0.3, 1, 0.3] }}
                transition={{ repeat: Infinity, duration: 1 }}
              />
              Saving…
            </>
          ) : (
            <>
              <span className={styles.check}>
                <CheckIcon />
              </span>
              Saved
            </>
          )}
        </motion.span>
      )}
    </AnimatePresence>
  );
}

const ACCENT_OPTIONS: SelectOption[] = [
  { value: "emerald", label: "Emerald", dot: "bg-emerald-500" },
  { value: "amber", label: "Amber", dot: "bg-amber-500" },
  { value: "stone", label: "Stone", dot: "bg-stone-500" },
];

const LANGUAGE_OPTIONS: SelectOption[] = [
  { value: "auto", label: "Auto-detect" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "ja", label: "Japanese" },
];

const WORK_OPTIONS: SelectOption[] = [
  { value: "design", label: "Design" },
  { value: "engineering", label: "Engineering" },
  { value: "product", label: "Product" },
  { value: "student", label: "Student" },
  { value: "other", label: "Other" },
];

const AVATAR_GRADIENTS = [
  "from-emerald-400 to-stone-700",
  "from-amber-400 to-stone-600",
  "from-stone-500 to-stone-900",
  "from-stone-200 to-stone-500",
];

function AppearanceControl({ value, onChange }: { value: "system" | "light" | "dark"; onChange: (v: "system" | "light" | "dark") => void }) {
  const styles = useAccent();
  const shouldReduceMotion = useReducedMotion();
  const options = [
    { value: "system" as const, label: "System", icon: MonitorIcon },
    { value: "light" as const, label: "Light", icon: SunIcon },
    { value: "dark" as const, label: "Dark", icon: MoonIcon },
  ];

  return (
    <div role="radiogroup" aria-label="Appearance" className="relative inline-flex gap-1 rounded-lg bg-stone-100 p-1 dark:bg-stone-900">
      {options.map((option) => {
        const isActive = value === option.value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-label={option.label}
            title={option.label}
            onClick={() => onChange(option.value)}
            className={`relative z-10 flex h-7 w-9 items-center justify-center rounded-md transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${styles.ring} ${
              isActive ? "text-stone-900 dark:text-stone-100" : "text-stone-500 dark:text-stone-500"
            }`}
          >
            {isActive && (
              <motion.span
                layoutId="settings-appearance-highlight"
                className="absolute inset-0 -z-10 rounded-md bg-white shadow-sm dark:bg-stone-700"
                transition={shouldReduceMotion ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 34 }}
              />
            )}
            <Icon />
          </button>
        );
      })}
    </div>
  );
}

function SettingsRow({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-stone-700 dark:text-stone-200">{label}</p>
        {description && <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-500">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function EmptyPane({ label, icon: Icon }: { label: string; icon: NavItem["icon"] }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 py-12 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-stone-100 text-stone-300 dark:bg-stone-900 dark:text-stone-600">
        <Icon className="h-5 w-5" />
      </span>
      <p className="text-sm text-stone-500 dark:text-stone-500">Nothing to configure in {label.toLowerCase()} yet.</p>
    </div>
  );
}

function GeneralPane({ settings, update }: { settings: SettingsState; update: UpdateSetting }) {
  const styles = useAccent();
  const shouldReduceMotion = useReducedMotion();

  return (
    <div>
      <AnimatePresence initial={false}>
        {settings.mfaVisible && (
          <motion.div
            initial={shouldReduceMotion ? { opacity: 1, height: "auto" } : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className={`relative mb-2 rounded-xl border p-4 pr-10 ${styles.bannerBorder} ${styles.bannerBg}`}>
              <button
                type="button"
                onClick={() => update("mfaVisible", false)}
                aria-label="Dismiss"
                className={`absolute right-3 top-3 rounded-md p-1 transition-colors ${styles.bannerDismiss}`}
              >
                <CloseIcon />
              </button>
              <div className="flex items-start gap-3">
                <span className={`mt-0.5 shrink-0 ${styles.bannerIcon}`}>
                  <ShieldIcon className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <AnimatePresence mode="wait" initial={false}>
                    {settings.mfaEnabled ? (
                      <motion.div
                        key="enabled"
                        initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        <p className={`text-sm font-semibold ${styles.bannerTitle}`}>Two-factor authentication is on</p>
                        <p className={`mt-1 text-xs leading-relaxed ${styles.bannerBody}`}>
                          Your account now needs a second code at sign-in, on top of your password.
                        </p>
                      </motion.div>
                    ) : (
                      <motion.div
                        key="prompt"
                        initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                        transition={{ duration: 0.2 }}
                      >
                        <p className={`text-sm font-semibold ${styles.bannerTitle}`}>Secure your account</p>
                        <p className={`mt-1 text-xs leading-relaxed ${styles.bannerBody}`}>
                          Add multi-factor authentication to help protect your account when signing in.
                        </p>
                        <button
                          type="button"
                          onClick={() => update("mfaEnabled", true)}
                          className={`mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-colors ${styles.button}`}
                        >
                          Set up MFA
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="divide-y divide-stone-100 dark:divide-stone-800/80">
        <SettingsRow label="Appearance">
          <AppearanceControl value={settings.appearance} onChange={(v) => update("appearance", v)} />
        </SettingsRow>
        <SettingsRow label="Accent color" description="Retints every control in this dialog, live.">
          <FieldSelect
            label="Accent color"
            options={ACCENT_OPTIONS}
            value={settings.accent}
            onChange={(v) => update("accent", v as AccentValue)}
          />
        </SettingsRow>
        <SettingsRow label="Language">
          <FieldSelect label="Language" options={LANGUAGE_OPTIONS} value={settings.language} onChange={(v) => update("language", v)} />
        </SettingsRow>
      </div>
    </div>
  );
}

function ProfilePane({ settings, update }: { settings: SettingsState; update: UpdateSetting }) {
  const styles = useAccent();
  const reactId = useId();

  const initials = settings.fullName
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div>
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => update("avatarIndex", (settings.avatarIndex + 1) % AVATAR_GRADIENTS.length)}
          aria-label="Change avatar color"
          className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-sm font-semibold text-white transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${styles.ring} ${AVATAR_GRADIENTS[settings.avatarIndex]}`}
        >
          {initials || "?"}
        </button>
        <div>
          <p className="text-sm font-medium text-stone-700 dark:text-stone-200">Avatar</p>
          <p className="text-xs text-stone-500 dark:text-stone-500">Click the avatar to try another color.</p>
        </div>
      </div>

      <div className="mt-5 space-y-4">
        <div>
          <label htmlFor={`${reactId}-name`} className="block text-xs font-medium text-stone-500 dark:text-stone-400">
            Full name
          </label>
          <input
            id={`${reactId}-name`}
            type="text"
            value={settings.fullName}
            onChange={(e) => update("fullName", e.target.value)}
            className={`mt-1.5 w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 ${styles.ring}`}
          />
        </div>

        <div>
          <label htmlFor={`${reactId}-nickname`} className="block text-xs font-medium text-stone-500 dark:text-stone-400">
            What should we call you?
          </label>
          <input
            id={`${reactId}-nickname`}
            type="text"
            value={settings.nickname}
            onChange={(e) => update("nickname", e.target.value)}
            className={`mt-1.5 w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 ${styles.ring}`}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <label className="text-xs font-medium text-stone-500 dark:text-stone-400">What best describes your work?</label>
          <FieldSelect label="What best describes your work?" options={WORK_OPTIONS} value={settings.work} onChange={(v) => update("work", v)} />
        </div>

        <div>
          <label htmlFor={`${reactId}-instructions`} className="block text-xs font-medium text-stone-500 dark:text-stone-400">
            Instructions
          </label>
          <textarea
            id={`${reactId}-instructions`}
            value={settings.instructions}
            onChange={(e) => update("instructions", e.target.value)}
            rows={3}
            placeholder="Anything this app should keep in mind about you..."
            className={`mt-1.5 w-full resize-none rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:placeholder:text-stone-600 ${styles.ring}`}
          />
          <p className="mt-1.5 text-xs text-stone-500 dark:text-stone-500">Kept in mind across every conversation.</p>
        </div>
      </div>
    </div>
  );
}

function PrivacyPane({ settings, update }: { settings: SettingsState; update: UpdateSetting }) {
  return (
    <div className="divide-y divide-stone-100 dark:divide-stone-800/80">
      <SettingsRow label="Usage analytics" description="Share anonymized usage data to help improve this app.">
        <MiniToggle checked={settings.analytics} onChange={(v) => update("analytics", v)} label="Usage analytics" />
      </SettingsRow>
      <SettingsRow label="Personalized suggestions" description="Use your activity to tailor what's shown to you.">
        <MiniToggle checked={settings.suggestions} onChange={(v) => update("suggestions", v)} label="Personalized suggestions" />
      </SettingsRow>
    </div>
  );
}

interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Renders scoped to the nearest positioned ancestor instead of the viewport, for demoing inside a bounded card. */
  contained?: boolean;
}

export function SettingsPanel({ open, onOpenChange, contained = false }: SettingsPanelProps) {
  const [active, setActive] = useState<SectionId>("general");
  const [settings, setSettings] = useState<SettingsState>(DEFAULT_SETTINGS);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [query, setQuery] = useState("");
  const shouldReduceMotion = useReducedMotion();
  const activeItem = NAV_GROUPS.flatMap((g) => g.items).find((item) => item.id === active);
  const styles = ACCENT_STYLES[settings.accent];
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Every setting lives here, not in each pane, so switching tabs or closing
  // and reopening the dialog doesn't reset anything: this is what the
  // autosave indicator below would otherwise be lying about. The "saving"
  // flip happens inside this handler (a real user-driven event) rather than
  // an effect watching `settings`, since setState synchronously inside an
  // effect body triggers cascading renders.
  const update: UpdateSetting = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => setSaveState("saved"), 500);
  };

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return NAV_GROUPS;
    return NAV_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter((item) => item.label.toLowerCase().includes(q)),
    })).filter((group) => group.items.length > 0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  return (
    <AccentContext.Provider value={settings.accent}>
      <AnimatePresence>
        {open && (
            <>
              <motion.div
                key="backdrop"
                aria-hidden
                className={`${contained ? "absolute" : "fixed"} inset-0 z-50 bg-stone-950/40 backdrop-blur-sm`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: shouldReduceMotion ? 0.1 : 0.2 }}
                onClick={() => onOpenChange(false)}
              />
              <motion.div
                key="dialog"
                role="dialog"
                aria-modal="true"
                aria-label="Settings"
                className={`${contained ? "absolute" : "fixed"} left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-2xl`}
                initial={shouldReduceMotion ? { opacity: 0, x: "-50%", y: "-50%" } : { opacity: 0, scale: 0.96, x: "-50%", y: "-50%" }}
                animate={{ opacity: 1, scale: 1, x: "-50%", y: "-50%" }}
                exit={shouldReduceMotion ? { opacity: 0, x: "-50%", y: "-50%" } : { opacity: 0, scale: 0.97, x: "-50%", y: "-50%" }}
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="flex h-[26rem] overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-[0_1px_2px_-1px_rgba(0,0,0,0.06),0_12px_32px_-8px_rgba(0,0,0,0.14)] dark:shadow-none dark:border-stone-700 dark:bg-stone-900">
                  <nav aria-label="Settings sections" data-lenis-prevent className="scrollbar-hide flex w-48 shrink-0 flex-col gap-4 overflow-y-auto border-r border-stone-100 bg-stone-50/60 p-3 dark:border-stone-800 dark:bg-stone-900/40">
                    <div className="relative">
                      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-500 dark:text-stone-500">
                        <SearchIcon />
                      </span>
                      <input
                        type="text"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search settings"
                        aria-label="Search settings"
                        className={`w-full rounded-lg border border-stone-200 bg-white py-1.5 pl-8 pr-2 text-xs text-stone-700 outline-none transition-colors placeholder:text-stone-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:placeholder:text-stone-500 ${styles.ring}`}
                      />
                    </div>

                    {filteredGroups.length === 0 && (
                      <p className="px-2 text-xs text-stone-500 dark:text-stone-500">No settings match &ldquo;{query}&rdquo;.</p>
                    )}

                    {filteredGroups.map((group) => (
                      <div key={group.label}>
                        <p className="px-2 pb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-stone-500 dark:text-stone-500">
                          {group.label}
                        </p>
                        <div role="tablist" aria-orientation="vertical" className="space-y-0.5">
                          {group.items.map((item) => {
                            const isActive = active === item.id;
                            const Icon = item.icon;
                            return (
                              <button
                                key={item.id}
                                type="button"
                                role="tab"
                                id={`settings-tab-${item.id}`}
                                aria-selected={isActive}
                                aria-controls={`settings-panel-${item.id}`}
                                onClick={() => setActive(item.id)}
                                className={`relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${styles.ring} ${
                                  isActive ? "text-stone-900 dark:text-stone-100" : "text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
                                }`}
                              >
                                {isActive && (
                                  <motion.span
                                    layoutId="settings-nav-highlight"
                                    className="absolute inset-0 -z-10 rounded-lg bg-white shadow-sm dark:bg-stone-800"
                                    transition={shouldReduceMotion ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 38 }}
                                  />
                                )}
                                <Icon className={`h-4 w-4 shrink-0 ${isActive ? styles.activeIcon : ""}`} />
                                <span className="truncate">{item.label}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </nav>

                  <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                    <button
                      type="button"
                      onClick={() => onOpenChange(false)}
                      aria-label="Close settings"
                      className="absolute right-4 top-4 z-10 rounded-md p-1 text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-600 dark:hover:bg-stone-800 dark:hover:text-stone-300"
                    >
                      <CloseIcon />
                    </button>

                    <div data-lenis-prevent className="scrollbar-hide min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-5">
                      <div className="flex items-center justify-between gap-3 pr-7">
                        <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">{activeItem?.label ?? "Settings"}</h2>
                        <SaveIndicator state={saveState} />
                      </div>
                      <motion.div
                        key={active}
                        id={`settings-panel-${active}`}
                        role="tabpanel"
                        aria-labelledby={`settings-tab-${active}`}
                        initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.15 }}
                        className="mt-3"
                      >
                        {active === "general" && <GeneralPane settings={settings} update={update} />}
                        {active === "profile" && <ProfilePane settings={settings} update={update} />}
                        {active === "privacy" && <PrivacyPane settings={settings} update={update} />}
                        {active !== "general" && active !== "profile" && active !== "privacy" && activeItem && (
                          <EmptyPane label={activeItem.label} icon={activeItem.icon} />
                        )}
                      </motion.div>
                    </div>
                  </div>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
    </AccentContext.Provider>
  );
}
