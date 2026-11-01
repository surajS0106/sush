// Settings → Sharing: the relay shared sessions go through, and the account
// on it. The token stays in the OS keyring, held by Rust (`share.rs`).

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Group, Page, Setting } from "@/components/settings-layout";
import { ShareAccountSetup } from "@/components/share-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { UserAvatar } from "@/components/user-avatar";
import { refreshShareAccount, safeImage, setLocalRelayOpen, setUsageCounts, signOutOfRelay, useShareAccount, useUsageCounts } from "@/lib/share";
import { api, errorMessage, type LocalRelay } from "@/lib/tauri";

export function SharingSection() {
  const account = useShareAccount();
  useEffect(() => {
    void refreshShareAccount().catch(() => {});
  }, []);
  const user = account?.user;
  const counts = useUsageCounts();
  const [changing, setChanging] = useState(false);
  return (
    <Page>
      <Group title="Relay">
        {changing ? (
          <div className="max-w-md py-3">
            <ShareAccountSetup relay={account?.relayUrl ?? undefined} onReady={() => setChanging(false)} onCancel={() => setChanging(false)} />
          </div>
        ) : user ? (
          <>
            <Setting title="Address" description="Where shared sessions pass through. Everyone in a session uses the same one.">
              <div className="flex items-center gap-3">
                <code className="text-sm">{account?.relayUrl}</code>
                <Button variant="outline" size="sm" onClick={() => setChanging(true)}>
                  Change
                </Button>
              </div>
            </Setting>
            <Setting title={user.name || user.email} description={user.email}>
              <div className="flex items-center gap-3">
                <UserAvatar image={safeImage(user.image)} name={user.name} email={user.email} className="size-8 text-xs" />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void signOutOfRelay().catch((e) => toast.error("Couldn’t sign out", { description: errorMessage(e) }))}
                >
                  Sign out
                </Button>
              </div>
            </Setting>
          </>
        ) : (
          <div className="max-w-md py-3">
            <ShareAccountSetup />
          </div>
        )}
      </Group>
      <LocalRelayGroup />
      <Group title="What guests see">
        <p className="py-3 text-sm text-muted-foreground">
          The messages, tool calls, and the files a session changes, as it runs. Never your keys, secret files (.env, keys),
          memory or past chats. Guests watch unless you let them suggest messages, or hand one of them the wheel: the driver
          sends messages and answers only the approvals you choose. The session keeps running here, with your keys. Shares are
          end-to-end encrypted unless you turn it off when starting one: the key travels in the invite link, after the{" "}
          <code>#</code>, so the relay only forwards ciphertext. On your own network, run <code>bun run dev:relay</code> on one
          machine.
        </p>
      </Group>
      <Group title="Usage counts">
        <Setting
          title="Report anonymous counts to the relay"
          description="When a share ends: how many people joined it and how many messages guests sent. Never names, messages or anything from the session. Off unless you turn it on."
        >
          <Switch checked={counts} onCheckedChange={setUsageCounts} aria-label="Report anonymous counts" />
        </Setting>
      </Group>
    </Page>
  );
}

/**
 * The installed app's own relay: off the network by default; one switch lets
 * others on the same Wi-Fi join sessions shared from here (and share through it).
 */
function LocalRelayGroup() {
  const [relay, setRelay] = useState<LocalRelay | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api.localRelay().then(setRelay, () => {});
  }, []);
  if (!relay?.available) return null;
  const toggle = async (open: boolean) => {
    setBusy(true);
    try {
      setRelay(await setLocalRelayOpen(open));
      await refreshShareAccount();
    } catch (e) {
      toast.error(open ? "Couldn’t open the relay" : "Couldn’t close the relay", { description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Group title="This computer as the relay">
      <Setting
        title="Let others on this Wi-Fi join"
        description="Sush’s built-in relay opens to your local network, so people on the same Wi-Fi can join the sessions you share, from the app or a browser. Shares stay end-to-end encrypted. Your Mac may ask whether Sush may accept incoming connections: allow it."
      >
        <Switch checked={relay.lan} disabled={busy} onCheckedChange={(on) => void toggle(on)} aria-label="Let others on this Wi-Fi join" />
      </Setting>
      {relay.lan && relay.url && (
        <Setting title="Address for others" description="Guests use this as their relay. Invite links already carry it.">
          <div className="flex items-center gap-2">
            <code className="text-sm">{relay.url}</code>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void navigator.clipboard.writeText(relay.url!).then(
                  () => toast.success("Copied"),
                  () => toast.error("Couldn’t copy"),
                )
              }
            >
              Copy
            </Button>
          </div>
        </Setting>
      )}
    </Group>
  );
}
