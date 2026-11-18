// One voice conversation. Realtime providers (OpenAI, xAI) hear and answer in
// one model over a socket held in Rust; the others go listen → transcribe →
// think → speak, sentence by sentence so the first words come quickly. Either
// way the user can cut in by talking, and the finished turns join the chat.

import { Channel } from "@tauri-apps/api/core";

import { appendTurns } from "@/lib/sessions";
import { wavBase64 } from "@/lib/speech";
import { api, errorMessage, isEngine, type CoreMessage, type StreamFrame, type VoiceEvent, type VoiceProvider, type VoiceTranscript } from "@/lib/tauri";
import type { ModelTarget, SushUIMessage } from "@/lib/transport";
import { BargeIn, openMic, pcm16Base64, Player, TurnDetector, VOICE_RATE, type Mic } from "@/lib/voice-audio";

export type VoiceStatus = "connecting" | "listening" | "hearing" | "thinking" | "speaking" | "error";

export interface Line {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
  /** The user cut this answer short. */
  cut?: boolean;
}

export interface VoiceState {
  status: VoiceStatus;
  muted: boolean;
  lines: Line[];
  error: string | null;
}

export interface VoiceOptions {
  threadId: string;
  provider: VoiceProvider;
  model: string;
  voice: string;
  personality: string;
  /** The chat so far, for context. */
  history: SushUIMessage[];
  /** Who answers a turn-by-turn conversation: Sarvam's own model (null), or the chat's model. */
  brain: ModelTarget | null;
  /** Lift quiet speech, so a whisper is heard. */
  whispers: boolean;
}

const BASE_INSTRUCTIONS = `You are Sush, talking with the user out loud in a hands-free voice conversation.
Speak the way a thoughtful person does on a call: natural, warm and direct. Keep answers short, usually one to three sentences, and go longer only when asked.
Everything you say is heard, not read: never use markdown, lists, headings, code, links, emoji or symbols. Say numbers, dates and units the way people say them.
If the user interrupts, stop and follow their lead. If they ask you to talk faster or slower, briefer or in more detail, keep doing so for the rest of the call.
Answer in the language the user speaks, and switch when they do.`;

const textOf = (m: SushUIMessage) =>
  m.parts
    .flatMap((p) => (p.type === "text" && p.text.trim() ? [p.text.trim()] : []))
    .join("\n")
    .trim();

/** The chat's last messages as plain text: what the voice model is told came before. */
function recentText(history: SushUIMessage[], budget = 6000): { role: "user" | "assistant"; text: string }[] {
  const out: { role: "user" | "assistant"; text: string }[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0 && used < budget; i--) {
    const m = history[i];
    if (m.role !== "user" && m.role !== "assistant") continue;
    let text = textOf(m);
    if (!text) continue;
    if (text.length > budget - used) text = `…${text.slice(text.length - (budget - used))}`;
    used += text.length;
    out.unshift({ role: m.role, text });
  }
  return out;
}

function instructions(opts: VoiceOptions, withHistory: boolean) {
  let out = BASE_INSTRUCTIONS;
  if (opts.personality.trim()) out += `\n\nHow to come across, from the user: ${opts.personality.trim()}`;
  const before = withHistory ? recentText(opts.history) : [];
  if (before.length) {
    out += "\n\nThis call continues a text chat. What was said there, oldest first:\n";
    out += before.map((m) => `${m.role === "user" ? "User" : "You"}: ${m.text}`).join("\n\n");
  }
  return out;
}

/** Text ready to speak: whole sentences, once there's enough of them to sound natural. */
function takeSentences(buffer: string, final: boolean): [string[], string] {
  const out: string[] = [];
  let rest = buffer;
  for (;;) {
    const match = /^([\s\S]*?[.!?।…:;](?=\s)|[\s\S]*?\n)\s*/.exec(rest);
    if (!match) break;
    const sentence = match[1].trim();
    // Join short fragments ("Sure.") to what follows, so they don't sound clipped.
    if (sentence.length < 24 && match[0].length < rest.length && !final) {
      const more = /^[\s\S]*?[.!?।…](?=\s)\s*/.exec(rest.slice(match[0].length));
      if (!more) break;
      out.push(rest.slice(0, match[0].length + more[0].length).trim());
      rest = rest.slice(match[0].length + more[0].length);
      continue;
    }
    if (sentence) out.push(sentence);
    rest = rest.slice(match[0].length);
  }
  if (final && rest.trim()) {
    out.push(rest.trim());
    rest = "";
  }
  return [out.map(speakable).filter(Boolean), rest];
}

/** Strip what reads but doesn't speak, in case the model formats anyway. */
const speakable = (s: string) =>
  s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_#>~|]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();

/** How long a "you said…" placeholder waits for its words before it's taken away. */
const PLACEHOLDER_MS = 10_000;

/** A brisk speaking pace, so captions never run ahead of the voice. */
const CHARS_PER_SECOND = 17;

export class VoiceConversation {
  state: VoiceState = { status: "connecting", muted: false, lines: [], error: null };
  private listeners = new Set<() => void>();
  private mic: Mic | null = null;
  private player = new Player();
  private ended = false;
  private saved = 0;

  // realtime
  private sessionId = crypto.randomUUID();
  private responding = false;
  private pendingUser: string[] = [];
  /** Answers whose audio has started arriving. */
  private voiced = new Set<string>();
  /** Turn by turn: each answer's sentences, with when each starts playing. */
  private cues = new Map<string, { at: number; text: string }[]>();

  // turn by turn
  private turns: TurnDetector | null = null;
  private generation = 0;
  private streamId: string | null = null;
  private speaking: Promise<void> = Promise.resolve();
  private thinkingDone = true;
  private language: string | null = null;

  constructor(private opts: VoiceOptions) {}

  get realtime() {
    return this.opts.provider === "openai" || this.opts.provider === "xai";
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<VoiceState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  private setLines(change: (lines: Line[]) => Line[]) {
    this.set({ lines: change(this.state.lines) });
  }

  /** Input and output loudness for the orb, 0..1. */
  levels() {
    return { input: this.mic?.level() ?? 0, output: this.player.level() };
  }

  private fail(message: string) {
    this.set({ status: "error", error: message });
  }

  async start() {
    try {
      if (this.realtime) await this.startRealtime();
      else await this.startTurns();
    } catch (e) {
      if (!this.ended) this.fail(micMessage(e));
    }
  }

  setMuted(muted: boolean) {
    this.mic?.setMuted(muted);
    if (muted) this.turns?.reset();
    this.set({ muted });
  }

  /**
   * What of a line to show. A realtime transcript arrives well ahead of its
   * audio, so the answer being spoken is shown only as far as it has been
   * heard: its share of the audio so far, and never faster than speech.
   */
  visibleText(line: Line): string {
    if (line.role !== "assistant" || line.cut) return line.text;
    if (!this.realtime) {
      // Sentence by sentence, each as its audio starts.
      const cues = this.cues.get(line.id);
      if (!cues) return line.final ? line.text : "";
      if (line.final && !this.player.playing()) return line.text;
      const now = this.player.now();
      return cues
        .filter((c) => c.at <= now)
        .map((c) => c.text)
        .join(" ");
    }
    // Words that came before any of their audio wait for the voice.
    if (!line.final && !this.voiced.has(line.id)) return "";
    const p = this.player.progress();
    if (!p || p.itemId !== line.id) return line.text;
    const byAudio = line.text.length * (p.heardMs / p.queuedMs);
    const bySpeech = (p.heardMs / 1000) * CHARS_PER_SECOND;
    const upTo = Math.floor(Math.min(byAudio, bySpeech));
    if (upTo >= line.text.length) return line.text;
    // Whole words only.
    const cut = line.text.lastIndexOf(" ", upTo);
    return cut > 0 ? line.text.slice(0, cut) : "";
  }

  /** Remove a user placeholder that never got words (now, if `final`, or only while it's still empty). */
  private dropIfEmpty(id: string, final = false) {
    if (this.ended) return;
    const line = this.state.lines.find((l) => l.id === id);
    if (!line || line.role !== "user" || line.text.trim() || (line.final && !final)) return;
    this.pendingUser = this.pendingUser.filter((p) => p !== id);
    this.setLines((lines) => lines.filter((l) => l.id !== id));
  }

  /** Stop the answer now (a tap on the orb), as if the user had started talking. */
  interrupt() {
    if (this.state.status !== "speaking" && this.state.status !== "thinking") return;
    if (this.realtime) {
      this.cutRealtime();
    } else {
      this.cutTurn();
    }
    this.set({ status: "listening" });
  }

  /** Hang up; the finished turns are added to the chat. */
  end() {
    if (this.ended) return;
    this.ended = true;
    this.mic?.stop();
    this.player.close();
    if (this.streamId) void api.cancelStream(this.streamId);
    if (this.realtime) void api.voiceRealtimeEnd(this.sessionId);
    this.save();
    this.listeners.clear();
  }

  /** Add the turns spoken so far to the chat, user and assistant alike. */
  private save() {
    const lines = this.state.lines.slice(this.saved).filter((l) => l.text.trim());
    this.saved = this.state.lines.length;
    const now = Date.now();
    const voice = { provider: this.opts.provider, voice: this.opts.voice };
    const turns = lines.map((l): SushUIMessage =>
      l.role === "user"
        ? { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: l.text.trim() }], metadata: { voice } }
        : {
            id: crypto.randomUUID(),
            role: "assistant",
            parts: [{ type: "text", text: l.text.trim() }],
            metadata: { voice, createdAt: now, ...(this.opts.brain && !this.realtime ? { providerId: this.opts.brain.providerId, model: this.opts.brain.model } : { model: this.opts.model }) },
          },
    );
    appendTurns(this.opts.threadId, turns);
  }

  // --- realtime ------------------------------------------------------------------------

  private async startRealtime() {
    const channel = new Channel<VoiceEvent>();
    channel.onmessage = (e) => this.onRealtime(e);
    await api.voiceRealtimeStart(this.sessionId, this.opts.provider, this.opts.model, this.opts.voice, instructions(this.opts, true), channel);
    if (this.ended) return void api.voiceRealtimeEnd(this.sessionId);
    // The server hears the user too, but echo cancellation turns their voice down while the answer plays,
    // so its detector can miss a "stop". This one, here, listens for the user over the answer and cuts at once.
    const bargeIn = new BargeIn();
    this.mic = await openMic(
      (samples, _loud, raw) => {
        void api.voiceRealtimeAudio(this.sessionId, pcm16Base64(samples)).catch(() => {});
        const playing = this.player.playing();
        if (!this.state.muted && bargeIn.push(raw, this.player.outputRms(), playing) && playing) {
          this.cutRealtime();
          this.set({ status: "hearing" });
        }
      },
      { whispers: this.opts.whispers },
    );
    if (this.ended) this.mic.stop();
    this.mic.setMuted(this.state.muted);
  }

  private cutRealtime() {
    this.trimToHeard();
    const { itemId, heardMs } = this.player.stop();
    if (this.responding || itemId) void api.voiceRealtimeInterrupt(this.sessionId, itemId, heardMs);
    this.responding = false;
  }

  /**
   * The user cut in: each answer keeps only the words they heard. Its text can
   * be far ahead of its audio, and can even be complete while the voice is
   * mid-sentence, so this goes by what was heard, not by what had arrived.
   * Call before stopping the player, while it still knows how far it got.
   */
  private trimToHeard() {
    const heard = new Map(this.state.lines.filter((l) => l.role === "assistant" && !l.cut).map((l) => [l.id, this.visibleText(l)]));
    this.setLines((lines) =>
      lines.map((l) => {
        const text = heard.get(l.id);
        if (text === undefined || (l.final && text === l.text)) return l;
        return { ...l, text, final: true, cut: true };
      }),
    );
  }

  private onRealtime(e: VoiceEvent) {
    if (this.ended) return;
    switch (e.type) {
      case "ready":
        if (this.state.status === "connecting") this.set({ status: "listening" });
        break;
      case "speech-started":
        if (this.player.playing() || this.responding) this.cutRealtime();
        this.set({ status: "hearing" });
        break;
      case "speech-stopped": {
        // A placeholder for what they said, so it sits before the answer even if its transcript comes later.
        // It carries the item its words will arrive on, so they land in it and nowhere else; only a server
        // that doesn't say which item falls back to filling placeholders in order.
        const id = e.itemId || `pending-${crypto.randomUUID()}`;
        // Their words may already be streaming into a bubble of their own (xAI transcribes as they speak):
        // then that bubble is the placeholder.
        if (this.state.lines.at(-1)?.role === "user") {
          this.set({ status: "thinking" });
          break;
        }
        if (!e.itemId) this.pendingUser.push(id);
        if (!this.state.lines.some((l) => l.id === id)) this.setLines((lines) => [...lines, { id, role: "user", text: "", final: false }]);
        // Noise or the answer's own echo can count as speech and never be transcribed: don't leave it waiting.
        setTimeout(() => this.dropIfEmpty(id), PLACEHOLDER_MS);
        this.set({ status: "thinking" });
        break;
      }
      case "user-transcript": {
        const known = this.state.lines.find((l) => l.id === e.itemId);
        if (known) {
          if (e.done && !e.text.trim()) this.dropIfEmpty(e.itemId, true);
          else this.setLines((lines) => lines.map((l) => (l.id === e.itemId ? { ...l, text: e.done ? e.text : l.text + e.text, final: e.done } : l)));
        } else {
          const pending = this.pendingUser.shift();
          if (e.done && !e.text.trim()) {
            if (pending) this.dropIfEmpty(pending, true);
            break;
          }
          const line: Line = { id: e.itemId, role: "user", text: e.text, final: e.done };
          this.setLines((lines) => {
            if (pending && lines.some((l) => l.id === pending)) return lines.map((l) => (l.id === pending ? line : l));
            // Words with no placeholder left: they come before the answer now being given, not after it.
            const last = lines.at(-1);
            return last?.role === "assistant" && !last.final ? [...lines.slice(0, -1), line, last] : [...lines, line];
          });
        }
        break;
      }
      case "audio":
        // The server keeps streaming an answer for a moment after it's told to stop: once the user has cut
        // it off, the rest of its audio is dropped, not played.
        if (this.state.lines.some((l) => l.id === e.itemId && l.cut)) break;
        this.responding = true;
        this.voiced.add(e.itemId);
        this.player.pushPcm(e.itemId, e.data);
        this.ensureAssistant(e.itemId);
        if (this.state.status !== "speaking") this.set({ status: "speaking" });
        this.watchPlayback();
        break;
      case "assistant-transcript":
        this.ensureAssistant(e.itemId);
        this.setLines((lines) =>
          lines.map((l) => (l.id === e.itemId && !l.cut ? { ...l, text: e.done ? e.text : l.text + e.text, final: e.done } : l)),
        );
        break;
      case "response-done":
        this.responding = false;
        this.setLines((lines) => lines.map((l) => (l.role === "assistant" && !l.final ? { ...l, final: true } : l)));
        this.watchPlayback();
        break;
      case "error":
        // Mid-call errors are usually about one request; say so without ending the call.
        if (this.state.status === "connecting") this.fail(e.message);
        else this.set({ error: e.message });
        break;
      case "closed":
        if (!this.ended) this.fail(e.reason ? `The call ended: ${e.reason}` : "The call ended. Start again to keep talking.");
        break;
    }
  }

  private ensureAssistant(itemId: string) {
    if (this.state.lines.some((l) => l.id === itemId)) return;
    // An answer is starting, so only the latest "you said…" placeholder is what it answers; any older
    // one still empty was noise or echo, and would otherwise catch later words out of order.
    const empty = this.state.lines.filter((l) => l.role === "user" && !l.final && !l.text.trim());
    const stale = new Set(empty.slice(0, -1).map((l) => l.id));
    this.pendingUser = this.pendingUser.filter((p) => !stale.has(p));
    this.setLines((lines) => [...lines.filter((l) => !stale.has(l.id)), { id: itemId, role: "assistant", text: "", final: false }]);
  }

  private watching = false;
  /** Back to listening once the last of the answer has been heard. */
  private watchPlayback() {
    if (this.watching) return;
    this.watching = true;
    const tick = () => {
      if (this.ended) return;
      const busy = this.player.playing() || (this.realtime ? this.responding : !this.thinkingDone);
      if (busy) return void setTimeout(tick, 120);
      this.watching = false;
      if (this.state.status === "speaking" || this.state.status === "thinking") this.set({ status: "listening" });
    };
    setTimeout(tick, 120);
  }

  // --- turn by turn --------------------------------------------------------------------

  private async startTurns() {
    if (this.opts.provider === "elevenlabs" || this.opts.brain) {
      const brain = this.opts.brain;
      if (!brain) throw new Error("Pick a chat model first: it does the thinking while ElevenLabs speaks.");
      if (isEngine(brain.providerId)) throw new Error("Claude Code and Codex can't hold a voice conversation. Pick a model from your providers.");
    }
    this.turns = new TurnDetector(
      () => this.onTurnStart(),
      (clip) => void this.onTurnEnd(clip),
    );
    // Talking over the answer is caught here, against the answer's echo; the turn detector then hears the rest.
    const bargeIn = new BargeIn();
    this.mic = await openMic(
      (samples, loud, raw) => {
        const playing = this.player.playing();
        if (bargeIn.push(raw, this.player.outputRms(), playing) && playing) {
          this.cutTurn();
          // Out of "speaking", so the turn detector listens at its everyday threshold for the rest of their words.
          this.set({ status: "listening" });
        }
        this.turns?.push(samples, loud, this.state.status === "speaking" || this.player.playing());
      },
      { whispers: this.opts.whispers },
    );
    if (this.ended) return this.mic.stop();
    this.mic.setMuted(this.state.muted);
    this.set({ status: "listening" });
  }

  private onTurnStart() {
    // Talking over the answer stops it.
    if (this.state.status === "thinking" || this.state.status === "speaking" || this.player.playing()) this.cutTurn();
    this.set({ status: "hearing" });
  }

  private cutTurn() {
    this.generation++;
    if (this.streamId) void api.cancelStream(this.streamId);
    this.streamId = null;
    this.thinkingDone = true;
    this.trimToHeard();
    this.player.stop();
    this.speaking = Promise.resolve();
  }

  private async onTurnEnd(clip: Float32Array) {
    if (this.ended || this.state.muted) return;
    const generation = ++this.generation;
    this.set({ status: "thinking", error: null });
    let heard: VoiceTranscript;
    try {
      heard = await api.voiceTranscribe(this.opts.provider, wavBase64(clip, VOICE_RATE), null);
    } catch (e) {
      if (generation === this.generation) this.set({ status: "listening", error: `Couldn't hear that: ${errorMessage(e)}` });
      return;
    }
    if (generation !== this.generation || this.ended) return;
    const text = heard.text.trim();
    if (!text) return this.set({ status: "listening" });
    if (heard.language) this.language = heard.language;
    this.setLines((lines) => [...lines, { id: crypto.randomUUID(), role: "user", text, final: true }]);
    await this.answer(generation);
  }

  private conversation(): CoreMessage[] {
    const before = recentText(this.opts.history, 8000);
    const spoken = this.state.lines.filter((l) => l.text.trim()).map((l) => ({ role: l.role, text: l.text.trim() }));
    return [...before, ...spoken].map((m) => ({ role: m.role, parts: [{ type: "text", text: m.text }] }) as CoreMessage);
  }

  private async answer(generation: number) {
    const id = crypto.randomUUID();
    this.setLines((lines) => [...lines, { id, role: "assistant", text: "", final: false }]);
    const brain = this.opts.brain;
    const streamId = crypto.randomUUID();
    this.streamId = streamId;
    this.thinkingDone = false;
    let pending = "";
    let failed: string | null = null;

    const say = (sentences: string[]) => {
      for (const sentence of sentences) {
        // Fetch now, play in order: the next sentence is ready by the time this one ends.
        const audio = api.voiceSpeak(this.opts.provider, this.opts.model, this.opts.voice, sentence, this.language);
        this.speaking = this.speaking.then(async () => {
          if (generation !== this.generation) return;
          const spoken = await audio.catch((e) => {
            if (generation === this.generation) this.set({ error: `Couldn't speak: ${errorMessage(e)}` });
            return null;
          });
          if (!spoken || generation !== this.generation) return;
          const at = await this.player.pushEncoded(spoken.data);
          if (at !== null) this.cues.set(id, [...(this.cues.get(id) ?? []), { at, text: sentence }]);
          if (generation === this.generation && this.state.status !== "speaking") this.set({ status: "speaking" });
          this.watchPlayback();
        });
      }
    };

    await new Promise<void>((resolve) => {
      const channel = new Channel<StreamFrame>();
      channel.onmessage = (frame) => {
        if (generation !== this.generation) return frame.type === "end" ? resolve() : undefined;
        if (frame.type === "end") return resolve();
        const event = frame.event;
        if (event.type === "text-delta") {
          pending += event.delta;
          this.setLines((lines) => lines.map((l) => (l.id === id ? { ...l, text: l.text + event.delta } : l)));
          const [ready, rest] = takeSentences(pending, false);
          pending = rest;
          say(ready);
        } else if (event.type === "error") {
          failed = event.message;
        }
      };
      const request = {
        model: brain?.model ?? "sarvam-105b",
        system: instructions(this.opts, false),
        // The new assistant line is still empty, so `conversation` leaves it out.
        messages: this.conversation(),
        maxTokens: 1024,
      };
      api.voiceThink(streamId, brain?.providerId ?? null, request, channel).catch((e) => {
        failed = errorMessage(e);
        resolve();
      });
    });

    if (generation !== this.generation) return;
    this.streamId = null;
    say(takeSentences(pending, true)[0]);
    this.setLines((lines) => lines.map((l) => (l.id === id ? { ...l, final: true } : l)));
    if (failed) this.set({ error: failed });
    await this.speaking;
    this.thinkingDone = true;
    if (generation !== this.generation) return;
    if (!this.player.playing()) this.set({ status: "listening" });
    else this.watchPlayback();
  }
}

function micMessage(e: unknown): string {
  const message = errorMessage(e);
  if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")) {
    return "Sush can't use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again.";
  }
  if (e instanceof DOMException && e.name === "NotFoundError") return "No microphone found. Plug one in and try again.";
  return message;
}
