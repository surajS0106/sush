import { BoxIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, ImageIcon, TriangleAlertIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

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
import { failedToLoad, reloadProviders, type ProviderModels } from "@/hooks/use-providers";
import {
  canGenerateImages,
  defaultImageApi,
  defaultImageModel,
  setImageSettings,
  useActiveImageSettings,
  type ImageSettings,
} from "@/lib/images";
import { logoColor, modelLogo, providerLogo } from "@/lib/logos";
import { topModels, useModelUsage } from "@/lib/model-usage";
import { friendlyName, isChatModel, isImageOnlyModel, withoutSnapshots, isLocalProvider, modelHint, modelProblem, useModelHealth } from "@/lib/model-names";
import type { ModelTarget } from "@/lib/transport";
import { cn } from "@/lib/utils";

interface ModelPickerProps {
  catalog: ProviderModels[];
  value: ModelTarget | null;
  onChange: (target: ModelTarget) => void;
  /**
   * Offer image models too, in their own group: picking one makes it the image model (Settings → Images)
   * rather than the chat model, and calls this (the composer makes the chat an image chat).
   */
  onPickImageModel?: () => void;
  /** The image model drawing this chat's messages, shown in place of the chat model until one is picked. */
  drawing?: ImageSettings | null;
}

/**
 * Search by words, not cmdk's fuzzy letters: every word typed must appear in the row's provider, id or name.
 * Fuzzy matching had "image" find Mistral Large 4 (m-I-stral … a-G-E) and re-sorted rows by score, which split
 * a provider's models apart; equal scores keep the list's own order.
 */
const wordFilter = (value: string, search: string) => {
  const hay = value.toLowerCase();
  return search.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w)) ? 1 : 0;
};

/** Video models (Grok Imagine Video, Veo, Sora) don't make still images, so they aren't offered for pictures. */
const VIDEO = /video|^veo|^sora/i;

/** Each provider's image models: the image-only ones it lists, plus the one we know it draws with. */
function imageModels(catalog: ProviderModels[]) {
  const out: { provider: ProviderModels["provider"]; id: string; displayName?: string | null }[] = [];
  for (const { provider, models } of catalog) {
    if (!canGenerateImages(provider)) continue;
    const ids = new Set<string>();
    for (const m of withoutSnapshots(models)) {
      if (!isImageOnlyModel(m.id) || VIDEO.test(m.id.split("/").pop() ?? m.id)) continue;
      ids.add(m.id);
      out.push({ provider, id: m.id, displayName: m.displayName });
    }
    // Only alongside a list that loaded: on its own it hid that the provider's models were missing.
    const known = defaultImageModel(provider);
    if (known && models.length > 0 && !ids.has(known)) out.push({ provider, id: known });
  }
  return out;
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

export function ModelPicker({ catalog: all, value, onChange, onPickImageModel, drawing }: ModelPickerProps) {
  // Image-only models can't chat: they're listed apart (when the composer asks) and picked as the image model.
  const catalog = useMemo(
    () => all.map((c) => ({ ...c, models: withoutSnapshots(c.models.filter((m) => isChatModel(m.id))) })),
    [all],
  );
  const images = useMemo(() => (onPickImageModel ? imageModels(all) : []), [all, onPickImageModel]);
  const imageNow = useActiveImageSettings();
  // Providers whose model list didn't load (a timeout or network blip at startup): they're retried when the
  // picker opens, and named at the top of the list with the reason and a Retry, rather than silently missing.
  const failed = all.filter(failedToLoad);
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    setRetrying(true);
    void reloadProviders().finally(() => setRetrying(false));
  };
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  // In "All models", groups start open; this holds the ones the user folded.
  const [folded, setFolded] = useState<Set<string>>(new Set());
  // While searching, show every group so matches are never hidden behind a folded header.
  const isCollapsed = (id: string) => !search && folded.has(id);
  const toggle = (id: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const currentEntry = catalog.find((c) => c.provider.id === value?.providerId);
  const current = currentEntry?.provider;
  const currentModel = currentEntry?.models.find((m) => m.id === value?.model);
  const label = value ? friendlyName(value.model, currentModel?.displayName) : undefined;
  const currentValue = current && value ? itemValue(current.name, value.model, currentModel?.displayName) : "";
  const currentLogo = value ? (modelLogo(value.model) ?? (current && providerLogo(current))) : undefined;
  // An image chat shows the model that draws it; picking a chat model from the list goes back to chatting.
  const drawer = drawing ? all.find((c) => c.provider.id === drawing.providerId)?.provider : undefined;
  const shown = drawing
    ? {
        key: `image/${drawing.providerId}/${drawing.model}`,
        label: friendlyName(drawing.model),
        logo: modelLogo(drawing.model) ?? (drawer && providerLogo(drawer)),
        provider: drawer?.name,
      }
    : value
      ? { key: `${value.providerId}/${value.model}`, label: label!, logo: currentLogo, provider: current?.name }
      : null;
  const reduceMotion = useReducedMotion();

  const health = useModelHealth();
  // The short list unless "All models" was picked (or something's typed); it opens short each time.
  const [showAll, setShowAll] = useState(false);
  const total = catalog.reduce((n, c) => n + c.models.length, 0);

  // The user's most used models (other than the current one) as quick picks at the top.
  const usage = useModelUsage();
  const suggestions = topModels(
    usage,
    (t) =>
      !(t.providerId === value?.providerId && t.model === value.model) &&
      !!catalog.find((c) => c.provider.id === t.providerId)?.models.some((m) => m.id === t.model),
  ).map((t) => {
    const entry = catalog.find((c) => c.provider.id === t.providerId)!;
    const model = entry.models.find((m) => m.id === t.model)!;
    return { target: t, provider: entry.provider, model, uses: usage[`${t.providerId}/${t.model}`].count };
  });

  // The short list: the current model, the most used, then up to two from each provider, eight at most.
  const shortList: { provider: ProviderModels["provider"]; model: ProviderModels["models"][number] }[] = [];
  const inList = (pid: string, mid: string) => shortList.some((x) => x.provider.id === pid && x.model.id === mid);
  if (current && currentModel) shortList.push({ provider: current, model: currentModel });
  for (const sug of suggestions) if (!inList(sug.provider.id, sug.model.id)) shortList.push({ provider: sug.provider, model: sug.model });
  for (let round = 0; round < 2; round++) {
    for (const c of catalog) {
      const m = c.models.filter((x) => !inList(c.provider.id, x.id))[0];
      if (m && shortList.length < 8) shortList.push({ provider: c.provider, model: m });
    }
  }

  // The highlighted row: the current model when the list opens, then wherever the keyboard or search moves it.
  const [active, setActive] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && failed.length > 0 && !retrying) retry();
  }, [open]);

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
        if (!o) {
          setSearch("");
          setShowAll(false);
        }
      }}
    >
      <ModelSelectorTrigger asChild>
        <PromptInputButton
          aria-label={
            drawing && shown
              ? `Drawing images with ${shown.label}. Pick a chat model to chat again`
              : value
                ? `Model: ${label}${current ? ` (${current.name})` : ""}. Change model`
                : "Select model"
          }
          className={cn(
            "relative max-w-64 min-w-0 gap-1.5 overflow-visible rounded-full text-foreground/90 hover:text-foreground",
            !shown && "text-amber-600 dark:text-amber-500",
            drawing && "text-sky-800! dark:text-sky-300!",
          )}
          tooltip={
            drawing
              ? `Every message in this chat is drawn by ${drawer ? `${drawer.name} / ` : ""}${drawing.model}. Pick a chat model to chat again.`
              : current && value
                ? `${current.name} / ${value.model}`
                : undefined
          }
        >
          {/* A brief ring whenever the model changes, so a switch (picked, or another session's model) is noticed. */}
          <AnimatePresence initial={false}>
            {!reduceMotion && shown && (
              <motion.span
                key={shown.key}
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
              key={shown?.key ?? "none"}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
              transition={{ duration: 0.18 }}
              className="flex min-w-0 items-center gap-1.5"
            >
              {shown ? (
                <>
                  {drawing ? <ImageIcon className="size-3.5 shrink-0" /> : <Logo className="size-3.5" src={shown.logo} />}
                  <span className="truncate">{shown.label}</span>
                  {shown.provider && (
                    // By the space it has, not the window: a composer in a side panel is narrow in a wide window.
                    <span className="hidden truncate font-normal text-muted-foreground @md:inline">· {shown.provider}</span>
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
      <ModelSelectorContent title="Pick a model" commandProps={{ value: active, onValueChange: setActive, filter: wordFilter }}>
        <ModelSelectorInput placeholder="Search all models…" value={search} onValueChange={setSearch} />
        <ModelSelectorList
          ref={listRef}
          data-lenis-prevent
          className="max-h-[min(28rem,60vh)] scrollbar-thin! scrollbar-gutter-stable"
        >
          {/* cmdk counts rendered rows, so collapsed groups alone would otherwise read as "no models". */}
          {(search || catalog.every((c) => c.models.length === 0)) && (
            <ModelSelectorEmpty>No models found. Add a provider in Settings.</ModelSelectorEmpty>
          )}
          {!search && failed.length > 0 && (
            <div className="mx-1 mt-1 mb-1.5 flex flex-col gap-1 rounded-md border border-coral/30 bg-coral/5 px-2.5 py-2 text-xs">
              {failed.map(({ provider, error }) => (
                <div key={provider.id} className="flex items-start gap-2">
                  <Logo className="mt-px size-3.5" src={providerLogo(provider)} />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{provider.name}’s models didn’t load.</span>{" "}
                    <span className="line-clamp-2 text-muted-foreground">{error}</span>
                  </span>
                </div>
              ))}
              <button
                type="button"
                onClick={retry}
                disabled={retrying}
                className="self-start rounded-md px-1.5 py-0.5 font-medium text-coral hover:bg-coral/10 disabled:opacity-60"
              >
                {retrying ? "Retrying…" : "Retry"}
              </button>
            </div>
          )}
          {!search && !showAll ? (
            // A short list: the current model, the ones used most, and a couple from each provider.
            <ModelSelectorGroup>
              {shortList.map(({ provider, model }) => {
                const target = { providerId: provider.id, model: model.id };
                const selected = !drawing && value?.providerId === provider.id && value.model === model.id;
                const problem = modelProblem(health, target);
                const hint = modelHint(model.id, isLocalProvider(provider.baseUrl));
                return (
                  <ModelSelectorItem
                    key={`${provider.id}/${model.id}`}
                    value={itemValue(provider.name, model.id, model.displayName)}
                    data-current={selected}
                    className={cn("items-start py-2", selected && "bg-brand/10 data-selected:bg-brand/15")}
                    onSelect={() => {
                      onChange(target);
                      setOpen(false);
                    }}
                  >
                    <Logo className="mt-0.5 text-foreground/80" src={modelLogo(model.id) ?? providerLogo(provider)} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={cn("truncate", selected && "font-medium")}>{friendlyName(model.id, model.displayName)}</span>
                        <span className="truncate text-xs text-muted-foreground">{provider.name}</span>
                      </span>
                      {problem && (
                        <span className="flex items-center gap-1 text-xs text-coral">
                          <TriangleAlertIcon className="size-3 shrink-0" />
                          <span className="line-clamp-1">{problem}</span>
                        </span>
                      )}
                    </span>
                    {hint && !problem && <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{hint}</span>}
                    {/* The check's slot is always kept, so a row's chip doesn't shift when it's picked. */}
                    <CheckIcon
                      className={cn("size-4 shrink-0 text-brand", !selected && "invisible")}
                      aria-label={selected ? "Current" : undefined}
                      aria-hidden={!selected}
                    />
                  </ModelSelectorItem>
                );
              })}
              {total > shortList.length && (
                <ModelSelectorItem value="__all-models" onSelect={() => setShowAll(true)} className="text-muted-foreground">
                  <ChevronRightIcon className="size-4" />
                  All models ({total})
                </ModelSelectorItem>
              )}
            </ModelSelectorGroup>
          ) : (
            catalog.map(({ provider, models, error }, i) => {
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
                    {!folded &&
                      models.map((m) => {
                        const selected = !drawing && value?.providerId === provider.id && value.model === m.id;
                        const problem = modelProblem(health, { providerId: provider.id, model: m.id });
                        const name = friendlyName(m.id, m.displayName);
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
                            <ModelSelectorName>{name}</ModelSelectorName>
                            {name !== m.id && <span className="truncate text-xs text-muted-foreground">{m.id}</span>}
                            {problem && <TriangleAlertIcon className="size-3.5 shrink-0 text-coral" aria-label={problem} />}
                            {/* The check's slot is always kept, so a row's chip doesn't shift when it's picked. */}
                    <CheckIcon
                      className={cn("size-4 shrink-0 text-brand", !selected && "invisible")}
                      aria-label={selected ? "Current" : undefined}
                      aria-hidden={!selected}
                    />
                          </ModelSelectorItem>
                        );
                      })}
                  </ModelSelectorGroup>
                </Fragment>
              );
            })
          )}
          {images.length > 0 && (
            <>
              <ModelSelectorSeparator />
              <ModelSelectorGroup
                heading={
                  <span className="flex items-center gap-1.5">
                    <ImageIcon className="size-3" />
                    Image models
                    <span className="ml-auto font-normal opacity-70">draws every message in this chat</span>
                  </span>
                }
              >
                {images.map(({ provider, id, displayName }) => {
                  const selected = !!drawing && imageNow?.providerId === provider.id && imageNow.model === id;
                  return (
                    <ModelSelectorItem
                      key={`image/${provider.id}/${id}`}
                      value={`image ${itemValue(provider.name, id, displayName)}`}
                      className={cn("py-2", selected && "bg-sky-500/10 data-selected:bg-sky-500/15")}
                      onSelect={() => {
                        setImageSettings({ providerId: provider.id, model: id, api: defaultImageApi(provider) });
                        onPickImageModel?.();
                        setOpen(false);
                      }}
                    >
                      <Logo className="text-foreground/80" src={modelLogo(id) ?? providerLogo(provider)} />
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className={cn("truncate", selected && "font-medium")}>{friendlyName(id, displayName)}</span>
                        <span className="truncate text-xs text-muted-foreground">{provider.name}</span>
                      </span>
                      <span className="shrink-0 rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-700 dark:text-sky-300">
                        Image
                      </span>
                      <CheckIcon
                        className={cn("size-4 shrink-0 text-sky-500", !selected && "invisible")}
                        aria-label={selected ? "Current image model" : undefined}
                        aria-hidden={!selected}
                      />
                    </ModelSelectorItem>
                  );
                })}
              </ModelSelectorGroup>
            </>
          )}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
