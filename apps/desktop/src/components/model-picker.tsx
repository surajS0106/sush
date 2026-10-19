import { BoxIcon, ChevronDownIcon, ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Fragment, useEffect, useRef, useState } from "react";

import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorSeparator,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import type { ProviderModels } from "@/hooks/use-providers";
import { logoColor, modelLogo, providerLogo } from "@/lib/logos";
import type { ModelTarget } from "@/lib/transport";
import { cn } from "@/lib/utils";

interface ModelPickerProps {
  catalog: ProviderModels[];
  value: ModelTarget | null;
  onChange: (target: ModelTarget) => void;
}

/** Renders a monochrome SVG as a mask so it takes the surrounding text color (or its brand color) in either theme. */
export function Logo({ src, className }: { src?: string; className?: string }) {
  if (!src) return <BoxIcon className={cn("size-4 shrink-0 opacity-60", className)} />;
  return (
    <span
      aria-hidden
      className={cn("size-4 shrink-0 bg-current", className)}
      style={{
        backgroundColor: logoColor(src),
        mask: `url("${src}") center / contain no-repeat`,
        WebkitMask: `url("${src}") center / contain no-repeat`,
      }}
    />
  );
}

/** The cmdk value of a model's row (cmdk trims values, so this does too). */
const itemValue = (providerName: string, id: string, displayName?: string | null) =>
  `${providerName} ${id} ${displayName ?? ""}`.trim();

export function ModelPicker({ catalog, value, onChange }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // While searching, show every group so matches are never hidden behind a collapsed header.
  const isCollapsed = (id: string) => !search && collapsed.has(id);
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const currentEntry = catalog.find((c) => c.provider.id === value?.providerId);
  const current = currentEntry?.provider;
  const currentModel = currentEntry?.models.find((m) => m.id === value?.model);
  const label = currentModel?.displayName ?? value?.model;
  const currentValue = current && value ? itemValue(current.name, value.model, currentModel?.displayName) : "";
  const currentLogo = value ? (modelLogo(value.model) ?? (current && providerLogo(current))) : undefined;
  const reduceMotion = useReducedMotion();

  // The highlighted row: the current model when the list opens, then wherever the keyboard or search moves it.
  const [active, setActive] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    setActive(currentValue);
    const id = requestAnimationFrame(() =>
      listRef.current?.querySelector("[data-current=true]")?.scrollIntoView({ block: "center" }),
    );
    return () => cancelAnimationFrame(id);
  }, [open]);

  return (
    <ModelSelector
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setSearch("");
      }}
    >
      <ModelSelectorTrigger asChild>
        <PromptInputButton
          aria-label={value ? `Model: ${label}${current ? ` (${current.name})` : ""}. Change model` : "Select model"}
          className={cn(
            "relative max-w-64 gap-1.5 overflow-visible rounded-full text-foreground/90 hover:text-foreground",
            !value && "text-amber-600 dark:text-amber-500",
          )}
          tooltip={current && value ? `${current.name} / ${value.model}` : undefined}
        >
          {/* A brief ring whenever the model changes, so a switch (picked, or another session's model) is noticed. */}
          <AnimatePresence initial={false}>
            {!reduceMotion && value && (
              <motion.span
                key={`${value.providerId}/${value.model}`}
                aria-hidden
                className="pointer-events-none absolute -inset-0.5 rounded-full border-2 border-brand"
                initial={{ opacity: 0.8, scale: 1 }}
                animate={{ opacity: 0, scale: 1.12 }}
                transition={{ duration: 0.9, ease: "easeOut" }}
              />
            )}
          </AnimatePresence>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={value ? `${value.providerId}/${value.model}` : "none"}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
              transition={{ duration: 0.18 }}
              className="flex min-w-0 items-center gap-1.5"
            >
              {value ? (
                <>
                  <Logo className="size-3.5" src={currentLogo} />
                  <span className="truncate">{label}</span>
                  {current && (
                    <span className="hidden truncate font-normal text-muted-foreground sm:inline">· {current.name}</span>
                  )}
                </>
              ) : (
                <span>Select model</span>
              )}
            </motion.span>
          </AnimatePresence>
          <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
        </PromptInputButton>
      </ModelSelectorTrigger>
      <ModelSelectorContent title="Select a model" commandProps={{ value: active, onValueChange: setActive }}>
        <ModelSelectorInput placeholder="Search models…" value={search} onValueChange={setSearch} />
        {value && (
          <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
            <span>Using</span>
            <Logo className="size-3.5 text-foreground/80" src={currentLogo} />
            <span className="truncate font-medium text-foreground">{label}</span>
            {current && <span className="truncate">· {current.name}</span>}
          </div>
        )}
        <ModelSelectorList
          ref={listRef}
          data-lenis-prevent
          className="max-h-[min(28rem,60vh)] scrollbar-thin! scrollbar-gutter-stable"
        >
          <ModelSelectorEmpty>No models found. Add a provider in Settings.</ModelSelectorEmpty>
          {catalog.map(({ provider, models, error }, i) => {
            const pLogo = providerLogo(provider);
            const folded = isCollapsed(provider.id);
            return (
              <Fragment key={provider.id}>
                {i > 0 && <ModelSelectorSeparator />}
                <ModelSelectorGroup
                  heading={
                    <button
                      type="button"
                      aria-expanded={!folded}
                      disabled={!!search}
                      onClick={() => toggle(provider.id)}
                      className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-1.5 rounded-sm px-1 hover:bg-accent/60 hover:text-foreground disabled:pointer-events-none"
                    >
                      <ChevronRightIcon
                        className={cn("size-3 shrink-0 transition-transform", !folded && "rotate-90", search && "invisible")}
                      />
                      <Logo className="size-3" src={pLogo} />
                      {provider.name}
                      <span className="ml-auto tabular-nums opacity-60">{models.length || ""}</span>
                    </button>
                  }
                >
                  {!folded && error && models.length === 0 && (
                    <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-destructive">
                      <TriangleAlertIcon className="size-3.5 shrink-0" />
                      <span className="line-clamp-2">{error}</span>
                    </div>
                  )}
                  {!folded && models.map((m) => {
                    const selected = value?.providerId === provider.id && value.model === m.id;
                    return (
                      <ModelSelectorItem
                        key={m.id}
                        value={itemValue(provider.name, m.id, m.displayName)}
                        data-current={selected}
                        data-checked={selected}
                        className={cn(selected && "bg-brand/10 font-medium text-foreground data-selected:bg-brand/15")}
                        onSelect={() => {
                          onChange({ providerId: provider.id, model: m.id });
                          setOpen(false);
                        }}
                      >
                        <Logo className="text-foreground/80" src={modelLogo(m.id) ?? pLogo} />
                        <ModelSelectorName>{m.displayName ?? m.id}</ModelSelectorName>
                        {m.displayName && <span className="truncate text-xs text-muted-foreground">{m.id}</span>}
                        {selected && (
                          <span className="rounded-full bg-brand/15 px-1.5 py-0.5 text-[10px] font-medium text-brand">Current</span>
                        )}
                      </ModelSelectorItem>
                    );
                  })}
                </ModelSelectorGroup>
              </Fragment>
            );
          })}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
