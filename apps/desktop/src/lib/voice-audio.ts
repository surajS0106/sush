// Voice mode's audio: the microphone as a stream of 24 kHz chunks, a player
// that queues the model's audio gaplessly and can stop dead when the user cuts
// in, and a small voice-activity detector for the turn-by-turn providers.

/** Realtime voice APIs take and give 24 kHz 16-bit mono PCM. */
export const VOICE_RATE = 24_000;
/** One mic chunk: 2048 samples, about 85 ms. */
const CHUNK = 2048;
export const CHUNK_MS = (CHUNK / VOICE_RATE) * 1000;

const rms = (samples: Float32Array) => {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
};

export interface Mic {
  /** Loudness of the latest chunk, 0..1, smoothed. Zero while muted. */
  level(): number;
  setMuted(muted: boolean): void;
  stop(): void;
}

/** Input sensitivity in dBFS (Settings → Voice mode), as the RMS level the gate opens at. */
export const dbToRms = (db: number) => Math.pow(10, db / 20);
export const rmsToDb = (r: number) => (r > 0 ? 20 * Math.log10(r) : -Infinity);
/** How long the gate stays open once the voice drops below it, so word endings and short pauses aren't cut. */
const GATE_HOLD_MS = 450;

/** Speech is lifted toward this loudness (RMS)... */
const BOOST_TARGET = 0.05;
/** ...by at most this much, so a whisper becomes ordinary speech and hiss stays hiss. */
const BOOST_MAX = 6;

/**
 * Lifts quiet speech, a whisper, to an ordinary level before anyone listens:
 * the server's detector, ours, and the transcriber. It tracks the room's
 * background level and only lifts what stands above it, so silence isn't
 * turned into noise; it lets loud speech through as it is, and rounds off
 * peaks instead of clipping them.
 */
class QuietBoost {
  private floor = 0.003;
  private gain = 1;

  apply(samples: Float32Array) {
    const level = rms(samples);
    this.floor = level < this.floor ? this.floor * 0.8 + level * 0.2 : this.floor * 0.995 + level * 0.005;
    const speech = level > this.floor * 2.5;
    const want = speech ? Math.min(BOOST_MAX, Math.max(1, BOOST_TARGET / Math.max(level, 1e-6))) : 1;
    // Rise quickly enough to catch the first syllable; drop quicker still, so a loud word isn't overdriven.
    this.gain += (want - this.gain) * (want > this.gain ? 0.5 : 0.8);
    if (this.gain < 1.01) return;
    for (let i = 0; i < samples.length; i++) samples[i] = Math.tanh(samples[i] * this.gain);
  }
}

/**
 * Open the microphone; `onChunk` gets each chunk with its loudness, except while muted.
 * With `whispers`, quiet speech is lifted first (`QuietBoost`), so a whisper is heard like a normal voice;
 * `raw` is the chunk's loudness before that, for telling the user from the answer's echo.
 * With a `gate` (an RMS level; 0 is none, the automatic default), anything quieter is silence: the
 * chunk is zeroed before the boost and every detector, held open a moment after the voice drops
 * below it, and `open` says whether it got through.
 */
export async function openMic(
  onChunk: (samples: Float32Array, loudness: number, raw: number, open: boolean) => void,
  { whispers = false, gate = 0 } = {},
): Promise<Mic> {
  const stream = await navigator.mediaDevices.getUserMedia({
    // Echo cancellation keeps the model's own voice out of the mic, so it doesn't interrupt itself.
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext({ sampleRate: VOICE_RATE });
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor needs no worklet module, which the CSP would block as a blob.
  const processor = ctx.createScriptProcessor(CHUNK, 1, 1);
  let muted = false;
  let level = 0;
  let openUntil = 0;
  const boost = whispers ? new QuietBoost() : null;
  processor.onaudioprocess = (e) => {
    if (muted) {
      level *= 0.6;
      return;
    }
    const samples = new Float32Array(e.inputBuffer.getChannelData(0));
    const raw = rms(samples);
    let open = true;
    if (gate > 0) {
      const now = performance.now();
      if (raw >= gate) openUntil = now + GATE_HOLD_MS;
      else if (now > openUntil) open = false;
    }
    if (!open) samples.fill(0);
    else boost?.apply(samples);
    const loud = !open ? 0 : boost ? rms(samples) : raw;
    level = Math.max(loud, level * 0.7);
    onChunk(samples, loud, raw, open);
  };
  source.connect(processor);
  processor.connect(ctx.destination);
  return {
    level: () => Math.min(1, level * 6),
    setMuted(m) {
      muted = m;
      stream.getAudioTracks().forEach((t) => (t.enabled = !m));
    },
    stop() {
      processor.onaudioprocess = null;
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}

/** Float samples as 16-bit little-endian PCM, base64. */
export function pcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Plays the model's audio back to back. Realtime answers arrive as PCM slices
 * of one item; turn-by-turn answers as encoded sentences (MP3, WAV). Either
 * way `stop` silences everything at once and says how much of the item
 * playing was heard, for the model to forget the rest.
 */
export class Player {
  private ctx = new AudioContext({ sampleRate: VOICE_RATE });
  private analyser = this.ctx.createAnalyser();
  private sources = new Set<AudioBufferSourceNode>();
  private next = 0;
  private item: { id: string; start: number } | null = null;
  /** Bumped by `stop`, so sentences still decoding are dropped. */
  private generation = 0;
  private chain: Promise<void> = Promise.resolve();
  private samples = new Float32Array(1024);

  constructor() {
    this.analyser.fftSize = 1024;
    this.analyser.connect(this.ctx.destination);
  }

  private schedule(buffer: AudioBuffer) {
    const now = this.ctx.currentTime;
    // A small lead on the first slice keeps a slow next slice from clicking.
    const at = Math.max(this.next, now + 0.05);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.analyser);
    src.onended = () => this.sources.delete(src);
    src.start(at);
    this.sources.add(src);
    this.next = at + buffer.duration;
    return at;
  }

  /** A slice of a realtime answer: 24 kHz 16-bit PCM, base64. */
  pushPcm(itemId: string, b64: string) {
    if (this.ctx.state === "suspended") void this.ctx.resume();
    const bytes = base64Bytes(b64);
    const count = Math.floor(bytes.length / 2);
    if (!count) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
    const buffer = this.ctx.createBuffer(1, count, VOICE_RATE);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < count; i++) data[i] = view.getInt16(i * 2, true) / 0x8000;
    const at = this.schedule(buffer);
    if (this.item?.id !== itemId) this.item = { id: itemId, start: at };
  }

  /**
   * A whole encoded sentence, played after everything queued before it.
   * Resolves once it's scheduled, with when it starts (on `now()`'s clock), or null if it was dropped.
   */
  pushEncoded(b64: string): Promise<number | null> {
    const generation = this.generation;
    const bytes = base64Bytes(b64);
    const scheduled = this.chain.then(async () => {
      if (generation !== this.generation) return null;
      const buffer = await this.ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer).catch(() => null);
      if (!buffer || generation !== this.generation) return null;
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return this.schedule(buffer);
    });
    this.chain = scheduled.then(() => undefined);
    return scheduled;
  }

  /** The playback clock, in seconds. */
  now() {
    return this.ctx.currentTime;
  }

  /** The realtime answer now playing: how much of its audio has been heard, and how much has arrived. */
  progress(): { itemId: string; heardMs: number; queuedMs: number } | null {
    if (!this.item || !this.playing()) return null;
    const heardMs = Math.max(0, (this.ctx.currentTime - this.item.start) * 1000);
    return { itemId: this.item.id, heardMs, queuedMs: Math.max(heardMs, (this.next - this.item.start) * 1000) };
  }

  /** Whether anything is still to be heard. */
  playing() {
    return this.ctx.currentTime < this.next - 0.02;
  }

  /** Loudness (RMS) of what's playing right now, unscaled; 0 when nothing is. */
  outputRms() {
    if (!this.playing()) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    return rms(this.samples);
  }

  /** Loudness of what's playing, 0..1. */
  level() {
    if (!this.playing()) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    return Math.min(1, rms(this.samples) * 5);
  }

  /** Silence everything now; returns the item that was playing and how many ms of it were heard. */
  stop(): { itemId: string | null; heardMs: number } {
    this.generation++;
    const heard = this.item ? Math.max(0, Math.round((this.ctx.currentTime - this.item.start) * 1000)) : 0;
    const itemId = this.playing() ? (this.item?.id ?? null) : null;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // already ended
      }
    }
    this.sources.clear();
    this.next = 0;
    this.item = null;
    this.chain = Promise.resolve();
    return { itemId, heardMs: heard };
  }

  close() {
    this.stop();
    void this.ctx.close();
  }
}

/**
 * Finds where the user starts and stops talking, from each chunk's loudness
 * against the room's noise floor. While the model is speaking it wants a
 * louder, longer start, so its own voice leaking into the mic doesn't count.
 */
export class TurnDetector {
  private floor = 0.004;
  private loudRun = 0;
  private quietRun = 0;
  private talking = false;
  private clip: Float32Array[] = [];
  /** Kept from before the start was detected, so the first syllable isn't cut. */
  private preroll: Float32Array[] = [];

  constructor(
    private onStart: () => void,
    private onEnd: (clip: Float32Array) => void,
    /** How long a pause ends the turn. */
    private endAfterMs = 750,
  ) {}

  push(samples: Float32Array, loudness: number, modelSpeaking: boolean) {
    if (!this.talking) this.floor = loudness < this.floor * 2 ? this.floor * 0.95 + loudness * 0.05 : this.floor * 0.999 + loudness * 0.001;
    const threshold = modelSpeaking ? Math.max(0.045, this.floor * 6) : Math.max(0.015, this.floor * 3);
    const loud = loudness > threshold;

    if (!this.talking) {
      this.preroll.push(samples);
      if (this.preroll.length > 5) this.preroll.shift();
      this.loudRun = loud ? this.loudRun + 1 : 0;
      if (this.loudRun >= (modelSpeaking ? 4 : 3)) {
        this.talking = true;
        this.clip = [...this.preroll];
        this.preroll = [];
        this.quietRun = 0;
        this.onStart();
      }
      return;
    }
    this.clip.push(samples);
    this.quietRun = loud ? 0 : this.quietRun + 1;
    const long = this.clip.length * CHUNK_MS > 28_000; // Sarvam takes 30 s at most
    if (this.quietRun * CHUNK_MS >= this.endAfterMs || long) this.finish();
  }

  private finish() {
    const total = this.clip.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(total);
    let at = 0;
    for (const c of this.clip) {
      out.set(c, at);
      at += c.length;
    }
    this.talking = false;
    this.clip = [];
    this.loudRun = 0;
    // Too short to be words: a cough or a click.
    if (total / VOICE_RATE >= 0.35) this.onEnd(out);
  }

  /** Forget a turn in progress (on mute). */
  reset() {
    this.talking = false;
    this.clip = [];
    this.preroll = [];
    this.loudRun = 0;
  }
}

/**
 * Hears the user talking over the answer. Loudness alone can't: what's left of
 * the answer's echo after echo cancellation rises and falls with the answer.
 * So this learns how much of the answer leaks back into the mic (the lowest
 * mic-to-output ratio seen while it plays) and counts the user as talking when
 * the mic is well above what that leak explains. Two chunks (about 170 ms) is
 * enough, so a short "stop" cuts the answer.
 */
export class BargeIn {
  /** Mic loudness per unit of output loudness that is just the answer's echo. */
  private leak = 0.3;
  /** The room's own level, from the mic while nothing plays. */
  private floor = 0.003;
  private run = 0;
  private lastOut = 0;

  /**
   * Feed a chunk: the mic's raw loudness and the output's. True once the user is talking over the answer.
   * A chunk the input gate shut (`open` false) still teaches the echo, but never counts as the user.
   */
  push(mic: number, out: number, playing: boolean, open = true): boolean {
    if (!playing) {
      this.floor = mic < this.floor ? this.floor * 0.8 + mic * 0.2 : this.floor * 0.99 + mic * 0.01;
      this.run = 0;
      this.lastOut = 0;
      return false;
    }
    // The echo reaches the mic a little after it leaves the speaker: compare with the louder of now and just before.
    const heard = Math.max(out, this.lastOut);
    this.lastOut = out;
    if (heard > 0.01) {
      const ratio = mic / heard;
      this.leak = ratio < this.leak ? this.leak * 0.7 + ratio * 0.3 : this.leak * 0.995 + ratio * 0.005;
    }
    const expected = this.leak * heard + this.floor;
    const talking = open && mic > Math.max(this.floor * 3, expected * 2.5);
    this.run = talking ? this.run + 1 : 0;
    if (this.run < 2) return false;
    this.run = 0;
    return true;
  }
}
