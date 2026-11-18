// Settings → Voice mode: a card per voice provider (add its key there; a card
// with a key is picked by clicking it), the model, and the voice, filtered by
// how it sounds and previewed before picking.

import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckIcon, ExternalLinkIcon, Loader2Icon, PlayIcon, SquareIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Group, Page, Segmented, Setting } from "@/components/settings-layout";
import { GlassOrb } from "@/components/glass-orb";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/DropdownMenu";
import { Input } from "@/components/ui/input";
import { Logo } from "@/components/model-picker";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { logoBySlug } from "@/lib/logos";
import { api, errorMessage, type VoiceGender, type VoiceInfo, type VoiceProvider } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { dbToRms, openMic, Player, rmsToDb, type Mic } from "@/lib/voice-audio";
import {
  activeProvider,
  DEFAULT_GATE_DB,
  forgetCatalog,
  modelFor,
  providerInfo,
  refreshVoiceKeys,
  setVoiceChoice,
  setVoiceModeSettings,
  setVoiceModel,
  useVoiceCatalog,
  useVoiceKeys,
  useVoiceModeSettings,
  voiceFor,
  VOICE_PROVIDERS,
  type VoiceProviderInfo,
} from "@/lib/voice-mode";

export function VoiceSection() {
  const keys = useVoiceKeys();
  const settings = useVoiceModeSettings();
  const provider = activeProvider(settings, keys);
  const [version, setVersion] = useState(0);
  const catalog = useVoiceCatalog(provider, version);

  const onKeyChanged = async (p: VoiceProvider) => {
    forgetCatalog(p);
    await refreshVoiceKeys();
    setVersion((v) => v + 1);
  };

  const models = useMemo(() => {
    if (!provider) return [];
    const list = catalog?.models ?? [];
    const current = modelFor(settings, provider);
    return list.some((m) => m.id === current) ? list : [{ id: current, name: current, description: "" }, ...list];
  }, [catalog, provider, settings]);

  return (
    <Page>
      <section>
        <h2 className="text-base font-semibold">Talk to</h2>
        <p className="mt-1 mb-4 max-w-lg text-sm text-muted-foreground">
          Tap the voice button in an empty composer to talk hands-free, and interrupt whenever you like. Each provider runs on your own key, kept in your
          system's keychain.
        </p>
        <div role="radiogroup" aria-label="Voice provider" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {VOICE_PROVIDERS.map((p) => (
            <ProviderCard
              key={p.id}
              info={p}
              hasKey={!!keys?.includes(p.id)}
              selected={provider === p.id}
              onSelect={() => setVoiceModeSettings({ provider: p.id })}
              onChanged={() => onKeyChanged(p.id)}
            />
          ))}
        </div>
      </section>

      {provider && (
        <Group title="Conversation">
          <Setting
            title={providerInfo(provider).realtime ? "Model" : "Speech model"}
            description={models.find((m) => m.id === modelFor(settings, provider))?.description || undefined}
          >
            <DropdownMenu
              label="Voice model"
              align="end"
              className="w-56"
              value={modelFor(settings, provider)}
              onChange={(m) => setVoiceModel(provider, m)}
              items={models.map((m) => ({ value: m.id, label: m.name }))}
            />
          </Setting>
          {provider === "sarvam" && (
            <Setting title="Thinks with" description="Sarvam's own model knows India best. Or let the chat's model answer, in Sarvam's voice.">
              <Segmented
                label="Thinks with"
                value={settings.sarvamBrain}
                onChange={(v) => setVoiceModeSettings({ sarvamBrain: v })}
                options={[
                  { value: "sarvam", label: "Sarvam 105B" },
                  { value: "chat", label: "Chat model" },
                ]}
              />
            </Setting>
          )}
          {provider === "elevenlabs" && (
            <Setting title="Thinks with" description="ElevenLabs listens and speaks; the model picked in the chat answers.">
              <span className="text-sm text-muted-foreground">Chat model</span>
            </Setting>
          )}
          <Setting
            title="Pick up whispers"
            description="Lifts quiet speech so a whisper is heard like your normal voice. Turn it off if a noisy room keeps cutting in."
          >
            <Switch
              checked={settings.whispers !== false}
              onCheckedChange={(whispers) => setVoiceModeSettings({ whispers })}
              aria-label="Pick up whispers"
            />
          </Setting>
          <Setting
            title="Input sensitivity"
            description="Automatic adapts to the room. Set it yourself if background noise keeps cutting in: anything quieter than the line is ignored."
          >
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              Automatic
              <Switch
                checked={!settings.manualGate}
                onCheckedChange={(auto) => setVoiceModeSettings({ manualGate: !auto })}
                aria-label="Set input sensitivity automatically"
              />
            </label>
          </Setting>
          {settings.manualGate && (
            <SensitivityMeter db={settings.gateDb ?? DEFAULT_GATE_DB} onChange={(gateDb) => setVoiceModeSettings({ gateDb })} />
          )}
          <Setting title="In a call" description="What floats above the call's bar: the voice's glass orb, or Sushi talking along with it.">
            <Segmented
              label="In a call"
              value={settings.figure ?? "orb"}
              onChange={(figure) => setVoiceModeSettings({ figure })}
              options={[
                { value: "orb", label: "Orb" },
                { value: "sushi", label: "Sushi" },
              ]}
            />
          </Setting>
          <div className="flex flex-col gap-2 py-3">
            <div>
              <p className="text-sm font-medium">Personality</p>
              <p className="mt-0.5 text-sm text-muted-foreground">Optional. How the voice should come across.</p>
            </div>
            <Textarea
              aria-label="Personality"
              rows={2}
              placeholder="A patient tutor who asks me questions back."
              defaultValue={settings.personality}
              onBlur={(e) => setVoiceModeSettings({ personality: e.target.value })}
              className="resize-none"
            />
          </div>
        </Group>
      )}

      {provider && <VoicePicker provider={provider} voices={catalog?.voices ?? null} />}
    </Page>
  );
}

const METER_MIN = -80;
const METER_MAX = -10;
const meterPct = (db: number) => Math.max(0, Math.min(100, ((db - METER_MIN) / (METER_MAX - METER_MIN)) * 100));

/**
 * The input gate, set by hand: the mic's live level along a bar, with the gate
 * as a handle on it (Discord's input sensitivity). The level shows green past
 * the handle, where the call would hear it. The mic is open only while this shows.
 */
function SensitivityMeter({ db, onChange }: { db: number; onChange: (db: number) => void }) {
  const fill = useRef<HTMLDivElement>(null);
  const level = useRef(0);
  const gate = useRef(db);
  gate.current = db;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mic: Mic | null = null;
    let stopped = false;
    let frame = 0;
    openMic((_s, _loud, raw) => {
      // Rise at once, fall slowly, like a peak meter.
      level.current = Math.max(raw, level.current * 0.85);
    })
      .then((m) => {
        if (stopped) m.stop();
        else mic = m;
      })
      .catch(() => setError("Allow the microphone to see your level."));
    const draw = () => {
      const el = fill.current;
      if (el) {
        const now = rmsToDb(level.current);
        el.style.width = `${meterPct(now)}%`;
        el.dataset.open = String(level.current >= dbToRms(gate.current));
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      mic?.stop();
    };
  }, []);

  return (
    <div className="pb-3">
      <div className="relative h-7">
        <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 overflow-hidden rounded-full bg-muted">
          <div
            ref={fill}
            className="h-full rounded-full bg-amber-500/70 transition-[width] duration-75 data-[open=true]:bg-emerald-500"
            style={{ width: 0 }}
          />
        </div>
        <input
          type="range"
          min={METER_MIN}
          max={METER_MAX}
          step={1}
          value={db}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label="Input sensitivity"
          aria-valuetext={`${db} dB`}
          className="peer absolute inset-0 w-full cursor-pointer opacity-0"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 h-6 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground shadow-sm ring-offset-2 ring-offset-background peer-focus-visible:ring-2 peer-focus-visible:ring-ring/60"
          style={{ left: `${meterPct(db)}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{error ?? "Talk normally: your voice should reach past the line, and the room shouldn't."}</span>
        <span className="tabular-nums">{db} dB</span>
      </div>
    </div>
  );
}

/** The provider's mark: its logo where one's bundled, else its initial. */
function ProviderMark({ id, name }: { id: VoiceProvider; name: string }) {
  const src = logoBySlug(id);
  return (
    <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-foreground shadow-xs">
      {src ? <Logo src={src} className="size-[18px]" /> : <span className="text-sm font-semibold">{name[0]}</span>}
    </span>
  );
}

function ProviderCard({
  info,
  hasKey,
  selected,
  onSelect,
  onChanged,
}: {
  info: VoiceProviderInfo;
  hasKey: boolean;
  selected: boolean;
  onSelect: () => void;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.voiceKeySet(info.id, draft);
      setDraft("");
      setEditing(false);
      await onChanged();
      onSelect();
      toast.success(`${info.name} is ready to talk`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await api.voiceKeyDelete(info.id);
      await onChanged();
    } catch (e) {
      toast.error(`Couldn't remove the key: ${errorMessage(e)}`);
    }
  };

  return (
    <div
      className={cn(
        "relative flex flex-col justify-between gap-4 rounded-xl border p-4 transition-[background-color,border-color,box-shadow] duration-200",
        selected ? "border-brand/50 bg-brand/[0.05] shadow-[0_0_0_3px_color-mix(in_oklch,var(--brand)_12%,transparent)]" : hasKey && "hover:border-foreground/20",
      )}
    >
      {hasKey && (
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          aria-label={`Talk to ${info.name}`}
          onClick={onSelect}
          className="absolute inset-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        />
      )}
      <div className="pointer-events-none flex items-start gap-3">
        <ProviderMark id={info.id} name={info.name} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            {info.name}
            <span className="rounded-full bg-foreground/[0.06] px-1.5 py-px text-[11px] font-normal text-muted-foreground dark:bg-white/10">
              {info.realtime ? "Realtime" : "Turn by turn"}
            </span>
          </p>
          <p className="mt-1 text-[13px] leading-snug text-muted-foreground">{info.blurb}</p>
        </div>
        {hasKey ? (
          <span
            aria-hidden
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
              selected ? "border-brand bg-brand text-brand-foreground" : "border-foreground/15",
            )}
          >
            {selected && <CheckIcon className="size-3" strokeWidth={3} />}
          </span>
        ) : (
          <GetKeyLink url={info.keyUrl} />
        )}
      </div>

      {hasKey ? (
        <div className="flex items-center justify-between text-xs">
          <span className="pointer-events-none flex items-center gap-1.5 text-muted-foreground">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            Key saved
          </span>
          <button type="button" onClick={() => void remove()} className="relative z-10 text-muted-foreground transition-colors hover:text-destructive">
            Remove
          </button>
        </div>
      ) : editing ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          onBlur={(e) => {
            // Leaving an empty field closes it, so a card never sits open with nothing in it.
            if (!draft.trim() && !e.currentTarget.contains(e.relatedTarget as Node | null)) setEditing(false);
          }}
        >
          <Input
            autoFocus
            type="password"
            aria-label={`${info.name} API key`}
            placeholder="Paste your API key"
            className="h-8 flex-1"
            value={draft}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setDraft("");
                setEditing(false);
              }
            }}
          />
          <Button
            type="button"
            variant="ghost"
            className="text-muted-foreground"
            disabled={saving}
            onClick={() => {
              setDraft("");
              setEditing(false);
            }}
          >
            Cancel
          </Button>
          {draft.trim() && (
            <Button type="submit" disabled={saving}>
              {saving ? "Checking…" : "Save"}
            </Button>
          )}
        </form>
      ) : (
        <div>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            Add key
          </Button>
        </div>
      )}
    </div>
  );
}

function GetKeyLink({ url }: { url: string }) {
  return (
    <button
      type="button"
      onClick={() => void openUrl(url)}
      className="pointer-events-auto relative z-10 flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      Get a key <ExternalLinkIcon className="size-3" />
    </button>
  );
}

type GenderFilter = "all" | VoiceGender;

const GENDER_LABEL: Record<VoiceGender, string> = { female: "Female", male: "Male", neutral: "Neutral" };

/** One shared player, so starting a preview stops the last. */
let previewPlayer: Player | null = null;

function VoicePicker({ provider, voices }: { provider: VoiceProvider; voices: VoiceInfo[] | null }) {
  const settings = useVoiceModeSettings();
  const selected = voiceFor(settings, provider);
  const [filter, setFilter] = useState<GenderFilter>("all");
  const [previewing, setPreviewing] = useState<{ id: string; loading: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    setFilter("all");
    return () => {
      clearInterval(timer.current);
      previewPlayer?.stop();
    };
  }, [provider]);

  const has = (g: VoiceGender) => voices?.some((v) => v.gender === g);
  const shown = (voices ?? []).filter((v) => filter === "all" || v.gender === filter);
  const filters: { value: GenderFilter; label: string }[] = [
    { value: "all", label: "All" },
    ...(["female", "male", "neutral"] as VoiceGender[]).filter(has).map((g) => ({ value: g as GenderFilter, label: GENDER_LABEL[g] })),
  ];

  const preview = async (voice: VoiceInfo) => {
    clearInterval(timer.current);
    previewPlayer?.stop();
    if (previewing?.id === voice.id) return setPreviewing(null);
    setPreviewing({ id: voice.id, loading: true });
    try {
      const text = `Hi, I'm ${voice.name}. Ask me anything, and cut in whenever you like.`;
      const audio = await api.voiceSpeak(provider, modelFor(settings, provider), voice.id, text, null);
      previewPlayer ??= new Player();
      await previewPlayer.pushEncoded(audio.data);
      setPreviewing((p) => (p?.id === voice.id ? { id: voice.id, loading: false } : p));
      timer.current = setInterval(() => {
        if (previewPlayer?.playing()) return;
        clearInterval(timer.current);
        setPreviewing((p) => (p?.id === voice.id ? null : p));
      }, 200);
    } catch (e) {
      setPreviewing(null);
      toast.error(`Couldn't play ${voice.name}`, { description: errorMessage(e) });
    }
  };

  return (
    <section>
      <div className="flex items-center justify-between gap-4 pb-3">
        <h2 className="text-base font-semibold">Voice</h2>
        {filters.length > 2 && <Segmented label="Filter voices" value={filter} onChange={setFilter} options={filters} />}
      </div>
      {voices === null ? (
        <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
          <Loader2Icon className="mr-2 size-4 animate-spin" /> Loading voices…
        </div>
      ) : (
        <div role="radiogroup" aria-label="Voice" className="grid grid-cols-2 gap-2 lg:grid-cols-3">
          {shown.map((v) => {
            const isSelected = v.id === selected;
            const isPreviewing = previewing?.id === v.id;
            return (
              <div
                key={v.id}
                className={cn(
                  "group relative flex items-center gap-3 rounded-xl border p-3 transition-colors",
                  isSelected ? "border-brand/50 bg-brand/[0.06]" : "hover:bg-foreground/[0.03] dark:hover:bg-white/5",
                )}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => setVoiceChoice(provider, v.id)}
                  className="absolute inset-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  <span className="sr-only">
                    {v.name}, {GENDER_LABEL[v.gender]}
                  </span>
                </button>
                <VoiceAvatar voice={v} active={isPreviewing && !previewing?.loading} />
                <div className="pointer-events-none min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                    {v.name}
                    {isSelected && <CheckIcon aria-hidden className="size-3.5 shrink-0 text-brand" />}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {GENDER_LABEL[v.gender]} · {v.description}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={isPreviewing ? `Stop ${v.name}` : `Hear ${v.name}`}
                  onClick={() => void preview(v)}
                  className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                >
                  {isPreviewing && previewing?.loading ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : isPreviewing ? (
                    <SquareIcon className="size-3 fill-current" />
                  ) : (
                    <PlayIcon className="size-3.5 fill-current" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {provider === "sarvam" && <p className="mt-3 text-xs text-muted-foreground">Sarvam doesn't label its voices; they're grouped by name.</p>}
    </section>
  );
}

/** Each voice's own glass orb, the same one its calls show; it floats while the voice plays. */
function VoiceAvatar({ voice, active }: { voice: VoiceInfo; active: boolean }) {
  return <GlassOrb seed={voice.id} size={36} float={active} />;
}
