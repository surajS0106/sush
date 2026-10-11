import { BoxIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import { Fragment, useState } from "react";

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
  const current = catalog.find((c) => c.provider.id === value?.providerId)?.provider;

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
          className="max-w-56 gap-1.5 rounded-full text-foreground/90 hover:text-foreground"
          tooltip={current && value ? `${current.name} / ${value.model}` : undefined}
        >
          {value ? (
            <>
              <Logo className="size-3.5" src={modelLogo(value.model) ?? (current && providerLogo(current))} />
              <span className="truncate">{value.model}</span>
            </>
          ) : (
            <span>Select model</span>
          )}
          <ChevronDownIcon className="size-3.5 opacity-60" />
        </PromptInputButton>
      </ModelSelectorTrigger>
      <ModelSelectorContent title="Select a model">
        <ModelSelectorInput placeholder="Search models…" value={search} onValueChange={setSearch} />
        <ModelSelectorList
          data-lenis-prevent
          className="max-h-[min(28rem,60vh)] [scrollbar-width:thin]! [scrollbar-gutter:stable]"
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
                        value={`${provider.name} ${m.id} ${m.displayName ?? ""}`}
                        onSelect={() => {
                          onChange({ providerId: provider.id, model: m.id });
                          setOpen(false);
                        }}
                      >
                        <Logo className="text-foreground/80" src={modelLogo(m.id) ?? pLogo} />
                        <ModelSelectorName>{m.displayName ?? m.id}</ModelSelectorName>
                        {m.displayName && <span className="truncate text-xs text-muted-foreground">{m.id}</span>}
                        <CheckIcon className={cn("size-4", !selected && "invisible")} />
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
