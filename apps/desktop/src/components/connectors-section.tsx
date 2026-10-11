// Customize → Connectors: the user's connectors ("Yours") and a catalog of
// remote MCP servers to add in one click ("Discover"), plus editors for a
// custom remote server (URL) and a local one (command).

import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CheckIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LogOutIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Editor, Empty, Field, SectionHeader, usePluginName } from "@/components/customize-sections";
import { Segmented } from "@/components/settings-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { CATALOG, CATEGORIES, catalogEntry, connectorIcon, type CatalogEntry } from "@/lib/connector-catalog";
import {
  cancelSignIn,
  connect,
  deleteConnector,
  saveConnector,
  signIn,
  signOut,
  toggleConnector,
  useConnectors,
  useConnectorStatus,
  type Connector,
  type ConnectorStatus,
} from "@/lib/library";
import { api, CUSTOM_CLIENT_REDIRECT, errorMessage } from "@/lib/tauri";
import { cn } from "@/lib/utils";

// --- logo ----------------------------------------------------------------------------

/** A brand logo on a neutral tile, or the name's initial when there's no logo. */
function ConnectorLogo({
  src,
  color,
  name,
  className,
}: {
  src?: string;
  color?: string;
  name: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-lg border bg-background shadow-xs",
        className,
      )}
    >
      {src ? (
        <span
          className="size-5 bg-current"
          style={{
            backgroundColor: color,
            mask: `url("${src}") center / contain no-repeat`,
            WebkitMask: `url("${src}") center / contain no-repeat`,
          }}
        />
      ) : (
        <span className="text-sm font-semibold text-muted-foreground">
          {name.trim().charAt(0).toUpperCase() || "?"}
        </span>
      )}
    </span>
  );
}

function logoFor(c: Connector) {
  return { src: connectorIcon(c), color: catalogEntry(c.catalogId)?.color };
}

// --- editing -------------------------------------------------------------------------

type LocalEdit = {
  kind: "local";
  id?: string;
  name: string;
  command: string;
  args: string;
  env: string;
  enabled: boolean;
};
type RemoteEdit = {
  kind: "remote";
  id?: string;
  name: string;
  url: string;
  clientId: string;
  /** Typed this session; blank keeps what's stored. */
  clientSecret: string;
  token: string;
  enabled: boolean;
  catalogId?: string;
};
type Edit = LocalEdit | RemoteEdit;

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

function toEdit(c: Connector): Edit {
  if (c.server.type === "http") {
    return {
      kind: "remote",
      id: c.id,
      name: c.name,
      url: c.server.url,
      clientId: c.server.oauthClientId ?? "",
      clientSecret: "",
      token: "",
      enabled: c.enabled,
      catalogId: c.catalogId,
    };
  }
  return {
    kind: "local",
    id: c.id,
    name: c.name,
    command: c.server.command,
    args: c.server.args.join("\n"),
    env: Object.entries(c.server.env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    enabled: c.enabled,
  };
}

const newRemote = (): RemoteEdit => ({
  kind: "remote",
  name: "",
  url: "",
  clientId: "",
  clientSecret: "",
  token: "",
  enabled: true,
});
const newLocal = (): LocalEdit => ({
  kind: "local",
  name: "",
  command: "",
  args: "",
  env: "",
  enabled: true,
});

function validUrl(url: string) {
  try {
    return ["http:", "https:"].includes(new URL(url.trim()).protocol);
  } catch {
    return false;
  }
}

/** Save secrets first, so the connect that saving triggers can already use them. */
async function saveEdit(e: Edit): Promise<Connector> {
  const id = e.id ?? crypto.randomUUID();
  if (e.kind === "local") {
    return saveConnector({
      id,
      name: e.name.trim(),
      enabled: e.enabled,
      server: {
        type: "stdio",
        command: e.command.trim(),
        args: lines(e.args),
        env: Object.fromEntries(
          lines(e.env)
            .filter((l) => l.includes("="))
            .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
        ),
      },
    });
  }
  const url = e.url.trim();
  if (e.token || e.clientSecret) {
    await api.connectorSaveSecrets(id, url, {
      token: e.token || undefined,
      clientSecret: e.clientSecret || undefined,
    });
  }
  return saveConnector({
    id,
    name: e.name.trim(),
    enabled: e.enabled,
    catalogId: e.catalogId,
    server: { type: "http", url, oauthClientId: e.clientId.trim() || null },
  });
}

function RemoteEditor({
  edit,
  onChange,
  onDone,
}: {
  edit: RemoteEdit;
  onChange: (e: Edit) => void;
  onDone: () => void;
}) {
  const entry = catalogEntry(edit.catalogId);
  const tokenOnly = entry?.auth === "token";
  const [advanced, setAdvanced] = useState(!!(edit.clientId || (!entry && edit.id)));
  const [saving, setSaving] = useState(false);
  const canSave = !!edit.name.trim() && validUrl(edit.url) && (!tokenOnly || !!edit.id || !!edit.token.trim());

  const save = async () => {
    setSaving(true);
    try {
      const saved = await saveEdit(edit);
      onDone();
      // A fresh token replaces whatever the running session was using.
      if (edit.token) void connect(saved);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Editor
      title={edit.id ? `Edit ${edit.name || "connector"}` : entry ? `Add ${entry.name}` : "Add custom connector"}
      onCancel={onDone}
      onSave={() => void save()}
      canSave={canSave && !saving}
    >
      {entry ? (
        <div className="flex items-center gap-3">
          <ConnectorLogo src={connectorIcon(entry)} color={entry.color} name={entry.name} />
          <div className="min-w-0">
            <p className="text-sm font-medium">{entry.name}</p>
            <p className="text-sm text-muted-foreground">{entry.description}</p>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Connect to a remote MCP server by its URL. Sush signs in through your browser when the server asks for it.
        </p>
      )}
      {!entry && (
        <>
          <Field label="Name">
            <Input
              value={edit.name}
              onChange={(e) => onChange({ ...edit, name: e.target.value })}
              placeholder="My server"
            />
          </Field>
          <Field label="Server URL">
            <Input
              value={edit.url}
              onChange={(e) => onChange({ ...edit, url: e.target.value })}
              placeholder="https://mcp.example.com/mcp"
              className="font-mono"
              aria-invalid={!!edit.url.trim() && !validUrl(edit.url)}
            />
          </Field>
        </>
      )}
      {tokenOnly && entry?.tokenHelp && (
        <Field label="Access token" hint={entry.tokenHelp.hint}>
          <Input
            type="password"
            value={edit.token}
            onChange={(e) => onChange({ ...edit, token: e.target.value })}
            placeholder={edit.id ? "Saved — paste a new one to replace it" : "Paste your token"}
            className="font-mono"
            autoFocus
          />
          <Button variant="link" size="sm" className="h-auto px-0" onClick={() => void openUrl(entry.tokenHelp!.url)}>
            Create a token <ExternalLinkIcon />
          </Button>
        </Field>
      )}
      {!tokenOnly && (
        <Collapsible open={advanced} onOpenChange={setAdvanced}>
          <CollapsibleTrigger className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
            <ChevronDownIcon className={cn("size-4 transition-transform", !advanced && "-rotate-90")} /> Advanced
            settings
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pt-4">
            <p className="text-xs text-muted-foreground">
              Leave these empty for servers that support automatic sign-in. For a server that needs its own OAuth app,
              register <code className="text-foreground">{CUSTOM_CLIENT_REDIRECT}</code> as the app’s redirect URL.
            </p>
            <Field label="OAuth client ID">
              <Input
                value={edit.clientId}
                onChange={(e) => onChange({ ...edit, clientId: e.target.value })}
                className="font-mono"
              />
            </Field>
            <Field label="OAuth client secret" hint="Optional. Stored in your system’s credential manager.">
              <Input
                type="password"
                value={edit.clientSecret}
                onChange={(e) => onChange({ ...edit, clientSecret: e.target.value })}
                placeholder={edit.id ? "Unchanged" : ""}
                className="font-mono"
              />
            </Field>
            <Field
              label="Access token"
              hint="Instead of signing in: sent as a bearer token. Stored in your system’s credential manager."
            >
              <Input
                type="password"
                value={edit.token}
                onChange={(e) => onChange({ ...edit, token: e.target.value })}
                placeholder={edit.id ? "Unchanged" : ""}
                className="font-mono"
              />
            </Field>
          </CollapsibleContent>
        </Collapsible>
      )}
    </Editor>
  );
}

function LocalEditor({ edit, onChange, onDone }: { edit: LocalEdit; onChange: (e: Edit) => void; onDone: () => void }) {
  return (
    <Editor
      title={edit.id ? "Edit local connector" : "Add local connector"}
      onCancel={onDone}
      onSave={() => void saveEdit(edit).then(onDone, (e) => toast.error(errorMessage(e)))}
      canSave={!!edit.name.trim() && !!edit.command.trim()}
    >
      <p className="text-sm text-muted-foreground">
        A local connector is an MCP server that runs on this computer as a command, like a package from npm.
      </p>
      <Field label="Name">
        <Input value={edit.name} onChange={(e) => onChange({ ...edit, name: e.target.value })} placeholder="Files" />
      </Field>
      <Field label="Command">
        <Input
          value={edit.command}
          onChange={(e) => onChange({ ...edit, command: e.target.value })}
          placeholder="npx"
          className="font-mono"
        />
      </Field>
      <Field label="Arguments" hint="One per line.">
        <Textarea
          value={edit.args}
          onChange={(e) => onChange({ ...edit, args: e.target.value })}
          placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\me\\notes"}
          className="min-h-24 font-mono text-[13px]"
        />
      </Field>
      <Field label="Environment" hint="KEY=value, one per line. Stored on this device in plain text.">
        <Textarea
          value={edit.env}
          onChange={(e) => onChange({ ...edit, env: e.target.value })}
          placeholder="API_KEY=…"
          className="min-h-20 font-mono text-[13px]"
        />
      </Field>
    </Editor>
  );
}

// --- yours -----------------------------------------------------------------------------

function statusLine(c: Connector, s: ConnectorStatus | undefined): React.ReactNode {
  if (!c.enabled) return "Off";
  switch (s?.state) {
    case "ready":
      return s.tools.length
        ? `${s.tools.length} tools · ${s.tools.map((t) => t.name).join(", ")}`
        : "Connected, no tools";
    case "needs-auth":
      return s.rejected ? `Sign-in was turned down: ${s.rejected}` : "Sign in to use it";
    case "authorizing":
      if (!s.code) return "Finish signing in in your browser…";
      return (
        <>
          Enter{" "}
          <button
            type="button"
            className="font-mono font-medium text-foreground hover:underline"
            title="Copy code"
            onClick={() =>
              void navigator.clipboard.writeText(s.code!.userCode).then(() => toast.success("Code copied"))
            }
          >
            {s.code.userCode}
          </button>{" "}
          at{" "}
          <button type="button" className="hover:underline" onClick={() => void openUrl(s.code!.verificationUri)}>
            {s.code.verificationUri.replace(/^https?:\/\//, "")}
          </button>
        </>
      );
    case "error":
      return <span className="text-destructive">{s.error}</span>;
    default:
      return "Connecting…";
  }
}

function ConnectorRow({ c, status, onEdit }: { c: Connector; status?: ConnectorStatus; onEdit: () => void }) {
  const pluginName = usePluginName()(c.pluginId);
  const remote = c.server.type === "http";
  const { src, color } = logoFor(c);
  return (
    <div className="flex items-center gap-3 px-6 py-3">
      <ConnectorLogo src={src} color={color} name={c.name} className="size-9" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{c.name}</span>
          {pluginName && (
            <Badge variant="secondary" className="shrink-0">
              {pluginName}
            </Badge>
          )}
          {!remote && (
            <Badge variant="outline" className="shrink-0">
              Local
            </Badge>
          )}
        </div>
        <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{statusLine(c, status)}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {c.enabled && status?.state === "needs-auth" && (
          <Button size="sm" onClick={() => void signIn(c)}>
            Sign in
          </Button>
        )}
        {c.enabled && status?.state === "authorizing" && (
          <>
            <Spinner className="mr-1 size-4 text-muted-foreground" />
            <Button size="sm" variant="ghost" onClick={() => cancelSignIn(c.id)}>
              Cancel
            </Button>
          </>
        )}
        {c.enabled && status?.state === "error" && (
          <Button size="icon-sm" variant="ghost" aria-label={`Reconnect ${c.name}`} onClick={() => void connect(c)}>
            <RefreshCwIcon />
          </Button>
        )}
        {!c.pluginId && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="ghost" aria-label={`More for ${c.name}`}>
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>
                <PencilIcon /> Edit
              </DropdownMenuItem>
              {remote && (
                <DropdownMenuItem onSelect={() => void signIn(c)}>
                  <RefreshCwIcon /> Sign in again
                </DropdownMenuItem>
              )}
              {remote && (
                <DropdownMenuItem onSelect={() => void signOut(c).catch((e) => toast.error(errorMessage(e)))}>
                  <LogOutIcon /> Sign out
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => deleteConnector(c.id)}>
                <Trash2Icon /> Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Switch checked={c.enabled} onCheckedChange={(on) => toggleConnector(c.id, on)} aria-label={`Use ${c.name}`} />
      </div>
    </div>
  );
}

// --- discover --------------------------------------------------------------------------

function CatalogCard({ entry, added, onAdd }: { entry: CatalogEntry; added: boolean; onAdd: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border bg-card p-3">
      <ConnectorLogo src={connectorIcon(entry)} color={entry.color} name={entry.name} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{entry.name}</p>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{entry.description}</p>
        <p className="mt-1 text-xs text-muted-foreground/80">
          by {entry.publisher}
          {entry.auth === "none" && " · No sign-in"}
        </p>
      </div>
      {added ? (
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
          title="Added"
        >
          <CheckIcon className="size-4" />
          <span className="sr-only">Added</span>
        </span>
      ) : (
        <Button size="icon-sm" variant="outline" aria-label={`Add ${entry.name}`} onClick={onAdd}>
          <PlusIcon />
        </Button>
      )}
    </div>
  );
}

function Discover({ query, onAdd }: { query: string; onAdd: (e: CatalogEntry) => void }) {
  const connectors = useConnectors();
  const q = query.trim().toLowerCase();
  const matches = CATALOG.filter((e) => !q || `${e.name} ${e.description} ${e.publisher}`.toLowerCase().includes(q));
  if (matches.length === 0) {
    return (
      <Empty>
        No connectors match “{query.trim()}”. You can add any MCP server by its URL with Add → Custom connector.
      </Empty>
    );
  }
  return (
    <div className="space-y-6 px-6 pt-2 pb-6">
      {CATEGORIES.map((category) => {
        const entries = matches.filter((e) => e.category === category);
        if (!entries.length) return null;
        return (
          <section key={category}>
            <h3 className="flex items-center gap-2 pb-2 text-sm font-medium">
              {category}
              <span className="rounded-md bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
                {entries.length}
              </span>
            </h3>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {entries.map((e) => (
                <CatalogCard
                  key={e.id}
                  entry={e}
                  added={connectors.some((c) => c.catalogId === e.id)}
                  onAdd={() => onAdd(e)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// --- section -----------------------------------------------------------------------------

type Tab = "yours" | "discover";

export function ConnectorsSection() {
  const connectors = useConnectors();
  const status = useConnectorStatus();
  const [tab, setTab] = useState<Tab>(() => (connectors.length ? "yours" : "discover"));
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Edit | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return connectors.filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [connectors, query]);

  if (editing?.kind === "remote")
    return <RemoteEditor edit={editing} onChange={setEditing} onDone={() => setEditing(null)} />;
  if (editing?.kind === "local")
    return <LocalEditor edit={editing} onChange={setEditing} onDone={() => setEditing(null)} />;

  const add = (entry: CatalogEntry) => {
    if (entry.auth === "token") {
      setEditing({
        ...newRemote(),
        name: entry.name,
        url: entry.url,
        catalogId: entry.id,
      });
      return;
    }
    const saved = saveConnector({
      name: entry.name,
      enabled: true,
      catalogId: entry.id,
      server: { type: "http", url: entry.url },
    });
    if (entry.auth === "oauth") {
      toast(`Sign in to ${entry.name} in your browser to finish adding it.`);
      void signIn(saved);
    } else {
      toast.success(`Added ${entry.name}`);
    }
  };

  return (
    <>
      <SectionHeader
        title="Connectors"
        description="Give Sush tools from the apps and services you use. Sush asks before each tool call unless you choose “Always allow”."
        action={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm">
                <PlusIcon /> Add <ChevronDownIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onSelect={() => setEditing(newRemote())}>
                <GlobeIcon />
                <div>
                  <p>Custom connector</p>
                  <p className="text-xs text-muted-foreground">A remote MCP server, by URL</p>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setEditing(newLocal())}>
                <TerminalIcon />
                <div>
                  <p>Local connector</p>
                  <p className="text-xs text-muted-foreground">An MCP server run as a command</p>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      <div className="flex items-center gap-3 px-6 py-3">
        <Segmented<Tab>
          label="Show"
          value={tab}
          onChange={setTab}
          options={[
            {
              value: "yours",
              label: connectors.length ? `Yours · ${connectors.length}` : "Yours",
            },
            { value: "discover", label: "Discover" },
          ]}
        />
        <div className="relative ml-auto w-56">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === "discover" ? "Search connectors" : "Filter yours"}
            aria-label="Search connectors"
            className="h-8 pl-8"
          />
        </div>
      </div>
      {tab === "discover" ? (
        <Discover query={query} onAdd={add} />
      ) : connectors.length === 0 ? (
        <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">No connectors yet.</p>
          <Button size="sm" variant="outline" onClick={() => setTab("discover")}>
            Browse connectors
          </Button>
        </div>
      ) : (
        <div className="divide-y border-t">
          {visible.map((c) => (
            <ConnectorRow key={c.id} c={c} status={status[c.id]} onEdit={() => setEditing(toEdit(c))} />
          ))}
          {visible.length === 0 && <Empty>No connectors match “{query.trim()}”.</Empty>}
        </div>
      )}
    </>
  );
}
