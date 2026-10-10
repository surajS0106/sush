// Settings → Speech: which provider and model transcribe dictation. The same
// controls appear in the dictation error dialog, laid out as stacked fields.

import { useEffect, useId, useState, type ReactNode } from "react";

import { Group, Page, Segmented, Setting } from "@/components/settings-layout";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  BUILTIN,
  canTranscribe,
  DEFAULT_OLLAMA_MODEL,
  defaultApi,
  setSpeechSettings,
  useSpeechSettings,
} from "@/lib/speech";
import { api, type ModelInfo, type ProviderView, type TranscribeApi } from "@/lib/tauri";

const PROVIDER_HINT = "Built-in Whisper runs offline. Claude models don't accept audio, so Anthropic providers can't transcribe.";
const API_HINT = "Ollama audio chat for local Gemma 4. The transcription endpoint for OpenAI, Azure Foundry and Groq.";

const modelHint = (api: TranscribeApi) =>
  api === "ollama-chat"
    ? `An audio-capable model. Gemma 4 E2B and E4B take audio: run "ollama pull ${DEFAULT_OLLAMA_MODEL}".`
    : "A transcription model such as whisper-1 or gpt-4o-transcribe. On Azure Foundry, use your deployment name.";

/** Form state for the speech target, written straight to the speech settings. */
function useSpeechForm(providers: ProviderView[]) {
  const settings = useSpeechSettings();
  const providerId = settings.providerId ?? BUILTIN;
  const builtin = providerId === BUILTIN;
  const { model, api: currentApi } = settings;
  const [models, setModels] = useState<ModelInfo[]>([]);

  useEffect(() => {
    setModels([]);
    if (builtin) return;
    let live = true;
    api.listModels(providerId).then((m) => live && setModels(m)).catch(() => {});
    return () => {
      live = false;
    };
  }, [providerId, builtin]);

  const pickProvider = (id: string) => {
    if (id === BUILTIN) return setSpeechSettings({ providerId: BUILTIN });
    const p = providers.find((x) => x.id === id);
    if (!p) return;
    const apiKind = defaultApi(p);
    setSpeechSettings({ providerId: id, api: apiKind, model: apiKind === "ollama-chat" ? DEFAULT_OLLAMA_MODEL : "" });
  };

  const update = (patch: { model?: string; api?: TranscribeApi }) =>
    setSpeechSettings({ providerId, model, api: currentApi, ...patch });

  return { providerId, builtin, model, api: currentApi, models, pickProvider, update };
}

type Form = ReturnType<typeof useSpeechForm>;

function ProviderSelect({ form, providers }: { form: Form; providers: ProviderView[] }) {
  return (
    <Select value={form.providerId} onValueChange={form.pickProvider}>
      <SelectTrigger aria-label="Speech provider" className="w-full sm:w-56">
        <SelectValue placeholder="Choose a provider" />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value={BUILTIN}>
          Built-in Whisper<span className="text-muted-foreground"> · 142 MB, offline</span>
        </SelectItem>
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
        {!form.builtin && (
          <>
            <Setting title="Model" description={modelHint(form.api)}>
              <ModelInput form={form} />
            </Setting>
            <Setting title="API" description={API_HINT}>
              <ApiPicker form={form} />
            </Setting>
          </>
        )}
        <Setting title="Shortcut" description="Press once to start dictating, again to finish. Local models transcribe live as you speak. Esc cancels.">
          <kbd className="rounded border px-1.5 py-0.5 font-sans text-xs">Ctrl+D</kbd>
        </Setting>
      </Group>
      {form.builtin && (
        <p className="text-sm text-muted-foreground">
          Whisper base.en runs on this computer. It downloads once (142 MB) the first time you dictate.
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
      {!form.builtin && (
        <>
          <Field label="Model" hint={modelHint(form.api)}>
            <ModelInput form={form} />
          </Field>
          <Field label="API">
            <ApiPicker form={form} />
          </Field>
        </>
      )}
    </div>
  );
}
