// Who drives a shared session, above the composer, and the hand-off around it:
// "Suraj is driving / You're driving", asking for control, answering those
// who ask, passing control on or giving it back, and the owner's "Step away"
// (the share's away policy then applies, see `lib/share.ts`). Shown only
// while a share is live and has someone besides the owner in it.

import { ChevronDownIcon, CoffeeIcon, HandIcon, NavigationIcon, UndoIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { UserAvatar } from "@/components/user-avatar";
import { answerControl, driverOf, passControl, releaseControl, requestControl, safeImage, stepAway, takeControl } from "@/lib/share";
import type { ShareView } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const minutesSince = (at: number) => Math.max(0, Math.round((Date.now() - at) / 60_000));

export function ControlBanner({ share }: { share: ShareView }) {
  const [busy, setBusy] = useState(false);
  const guests = share.members.filter((m) => m.role !== "owner");
  if (share.status !== "live" || guests.length === 0) return null;

  const owner = share.role === "owner";
  const host = share.thread.hostName;
  const driver = driverOf(share);
  const me = share.me;
  const mine = !!driver && driver.userId === me;
  const holds = owner || mine;
  const asked = share.requests.some((r) => r.userId === me);
  const away = share.ownerAway;
  const others = guests.filter((m) => m.userId !== me && m.userId !== driver?.userId);
  const run = (work: () => Promise<unknown>) => {
    setBusy(true);
    void work().finally(() => setBusy(false));
  };

  const who = mine ? "You’re driving" : driver ? `${driver.name} is driving` : owner ? "You’re driving" : `${host} is driving`;
  const awayNote = away
    ? owner
      ? share.policy.away.mode === "pause" || !driver
        ? "You stepped away: the agent pauses once it finishes what it’s doing."
        : `You stepped away: ${driver.name} carries on for up to ${share.policy.away.minutes} minutes.`
      : `${host} stepped away ${minutesSince(away) || "just now"}${minutesSince(away) ? " min ago" : ""}.`
    : null;

  return (
    <div className="mb-2 flex flex-col gap-1.5 rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-2 text-sm dark:border-white/10">
      <div className="flex flex-wrap items-center gap-2 px-1.5">
        {driver ? (
          <UserAvatar image={safeImage(driver.image)} name={driver.name} className="size-5 text-[10px]" />
        ) : (
          <NavigationIcon className={cn("size-4", (owner || mine) && "text-brand")} />
        )}
        <span className={cn("font-medium", mine && "text-brand")}>{who}</span>
        {awayNote && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <CoffeeIcon className="size-3.5" /> {awayNote}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {holds && others.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="h-7 rounded-full text-xs" disabled={busy}>
                  Pass control <ChevronDownIcon className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Hand control to</DropdownMenuLabel>
                {others.map((m) => (
                  <DropdownMenuItem key={m.userId} onSelect={() => run(() => passControl(share, m.userId))}>
                    <UserAvatar image={safeImage(m.image)} name={m.name} className="size-5 text-[10px]" />
                    {m.name}
                    {!m.online && <span className="text-muted-foreground">· away</span>}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {mine && (
            <Button size="sm" variant="ghost" className="h-7 rounded-full text-xs" disabled={busy} onClick={() => run(() => releaseControl(share))}>
              <UndoIcon className="size-3.5" /> Give back to {host}
            </Button>
          )}
          {owner && driver && (
            <Button size="sm" variant="outline" className="h-7 rounded-full text-xs" disabled={busy} onClick={() => run(() => takeControl(share.threadId))}>
              <NavigationIcon className="size-3.5" /> Take control
            </Button>
          )}
          {!owner && !mine && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 rounded-full text-xs"
              disabled={busy || asked || (!!away && share.policy.away.mode === "pause")}
              onClick={() => run(() => requestControl(share))}
            >
              <HandIcon className="size-3.5" /> {asked ? "Asked to drive" : "Ask to drive"}
            </Button>
          )}
          {owner && (
            <Button
              size="sm"
              variant={away ? "default" : "ghost"}
              className="h-7 rounded-full text-xs"
              disabled={busy}
              onClick={() => run(() => stepAway(share.threadId, !away))}
            >
              <CoffeeIcon className="size-3.5" /> {away ? "I’m back" : "Step away"}
            </Button>
          )}
        </span>
      </div>
      {holds &&
        share.requests
          .filter((r) => r.userId !== me)
          .map((r) => {
            const member = share.members.find((m) => m.userId === r.userId);
            return (
              <div key={r.userId} className="flex items-center gap-2 rounded-xl bg-background px-2 py-1.5 dark:bg-card">
                <UserAvatar image={safeImage(member?.image)} name={r.name} className="size-5 text-[10px]" />
                <span className="flex-1 truncate">{r.name} asks to drive</span>
                <Button size="sm" variant="ghost" className="h-7 rounded-full text-xs" disabled={busy} onClick={() => run(() => answerControl(share, r.userId, false))}>
                  Not now
                </Button>
                <Button size="sm" className="h-7 rounded-full text-xs" disabled={busy} onClick={() => run(() => answerControl(share, r.userId, true))}>
                  Let them drive
                </Button>
              </div>
            );
          })}
    </div>
  );
}
