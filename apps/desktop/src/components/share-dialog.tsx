// "Share live…": let others watch a session as it runs, and redirect it.
// Setting up the relay account (also on Settings → Sharing and in the join
// dialog), starting the share, copying invite links (to watch, or to suggest
// too), letting people in from the lobby, giving each a role (one driver at a
// time), choosing which approvals the driver may answer, what happens when the
// owner steps away, removing people, revoking links, the activity log and
// ending the share. Hand-offs themselves are in `control-banner.tsx`. The work
// itself is `lib/share.ts`.

import { CheckIcon, CopyIcon, LinkIcon, LockIcon, LockOpenIcon, RadioIcon, ShieldCheckIcon, UserXIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Mascot } from "@/components/mascot";
import { ActivityLog } from "@/components/share-activity";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { UserAvatar } from "@/components/user-avatar";
import {
  admit,
  copyInvite,
  DEFAULT_RELAY,
  endShare,
  isLive,
  kick,
  listInvites,
  othersCanSteer,
  refreshShareAccount,
  revokeInvite,
  safeImage,
  setBrowseFiles,
  setAwayPolicy,
  setDelegation,
  setRole,
  shareWithAppAccount,
  signInToRelay,
  startShare,
  useShare,
  useShareAccount,
} from "@/lib/share";
import { getConversations } from "@/lib/store";
import { errorMessage, type InviteInfo, type ShareDelegation, type ShareRole, type ShareView } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** The relay account: who's signed in, or the form to set it up. `onReady` once someone is. */
export function ShareAccountSetup({ onReady }: { onReady?: () => void }) {
  const account = useShareAccount();
  const [relay, setRelay] = useState(account?.relayUrl ?? DEFAULT_RELAY);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshShareAccount().catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    if (account?.relayUrl) setRelay(account.relayUrl);
  }, [account?.relayUrl]);
  useEffect(() => {
    if (account?.user) onReady?.();
  }, [account?.user, onReady]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => signInToRelay(relay, email, password, creating ? name || email.split("@")[0] : undefined));
  };
  // The server this app signs in to can be the relay too; then the same session does.
  const sameServer = sameOrigin(relay, DEFAULT_RELAY);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="share-relay">Relay</Label>
        <Input id="share-relay" value={relay} onChange={(e) => setRelay(e.target.value)} placeholder="http://192.168.1.20:3000" spellCheck={false} />
        <p className="text-xs text-muted-foreground">
          The server shared sessions pass through. On your Wi-Fi, one of you runs <code>bun run dev:relay</code> and everyone
          uses that machine’s address.
        </p>
      </div>
      {sameServer && (
        <Button type="button" variant="outline" disabled={busy} onClick={() => void run(() => shareWithAppAccount(relay))}>
          Use the account I’m signed in with
        </Button>
      )}
      <form onSubmit={submit} className="flex flex-col gap-3">
        {sameServer && <p className="text-center text-xs text-muted-foreground">or sign in to it</p>}
        {creating && (
          <Input aria-label="Your name" placeholder="Your name, as others see it" value={name} onChange={(e) => setName(e.target.value)} />
        )}
        <Input aria-label="Email" type="email" placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <Input
          aria-label="Password"
          type="password"
          placeholder="Password"
          autoComplete={creating ? "new-password" : "current-password"}
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={busy}>
            {creating ? "Create account" : "Sign in"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setCreating((c) => !c)}>
            {creating ? "I have an account" : "New to this relay?"}
          </Button>
        </div>
      </form>
      {(error || account?.error) && <p className="text-sm text-destructive">{error ?? account?.error}</p>}
    </div>
  );
}

function sameOrigin(a: string, b: string) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export function ShareDialog({ threadId, onClose }: { threadId: string | null; onClose: () => void }) {
  const share = useShare(threadId ?? undefined);
  const account = useShareAccount();
  const title = getConversations().find((c) => c.id === threadId)?.title ?? "this session";
  const live = isLive(share);
  return (
    <Dialog open={threadId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RadioIcon className={cn("size-4", live && share.status === "live" && "text-brand")} /> Share live
          </DialogTitle>
          <DialogDescription>
            Others watch “{title}” as it runs: the messages, tool calls and the files it changes. It keeps running on this
            computer, with your keys. You choose who may suggest messages and who drives.
          </DialogDescription>
        </DialogHeader>
        {threadId &&
          (live ? (
            <Sharing share={share} />
          ) : account?.user ? (
            <Start threadId={threadId} ended={share?.ended ?? null} />
          ) : (
            <ShareAccountSetup />
          ))}
      </DialogContent>
    </Dialog>
  );
}

function Start({ threadId, ended }: { threadId: string; ended: string | null }) {
  const [busy, setBusy] = useState(false);
  const [e2e, setE2e] = useState(true);
  const start = async () => {
    setBusy(true);
    try {
      await startShare(threadId, e2e);
      await copyInvite(threadId);
      toast.success("Sharing. Invite link copied", { description: "Anyone who opens it waits until you let them in." });
    } catch (e) {
      toast.error("Couldn’t start sharing", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-center gap-4 py-2 text-center">
      <Mascot busy={false} draft="" still />
      {ended && <p className="text-sm text-muted-foreground">{ended}</p>}
      <ul className="max-w-sm text-left text-sm text-muted-foreground [&>li]:mt-1 [&>li]:list-disc [&>li]:ml-4">
        <li>Secret files (.env, keys), your memory and past chats are hidden from them.</li>
        <li>You let each person in, give them a role, and can remove them or end the share at any time.</li>
        <li>While anyone else can steer, edits, commands, connectors and new sites ask you first.</li>
        <li>{e2e ? "End-to-end encrypted: the relay only forwards ciphertext. The key is in the link, so share links privately." : "Not encrypted: the relay can see what’s shared. Use one you trust."}</li>
      </ul>
      <label className="flex w-full max-w-sm items-center justify-between gap-4 text-left text-sm">
        <span className="flex items-center gap-2">
          <LockIcon className="size-4" /> End-to-end encrypt
        </span>
        <Switch checked={e2e} onCheckedChange={setE2e} />
      </label>
      <Button onClick={() => void start()} disabled={busy}>
        <LinkIcon /> Start sharing and copy link
      </Button>
    </div>
  );
}

const STATUS: Record<ShareView["status"], string> = {
  connecting: "Connecting to the relay…",
  live: "Live",
  lobby: "Waiting",
  offline: "Offline, reconnecting…",
  ended: "Ended",
};

const ROLES: { value: Exclude<ShareRole, "owner">; label: string; hint: string }[] = [
  { value: "viewer", label: "Watches", hint: "Sees everything, sends nothing" },
  { value: "collaborator", label: "Suggests", hint: "Suggests messages for the driver or you, and comments" },
  { value: "driver", label: "Drives", hint: "Sends messages, pauses and resumes, answers what you hand over" },
];

const DELEGATIONS: { key: keyof ShareDelegation; label: string; hint: string; risky?: boolean }[] = [
  { key: "edits", label: "File changes", hint: "Writing, editing, moving and deleting files, and commits" },
  { key: "shell", label: "Sandboxed commands", hint: "Commands that can only change this folder, without network" },
  { key: "browser", label: "Opening sites", hint: "New sites in the built-in browser" },
  { key: "undo", label: "Undoing changes", hint: "Putting back the files a turn changed (secret files stay yours)" },
  { key: "escalated", label: "Commands with network or outside the sandbox", hint: "They run as you, on your computer", risky: true },
  { key: "connectors", label: "Connector tools", hint: "They act with your accounts (GitHub, Slack, …)", risky: true },
];

/** What happens when the owner steps away: pause (the default), or let the driver carry on for a while. */
function AwaySetting({ share, onError }: { share: ShareView; onError: (e: unknown) => void }) {
  const away = share.policy.away;
  const [minutes, setMinutes] = useState(String(away.minutes));
  useEffect(() => setMinutes(String(away.minutes)), [away.minutes]);
  const save = (next: ShareView["policy"]["away"]) => void setAwayPolicy(share, next).catch(onError);
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">When you step away</h3>
      <div className="flex items-center gap-2">
        <Select value={away.mode} onValueChange={(mode) => save({ ...away, mode: mode as typeof away.mode })}>
          <SelectTrigger size="sm" className="flex-1" aria-label="When you step away">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pause">Pause the agent, and take back control</SelectItem>
            <SelectItem value="keep-going">Let the driver carry on for a while</SelectItem>
          </SelectContent>
        </Select>
        {away.mode === "keep-going" && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Input
              type="number"
              min={1}
              max={480}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
              onBlur={() => {
                const n = Math.round(Number(minutes));
                if (Number.isFinite(n) && n !== away.minutes) save({ ...away, minutes: n });
              }}
              className="h-8 w-16"
              aria-label="Minutes"
            />
            min
          </label>
        )}
      </div>
      <p className={cn("text-xs", away.mode === "keep-going" ? "text-destructive" : "text-muted-foreground")}>
        {away.mode === "pause"
          ? "The agent finishes what it’s doing, then pauses. Nothing more happens on this computer until you’re back."
          : "The driver keeps going with only what you’ve handed over, spending your credits on this computer while you’re gone. Secret files and anything you haven’t handed over wait for you. After the time is up, the agent pauses."}
      </p>
    </section>
  );
}

function Sharing({ share }: { share: ShareView }) {
  const [copied, setCopied] = useState<"viewer" | "collaborator" | null>(null);
  const [invites, setInvites] = useState<InviteInfo[] | null>(null);
  const threadId = share.threadId;
  const guests = share.members.filter((m) => m.role !== "owner");
  const driver = guests.find((m) => m.role === "driver");
  const steerable = othersCanSteer(share);

  const loadInvites = () =>
    void listInvites(threadId).then(setInvites, (e) => toast.error("Couldn’t load the links", { description: errorMessage(e) }));
  useEffect(loadInvites, [threadId]);

  const copy = async (roleCap: "viewer" | "collaborator") => {
    try {
      await copyInvite(threadId, roleCap);
      setCopied(roleCap);
      setTimeout(() => setCopied(null), 1500);
      loadInvites();
    } catch (e) {
      toast.error("Couldn’t make a link", { description: errorMessage(e) });
    }
  };
  const act = (work: () => Promise<unknown>, failed: string) =>
    void work().catch((e) => toast.error(failed, { description: errorMessage(e) }));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2 text-sm">
        <span className={cn("size-2 rounded-full", share.status === "live" ? "bg-brand" : "bg-muted-foreground/50")} />
        <span>{STATUS[share.status]}</span>
        {share.error && share.status !== "live" && <span className="truncate text-muted-foreground">· {share.error}</span>}
        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground" title={share.e2e ? "The relay only forwards ciphertext" : "The relay can read what’s shared"}>
          {share.e2e ? <LockIcon className="size-3.5" /> : <LockOpenIcon className="size-3.5" />}
          {share.e2e ? "Encrypted" : "Not encrypted"} · Ends{" "}
          {new Date(share.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button onClick={() => void copy("viewer")} variant="outline" className="justify-center">
          {copied === "viewer" ? <CheckIcon /> : <CopyIcon />} {copied === "viewer" ? "Copied" : "Link to watch"}
        </Button>
        <Button onClick={() => void copy("collaborator")} variant="outline" className="justify-center">
          {copied === "collaborator" ? <CheckIcon /> : <CopyIcon />} {copied === "collaborator" ? "Copied" : "Link to suggest"}
        </Button>
      </div>

      {share.lobby.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Waiting to join</h3>
          {share.lobby.map((p) => (
            <div key={p.peerId} className="flex items-center gap-3">
              <UserAvatar image={safeImage(p.image)} name={p.name} email={p.email} className="size-7 text-xs" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{p.name}</p>
                {p.email && <p className="truncate text-xs text-muted-foreground">{p.email}</p>}
              </div>
              <Button size="sm" variant="ghost" onClick={() => void admit(threadId, p.userId, false)}>
                Turn away
              </Button>
              <Button size="sm" onClick={() => void admit(threadId, p.userId, true)}>
                Let in
              </Button>
            </div>
          ))}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">People</h3>
        {guests.length === 0 && <p className="text-sm text-muted-foreground">Nobody yet. Send someone a link.</p>}
        {guests.length >= share.limits.maxGuests && (
          <p className="text-xs text-muted-foreground">
            This relay’s plan for your account lets {share.limits.maxGuests === 1 ? "one guest" : `${share.limits.maxGuests} guests`} in at a time.
          </p>
        )}
        {guests.map((m) => (
          <div key={m.userId} className="flex items-center gap-3">
            <UserAvatar image={safeImage(m.image)} name={m.name} className={cn("size-7 text-xs", !m.online && "opacity-50")} />
            <p className="min-w-0 flex-1 truncate text-sm">
              {m.name} {!m.online && <span className="text-muted-foreground">· away</span>}
            </p>
            <Select
              value={m.role}
              onValueChange={(role) => act(() => setRole(threadId, m.userId, role as Exclude<ShareRole, "owner">), "Couldn’t change their role")}
            >
              <SelectTrigger size="sm" className="w-28" aria-label={`${m.name}’s role`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r.value} value={r.value} title={r.hint} disabled={!share.limits.roles.includes(r.value)}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Remove ${m.name}`}
              onClick={() => act(() => kick(threadId, m.userId), "Couldn’t remove them")}
            >
              <UserXIcon />
            </Button>
          </div>
        ))}
        {guests.length > 0 && (
          <p className="text-xs text-muted-foreground">
            One person drives at a time. Links never make anyone a driver: you do, here, or whoever drives passes it on.
          </p>
        )}
      </section>

      {guests.length > 0 && <AwaySetting share={share} onError={(e) => toast.error("Couldn’t change that", { description: errorMessage(e) })} />}

      {steerable && (
        <p className="flex gap-2 rounded-lg bg-muted/60 p-2.5 text-xs text-muted-foreground">
          <ShieldCheckIcon className="size-4 shrink-0 text-foreground" />
          <span>
            While someone else can steer, file changes, commands, connector tools and new sites ask you each time, even ones
            you’d normally allow{driver ? ", unless you hand them to the driver below" : ""}. Anyone who can steer could ask the
            agent to repeat what your memory or past chats hold.
          </span>
        </p>
      )}

      {driver && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">{driver.name} may approve</h3>
          {DELEGATIONS.map((d) => (
            <label key={d.key} className="flex items-start justify-between gap-4">
              <span>
                <span className={cn("block text-sm", d.risky && "text-destructive")}>{d.label}</span>
                <span className="block text-xs text-muted-foreground">{d.hint}</span>
              </span>
              <Switch
                checked={share.policy.delegation[d.key]}
                onCheckedChange={(on) =>
                  act(() => setDelegation(share, { ...share.policy.delegation, [d.key]: on }), "Couldn’t change that")
                }
              />
            </label>
          ))}
          <p className="text-xs text-muted-foreground">They always answer the agent’s questions. Reading secret files stays yours.</p>
        </section>
      )}

      {share.thread.kind === "cowork" && (
        <label className="flex items-start justify-between gap-4">
          <span>
            <span className="block text-sm font-medium">Let them browse the folder</span>
            <span className="block text-xs text-muted-foreground">
              Otherwise they only see the files this session worked on. Secret files never.
            </span>
          </span>
          <Switch
            checked={share.policy.browseFiles}
            onCheckedChange={(on) => act(() => setBrowseFiles(share, on), "Couldn’t change that")}
          />
        </label>
      )}

      {invites && invites.some((i) => !i.revoked && i.expiresAt > Date.now()) && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium">Links</h3>
          {invites
            .filter((i) => !i.revoked && i.expiresAt > Date.now())
            .map((i) => (
              <div key={i.inviteId} className="flex items-center gap-2 text-sm">
                <LinkIcon className="size-3.5 text-muted-foreground" />
                <span className="flex-1 text-muted-foreground">
                  {i.roleCap === "collaborator" ? "To suggest" : "To watch"} · made{" "}
                  {new Date(i.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · used {i.uses} of {i.maxUses}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    act(async () => {
                      await revokeInvite(threadId, i.inviteId);
                      loadInvites();
                    }, "Couldn’t revoke it")
                  }
                >
                  Revoke
                </Button>
              </div>
            ))}
        </section>
      )}

      {share.audit.length > 0 && (
        <details className="group/log">
          <summary className="cursor-pointer text-sm font-medium select-none">Activity</summary>
          <ActivityLog entries={share.audit} className="mt-2 max-h-48 overflow-y-auto" />
        </details>
      )}

      <DialogFooter className="items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">Secret files, memory and past chats stay hidden.</p>
        <Button variant="destructive" onClick={() => act(() => endShare(threadId), "Couldn’t end the share")}>
          End share
        </Button>
      </DialogFooter>
    </div>
  );
}
