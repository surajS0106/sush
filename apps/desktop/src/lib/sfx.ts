// The mascot's cartoon sound effects, synthesised with Web Audio (no audio
// files): a slide-whistle "whoa" as it topples, a thud on landing, and birds
// tweeting round its head while it lies there seeing stars.

let ctx: AudioContext | null = null;

/** The shared audio context, resumed. Call from a click so the webview lets it play. */
export function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** One fall's sounds, all under one gain node so they can be cut off together. */
export interface Fall {
  whoa(): void;
  thud(): void;
  /** Tweeting for `seconds` from now. */
  tweets(seconds: number): void;
  stop(): void;
}

export function fallSounds(): Fall | null {
  const ac = audio();
  if (!ac) return null;
  const out = ac.createGain();
  out.gain.value = 0.5;
  out.connect(ac.destination);

  const tone = (type: OscillatorType, at: number, dur: number, freqs: [number, number], peak: number) => {
    const osc = ac.createOscillator();
    const env = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqs[0], at);
    osc.frequency.exponentialRampToValueAtTime(freqs[1], at + dur);
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(peak, at + Math.min(0.02, dur / 4));
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(env).connect(out);
    osc.start(at);
    osc.stop(at + dur + 0.02);
    return osc;
  };

  return {
    whoa() {
      // A slide whistle falling, with a wobble in it.
      const t = ac.currentTime;
      const osc = tone("sine", t, 0.5, [1100, 260], 0.35);
      const lfo = ac.createOscillator();
      const depth = ac.createGain();
      lfo.frequency.value = 14;
      depth.gain.value = 40;
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + 0.52);
    },
    thud() {
      const t = ac.currentTime;
      tone("sine", t, 0.3, [140, 40], 0.9);
      // A burst of low noise for the body hitting the ground.
      const len = Math.floor(ac.sampleRate * 0.15);
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
      const noise = ac.createBufferSource();
      const lowpass = ac.createBiquadFilter();
      const env = ac.createGain();
      noise.buffer = buf;
      lowpass.type = "lowpass";
      lowpass.frequency.value = 500;
      env.gain.value = 0.6;
      noise.connect(lowpass).connect(env).connect(out);
      noise.start(t);
    },
    tweets(seconds) {
      // "Tweet-tweet", over and over, each pair a little different.
      const t0 = ac.currentTime + 0.25;
      for (let t = t0; t < t0 + seconds - 0.4; t += 0.55 + Math.random() * 0.2) {
        const base = 2200 + Math.random() * 600;
        tone("sine", t, 0.07, [base, base * 1.4], 0.12);
        tone("sine", t + 0.11, 0.07, [base * 1.05, base * 1.5], 0.12);
      }
    },
    stop() {
      out.gain.setTargetAtTime(0, ac.currentTime, 0.03);
      setTimeout(() => out.disconnect(), 200);
    },
  };
}
