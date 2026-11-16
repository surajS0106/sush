// The welcome tour: a few steps shown the first time someone opens Sush
// (lib/onboarding.ts decides when). It says hello, lets them pick a look and a
// character, explains Chat and Cowork and what's in the sidebar, then gets a
// model connected. Settings → General turns it back on or opens it again.

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  AtSignIcon,
  BookOpenIcon,
  CheckIcon,
  CodeXmlIcon,
  CpuIcon,
  KanbanIcon,
  KeyRoundIcon,
  LockIcon,
  MessagesSquareIcon,
  NotebookTextIcon,
  PlugIcon,
  ShieldIcon,
  SlashIcon,
  SparklesIcon,
  TimerIcon,
  UsersIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useTheme } from "next-themes";
import { useEffect, useState, type ReactNode } from "react";

import { Mascot } from "@/components/mascot";
import { AccentPicker, ThemePicker } from "@/components/settings-dialog";
import { CharacterTile, tint } from "@/components/sushi-section";
import { Button } from "@/components/ui/button";
import { IS_MAC } from "@/components/window-controls";
import { setAppearance, transitionTheme, useAppearance } from "@/lib/appearance";
import { useSession } from "@/lib/auth";
import { openSettings } from "@/lib/library";
import { MASCOTS, setMascot, useMascot } from "@/lib/mascot";
import { finishOnboarding, useOnboardingOpen } from "@/lib/onboarding";
import { cn, focusComposer } from "@/lib/utils";

const STEPS = ["welcome", "look", "modes", "tour", "model"] as const;
type Step = (typeof STEPS)[number];

/** How many characters the look step offers; the rest are in Settings → Sushi. */
const CHARACTERS_SHOWN = 10;

const MOD = IS_MAC ? "⌘" : "Ctrl";

export function Onboarding({ hasProviders }: { hasProviders: boolean | null }) {
  const open = useOnboardingOpen();
  const [index, setIndex] = useState(0);
  // Which way the steps slide: forward from the right, back from the left.
  const [direction, setDirection] = useState(1);
  const reduceMotion = useReducedMotion();
  const step: Step = STEPS[index];
  const last = index === STEPS.length - 1;

  // Each opening starts from the top.
  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);

  const go = (to: number) => {
    setDirection(to > index ? 1 : -1);
    setIndex(Math.max(0, Math.min(STEPS.length - 1, to)));
  };

  const done = () => {
    finishOnboarding();
    requestAnimationFrame(focusComposer);
  };
  const addProvider = () => {
    finishOnboarding();
    openSettings({ section: "providers" });
  };

  // ← and → walk the steps, unless a control that uses them has focus; Escape skips the tour.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape closing a menu or color picker (the accent's) shouldn't also end the tour.
      if (e.key === "Escape") {
        if (!e.defaultPrevented && !document.querySelector("[data-radix-popper-content-wrapper]")) done();
        return;
      }
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, [role=radiogroup], [role=menu]")) return;
      if (e.key === "ArrowRight" && !last) go(index + 1);
      else if (e.key === "ArrowLeft" && index > 0) go(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <AnimatePresence>
      {open && (
        // A page over the whole window, under the window controls (rendered after the app, same layer).
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="Welcome to Sush"
          className="fixed inset-0 z-50 flex flex-col bg-background"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
        >
          {/* A soft wash of the accent behind everything. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: "radial-gradient(1200px 500px at 50% -10%, color-mix(in oklab, var(--brand) 12%, transparent), transparent)" }}
          />
          {/* Doubles as the title bar, so the window can still be moved. */}
          <header
            data-tauri-drag-region
            className={cn("relative flex h-12 shrink-0 items-center px-4 select-none", IS_MAC ? "pl-24" : "pr-36")}
          >
            <span data-tauri-drag-region className="text-sm font-semibold tracking-tight">
              Sush
            </span>
          </header>

          <div className="relative min-h-0 flex-1 overflow-hidden">
            <AnimatePresence mode="wait" custom={direction} initial={false}>
              <motion.div
                key={step}
                custom={direction}
                className="absolute inset-0 overflow-y-auto"
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 32 * direction }}
                animate={{ opacity: 1, x: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -32 * direction }}
                transition={{ duration: 0.22, ease: "easeOut" }}
              >
                <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-center px-10 py-10">
                  {step === "welcome" && <WelcomeStep />}
                  {step === "look" && <LookStep />}
                  {step === "modes" && <ModesStep />}
                  {step === "tour" && <TourStep />}
                  {step === "model" && <ModelStep hasProviders={hasProviders} />}
                </div>
              </motion.div>
            </AnimatePresence>
          </div>

          <footer className="relative mx-auto flex w-full max-w-5xl items-center gap-3 border-t px-10 py-4">
          <div className="flex flex-1 items-center gap-1.5" aria-hidden>
            {STEPS.map((s, i) => (
              <button
                key={s}
                type="button"
                tabIndex={-1}
                onClick={() => go(i)}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  i === index ? "w-6 bg-brand" : "w-1.5 bg-foreground/15 hover:bg-foreground/30",
                )}
              />
            ))}
            <span className="ml-2 text-xs text-muted-foreground">
              {index + 1} of {STEPS.length}
            </span>
          </div>
          {!last && (
            <Button variant="ghost" size="sm" onClick={done}>
              Skip tour
            </Button>
          )}
          {index > 0 && (
            <Button variant="outline" size="sm" onClick={() => go(index - 1)}>
              <ArrowLeftIcon /> Back
            </Button>
          )}
          {!last ? (
            <Button size="sm" onClick={() => go(index + 1)} autoFocus>
              {index === 0 ? "Let's go" : "Next"} <ArrowRightIcon />
            </Button>
          ) : hasProviders === false ? (
            <>
              <Button variant="ghost" size="sm" onClick={done}>
                Later
              </Button>
              <Button size="sm" onClick={addProvider}>
                <KeyRoundIcon /> Add a provider
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={done}>
              Start using Sush <ArrowRightIcon />
            </Button>
          )}
          </footer>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function StepHeading({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="pb-6">
      <p className="pb-1 text-xs font-medium tracking-wide text-brand uppercase">{eyebrow}</p>
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      {children && <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">{children}</p>}
    </div>
  );
}

// --- steps -------------------------------------------------------------------------

function WelcomeStep() {
  const { data: session } = useSession();
  const first = session?.user.name?.trim().split(/\s+/)[0];
  return (
    <div className="flex flex-col items-center text-center">
      {/* The real mascot, standing on a pretend composer edge. */}
      <div className="relative mb-6 h-20 w-64">
        <Mascot busy={false} draft="" className="absolute bottom-0 left-1/2 -translate-x-1/2" />
        <div className="absolute inset-x-0 bottom-0 h-px bg-border" />
      </div>
      <h2 className="text-3xl font-semibold tracking-tight">Welcome to Sush{first ? `, ${first}` : ""}</h2>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Your AI workspace that lives on your computer. Chat with any model, let it work in your folders, and keep your
        data on your own machine.
      </p>
      <div className="mt-8 grid w-full max-w-2xl grid-cols-3 gap-3 text-left">
        <Highlight icon={CpuIcon} title="Any model">
          OpenAI, Anthropic, OpenRouter, or a local model through Ollama. Bring your own key.
        </Highlight>
        <Highlight icon={LockIcon} title="Private by default">
          Chats are stored on this computer. API keys go to your system keychain.
        </Highlight>
        <Highlight icon={SparklesIcon} title="Gets work done">
          Edits files, runs commands in a sandbox, searches the web and uses your apps.
        </Highlight>
      </div>
      <p className="mt-6 text-xs text-muted-foreground">Psst: click the little one above to say hi.</p>
    </div>
  );
}

function Highlight({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border bg-muted/30 p-4">
      <span className="mb-2 flex size-8 items-center justify-center rounded-lg bg-brand/10 text-brand">
        <Icon className="size-4" />
      </span>
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{children}</p>
    </div>
  );
}

function LookStep() {
  const { theme = "system", setTheme } = useTheme();
  const appearance = useAppearance();
  const mascot = useMascot();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-10">
      <div>
      <StepHeading eyebrow="Make it yours" title="Pick a look">
        You can change any of this later in Settings.
      </StepHeading>
      <div className="flex flex-wrap items-start gap-x-10 gap-y-6 pb-6">
        <div>
          <p className="pb-2 text-sm font-medium">Theme</p>
          <ThemePicker value={theme} onChange={(t) => transitionTheme(() => setTheme(t))} />
        </div>
        <div>
          <p className="pb-2 text-sm font-medium">Accent color</p>
          <AccentPicker
            value={appearance.accent}
            onChange={(accent) => setAppearance({ accent })}
            custom={appearance.customAccent}
            onCustomChange={(customAccent) => setAppearance({ customAccent })}
          />
        </div>
      </div>
      <p className="text-sm font-medium">Your buddy</p>
      <p className="pb-2 text-xs text-muted-foreground">
        It stands on the message box, watches you type and gets to work when Sush does. More in Settings → Sushi.
      </p>
      <div role="radiogroup" aria-label="Mascot" className="grid grid-cols-5 gap-1">
        {MASCOTS.slice(0, CHARACTERS_SHOWN).map((m) => (
          <CharacterTile key={m.key} kind={m.key} label={m.label} selected={m.key === mascot} onPick={() => setMascot(m.key)} />
        ))}
      </div>
      </div>
      <BuddyPreview kind={mascot} />
    </div>
  );
}

/** The picked character, live on a pretend message box; each new pick pops in. */
function BuddyPreview({ kind }: { kind: string }) {
  const reduceMotion = useReducedMotion();
  const label = MASCOTS.find((m) => m.key === kind)?.label ?? "Sushi";
  const [draft, setDraft] = useState("");
  return (
    <div className="sticky top-0 flex flex-col overflow-hidden rounded-2xl border shadow-xs">
      <motion.div
        className="relative flex h-64 items-end justify-center px-5 pb-5"
        animate={{ backgroundColor: tint(kind) }}
        transition={{ duration: 0.35, ease: "easeOut" }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.p
            key={kind}
            className="absolute top-5 inset-x-0 text-center text-sm font-semibold text-neutral-800"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            Hi, I'm {label}!
          </motion.p>
        </AnimatePresence>
        <div className="relative w-full rounded-xl border border-black/10 bg-white/90 shadow-sm">
          {/* Re-keyed on each pick, so the new character springs up out of the box. */}
          <motion.div
            key={kind}
            className="absolute right-8 bottom-full z-10 -mb-px"
            style={{ transformOrigin: "50% 100%" }}
            initial={reduceMotion ? false : { scale: 0.3, y: 16, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            transition={{ type: "spring", stiffness: 420, damping: 16 }}
          >
            <Mascot kind={kind} busy={false} draft={draft} />
          </motion.div>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Type to see it watch…"
            aria-label="Try typing"
            className="h-10 w-full rounded-xl bg-transparent px-3 text-sm text-neutral-800 outline-none placeholder:text-neutral-500"
          />
        </div>
      </motion.div>
      <p className="border-t bg-background px-4 py-3 text-xs text-muted-foreground">
        Click {label} to say hi. Three quick clicks for a backflip.
      </p>
    </div>
  );
}

function ModesStep() {
  return (
    <>
      <StepHeading eyebrow="Two ways to work" title="Chat, or Cowork in a folder">
        Switch between them with the Chat / Cowork toggle at the top of the sidebar. "New" starts the same kind as the
        session that's open.
      </StepHeading>
      <div className="grid grid-cols-2 gap-4">
        <ModeCard icon={MessagesSquareIcon} title="Chat" tagline="Ask, write, research, plan">
          <li>Answers with web search and citations</li>
          <li>Images, maps, weather, flights and more as cards</li>
          <li>Remembers what matters to you, if you let it</li>
          <li>Incognito chats that are never saved</li>
        </ModeCard>
        <ModeCard icon={CodeXmlIcon} title="Cowork" tagline="Hand it a folder and a task">
          <li>Reads and edits your files, shows every diff</li>
          <li>Runs commands in a sandbox, asking first</li>
          <li>Undo any turn, or any single file</li>
          <li>Built-in file viewer, terminal, browser and git graph</li>
        </ModeCard>
      </div>
    </>
  );
}

function ModeCard({ icon: Icon, title, tagline, children }: { icon: LucideIcon; title: string; tagline: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border bg-muted/30 p-5">
      <div className="flex items-center gap-3 pb-4">
        <span className="flex size-10 items-center justify-center rounded-xl bg-brand text-brand-foreground">
          <Icon className="size-5" />
        </span>
        <div>
          <p className="font-semibold">{title}</p>
          <p className="text-xs text-muted-foreground">{tagline}</p>
        </div>
      </div>
      <ul className="flex flex-col gap-2 text-sm [&>li]:flex [&>li]:gap-2 [&>li]:before:mt-2 [&>li]:before:size-1.5 [&>li]:before:shrink-0 [&>li]:before:rounded-full [&>li]:before:bg-brand [&>li]:before:content-['']">
        {children}
      </ul>
    </div>
  );
}

const FEATURES: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: PlugIcon, title: "Connectors", text: "Hook up GitHub, Linear, Notion and other MCP servers." },
  { icon: TimerIcon, title: "Automations", text: "Run a prompt on a schedule, like a morning brief." },
  { icon: WorkflowIcon, title: "Workflows", text: "Chain steps and tools into a flow you can rerun." },
  { icon: KanbanIcon, title: "Board", text: "Track tasks and start a session from any card." },
  { icon: NotebookTextIcon, title: "Notebooks", text: "Drop in sources and ask, summarize or listen." },
  { icon: ShieldIcon, title: "Security & Review", text: "Have a codebase reviewed for bugs and risks." },
  { icon: BookOpenIcon, title: "Wiki", text: "Generate a guide to any codebase, then ask it." },
  { icon: UsersIcon, title: "Shared sessions", text: "Let teammates watch and suggest, live." },
];

function TourStep() {
  return (
    <>
      <StepHeading eyebrow="In the sidebar" title="There's more where that came from" />
      <div className="grid grid-cols-4 gap-3">
        {FEATURES.map(({ icon: Icon, title, text }) => (
          <div key={title} className="rounded-xl border p-3.5">
            <Icon className="mb-2 size-4 text-brand" />
            <p className="text-sm font-medium">{title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{text}</p>
          </div>
        ))}
      </div>
      <p className="pt-7 pb-2 text-sm font-medium">Handy in the message box</p>
      <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
        <Tip keys={[<SlashIcon key="s" className="size-3" />]}>Run a skill, like /create-skill</Tip>
        <Tip keys={[<AtSignIcon key="a" className="size-3" />]}>Mention a connector or file to bring it in</Tip>
        <Tip keys={[MOD, "N"]}>New session in a tab</Tip>
        <Tip keys={[MOD, "W"]}>Close the tab</Tip>
        <Tip keys={["Ctrl", "Tab"]}>Next tab</Tip>
        <Tip keys={["Alt", "← →"]}>Back and forward</Tip>
      </div>
    </>
  );
}

function Tip({ keys, children }: { keys: ReactNode[]; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex w-20 shrink-0 gap-1">
        {keys.map((k, i) => (
          <kbd
            key={i}
            className="flex h-6 min-w-6 items-center justify-center rounded-md border bg-muted px-1.5 font-mono text-xs text-muted-foreground"
          >
            {k}
          </kbd>
        ))}
      </span>
      <span className="text-muted-foreground">{children}</span>
    </div>
  );
}

function ModelStep({ hasProviders }: { hasProviders: boolean | null }) {
  if (hasProviders !== false) {
    return (
      <div className="flex flex-col items-center text-center">
        <span className="mb-5 flex size-14 items-center justify-center rounded-full bg-brand/10 text-brand">
          <CheckIcon className="size-7" />
        </span>
        <h2 className="text-2xl font-semibold tracking-tight">You're all set</h2>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          A model is connected and ready. Pick one from the model menu in the message box, type what you need, and
          Sush takes it from there.
        </p>
        <p className="mt-6 text-xs text-muted-foreground">You can take this tour again from Settings → General.</p>
      </div>
    );
  }
  return (
    <>
      <StepHeading eyebrow="Last step" title="Connect a model">
        Sush talks to the model you choose. Add a provider with your API key, or point it at a model running on this
        computer. Keys stay in your system keychain.
      </StepHeading>
      <div className="grid grid-cols-2 gap-3">
        <ProviderOption title="OpenAI" text="GPT models with your OpenAI API key." />
        <ProviderOption title="Anthropic" text="Claude models with your Anthropic API key." />
        <ProviderOption title="OpenRouter, Groq, Azure…" text="Any endpoint that speaks the OpenAI or Anthropic format." />
        <ProviderOption title="Ollama" text="Run models locally for free, or use Ollama Cloud." />
      </div>
      <p className="pt-6 text-xs text-muted-foreground">
        "Add a provider" opens Settings → Providers. You can take this tour again from Settings → General.
      </p>
    </>
  );
}

function ProviderOption({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border p-4">
      <KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-brand" />
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}
