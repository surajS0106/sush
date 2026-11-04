// Settings → Maps: the saved address `location_get` offers, and the optional
// Google Maps key that adds travel time, ratings and open status to map cards.
// Maps work without either.

import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Group, Page, Setting } from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setSavedLocation, useSavedLocation } from "@/lib/location";
import { api, errorMessage } from "@/lib/tauri";

const CONSOLE_START = "https://console.cloud.google.com/google/maps-apis/start";
const CONSOLE_APIS = "https://console.cloud.google.com/google/maps-apis/api-list";
const CONSOLE_KEYS = "https://console.cloud.google.com/google/maps-apis/credentials";
const PRICING = "https://developers.google.com/maps/billing-and-pricing/pricing";

function SavedAddress() {
  const saved = useSavedLocation();
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);

  const commit = () => {
    const next = draft.trim();
    if (next === saved) return;
    setSavedLocation(next);
    toast.success(next ? "Address saved" : "Address removed");
  };

  return (
    <Input
      aria-label="Saved address"
      className="w-full sm:w-72"
      value={draft}
      placeholder="12 Main Road, Madipakkam, Chennai"
      spellCheck={false}
      autoComplete="street-address"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

function Link({ href, children }: { href: string; children: string }) {
  return (
    <button type="button" onClick={() => void openUrl(href)} className="text-foreground underline underline-offset-4">
      {children}
    </button>
  );
}

export function MapsSection() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  useEffect(() => {
    api.mapsKeyStatus().then(setHasKey).catch(() => setHasKey(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setProblems([]);
    try {
      const found = await api.mapsKeySet(draft);
      setHasKey(true);
      setDraft("");
      setProblems(found);
      if (found.length === 0) toast.success("Your Google Maps key works");
    } catch (e) {
      toast.error(`Couldn't save the key: ${errorMessage(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await api.mapsKeyDelete();
      setHasKey(false);
      setProblems([]);
    } catch (e) {
      toast.error(`Couldn't remove the key: ${errorMessage(e)}`);
    }
  };

  return (
    <Page>
      <Group title="Your location">
        <Setting
          title="Saved address"
          description="Offered first when a chat asks where you are, because a computer's own position can be far off. Stored on this device."
        >
          <SavedAddress />
        </Setting>
      </Group>
      <Group title="Travel details">
        <Setting
          title="Google Maps API key"
          description="Optional. Maps work without it; your own key adds travel time, distance, ratings and open status."
        >
          {hasKey ? (
            <Button variant="outline" size="sm" onClick={() => void remove()}>
              Remove key
            </Button>
          ) : (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <Input
                type="password"
                aria-label="Google Maps API key"
                className="w-56"
                value={draft}
                placeholder="AIza…"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setDraft(e.target.value)}
              />
              <Button type="submit" size="sm" disabled={saving || !draft.trim()}>
                {saving ? "Checking…" : "Save"}
              </Button>
            </form>
          )}
        </Setting>
      </Group>
      {problems.length > 0 && (
        <div role="alert" className="flex flex-col gap-1 text-sm text-destructive">
          <p className="font-medium">The key is saved, but Google refused it:</p>
          {problems.map((p) => (
            <p key={p} className="break-words">
              {p}
            </p>
          ))}
          <p className="text-muted-foreground">If you just enabled an API, give it a few minutes. To try again, remove the key and paste it back.</p>
        </div>
      )}
      <div className="flex flex-col gap-2 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Getting a key</p>
        <ol className="flex list-decimal flex-col gap-1 pl-5">
          <li>
            <Link href={CONSOLE_START}>Open Google Maps Platform</Link>, create a project and turn on billing. Google requires this even
            within its free allowance.
          </li>
          <li>
            <Link href={CONSOLE_APIS}>Enable</Link> Routes API and Places API (New).
          </li>
          <li>
            <Link href={CONSOLE_KEYS}>Create an API key</Link> and restrict it to those two APIs.
          </li>
          <li>Paste it above. It's kept in your system's secure storage and only sent to Google.</li>
        </ol>
        <p>
          Each map with details makes one Places search and, for a route, one Routes request, billed to your Google account. Google's free
          monthly allowance covers about 1,000 of these; after that it charges per request. See{" "}
          <Link href={PRICING}>current pricing</Link>.
        </p>
      </div>
    </Page>
  );
}
