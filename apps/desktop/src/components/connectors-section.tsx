// The sidebar's Connectors page: one page with the user's connectors ("Connected"),
// a Popular shortlist and the catalog of remote MCP servers by category, each
// added in one click, filtered by All / Connected / Available; plus editors
// for a custom remote server (URL) and a local one (command).

import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeftIcon,
  BadgeCheckIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
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

import { Editor, Empty, Field, usePluginName } from "@/components/customize-sections";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  CATALOG,
  CATEGORIES,
  catalogEntry,
  brandLogo,
  connectorIcon,
  normalizeHost,
  setupUrl,
  setupValues,
  type CatalogEntry,
  type ConnectorSetup,
  type SetupValues,
} from "@/lib/connector-catalog";
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

/** A full-colour logo as it comes, or a brand logo on a neutral tile, or the name's initial when there's no logo. */
function ConnectorLogo({
  brand,
  src,
  color,
  name,
  className,
}: {
  brand?: string;
  src?: string;
  color?: string;
  name: string;
  className?: string;
}) {
  if (brand) return <img src={brand} alt="" className={cn("size-10 shrink-0 rounded-[20%] object-cover", className)} />;
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
          className="size-1/2 bg-current"
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
  /** For a catalog entry with a `setup`: the form the URL is built from. */
  setup?: SetupValues;
  /** The URL it was saved with; credentials are bound to it, so a new URL needs them again. */
  savedUrl?: string;
};
type Edit = LocalEdit | RemoteEdit;

const blankSetup = (setup: ConnectorSetup): SetupValues => ({ host: "", server: setup.servers[0].id });

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

function toEdit(c: Connector): Edit {
  if (c.server.type === "http") {
    const setup = catalogEntry(c.catalogId)?.setup;
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
      setup: setup ? (setupValues(setup, c.server.url) ?? blankSetup(setup)) : undefined,
      savedUrl: c.server.url,
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
  const setup = entry?.setup && edit.setup ? entry.setup : undefined;
  const url = setup ? (setupUrl(setup, edit.setup!) ?? "") : edit.url;
  const tokenOnly = entry?.auth === "token" && !setup;
  const [advanced, setAdvanced] = useState(!!(edit.clientId || (!entry && edit.id)));
  const [saving, setSaving] = useState(false);
  // Credentials are bound to the URL, so a new one needs a token (or, with a setup, a client to sign in with).
  const hasSaved = !!edit.id && url === edit.savedUrl;
  const credentialed = hasSaved || !!edit.token.trim() || (!!setup && !!edit.clientId.trim());
  const canSave = !!edit.name.trim() && validUrl(url) && (!(tokenOnly || setup) || credentialed);

  const save = async () => {
    setSaving(true);
    try {
      const saved = await saveEdit({ ...edit, url });
      onDone();
      // A fresh token replaces whatever the running session was using.
      if (edit.token) void connect(saved);
      // No token: sign in through the browser with the user's own OAuth app.
      else if (setup && edit.clientId.trim() && !hasSaved) void signIn(saved);
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
          <ConnectorLogo brand={brandLogo(entry)} src={connectorIcon(entry)} color={entry.color} name={entry.name} />
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
      {(!entry || setup) && (
        <Field label="Name" hint={setup ? "Shown in your list; mention it in a chat with @ and this name." : undefined}>
          <Input
            value={edit.name}
            onChange={(e) => onChange({ ...edit, name: e.target.value })}
            placeholder="My server"
          />
        </Field>
      )}
      {setup && edit.setup && (
        <SetupFields setup={setup} values={edit.setup} onChange={(values) => onChange({ ...edit, setup: values })} />
      )}
      {!entry && (
        <>
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
      {(tokenOnly || setup) && entry?.tokenHelp && (
        <Field label="Access token" hint={entry.tokenHelp.hint}>
          <Input
            type="password"
            value={edit.token}
            onChange={(e) => onChange({ ...edit, token: e.target.value })}
            placeholder={hasSaved ? "Saved — paste a new one to replace it" : "Paste your token"}
            className="font-mono"
            autoFocus={tokenOnly}
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
            {setup ? (
              <p className="text-xs text-muted-foreground">
                Instead of a token, sign in through your browser with an OAuth app you create for {entry!.name}. Register{" "}
                <code className="text-foreground">{CUSTOM_CLIENT_REDIRECT}</code> as the app’s redirect URL.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Leave these empty for servers that support automatic sign-in. For a server that needs its own OAuth app,
                register <code className="text-foreground">{CUSTOM_CLIENT_REDIRECT}</code> as the app’s redirect URL.
              </p>
            )}
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
            {!setup && (
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
            )}
          </CollapsibleContent>
        </Collapsible>
      )}
    </Editor>
  );
}

/** The host and server a `setup` entry's URL is built from, plus the server's own fields. */
function SetupFields({
  setup,
  values,
  onChange,
}: {
  setup: ConnectorSetup;
  values: SetupValues;
  onChange: (values: SetupValues) => void;
}) {
  const server = setup.servers.find((s) => s.id === values.server) ?? setup.servers[0];
  const url = setupUrl(setup, values);
  return (
    <>
      <Field label={setup.host.label} hint={setup.host.hint}>
        <Input
          value={values.host}
          onChange={(e) => onChange({ ...values, host: e.target.value })}
          placeholder={setup.host.placeholder}
          className="font-mono"
          aria-invalid={!!values.host.trim() && !normalizeHost(values.host)}
          autoFocus
        />
      </Field>
      <Field label="Server" hint={server.description}>
        <Select value={server.id} onValueChange={(id) => onChange({ ...values, server: id })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {setup.servers.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {server.fields.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {server.fields.map((f) => (
            <Field key={f.key} label={f.label}>
              <Input
                value={values[f.key] ?? ""}
                onChange={(e) => onChange({ ...values, [f.key]: e.target.value })}
                placeholder={f.placeholder}
                className="font-mono"
              />
            </Field>
          ))}
        </div>
      )}
      {url && <p className="truncate font-mono text-xs text-muted-foreground" title={url}>{url}</p>}
      {setup.note && <p className="text-xs text-muted-foreground">{setup.note}</p>}
    </>
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

// --- connected ---------------------------------------------------------------------------

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
    <div className="flex min-w-0 items-center gap-3 py-2">
      <ConnectorLogo brand={brandLogo(c)} src={src} color={color} name={c.name} className="size-8" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
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
        <div className="truncate text-xs text-muted-foreground">{statusLine(c, status)}</div>
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

// --- catalog -----------------------------------------------------------------------------

/** Shown first under All, in this order; the rest stay in their categories. */
const POPULAR = ["notion", "linear", "github", "atlassian", "sentry", "canva", "stripe", "zapier"];
/** Rows a section shows before folding the rest into "… and N more". */
const FOLD = 6;

const GRID = "grid grid-cols-1 gap-x-8 lg:grid-cols-2";

function CatalogRow({
  entry,
  added,
  onAdd,
  onOpen,
}: {
  entry: CatalogEntry;
  added: boolean;
  onAdd: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 py-2">
      <ConnectorLogo
        brand={brandLogo(entry)}
        src={connectorIcon(entry)}
        color={entry.color}
        name={entry.name}
        className="size-8"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="truncate text-sm font-medium">{entry.name}</span>
          <span title={`By ${entry.publisher}${entry.auth === "none" ? " · No sign-in" : ""}`} className="shrink-0">
            <BadgeCheckIcon className="size-3.5 text-muted-foreground/60" aria-label={`By ${entry.publisher}`} />
          </span>
        </div>
        <p className="truncate text-xs text-muted-foreground" title={entry.description}>
          {entry.description}
        </p>
      </div>
      {added ? (
        <Button size="icon-sm" aria-label={`${entry.name} is connected`} title="Connected" onClick={onOpen}>
          <CheckIcon />
        </Button>
      ) : (
        <Button size="icon-sm" variant="outline" aria-label={`Add ${entry.name}`} onClick={onAdd}>
          <PlusIcon />
        </Button>
      )}
    </div>
  );
}

/** "Stripe, Zapier and 2 more" with the first few logos stacked; unfolds the section. */
function MoreRow({ entries, onClick }: { entries: CatalogEntry[]; onClick: () => void }) {
  const named = entries.slice(0, 2).map((e) => e.name);
  const rest = entries.length - named.length;
  const label = rest > 0 ? `${named.join(", ")} and ${rest} more` : named.join(" and ");
  return (
    <button
      type="button"
      onClick={onClick}
      className="group mt-1 flex items-center gap-2.5 rounded-lg py-1.5 pr-2 text-xs text-muted-foreground hover:text-foreground"
    >
      <span className="flex -space-x-1.5">
        {entries.slice(0, 3).map((e) => (
          <ConnectorLogo
            key={e.id}
            brand={brandLogo(e)}
            src={connectorIcon(e)}
            color={e.color}
            name={e.name}
            className="size-6 rounded-md ring-2 ring-background"
          />
        ))}
      </span>
      {label}
      <ChevronRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="flex items-center gap-2 pb-2 text-sm font-medium">
        {title}
        {count !== undefined && (
          <span className="text-xs font-normal text-muted-foreground tabular-nums">{count}</span>
        )}
      </h3>
      {children}
    </section>
  );
}

function CatalogSection({
  title,
  entries,
  expanded,
  isAdded,
  onAdd,
  onOpen,
}: {
  title: string;
  entries: CatalogEntry[];
  /** Show every entry, as while searching. */
  expanded: boolean;
  isAdded: (e: CatalogEntry) => boolean;
  onAdd: (e: CatalogEntry) => void;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!entries.length) return null;
  // Folding away a single entry would take as much room as showing it.
  const all = expanded || open || entries.length <= FOLD + 1;
  const shown = all ? entries : entries.slice(0, FOLD);
  return (
    <Section title={title}>
      <div className={GRID}>
        {shown.map((e) => (
          <CatalogRow key={e.id} entry={e} added={isAdded(e)} onAdd={() => onAdd(e)} onOpen={onOpen} />
        ))}
      </div>
      {!all && <MoreRow entries={entries.slice(FOLD)} onClick={() => setOpen(true)} />}
    </Section>
  );
}

// --- section -----------------------------------------------------------------------------

type Tab = "all" | "connected" | "available";

const TABS: { value: Tab; label: string }[] = [
  { value: "all", label: "All" },
  { value: "connected", label: "Connected" },
  { value: "available", label: "Available" },
];

/** The sidebar's Connectors page, laid out like Folders. */
export function ConnectorsPage() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-8 pt-8 pb-16">
        <Connectors />
      </div>
    </div>
  );
}

function Connectors() {
  const connectors = useConnectors();
  const status = useConnectorStatus();
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Edit | null>(null);

  const q = query.trim().toLowerCase();
  const connected = useMemo(() => connectors.filter((c) => !q || c.name.toLowerCase().includes(q)), [connectors, q]);
  // One per server and workspace, so a `setup` entry can always be added again.
  const isAdded = (e: CatalogEntry) => !e.setup && connectors.some((c) => c.catalogId === e.id);
  const catalog = CATALOG.filter(
    (e) =>
      (!q || `${e.name} ${e.description} ${e.publisher}`.toLowerCase().includes(q)) &&
      (tab !== "available" || !isAdded(e)),
  );

  if (editing) {
    const done = () => setEditing(null);
    return (
      <div className="mx-auto max-w-2xl">
        <button
          type="button"
          onClick={done}
          className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3.5" /> Connectors
        </button>
        <div className="rounded-xl border">
          {editing.kind === "remote" ? (
            <RemoteEditor edit={editing} onChange={setEditing} onDone={done} />
          ) : (
            <LocalEditor edit={editing} onChange={setEditing} onDone={done} />
          )}
        </div>
      </div>
    );
  }

  const add = (entry: CatalogEntry) => {
    if (entry.setup) {
      setEditing({ ...newRemote(), name: entry.name, catalogId: entry.id, setup: blankSetup(entry.setup) });
      return;
    }
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

  const showConnected = tab !== "available";
  const showCatalog = tab !== "connected";
  // Popular gets a section of its own only while browsing everything, unfiltered.
  const popular =
    tab === "all" && !q
      ? POPULAR.map((id) => catalog.find((e) => e.id === id)).filter((e): e is CatalogEntry => !!e)
      : [];
  const rest = catalog.filter((e) => !popular.includes(e));
  const nothing = (!showConnected || connected.length === 0) && (!showCatalog || catalog.length === 0);
  const toConnected = () => setTab("connected");

  return (
    <>
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Connectors</h1>
        <p className="mt-2 text-muted-foreground">
          Give Sush tools from the apps and services you use. Sush asks before each tool call unless you choose
          “Always allow”.
        </p>
      </header>
      <div className="mt-10 flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Show" className="flex items-center gap-1">
          {TABS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition-colors",
                tab === value ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
              {value === "connected" && connectors.length > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums">{connectors.length}</span>
              )}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative w-52">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search connectors"
              aria-label="Search connectors"
              className="h-8 pl-8"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm">
                <PlusIcon /> Add
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
        </div>
      </div>

      <div className="mt-6 space-y-10">
        {tab === "connected" && connectors.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-muted-foreground">No connectors yet.</p>
            <Button size="sm" variant="outline" onClick={() => setTab("available")}>
              Browse connectors
            </Button>
          </div>
        ) : nothing ? (
          <Empty>
            No connectors match “{query.trim()}”. You can add any MCP server by its URL with Add → Custom connector.
          </Empty>
        ) : (
          <>
            {showConnected && connected.length > 0 && (
              <Section title="Connected" count={tab === "all" ? connected.length : undefined}>
                <div className={GRID}>
                  {connected.map((c) => (
                    <ConnectorRow key={c.id} c={c} status={status[c.id]} onEdit={() => setEditing(toEdit(c))} />
                  ))}
                </div>
              </Section>
            )}
            {showCatalog && (
              <>
                <CatalogSection
                  title="Popular"
                  entries={popular}
                  expanded={false}
                  isAdded={isAdded}
                  onAdd={add}
                  onOpen={toConnected}
                />
                {CATEGORIES.map((category) => (
                  <CatalogSection
                    key={category}
                    title={category}
                    entries={rest.filter((e) => e.category === category)}
                    expanded={!!q}
                    isAdded={isAdded}
                    onAdd={add}
                    onOpen={toConnected}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
