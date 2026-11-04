// Settings → Flights: the optional Ignav key that adds live fares and seller links
// to flight cards. Cards work without it, with links to search elsewhere.

import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { CurrencySelect } from "@/components/currency-select";
import { Group, Page, Setting } from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { removePriceAlert, usePriceAlerts } from "@/lib/price-alerts";
import { api, errorMessage } from "@/lib/tauri";

const IGNAV = "https://ignav.com";
const PRICING = "https://ignav.com/pricing";

function Link({ href, children }: { href: string; children: string }) {
  return (
    <button type="button" onClick={() => void openUrl(href)} className="text-foreground underline underline-offset-4">
      {children}
    </button>
  );
}

export function FlightsSection() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const alerts = usePriceAlerts();

  useEffect(() => {
    api.flightsKeyStatus().then(setHasKey).catch(() => setHasKey(false));
  }, []);

  const save = async () => {
    setSaving(true);
    setProblem(null);
    try {
      const found = await api.flightsKeySet(draft);
      setHasKey(true);
      setDraft("");
      setProblem(found);
      if (!found) toast.success("Your Ignav key works");
    } catch (e) {
      toast.error(`Couldn't save the key: ${errorMessage(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await api.flightsKeyDelete();
      setHasKey(false);
      setProblem(null);
    } catch (e) {
      toast.error(`Couldn't remove the key: ${errorMessage(e)}`);
    }
  };

  return (
    <Page>
      <Group title="Live fares">
        <Setting
          title="Ignav API key"
          description="Optional. Flight cards work without it; your own key adds fares and links to the sellers of each one. You always book and pay on the seller's site."
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
                aria-label="Ignav API key"
                className="w-56"
                value={draft}
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
      <Group title="Prices">
        <Setting title="Currency" description="Shows prices on flight cards in this currency, at today's rate. Sellers still charge in their own.">
          <CurrencySelect />
        </Setting>
      </Group>
      {alerts.length > 0 && (
        <Group title="Price alerts">
          {alerts.map((alert) => (
            <Setting
              key={alert.id}
              title={`${alert.search.origin} → ${alert.search.destination}`}
              description={`${alert.search.departureDate}${alert.search.returnDate ? ` to ${alert.search.returnDate}` : ""}. Last seen at ${alert.lastPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${alert.currency}.`}
            >
              <Button variant="outline" size="sm" onClick={() => removePriceAlert(alert.id)}>
                Remove
              </Button>
            </Setting>
          ))}
        </Group>
      )}
      {problem && (
        <div role="alert" className="flex flex-col gap-1 text-sm text-destructive">
          <p className="font-medium">The key is saved, but it didn't work:</p>
          <p className="break-words">{problem}</p>
          <p className="text-muted-foreground">To try again, remove the key and paste it back.</p>
        </div>
      )}
      <div className="flex flex-col gap-2 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Getting a key</p>
        <ol className="flex list-decimal flex-col gap-1 pl-5">
          <li>
            <Link href={IGNAV}>Sign up at Ignav</Link> and verify your email.
          </li>
          <li>Paste your API key above. It's kept in your system's secure storage and only sent to Ignav.</li>
        </ol>
        <p>
          Each search is up to three requests to your Ignav account, to find more airlines. Each time you press Book on a fare, and each check of
          a price alert (every 6 hours while Sush is open), is one. They carry the route, dates and passenger count. See <Link href={PRICING}>current pricing</Link>. Each search
          also sends both cities and the departure date to Open-Meteo, with no key, for the globe and the weather tile. Picking a currency gets daily rates from ExchangeRate-API, with no key and nothing about your trips.
        </p>
      </div>
    </Page>
  );
}
