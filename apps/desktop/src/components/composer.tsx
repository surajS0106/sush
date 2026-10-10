import type { ChatStatus } from "ai";
import { ArrowUpIcon, FileIcon, FolderIcon, MicIcon, SquareIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputController,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { ComposerMenu } from "@/components/composer-menu";
import { ModelPicker } from "@/components/model-picker";
import { hasLeadingCommand, SLASH_MENU_ID, SlashHighlight, SlashMenu, useSlashMenu } from "@/components/slash-menu";
import { InputGroupAddon } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDictation } from "@/hooks/use-dictation";
import type { ProviderModels } from "@/hooks/use-providers";
import { FOLDER_MEDIA_TYPE, type ModelTarget, type SushUIMessage } from "@/lib/transport";
import { cn } from "@/lib/utils";

const PLACEHOLDERS = [
  "How can I help you today?",
  "Summarize this document…",
  "Draft a follow-up email…",
  "Explain this error message…",
  "Brainstorm names for a project…",
];

// Two soft brand-tinted pools blurred behind the input; tracks --brand in both themes.
const GLOW =
  "radial-gradient(circle at 50% 35%, color-mix(in oklch, var(--brand) 40%, transparent), transparent 62%), radial-gradient(circle at 50% 75%, color-mix(in oklch, var(--brand) 28%, transparent), transparent 65%)";

const EASE_OUT = [0.16, 1, 0.3, 1] as const;

// Shared by the textarea and its slash-command highlight layer, which must lay out text identically.
// `text-base md:text-sm` and `pb-2` repeat what the textarea inherits from Textarea / InputGroupTextarea.
const TEXT_BOX = cn("px-4 pt-3.5 pb-2 text-base md:text-sm", "text-[15px]");

interface ComposerProps {
  catalog: ProviderModels[];
  target: ModelTarget | null;
  onPickModel: (target: ModelTarget) => void;
  status: ChatStatus;
  onSubmit: (msg: PromptInputMessage) => void;
  onStop: () => void;
  onOpenSettings: () => void;
  /** Whether the current model can use Research (Claude only). */
  researchAvailable: boolean;
  /** The conversation so far, for "Record a skill". */
  messages: SushUIMessage[];
}

export function Composer({
  catalog,
  target,
  onPickModel,
  status,
  onSubmit,
  onStop,
  onOpenSettings,
  researchAvailable,
  messages,
}: ComposerProps) {
  const { attachments, textInput } = usePromptInputController();
  const reduceMotion = useReducedMotion();
  const busy = status === "submitted" || status === "streaming";
  const empty = textInput.value.length === 0;
  const canSend = !!target && (textInput.value.trim().length > 0 || attachments.files.length > 0);
  const [promptIndex, setPromptIndex] = useState(0);
  const speechProviders = useMemo(() => catalog.map((c) => c.provider), [catalog]);
  const dictation = useDictation(textInput.value, textInput.setInput, speechProviders);
  const listening = dictation.status === "recording";
  const dictating = dictation.status !== "idle";
  const slash = useSlashMenu(textInput.value, textInput.setInput);
  const highlighted = hasLeadingCommand(textInput.value);
  const highlightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "u") {
        e.preventDefault();
        attachments.openFileDialog();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "Space") {
        e.preventDefault();
        dictation.toggle();
      } else if (e.key === "Escape" && listening) {
        e.preventDefault();
        dictation.cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [attachments, dictation.toggle, dictation.cancel, listening]);

  // Sending mid-recording discards the recording rather than dictating into the next message.
  const submit = (msg: PromptInputMessage) => {
    dictation.cancel();
    onSubmit(msg);
  };

  // Cycle the placeholder only while the box is empty and idle.
  useEffect(() => {
    if (!empty || busy || dictating) return;
    const id = setInterval(() => setPromptIndex((i) => (i + 1) % PLACEHOLDERS.length), 3200);
    return () => clearInterval(id);
  }, [empty, busy]);

  return (
    <div className="group/composer relative isolate flex flex-col gap-2">
      {slash.open && (
        <SlashMenu commands={slash.commands} active={slash.active} onHover={slash.setActive} onPick={slash.pick} />
      )}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute -inset-6 -z-10 rounded-2xl opacity-40 blur-3xl transform-gpu"
        style={{ background: GLOW }}
        animate={reduceMotion ? undefined : { x: [0, 6, -6, 0], y: [0, -6, 4, 0] }}
        transition={{ duration: 10, repeat: Infinity, ease: "easeInOut" }}
      />
      <PromptInput
        onSubmit={submit}
        multiple
        globalDrop
        className="[&_[data-slot=input-group]]:rounded-2xl [&_[data-slot=input-group]]:bg-background [&_[data-slot=input-group]]:shadow-[0_25px_60px_-25px_color-mix(in_oklch,var(--brand)_35%,transparent)] dark:[&_[data-slot=input-group]]:bg-card dark:[&_[data-slot=input-group]]:shadow-[0_25px_60px_-20px_rgb(0_0_0/0.7)]"
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-white/60 to-transparent dark:via-white/25"
        />
        {attachments.files.length > 0 && (
          <InputGroupAddon align="block-start" className="flex-wrap gap-2 px-4 pt-3.5">
            <AnimatePresence initial={false}>
              {attachments.files.map((f) => (
                <motion.div
                  key={f.id}
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
                  transition={{ duration: 0.18, ease: EASE_OUT }}
                  className={cn(
                    "group/att relative overflow-hidden rounded-xl border",
                    f.mediaType.startsWith("image/") ? "size-14" : "flex h-14 max-w-56 items-center gap-2 px-3",
                  )}
                >
                  {f.mediaType.startsWith("image/") ? (
                    <img src={f.url} alt={f.filename ?? "attachment"} className="size-full object-cover" />
                  ) : (
                    <>
                      {f.mediaType === FOLDER_MEDIA_TYPE ? (
                        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate text-sm">{f.filename ?? "attachment"}</span>
                    </>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${f.filename ?? "attachment"}`}
                    onClick={() => attachments.remove(f.id)}
                    className="absolute top-0.5 right-0.5 rounded-full bg-background/90 p-0.5 opacity-0 shadow-xs group-hover/att:opacity-100 focus-visible:opacity-100"
                  >
                    <XIcon className="size-3" />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </InputGroupAddon>
        )}
        <PromptInputBody>
          <div className="relative w-full">
            <SlashHighlight value={textInput.value} className={TEXT_BOX} scrollRef={highlightRef} />
            <PromptInputTextarea
              placeholder=""
              aria-label="Message"
              onScroll={(e) => {
                if (highlightRef.current) highlightRef.current.scrollTop = e.currentTarget.scrollTop;
              }}
              onKeyDown={slash.onKeyDown}
              aria-expanded={slash.open}
              aria-controls={slash.open ? SLASH_MENU_ID : undefined}
              aria-activedescendant={slash.activeId}
              className={cn("relative min-h-14", TEXT_BOX, highlighted && "text-transparent caret-foreground")}
            />
            {empty && (
              <div aria-hidden className="pointer-events-none absolute inset-x-4 top-3.5 overflow-hidden">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={dictating ? dictation.status : promptIndex}
                    initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
                    transition={{ duration: 0.35, ease: EASE_OUT }}
                    className="block truncate text-[15px] text-muted-foreground"
                  >
                    {listening ? "Listening… press Esc to cancel" : dictating ? "Transcribing…" : PLACEHOLDERS[promptIndex]}
                  </motion.span>
                </AnimatePresence>
              </div>
            )}
          </div>
        </PromptInputBody>
        <PromptInputFooter className="mt-2 border-t border-foreground/5 bg-foreground/[0.015] px-3 py-2.5 dark:border-white/10 dark:bg-white/[0.02]">
          <ComposerMenu
            target={target}
            messages={messages}
            researchAvailable={researchAvailable}
            onOpenSettings={onOpenSettings}
            onSend={(text) => submit({ text, files: [] })}
          />
          <div className="flex items-center gap-1.5">
            <div className="[&_button]:h-7 [&_button]:rounded-full [&_button]:border [&_button]:border-foreground/10 [&_button]:bg-foreground/[0.02] [&_button]:px-2.5 [&_button]:text-xs [&_button]:font-medium dark:[&_button]:border-white/10 dark:[&_button]:bg-white/5">
              <ModelPicker catalog={catalog} value={target} onChange={onPickModel} />
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={listening ? "Stop and transcribe" : "Dictate"}
                  aria-pressed={listening}
                  disabled={dictation.status === "transcribing"}
                  onClick={dictation.toggle}
                  className={cn(
                    "relative flex size-8 items-center justify-center rounded-full transition-colors",
                    dictating
                      ? "bg-brand/15 text-brand"
                      : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground dark:hover:bg-white/10",
                  )}
                >
                  {listening && !reduceMotion && (
                    <motion.span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 rounded-full border border-brand/60"
                      animate={{ scale: [1, 1.35], opacity: [0.6, 0] }}
                      transition={{ duration: 1.1, repeat: Infinity, ease: "easeOut" }}
                    />
                  )}
                  {dictation.status === "transcribing" ? <Spinner /> : <MicIcon className="size-4" />}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {listening ? "Stop and transcribe" : "Dictate"} <span className="ml-1 text-muted-foreground">Ctrl+Shift+Space</span>
              </TooltipContent>
            </Tooltip>
            <div className="relative">
              {busy && !reduceMotion && (
                <motion.span
                  aria-hidden
                  className="pointer-events-none absolute -inset-1 rounded-full border border-brand/60"
                  animate={{ scale: [1, 1.35], opacity: [0.6, 0] }}
                  transition={{ duration: 1.1, repeat: Infinity, ease: "easeOut" }}
                />
              )}
              <PromptInputSubmit
                status={status}
                onStop={onStop}
                disabled={!busy && !canSend}
                className={
                  busy || canSend
                    ? "rounded-full bg-linear-to-br from-brand via-brand/85 to-brand text-brand-foreground shadow-[0_4px_18px_-4px_color-mix(in_oklch,var(--brand)_65%,transparent)] hover:bg-brand/90"
                    : "rounded-full bg-foreground/5 text-muted-foreground disabled:opacity-100 dark:bg-white/10"
                }
              >
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={busy ? status : "idle"}
                    initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6, rotate: -45 }}
                    animate={{ opacity: 1, scale: 1, rotate: 0 }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6, rotate: 45 }}
                    transition={{ duration: 0.18, ease: EASE_OUT }}
                    className="flex items-center justify-center"
                  >
                    {status === "submitted" ? (
                      <Spinner />
                    ) : status === "streaming" ? (
                      <SquareIcon className="size-3 fill-current" />
                    ) : (
                      <ArrowUpIcon className="size-4" />
                    )}
                  </motion.span>
                </AnimatePresence>
              </PromptInputSubmit>
            </div>
          </div>
        </PromptInputFooter>
      </PromptInput>
      <p className="px-1 text-right text-[11px] text-muted-foreground opacity-0 transition-opacity duration-200 group-focus-within/composer:opacity-100">
        <kbd className="rounded border px-1 py-0.5 font-sans">Enter</kbd> to send ·{" "}
        <kbd className="rounded border px-1 py-0.5 font-sans">Shift+Enter</kbd> for new line ·{" "}
        <kbd className="rounded border px-1 py-0.5 font-sans">/</kbd> for skills ·{" "}
        <kbd className="rounded border px-1 py-0.5 font-sans">Ctrl+Shift+Space</kbd> to dictate
      </p>
    </div>
  );
}
