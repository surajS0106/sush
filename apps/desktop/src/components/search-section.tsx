// Settings → Search: whether models may search the web, and the Ollama key that powers
// search for models without their own. Claude and GPT models use their provider's search.

import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Group, Page, Setting } from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { setPrefs, usePrefs } from "@/lib/library";
import { api, errorMessage, type WebKeySource } from "@/lib/tauri";

const KEYS = "https://ollama.com/settings/keys";

function Link({ href, children }: { href: string; children: string }) {
  return (
    <button type="button" onClick={() => void openUrl(href)} className="text-foreground underline underline-offset-4">
      {children}
    </button>
  );
}

export function SearchSection() {
  const prefs = usePrefs();
  const [source, setSource] = useState<WebKeySource | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = () => api.webKeyStatus().then(setSource).catch(() => setSource("none"));
  useEffect(() => void refresh(), []);

  const save = async () => {
    setSaving(true);
    setProblem(null);
    try {
      const found = await api.webKeySet(draft);
      setDraft("");
      setProblem(found);
      await refresh();
      if (!found) toast.success("Your Ollama key works");
    } catch (e) {
      toast.error(`Couldn't save the key: ${errorMessage(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await api.webKeyDelete();
      setProblem(null);
      await refresh();
    } catch (e) {
      toast.error(`Couldn't remove the key: ${errorMessage(e)}`);
    }
  };

  const keyForm = (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Input
        type="password"
        aria-label="Ollama API key"
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
  );

  return (
    <Page>
      <Group title="Web search">
        <Setting
          title="Search the web"
          description="Let models look things up and read pages when a question needs it, citing what they used. Research in the composer asks for a more thorough search."
        >
          <Switch checked={prefs.webSearch} onCheckedChange={(webSearch) => setPrefs({ webSearch })} aria-label="Search the web" />
        </Setting>
        <Setting
          title="Ollama API key"
          description={
            source === "provider"
              ? "Using your Ollama Cloud provider's key. Add one here to use a different account."
              : "Powers search for models without their own, such as local, Groq and OpenRouter models. Claude and GPT models use their provider's search."
          }
        >
          {source === "own" ? (
            <Button variant="outline" size="sm" onClick={() => void remove()}>
              Remove key
            </Button>
          ) : (
            keyForm
          )}
        </Setting>
      </Group>
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
            <Link href={KEYS}>Create a key on ollama.com</Link>. A free Ollama account includes web search.
          </li>
          <li>Paste it above. It's kept in your system's secure storage and only sent to Ollama.</li>
        </ol>
        <p>
          Searches send the query to Ollama. Without a key, models can still read a page you give them: Sush fetches it from this computer, and
          only from public websites, never your local network.
        </p>
      </div>
    </Page>
  );
}
