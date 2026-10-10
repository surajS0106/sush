// Settings: one window for app preferences, the account, providers and the
// Customize sections. Opened at a section via openSettings (lib/library.ts).

import {
  BlocksIcon,
  BrainIcon,
  CheckIcon,
  CircleUserIcon,
  KeyRoundIcon,
  LogOutIcon,
  MicIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  PlugIcon,
  ScrollTextIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useState } from "react";

import { ConnectorsSection } from "@/components/connectors-section";
import { DesignSection, PluginsSection, SkillsSection } from "@/components/customize-sections";
import { MemorySection } from "@/components/memory-section";
import { ProvidersSection } from "@/components/providers-section";
import { Group, Page, Segmented, Setting } from "@/components/settings-layout";
import { SpeechSection } from "@/components/speech-section";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ACCENTS, setAppearance, useAppearance, type Accent, type ChatFont } from "@/lib/appearance";
import { signOut, useSession } from "@/lib/auth";
import { closeSettings, openSettings, useSettings, type SettingsSection } from "@/lib/library";
import type { ProviderView } from "@/lib/tauri";
import { cn, focusComposer } from "@/lib/utils";

interface NavItem {
  id: SettingsSection;
  label: string;
  icon: typeof SettingsIcon;
  /** Extra words the nav search matches, e.g. the settings on the page. */
  keywords: string;
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: "Settings",
    items: [
      { id: "general", label: "General", icon: SettingsIcon, keywords: "appearance theme dark light accent color colour font text size width motion animation" },
      { id: "account", label: "Account", icon: CircleUserIcon, keywords: "profile email name sign out log out" },
      { id: "providers", label: "Providers", icon: KeyRoundIcon, keywords: "models api key openai anthropic azure bedrock local" },
      { id: "speech", label: "Speech", icon: MicIcon, keywords: "dictation voice microphone transcribe whisper ollama gemma" },
      { id: "memory", label: "Memory", icon: BrainIcon, keywords: "remember facts profile import past chats sensitive" },
      { id: "design", label: "Design systems", icon: PaletteIcon, keywords: "brand style guidelines" },
    ],
  },
  {
    group: "Customize",
    items: [
      { id: "skills", label: "Skills", icon: ScrollTextIcon, keywords: "instructions" },
      { id: "connectors", label: "Connectors", icon: PlugIcon, keywords: "mcp tools servers" },
      { id: "plugins", label: "Plugins", icon: BlocksIcon, keywords: "extensions install" },
    ],
  },
];

interface SettingsDialogProps {
  providers: ProviderView[];
  onProvidersChanged: () => void;
}

export function SettingsDialog({ providers, onProvidersChanged }: SettingsDialogProps) {
  const state = useSettings();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const groups = NAV.map(({ group, items }) => ({
    group,
    items: q ? items.filter((i) => `${i.label} ${i.keywords}`.toLowerCase().includes(q)) : items,
  })).filter((g) => g.items.length > 0);

  return (
    <Dialog
      open={state !== null}
      onOpenChange={(open) => {
        if (open) return;
        closeSettings();
        setQuery("");
      }}
    >
      <DialogContent
        className="flex h-[min(760px,90vh)] gap-0 overflow-hidden p-0 sm:max-w-5xl"
        // Focus the search on open rather than ringing the first nav item.
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Back to the composer, e.g. after "New skill" opened a chat with /create-skill.
        onCloseAutoFocus={(e) => {
          if (focusComposer()) e.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">App preferences, account, providers and customizations.</DialogDescription>
        <nav className="flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r bg-sidebar p-3">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search settings"
              className="h-9 w-full rounded-lg border bg-background/50 pr-2.5 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          </div>
          {groups.map(({ group, items }) => (
            <div key={group} className="flex flex-col gap-0.5">
              <p className="px-2.5 pb-1 text-xs text-muted-foreground">{group}</p>
              {items.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => openSettings({ section: id })}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                    state?.section === id && "bg-sidebar-accent font-medium text-sidebar-foreground",
                  )}
                >
                  <Icon className="size-4" /> {label}
                </button>
              ))}
            </div>
          ))}
          {groups.length === 0 && <p className="px-2.5 text-sm text-muted-foreground">No matching settings</p>}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {state?.section === "general" && <GeneralSection />}
          {state?.section === "account" && <AccountSection />}
          {state?.section === "providers" && <ProvidersSection providers={providers} onChanged={onProvidersChanged} />}
          {state?.section === "speech" && <SpeechSection providers={providers} />}
          {state?.section === "memory" && <MemorySection />}
          {state?.section === "design" && <DesignSection />}
          {state?.section === "skills" && <SkillsSection />}
          {state?.section === "connectors" && <ConnectorsSection />}
          {state?.section === "plugins" && <PluginsSection />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// --- general -----------------------------------------------------------------------

const FONTS: { value: ChatFont; label: string; family: string }[] = [
  { value: "sans", label: "Geist Sans", family: '"Geist Variable", sans-serif' },
  { value: "serif", label: "Serif", family: 'ui-serif, "Iowan Old Style", "Palatino Linotype", Georgia, serif' },
  { value: "mono", label: "Monospace", family: 'ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace' },
];

function GeneralSection() {
  const { theme = "system", setTheme } = useTheme();
  const appearance = useAppearance();
  const font = FONTS.find((f) => f.value === appearance.chatFont) ?? FONTS[0];

  return (
    <Page>
      <Group title="Appearance">
        <Setting title="Theme">
          <Segmented
            label="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: "system", label: "System", icon: MonitorIcon },
              { value: "light", label: "Light", icon: SunIcon },
              { value: "dark", label: "Dark", icon: MoonIcon },
            ]}
          />
        </Setting>
        <Setting title="Accent color" description="Highlight color for the send button, commands and other accents.">
          <AccentPicker value={appearance.accent} onChange={(accent) => setAppearance({ accent })} />
        </Setting>
        <Setting title="Chat font">
          <Select value={appearance.chatFont} onValueChange={(v) => setAppearance({ chatFont: v as ChatFont })}>
            <SelectTrigger
              aria-label="Chat font"
              className="border-none bg-transparent shadow-none hover:bg-accent dark:bg-transparent dark:hover:bg-accent"
              style={{ fontFamily: font.family }}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {FONTS.map((f) => (
                <SelectItem key={f.value} value={f.value} style={{ fontFamily: f.family }}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Setting>
        <Setting title="Transcript text size" description="Size of the conversation transcript text.">
          <Segmented
            label="Transcript text size"
            value={appearance.textSize}
            onChange={(textSize) => setAppearance({ textSize })}
            options={[
              { value: "small", label: "Small" },
              { value: "medium", label: "Medium" },
              { value: "large", label: "Large" },
            ]}
          />
        </Setting>
        <Setting title="Transcript width" description="Maximum width of the transcript and composer columns.">
          <Segmented
            label="Transcript width"
            value={appearance.width}
            onChange={(width) => setAppearance({ width })}
            options={[
              { value: "narrow", label: "Narrow" },
              { value: "medium", label: "Medium" },
              { value: "wide", label: "Wide" },
            ]}
          />
        </Setting>
        <Setting title="Motion" description="Reduce animation in streaming responses and other interface elements.">
          <Segmented
            label="Motion"
            value={appearance.motion}
            onChange={(motion) => setAppearance({ motion })}
            options={[
              { value: "system", label: "System" },
              { value: "reduced", label: "Reduced" },
            ]}
          />
        </Setting>
      </Group>
    </Page>
  );
}

function AccentPicker({ value, onChange }: { value: Accent; onChange: (accent: Accent) => void }) {
  return (
    <div role="radiogroup" aria-label="Accent color" className="flex gap-1.5">
      {ACCENTS.map((a) => (
        <Tooltip key={a.value}>
          <TooltipTrigger asChild>
            {/* data-accent scopes --brand to this swatch (index.css). */}
            <button
              type="button"
              role="radio"
              aria-checked={value === a.value}
              aria-label={a.label}
              data-accent={a.value}
              onClick={() => onChange(a.value)}
              className={cn(
                "flex size-6 items-center justify-center rounded-full bg-brand text-brand-foreground ring-offset-2 ring-offset-background transition-shadow hover:ring-2 hover:ring-brand/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                value === a.value && "ring-2 ring-brand hover:ring-brand",
              )}
            >
              {value === a.value && <CheckIcon className="size-3.5" strokeWidth={3} />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{a.label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

// --- account -----------------------------------------------------------------------

function AccountSection() {
  const { data: session } = useSession();
  const user = session?.user;
  const initial = (user?.name || user?.email || "?").charAt(0).toUpperCase();

  return (
    <Page>
      <Group title="Account">
        <div className="flex items-center gap-3 py-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-brand text-base font-medium text-brand-foreground">
            {initial}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{user?.name || "Unnamed"}</p>
            <p className="truncate text-sm text-muted-foreground">{user?.email}</p>
          </div>
        </div>
        <Setting title="Sign out" description="Sign out of Sush on this device. Your chats stay on this computer.">
          <Button variant="outline" size="sm" onClick={() => void signOut()}>
            <LogOutIcon /> Sign out
          </Button>
        </Setting>
      </Group>
    </Page>
  );
}
