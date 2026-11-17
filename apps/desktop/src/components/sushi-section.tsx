// Settings → Sushi: pick which character stands on the composer. A little
// stage at the top runs the real mascot on a pretend composer, so typing,
// each stage of a reply (thinking, tools, writing) and clicking can be tried
// before going back to a chat. "What should it do?" picks one activity at a
// time: work (a pretend reply), a coffee break, reading, dancing, a nap, a
// workout, juggling, meditating or a handheld game.

import {
  BookOpenIcon,
  CoffeeIcon,
  DumbbellIcon,
  FlowerIcon,
  Gamepad2Icon,
  LaptopIcon,
  MoonIcon,
  MusicIcon,
  OrbitIcon,
  SquareIcon,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

import { Mascot, MascotSprite, type MascotAct, type MascotStage } from "@/components/mascot";
import { Group, Page, Setting } from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { AVATARS } from "@/lib/avatars";
import { MASCOTS, setMascot, setMascotSounds, useMascot, useMascotSounds } from "@/lib/mascot";
import { cn } from "@/lib/utils";

/** The tile color behind each character: the avatar's own, salmon pink for Sushi. */
export const tint = (key: string) => AVATARS.find((a) => a.key === key)?.background ?? "#ffe1d8";

export function SushiSection() {
  const current = useMascot();
  const label = MASCOTS.find((m) => m.key === current)?.label ?? "Sushi";
  const sounds = useMascotSounds();

  return (
    <Page>
      <Group title="Sushi">
        <p className="pb-4 text-sm text-muted-foreground">
          Your little buddy on the composer. It watches you type, runs while Sush works and naps when you're away.
        </p>
        <Stage kind={current} label={label} />
        <Setting title="Sound effects" description={`Let ${label} make noise, like the thud when it falls over.`}>
          <Switch checked={sounds} onCheckedChange={setMascotSounds} aria-label="Sound effects" />
        </Setting>
      </Group>
      <Group title="Choose a character">
        <div role="radiogroup" aria-label="Mascot" className="grid grid-cols-4 gap-2 pt-2 md:grid-cols-5">
          {MASCOTS.map((m) => (
            <CharacterTile key={m.key} kind={m.key} label={m.label} selected={m.key === current} onPick={() => setMascot(m.key)} />
          ))}
        </div>
      </Group>
    </Page>
  );
}

const STAGES: MascotStage[] = ["thinking", "tools", "writing"];

/** What the character can be asked to do on the stage: work runs a pretend reply, the rest are its acts. */
type Activity = "work" | MascotAct;

const ACTIVITIES: { key: Activity; label: string; icon: LucideIcon }[] = [
  { key: "work", label: "Work", icon: LaptopIcon },
  { key: "coffee", label: "Coffee break", icon: CoffeeIcon },
  { key: "read", label: "Read", icon: BookOpenIcon },
  { key: "dance", label: "Dance", icon: MusicIcon },
  { key: "nap", label: "Nap", icon: MoonIcon },
  { key: "workout", label: "Work out", icon: DumbbellIcon },
  { key: "juggle", label: "Juggle", icon: OrbitIcon },
  { key: "meditate", label: "Meditate", icon: FlowerIcon },
  { key: "game", label: "Play a game", icon: Gamepad2Icon },
];

function Stage({ kind, label }: { kind: string; label: string }) {
  const [draft, setDraft] = useState("");
  const [activity, setActivity] = useState<Activity | null>(null);
  const busy = activity === "work";
  const [step, setStep] = useState(0);

  // A pretend reply moves through each stage in turn.
  useEffect(() => {
    if (!busy) return setStep(0);
    const id = setInterval(() => setStep((s) => s + 1), 3500);
    return () => clearInterval(id);
  }, [busy]);

  const current = ACTIVITIES.find((a) => a.key === activity);

  return (
    <div className="overflow-hidden rounded-xl border bg-muted/30">
      <div className="flex flex-col gap-3 p-4 pt-16">
        <div className="relative rounded-xl border bg-background shadow-xs">
          <Mascot
            kind={kind}
            busy={busy}
            act={activity && activity !== "work" ? activity : undefined}
            stage={STAGES[step % STAGES.length]}
            draft={draft}
            className="absolute right-16 bottom-full z-10 -mb-px"
          />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Type something and ${label} will watch…`}
            aria-label="Try typing"
            className="h-11 w-full rounded-xl bg-transparent px-3.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </div>
        <p className="text-xs text-muted-foreground">Click to say hi. Three quick clicks for a backflip. Keep going and see what happens.</p>
      </div>
      <div className="flex flex-col gap-3 border-t bg-background/70 p-3">
        <div className="flex h-7 items-center justify-between gap-3 px-1">
          <p className="text-sm font-medium">What should {label} do?</p>
          <AnimatePresence initial={false}>
            {current && (
              <motion.div
                key="stop"
                initial={{ opacity: 0, x: 6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 6 }}
                transition={{ duration: 0.15 }}
              >
                <Button variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={() => setActivity(null)}>
                  <SquareIcon className="size-3 fill-current" /> Stop
                </Button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div role="group" aria-label={`What should ${label} do?`} className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-1">
          {ACTIVITIES.map(({ key, label: name, icon: Icon }) => (
            <ActivityTile key={key} name={name} icon={Icon} on={activity === key} onToggle={() => setActivity(activity === key ? null : key)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ActivityTile({ name, icon: Icon, on, onToggle }: { name: string; icon: LucideIcon; on: boolean; onToggle: () => void }) {
  const reduceMotion = useReducedMotion();
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className={cn(
        "relative flex h-16 flex-col items-center justify-center gap-1.5 rounded-lg px-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
        on ? "font-medium text-brand" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {on && (
        // One highlight that slides from tile to tile.
        <motion.span
          layoutId="sushi-activity"
          className="absolute inset-0 rounded-lg bg-brand/10 ring-1 ring-brand/30"
          transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 38 }}
        />
      )}
      <motion.span
        className="relative"
        animate={on && !reduceMotion ? { y: [0, -2, 0] } : { y: 0 }}
        transition={on && !reduceMotion ? { duration: 0.9, repeat: Infinity, ease: "easeInOut" } : { duration: 0.15 }}
      >
        <Icon className="size-5" strokeWidth={1.75} />
      </motion.span>
      <span className="relative truncate">{name}</span>
    </button>
  );
}

export function CharacterTile({
  kind,
  label,
  selected,
  onPick,
}: {
  kind: string;
  label: string;
  selected: boolean;
  onPick: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const [hovered, setHovered] = useState(false);

  return (
    <motion.button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onPick}
      onHoverStart={() => setHovered(true)}
      onHoverEnd={() => setHovered(false)}
      whileHover={reduceMotion ? undefined : "hover"}
      whileTap={reduceMotion ? undefined : "tap"}
      className="group flex flex-col items-center gap-2 rounded-xl p-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span
        className={cn(
          "rounded-2xl p-0.5 ring-2 transition-shadow",
          selected ? "ring-brand" : "ring-transparent group-hover:ring-foreground/15",
        )}
      >
        <span className="flex h-16 w-20 items-end justify-center overflow-hidden rounded-[14px] pb-2" style={{ background: tint(kind) }}>
          <motion.span
            className="block"
            style={{ transformOrigin: "50% 100%" }}
            variants={{
              hover: { y: [0, -6, 0], scaleY: [1, 1.08, 1], transition: { duration: 0.4, ease: "easeOut" } },
              tap: { scaleY: 0.85, scaleX: 1.12, transition: { duration: 0.08 } },
            }}
            // The picked one breathes, like it does on the composer.
            animate={selected && !reduceMotion ? { scaleY: [1, 1.04, 1] } : { scaleY: 1 }}
            transition={selected && !reduceMotion ? { duration: 2.8, repeat: Infinity, ease: "easeInOut" } : { duration: 0.2 }}
          >
            {/* A happy squint on hover. */}
            <MascotSprite kind={kind} closed={hovered && !reduceMotion} />
          </motion.span>
        </span>
      </span>
      <span className={cn("text-center text-xs", selected ? "font-medium text-foreground" : "text-muted-foreground group-hover:text-foreground")}>
        {label}
      </span>
    </motion.button>
  );
}
