// Voice mode, inside the chat. Starting it swaps the composer for the voice
// dock: the voice's glass orb (or Sushi, `voice-sushi.tsx`) floating above a bar with the status, mute and
// end. What's said appears in the chat as it happens (`VoiceLines`, after the
// thread's messages), the answer's words as they're heard. When the call ends
// its turns become the chat's own messages, and the chat carries on from them.

import { MicIcon, MicOffIcon, Settings2Icon, XIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { Message, MessageContent } from "@/components/ai-elements/message";
import { GlassOrb } from "@/components/glass-orb";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VoiceSushi } from "@/components/voice-sushi";
import { openSettings } from "@/lib/library";
import { threadMessages } from "@/lib/sessions";
import type { ModelTarget } from "@/lib/transport";
import { cn } from "@/lib/utils";
import {
  activeProvider,
  closeVoice,
  gateFor,
  modelFor,
  providerInfo,
  useVoiceCatalog,
  useVoiceKeys,
  useVoiceModeSettings,
  voiceFor,
} from "@/lib/voice-mode";
import { VoiceConversation, type Line, type VoiceStatus } from "@/lib/voice-session";

const EASE_OUT = [0.16, 1, 0.3, 1] as const;

const STATUS_LABEL: Record<VoiceStatus, string> = {
  connecting: "Connecting…",
  listening: "Listening",
  hearing: "Listening…",
  thinking: "Thinking…",
  speaking: "Talk to interrupt",
  error: "Call ended",
};

// The call in progress, shared by the dock (which owns it) and the chat's live lines.
let live: { threadId: string; conversation: VoiceConversation } | null = null;
const listeners = new Set<() => void>();
const setLive = (next: typeof live) => {
  live = next;
  listeners.forEach((l) => l());
};
const subscribeLive = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const useLiveCall = (threadId: string) => useSyncExternalStore(subscribeLive, () => (live?.threadId === threadId ? live.conversation : null));

const openVoiceSettings = () => {
  closeVoice();
  openSettings({ section: "voice" });
};

/** In place of the composer while a call is on: the orb, and the bar under it. */
export function VoiceDock({ conversationId, target }: { conversationId: string; target: ModelTarget | null }) {
  const keys = useVoiceKeys();
  const settings = useVoiceModeSettings();
  const provider = activeProvider(settings, keys);
  const [attempt, setAttempt] = useState(0);
  const [conversation, setConversation] = useState<VoiceConversation | null>(null);

  // Start the call once the settings are known; a change of provider or voice, or "Try again", starts a new one.
  const model = provider ? modelFor(settings, provider) : "";
  const voice = provider ? voiceFor(settings, provider) : "";
  const brain = provider === "elevenlabs" || (provider === "sarvam" && settings.sarvamBrain === "chat") ? target : null;
  const whispers = settings.whispers !== false;
  const gate = gateFor(settings);
  useEffect(() => {
    if (!provider) return;
    const conv = new VoiceConversation({
      threadId: conversationId,
      provider,
      model,
      voice,
      personality: settings.personality,
      history: threadMessages(conversationId),
      brain,
      whispers,
      gate,
    });
    setConversation(conv);
    setLive({ threadId: conversationId, conversation: conv });
    void conv.start();
    return () => {
      // Clear the live lines in the same update that saves them as messages.
      if (live?.conversation === conv) setLive(null);
      conv.end();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the call keeps the settings it started with
  }, [provider, model, voice, whispers, gate, conversationId, attempt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeVoice();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE_OUT }}
      className="flex flex-col items-center"
    >
      {keys === null ? null : !provider ? (
        <NoKey />
      ) : conversation ? (
        <Call
          conversation={conversation}
          provider={provider}
          voiceId={voice}
          sushi={settings.figure === "sushi"}
          onRetry={() => setAttempt((a) => a + 1)}
        />
      ) : null}
    </motion.div>
  );
}

function NoKey() {
  return (
    <div className="flex w-full items-center gap-3 rounded-[28px] border bg-background/80 py-2 pr-2 pl-5 shadow-sm backdrop-blur-md dark:bg-white/[0.04]">
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">Voice mode runs on your own OpenAI, xAI, Sarvam or ElevenLabs key.</p>
      <Button variant="ghost" onClick={closeVoice}>
        Not now
      </Button>
      <Button onClick={openVoiceSettings}>Add a key</Button>
    </div>
  );
}

function Call({
  conversation,
  provider,
  voiceId,
  sushi,
  onRetry,
}: {
  conversation: VoiceConversation;
  provider: NonNullable<ReturnType<typeof activeProvider>>;
  voiceId: string;
  sushi: boolean;
  onRetry: () => void;
}) {
  const state = useSyncExternalStore(conversation.subscribe, () => conversation.state);
  const catalog = useVoiceCatalog(provider);
  const voiceName = catalog?.voices.find((v) => v.id === voiceId)?.name ?? voiceId;
  const failed = state.status === "error";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable=true]")) return;
      if (e.key.toLowerCase() === "m" && !e.metaKey && !e.ctrlKey) conversation.setMuted(!conversation.state.muted);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conversation]);

  const status = state.muted && !failed ? "Muted" : STATUS_LABEL[state.status];

  return (
    <>
      <div className="relative flex w-full justify-center">
        {!failed && <Notice message={state.error} />}
        {sushi ? (
          <VoiceSushi conversation={conversation} seed={voiceId} status={state.status} muted={state.muted} />
        ) : (
          <Orb conversation={conversation} seed={voiceId} status={state.status} muted={state.muted} />
        )}
      </div>
      <div className="mt-6 flex h-14 w-full items-center gap-2 rounded-[28px] border bg-background/80 pr-2 pl-5 shadow-sm backdrop-blur-md dark:bg-white/[0.04]">
        <div className="flex min-w-0 flex-1 items-baseline gap-2 text-sm">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={failed ? state.error : status}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.16 }}
              aria-live="polite"
              className={cn("truncate", failed ? "text-destructive" : "text-foreground/80")}
            >
              {failed ? state.error : status}
            </motion.span>
          </AnimatePresence>
          {!failed && (
            <span className="shrink-0 truncate text-xs text-muted-foreground">
              {providerInfo(provider).name} · {voiceName}
            </span>
          )}
        </div>
        {failed ? (
          <Button size="sm" className="rounded-full" onClick={onRetry}>
            Try again
          </Button>
        ) : (
          <IconButton label={state.muted ? "Unmute" : "Mute"} keyHint="M" pressed={state.muted} onClick={() => conversation.setMuted(!state.muted)}>
            {state.muted ? <MicOffIcon className="size-[18px]" /> : <MicIcon className="size-[18px]" />}
          </IconButton>
        )}
        <IconButton label="Voice settings" onClick={openVoiceSettings}>
          <Settings2Icon className="size-[18px]" />
        </IconButton>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="End voice conversation"
              onClick={closeVoice}
              className="flex size-10 items-center justify-center rounded-full bg-destructive text-white transition-[filter] hover:brightness-110"
            >
              <XIcon className="size-[18px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            End <span className="ml-1 text-muted-foreground">Esc</span>
          </TooltipContent>
        </Tooltip>
      </div>
    </>
  );
}

/** A mid-call problem that doesn't end the call: shown quietly above the orb, then gone. */
function Notice({ message }: { message: string | null }) {
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    setShown(message);
    if (!message) return;
    const timer = setTimeout(() => setShown(null), 6000);
    return () => clearTimeout(timer);
  }, [message]);
  return (
    <div aria-live="polite" className="pointer-events-none absolute inset-x-0 -top-10 flex justify-center">
      <AnimatePresence>
        {shown && (
          <motion.p
            key={shown}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className="flex max-w-md items-center gap-2 rounded-full bg-foreground/[0.06] px-3.5 py-1.5 text-xs text-muted-foreground backdrop-blur-md dark:bg-white/10"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
            {shown}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

function IconButton({
  label,
  keyHint,
  pressed,
  onClick,
  children,
}: {
  label: string;
  keyHint?: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
          className={cn(
            "flex size-10 items-center justify-center rounded-full transition-colors",
            pressed ? "bg-foreground text-background" : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground dark:hover:bg-white/10",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {keyHint && <span className="ml-1 text-muted-foreground">{keyHint}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The voice's glass orb, floating above the bar. It swells with the voice being
 * heard (the user's while listening, the answer's while speaking), and its
 * colour turns fast while thinking. Scaled from refs every frame, so loudness
 * never re-renders React. Tapping it cuts the answer short.
 */
function Orb({ conversation, seed, status, muted }: { conversation: VoiceConversation; seed: string; status: VoiceStatus; muted: boolean }) {
  const reduce = useReducedMotion();
  const scale = useRef<HTMLSpanElement>(null);
  const state = useRef({ status, muted });
  state.current = { status, muted };

  useEffect(() => {
    let frame = 0;
    let level = 0;
    const draw = () => {
      const { status, muted } = state.current;
      const { input, output } = conversation.levels();
      const target = status === "speaking" ? output : muted ? 0 : input;
      level += (target - level) * 0.25;
      const s = reduce ? 1 : 1 + level * (status === "speaking" ? 0.18 : 0.1);
      if (scale.current) scale.current.style.transform = `scale(${s.toFixed(4)})`;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [conversation, reduce]);

  const busy = status === "thinking" || status === "connecting";
  return (
    <button
      type="button"
      aria-label={status === "speaking" || status === "thinking" ? "Interrupt" : "Voice orb"}
      onClick={() => conversation.interrupt()}
      className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-4 focus-visible:ring-offset-background"
    >
      <GlassOrb seed={seed} size={88} float reflection spin={busy ? "fast" : "slow"} dim={muted || status === "error"} scaleRef={scale} />
    </button>
  );
}

/** Re-render about ten times a second while an answer plays, so its words keep pace with the voice. */
function useTicking(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(timer);
  }, [active]);
}

/**
 * The call so far, in the chat after its messages: the user's words as they
 * come, the answer's as they're heard. Styled like the chat's own messages,
 * which they become when the call ends.
 */
export function VoiceLines({ threadId }: { threadId: string }) {
  const conversation = useLiveCall(threadId);
  if (!conversation) return null;
  return <Lines conversation={conversation} />;
}

function Lines({ conversation }: { conversation: VoiceConversation }) {
  const state = useSyncExternalStore(conversation.subscribe, () => conversation.state);
  useTicking(state.status === "speaking");
  const shown = state.lines.map((l) => ({ ...l, text: conversation.visibleText(l) })).filter((l) => l.text.trim() || !l.final);
  // While the user talks and their words have no bubble yet, one shows they're being heard.
  const waiting = state.status === "hearing" && shown.at(-1)?.role !== "user";
  return (
    <>
      {shown.map((l) => (
        <VoiceLine key={l.id} line={l} />
      ))}
      {waiting && <VoiceLine line={{ id: "hearing", role: "user", text: "", final: false }} />}
    </>
  );
}

function VoiceLine({ line }: { line: Line }) {
  const text = line.text.trim();
  return (
    <Message from={line.role}>
      <MessageContent>
        {text ? (
          <p className="whitespace-pre-wrap">
            {text}
            {line.cut && <span className="ml-1 text-xs text-muted-foreground">(interrupted)</span>}
          </p>
        ) : (
          <Dots />
        )}
      </MessageContent>
    </Message>
  );
}

/** Words on their way. */
function Dots() {
  return (
    <span role="status" aria-label="Listening" className="inline-flex items-center gap-1 py-1.5 align-middle">
      {[0, 1, 2].map((i) => (
        <span key={i} className="size-1.5 rounded-full bg-muted-foreground/60 motion-safe:animate-pulse" style={{ animationDelay: `${i * 160}ms` }} />
      ))}
    </span>
  );
}
