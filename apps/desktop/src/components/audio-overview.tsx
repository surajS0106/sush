// A notebook's audio overview: two hosts talking its sources through. The
// script is a Studio output (`studio_save`); this voices and plays it. With
// the computer's voices (Settings → Speech → Audio overviews) it's read live;
// with a provider's, each turn is voiced once (`tts_speak`), kept with the
// note, and played back in order. The transcript follows along and jumps on
// click; each line can open the passage it rests on.

import { PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon, SquareIcon, Volume2Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { SourceChip } from "@/components/notebook-play";
import { Button } from "@/components/ui/button";
import { openSettings } from "@/lib/library";
import { api, errorMessage, type AudioOverviewData, type AudioTurn, type NotebookNote } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { DELIVERY, systemVoiceFor, useVoiceSettings, voicesKey, type VoiceSettings } from "@/lib/voices";

const RATES = [0.75, 1, 1.25, 1.5, 2];
const WORDS_PER_MINUTE = 155;

type Line = { chapter: number; index: number; turn: AudioTurn };

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** `guest`: someone watching a shared notebook chat; the clips are the host's, so their computer reads it aloud. */
export function AudioOverviewView({ note, guest }: { note: Pick<NotebookNote, "id" | "data">; guest?: boolean }) {
  const data = note.data as AudioOverviewData;
  const own = useVoiceSettings();
  const settings: VoiceSettings = guest ? { ...own, engine: "system" } : own;
  const lines = useMemo<Line[]>(
    () => data.chapters.flatMap((c, chapter) => c.turns.map((turn, index) => ({ chapter, index, turn }))),
    [data],
  );
  const totalWords = useMemo(() => lines.reduce((n, l) => n + words(l.turn.text), 0), [lines]);
  const minutes = Math.max(1, Math.round(totalWords / WORDS_PER_MINUTE));
  const key = voicesKey(settings);
  const provider = settings.engine === "provider";
  const voiced = !provider || (data.voices === key && lines.every((l) => l.turn.audio));
  const configured = !provider || (!!settings.providerId && !!settings.model.trim() && !!settings.voiceA.trim() && !!settings.voiceB.trim());

  return (
    <div className="flex flex-col gap-4">
      {!configured ? (
        <div className="flex flex-col items-start gap-2 rounded-xl border bg-card p-4 text-sm">
          <p className="font-medium">Choose the voices</p>
          <p className="text-muted-foreground">Pick a provider, model and two voices in Settings → Speech, or use this computer’s voices.</p>
          <Button variant="outline" size="sm" onClick={() => openSettings({ section: "speech" })}>
            Open Settings
          </Button>
        </div>
      ) : voiced ? (
        <Player lines={lines} chapters={data.chapters.map((c) => c.title)} settings={settings} minutes={minutes} totalWords={totalWords} />
      ) : (
        <MakeAudio note={note} data={data} lines={lines} settings={settings} minutes={minutes} />
      )}
    </div>
  );
}

/** Voice every turn that has no clip from the current voices, keeping progress as it goes. */
function MakeAudio({ note, data, lines, settings, minutes }: { note: Pick<NotebookNote, "id">; data: AudioOverviewData; lines: Line[]; settings: VoiceSettings; minutes: number }) {
  const [done, setDone] = useState<number | null>(null);
  const stop = useRef(false);
  const key = voicesKey(settings);
  const kept = data.voices === key ? lines.filter((l) => l.turn.audio).length : 0;

  const make = async () => {
    stop.current = false;
    // Start from what's kept for these voices; clips from other voices are made again.
    const next: AudioOverviewData = {
      voices: key,
      chapters: data.chapters.map((c) => ({ ...c, turns: c.turns.map((t) => ({ ...t, audio: data.voices === key ? t.audio : null })) })),
    };
    let made = next.chapters.reduce((n, c) => n + c.turns.filter((t) => t.audio).length, 0);
    setDone(made);
    try {
      for (const c of next.chapters) {
        for (const t of c.turns) {
          if (stop.current) throw new Error("stopped");
          if (t.audio) continue;
          t.audio = await api.ttsSpeak(settings.providerId!, settings.model.trim(), (t.host === "a" ? settings.voiceA : settings.voiceB).trim(), t.text, DELIVERY);
          made += 1;
          setDone(made);
          // Kept as it goes, so a stop or an error loses little.
          if (made % 8 === 0) await api.notebookNoteSetData(note.id, next);
        }
      }
      await api.notebookNoteSetData(note.id, next);
    } catch (e) {
      await api.notebookNoteSetData(note.id, next).catch(() => {});
      if (!(e instanceof Error && e.message === "stopped")) toast.error("Couldn’t make the audio", { description: errorMessage(e) });
    } finally {
      setDone(null);
    }
  };

  const working = done !== null;
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border bg-card p-4">
      <span className="flex size-9 items-center justify-center rounded-lg bg-brand/10 text-brand">
        <Volume2Icon className="size-4" aria-hidden />
      </span>
      <div>
        <p className="text-sm font-medium">{working ? "Making the audio…" : kept > 0 ? "Finish the audio" : "Make the audio"}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {lines.length} lines, about {minutes} minutes, voiced once with {settings.model} and kept with this overview.
        </p>
      </div>
      {working && (
        <div className="w-full" role="status">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${((done ?? 0) / lines.length) * 100}%` }} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {done} of {lines.length} lines
          </p>
        </div>
      )}
      {working ? (
        <Button variant="outline" size="sm" onClick={() => (stop.current = true)}>
          <SquareIcon /> Stop
        </Button>
      ) : (
        <Button size="sm" onClick={() => void make()}>
          <Volume2Icon /> {kept > 0 ? `Make the other ${lines.length - kept}` : "Make the audio"}
        </Button>
      )}
    </div>
  );
}

function Player({
  lines,
  chapters,
  settings,
  minutes,
  totalWords,
}: {
  lines: Line[];
  chapters: string[];
  settings: VoiceSettings;
  minutes: number;
  totalWords: number;
}) {
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const audio = useRef<HTMLAudioElement | null>(null);
  // Each start gets a token; an end event from a line that was replaced is ignored.
  const token = useRef(0);
  const transcript = useRef<HTMLOListElement>(null);
  const provider = settings.engine === "provider";

  const advance = (mine: number) => {
    if (mine !== token.current) return;
    setAt((i) => {
      if (i + 1 < lines.length) return i + 1;
      setPlaying(false);
      return 0;
    });
  };

  useEffect(() => {
    const mine = ++token.current;
    audio.current?.pause();
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    if (!playing) return;
    const line = lines[at].turn;
    if (provider) {
      const el = audio.current ?? (audio.current = new Audio());
      el.src = line.audio ?? "";
      el.playbackRate = rate;
      el.onended = () => advance(mine);
      el.play().catch((e) => {
        toast.error("Couldn’t play that line", { description: errorMessage(e) });
        setPlaying(false);
      });
      // The next line, fetched ahead so the hand-off has no gap.
      const ahead = lines[at + 1]?.turn.audio;
      if (ahead) new Audio(ahead).preload = "auto";
    } else {
      const u = new SpeechSynthesisUtterance(line.text);
      const voice = systemVoiceFor(line.host, settings);
      if (voice) u.voice = voice;
      u.rate = rate;
      u.onend = () => advance(mine);
      speechSynthesis.speak(u);
    }
    // Rate changes apply live to clips; a spoken line picks them up from the next one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, playing, provider, lines]);

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = rate;
  }, [rate]);

  // Stop when the overview closes.
  useEffect(
    () => () => {
      token.current++;
      audio.current?.pause();
      if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    },
    [],
  );

  // Keep the line being spoken in view.
  useEffect(() => {
    transcript.current?.querySelector(`[data-line="${at}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [at]);

  const jump = (i: number) => {
    setAt(Math.max(0, Math.min(i, lines.length - 1)));
    setPlaying(true);
  };
  const spoken = lines.slice(0, at).reduce((n, l) => n + words(l.turn.text), 0);
  const elapsed = Math.round(spoken / WORDS_PER_MINUTE);
  const chapterStarts = chapters.map((_, c) => lines.findIndex((l) => l.chapter === c));
  const current = lines[at];

  return (
    <>
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" aria-label="Previous line" disabled={at === 0} onClick={() => jump(at - 1)}>
            <SkipBackIcon />
          </Button>
          <Button size="icon-lg" className="rounded-full" aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying((p) => !p)}>
            {playing ? <PauseIcon /> : <PlayIcon />}
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next line" disabled={at >= lines.length - 1} onClick={() => jump(at + 1)}>
            <SkipForwardIcon />
          </Button>
          <div className="ml-1 min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{chapters[current.chapter]}</p>
            <p className="text-xs text-muted-foreground">
              {elapsed} of about {minutes} min · {provider ? settings.model : "this computer’s voices"}
            </p>
          </div>
          <label className="sr-only" htmlFor="overview-rate">
            Speed
          </label>
          <select
            id="overview-rate"
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            className="h-8 rounded-md border bg-background px-1.5 text-xs"
          >
            {RATES.map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
        </div>
        {/* Seek by where the words fall, a click anywhere along it. */}
        <div
          role="slider"
          tabIndex={0}
          aria-label="Position"
          aria-valuemin={1}
          aria-valuemax={lines.length}
          aria-valuenow={at + 1}
          aria-valuetext={`Line ${at + 1} of ${lines.length}`}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") jump(at + 1);
            else if (e.key === "ArrowLeft") jump(at - 1);
          }}
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            const goal = ((e.clientX - box.left) / box.width) * totalWords;
            let n = 0;
            const i = lines.findIndex((l) => (n += words(l.turn.text)) >= goal);
            jump(i < 0 ? lines.length - 1 : i);
          }}
          className="relative h-2 cursor-pointer rounded-full bg-muted outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${(spoken / Math.max(totalWords, 1)) * 100}%` }} />
          {chapterStarts.slice(1).map((start, c) => {
            const before = lines.slice(0, start).reduce((n, l) => n + words(l.turn.text), 0);
            return <span key={c} aria-hidden className="absolute top-0 h-full w-0.5 bg-background" style={{ left: `${(before / totalWords) * 100}%` }} />;
          })}
        </div>
        {chapters.length > 1 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Chapters">
            {chapters.map((title, c) => (
              <li key={c}>
                <button
                  type="button"
                  onClick={() => jump(chapterStarts[c])}
                  aria-current={current.chapter === c ? "true" : undefined}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs transition-colors outline-none hover:border-brand/40 focus-visible:ring-2 focus-visible:ring-brand/40",
                    current.chapter === c ? "border-brand/50 bg-brand/10 text-foreground" : "text-muted-foreground",
                  )}
                >
                  {title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ol ref={transcript} className="flex flex-col gap-1" aria-label="Transcript">
        {lines.map((l, i) => (
          <li key={i} data-line={i} className="scroll-mt-4">
            {l.index === 0 && <p className="mt-3 mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{chapters[l.chapter]}</p>}
            <div
              className={cn(
                "group flex gap-3 rounded-lg px-2 py-1.5 transition-colors",
                i === at ? "bg-brand/10" : "hover:bg-muted/60",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex h-5 shrink-0 items-center rounded px-1.5 text-[10px] font-semibold tracking-wide uppercase",
                  l.turn.host === "a" ? "bg-brand text-brand-foreground" : "bg-foreground/10 text-foreground",
                )}
              >
                {l.turn.host === "a" ? "Host 1" : "Host 2"}
              </span>
              <div className="min-w-0 flex-1">
                <button type="button" onClick={() => jump(i)} className="text-left text-sm leading-relaxed outline-none focus-visible:underline" aria-current={i === at ? "true" : undefined}>
                  {l.turn.text}
                </button>
                {l.turn.source && <SourceChip source={l.turn.source} className="mt-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
