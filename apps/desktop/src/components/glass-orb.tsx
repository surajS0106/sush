// A glass sphere with colour inside, drawn in SVG: a body that runs from one
// rich hue at the top to another at the bottom, a milky centre where the glass
// is thin, a thick rim that darkens and splits into warm and cool light, a
// broad crescent of window light top left, a bright one caught bottom right,
// and a faint mirror image below. Each voice gets its own pair of hues, so the
// orb in a call matches the one next to its name in Settings → Voice mode.

import { useId, type CSSProperties, type Ref } from "react";

import { cn } from "@/lib/utils";

/** Hand-picked pairs (top hue, bottom hue) that blend cleanly through glass. */
const PALETTES: [number, number][] = [
  [350, 195], // magenta → teal
  [300, 230], // violet → sky
  [20, 170], // coral → mint
  [265, 190], // blue → aqua
  [330, 60], // rose → gold
  [285, 30], // lilac → peach
  [160, 275], // jade → indigo
  [215, 320], // azure → pink
  [45, 345], // amber → raspberry
  [190, 300], // cyan → orchid
];

/** The orb's two hues for a voice. */
export function orbHues(seed: string): [number, number] {
  const n = [...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return PALETTES[n % PALETTES.length];
}

const ok = (l: number, c: number, h: number, a = 1) => `oklch(${l} ${c} ${h % 360} / ${a})`;
const stop = (offset: string, color: string): { offset: string; style: CSSProperties } => ({ offset, style: { stopColor: color } });

export function GlassOrb({
  seed,
  size,
  float = false,
  spin = "slow",
  dim = false,
  reflection = false,
  scaleRef,
  className,
}: {
  seed: string;
  size: number;
  /** Bob gently up and down. */
  float?: boolean;
  /** How fast the colour inside drifts: slowly at rest, fast while thinking. */
  spin?: "slow" | "fast";
  /** Muted or failed: drained of colour. */
  dim?: boolean;
  reflection?: boolean;
  /** For callers that scale the orb every frame (with the voice's loudness). */
  scaleRef?: Ref<HTMLSpanElement>;
  className?: string;
}) {
  return (
    <span aria-hidden className={cn("pointer-events-none relative block shrink-0", className)} style={{ width: size, height: size }}>
      {reflection && (
        // The sphere again, upside down and fading, as if on a glossy floor.
        <span className={cn("absolute top-[102%] left-1/2 block h-full w-full -translate-x-1/2", float && "orb-reflect")}>
          <span
            className="block size-full -scale-y-100 opacity-30 blur-[1.5px]"
            style={{ maskImage: "linear-gradient(to top, black, transparent 45%)", WebkitMaskImage: "linear-gradient(to top, black, transparent 45%)" }}
          >
            <Sphere seed={seed} spin="slow" dim={dim} />
          </span>
        </span>
      )}
      <span className={cn("absolute inset-0 block", float && "orb-float")}>
        <span ref={scaleRef} className="absolute inset-0 block will-change-transform">
          <Sphere seed={seed} spin={spin} dim={dim} />
        </span>
      </span>
    </span>
  );
}

function Sphere({ seed, spin, dim }: { seed: string; spin: "slow" | "fast"; dim: boolean }) {
  const id = useId().replace(/:/g, "");
  const [a, b] = orbHues(seed);
  const u = (name: string) => `url(#${id}-${name})`;

  const body = [
    stop("0%", ok(0.8, 0.13, a)),
    stop("38%", ok(0.7, 0.2, a)),
    stop("62%", ok(0.76, 0.15, a + 12)),
    stop("80%", ok(0.8, 0.13, b)),
    stop("100%", ok(0.86, 0.11, b)),
  ];

  return (
    <svg viewBox="0 0 100 100" className="block size-full overflow-visible transition-[filter] duration-500" style={{ filter: dim ? "grayscale(1) opacity(0.65)" : undefined }}>
      <defs>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="0" y2="1">
          {body.map((s) => (
            <stop key={s.offset} offset={s.offset} style={s.style} />
          ))}
        </linearGradient>
        {/* Thin glass in the middle lets the light through. */}
        <radialGradient id={`${id}-milk`} cx="50%" cy="54%" r="50%">
          <stop offset="0%" style={{ stopColor: "white", stopOpacity: 0.32 }} />
          <stop offset="55%" style={{ stopColor: "white", stopOpacity: 0.1 }} />
          <stop offset="78%" style={{ stopColor: "white", stopOpacity: 0 }} />
        </radialGradient>
        {/* Thick glass at the edge: deeper colour. */}
        <radialGradient id={`${id}-edge`} cx="50%" cy="50%" r="50%">
          <stop offset="68%" style={{ stopColor: ok(0.45, 0.17, a), stopOpacity: 0 }} />
          <stop offset="90%" style={{ stopColor: ok(0.45, 0.17, a), stopOpacity: 0.45 }} />
          <stop offset="100%" style={{ stopColor: ok(0.38, 0.15, a + 10), stopOpacity: 0.75 }} />
        </radialGradient>
        {/* Light split by the rim: warm top right, cool on the left. */}
        <radialGradient id={`${id}-warm`} cx="78%" cy="22%" r="42%">
          <stop offset="0%" style={{ stopColor: ok(0.74, 0.19, 45), stopOpacity: 0.95 }} />
          <stop offset="100%" style={{ stopColor: ok(0.74, 0.19, 45), stopOpacity: 0 }} />
        </radialGradient>
        <radialGradient id={`${id}-cool`} cx="10%" cy="58%" r="45%">
          <stop offset="0%" style={{ stopColor: ok(0.48, 0.2, 290), stopOpacity: 0.85 }} />
          <stop offset="100%" style={{ stopColor: ok(0.48, 0.2, 290), stopOpacity: 0 }} />
        </radialGradient>
        <radialGradient id={`${id}-ringfade`} cx="50%" cy="50%" r="50%">
          <stop offset="82%" style={{ stopColor: "black" }} />
          <stop offset="93%" style={{ stopColor: "white" }} />
        </radialGradient>
        <mask id={`${id}-ring`}>
          <circle cx="50" cy="50" r="49" fill={u("ringfade")} />
        </mask>
        {/* Colour drifting inside, so the orb never sits quite still. */}
        <radialGradient id={`${id}-drift-a`}>
          <stop offset="0%" style={{ stopColor: ok(0.85, 0.12, a), stopOpacity: 0.75 }} />
          <stop offset="100%" style={{ stopColor: ok(0.85, 0.12, a), stopOpacity: 0 }} />
        </radialGradient>
        <radialGradient id={`${id}-drift-b`}>
          <stop offset="0%" style={{ stopColor: ok(0.78, 0.14, b), stopOpacity: 0.6 }} />
          <stop offset="100%" style={{ stopColor: ok(0.78, 0.14, b), stopOpacity: 0 }} />
        </radialGradient>
        <clipPath id={`${id}-clip`}>
          <circle cx="50" cy="50" r="49" />
        </clipPath>
        {/* Window light: a broad crescent hugging the top left. */}
        <linearGradient id={`${id}-shine`} x1="0.15" y1="0.05" x2="0.6" y2="0.55">
          <stop offset="0%" style={{ stopColor: "white", stopOpacity: 0.95 }} />
          <stop offset="55%" style={{ stopColor: "white", stopOpacity: 0.35 }} />
          <stop offset="100%" style={{ stopColor: "white", stopOpacity: 0 }} />
        </linearGradient>
        <mask id={`${id}-crescent-top`}>
          <circle cx="50" cy="50" r="44" fill="white" />
          <circle cx="57" cy="60" r="43" fill="black" />
        </mask>
        <mask id={`${id}-crescent-bottom`}>
          <circle cx="50" cy="50" r="40" fill="white" />
          <circle cx="45" cy="44" r="39" fill="black" />
        </mask>
        <filter id={`${id}-soft`} x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="0.5" />
        </filter>
        <filter id={`${id}-blur`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>

      {/* A soft coloured shadow, as the light passes through. */}
      <ellipse cx="50" cy="90" rx="34" ry="8" fill={ok(0.7, 0.15, a, 0.35)} filter={u("blur")} />

      <circle cx="50" cy="50" r="49" fill={u("body")} />
      <g clipPath={u("clip")}>
        <g
          className={cn(spin === "fast" ? "motion-safe:animate-[spin_1.8s_linear_infinite]" : "motion-safe:animate-[spin_14s_linear_infinite]")}
          style={{ transformOrigin: "50px 50px", transformBox: "view-box" }}
        >
          <circle cx="32" cy="36" r="30" fill={u("drift-a")} filter={u("blur")} />
          <circle cx="68" cy="70" r="26" fill={u("drift-b")} filter={u("blur")} />
        </g>
      </g>
      <circle cx="50" cy="50" r="49" fill={u("milk")} />
      <circle cx="50" cy="50" r="49" fill={u("edge")} />
      <g mask={u("ring")}>
        <circle cx="50" cy="50" r="49" fill={u("warm")} />
        <circle cx="50" cy="50" r="49" fill={u("cool")} />
      </g>

      {/* A refraction line just inside the left edge. */}
      <path d="M 16 30 A 42 42 0 0 0 22 80" fill="none" stroke={ok(0.35, 0.14, a, 0.45)} strokeWidth="0.7" strokeLinecap="round" filter={u("soft")} />

      <rect x="0" y="0" width="100" height="100" fill={u("shine")} mask={u("crescent-top")} filter={u("soft")} />
      <rect x="0" y="0" width="100" height="100" fill="white" fillOpacity="0.85" mask={u("crescent-bottom")} filter={u("soft")} />
      {/* Small glints. */}
      <ellipse cx="28" cy="24" rx="4.5" ry="2.6" transform="rotate(-35 28 24)" fill="white" fillOpacity="0.8" filter={u("soft")} />
      <ellipse cx="74" cy="64" rx="2.2" ry="1.3" fill="white" fillOpacity="0.45" />
      <ellipse cx="48" cy="38" rx="1.6" ry="1" fill="white" fillOpacity="0.3" />

      {/* The glass's outer surface. */}
      <circle cx="50" cy="50" r="48.6" fill="none" stroke="white" strokeOpacity="0.55" strokeWidth="0.8" />
    </svg>
  );
}
