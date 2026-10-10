// Settings → Speech: which provider and model transcribe dictation.

import { useEffect, useId, useState } from "react";

import { Group, Page, Segmented, Setting } from "@/components/settings-layout";
import { Input } from "@/components/ui/input";
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

export function SpeechSection({ providers }: { providers: ProviderView[] }) {
  const settings = useSpeechSettings();
  const target = resolveSpeechTarget(settings, providers);
  const providerId = target?.provider.id ?? settings.providerId ?? "";
  const [models, setModels] = useState<ModelInfo[]>([]);
  const listId = useId();

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

  // Writing any field pins the current (possibly fallback) target so edits stick.
  const update = (patch: { model?: string; api?: TranscribeApi }) =>
    setSpeechSettings({
      providerId,
      model: target?.model ?? settings.model,
      api: target?.api ?? settings.api,
      ...patch,
    });

  const currentApi = target?.api ?? settings.api;

  return (
    <Page>
      <Group title="Dictation">
        <Setting
          title="Provider"
          description="Where your recorded speech is sent to be transcribed. Claude models don't accept audio, so Anthropic providers can't be used here."
        >
          <Select value={providerId} onValueChange={pickProvider}>
            <SelectTrigger aria-label="Speech provider" className="w-56">
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
        </Setting>
        <Setting
          title="Model"
          description={
            currentApi === "ollama-chat"
              ? `An audio-capable model. Gemma 4 E2B and E4B take audio: run "ollama pull ${DEFAULT_OLLAMA_MODEL}".`
              : "A transcription model such as whisper-1 or gpt-4o-transcribe. On Azure Foundry, use your deployment name."
          }
        >
          <Input
            aria-label="Speech model"
            className="w-56"
            list={listId}
            value={target?.model ?? settings.model}
            placeholder={currentApi === "ollama-chat" ? DEFAULT_OLLAMA_MODEL : "whisper-1"}
            onChange={(e) => update({ model: e.target.value })}
            spellCheck={false}
            disabled={!providerId}
          />
          <datalist id={listId}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName ?? m.id}
              </option>
            ))}
          </datalist>
        </Setting>
        <Setting
          title="API"
          description="Ollama audio chat for local Gemma 4. The transcription endpoint for OpenAI, Azure Foundry and Groq."
        >
          <Segmented
            label="Speech API"
            value={currentApi}
            onChange={(v) => update({ api: v })}
            options={[
              { value: "ollama-chat", label: "Ollama audio chat" },
              { value: "transcriptions", label: "Transcription endpoint" },
            ]}
          />
        </Setting>
        <Setting title="Shortcut" description="Press once to start recording, again to transcribe. Esc cancels.">
          <kbd className="rounded border px-1.5 py-0.5 font-sans text-xs">Ctrl+Shift+Space</kbd>
        </Setting>
      </Group>
      {providers.length > 0 && !target && (
        <p className="text-sm text-muted-foreground">
          No speech model is set up. Add Ollama under Providers for local dictation, or pick a provider above.
        </p>
      )}
    </Page>
  );
}
