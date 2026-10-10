import { BoxIcon, CheckIcon, ChevronDownIcon, TriangleAlertIcon } from "lucide-react";
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
  const current = catalog.find((c) => c.provider.id === value?.providerId)?.provider;

  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <PromptInputButton
          className="max-w-56 gap-1.5 rounded-full text-muted-foreground"
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
        <ModelSelectorInput placeholder="Search models…" />
        <ModelSelectorList>
          <ModelSelectorEmpty>No models found. Add a provider in Settings.</ModelSelectorEmpty>
          {catalog.map(({ provider, models, error }, i) => {
            const pLogo = providerLogo(provider);
            return (
              <Fragment key={provider.id}>
                {i > 0 && <ModelSelectorSeparator />}
                <ModelSelectorGroup
                  heading={
                    <span className="flex w-full items-center gap-1.5">
                      <Logo className="size-3" src={pLogo} />
                      {provider.name}
                      <span className="ml-auto tabular-nums opacity-60">{models.length || ""}</span>
                    </span>
                  }
                >
                  {error && models.length === 0 && (
                    <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-destructive">
                      <TriangleAlertIcon className="size-3.5 shrink-0" />
                      <span className="line-clamp-2">{error}</span>
                    </div>
                  )}
                  {models.map((m) => {
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
