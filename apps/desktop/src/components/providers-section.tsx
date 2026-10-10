// Settings → Providers: connect model providers; keys live in the OS keychain.

import { KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Logo } from "@/components/model-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { providerLogo } from "@/lib/logos";
import { api, errorMessage, type ProviderConfig, type ProviderView, type WireFormat } from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface ProvidersSectionProps {
  providers: ProviderView[];
  onChanged: () => void;
}

const FORMAT_LABELS: Record<WireFormat, string> = {
  "openai-chat": "OpenAI Chat Completions",
  "anthropic-messages": "Anthropic Messages",
};

export function ProvidersSection({ providers, onChanged }: ProvidersSectionProps) {
  const [presets, setPresets] = useState<ProviderConfig[]>([]);
  const [draft, setDraft] = useState<(ProviderConfig & { hasKey?: boolean }) | null>(null);

  useEffect(() => {
    api.listPresets().then(setPresets).catch((e) => toast.error(errorMessage(e)));
  }, []);

  // Default to the first provider.
  useEffect(() => {
    if (!draft && providers.length > 0) setDraft(providers[0]);
  }, [draft, providers]);

  const addFromPreset = (preset: ProviderConfig) => setDraft({ ...preset, id: crypto.randomUUID(), hasKey: false });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mx-6 border-b pt-6 pr-8 pb-5">
        <h2 className="text-lg font-semibold tracking-tight">Providers</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect model providers. API keys are stored in your OS keychain.
        </p>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-64 shrink-0 flex-col border-r">
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-1 p-3">
              {providers.map((p) => {
                const missingKey = p.auth.type === "api-key" && !p.hasKey;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setDraft(p)}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent/60",
                      draft?.id === p.id && "bg-accent font-medium hover:bg-accent",
                    )}
                  >
                    <ProviderTile provider={p} />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    {missingKey ? (
                      <KeyRoundIcon className="size-4 shrink-0 text-destructive" aria-label="No API key" />
                    ) : (
                      <span className="mr-1 size-2 shrink-0 rounded-full bg-emerald-500" aria-label="Ready" />
                    )}
                  </button>
                );
              })}
              {providers.length === 0 && (
                <p className="px-2.5 py-2 text-sm text-muted-foreground">No providers yet.</p>
              )}
            </div>
          </ScrollArea>
          <div className="p-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="h-10 w-full">
                  <PlusIcon /> Add provider
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                {presets.map((preset) => (
                  <DropdownMenuItem key={preset.id} onSelect={() => addFromPreset(preset)}>
                    <Logo src={providerLogo(preset)} />
                    {preset.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          {draft ? (
            <ProviderForm
              key={draft.id}
              initial={draft}
              isNew={!providers.some((p) => p.id === draft.id)}
              onSaved={(saved) => {
                setDraft(saved);
                onChanged();
              }}
              onDeleted={() => {
                setDraft(null);
                onChanged();
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
              Add a provider to get started.
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}

interface ProviderFormProps {
  initial: ProviderConfig & { hasKey?: boolean };
  isNew: boolean;
  onSaved: (saved: ProviderView) => void;
  onDeleted: () => void;
}

function ProviderForm({ initial, isNew, onSaved, onDeleted }: ProviderFormProps) {
  const [form, setForm] = useState(initial);
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState(initial.models.join("\n"));
  const [busy, setBusy] = useState(false);
  const needsKey = form.auth.type === "api-key";
  const set = <K extends keyof ProviderConfig>(key: K, value: ProviderConfig[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    if (/\{.+\}/.test(form.baseUrl)) {
      toast.error("Replace the {placeholder} in the base URL with your resource name.");
      return;
    }
    if (needsKey && !initial.hasKey && !apiKey.trim()) {
      toast.error("Enter an API key.");
      return;
    }
    setBusy(true);
    try {
      const config: ProviderConfig = {
        ...form,
        name: form.name.trim() || "Untitled",
        baseUrl: form.baseUrl.trim(),
        models: models.split(/[\n,]/).map((m) => m.trim()).filter(Boolean),
      };
      const saved = await api.saveProvider(config, apiKey);
      setApiKey("");
      // Saving doubles as a connection test.
      try {
        const found = await api.listModels(saved.id);
        toast.success(`Saved ${saved.name}: ${found.length} model${found.length === 1 ? "" : "s"} available.`);
      } catch (e) {
        toast.warning(`Saved ${saved.name}, but listing models failed: ${errorMessage(e)}`);
      }
      onSaved(saved);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteProvider(form.id);
      onDeleted();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-5 px-8 py-6"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-3 border-b pb-5">
        <ProviderTile provider={form} size="lg" />
        <h3 className="truncate text-base font-semibold">{isNew ? "New provider" : form.name}</h3>
        <Badge variant="secondary" className="rounded-full px-2.5 font-normal">
          {FORMAT_LABELS[form.format]}
        </Badge>
      </div>

      <Field label="Name">
        <Input className="h-10" value={form.name} onChange={(e) => set("name", e.target.value)} />
      </Field>

      <Field label="API format">
        <Select value={form.format} onValueChange={(v) => set("format", v as WireFormat)}>
          <SelectTrigger className="w-full data-[size=default]:h-10">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(FORMAT_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Base URL" hint="Requests go to {base}/chat/completions or {base}/messages.">
        <Input
          className="h-10"
          value={form.baseUrl}
          placeholder="https://api.example.com/v1"
          onChange={(e) => set("baseUrl", e.target.value)}
          spellCheck={false}
        />
      </Field>

      <Field label="Authentication">
        <Select
          value={form.auth.type}
          onValueChange={(v) => set("auth", v === "none" ? { type: "none" } : { type: "api-key", header: null })}
        >
          <SelectTrigger className="w-full data-[size=default]:h-10">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="api-key">API key</SelectItem>
            <SelectItem value="none">None (local server)</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      {form.auth.type === "api-key" && (
        <div className="grid grid-cols-[1fr_10rem] gap-3">
          <Field label="API key">
            <Input
              className="h-10"
              type="password"
              value={apiKey}
              autoComplete="off"
              placeholder={initial.hasKey ? "Saved. Enter a new key to replace it." : "Paste your key"}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>
          <Field label="Header" hint="Blank = default">
            <Input
              className="h-10"
              value={form.auth.header ?? ""}
              placeholder="default"
              spellCheck={false}
              onChange={(e) => set("auth", { type: "api-key", header: e.target.value.trim() || null })}
            />
          </Field>
        </div>
      )}

      <Field
        label="Pinned models"
        hint="One per line. Use this for Azure deployment names or models the endpoint doesn't list."
      >
        <Textarea
          rows={3}
          className="min-h-20 font-mono text-sm"
          value={models}
          spellCheck={false}
          placeholder="gpt-4.1-deployment"
          onChange={(e) => setModels(e.target.value)}
        />
      </Field>

      <div className="mt-2 flex items-center justify-between gap-2">
        {!isNew ? (
          <Button
            type="button"
            variant="ghost"
            className="h-10 text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={busy}
            onClick={remove}
          >
            <Trash2Icon /> Delete
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" className="h-10 px-5" disabled={busy}>
          {busy ? "Saving…" : "Save & test"}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="font-semibold">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** The provider's logo in a soft rounded tile, like an app icon. */
function ProviderTile({
  provider,
  size = "md",
}: {
  provider: { id: string; name: string; baseUrl: string };
  size?: "md" | "lg";
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg border bg-muted/60 text-foreground shadow-xs",
        size === "lg" ? "size-10 rounded-xl" : "size-8",
      )}
    >
      <Logo src={providerLogo(provider)} className={size === "lg" ? "size-5" : "size-4"} />
    </span>
  );
}
