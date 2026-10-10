// Settings sections for skills, design systems, connectors and plugins.
// Rendered by the settings dialog; the composer's `+` menu opens them via openSettings.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { PencilIcon, PlusIcon, RefreshCwIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  availableDesignSystems,
  connect,
  createSkillInChat,
  deleteConnector,
  deleteDesignSystem,
  deleteSkill,
  installPlugin,
  removePlugin,
  saveConnector,
  saveDesignSystem,
  saveSkill,
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
  type Connector,
  type DesignSystem,
  type Skill,
} from "@/lib/library";
import { slugify } from "@/lib/skills";
import { errorMessage } from "@/lib/tauri";

// --- shared bits -------------------------------------------------------------------

function SectionHeader({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b py-4 pr-14 pl-6">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

function Row({
  title,
  subtitle,
  badge,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  badge?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-6 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {badge && (
            <Badge variant="secondary" className="shrink-0">
              {badge}
            </Badge>
          )}
        </div>
        {subtitle && <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{subtitle}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-6 py-10 text-center text-sm text-muted-foreground">{children}</p>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function usePluginName() {
  const plugins = usePlugins();
  return (id?: string) => plugins.find((p) => p.id === id)?.name;
}

// --- skills ------------------------------------------------------------------------

// New skills are made with Sush in chat (/create-skill); this editor is for tweaking saved ones.
export function SkillsSection() {
  const skills = useSkills();
  const pluginName = usePluginName();
  const [editing, setEditing] = useState<Skill | null>(null);

  if (editing) {
    return (
      <Editor
        title="Edit skill"
        onCancel={() => setEditing(null)}
        onSave={() => {
          saveSkill(editing);
          setEditing(null);
        }}
        canSave={!!editing.name.trim() && !!editing.instructions.trim()}
      >
        <Field label="Name" hint={`Run it with /${slugify(editing.name)}.`}>
          <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Code review" />
        </Field>
        <Field label="When to use it" hint="One sentence; the model reads it to decide when the skill applies.">
          <Input
            value={editing.description}
            onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            placeholder="When the user asks for a review of a diff or pull request"
          />
        </Field>
        <Field label="Instructions" hint="Markdown. The model loads these when a request matches, or when you run the slash command.">
          <Textarea
            value={editing.instructions}
            onChange={(e) => setEditing({ ...editing, instructions: e.target.value })}
            className="min-h-64 font-mono text-[13px]"
            placeholder={"When reviewing code:\n- Lead with correctness bugs, then risky changes\n- Quote the line you're commenting on"}
          />
        </Field>
      </Editor>
    );
  }

  return (
    <>
      <SectionHeader
        title="Skills"
        description="Reusable instructions. Sush uses a skill when a request matches it while it's on, and you can run any skill with its slash command, like /code-review."
        action={
          <Button size="sm" onClick={createSkillInChat}>
            <SparklesIcon /> Create with Sush
          </Button>
        }
      />
      <div className="divide-y">
        {skills.map((s) => (
          <Row
            key={s.id}
            title={s.name}
            subtitle={
              <>
                <code className="text-foreground">/{slugify(s.name)}</code>
                {s.description && ` · ${s.description}`}
              </>
            }
            badge={pluginName(s.pluginId)}
          >
            {!s.pluginId && (
              <>
                <Button size="icon-sm" variant="ghost" aria-label={`Edit ${s.name}`} onClick={() => setEditing(s)}>
                  <PencilIcon />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Delete ${s.name}`} onClick={() => deleteSkill(s.id)}>
                  <Trash2Icon />
                </Button>
              </>
            )}
            <Switch checked={s.enabled} onCheckedChange={(on) => toggleSkill(s.id, on)} aria-label={`Use ${s.name}`} />
          </Row>
        ))}
      </div>
      {skills.length === 0 && <Empty>No skills yet. Create one with Sush, or type /create-skill in any chat.</Empty>}
    </>
  );
}

function Editor({
  title,
  children,
  onCancel,
  onSave,
  canSave,
}: {
  title: string;
  children: React.ReactNode;
  onCancel: () => void;
  onSave: () => void;
  canSave: boolean;
}) {
  return (
    <div className="flex min-h-full flex-col">
      <div className="border-b px-6 py-4">
        <h2 className="text-base font-semibold">{title}</h2>
      </div>
      <div className="flex-1 space-y-4 px-6 py-5">{children}</div>
      <div className="sticky bottom-0 flex justify-end gap-2 border-t bg-background px-6 py-3">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onSave} disabled={!canSave}>
          Save
        </Button>
      </div>
    </div>
  );
}

// --- design systems ------------------------------------------------------------------

type DesignEdit = Omit<DesignSystem, "id"> & { id?: string };

const DESIGN_TEMPLATE = `## Colors
- Primary: #0F766E (teal), used for primary actions only
- Neutrals: slate scale; text #0F172A on #FFFFFF

## Typography
- Inter; headings semibold, body 15px/1.6

## Components
- Buttons: 8px radius, 36px tall; one primary per view
- Cards: 1px border, no shadows

## Voice
- Short, plain sentences. No exclamation marks.`;

export function DesignSection() {
  useDesignSystems();
  const designs = availableDesignSystems();
  const prefs = usePrefs();
  const pluginName = usePluginName();
  const [editing, setEditing] = useState<DesignEdit | null>(null);

  if (editing) {
    return (
      <Editor
        title={editing.id ? "Edit design system" : "New design system"}
        onCancel={() => setEditing(null)}
        onSave={() => {
          const saved = saveDesignSystem(editing);
          if (!editing.id) setPrefs({ designSystemId: saved.id });
          setEditing(null);
        }}
        canSave={!!editing.name.trim() && !!editing.guidelines.trim()}
      >
        <Field label="Name">
          <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Acme brand" />
        </Field>
        <Field label="Description">
          <Input
            value={editing.description}
            onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            placeholder="Marketing site and dashboard"
          />
        </Field>
        <Field label="Guidelines" hint="Colors, type, spacing, components, tone. The model follows these when it designs or writes UI code.">
          <Textarea
            value={editing.guidelines}
            onChange={(e) => setEditing({ ...editing, guidelines: e.target.value })}
            className="min-h-72 font-mono text-[13px]"
          />
        </Field>
      </Editor>
    );
  }

  return (
    <>
      <SectionHeader
        title="Design systems"
        description="Design guidelines the model follows when it produces UI, front-end code or visual designs. One can be active at a time."
        action={
          <Button size="sm" onClick={() => setEditing({ name: "", description: "", guidelines: DESIGN_TEMPLATE })}>
            <PlusIcon /> New design system
          </Button>
        }
      />
      <div className="divide-y">
        {designs.map((d) => (
          <Row key={d.id} title={d.name} subtitle={d.description} badge={pluginName(d.pluginId)}>
            {!d.pluginId && (
              <>
                <Button size="icon-sm" variant="ghost" aria-label={`Edit ${d.name}`} onClick={() => setEditing(d)}>
                  <PencilIcon />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label={`Delete ${d.name}`} onClick={() => deleteDesignSystem(d.id)}>
                  <Trash2Icon />
                </Button>
              </>
            )}
            <Switch
              checked={prefs.designSystemId === d.id}
              onCheckedChange={(on) => setPrefs({ designSystemId: on ? d.id : null })}
              aria-label={`Use ${d.name}`}
            />
          </Row>
        ))}
      </div>
      {designs.length === 0 && <Empty>No design systems yet.</Empty>}
    </>
  );
}

// --- connectors --------------------------------------------------------------------------

interface ConnectorEdit {
  id?: string;
  name: string;
  command: string;
  args: string;
  env: string;
  enabled: boolean;
}

function toEdit(c: Connector): ConnectorEdit {
  return {
    id: c.id,
    name: c.name,
    command: c.command.command,
    args: c.command.args.join("\n"),
    env: Object.entries(c.command.env).map(([k, v]) => `${k}=${v}`).join("\n"),
    enabled: c.enabled,
  };
}

function fromEdit(e: ConnectorEdit): Omit<Connector, "id"> & { id?: string } {
  const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
  return {
    id: e.id,
    name: e.name.trim(),
    enabled: e.enabled,
    command: {
      command: e.command.trim(),
      args: lines(e.args),
      env: Object.fromEntries(
        lines(e.env)
          .filter((l) => l.includes("="))
          .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
      ),
    },
  };
}

export function ConnectorsSection() {
  const connectors = useConnectors();
  const status = useConnectorStatus();
  const pluginName = usePluginName();
  const [editing, setEditing] = useState<ConnectorEdit | null>(null);

  if (editing) {
    return (
      <Editor
        title={editing.id ? "Edit connector" : "New connector"}
        onCancel={() => setEditing(null)}
        onSave={() => {
          saveConnector(fromEdit(editing));
          setEditing(null);
        }}
        canSave={!!editing.name.trim() && !!editing.command.trim()}
      >
        <p className="text-sm text-muted-foreground">
          Connectors are MCP servers that run on this computer and give the model tools. Sush asks before each tool
          call unless you choose “Always allow”.
        </p>
        <Field label="Name">
          <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Files" />
        </Field>
        <Field label="Command">
          <Input
            value={editing.command}
            onChange={(e) => setEditing({ ...editing, command: e.target.value })}
            placeholder="npx"
            className="font-mono"
          />
        </Field>
        <Field label="Arguments" hint="One per line.">
          <Textarea
            value={editing.args}
            onChange={(e) => setEditing({ ...editing, args: e.target.value })}
            placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\me\\notes"}
            className="min-h-24 font-mono text-[13px]"
          />
        </Field>
        <Field label="Environment" hint="KEY=value, one per line. Stored on this device in plain text.">
          <Textarea
            value={editing.env}
            onChange={(e) => setEditing({ ...editing, env: e.target.value })}
            placeholder="GITHUB_TOKEN=ghp_…"
            className="min-h-20 font-mono text-[13px]"
          />
        </Field>
      </Editor>
    );
  }

  return (
    <>
      <SectionHeader
        title="Connectors"
        description="Local MCP servers that give the model tools: files, GitHub, databases and more."
        action={
          <Button size="sm" onClick={() => setEditing({ name: "", command: "", args: "", env: "", enabled: true })}>
            <PlusIcon /> Add connector
          </Button>
        }
      />
      <div className="divide-y">
        {connectors.map((c) => {
          const s = status[c.id];
          const subtitle = !c.enabled
            ? "Off"
            : s?.state === "ready"
              ? `${s.tools.length} tools · ${s.tools.map((t) => t.name).join(", ")}`
              : s?.state === "error"
                ? <span className="text-destructive">{s.error}</span>
                : "Connecting…";
          return (
            <Row key={c.id} title={c.name} subtitle={subtitle} badge={pluginName(c.pluginId)}>
              {c.enabled && s?.state === "error" && (
                <Button size="icon-sm" variant="ghost" aria-label={`Reconnect ${c.name}`} onClick={() => void connect(c)}>
                  <RefreshCwIcon />
                </Button>
              )}
              {!c.pluginId && (
                <>
                  <Button size="icon-sm" variant="ghost" aria-label={`Edit ${c.name}`} onClick={() => setEditing(toEdit(c))}>
                    <PencilIcon />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label={`Delete ${c.name}`} onClick={() => deleteConnector(c.id)}>
                    <Trash2Icon />
                  </Button>
                </>
              )}
              <Switch checked={c.enabled} onCheckedChange={(on) => toggleConnector(c.id, on)} aria-label={`Use ${c.name}`} />
            </Row>
          );
        })}
      </div>
      {connectors.length === 0 && <Empty>No connectors yet.</Empty>}
    </>
  );
}

// --- plugins ------------------------------------------------------------------------------

const MANIFEST_EXAMPLE = `{
  "name": "Team kit",
  "version": "1.0.0",
  "skills": [{ "name": "Code review", "description": "…", "file": "skills/review.md" }],
  "designSystems": [{ "name": "Brand", "file": "design.md" }],
  "connectors": [{ "name": "Notes", "command": "node", "args": ["\${PLUGIN_DIR}/server.js"] }]
}`;

export function PluginsSection() {
  const plugins = usePlugins();
  const skills = useSkills();
  const designs = useDesignSystems();
  const connectors = useConnectors();
  const [busy, setBusy] = useState(false);

  const install = async (dir?: string) => {
    const path = dir ?? (await openDialog({ directory: true, title: "Choose a plugin folder" }));
    if (typeof path !== "string") return;
    setBusy(true);
    try {
      const p = await installPlugin(path);
      toast.success(dir ? `Reloaded ${p.name}` : `Installed ${p.name}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionHeader
        title="Plugins"
        description="Folders that bundle skills, design systems and connectors, so a setup can be shared in one piece."
        action={
          <Button size="sm" disabled={busy} onClick={() => void install()}>
            <PlusIcon /> Install from folder
          </Button>
        }
      />
      <div className="divide-y">
        {plugins.map((p) => {
          const counts = [
            [skills.filter((s) => s.pluginId === p.id).length, "skills"],
            [designs.filter((d) => d.pluginId === p.id).length, "design systems"],
            [connectors.filter((c) => c.pluginId === p.id).length, "connectors"],
          ]
            .filter(([n]) => n)
            .map(([n, what]) => `${n} ${what}`)
            .join(" · ");
          return (
            <Row
              key={p.id}
              title={p.version ? `${p.name} ${p.version}` : p.name}
              subtitle={[p.description, counts || "Empty"].filter(Boolean).join(" — ")}
            >
              <Button size="icon-sm" variant="ghost" aria-label={`Reload ${p.name}`} disabled={busy} onClick={() => void install(p.dir)}>
                <RefreshCwIcon />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label={`Remove ${p.name}`} onClick={() => removePlugin(p.id)}>
                <Trash2Icon />
              </Button>
              <Switch checked={p.enabled} onCheckedChange={(on) => togglePlugin(p.id, on)} aria-label={`Use ${p.name}`} />
            </Row>
          );
        })}
      </div>
      {plugins.length === 0 && (
        <div className="space-y-3 px-6 py-6 text-sm text-muted-foreground">
          <p>
            A plugin is a folder with a <code className="text-foreground">sush-plugin.json</code> manifest. Text can be
            inline (<code className="text-foreground">"text"</code>) or in a file next to the manifest (
            <code className="text-foreground">"file"</code>).
          </p>
          <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs text-foreground">{MANIFEST_EXAMPLE}</pre>
        </div>
      )}
    </>
  );
}
