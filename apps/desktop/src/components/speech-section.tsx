// Settings → Speech: which provider and model transcribe dictation. The same
// controls appear in the dictation error dialog, laid out as stacked fields.

import { useEffect, useId, useState, type ReactNode } from "react";

import { Group, Page, Segmented, Setting } from "@/components/settings-layout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  canTranscribe,
  DEFAULT_OLLAMA_MODEL,
  defaultApi,
  resolveSpeechTarget,
  setSpeechSettings,
  useSpeechSettings,
} from "@/lib/speech";
import { api, type ModelInfo, type ProviderView, type TranscribeApi } from "@/lib/tauri";

const PROVIDER_HINT = "Claude models don't accept audio, so Anthropic providers can't transcribe.";
const API_HINT = "Ollama audio chat for local Gemma 4. The transcription endpoint for OpenAI, Azure Foundry and Groq.";

const modelHint = (api: TranscribeApi) =>
  api === "ollama-chat"
    ? `An audio-capable model. Gemma 4 E2B and E4B take audio: run "ollama pull ${DEFAULT_OLLAMA_MODEL}".`
    : "A transcription model such as whisper-1 or gpt-4o-transcribe. On Azure Foundry, use your deployment name.";

/** Form state for the speech target, written straight to the speech settings. */
function useSpeechForm(providers: ProviderView[]) {
  const settings = useSpeechSettings();
  // Until the user picks, show the fallback (local Ollama) as the current choice.
  const fallback = settings.providerId ? null : resolveSpeechTarget(settings, providers);
  const providerId = settings.providerId ?? fallback?.provider.id ?? "";
  const model = fallback?.model ?? settings.model;
  const currentApi = fallback?.api ?? settings.api;
  const [models, setModels] = useState<ModelInfo[]>([]);

  useEffect(() => {
    setModels([]);
    if (!providerId) return;
    let live = true;
    api.listModels(providerId).then((m) => live && setModels(m)).catch(() => {});
    return () => {
      live = false;
    };
  }, [providerId]);

  const pickProvider = (id: string) => {
    const p = providers.find((x) => x.id === id);
    if (!p) return;
    const apiKind = defaultApi(p);
    setSpeechSettings({ providerId: id, api: apiKind, model: apiKind === "ollama-chat" ? DEFAULT_OLLAMA_MODEL : "" });
  };

  // Editing any field pins the shown (possibly fallback) choice so the edit sticks.
  const update = (patch: { model?: string; api?: TranscribeApi }) =>
    setSpeechSettings({ providerId, model, api: currentApi, ...patch });

  return { providerId, model, api: currentApi, models, pickProvider, update };
}

type Form = ReturnType<typeof useSpeechForm>;

function ProviderSelect({ form, providers }: { form: Form; providers: ProviderView[] }) {
  return (
    <Select value={form.providerId} onValueChange={form.pickProvider}>
      <SelectTrigger aria-label="Speech provider" className="w-full sm:w-56">
        <SelectValue placeholder="Choose a provider" />
      </SelectTrigger>
      <SelectContent align="end">
        {providers.map((p) => (
          <SelectItem key={p.id} value={p.id} disabled={!canTranscribe(p)}>
            {p.name}
            {!canTranscribe(p) && <span className="text-muted-foreground"> · no audio input</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ModelInput({ form }: { form: Form }) {
  const listId = useId();
  return (
    <>
      <Input
        aria-label="Speech model"
        className="w-full sm:w-56"
        list={listId}
        value={form.model}
        placeholder={form.api === "ollama-chat" ? DEFAULT_OLLAMA_MODEL : "whisper-1"}
        onChange={(e) => form.update({ model: e.target.value })}
        spellCheck={false}
        disabled={!form.providerId}
      />
      <datalist id={listId}>
        {form.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.displayName ?? m.id}
          </option>
        ))}
      </datalist>
    </>
  );
}

function ApiPicker({ form }: { form: Form }) {
  return (
    <Segmented
      label="Speech API"
      value={form.api}
      onChange={(v) => form.update({ api: v })}
      options={[
        { value: "ollama-chat", label: "Ollama audio chat" },
        { value: "transcriptions", label: "Transcription endpoint" },
      ]}
    />
  );
}

export function SpeechSection({ providers }: { providers: ProviderView[] }) {
  const form = useSpeechForm(providers);
  return (
    <Page>
      <Group title="Dictation">
        <Setting title="Provider" description={`Where your recorded speech is sent to be transcribed. ${PROVIDER_HINT}`}>
          <ProviderSelect form={form} providers={providers} />
        </Setting>
        <Setting title="Model" description={modelHint(form.api)}>
          <ModelInput form={form} />
        </Setting>
        <Setting title="API" description={API_HINT}>
          <ApiPicker form={form} />
        </Setting>
        <Setting title="Shortcut" description="Press once to start recording, again to transcribe. Esc cancels.">
          <kbd className="rounded border px-1.5 py-0.5 font-sans text-xs">Ctrl+Shift+Space</kbd>
        </Setting>
      </Group>
      {providers.length > 0 && !form.providerId && (
        <p className="text-sm text-muted-foreground">
          No speech model is set up. Add Ollama under Providers for local dictation, or pick a provider above.
        </p>
      )}
    </Page>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** The speech controls as stacked fields, for dialogs. */
export function SpeechFields({ providers }: { providers: ProviderView[] }) {
  const form = useSpeechForm(providers);
  return (
    <div className="flex flex-col gap-4">
      <Field label="Provider" hint={PROVIDER_HINT}>
        <ProviderSelect form={form} providers={providers} />
      </Field>
      <Field label="Model" hint={modelHint(form.api)}>
        <ModelInput form={form} />
      </Field>
      <Field label="API">
        <ApiPicker form={form} />
      </Field>
    </div>
  );
}
