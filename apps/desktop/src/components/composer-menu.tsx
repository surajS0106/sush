// The composer's `+` menu: attach context, record a skill (via /create-skill), pick skills /
// connectors / design system / plugins, and toggle research, memory and
// clarifying questions.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
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
  TelescopeIcon,
  UnplugIcon,
  VideoIcon,
} from "lucide-react";
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
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

  const manage = (section: SettingsSection) => openSettings({ section });

  const addFolder = async () => {
    const path = await openDialog({ directory: true, title: "Add folder" });
    if (typeof path !== "string") return;
    try {
      const folder = await api.readFolder(path);
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

  return (
    <PromptInputActionMenu>
      <PromptInputActionMenuTrigger
        aria-label="Add tools and context"
        className="rounded-full text-muted-foreground hover:text-foreground [&_svg]:transition-transform [&_svg]:duration-150 data-[state=open]:[&_svg]:rotate-45"
      >
        <PlusIcon className="size-4" />
      </PromptInputActionMenuTrigger>
      <PromptInputActionMenuContent className="w-64 rounded-2xl p-1.5 [&_[role^=menuitem]]:gap-2.5 [&_[role^=menuitem]]:rounded-lg [&_[role^=menuitem]]:py-2 [&_[role^=menuitem]]:font-medium [&_[role^=menuitem]_svg]:text-muted-foreground">
        <PromptInputActionMenuItem onSelect={() => attachments.openFileDialog()}>
          <PaperclipIcon /> Add files or photos
          <DropdownMenuShortcut>Ctrl+U</DropdownMenuShortcut>
        </PromptInputActionMenuItem>
        <PromptInputActionMenuItem onSelect={() => void addFolder()}>
          <FolderPlusIcon /> Add folder
        </PromptInputActionMenuItem>
        <PromptInputActionMenuItem disabled={!target || messages.length === 0} onSelect={recordSkill}>
          <VideoIcon /> Record a skill
        </PromptInputActionMenuItem>

        <DropdownMenuSeparator />

        <Submenu icon={<ScrollTextIcon />} label="Skills" count={skills.filter((s) => s.enabled).length}>
          {skills.map((s) => (
            <DropdownMenuCheckboxItem
              key={s.id}
              checked={s.enabled}
              onCheckedChange={(on) => toggleSkill(s.id, on)}
              onSelect={(e) => e.preventDefault()}
            >
              <span className="truncate">{s.name}</span>
            </DropdownMenuCheckboxItem>
          ))}
          {skills.length > 0 && <DropdownMenuSeparator />}
          <PromptInputActionMenuItem onSelect={createSkillInChat}>
            <SparklesIcon /> Create a skill
          </PromptInputActionMenuItem>
          {skills.length > 0 && (
            <PromptInputActionMenuItem onSelect={() => manage("skills")}>
              <SettingsIcon /> Manage skills
            </PromptInputActionMenuItem>
          )}
        </Submenu>

        <Submenu icon={<PlugIcon />} label="Connectors" count={connectors.filter((c) => c.enabled).length}>
          {connectors.map((c) => {
            const s = status[c.id];
            return (
              <DropdownMenuCheckboxItem
                key={c.id}
                checked={c.enabled}
                onCheckedChange={(on) => toggleConnector(c.id, on)}
                onSelect={(e) => e.preventDefault()}
              >
                <span className="flex-1 truncate">{c.name}</span>
                {c.enabled && (
                  <span
                    title={s?.state === "error" ? s.error : s?.state}
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      s?.state === "ready" ? "bg-emerald-500" : s?.state === "error" ? "bg-destructive" : "bg-muted-foreground/40",
                    )}
                  />
                )}
              </DropdownMenuCheckboxItem>
            );
          })}
          {connectors.length > 0 && <DropdownMenuSeparator />}
          <PromptInputActionMenuItem onSelect={() => manage("connectors")}>
            {connectors.length > 0 ? <SettingsIcon /> : <UnplugIcon />}{" "}
            {connectors.length > 0 ? "Manage connectors" : "Add a connector"}
          </PromptInputActionMenuItem>
        </Submenu>

        <Submenu icon={<PaletteIcon />} label="Design system" count={prefs.designSystemId ? 1 : 0}>
          <DropdownMenuRadioGroup
            value={prefs.designSystemId ?? ""}
            onValueChange={(id) => setPrefs({ designSystemId: id || null })}
          >
            <DropdownMenuRadioItem value="" onSelect={(e) => e.preventDefault()}>
              None
            </DropdownMenuRadioItem>
            {designSystems.map((d) => (
              <DropdownMenuRadioItem key={d.id} value={d.id} onSelect={(e) => e.preventDefault()}>
                <span className="truncate">{d.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <PromptInputActionMenuItem onSelect={() => manage("design")}>
            <SettingsIcon /> {designSystems.length > 0 ? "Manage design systems" : "Create a design system"}
          </PromptInputActionMenuItem>
        </Submenu>

        <Submenu icon={<BlocksIcon />} label="Plugins" count={plugins.filter((p) => p.enabled).length}>
          {plugins.map((p) => (
            <DropdownMenuCheckboxItem
              key={p.id}
              checked={p.enabled}
              onCheckedChange={(on) => togglePlugin(p.id, on)}
              onSelect={(e) => e.preventDefault()}
            >
              <span className="truncate">{p.name}</span>
            </DropdownMenuCheckboxItem>
          ))}
          {plugins.length > 0 && <DropdownMenuSeparator />}
          <PromptInputActionMenuItem onSelect={() => manage("plugins")}>
            <SettingsIcon /> {plugins.length > 0 ? "Manage plugins" : "Install a plugin"}
          </PromptInputActionMenuItem>
        </Submenu>

        <DropdownMenuSeparator />

        <DropdownMenuCheckboxItem
          checked={prefs.research && researchAvailable}
          disabled={!researchAvailable}
          onCheckedChange={(on) => setPrefs({ research: on })}
          onSelect={(e) => e.preventDefault()}
        >
          <TelescopeIcon /> Research
          {!researchAvailable && <span className="ml-auto text-xs font-normal">Claude only</span>}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={prefs.memory}
          onCheckedChange={(on) => setPrefs({ memory: on })}
          onSelect={(e) => e.preventDefault()}
        >
          <BrainIcon /> Memory
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={askUser} onCheckedChange={setAskUser} onSelect={(e) => e.preventDefault()}>
          <MessageCircleQuestionMarkIcon /> Ask clarifying questions
        </DropdownMenuCheckboxItem>

        <DropdownMenuSeparator />
        <PromptInputActionMenuItem onSelect={onOpenSettings}>
          <SettingsIcon /> Manage providers
        </PromptInputActionMenuItem>
      </PromptInputActionMenuContent>
    </PromptInputActionMenu>
  );
}

function Submenu({
  icon,
  label,
  count,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {icon} {label}
        {count > 0 && <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">{count}</span>}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto rounded-xl p-1.5">{children}</DropdownMenuSubContent>
    </DropdownMenuSub>
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
