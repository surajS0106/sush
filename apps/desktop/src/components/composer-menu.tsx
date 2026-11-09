// The composer's `+` menu: attach context, record a skill (via /create-skill), pick skills /
// connectors / design system / plugins, and toggle research, memory and
// clarifying questions.

import {
  BlocksIcon,
  BrainIcon,
  FolderPlusIcon,
  MessageCircleQuestionMarkIcon,
  PaletteIcon,
  PaperclipIcon,
  PlugIcon,
  PlusIcon,
  ScrollTextIcon,
  SettingsIcon,
  SparklesIcon,
  CircleDotIcon,
  TelescopeIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";


import {
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
  PromptInputActionMenuTrigger,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu";
import { brandLogo, catalogEntry, connectorIcon } from "@/lib/connector-catalog";
import {
  availableConnectors,
  availableDesignSystems,
  availableSkills,
  createSkillInChat,
  openSettings,
  setPrefs,
  toggleConnector,
  togglePlugin,
  toggleSkill,
  useConnectors,
  useConnectorStatus,
  useDesignSystems,
  usePlugins,
  usePrefs,
  useSkills,
  type SettingsSection,
} from "@/lib/library";
import { setAskUser, useAskUser } from "@/lib/store";
import { api, errorMessage, type Folder } from "@/lib/tauri";
import { FOLDER_MEDIA_TYPE, type ModelTarget, type SushUIMessage } from "@/lib/transport";
import { cn } from "@/lib/utils";

interface ComposerMenuProps {
  target: ModelTarget | null;
  messages: SushUIMessage[];
  researchAvailable: boolean;
  onOpenSettings: () => void;
  /** Send a message in this chat, e.g. `/create-skill` for "Record a skill". */
  onSend: (text: string) => void;
}

export function ComposerMenu({ target, messages, researchAvailable, onOpenSettings, onSend }: ComposerMenuProps) {
  const { attachments } = usePromptInputController();
  const askUser = useAskUser();
  const prefs = usePrefs();
  // Subscribe so the lists below re-render; filtering reads the live stores.
  useSkills();
  useConnectors();
  useDesignSystems();
  const plugins = usePlugins();
  const status = useConnectorStatus();
  const skills = availableSkills();
  const connectors = availableConnectors();
  const designSystems = availableDesignSystems();

  const { anchor, geo, measure } = useComposerSpan();

  const manage = (section: SettingsSection) => openSettings({ section });

  const addFolder = async () => {
    try {
      const folder = await api.pickFolderAttachment();
      if (!folder) return;
      if (folder.files.length === 0) {
        toast.error(`No readable text files in ${folder.name}`);
        return;
      }
      attachments.add([folderFile(folder)]);
      if (folder.truncated) toast.warning(`${folder.name} is large; only the first ${folder.files.length} files were added.`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // Sush drafts the skill right here, with this chat as context, and asks before saving it.
  const recordSkill = () => onSend("/create-skill Turn what we did in this chat into a reusable skill.");

  const enabledSkills = skills;

  return (
    <PromptInputActionMenu onOpenChange={measure}>
      <span ref={anchor} className="inline-flex">
      <PromptInputActionMenuTrigger aria-label="Add tools and context" className={MENU_TRIGGER}>
        <PlusIcon className="size-4" />
      </PromptInputActionMenuTrigger>
      </span>
      <PromptInputActionMenuContent
        side="top"
        align="start"
        alignOffset={geo?.alignOffset ?? 0}
        sideOffset={geo?.sideOffset ?? 8}
        style={geo ? { width: geo.width } : undefined}
        className={MENU_CONTENT}>
        <Section first>Add</Section>
        <PromptInputActionMenuItem onSelect={() => attachments.openFileDialog()}>
          <PaperclipIcon /> <Label hint="Images, PDFs and text">Files and photos</Label>
          <DropdownMenuShortcut>Ctrl+U</DropdownMenuShortcut>
        </PromptInputActionMenuItem>
        <PromptInputActionMenuItem onSelect={() => void addFolder()}>
          <FolderPlusIcon /> <Label hint="Include a folder's files">Add folder</Label>
        </PromptInputActionMenuItem>
        <PromptInputActionMenuItem disabled={!target || messages.length === 0} onSelect={recordSkill}>
          <CircleDotIcon /> <Label hint="Turn this chat into a skill">Record a skill</Label>
        </PromptInputActionMenuItem>

        <Section>Settings</Section>
        <DropdownMenuCheckboxItem
          checked={prefs.research && researchAvailable}
          disabled={!researchAvailable}
          onCheckedChange={(on) => setPrefs({ research: on })}
          onSelect={(e) => e.preventDefault()}
        >
          <TelescopeIcon /> <Label hint={researchAvailable ? "Search the web in depth" : "Turn on web search first"}>Research</Label>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={prefs.memory} onCheckedChange={(on) => setPrefs({ memory: on })} onSelect={(e) => e.preventDefault()}>
          <BrainIcon /> <Label hint="Remember things across chats">Memory</Label>
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={askUser} onCheckedChange={setAskUser} onSelect={(e) => e.preventDefault()}>
          <MessageCircleQuestionMarkIcon /> <Label hint="Check in before big tasks">Ask clarifying questions</Label>
        </DropdownMenuCheckboxItem>

        <Section>Skills</Section>
        {enabledSkills.map((x) => (
          <DropdownMenuCheckboxItem key={x.id} checked={x.enabled} onCheckedChange={(on) => toggleSkill(x.id, on)} onSelect={(e) => e.preventDefault()}>
            <ScrollTextIcon /> <Label>{x.name}</Label>
          </DropdownMenuCheckboxItem>
        ))}
        <PromptInputActionMenuItem onSelect={createSkillInChat}>
          <SparklesIcon /> <Label hint="Write a new skill">Create a skill</Label>
        </PromptInputActionMenuItem>

        <Section>Connectors</Section>
        {connectors.map((c) => {
          const s = status[c.id];
          return (
            <DropdownMenuCheckboxItem key={c.id} checked={c.enabled} onCheckedChange={(on) => toggleConnector(c.id, on)} onSelect={(e) => e.preventDefault()}>
              <ConnectorMark connector={c} />
              <Label>{c.name}</Label>
              {c.enabled && (
                <span
                  title={s?.state === "error" ? s.error : s?.state === "needs-auth" ? "Sign in under Manage connectors" : s?.state}
                  className={cn(
                    "mr-4 size-1.5 shrink-0 rounded-full",
                    s?.state === "ready" ? "bg-emerald-500" : s?.state === "error" ? "bg-destructive" : s?.state === "needs-auth" ? "bg-amber-500" : "bg-muted-foreground/40",
                  )}
                />
              )}
            </DropdownMenuCheckboxItem>
          );
        })}
        <PromptInputActionMenuItem onSelect={() => manage("connectors")}>
          <SettingsIcon /> <Label hint={connectors.length > 0 ? "Sign in, add or remove" : "Connect an app or data source"}>{connectors.length > 0 ? "Manage connectors" : "Add a connector"}</Label>
        </PromptInputActionMenuItem>

        <Section>Design system</Section>
        <DropdownMenuRadioGroup value={prefs.designSystemId ?? ""} onValueChange={(id) => setPrefs({ designSystemId: id || null })}>
          <DropdownMenuRadioItem value="" onSelect={(e) => e.preventDefault()}>
            <PaletteIcon /> <Label hint="Don't apply a brand">None</Label>
          </DropdownMenuRadioItem>
          {designSystems.map((d) => (
            <DropdownMenuRadioItem key={d.id} value={d.id} onSelect={(e) => e.preventDefault()}>
              <PaletteIcon /> <Label>{d.name}</Label>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <PromptInputActionMenuItem onSelect={() => manage("design")}>
          <SettingsIcon /> <Label>{designSystems.length > 0 ? "Manage design systems" : "Create a design system"}</Label>
        </PromptInputActionMenuItem>

        <Section>Plugins</Section>
        {plugins.map((p) => (
          <DropdownMenuCheckboxItem key={p.id} checked={p.enabled} onCheckedChange={(on) => togglePlugin(p.id, on)} onSelect={(e) => e.preventDefault()}>
            <BlocksIcon /> <Label>{p.name}</Label>
          </DropdownMenuCheckboxItem>
        ))}
        <PromptInputActionMenuItem onSelect={() => manage("plugins")}>
          <SettingsIcon /> <Label>{plugins.length > 0 ? "Manage plugins" : "Install a plugin"}</Label>
        </PromptInputActionMenuItem>

        <DropdownMenuSeparator />
        <PromptInputActionMenuItem onSelect={onOpenSettings}>
          <SettingsIcon /> <Label hint="Models and API keys">Manage providers</Label>
        </PromptInputActionMenuItem>
      </PromptInputActionMenuContent>
    </PromptInputActionMenu>
  );
}

/** The `+` button. */
export const MENU_TRIGGER =
  "rounded-full text-muted-foreground hover:text-foreground [&_svg]:transition-transform [&_svg]:duration-150 data-[state=open]:[&_svg]:rotate-45";

/** The menu's panel: as wide as the composer, rising out of it. */
export const MENU_CONTENT =
  "max-h-[min(26rem,var(--radix-dropdown-menu-content-available-height))] max-w-none origin-bottom overflow-y-auto rounded-xl p-1.5 data-open:animate-[composer-menu-in_240ms_cubic-bezier(0.22,1,0.36,1)]! [&_[role^=menuitem]]:gap-2.5 [&_[role^=menuitem]]:rounded-md [&_[role^=menuitem]]:py-1.5 [&_[role^=menuitem]]:text-sm [&_[role^=menuitem]_svg]:text-muted-foreground";

/** The menu spans the composer: measure it when the menu opens and sit just above its top edge. */
export function useComposerSpan() {
  const anchor = useRef<HTMLSpanElement>(null);
  const [geo, setGeo] = useState<{ width: number; alignOffset: number; sideOffset: number } | null>(null);
  const measure = (open: boolean) => {
    const el = anchor.current;
    const box = el?.closest("form")?.getBoundingClientRect();
    if (!open || !el || !box) return;
    const at = el.getBoundingClientRect();
    setGeo({ width: box.width, alignOffset: box.left - at.left, sideOffset: at.top - box.top + 8 });
  };
  return { anchor, geo, measure };
}

/** A connector's own logo: full colour where it ships one, else its mark in the brand colour, else a plug. */
export function ConnectorMark({
  connector,
  className = "size-4",
}: {
  connector: Parameters<typeof connectorIcon>[0];
  className?: string;
}) {
  const brand = brandLogo(connector);
  if (brand) return <img src={brand} alt="" className={cn("shrink-0 rounded-[20%] object-cover", className)} />;
  const src = connectorIcon(connector);
  if (!src) return <PlugIcon className={className} />;
  return (
    <span
      aria-hidden
      className={cn("shrink-0 bg-current", className)}
      style={{
        backgroundColor: catalogEntry(connector.catalogId)?.color,
        mask: `url("${src}") center / contain no-repeat`,
        WebkitMask: `url("${src}") center / contain no-repeat`,
      }}
    />
  );
}

/** A group heading, as in the slash-command picker. */
export function Section({ first, children }: { first?: boolean; children: React.ReactNode }) {
  return (
    <DropdownMenuLabel className={cn("px-2 pb-1 text-xs font-medium text-muted-foreground/70", first ? "pt-1" : "pt-3")}>
      {children}
    </DropdownMenuLabel>
  );
}

/** A row's name in bold with its description beside it, muted. */
export function Label({ hint, children }: { hint?: string; children: React.ReactNode }) {
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="shrink-0 font-medium">{children}</span>
      {hint && <span className="truncate text-[13px] font-normal text-muted-foreground">{hint}</span>}
    </span>
  );
}

/** A folder as one attachment: every file's text, tagged with its path. */
function folderFile(folder: Folder): File {
  const body = folder.files.map((f) => `<file path="${f.path}">\n${f.content}\n</file>`).join("\n");
  const notes = [
    folder.skipped > 0 && `${folder.skipped} binary or oversized files were left out.`,
    folder.truncated && "The folder was too large to include completely.",
  ].filter(Boolean);
  const text = `<folder name="${folder.name}" files="${folder.files.length}">\n${body}\n${notes.join(" ")}</folder>`;
  return new File([text], `${folder.name} (${folder.files.length} files)`, { type: FOLDER_MEDIA_TYPE });
}
