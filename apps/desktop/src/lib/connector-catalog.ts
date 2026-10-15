// Remote MCP servers offered under Customize → Connectors → Discover. Each was
// checked to speak MCP over HTTP; "oauth" ones support dynamic client
// registration or have a client Sush ships, so adding one just opens the
// browser to sign in. Servers that live on the user's own host (Databricks)
// have a `setup`: the editor asks for the host and which server, and builds the URL.

import type { Connector } from "@/lib/library";

export type CatalogAuth =
  /** Sign in through the browser. */
  | "oauth"
  /** Public; no account needed. */
  | "none"
  /** Paste an access token (servers without automatic sign-in). */
  | "token";

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  publisher: string;
  url: string;
  auth: CatalogAuth;
  category: "Productivity" | "Developer tools" | "Data & docs" | "Business";
  /** Brand color for the logo; omitted where it's too dark or light for either theme. */
  color?: string;
  /** For `token` auth: where to create one, and what it needs. */
  tokenHelp?: { url: string; hint: string };
  /** The URL depends on the user's account; `url` is then only an example. */
  setup?: ConnectorSetup;
}

/** How to build a server URL from the user's host and the server they pick. */
export interface ConnectorSetup {
  host: { label: string; placeholder: string; hint: string };
  servers: SetupServer[];
  /** Servers that need it enabled first, e.g. a preview the admin turns on. */
  note?: string;
}

export interface SetupServer {
  id: string;
  label: string;
  description: string;
  /** Appended to `https://<host>`; `{key}` is filled from the field with that key. */
  path: string;
  fields: { key: string; label: string; placeholder: string }[];
}

export type SetupValues = { host: string; server: string } & Record<string, string>;

/** `adb-123.azuredatabricks.net` from whatever was pasted: a bare host, or a URL from the browser. */
export function normalizeHost(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const { protocol, hostname } = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    return protocol === "https:" && hostname.includes(".") ? hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The server URL for these values, or null while something is missing. */
export function setupUrl(setup: ConnectorSetup, values: SetupValues): string | null {
  const host = normalizeHost(values.host);
  const server = setup.servers.find((s) => s.id === values.server);
  if (!host || !server) return null;
  let missing = false;
  const path = server.path.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = values[key]?.trim();
    if (!value) missing = true;
    return encodeURIComponent(value ?? "");
  });
  return missing ? null : `https://${host}${path}`;
}

/** The values a saved URL was built from, so editing shows the form filled in. */
export function setupValues(setup: ConnectorSetup, url: string): SetupValues | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  for (const server of setup.servers) {
    const keys: string[] = [];
    const pattern = server.path
      .split(/(\{\w+\})/)
      .map((piece) => {
        const key = piece.match(/^\{(\w+)\}$/)?.[1];
        if (!key) return piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        keys.push(key);
        return "([^/]+)";
      })
      .join("");
    const m = parsed.pathname.match(new RegExp(`^${pattern}/?$`));
    if (!m) continue;
    const values: SetupValues = { host: parsed.hostname, server: server.id };
    keys.forEach((key, i) => (values[key] = decodeURIComponent(m[i + 1])));
    return values;
  }
  return null;
}

const icons = import.meta.glob<string>("../assets/connectors/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});
const ICONS: Record<string, string> = Object.fromEntries(
  Object.entries(icons).map(([path, url]) => [path.split("/").pop()!.replace(".svg", ""), url]),
);

export const CATALOG: CatalogEntry[] = [
  // Productivity
  {
    id: "notion",
    name: "Notion",
    description: "Search, read and update pages and databases in your workspace",
    publisher: "Notion",
    url: "https://mcp.notion.com/mcp",
    auth: "oauth",
    category: "Productivity",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Find, create and update issues, projects and comments",
    publisher: "Linear",
    url: "https://mcp.linear.app/mcp",
    auth: "oauth",
    category: "Productivity",
    color: "#5E6AD2",
  },
  {
    id: "atlassian",
    name: "Atlassian",
    description: "Work with Jira issues and Confluence pages",
    publisher: "Atlassian",
    url: "https://mcp.atlassian.com/v1/mcp",
    auth: "oauth",
    category: "Productivity",
    color: "#0052CC",
  },
  {
    id: "asana",
    name: "Asana",
    description: "Coordinate tasks, projects and goals",
    publisher: "Asana",
    url: "https://mcp.asana.com/sse",
    auth: "oauth",
    category: "Productivity",
    color: "#F06A6A",
  },
  {
    id: "monday",
    name: "monday.com",
    description: "Manage boards, items and updates",
    publisher: "monday.com",
    url: "https://mcp.monday.com/mcp",
    auth: "oauth",
    category: "Productivity",
  },
  {
    id: "clickup",
    name: "ClickUp",
    description: "Search and manage tasks, docs and lists",
    publisher: "ClickUp",
    url: "https://mcp.clickup.com/mcp",
    auth: "oauth",
    category: "Productivity",
    color: "#7B68EE",
  },
  {
    id: "todoist",
    name: "Todoist",
    description: "Add, organize and complete your tasks",
    publisher: "Doist",
    url: "https://ai.todoist.net/mcp",
    auth: "oauth",
    category: "Productivity",
    color: "#E44332",
  },
  {
    id: "airtable",
    name: "Airtable",
    description: "Read and write records across your bases",
    publisher: "Airtable",
    url: "https://mcp.airtable.com/mcp",
    auth: "oauth",
    category: "Productivity",
    color: "#18BFFF",
  },
  {
    id: "miro",
    name: "Miro",
    description: "Read and create content on your boards",
    publisher: "Miro",
    url: "https://mcp.miro.com",
    auth: "oauth",
    category: "Productivity",
  },
  {
    id: "canva",
    name: "Canva",
    description: "Search, create, autofill and export designs",
    publisher: "Canva",
    url: "https://mcp.canva.com/mcp",
    auth: "oauth",
    category: "Productivity",
  },
  {
    id: "dropbox",
    name: "Dropbox",
    description: "Find, read and share files in your Dropbox",
    publisher: "Dropbox",
    url: "https://mcp.dropbox.com/mcp",
    auth: "oauth",
    category: "Productivity",
    color: "#0061FF",
  },
  {
    id: "granola",
    name: "Granola",
    description: "Search your meeting notes and transcripts",
    publisher: "Granola",
    url: "https://mcp.granola.ai/mcp",
    auth: "oauth",
    category: "Productivity",
  },
  {
    id: "zapier",
    name: "Zapier",
    description: "Run actions across thousands of apps",
    publisher: "Zapier",
    url: "https://mcp.zapier.com/api/mcp/mcp",
    auth: "oauth",
    category: "Productivity",
    color: "#FF4F00",
  },

  // Developer tools
  {
    id: "github",
    name: "GitHub",
    description: "Browse repositories, issues, pull requests and Actions",
    publisher: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    // No dynamic registration; signs in with Sush's own OAuth app (connector_auth.rs).
    auth: "oauth",
    category: "Developer tools",
  },
  {
    id: "gitlab",
    name: "GitLab",
    description: "Work with projects, issues and merge requests",
    publisher: "GitLab",
    url: "https://gitlab.com/api/v4/mcp",
    auth: "oauth",
    category: "Developer tools",
    color: "#FC6D26",
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Investigate errors, issues and releases",
    publisher: "Sentry",
    url: "https://mcp.sentry.dev/mcp",
    auth: "oauth",
    category: "Developer tools",
  },
  {
    id: "vercel",
    name: "Vercel",
    description: "Inspect projects, deployments and logs",
    publisher: "Vercel",
    url: "https://mcp.vercel.com",
    auth: "oauth",
    category: "Developer tools",
  },
  {
    id: "netlify",
    name: "Netlify",
    description: "Create, deploy and manage sites",
    publisher: "Netlify",
    url: "https://netlify-mcp.netlify.app/mcp",
    auth: "oauth",
    category: "Developer tools",
    color: "#00C7B7",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "Manage Workers, DNS and other account resources",
    publisher: "Cloudflare",
    url: "https://mcp.cloudflare.com/mcp",
    auth: "oauth",
    category: "Developer tools",
    color: "#F38020",
  },
  {
    id: "supabase",
    name: "Supabase",
    description: "Query databases and manage projects",
    publisher: "Supabase",
    url: "https://mcp.supabase.com/mcp",
    auth: "oauth",
    category: "Developer tools",
    color: "#3FCF8E",
  },
  {
    id: "neon",
    name: "Neon",
    description: "Manage Postgres projects, branches and queries",
    publisher: "Neon",
    url: "https://mcp.neon.tech/mcp",
    auth: "oauth",
    category: "Developer tools",
    color: "#34D59A",
  },
  {
    id: "prisma",
    name: "Prisma Postgres",
    description: "Create and manage Prisma Postgres databases",
    publisher: "Prisma",
    url: "https://mcp.prisma.io/mcp",
    auth: "oauth",
    category: "Developer tools",
  },
  {
    id: "databricks",
    name: "Databricks",
    description: "Query your lakehouse with SQL, Genie spaces, Unity Catalog functions and AI Search",
    publisher: "Databricks",
    url: "https://<workspace-host>/api/2.0/mcp/sql",
    // Databricks has no dynamic client registration: a personal access token, or an
    // OAuth app the user creates (its client ID goes under Advanced settings).
    auth: "token",
    category: "Developer tools",
    color: "#FF3621",
    tokenHelp: {
      url: "https://docs.databricks.com/aws/en/dev-tools/auth/pat",
      hint: "A personal access token from Settings → Developer → Access tokens in your workspace. Or leave it empty and sign in with your own OAuth app under Advanced settings.",
    },
    setup: {
      host: {
        label: "Workspace URL",
        placeholder: "adb-1234567890123456.7.azuredatabricks.net",
        hint: "The address you open Databricks at.",
      },
      note: "A workspace admin needs to turn on Managed MCP Servers under Previews in the workspace.",
      servers: [
        {
          id: "sql",
          label: "Databricks SQL",
          description: "Run SQL on your SQL warehouses",
          path: "/api/2.0/mcp/sql",
          fields: [],
        },
        {
          id: "genie",
          label: "Genie space",
          description: "Ask questions of a Genie space in plain language",
          path: "/api/2.0/mcp/genie/{space}",
          fields: [{ key: "space", label: "Genie space ID", placeholder: "01ef…" }],
        },
        {
          id: "functions",
          label: "Unity Catalog functions",
          description: "Call the functions in a schema as tools",
          path: "/api/2.0/mcp/functions/{catalog}/{schema}",
          fields: [
            { key: "catalog", label: "Catalog", placeholder: "main" },
            { key: "schema", label: "Schema", placeholder: "default" },
          ],
        },
        {
          id: "ai-search",
          label: "AI Search",
          description: "Search a vector index",
          path: "/api/2.0/mcp/ai-search/{catalog}/{schema}/{index}",
          fields: [
            { key: "catalog", label: "Catalog", placeholder: "main" },
            { key: "schema", label: "Schema", placeholder: "default" },
            { key: "index", label: "Index", placeholder: "docs_index" },
          ],
        },
      ],
    },
  },
  {
    id: "posthog",
    name: "PostHog",
    description: "Query analytics, feature flags and experiments",
    publisher: "PostHog",
    url: "https://mcp.posthog.com/mcp",
    auth: "oauth",
    category: "Developer tools",
  },
  {
    id: "semgrep",
    name: "Semgrep",
    description: "Scan code for security issues",
    publisher: "Semgrep",
    url: "https://mcp.semgrep.ai/mcp",
    auth: "oauth",
    category: "Developer tools",
  },
  {
    id: "sanity",
    name: "Sanity",
    description: "Query and edit content in your Sanity projects",
    publisher: "Sanity",
    url: "https://mcp.sanity.io",
    auth: "oauth",
    category: "Developer tools",
  },
  {
    id: "jam",
    name: "Jam",
    description: "Read bug reports with console logs and network requests",
    publisher: "Jam",
    url: "https://mcp.jam.dev/mcp",
    auth: "oauth",
    category: "Developer tools",
  },

  // Data & docs (public, no account)
  {
    id: "huggingface",
    name: "Hugging Face",
    description: "Search models, datasets, Spaces and papers",
    publisher: "Hugging Face",
    url: "https://huggingface.co/mcp",
    auth: "none",
    category: "Data & docs",
  },
  {
    id: "deepwiki",
    name: "DeepWiki",
    description: "Ask questions about public GitHub repositories",
    publisher: "Cognition",
    url: "https://mcp.deepwiki.com/mcp",
    auth: "none",
    category: "Data & docs",
  },
  {
    id: "context7",
    name: "Context7",
    description: "Up-to-date docs and code examples for libraries",
    publisher: "Upstash",
    url: "https://mcp.context7.com/mcp",
    auth: "none",
    category: "Data & docs",
  },
  {
    id: "microsoft-learn",
    name: "Microsoft Learn",
    description: "Search official Microsoft and Azure documentation",
    publisher: "Microsoft",
    url: "https://learn.microsoft.com/api/mcp",
    auth: "none",
    category: "Data & docs",
  },
  {
    id: "aws-knowledge",
    name: "AWS Knowledge",
    description: "Search AWS documentation, guides and announcements",
    publisher: "Amazon Web Services",
    url: "https://knowledge-mcp.global.api.aws",
    auth: "none",
    category: "Data & docs",
  },
  {
    id: "cloudflare-docs",
    name: "Cloudflare Docs",
    description: "Search Cloudflare's developer documentation",
    publisher: "Cloudflare",
    url: "https://docs.mcp.cloudflare.com/mcp",
    auth: "none",
    category: "Data & docs",
    color: "#F38020",
  },

  // Business
  {
    id: "stripe",
    name: "Stripe",
    description: "Look up customers, payments and subscriptions",
    publisher: "Stripe",
    url: "https://mcp.stripe.com",
    auth: "oauth",
    category: "Business",
    color: "#635BFF",
  },
  {
    id: "paypal",
    name: "PayPal",
    description: "Manage invoices, orders and transactions",
    publisher: "PayPal",
    url: "https://mcp.paypal.com/mcp",
    auth: "oauth",
    category: "Business",
    color: "#002991",
  },
  {
    id: "square",
    name: "Square",
    description: "Work with payments, catalog and customers",
    publisher: "Block",
    url: "https://mcp.squareup.com/sse",
    auth: "oauth",
    category: "Business",
  },
  {
    id: "intercom",
    name: "Intercom",
    description: "Search conversations and customer data",
    publisher: "Intercom",
    url: "https://mcp.intercom.com/mcp",
    auth: "oauth",
    category: "Business",
  },
  {
    id: "attio",
    name: "Attio",
    description: "Search and update records in your CRM",
    publisher: "Attio",
    url: "https://mcp.attio.com/mcp",
    auth: "oauth",
    category: "Business",
  },
  {
    id: "close",
    name: "Close",
    description: "Work with leads, opportunities and activities",
    publisher: "Close",
    url: "https://mcp.close.com/mcp",
    auth: "oauth",
    category: "Business",
  },
  {
    id: "webflow",
    name: "Webflow",
    description: "Manage sites, pages and CMS collections",
    publisher: "Webflow",
    url: "https://mcp.webflow.com/sse",
    auth: "oauth",
    category: "Business",
    color: "#146EF5",
  },
  {
    id: "wix",
    name: "Wix",
    description: "Manage your Wix sites and business apps",
    publisher: "Wix",
    url: "https://mcp.wix.com/sse",
    auth: "oauth",
    category: "Business",
    color: "#0C6EFC",
  },
];

export const CATEGORIES = ["Productivity", "Developer tools", "Data & docs", "Business"] as const;

export const catalogEntry = (id?: string) => CATALOG.find((e) => e.id === id);

/** Logo for a catalog entry or a connector (by catalog id, else a known host). */
export function connectorIcon(item: {
  id?: string;
  catalogId?: string;
  server?: Connector["server"];
}): string | undefined {
  const entry = catalogEntry(item.catalogId ?? item.id);
  const slug = entry?.id.replace(/-docs$/, "");
  if (slug && ICONS[slug]) return ICONS[slug];
  if (item.server?.type === "http") {
    let host = "";
    try {
      host = new URL(item.server.url).hostname;
    } catch {
      return undefined;
    }
    const match = Object.keys(ICONS).find((s) => host.split(".").includes(s));
    if (match) return ICONS[match];
  }
  return undefined;
}
