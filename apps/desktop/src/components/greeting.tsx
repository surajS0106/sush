import { useState } from "react";
import { MoonStarIcon, SunIcon, SunriseIcon, SunsetIcon, type LucideIcon } from "lucide-react";

type Part = { label: string; icon: LucideIcon; title: string; lines: string[] };

function partOfDay(hour: number): Part {
  if (hour < 5)
    return {
      label: "Late night",
      icon: MoonStarIcon,
      title: "Burning the midnight oil",
      lines: ["Let’s think it through.", "What’s keeping you up?", "Quiet hours, clear thinking."],
    };
  if (hour < 12)
    return {
      label: "Morning",
      icon: SunriseIcon,
      title: "Good morning",
      lines: ["What’s on your mind?", "What are we starting today?", "Fresh day, fresh ideas."],
    };
  if (hour < 17)
    return {
      label: "Afternoon",
      icon: SunIcon,
      title: "Good afternoon",
      lines: ["What’s on your mind?", "What can we get done?", "Pick up where you left off, or start something new."],
    };
  if (hour < 22)
    return {
      label: "Evening",
      icon: SunsetIcon,
      title: "Good evening",
      lines: ["What’s on your mind?", "Winding down or just getting going?", "Let’s wrap something up."],
    };
  return {
    label: "Late night",
    icon: MoonStarIcon,
    title: "Late night",
    lines: ["Let’s think it through.", "One more idea before bed?", "Quiet hours, clear thinking."],
  };
}

/** The new chat's hero: the date and time of day, a greeting with the user's name in the
 *  logo's colors, and a line under it picked for the time of day. */
export function Greeting({ name }: { name?: string }) {
  // Picked once per mount: the composer's placeholder already cycles, so this line holds still.
  const [{ part, line, date }] = useState(() => {
    const now = new Date();
    const part = partOfDay(now.getHours());
    return {
      part,
      line: part.lines[Math.floor(Math.random() * part.lines.length)],
      date: now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }),
    };
  });
  const Icon = part.icon;

  return (
    <div className="mb-7 flex flex-col items-center text-center">
      <div className="mb-4 inline-flex items-center gap-1.5 rounded-full border bg-background/60 px-3 py-1 text-xs text-muted-foreground backdrop-blur motion-safe:animate-[fade-up_0.4s_ease-out_both]">
        <Icon className="size-3.5 text-(--coral)" />
        <span>{date}</span>
        <span aria-hidden className="text-border">•</span>
        <span>{part.label}</span>
      </div>
      <h1 className="flex items-center justify-center gap-3 text-[30px] leading-tight font-medium tracking-tight motion-safe:animate-[fade-up_0.45s_ease-out_0.05s_both]">
        <img src="/sush-mark.png" alt="" className="size-8 shrink-0" />
        <span>
          {part.title}
          {name && (
            <>
              ,{" "}
              <span className="bg-linear-to-r from-(--sush) to-(--coral) bg-clip-text text-transparent">{name}</span>
            </>
          )}
        </span>
      </h1>
      <p className="mt-2 text-base text-balance text-muted-foreground motion-safe:animate-[fade-up_0.5s_ease-out_0.12s_both]">
        {line}
      </p>
    </div>
  );
}
