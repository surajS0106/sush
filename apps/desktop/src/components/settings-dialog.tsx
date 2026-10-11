// Settings: one window for app preferences, the account, providers and the
// Customize sections. Opened at a section via openSettings (lib/library.ts).

import {
  BlocksIcon,
  BrainIcon,
  CircleUserIcon,
  ImageIcon,
  KeyRoundIcon,
  LogOutIcon,
  MicIcon,
  PaletteIcon,
  PencilIcon,
  PlugIcon,
  ScrollTextIcon,
  SearchIcon,
  SettingsIcon,
  ShapesIcon,
  Trash2Icon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { ConnectorsSection } from "@/components/connectors-section";
import { DesignSection, PluginsSection, SkillsSection } from "@/components/customize-sections";
import { MemorySection } from "@/components/memory-section";
import { ProvidersSection } from "@/components/providers-section";
import { Group, Page, Segmented, Setting } from "@/components/settings-layout";
import { SpeechSection } from "@/components/speech-section";
import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/ColorPicker";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu } from "@/components/ui/DropdownMenu";
import {
  DropdownMenu as DropdownMenuRoot,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { HoverHighlight } from "@/components/ui/motion-highlight";
import { AvatarSprite, UserAvatar } from "@/components/user-avatar";
import { ACCENTS, setAppearance, transitionTheme, useAppearance, type Accent, type ChatFont } from "@/lib/appearance";
import { changePassword, signOut, updateProfile, useSession } from "@/lib/auth";
import { AVATARS, avatarId, builtinAvatar, photoToDataUrl } from "@/lib/avatars";
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
      { id: "account", label: "Account", icon: CircleUserIcon, keywords: "profile email name photo picture avatar password sign out log out" },
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
          <HoverHighlight className="flex flex-col gap-4" highlightClassName="rounded-lg bg-sidebar-accent">
            {groups.map(({ group, items }) => (
              <div key={group} className="flex flex-col gap-0.5">
                <p className="px-2.5 pb-1 text-xs text-muted-foreground">{group}</p>
                {items.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    data-hover-item
                    onClick={() => openSettings({ section: id })}
                    className={cn(
                      "relative flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-sidebar-foreground/80 hover:text-sidebar-foreground",
                      state?.section === id && "bg-sidebar-accent font-medium text-sidebar-foreground",
                    )}
                  >
                    <Icon className="size-4" /> {label}
                  </button>
                ))}
              </div>
            ))}
            {groups.length === 0 && <p className="px-2.5 text-sm text-muted-foreground">No matching settings</p>}
          </HoverHighlight>
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

// "mono" is DM Mono so a monospace preference saved before the second one
// existed still resolves.
const FONTS: { value: ChatFont; label: string; family: string }[] = [
  { value: "sans", label: "Plus Jakarta Sans", family: '"Plus Jakarta Sans Variable", sans-serif' },
  { value: "serif", label: "Lora", family: '"Lora Variable", Georgia, serif' },
  { value: "mono", label: "DM Mono", family: '"DM Mono", ui-monospace, monospace' },
  { value: "space-mono", label: "Space Mono", family: '"Space Mono", ui-monospace, monospace' },
];

function GeneralSection() {
  const { theme = "system", setTheme } = useTheme();
  const appearance = useAppearance();

  return (
    <Page>
      <Group title="Appearance">
        <Setting title="Theme">
          <ThemePicker value={theme} onChange={(t) => transitionTheme(() => setTheme(t))} />
        </Setting>
        <Setting title="Accent color" description="Highlight color for the send button, commands and other accents.">
          <AccentPicker
            value={appearance.accent}
            onChange={(accent) => setAppearance({ accent })}
            custom={appearance.customAccent}
            onCustomChange={(customAccent) => setAppearance({ customAccent })}
          />
        </Setting>
        <Setting title="Chat font">
          <DropdownMenu
            label="Chat font"
            align="end"
            value={appearance.chatFont}
            onChange={(chatFont) => setAppearance({ chatFont })}
            items={FONTS.map((f) => ({ value: f.value, label: f.label, style: { fontFamily: f.family } }))}
          />
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
        <Setting
          title="Transcript width"
          description={
            appearance.width === "custom"
              ? `Custom, ${appearance.customWidth}px. Drag the column's edges in a chat, or pick a preset.`
              : "Maximum width of the transcript and composer columns. You can also drag the column's edges in a chat."
          }
        >
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

const THEMES = [
  { value: "system", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

/** Theme choices as little window previews, like macOS's Appearance setting. */
function ThemePicker({ value, onChange }: { value: string; onChange: (theme: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Theme" className="flex gap-4">
      {THEMES.map((t) => {
        const selected = value === t.value;
        return (
          <button
            key={t.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(t.value)}
            className="group flex flex-col items-center gap-2 rounded-lg outline-none"
          >
            <span
              className={cn(
                "rounded-[10px] p-0.5 ring-2 transition-shadow",
                selected ? "ring-brand" : "ring-transparent group-hover:ring-foreground/15",
                "group-focus-visible:ring-ring/50",
              )}
            >
              <span className="relative block h-14 w-20 overflow-hidden rounded-lg ring-1 ring-foreground/10">
                {t.value === "system" ? (
                  <>
                    <ThemePreview mode="light" />
                    {/* The dark half, cut on a slant like the macOS Auto tile. */}
                    <span className="absolute inset-0" style={{ clipPath: "polygon(55% 0, 100% 0, 100% 100%, 45% 100%)" }}>
                      <ThemePreview mode="dark" />
                    </span>
                  </>
                ) : (
                  <ThemePreview mode={t.value} />
                )}
              </span>
            </span>
            <span className={cn("text-xs", selected ? "font-semibold text-foreground" : "text-muted-foreground")}>
              {t.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A miniature desktop: accent wallpaper, a menu bar strip and a window with traffic lights. */
function ThemePreview({ mode }: { mode: "light" | "dark" }) {
  const dark = mode === "dark";
  const panel = dark ? "#1c1c1e" : "#ffffff";
  return (
    <span
      className="absolute inset-0 bg-brand"
      style={{
        backgroundImage: dark
          ? "linear-gradient(135deg, rgb(0 0 0 / 0.55), rgb(0 0 0 / 0.15) 60%, rgb(255 255 255 / 0.1))"
          : "linear-gradient(135deg, rgb(255 255 255 / 0.75), rgb(255 255 255 / 0.35) 60%, rgb(255 255 255 / 0.1))",
      }}
      aria-hidden
    >
      <span
        className="absolute top-1.5 left-1.5 flex h-3.5 w-11 items-center rounded-sm px-1 shadow-sm"
        style={{ background: dark ? "rgb(28 28 30 / 0.85)" : "rgb(255 255 255 / 0.85)" }}
      >
        <span className="h-1.5 w-full rounded-full bg-brand" />
      </span>
      <span className="absolute top-7 left-5 flex h-10 w-16 gap-1 rounded-md p-1.5 shadow-md" style={{ background: panel }}>
        <span className="size-1.5 rounded-full bg-[#ff5f57]" />
        <span className="size-1.5 rounded-full bg-[#febc2e]" />
        <span className="size-1.5 rounded-full bg-[#28c840]" />
      </span>
    </span>
  );
}

function AccentPicker({
  value,
  onChange,
  custom,
  onCustomChange,
}: {
  value: Accent;
  onChange: (accent: Accent) => void;
  custom: string;
  onCustomChange: (hex: string) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {value === "custom" && (
        <ColorPicker
          label="Custom accent color"
          value={custom}
          onChange={onCustomChange}
          swatches={[]}
          triggerClassName="size-5 rounded-full ring-1 ring-foreground/15 transition-transform hover:scale-110"
        />
      )}
      <DropdownMenu
        label="Accent color"
        align="end"
        value={value}
        onChange={onChange}
        items={ACCENTS.map((a) => ({ ...a, icon: <AccentSwatch accent={a.value} /> }))}
      />
    </div>
  );
}

function AccentSwatch({ accent }: { accent: Accent }) {
  if (accent === "custom") {
    return (
      <span
        className="size-3.5 shrink-0 rounded-full"
        style={{ background: "conic-gradient(#f43f5e, #f59e0b, #22c55e, #06b6d4, #6366f1, #d946ef, #f43f5e)" }}
        aria-hidden
      />
    );
  }
  // data-accent scopes --brand to this swatch (index.css).
  return <span data-accent={accent} className="size-3.5 shrink-0 rounded-full bg-brand" aria-hidden />;
}

// --- account -----------------------------------------------------------------------

function AccountSection() {
  const { data: session } = useSession();
  const user = session?.user;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const setImage = async (image: string | null, done: string) => {
    try {
      await updateProfile({ image });
      toast.success(done);
    } catch (e) {
      toast.error(`Couldn't update your picture: ${errorMessage(e)}`);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      await setImage(await photoToDataUrl(file), "Photo updated");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Page>
      <Group title="Account">
        <div className="flex items-center gap-4 py-4">
          <div className="relative shrink-0">
            <UserAvatar image={user?.image} name={user?.name} email={user?.email} className="size-16 text-2xl" />
            <DropdownMenuRoot>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Change picture"
                  className="absolute -right-1 -bottom-1 flex size-7 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-xs transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:text-foreground"
                >
                  <PencilIcon className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-48">
                <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
                  <ImageIcon /> Upload photo
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setPickerOpen(true)}>
                  <ShapesIcon /> Choose an avatar
                </DropdownMenuItem>
                {user?.image && (
                  <DropdownMenuItem variant="destructive" onSelect={() => void setImage(null, "Picture removed")}>
                    <Trash2Icon /> Remove
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenuRoot>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/heic"
              className="hidden"
              onChange={(e) => {
                void onFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
          <div className="min-w-0">
            <p className="truncate text-base font-medium">{user?.name || "Unnamed"}</p>
            <p className="truncate text-sm text-muted-foreground">{user?.email}</p>
          </div>
        </div>
        <Setting title="Full name">
          <ProfileField
            label="Full name"
            value={user?.name ?? ""}
            autoComplete="name"
            onSave={async (name) => {
              if (!name) throw new Error("Name can't be empty.");
              await updateProfile({ name });
              return "Name updated";
            }}
          />
        </Setting>
        <Setting title="Email" description="The address you sign in with.">
          <p className="max-w-72 truncate text-sm text-muted-foreground">{user?.email}</p>
        </Setting>
        <Setting title="Password">
          <Button variant="outline" size="sm" onClick={() => setPasswordOpen(true)}>
            <KeyRoundIcon /> Change password
          </Button>
        </Setting>
        <Setting title="Sign out" description="Sign out of Sush on this device. Your chats stay on this computer.">
          <Button variant="outline" size="sm" onClick={() => void signOut()}>
            <LogOutIcon /> Sign out
          </Button>
        </Setting>
      </Group>
      <AvatarPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        current={user?.image}
        onPick={(key) => {
          setPickerOpen(false);
          void setImage(avatarId(key), "Avatar updated");
        }}
      />
      <PasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
    </Page>
  );
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A text field that saves when it loses focus or on Enter. `onSave` returns
 * the toast to show, or throws and the saved value comes back.
 */
function ProfileField({
  label,
  value,
  autoComplete,
  onSave,
}: {
  label: string;
  value: string;
  autoComplete?: string;
  onSave: (value: string) => Promise<string>;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  // Follow the account when it changes elsewhere (or after a save).
  useEffect(() => setDraft(value), [value]);

  const commit = async () => {
    const next = draft.trim();
    if (next === value || saving) return setDraft(value);
    setSaving(true);
    try {
      toast.success(await onSave(next));
    } catch (e) {
      toast.error(errorMessage(e));
      setDraft(value);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Input
      aria-label={label}
      value={draft}
      autoComplete={autoComplete}
      spellCheck={false}
      disabled={saving}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      className="h-9 w-72"
    />
  );
}

function AvatarPicker({
  open,
  onOpenChange,
  current,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current?: string | null;
  onPick: (key: string) => void;
}) {
  const selected = builtinAvatar(current)?.key;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle>Choose an avatar</DialogTitle>
        <DialogDescription>Shown in the sidebar and on your account instead of a photo.</DialogDescription>
        <div role="radiogroup" aria-label="Avatars" className="grid grid-cols-4 gap-3 pt-2">
          {AVATARS.map((a) => (
            <button
              key={a.key}
              type="button"
              role="radio"
              aria-checked={selected === a.key}
              onClick={() => onPick(a.key)}
              className="group flex flex-col items-center gap-2 rounded-xl p-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <span
                className={cn(
                  "rounded-full p-0.5 ring-2 transition-shadow",
                  selected === a.key ? "ring-brand" : "ring-transparent group-hover:ring-foreground/15",
                )}
              >
                <AvatarSprite avatar={a} className="size-16 rounded-full" />
              </span>
              <span className="text-center text-xs text-muted-foreground group-hover:text-foreground">{a.label}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
    setError("");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next.length < 8) return setError("The new password needs at least 8 characters.");
    if (next !== confirm) return setError("The new passwords don't match.");
    setSaving(true);
    try {
      await changePassword(current, next);
      toast.success("Password changed. Other devices were signed out.");
      onOpenChange(false);
      reset();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogTitle>Change password</DialogTitle>
        <DialogDescription>Signs you out everywhere else.</DialogDescription>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3 pt-1">
          <Input type="password" placeholder="Current password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required className="h-9" />
          <Input type="password" placeholder="New password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required className="h-9" />
          <Input type="password" placeholder="Confirm new password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required className="h-9" />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={saving} className="mt-1">
            {saving ? "Saving…" : "Change password"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
