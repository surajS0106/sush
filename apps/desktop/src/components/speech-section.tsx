// Settings → Speech: who dictates (Yammer by default, or Sush itself), and for
// Sush's own dictation which provider and model transcribe. Those controls also
// appear in the dictation error dialog, laid out as stacked fields.

import { openUrl } from "@tauri-apps/plugin-opener";
import { DownloadIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";

import { Group, Page, Segmented, Setting } from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import { openYammer, useYammerStatus } from "@/components/yammer-setup-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DropdownMenu } from "@/components/ui/DropdownMenu";
import {
  BUILTIN,
  canTranscribe,
  DEFAULT_OLLAMA_MODEL,
  defaultApi,
  dictationEngine,
  hotkeyLabel,
  setSpeechSettings,
  useSpeechSettings,
  YAMMER_DOWNLOAD_URL,
  type DictationEngine,
} from "@/lib/speech";
import { api, type ModelInfo, type ProviderView, type TranscribeApi } from "@/lib/tauri";
import { setVoiceSettings, systemVoices, useVoiceSettings, type VoiceSettings } from "@/lib/voices";

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
    <DropdownMenu
      label="Speech provider"
      align="end"
      variant="field"
      className="w-full sm:w-56"
      placeholder="Choose a provider"
      value={form.providerId}
      onChange={form.pickProvider}
      items={[
        { value: BUILTIN, label: "Built-in Whisper", hint: "142 MB, offline" },
        ...providers.map((p) => ({
          value: p.id,
          label: p.name,
          hint: canTranscribe(p) ? undefined : "no audio input",
          disabled: !canTranscribe(p),
        })),
      ]}
    />
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

function YammerSettings() {
  const status = useYammerStatus(true);
  const installed = !!status?.installed;
  return (
    <>
      <Setting
        title="Yammer"
        description={
          !status
            ? "Looking for Yammer…"
            : !installed
              ? "Not installed yet. Yammer is Sush's free dictation app: it transcribes on this computer and types into any app."
              : status.onboarded
                ? status.running
                  ? "Installed and running. It starts by itself when you dictate."
                  : "Installed. It starts by itself when you dictate."
                : "Installed. Open it to finish its setup: a speech model and the microphone."
        }
      >
        {installed ? (
          <Button variant="outline" size="sm" onClick={() => void openYammer()}>
            <ExternalLinkIcon /> Open Yammer
          </Button>
        ) : (
          <Button size="sm" disabled={!status} onClick={() => void openUrl(YAMMER_DOWNLOAD_URL)}>
            <DownloadIcon /> Download
          </Button>
        )}
      </Setting>
      <Setting
        title="Shortcut"
        description="Ctrl+D in Sush starts dictating, and again finishes; Yammer types the text into the message box. Its own hotkey works in every app. Esc cancels. Speech model, language and clean-up are set in Yammer."
      >
        <span className="flex gap-1.5">
          <kbd className="rounded border px-1.5 py-0.5 font-sans text-xs">Ctrl+D</kbd>
          <kbd className="rounded border px-1.5 py-0.5 font-sans text-xs">{hotkeyLabel(status?.hotkey)}</kbd>
        </span>
      </Setting>
    </>
  );
}

export function SpeechSection({ providers }: { providers: ProviderView[] }) {
  const form = useSpeechForm(providers);
  const engine = dictationEngine(useSpeechSettings());
  return (
    <Page>
      <Group title="Dictation">
        <Setting title="Dictate with" description="Yammer is Sush's dictation app and works everywhere. Sush's built-in dictation needs nothing else installed.">
          <Segmented<DictationEngine>
            label="Dictation engine"
            value={engine}
            onChange={(v) => setSpeechSettings({ engine: v })}
            options={[
              { value: "yammer", label: "Yammer" },
              { value: "sush", label: "Built-in" },
            ]}
          />
        </Setting>
        {engine === "yammer" && <YammerSettings />}
      </Group>
      {engine === "sush" && <SushSpeech form={form} providers={providers} />}
      <OverviewVoices providers={providers} />
    </Page>
  );
}

function SushSpeech({ form, providers }: { form: Form; providers: ProviderView[] }) {
  return (
    <>
      <Group title="Built-in dictation">
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
    </>
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

/** Voices for notebooks' audio overviews: the computer's own, or a provider's speech endpoint. */
function OverviewVoices({ providers }: { providers: ProviderView[] }) {
  const v = useVoiceSettings();
  const speakers = providers.filter((p) => p.format === "openai-chat");
  // The browser lists its voices a moment after asking.
  const [system, setSystem] = useState(systemVoices);
  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    const update = () => setSystem(systemVoices());
    speechSynthesis.addEventListener("voiceschanged", update);
    update();
    return () => speechSynthesis.removeEventListener("voiceschanged", update);
  }, []);
  const systemItems = [{ value: "", label: "Default" }, ...system.map((x) => ({ value: x.voiceURI, label: x.name, hint: x.lang }))];
  const voiceInput = (key: keyof Pick<VoiceSettings, "voiceA" | "voiceB">, label: string, placeholder: string) => (
    <Input
      aria-label={label}
      className="w-full sm:w-56"
      value={v[key]}
      placeholder={placeholder}
      onChange={(e) => setVoiceSettings({ [key]: e.target.value })}
      spellCheck={false}
    />
  );
  return (
    <Group title="Audio overviews">
      <Setting
        title="Voices"
        description="Your computer's voices read an overview aloud as it plays: free, offline, nothing saved. A provider's voices sound far more natural and are made once, then kept."
      >
        <Segmented<VoiceSettings["engine"]>
          label="Voices for audio overviews"
          value={v.engine}
          onChange={(engine) => setVoiceSettings({ engine })}
          options={[
            { value: "system", label: "This computer" },
            { value: "provider", label: "A provider" },
          ]}
        />
      </Setting>
      {v.engine === "system" ? (
        <>
          <Setting title="First host" description="Leads the conversation.">
            <DropdownMenu label="First host's voice" align="end" variant="field" className="w-full sm:w-56" value={v.systemA} onChange={(id) => setVoiceSettings({ systemA: id })} items={systemItems} />
          </Setting>
          <Setting title="Second host" description="Asks and pushes back. Pick a different voice from the first.">
            <DropdownMenu label="Second host's voice" align="end" variant="field" className="w-full sm:w-56" value={v.systemB} onChange={(id) => setVoiceSettings({ systemB: id })} items={systemItems} />
          </Setting>
        </>
      ) : (
        <>
          <Setting
            title="Provider"
            description="Any provider with an OpenAI-style speech endpoint: OpenAI, Azure Foundry, Groq, or a local server like Kokoro-FastAPI added as an OpenAI-compatible provider."
          >
            <DropdownMenu
              label="Speech provider for audio overviews"
              align="end"
              variant="field"
              className="w-full sm:w-56"
              placeholder="Choose a provider"
              value={v.providerId ?? ""}
              onChange={(id) => setVoiceSettings({ providerId: id || null })}
              items={speakers.map((p) => ({ value: p.id, label: p.name }))}
            />
          </Setting>
          <Setting title="Model" description="gpt-4o-mini-tts or tts-1 on OpenAI; your deployment name on Azure; kokoro on a Kokoro server.">
            <Input
              aria-label="Speech model"
              className="w-full sm:w-56"
              value={v.model}
              placeholder="gpt-4o-mini-tts"
              onChange={(e) => setVoiceSettings({ model: e.target.value })}
              spellCheck={false}
            />
          </Setting>
          <Setting title="First host's voice" description="The provider's voice name, such as alloy, ash, coral or nova (OpenAI), or af_bella (Kokoro).">
            {voiceInput("voiceA", "First host's voice", "alloy")}
          </Setting>
          <Setting title="Second host's voice" description="A different voice from the first.">
            {voiceInput("voiceB", "Second host's voice", "verse")}
          </Setting>
        </>
      )}
    </Group>
  );
}
