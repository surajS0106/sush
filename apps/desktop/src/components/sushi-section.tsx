// Settings → Sushi: pick which character stands on the composer. A little
// stage at the top runs the real mascot on a pretend composer, so typing,
// "working" and clicking can be tried before going back to a chat.

import { PlayIcon, SquareIcon } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";

import { Mascot, MascotSprite } from "@/components/mascot";
import { Group, Page } from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import { AVATARS } from "@/lib/avatars";
import { MASCOTS, setMascot, useMascot } from "@/lib/mascot";
import { cn } from "@/lib/utils";

/** The tile color behind each character: the avatar's own, salmon pink for Sushi. */
const tint = (key: string) => AVATARS.find((a) => a.key === key)?.background ?? "#ffe1d8";

export function SushiSection() {
  const current = useMascot();
  const label = MASCOTS.find((m) => m.key === current)?.label ?? "Sushi";

  return (
    <Page>
      <Group title="Sushi">
        <p className="pb-4 text-sm text-muted-foreground">
          Your little buddy on the composer. It watches you type, runs while Sush works and naps when you're away.
        </p>
        <Stage kind={current} label={label} />
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

function Stage({ kind, label }: { kind: string; label: string }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-muted/30 p-4">
      <div className="relative mt-12 rounded-xl border bg-background shadow-xs">
        <Mascot kind={kind} busy={busy} draft={draft} className="absolute right-10 bottom-full z-10 -mb-px" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Type something and ${label} will watch…`}
          aria-label="Try typing"
          className="h-11 w-full rounded-xl bg-transparent px-3.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        />
      </div>
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">Click to say hi. Three quick clicks for a backflip.</p>
        <Button variant="outline" size="sm" onClick={() => setBusy((b) => !b)} aria-pressed={busy}>
          {busy ? <SquareIcon /> : <PlayIcon />} {busy ? "Stop" : "Pretend to work"}
        </Button>
      </div>
    </div>
  );
}

function CharacterTile({
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
