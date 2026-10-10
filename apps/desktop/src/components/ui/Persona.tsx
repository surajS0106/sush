"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";

interface PersonaDef {
  id: string;
  name: string;
  role: string;
  description: string;
  traits: string[];
  orb: string;
  glow: string;
}

function CheckDotIcon() {
  return <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />;
}

function AvatarOrb({ persona, size, thinking, shouldReduceMotion }: { persona: PersonaDef; size: number; thinking: boolean; shouldReduceMotion: boolean | null }) {
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <motion.span
        aria-hidden
        className="absolute rounded-full blur-lg"
        style={{ inset: -6, background: persona.glow }}
        animate={shouldReduceMotion ? { opacity: 0.5 } : { opacity: thinking ? [0.4, 0.75, 0.4] : [0.35, 0.5, 0.35] }}
        transition={{ duration: thinking ? 1 : 3, repeat: Infinity, ease: "easeInOut" }}
      />

      {!shouldReduceMotion && (
        <motion.svg
          aria-hidden
          viewBox="0 0 100 100"
          className="absolute"
          style={{ inset: -9 }}
          animate={{ rotate: 360 }}
          transition={{ duration: thinking ? 2.2 : 9, repeat: Infinity, ease: "linear" }}
        >
          <circle cx="50" cy="50" r="47" fill="none" stroke={persona.glow} strokeWidth="1.5" strokeDasharray="1 7" strokeLinecap="round" opacity="0.7" />
        </motion.svg>
      )}

      {!shouldReduceMotion && (
        <motion.div
          aria-hidden
          className="absolute inset-[-5px]"
          animate={{ rotate: 360 }}
          transition={{ duration: thinking ? 1.6 : 4.5, repeat: Infinity, ease: "linear" }}
        >
          <span className="absolute left-1/2 top-0 h-1 w-1 -translate-x-1/2 rounded-full bg-white shadow-[0_0_6px_1.5px_rgba(255,255,255,0.9)]" />
        </motion.div>
      )}

      <span className="relative block h-full w-full overflow-hidden rounded-full ring-1 ring-white/25" style={{ background: persona.orb }}>
        <motion.span
          aria-hidden
          className="absolute inset-[-30%]"
          style={{ background: "conic-gradient(from 0deg, transparent 0%, rgba(255,255,255,0.4) 8%, transparent 20%)" }}
          animate={shouldReduceMotion ? undefined : { rotate: 360 }}
          transition={{ duration: thinking ? 1.4 : 6, repeat: Infinity, ease: "linear" }}
        />
        <span aria-hidden className="pointer-events-none absolute left-[20%] top-[14%] h-[32%] w-[32%] rounded-full bg-white/50 blur-[2px]" />
      </span>
    </div>
  );
}

function StatusBadge({ thinking }: { thinking: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        thinking ? "bg-amber-500/10 text-amber-700 dark:text-amber-400" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      }`}
    >
      {thinking ? (
        <motion.span
          aria-hidden
          className="h-2 w-2 rounded-full border-[1.5px] border-amber-400/30 border-t-amber-600 dark:border-t-amber-400"
          animate={{ rotate: 360 }}
          transition={{ duration: 0.7, repeat: Infinity, ease: "linear" }}
        />
      ) : (
        <CheckDotIcon />
      )}
      {thinking ? "Thinking" : "Active"}
    </span>
  );
}

export function Persona({ personas, initialId }: { personas: PersonaDef[]; initialId?: string }) {
  const [activeId, setActiveId] = useState(initialId ?? personas[0].id);
  const [thinking, setThinking] = useState(false);
  const shouldReduceMotion = useReducedMotion();
  const active = personas.find((p) => p.id === activeId) ?? personas[0];

  useEffect(() => {
    if (!thinking) return;
    const t = setTimeout(() => setThinking(false), shouldReduceMotion ? 30 : 550);
    return () => clearTimeout(t);
  }, [thinking, shouldReduceMotion]);

  const switchPersona = (id: string) => {
    if (id === activeId) return;
    setActiveId(id);
    setThinking(true);
  };

  return (
    <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
      <AnimatePresence mode="wait">
        <motion.div
          key={activeId}
          initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="flex items-start gap-3">
            <AvatarOrb persona={active} size={44} thinking={thinking} shouldReduceMotion={shouldReduceMotion} />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-stone-900 dark:text-stone-100">{active.name}</h3>
                <StatusBadge thinking={thinking} />
              </div>
              <p className="text-xs text-stone-500 dark:text-stone-400">{active.role}</p>
            </div>
          </div>

          <p className="mt-3 text-sm leading-relaxed text-stone-600 dark:text-stone-300">{active.description}</p>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {active.traits.map((t, i) => (
              <motion.span
                key={t}
                initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, delay: 0.1 + i * 0.05, ease: [0.22, 1, 0.36, 1] }}
                className="rounded-full bg-black/[0.04] px-2.5 py-1 text-[11px] font-medium text-stone-600 dark:bg-white/[0.06] dark:text-stone-300"
              >
                {t}
              </motion.span>
            ))}
          </div>
        </motion.div>
      </AnimatePresence>

      {personas.length > 1 && (
        <div className="mt-4 flex items-center gap-2 border-t border-stone-100 pt-3 dark:border-white/5">
          <span className="text-[11px] font-medium text-stone-500 dark:text-stone-500">Switch persona</span>
          <div role="tablist" aria-label="Persona" className="ml-auto flex gap-1.5">
            {personas.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={p.id === activeId}
                aria-label={p.name}
                title={p.name}
                onClick={() => switchPersona(p.id)}
                className={`rounded-full transition-[color,background-color,border-color,transform,opacity] duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400 ${
                  p.id === activeId ? "ring-2 ring-emerald-500/60 ring-offset-2 ring-offset-white dark:ring-offset-stone-950" : "opacity-70 hover:opacity-100"
                }`}
              >
                <span className="block h-6 w-6 rounded-full" style={{ background: p.orb }} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}