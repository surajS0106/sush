"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  PaperclipIcon as PhPaperclip,
  ArrowUpIcon as PhArrowUp,
  StopIcon as PhStop,
  MicrophoneIcon as PhMicrophone,
  PlayIcon as PhPlay,
  PauseIcon as PhPause,
  ChatCircleIcon as PhChatCircle,
  CaretDownIcon as PhCaretDown,
  CheckIcon as PhCheck,
  LightningIcon as PhLightning,
  SparkleIcon as PhSparkle,
  AtomIcon as PhAtom,
  PlusIcon as PhPlus,
  CaretRightIcon as PhCaretRight,
  MagnifyingGlassIcon as PhMagnifyingGlass,
  CodeIcon as PhCode,
  ShapesIcon as PhShapes,
  CloudIcon as PhCloud,
  FileTextIcon as PhFileText,
  StackIcon as PhStack,
  UploadSimpleIcon as PhUploadSimple,
  ImageIcon as PhImage,
  PencilSimpleIcon as PhPencilSimple,
  PuzzlePieceIcon as PhPuzzlePiece,
  PlugsIcon as PhPlugs,
  ShieldCheckIcon as PhShieldCheck,
} from "@phosphor-icons/react";

const DEFAULT_PLACEHOLDERS = [
  "Ask anything…",
  "Summarize this contract…",
  "Draft a follow-up email…",
  "Explain this error message…",
  "Brainstorm names for a project…",
];

type GlowTone = "mono" | "pinkPurple" | "redBlue" | "yellowGreen" | "limePink";

const GLOW_TONES: Record<GlowTone, { light: string; dark: string }> = {
  mono: {
    light:
      "radial-gradient(circle at 50% 35%, rgba(0,0,0,0.35), rgba(0,0,0,0) 62%), radial-gradient(circle at 50% 75%, rgba(0,0,0,0.28), rgba(0,0,0,0) 65%)",
    dark:
      "radial-gradient(circle at 50% 35%, rgba(255,255,255,0.35), rgba(255,255,255,0) 62%), radial-gradient(circle at 50% 75%, rgba(255,255,255,0.28), rgba(255,255,255,0) 65%)",
  },
  pinkPurple: {
    light:
      "radial-gradient(circle at 50% 35%, rgba(236,72,153,0.4), rgba(236,72,153,0) 62%), radial-gradient(circle at 50% 75%, rgba(168,85,247,0.32), rgba(168,85,247,0) 65%)",
    dark:
      "radial-gradient(circle at 50% 35%, rgba(236,72,153,0.4), rgba(236,72,153,0) 62%), radial-gradient(circle at 50% 75%, rgba(168,85,247,0.32), rgba(168,85,247,0) 65%)",
  },
  redBlue: {
    light:
      "radial-gradient(circle at 50% 35%, rgba(239,68,68,0.4), rgba(239,68,68,0) 62%), radial-gradient(circle at 50% 75%, rgba(59,130,246,0.32), rgba(59,130,246,0) 65%)",
    dark:
      "radial-gradient(circle at 50% 35%, rgba(239,68,68,0.4), rgba(239,68,68,0) 62%), radial-gradient(circle at 50% 75%, rgba(59,130,246,0.32), rgba(59,130,246,0) 65%)",
  },
  yellowGreen: {
    light:
      "radial-gradient(circle at 50% 35%, rgba(234,179,8,0.4), rgba(234,179,8,0) 62%), radial-gradient(circle at 50% 75%, rgba(34,197,94,0.32), rgba(34,197,94,0) 65%)",
    dark:
      "radial-gradient(circle at 50% 35%, rgba(234,179,8,0.4), rgba(234,179,8,0) 62%), radial-gradient(circle at 50% 75%, rgba(34,197,94,0.32), rgba(34,197,94,0) 65%)",
  },
  limePink: {
    light:
      "radial-gradient(circle at 50% 35%, rgba(132,204,22,0.4), rgba(132,204,22,0) 62%), radial-gradient(circle at 50% 75%, rgba(236,72,153,0.32), rgba(236,72,153,0) 65%)",
    dark:
      "radial-gradient(circle at 50% 35%, rgba(132,204,22,0.4), rgba(132,204,22,0) 62%), radial-gradient(circle at 50% 75%, rgba(236,72,153,0.32), rgba(236,72,153,0) 65%)",
  },
};

interface ModelOption {
  id: string;
  label: string;
  hint: string;
  icon: ReactNode;
}

function PaperclipIcon() {
  return <PhPaperclip size={16} aria-hidden />;
}

function ArrowUpIcon() {
  return <PhArrowUp size={16} weight="bold" aria-hidden />;
}

function StopIcon() {
  return <PhStop size={11} weight="fill" aria-hidden />;
}

function MicIcon() {
  return <PhMicrophone size={16} aria-hidden />;
}

function PlayIcon() {
  return <PhPlay size={12} weight="fill" aria-hidden />;
}

function PauseIcon() {
  return <PhPause size={12} weight="fill" aria-hidden />;
}

function NewConversationIcon() {
  return <PhChatCircle size={16} aria-hidden />;
}

function ChevronDownIcon() {
  return <PhCaretDown size={12} weight="bold" aria-hidden />;
}

function CheckIcon() {
  return <PhCheck size={14} weight="bold" aria-hidden />;
}

function BoltIcon() {
  return <PhLightning size={13} weight="fill" aria-hidden />;
}

function SparkleIcon() {
  return <PhSparkle size={13} weight="fill" aria-hidden />;
}

function AtomIcon() {
  return <PhAtom size={13} aria-hidden />;
}

const MODELS: ModelOption[] = [
  { id: "quick", label: "Quick", hint: "Fast, lightweight replies", icon: <BoltIcon /> },
  { id: "balanced", label: "Balanced", hint: "The default, all-round model", icon: <SparkleIcon /> },
  { id: "deep", label: "Deep think", hint: "Slower, more thorough reasoning", icon: <AtomIcon /> },
];

const WAVEFORM_BARS = [
  { peak: 12, duration: 0.85, delay: 0 },
  { peak: 18, duration: 0.75, delay: 0.1 },
  { peak: 22, duration: 0.9, delay: 0.2 },
  { peak: 16, duration: 0.8, delay: 0.3 },
  { peak: 10, duration: 0.95, delay: 0.4 },
];

function PlusIcon() {
  return <PhPlus size={16} weight="bold" aria-hidden />;
}

function ChevronRightIcon() {
  return <PhCaretRight size={12} weight="bold" aria-hidden />;
}

function SearchIcon() {
  return <PhMagnifyingGlass size={13} aria-hidden />;
}

function CodeBracketIcon() {
  return <PhCode size={15} aria-hidden />;
}

function ShapesIcon() {
  return <PhShapes size={15} aria-hidden />;
}

function CloudIcon() {
  return <PhCloud size={15} aria-hidden />;
}

function DocumentIcon() {
  return <PhFileText size={15} aria-hidden />;
}

function LayersIcon() {
  return <PhStack size={15} aria-hidden />;
}

function UploadIcon() {
  return <PhUploadSimple size={15} aria-hidden />;
}

function ImageIcon() {
  return <PhImage size={15} aria-hidden />;
}

function PencilIcon() {
  return <PhPencilSimple size={15} aria-hidden />;
}

function PuzzleIcon() {
  return <PhPuzzlePiece size={15} aria-hidden />;
}

function PlugIcon() {
  return <PhPlugs size={15} aria-hidden />;
}

function ShieldIcon() {
  return <PhShieldCheck size={15} aria-hidden />;
}

interface LibraryEntry {
  id: string;
  label: string;
  hint: string;
}

interface ImportSource extends LibraryEntry {
  icon: ReactNode;
}

const IMPORT_SOURCES: ImportSource[] = [
  { id: "github", label: "GitHub", hint: "Pull in a repo, PR, or file", icon: <CodeBracketIcon /> },
  { id: "figma", label: "Figma", hint: "Pull in a frame or file", icon: <ShapesIcon /> },
  { id: "drive", label: "Google Drive", hint: "Pull in a doc or sheet", icon: <CloudIcon /> },
  { id: "notion", label: "Notion", hint: "Pull in a page or database", icon: <DocumentIcon /> },
  { id: "linear", label: "Linear", hint: "Pull in an issue", icon: <LayersIcon /> },
];

const DEFAULT_SKILLS: LibraryEntry[] = [
  { id: "accessibility", label: "Accessibility audit", hint: "WCAG AA review pass" },
  { id: "dataviz", label: "Data visualization", hint: "Charts, dashboards, palettes" },
  { id: "pr-description", label: "PR description", hint: "Summarize a diff for review" },
  { id: "code-review", label: "Code review", hint: "Correctness + simplification pass" },
];

const MCP_SERVERS: LibraryEntry[] = [
  { id: "github-mcp", label: "GitHub", hint: "Issues, PRs, repositories" },
  { id: "figma-mcp", label: "Figma", hint: "Design context and assets" },
  { id: "notion-mcp", label: "Notion", hint: "Pages and databases" },
  { id: "postgres-mcp", label: "Postgres", hint: "Query a connected database" },
];

type PermissionMode = "manual" | "auto" | "bypass";

const PERMISSION_MODES: { id: PermissionMode; label: string; hint: string }[] = [
  { id: "manual", label: "Manual", hint: "Confirm every tool call before it runs" },
  { id: "auto", label: "Auto", hint: "Run safe actions automatically, ask for risky ones" },
  { id: "bypass", label: "Bypass", hint: "Run everything without asking; use with care" },
];

type ToolSubmenuId = "import" | "instructions" | "skills" | "mcps" | "permissions";

const MENU_ITEM_CLASS =
  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-stone-700 transition-colors hover:bg-stone-50 dark:text-stone-200 dark:hover:bg-stone-800/60";

type FlyoutAxis = "vertical" | "horizontal";
type FlyoutSide = "top" | "bottom" | "left" | "right";

interface FlyoutPosition {
  top: number;
  left: number;
  side: FlyoutSide;
}

/**
 * Positions a floating panel against an anchor element using fixed (viewport-relative)
 * coordinates, flipping to the opposite side when the preferred side doesn't fit and
 * clamping within the viewport, so panels never overlap page content above/beside them
 * regardless of where the anchor sits on the page. Recomputes on resize and panel-size
 * change, but not on scroll: the caller closes the menu on scroll instead of chasing the
 * anchor, since a `position: fixed` panel has no reliable way to track an anchor through
 * this site's Lenis-driven smooth scroll without drifting or scroll-jank.
 */
function useFloatingPosition(
  anchorRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
  axis: FlyoutAxis,
  preferredSide: FlyoutSide,
  gap: number,
): FlyoutPosition | null {
  const [position, setPosition] = useState<FlyoutPosition | null>(null);

  useLayoutEffect(() => {
    // Stale coordinates from the last time this panel was open are harmless: the caller
    // never renders the panel while closed, so there's nothing to reset here, only to
    // recompute once it opens again.
    if (!isOpen) return;
    const margin = 8;

    const update = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const anchorRect = anchor.getBoundingClientRect();
      const panelWidth = panel.offsetWidth;
      const panelHeight = panel.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let top: number;
      let left: number;
      let side: FlyoutSide;

      if (axis === "vertical") {
        const spaceAbove = anchorRect.top;
        const spaceBelow = vh - anchorRect.bottom;
        const fitsBelow = spaceBelow >= panelHeight + gap;
        const fitsAbove = spaceAbove >= panelHeight + gap;
        const openBelow =
          preferredSide === "bottom" ? fitsBelow || spaceBelow >= spaceAbove : !(fitsAbove || spaceAbove >= spaceBelow);
        side = openBelow ? "bottom" : "top";
        top = openBelow ? anchorRect.bottom + gap : anchorRect.top - gap - panelHeight;
        left = anchorRect.left;
      } else {
        const spaceLeft = anchorRect.left;
        const spaceRight = vw - anchorRect.right;
        const fitsRight = spaceRight >= panelWidth + gap;
        const fitsLeft = spaceLeft >= panelWidth + gap;
        const openRight =
          preferredSide === "right" ? fitsRight || spaceRight >= spaceLeft : !(fitsLeft || spaceLeft >= spaceRight);
        side = openRight ? "right" : "left";
        left = openRight ? anchorRect.right + gap : anchorRect.left - gap - panelWidth;
        top = anchorRect.top;
      }

      top = Math.min(Math.max(top, margin), Math.max(margin, vh - panelHeight - margin));
      left = Math.min(Math.max(left, margin), Math.max(margin, vw - panelWidth - margin));

      setPosition({ top, left, side });
    };

    update();
    window.addEventListener("resize", update);
    const ro = new ResizeObserver(update);
    if (panelRef.current) ro.observe(panelRef.current);

    return () => {
      window.removeEventListener("resize", update);
      ro.disconnect();
    };
  }, [isOpen, anchorRef, panelRef, axis, preferredSide, gap]);

  return position;
}

const subscribeNever = () => () => {};

/**
 * Portaled panels need `document.body` as a render target, which doesn't exist during
 * SSR. Gating on this (rather than `typeof document !== "undefined"` inline) keeps the
 * server and first-client-render markup identical: `useSyncExternalStore`'s server
 * snapshot returns `false`, its client snapshot returns `true`, so this flips strictly
 * after hydration with no hydration mismatch and no setState-in-effect.
 */
function useHasMounted() {
  return useSyncExternalStore(subscribeNever, () => true, () => false);
}

function formatClipTime(s: number) {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function VoiceClip({ url, onRemove }: { url: string; onRemove: () => void }) {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (!playing) return;
    let raf: number;
    const tick = () => {
      const audio = audioRef.current;
      if (!audio) return;
      setCurrentTime(audio.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
      return;
    }
    if (audio.ended || audio.currentTime >= (audio.duration || 0)) audio.currentTime = 0;
    audio.play().catch(() => {});
    setPlaying(true);
  };

  const frac = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="flex items-center gap-2 rounded-full bg-black/5 py-1 pl-1 pr-2 text-xs font-medium text-stone-600 dark:bg-white/10 dark:text-stone-300"
    >
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onEnded={() => {
          setPlaying(false);
          setCurrentTime(0);
        }}
        className="hidden"
      />
      <button
        type="button"
        onClick={togglePlay}
        aria-label={playing ? "Pause voice message" : "Play voice message"}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-white"
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <span className="h-1 w-16 overflow-hidden rounded-full bg-stone-300/70 dark:bg-white/15">
        <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${frac * 100}%` }} />
      </span>
      <span className="tabular-nums text-stone-500 dark:text-stone-500">{formatClipTime(playing || currentTime > 0 ? currentTime : duration)}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove voice message"
        className="ml-0.5 text-stone-500 transition-colors hover:text-stone-600 dark:hover:text-stone-200"
      >
        ×
      </button>
    </motion.div>
  );
}

function ListeningIndicator({ shouldReduceMotion }: { shouldReduceMotion: boolean | null }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400"
    >
      <span className="flex h-4 items-end gap-0.5">
        {WAVEFORM_BARS.map((bar, i) => (
          <motion.span
            key={i}
            className="w-0.5 rounded-full bg-amber-500 dark:bg-amber-400"
            style={{ height: 4 }}
            animate={shouldReduceMotion ? undefined : { height: [4, bar.peak, 4] }}
            transition={{ duration: bar.duration, repeat: Infinity, ease: "easeInOut", delay: bar.delay }}
          />
        ))}
      </span>
      Listening…
    </motion.div>
  );
}

function ToolMenuRow({
  icon,
  label,
  isOpen,
  onEnter,
  onLeave,
  onActivate,
  panelWidth = "w-56",
  shouldReduceMotion,
  children,
}: {
  icon: ReactNode;
  label: string;
  isOpen: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onActivate: () => void;
  panelWidth?: string;
  shouldReduceMotion: boolean | null;
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const position = useFloatingPosition(rowRef, panelRef, isOpen, "horizontal", "right", 6);
  const openLeft = position?.side === "left";
  const mounted = useHasMounted();

  return (
    <div ref={rowRef} className="relative" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={onActivate}
        className={MENU_ITEM_CLASS}
      >
        <span className="text-stone-500">{icon}</span>
        <span className="flex-1">{label}</span>
        <span className="text-stone-300 dark:text-stone-600">
          <ChevronRightIcon />
        </span>
      </button>
      {mounted && createPortal(
        <AnimatePresence>
          {isOpen && (
            <motion.div
              key={label}
              ref={panelRef}
              role="menu"
              aria-label={label}
              data-chat-tools-panel
              initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, x: openLeft ? 4 : -4 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
              exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, x: openLeft ? 2 : -2 }}
              transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
              style={{
                position: "fixed",
                top: position?.top ?? -9999,
                left: position?.left ?? -9999,
                transformOrigin: openLeft ? "top right" : "top left",
              }}
              onMouseEnter={onEnter}
              onMouseLeave={onLeave}
              className={`z-[60] ${panelWidth} rounded-2xl border border-stone-200 bg-white p-1.5 shadow-[0_1px_2px_-1px_rgba(0,0,0,0.06),0_4px_12px_-4px_rgba(0,0,0,0.08)] dark:shadow-none dark:border-stone-800 dark:bg-stone-900`}
            >
              {children}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}

export function ChatInputBar({
  placeholders = DEFAULT_PLACEHOLDERS,
  onSend,
  glowTone = "mono",
}: {
  placeholders?: string[];
  onSend?: (message: string, voiceUrl?: string) => void;
  glowTone?: GlowTone;
}) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [phase, setPhase] = useState<"idle" | "thinking">("idle");
  const [recording, setRecording] = useState(false);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<string | null>(null);
  const [promptIndex, setPromptIndex] = useState(0);
  const [modelId, setModelId] = useState(MODELS[1].id);
  const [modelOpen, setModelOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [openSubmenu, setOpenSubmenu] = useState<ToolSubmenuId | null>(null);
  const [importedSources, setImportedSources] = useState<Set<string>>(new Set());
  const [instructions, setInstructions] = useState("");
  const [instructionsDraft, setInstructionsDraft] = useState("");
  const [skills, setSkills] = useState<LibraryEntry[]>(DEFAULT_SKILLS);
  const [addedSkills, setAddedSkills] = useState<Set<string>>(new Set());
  const [skillQuery, setSkillQuery] = useState("");
  const [newSkillDraft, setNewSkillDraft] = useState("");
  const [mcpQuery, setMcpQuery] = useState("");
  const [connectedMcps, setConnectedMcps] = useState<Set<string>>(new Set());
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("manual");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const toolsButtonRef = useRef<HTMLButtonElement>(null);
  const toolsPanelRef = useRef<HTMLDivElement>(null);
  const submenuCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recordedUrlRef = useRef<string | null>(null);
  const shouldReduceMotion = useReducedMotion();
  const activeGlow = GLOW_TONES[glowTone];
  const toolsPosition = useFloatingPosition(toolsButtonRef, toolsPanelRef, toolsOpen, "vertical", "bottom", 8);
  const toolsOpenAbove = toolsPosition?.side === "top";
  const toolsMounted = useHasMounted();

  useEffect(() => {
    if (value || recording) return;
    const id = setInterval(() => setPromptIndex((i) => (i + 1) % placeholders.length), 3200);
    return () => clearInterval(id);
  }, [value, recording, placeholders.length]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  useEffect(() => {
    recordedUrlRef.current = recordedUrl;
  }, [recordedUrl]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (micErrorTimeoutRef.current) clearTimeout(micErrorTimeoutRef.current);
      if (submenuCloseTimeoutRef.current) clearTimeout(submenuCloseTimeoutRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") mediaRecorderRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (recordedUrlRef.current) URL.revokeObjectURL(recordedUrlRef.current);
    };
  }, []);

  useEffect(() => {
    if (!modelOpen) return;
    const onClick = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModelOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [modelOpen]);

  useEffect(() => {
    if (!toolsOpen) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      // The menu panel and every submenu panel are portaled to document.body (so their
      // own fixed-position math escapes any transformed ancestor, see useFloatingPosition),
      // meaning none of them are DOM descendants of toolsRef anymore. Every portaled panel
      // carries data-chat-tools-panel, so a click inside any of them is still "inside".
      const insideTrigger = toolsRef.current?.contains(target);
      const insidePanel = target instanceof Element && target.closest("[data-chat-tools-panel]");
      if (!insideTrigger && !insidePanel) {
        setToolsOpen(false);
        setOpenSubmenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setToolsOpen(false);
        setOpenSubmenu(null);
      }
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [toolsOpen]);

  useEffect(() => {
    if (!toolsOpen) return;
    // The panel is `position: fixed`, so it doesn't move with the page on its own, closing
    // on scroll (rather than trying to re-track the anchor) avoids it drifting away from its
    // trigger and ending up stranded over unrelated content further down the page. Scroll
    // events inside one of our own panels (e.g. a long skills/MCP list) don't count.
    const onScroll = (e: Event) => {
      const target = e.target;
      if (target instanceof Element && target.closest("[data-chat-tools-panel]")) return;
      setToolsOpen(false);
      setOpenSubmenu(null);
    };
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, [toolsOpen]);

  const canSend = value.trim().length > 0 || !!recordedUrl;
  const busy = phase === "thinking" || recording;
  const activeModel = MODELS.find((m) => m.id === modelId) ?? MODELS[1];
  const filteredSkills = useMemo(
    () => skills.filter((s) => s.label.toLowerCase().includes(skillQuery.trim().toLowerCase())),
    [skills, skillQuery],
  );
  const filteredMcps = useMemo(
    () => MCP_SERVERS.filter((m) => m.label.toLowerCase().includes(mcpQuery.trim().toLowerCase())),
    [mcpQuery],
  );

  const closeToolsMenu = () => {
    setToolsOpen(false);
    setOpenSubmenu(null);
  };

  const openSubmenuNow = (id: ToolSubmenuId) => {
    if (submenuCloseTimeoutRef.current) clearTimeout(submenuCloseTimeoutRef.current);
    setOpenSubmenu(id);
  };

  const scheduleSubmenuClose = () => {
    if (submenuCloseTimeoutRef.current) clearTimeout(submenuCloseTimeoutRef.current);
    submenuCloseTimeoutRef.current = setTimeout(() => setOpenSubmenu(null), 160);
  };

  const openInstructionsMenu = () => {
    if (openSubmenu !== "instructions") setInstructionsDraft(instructions);
    openSubmenuNow("instructions");
  };

  const toggleImportSource = (id: string) => {
    setImportedSources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setAttachment(file.name);
    e.target.value = "";
    closeToolsMenu();
  };

  const handleGenerateImage = () => {
    setAttachment("generated-image.png");
    closeToolsMenu();
  };

  const saveInstructions = () => {
    setInstructions(instructionsDraft.trim());
    closeToolsMenu();
  };

  const toggleSkill = (id: string) => {
    setAddedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addCustomSkill = () => {
    const label = newSkillDraft.trim();
    if (!label) return;
    const id = `custom-${Date.now()}`;
    setSkills((prev) => [...prev, { id, label, hint: "Custom skill" }]);
    setAddedSkills((prev) => new Set(prev).add(id));
    setNewSkillDraft("");
  };

  const toggleMcp = (id: string) => {
    setConnectedMcps((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const discardRecording = () => {
    if (recordedUrlRef.current) URL.revokeObjectURL(recordedUrlRef.current);
    setRecordedUrl(null);
  };

  const handleSend = () => {
    if (phase === "thinking") {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      setPhase("idle");
      return;
    }
    if (recording || !canSend) return;
    onSend?.(value.trim(), recordedUrl ?? undefined);
    setValue("");
    setAttachment(null);
    discardRecording();
    setPhase("thinking");
    timeoutRef.current = setTimeout(() => setPhase("idle"), 1700);
  };

  const showMicError = (message: string) => {
    setMicError(message);
    if (micErrorTimeoutRef.current) clearTimeout(micErrorTimeoutRef.current);
    micErrorTimeoutRef.current = setTimeout(() => setMicError(null), 3200);
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      showMicError("This browser can't record audio.");
      return;
    }
    setMicError(null);
    try {
      // Prompts the browser's native microphone-permission dialog.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      recordedChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        discardRecording();
        setRecordedUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err) {
      const denied = err instanceof DOMException && err.name === "NotAllowedError";
      showMicError(denied ? "Microphone access was denied." : "Couldn't access the microphone.");
    }
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    setRecording(false);
  };

  const toggleRecording = () => {
    if (phase === "thinking") return;
    if (recording) {
      stopRecording();
      return;
    }
    startRecording();
  };

  const startNewConversation = () => {
    if (busy) return;
    setValue("");
    setAttachment(null);
    discardRecording();
    textareaRef.current?.focus();
  };

  return (
    <div className="w-full max-w-xl">
      <div className="relative">
        <motion.div
          aria-hidden
          className="pointer-events-none absolute -inset-6 rounded-2xl opacity-40 blur-3xl transform-gpu dark:hidden"
          style={{ background: activeGlow.light }}
          animate={shouldReduceMotion ? undefined : { x: [0, 6, -6, 0], y: [0, -6, 4, 0] }}
          transition={{ duration: 10, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          aria-hidden
          className="pointer-events-none absolute -inset-6 rounded-2xl opacity-40 blur-3xl transform-gpu hidden dark:block"
          style={{ background: activeGlow.dark }}
          animate={shouldReduceMotion ? undefined : { x: [0, 6, -6, 0], y: [0, -6, 4, 0] }}
          transition={{ duration: 10, repeat: Infinity, ease: "easeInOut" }}
        />

        <div className="relative">
          <div className="relative rounded-2xl border border-stone-200 bg-white shadow-[0_25px_60px_-25px_rgba(5,150,105,0.35)] transition-colors duration-150 dark:border-stone-800 dark:bg-stone-900 dark:shadow-[0_25px_60px_-20px_rgba(0,0,0,0.7)]">
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[28px] bg-gradient-to-r from-transparent via-white/60 to-transparent dark:via-white/25"
            />
            <AnimatePresence>
              {(attachment || recordedUrl) && (
                <div className="flex flex-wrap gap-2 px-4 pt-3.5">
                  {attachment && (
                    <motion.span
                      initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: -4 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
                      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                      className="inline-flex items-center gap-1.5 rounded-full bg-black/5 py-1 pl-1 pr-2 text-xs font-medium text-stone-600 dark:bg-white/10 dark:text-stone-300"
                    >
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700">
                        <PaperclipIcon />
                      </span>
                      {attachment}
                      <button
                        type="button"
                        onClick={() => setAttachment(null)}
                        aria-label={`Remove ${attachment}`}
                        className="ml-0.5 text-stone-500 transition-colors hover:text-stone-600 dark:hover:text-stone-200"
                      >
                        ×
                      </button>
                    </motion.span>
                  )}
                  {recordedUrl && <VoiceClip url={recordedUrl} onRemove={discardRecording} />}
                </div>
              )}
            </AnimatePresence>

            <div className="relative px-4 pt-3.5">
              <label htmlFor="chat-input-bar" className="sr-only">
                Message
              </label>
              <textarea
                id="chat-input-bar"
                ref={textareaRef}
                rows={1}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                disabled={busy}
                className="block max-h-40 w-full resize-none bg-transparent text-sm leading-relaxed text-stone-900 outline-none focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 dark:text-stone-100"
              />
              {value.length === 0 && (
                <div className="pointer-events-none absolute inset-x-4 top-3.5 overflow-hidden">
                  {recording ? (
                    <ListeningIndicator shouldReduceMotion={shouldReduceMotion} />
                  ) : (
                    <AnimatePresence mode="wait">
                      <motion.span
                        key={promptIndex}
                        initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
                        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                        className="block truncate text-sm text-stone-500 dark:text-stone-500"
                      >
                        {placeholders[promptIndex]}
                      </motion.span>
                    </AnimatePresence>
                  )}
                </div>
              )}
            </div>

            <div className="mt-2 flex items-center justify-between gap-2 rounded-b-[26px] border-t border-stone-900/5 bg-black/[0.015] px-3 py-2.5 dark:border-white/10 dark:bg-white/[0.02]">
              <div className="flex items-center gap-1">
                <div ref={toolsRef} className="relative">
                  <button
                    ref={toolsButtonRef}
                    type="button"
                    onClick={() => setToolsOpen((v) => !v)}
                    disabled={busy}
                    aria-haspopup="menu"
                    aria-expanded={toolsOpen}
                    aria-label="Add tools and context"
                    className="relative inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-black/5 hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 disabled:pointer-events-none disabled:opacity-50 dark:text-stone-400 dark:hover:bg-white/10 dark:hover:text-stone-200"
                  >
                    <motion.span
                      className="flex items-center justify-center"
                      animate={{ rotate: toolsOpen ? 45 : 0 }}
                      transition={{ duration: 0.15 }}
                    >
                      <PlusIcon />
                    </motion.span>
                    {permissionMode === "bypass" && (
                      <span
                        aria-hidden
                        className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-red-500"
                      />
                    )}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    onChange={handleFileUpload}
                    className="hidden"
                    tabIndex={-1}
                    aria-hidden
                  />
                  {toolsMounted && createPortal(
                    <AnimatePresence>
                      {toolsOpen && (
                        <motion.div
                          key="tools-menu"
                          ref={toolsPanelRef}
                          role="menu"
                          aria-label="Tools"
                          data-chat-tools-panel
                        initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: toolsOpenAbove ? 6 : -6 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: toolsOpenAbove ? 4 : -4 }}
                        transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                        style={{
                          position: "fixed",
                          top: toolsPosition?.top ?? -9999,
                          left: toolsPosition?.left ?? -9999,
                          transformOrigin: toolsOpenAbove ? "bottom left" : "top left",
                        }}
                        className="z-30 w-64 rounded-2xl border border-stone-200 bg-white p-1.5 shadow-[0_1px_2px_-1px_rgba(0,0,0,0.06),0_4px_12px_-4px_rgba(0,0,0,0.08)] dark:shadow-none dark:border-stone-800 dark:bg-stone-900"
                      >
                        <ToolMenuRow
                          icon={<CodeBracketIcon />}
                          label="Import from"
                          isOpen={openSubmenu === "import"}
                          onEnter={() => openSubmenuNow("import")}
                          onLeave={scheduleSubmenuClose}
                          onActivate={() => openSubmenuNow("import")}
                          shouldReduceMotion={shouldReduceMotion}
                        >
                          <div data-lenis-prevent className="scrollbar-thin max-h-40 overflow-y-auto">
                            {IMPORT_SOURCES.map((source) => (
                              <button
                                key={source.id}
                                type="button"
                                role="menuitemcheckbox"
                                aria-checked={importedSources.has(source.id)}
                                onClick={() => toggleImportSource(source.id)}
                                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-emerald-500/10 dark:hover:bg-emerald-500/15/60"
                              >
                                <span className="text-stone-500">{source.icon}</span>
                                <span className="flex-1">
                                  <span className="block text-sm font-medium text-stone-900 dark:text-stone-100">{source.label}</span>
                                  <span className="block text-xs text-stone-500 dark:text-stone-500">{source.hint}</span>
                                </span>
                                {importedSources.has(source.id) && (
                                  <span className="text-emerald-700">
                                    <CheckIcon />
                                  </span>
                                )}
                              </button>
                            ))}
                          </div>
                        </ToolMenuRow>

                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => fileInputRef.current?.click()}
                          className={MENU_ITEM_CLASS}
                        >
                          <span className="text-stone-500">
                            <UploadIcon />
                          </span>
                          <span className="flex-1">Upload from computer</span>
                        </button>

                        <button
                          type="button"
                          role="menuitem"
                          onClick={handleGenerateImage}
                          className={MENU_ITEM_CLASS}
                        >
                          <span className="text-stone-500">
                            <ImageIcon />
                          </span>
                          <span className="flex-1">Generate an image</span>
                        </button>

                        <div className="my-1 h-px bg-stone-900/5 dark:bg-white/10" />

                        <ToolMenuRow
                          icon={<PencilIcon />}
                          label="Custom instructions"
                          isOpen={openSubmenu === "instructions"}
                          onEnter={openInstructionsMenu}
                          onLeave={scheduleSubmenuClose}
                          onActivate={openInstructionsMenu}
                          panelWidth="w-72"
                          shouldReduceMotion={shouldReduceMotion}
                        >
                          <div className="p-1.5">
                            <label
                              htmlFor="chat-input-instructions"
                              className="mb-1.5 block px-1 text-xs font-medium text-stone-500 dark:text-stone-400"
                            >
                              How should responses sound?
                            </label>
                            <textarea
                              id="chat-input-instructions"
                              rows={4}
                              value={instructionsDraft}
                              onChange={(e) => setInstructionsDraft(e.target.value)}
                              placeholder="e.g. Keep answers short, skip the pleasantries, prefer bullet points…"
                              className="w-full resize-none rounded-xl border border-stone-200 bg-stone-50 px-2.5 py-2 text-xs leading-relaxed text-stone-700 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:border-white/10 dark:bg-white/5 dark:text-stone-200"
                            />
                            <div className="mt-2 flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={closeToolsMenu}
                                className="rounded-full px-2.5 py-1 text-xs font-medium text-stone-500 transition-colors hover:bg-black/5 dark:text-stone-400 dark:hover:bg-white/10"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={saveInstructions}
                                className="rounded-full bg-emerald-700 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-800 dark:bg-emerald-700 dark:hover:bg-emerald-800"
                              >
                                Save
                              </button>
                            </div>
                          </div>
                        </ToolMenuRow>

                        <ToolMenuRow
                          icon={<PuzzleIcon />}
                          label="Skills"
                          isOpen={openSubmenu === "skills"}
                          onEnter={() => openSubmenuNow("skills")}
                          onLeave={scheduleSubmenuClose}
                          onActivate={() => openSubmenuNow("skills")}
                          shouldReduceMotion={shouldReduceMotion}
                        >
                          <div className="relative mb-1 px-1 pt-0.5">
                            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-stone-300 dark:text-stone-600">
                              <SearchIcon />
                            </span>
                            <input
                              type="text"
                              value={skillQuery}
                              onChange={(e) => setSkillQuery(e.target.value)}
                              placeholder="Search skills…"
                              aria-label="Search skills"
                              className="w-full rounded-lg border border-stone-200 bg-stone-50 py-1.5 pl-7 pr-2 text-xs text-stone-700 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:border-white/10 dark:bg-white/5 dark:text-stone-200"
                            />
                          </div>
                          <div data-lenis-prevent className="scrollbar-thin max-h-40 overflow-y-auto">
                            {filteredSkills.length === 0 && (
                              <p className="px-2.5 py-2 text-xs text-stone-500 dark:text-stone-500">
                                No skills match &ldquo;{skillQuery}&rdquo;.
                              </p>
                            )}
                            {filteredSkills.map((skill) => (
                              <button
                                key={skill.id}
                                type="button"
                                role="menuitemcheckbox"
                                aria-checked={addedSkills.has(skill.id)}
                                onClick={() => toggleSkill(skill.id)}
                                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-emerald-500/10 dark:hover:bg-emerald-500/15/60"
                              >
                                <span className="flex-1">
                                  <span className="block text-sm font-medium text-stone-900 dark:text-stone-100">{skill.label}</span>
                                  <span className="block text-xs text-stone-500 dark:text-stone-500">{skill.hint}</span>
                                </span>
                                {addedSkills.has(skill.id) && (
                                  <span className="text-emerald-700">
                                    <CheckIcon />
                                  </span>
                                )}
                              </button>
                            ))}
                          </div>
                          <div className="mt-1 flex items-center gap-1.5 border-t border-stone-900/5 px-1 pt-1.5 dark:border-white/10">
                            <input
                              type="text"
                              value={newSkillDraft}
                              onChange={(e) => setNewSkillDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  addCustomSkill();
                                }
                              }}
                              placeholder="Add a new skill…"
                              aria-label="New skill name"
                              className="min-w-0 flex-1 rounded-lg border border-stone-200 bg-stone-50 px-2 py-1.5 text-xs text-stone-700 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:border-white/10 dark:bg-white/5 dark:text-stone-200"
                            />
                            <button
                              type="button"
                              onClick={addCustomSkill}
                              disabled={!newSkillDraft.trim()}
                              aria-label="Add skill"
                              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-stone-900 text-white transition-colors hover:bg-stone-700 disabled:pointer-events-none disabled:opacity-50 dark:bg-white dark:text-stone-900 dark:hover:bg-stone-200"
                            >
                              <PlusIcon />
                            </button>
                          </div>
                        </ToolMenuRow>

                        <ToolMenuRow
                          icon={<PlugIcon />}
                          label="MCPs"
                          isOpen={openSubmenu === "mcps"}
                          onEnter={() => openSubmenuNow("mcps")}
                          onLeave={scheduleSubmenuClose}
                          onActivate={() => openSubmenuNow("mcps")}
                          shouldReduceMotion={shouldReduceMotion}
                        >
                          <div className="relative mb-1 px-1 pt-0.5">
                            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-stone-300 dark:text-stone-600">
                              <SearchIcon />
                            </span>
                            <input
                              type="text"
                              value={mcpQuery}
                              onChange={(e) => setMcpQuery(e.target.value)}
                              placeholder="Search MCP servers…"
                              aria-label="Search MCP servers"
                              className="w-full rounded-lg border border-stone-200 bg-stone-50 py-1.5 pl-7 pr-2 text-xs text-stone-700 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 dark:border-white/10 dark:bg-white/5 dark:text-stone-200"
                            />
                          </div>
                          <div data-lenis-prevent className="scrollbar-thin max-h-40 overflow-y-auto">
                            {filteredMcps.length === 0 && (
                              <p className="px-2.5 py-2 text-xs text-stone-500 dark:text-stone-500">
                                No servers match &ldquo;{mcpQuery}&rdquo;.
                              </p>
                            )}
                            {filteredMcps.map((server) => (
                              <button
                                key={server.id}
                                type="button"
                                role="menuitemcheckbox"
                                aria-checked={connectedMcps.has(server.id)}
                                onClick={() => toggleMcp(server.id)}
                                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-emerald-500/10 dark:hover:bg-emerald-500/15/60"
                              >
                                <span
                                  aria-hidden
                                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                    connectedMcps.has(server.id) ? "bg-emerald-500" : "bg-stone-300 dark:bg-stone-600"
                                  }`}
                                />
                                <span className="flex-1">
                                  <span className="block text-sm font-medium text-stone-900 dark:text-stone-100">{server.label}</span>
                                  <span className="block text-xs text-stone-500 dark:text-stone-500">{server.hint}</span>
                                </span>
                                <span className="text-[11px] font-medium text-stone-500 dark:text-stone-500">
                                  {connectedMcps.has(server.id) ? "Connected" : "Connect"}
                                </span>
                              </button>
                            ))}
                          </div>
                        </ToolMenuRow>

                        <div className="my-1 h-px bg-stone-900/5 dark:bg-white/10" />

                        <ToolMenuRow
                          icon={<ShieldIcon />}
                          label="Permissions"
                          isOpen={openSubmenu === "permissions"}
                          onEnter={() => openSubmenuNow("permissions")}
                          onLeave={scheduleSubmenuClose}
                          onActivate={() => openSubmenuNow("permissions")}
                          shouldReduceMotion={shouldReduceMotion}
                        >
                          {PERMISSION_MODES.map((mode) => (
                            <button
                              key={mode.id}
                              type="button"
                              role="menuitemradio"
                              aria-checked={permissionMode === mode.id}
                              onClick={() => {
                                setPermissionMode(mode.id);
                                closeToolsMenu();
                              }}
                              className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-emerald-500/10 dark:hover:bg-emerald-500/15/60"
                            >
                              <span
                                aria-hidden
                                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                                  permissionMode === mode.id
                                    ? "border-emerald-600 bg-emerald-600"
                                    : "border-stone-300 dark:border-stone-600"
                                }`}
                              >
                                {permissionMode === mode.id && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                              </span>
                              <span className="flex-1">
                                <span
                                  className={`block text-sm font-medium ${
                                    mode.id === "bypass" ? "text-red-600 dark:text-red-400" : "text-stone-900 dark:text-stone-100"
                                  }`}
                                >
                                  {mode.label}
                                </span>
                                <span className="block text-xs text-stone-500 dark:text-stone-500">{mode.hint}</span>
                              </span>
                            </button>
                          ))}
                        </ToolMenuRow>
                        </motion.div>
                      )}
                    </AnimatePresence>,
                    document.body,
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setAttachment((a) => a ?? "brief.pdf")}
                  disabled={busy}
                  aria-label="Attach file"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-black/5 hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 disabled:pointer-events-none disabled:opacity-50 dark:text-stone-400 dark:hover:bg-white/10 dark:hover:text-stone-200"
                >
                  <PaperclipIcon />
                </button>
                <div className="relative">
                  <button
                    type="button"
                    onClick={toggleRecording}
                    disabled={phase === "thinking"}
                    aria-pressed={recording}
                    aria-label={recording ? "Stop recording" : "Record a voice message"}
                    className={`relative inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 disabled:pointer-events-none disabled:opacity-50 ${
                      recording
                        ? "bg-emerald-700 text-white"
                        : "text-stone-500 hover:bg-black/5 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-white/10 dark:hover:text-stone-200"
                    }`}
                  >
                    {recording && (
                      <motion.span
                        aria-hidden
                        className="absolute inset-[-4px] rounded-full border border-amber-400/60"
                        animate={shouldReduceMotion ? undefined : { scale: [1, 1.35], opacity: [0.6, 0] }}
                        transition={{ duration: 1.1, repeat: Infinity, ease: "easeOut" }}
                      />
                    )}
                    {recording ? <StopIcon /> : <MicIcon />}
                  </button>
                  <AnimatePresence>
                    {micError && (
                      <motion.p
                        role="alert"
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 4 }}
                        transition={{ duration: 0.15 }}
                        className="absolute bottom-full left-1/2 mb-2 w-max max-w-[180px] -translate-x-1/2 rounded-lg bg-red-600 px-2.5 py-1.5 text-center text-[11px] font-medium text-white shadow-[0_1px_2px_-1px_rgba(0,0,0,0.06),0_4px_12px_-4px_rgba(0,0,0,0.08)] dark:shadow-none"
                      >
                        {micError}
                      </motion.p>
                    )}
                  </AnimatePresence>
                </div>
                <button
                  type="button"
                  onClick={startNewConversation}
                  disabled={busy}
                  aria-label="Start new conversation"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-black/5 hover:text-stone-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 disabled:pointer-events-none disabled:opacity-50 dark:text-stone-400 dark:hover:bg-white/10 dark:hover:text-stone-200"
                >
                  <NewConversationIcon />
                </button>
              </div>

              <div className="flex items-center gap-1.5">
                <div ref={modelRef} className="relative">
                  <button
                    type="button"
                    onClick={() => setModelOpen((v) => !v)}
                    disabled={busy}
                    aria-haspopup="listbox"
                    aria-expanded={modelOpen}
                    className="inline-flex items-center gap-1.5 rounded-full border border-stone-900/10 bg-black/[0.02] px-2.5 py-1 text-xs font-medium text-stone-600 transition-colors hover:border-stone-900/20 hover:bg-black/5 hover:text-stone-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 disabled:pointer-events-none disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-stone-300 dark:hover:border-white/20 dark:hover:bg-emerald-500/15 dark:hover:text-stone-100"
                  >
                    <span className="text-emerald-700">{activeModel.icon}</span>
                    {activeModel.label}
                    <motion.span
                      animate={{ rotate: modelOpen ? 180 : 0 }}
                      transition={{ duration: 0.15 }}
                      className="text-stone-500"
                    >
                      <ChevronDownIcon />
                    </motion.span>
                  </button>
                  <AnimatePresence>
                    {modelOpen && (
                      <motion.div
                        role="listbox"
                        aria-label="Model"
                        initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 6 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 4 }}
                        transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                        style={{ transformOrigin: "bottom left" }}
                        className="scrollbar-thin absolute bottom-full left-0 z-20 mb-2 max-h-32 w-52 overflow-y-auto rounded-xl border border-stone-200 bg-white p-1 shadow-[0_1px_2px_-1px_rgba(0,0,0,0.06),0_4px_12px_-4px_rgba(0,0,0,0.08)] dark:shadow-none dark:border-stone-800 dark:bg-stone-900"
                      >
                        {MODELS.map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            role="option"
                            aria-selected={m.id === modelId}
                            onClick={() => {
                              setModelId(m.id);
                              setModelOpen(false);
                            }}
                            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-emerald-500/10 dark:hover:bg-emerald-500/15/60"
                          >
                            <span className="text-amber-500">{m.icon}</span>
                            <span className="flex-1">
                              <span className="block text-sm font-medium text-stone-900 dark:text-stone-100">{m.label}</span>
                              <span className="block text-xs text-stone-500 dark:text-stone-500">{m.hint}</span>
                            </span>
                            {m.id === modelId && (
                              <span className="text-amber-500">
                                <CheckIcon />
                              </span>
                            )}
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <button
                  type="button"
                  onClick={handleSend}
                  disabled={phase === "idle" && (recording || !canSend)}
                  aria-label={phase === "thinking" ? "Stop generating" : "Send message"}
                  className={`relative inline-flex h-8 w-8 items-center justify-center rounded-full transition-[color,background-color,border-color,transform,opacity] duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 disabled:pointer-events-none ${
                    phase === "thinking"
                      ? "bg-emerald-700 text-white dark:bg-emerald-700"
                      : canSend && !recording
                        ? "bg-gradient-to-br from-emerald-700 via-emerald-500 to-emerald-600 text-white shadow-[0_4px_18px_-4px_rgba(5,150,105,0.65)]"
                        : "bg-black/5 text-stone-500 dark:bg-white/10 dark:text-stone-500"
                  }`}
                >
                  {phase === "thinking" && (
                    <motion.span
                      aria-hidden
                      className="absolute inset-[-4px] rounded-full border border-emerald-400/60"
                      animate={shouldReduceMotion ? undefined : { scale: [1, 1.35], opacity: [0.6, 0] }}
                      transition={{ duration: 1.1, repeat: Infinity, ease: "easeOut" }}
                    />
                  )}
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={phase}
                      initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6, rotate: -45 }}
                      animate={{ opacity: 1, scale: 1, rotate: 0 }}
                      exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6, rotate: 45 }}
                      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                      className="flex items-center justify-center"
                    >
                      {phase === "thinking" ? <StopIcon /> : <ArrowUpIcon />}
                    </motion.span>
                  </AnimatePresence>
                </button>
              </div>
            </div>
          </div>
        </div>

        <AnimatePresence>
          {focused && (
            <motion.p
              initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
              className="mt-2 px-1 text-right text-[11px] text-stone-500 dark:text-stone-500"
            >
              <kbd className="rounded border border-stone-300 px-1 py-0.5 font-sans dark:border-stone-600">Enter</kbd> to send ·{" "}
              <kbd className="rounded border border-stone-300 px-1 py-0.5 font-sans dark:border-stone-600">Shift+Enter</kbd> for new line
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}