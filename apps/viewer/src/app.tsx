// The browser viewer: open an invite link without installing Sush, sign in to
// the relay, wait to be let in, then watch the session live and comment.
// Everything it shows comes from the host, already redacted; it renders text
// as text (never as HTML) and images only as data URLs it fetched itself.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";

import { parseFragment, unb64, type ShareKey } from "./crypto";
import { Session, type Comment, type Member, type Message, type Part, type View } from "./session";

/** The share this page is for: /join/<id>, or ?join=<id> while developing. */
const shareId = location.pathname.match(/^\/join\/([A-Za-z0-9_-]+)/)?.[1] ?? new URLSearchParams(location.search).get("join") ?? "";

/** The link's token and key, kept for this tab only so a reload still works, and taken out of the address bar. */
function linkSecrets(): { token: string; key: string | null } {
  const stored = `sush.join.${shareId}`;
  if (location.hash.length > 1) {
    const secrets = parseFragment(location.hash);
    try {
      sessionStorage.setItem(stored, JSON.stringify(secrets));
    } catch {
      // Private mode: a reload needs the link again.
    }
    history.replaceState(null, "", location.pathname + location.search);
    return secrets;
  }
  try {
    const saved = sessionStorage.getItem(stored);
    if (saved) return JSON.parse(saved);
  } catch {
    // Nothing kept.
  }
  return { token: "", key: null };
}

interface Me {
  id: string;
  name: string;
  email: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...init });
  const body = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(body?.error ?? body?.message ?? `The relay answered ${resp.status}.`);
  return body as T;
}

export function App() {
  const secrets = useMemo(linkSecrets, []);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ user?: Me } | null>("/api/auth/get-session").then(
      (s) => setMe(s?.user ?? null),
      () => setMe(null),
    );
  }, []);

  useEffect(() => {
    if (!me || !shareId) return;
    let s: Session | null = null;
    api<{ title: string; hostName: string; e2e?: boolean }>(`/api/shares/${encodeURIComponent(shareId)}/join`, {
      method: "POST",
      body: JSON.stringify({ token: secrets.token }),
    }).then(
      (joined) => {
        let key: ShareKey | null = null;
        if (secrets.key) {
          try {
            key = { generation: 1, key: unb64(secrets.key) };
          } catch {
            return setError("This link's key is damaged. Ask for a new link.");
          }
        } else if (joined.e2e) {
          return setError("This session is encrypted, and the link's key is missing. Open the whole link, including the part after #.");
        }
        s = new Session(shareId, { title: joined.title, kind: "chat", hostName: joined.hostName }, key);
        s.connect();
        setSession(s);
      },
      (e) => setError(String(e.message ?? e)),
    );
    return () => s?.close();
  }, [me, secrets]);

  if (!shareId) return <Centered title="Not a session link">Open the whole invite link you were sent.</Centered>;
  if (error) return <Centered title="Couldn’t open the session">{error}</Centered>;
  if (me === undefined) return <Centered title="Loading…" />;
  if (me === null) return <SignIn onSignedIn={setMe} />;
  if (!session) return <Centered title="Joining…" />;
  return <Watch session={session} />;
}

function Centered({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="centered">
      <Sushi />
      <h1>{title}</h1>
      {children && <p className="muted">{children}</p>}
    </main>
  );
}

/** The mascot, simply: a salmon nigiri. */
function Sushi() {
  return (
    <svg className="sushi" viewBox="0 0 64 40" aria-hidden>
      <ellipse cx="32" cy="30" rx="26" ry="9" fill="var(--rice)" />
      <path d="M8 22c6-12 42-12 48 0-4 6-44 6-48 0z" fill="var(--salmon)" />
      <path d="M18 18l6 6M28 16l6 7M38 16l5 7" stroke="var(--salmon-line)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const path = creating ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email";
      const body = creating ? { name: name || email.split("@")[0], email, password } : { email, password };
      const r = await api<{ user: Me }>(path, { method: "POST", body: JSON.stringify(body) });
      onSignedIn(r.user);
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="centered">
      <Sushi />
      <h1>Watch a shared Sush session</h1>
      <p className="muted">Sign in to this relay so the host knows who’s asking. They let you in.</p>
      <form className="signin" onSubmit={(e) => void submit(e)}>
        {creating && <input placeholder="Your name, as others see it" value={name} onChange={(e) => setName(e.target.value)} />}
        <input type="email" placeholder="Email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          type="password"
          placeholder="Password"
          minLength={8}
          autoComplete={creating ? "new-password" : "current-password"}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" className="primary" disabled={busy}>
          {creating ? "Create account" : "Sign in"}
        </button>
        <button type="button" className="link" onClick={() => setCreating((c) => !c)}>
          {creating ? "I have an account" : "New to this relay?"}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </main>
  );
}

function useView(session: Session): View {
  return useSyncExternalStore(session.subscribe, session.get);
}

function Watch({ session }: { session: Session }) {
  const view = useView(session);
  const bottom = useRef<HTMLDivElement>(null);
  // Braces: newer browsers' scrollIntoView returns a promise, which React would take for a cleanup.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [view.messages]);
  const host = view.thread.hostName;
  const online = view.members.filter((m) => m.online);

  return (
    <div className="watch">
      <header>
        <div className="title">
          <strong>{view.thread.title || "Shared session"}</strong>
          <span className="muted">
            {host}’s session{view.thread.workspaceName ? ` · ${view.thread.workspaceName}` : ""}
          </span>
        </div>
        <span className={`dot ${view.link === "live" ? "live" : ""}`} />
        <span className="muted small">{linkLabel(view)}</span>
        {view.e2e && <span className="badge" title="The relay only forwards ciphertext">Encrypted</span>}
        <span className="people">
          {online.slice(0, 5).map((m) => (
            <Avatar key={m.userId} member={m} />
          ))}
        </span>
      </header>
      {view.ownerAway && <p className="banner">{host} stepped away.</p>}
      <div className="body">
        <section className="transcript">
          {view.link === "lobby" && <p className="muted center">Waiting for {host} to let you in…</p>}
          {view.messages.map((m) => (
            <MessageView key={m.id} message={m} session={session} />
          ))}
          {(view.status === "submitted" || view.status === "streaming") && <p className="muted small">Working…</p>}
          {view.status === "awaiting" && <p className="muted small">Waiting for an approval…</p>}
          <div ref={bottom} />
        </section>
        <Comments session={session} comments={view.comments} members={view.members} />
      </div>
      {view.error && (view.link !== "live" || view.messages.length === 0) && <p className="footer muted">{view.error}</p>}
    </div>
  );
}

function linkLabel(view: View) {
  return { "signing-in": "Signing in", connecting: "Connecting…", lobby: "Waiting", live: "Live", offline: "Offline", ended: "Ended" }[view.link];
}

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

/** A `data:` image only: never a URL the page would fetch from elsewhere. */
const safeImage = (image?: string | null) => (image && /^data:image\/(png|jpeg|webp|gif);base64,/.test(image) ? image : null);

function Avatar({ member }: { member: { name: string; image?: string | null; role?: Member["role"] } }) {
  const image = safeImage(member.image);
  return (
    <span className="avatar" title={member.role === "owner" ? `${member.name} (host)` : member.name}>
      {image ? <img src={image} alt="" /> : initials(member.name)}
    </span>
  );
}

function MessageView({ message, session }: { message: Message; session: Session }) {
  const author = message.metadata?.author;
  const host = session.get().thread.hostName;
  if (message.role === "user") {
    return (
      <div className="msg user">
        <p className="who small muted">
          {author?.name ?? host}
          {message.metadata?.acceptedBy && ` · sent by ${message.metadata.acceptedBy.name}`}
        </p>
        {message.parts.map((p, i) => (
          <PartView key={i} part={p} session={session} />
        ))}
      </div>
    );
  }
  return (
    <div className="msg assistant">
      {message.parts.map((p, i) => (
        <PartView key={i} part={p} session={session} />
      ))}
    </div>
  );
}

function PartView({ part, session }: { part: Part; session: Session }) {
  switch (part.type) {
    case "text":
      return <div className="text">{part.text}</div>;
    case "reasoning":
      return part.text ? (
        <details className="reasoning">
          <summary>Thinking</summary>
          <div className="text">{part.text}</div>
        </details>
      ) : null;
    case "file":
      return <FileView part={part} session={session} />;
    case "dynamic-tool":
      return <ToolView part={part} />;
    default:
      return null;
  }
}

function ToolView({ part }: { part: Part }) {
  const state =
    part.state === "output-available" ? "done" : part.state === "output-error" ? "failed" : part.state === "input-available" ? "waiting or running" : "…";
  return (
    <details className="tool">
      <summary>
        <code>{part.toolName}</code> <span className="muted small">{state}</span>
      </summary>
      <pre>{show(part.input)}</pre>
      {part.output !== undefined && <pre>{show(part.output)}</pre>}
      {part.errorText && <pre className="error">{part.errorText}</pre>}
    </details>
  );
}

function show(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text && text.length > 8000 ? `${text.slice(0, 8000)}\n…` : (text ?? "");
}

/** An image attachment, fetched from the host (it only sends what the session shows). */
function FileView({ part, session }: { part: Part; session: Session }) {
  const [src, setSrc] = useState<string | null>(null);
  const sha = part.url?.match(/([0-9a-f]{64})/)?.[1];
  useEffect(() => {
    if (!sha || !part.mediaType?.startsWith("image/")) return;
    session.request<{ mediaType: string; data: string }>({ kind: "get-blob", sha }).then(
      (b) => /^image\/(png|jpeg|gif|webp)$/.test(b.mediaType) && setSrc(`data:${b.mediaType};base64,${b.data}`),
      () => {},
    );
  }, [sha, part.mediaType, session]);
  if (!part.mediaType?.startsWith("image/")) return <p className="muted small">📎 {part.filename ?? "attachment"}</p>;
  return src ? <img className="attachment" src={src} alt={part.filename ?? "image"} /> : <p className="muted small">Loading image…</p>;
}

function Comments({ session, comments, members }: { session: Session; comments: Comment[]; members: Member[] }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const role = members.find((m) => m.userId === session.get().me)?.role ?? "viewer";
  const canComment = role === "collaborator" || role === "driver";
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await session.request({ kind: "comment", text: text.trim(), messageId: null });
      setText("");
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="comments">
      <h2>Comments</h2>
      {comments.length === 0 && <p className="muted small">Nothing yet.</p>}
      {comments.map((c) => (
        <div key={c.id} className="comment">
          <Avatar member={c.author} />
          <div>
            <p className="small">
              <strong>{c.author.name}</strong> <span className="muted">{new Date(c.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
            </p>
            <p className="text">{c.text}</p>
          </div>
        </div>
      ))}
      {canComment ? (
        <form onSubmit={(e) => void send(e)}>
          <textarea placeholder="Comment (never sent to the agent)" maxLength={4096} value={text} onChange={(e) => setText(e.target.value)} />
          <button type="submit" className="primary" disabled={busy || !text.trim()}>
            Comment
          </button>
          {error && <p className="error small">{error}</p>}
        </form>
      ) : (
        <p className="muted small">You’re watching. The host can let you comment.</p>
      )}
    </aside>
  );
}
