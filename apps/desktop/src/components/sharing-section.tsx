// Settings → Sharing: the relay shared sessions go through, and the account
// on it. The token stays in the OS keyring, held by Rust (`share.rs`).

import { useEffect } from "react";
import { toast } from "sonner";

import { Group, Page, Setting } from "@/components/settings-layout";
import { ShareAccountSetup } from "@/components/share-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { UserAvatar } from "@/components/user-avatar";
import { refreshShareAccount, safeImage, setUsageCounts, signOutOfRelay, useShareAccount, useUsageCounts } from "@/lib/share";
import { errorMessage } from "@/lib/tauri";

export function SharingSection() {
  const account = useShareAccount();
  useEffect(() => {
    void refreshShareAccount().catch(() => {});
  }, []);
  const user = account?.user;
  const counts = useUsageCounts();
  return (
    <Page>
      <Group title="Relay">
        {user ? (
          <>
            <Setting title="Address" description="Where shared sessions pass through. Everyone in a session uses the same one.">
              <code className="text-sm">{account?.relayUrl}</code>
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
