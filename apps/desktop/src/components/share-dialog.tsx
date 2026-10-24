// "Share live…": let others watch a session as it runs. Setting up the relay
// account (also on Settings → Sharing and in the join dialog), starting the
// share, copying invite links, letting people in from the lobby, removing
// them, revoking links and ending the share. The work itself is `lib/share.ts`.

import { CheckIcon, CopyIcon, LinkIcon, RadioIcon, UserXIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Mascot } from "@/components/mascot";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  refreshShareAccount,
  revokeInvite,
  safeImage,
  setBrowseFiles,
  shareWithAppAccount,
  signInToRelay,
  startShare,
  useShare,
  useShareAccount,
} from "@/lib/share";
import { getConversations } from "@/lib/store";
import { errorMessage, type InviteInfo, type ShareView } from "@/lib/tauri";
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
            computer, with your keys; they can’t run anything.
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
  const start = async () => {
    setBusy(true);
    try {
      await startShare(threadId);
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
        <li>You let each person in, and can remove them or end the share at any time.</li>
        <li>The relay can see what’s shared. Use one you trust.</li>
      </ul>
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

function Sharing({ share }: { share: ShareView }) {
  const [copied, setCopied] = useState(false);
  const [invites, setInvites] = useState<InviteInfo[] | null>(null);
  const threadId = share.threadId;
  const guests = share.members.filter((m) => m.role !== "owner");

  const loadInvites = () =>
    void listInvites(threadId).then(setInvites, (e) => toast.error("Couldn’t load the links", { description: errorMessage(e) }));
  useEffect(loadInvites, [threadId]);

  const copy = async () => {
    try {
      await copyInvite(threadId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
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
        <span className="ml-auto text-xs text-muted-foreground">Ends {new Date(share.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
      </div>

      <Button onClick={() => void copy()} variant="outline" className="justify-center">
        {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : "Copy a new invite link"}
      </Button>

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
        <h3 className="text-sm font-medium">Watching</h3>
        {guests.length === 0 && <p className="text-sm text-muted-foreground">Nobody yet. Send someone the link.</p>}
        {guests.map((m) => (
          <div key={m.userId} className="flex items-center gap-3">
            <UserAvatar image={safeImage(m.image)} name={m.name} className={cn("size-7 text-xs", !m.online && "opacity-50")} />
            <p className="min-w-0 flex-1 truncate text-sm">
              {m.name} {!m.online && <span className="text-muted-foreground">· away</span>}
            </p>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove ${m.name}`}
              onClick={() => act(() => kick(threadId, m.userId), "Couldn’t remove them")}
            >
              <UserXIcon /> Remove
            </Button>
          </div>
        ))}
      </section>

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
            onCheckedChange={(on) => act(() => setBrowseFiles(threadId, on), "Couldn’t change that")}
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
                  Made {new Date(i.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · used {i.uses} of {i.maxUses}
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

      <DialogFooter className="items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">Secret files, memory and past chats stay hidden.</p>
        <Button variant="destructive" onClick={() => act(() => endShare(threadId), "Couldn’t end the share")}>
          End share
        </Button>
      </DialogFooter>
    </div>
  );
}
