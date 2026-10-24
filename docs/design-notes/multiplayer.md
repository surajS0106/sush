# Shared Sessions (Multiplayer) — Design Notes

Last updated: 2026-10-25 (phase 2)

## What changed

### 2026-10-25 (phase 2: redirect together)
- **Roles.** Each guest is a viewer (watches), a collaborator (suggests and comments) or the driver (one at a time: sends messages, pauses, resumes, "Send now", and answers what the host hands over). The share dialog has two links, **Link to watch** and **Link to suggest**, and a role picker (Watches / Suggests / Drives) next to each person. Links never make anyone a driver.
- **The guest's composer** (`GuestComposer` in `components/shared-sessions.tsx`) replaces the dashed bar for a driver or collaborator: a plain text box with an image button, a line saying "You're driving Suraj's session" (navigation mark) or "You can suggest…" (lightbulb), Leave, Pause while the agent works (driver), and Send or Suggest. A driver's message waiting for the next step shows in the usual queue with "Send now". Viewers keep the dashed bar.
- **Suggestions** (`components/suggestion-queue.tsx`) sit above the composer, in the same rounded box as the queue: each with its author's avatar, the text, and Drop / Edit / Send for the owner or the driver. A collaborator sees only theirs, "waiting for Shruti". The owner and driver get a toast when one arrives.
- **Authorship.** A message someone else wrote shows their avatar and name above the bubble, plus "sent by …" when a suggestion was sent on. A finished tool call shows "Approved by Shruti" / "Denied by" / "Answered by" under it.
- **Cards for the driver.** Approval cards appear for the driver only for what was handed over (questions always); the rest still read "Waiting for Suraj to approve". "Always allow" and "Allow all edits" never appear for a guest.
- **Comments and activity** (`components/share-activity.tsx`): a speech-bubble button with a count, left of the presence pill, opens a side sheet with two pills, Comments (thread with avatars and times, a box at the bottom for anyone but viewers) and Activity (the audit log, newest first, refusals greyed).
- **Share dialog**: "People" with roles; a shield note while anyone else can steer, saying that edits, commands, connectors and new sites ask each time and that anyone steering could get the agent to repeat memory; "<driver> may approve" switches (connectors and unsandboxed commands in red); an Activity disclosure; invite rows say "To watch" or "To suggest".

### 2026-10-25 (phase 1: watch live)
- **Share live…** in every session's menu (not incognito chats or reports) opens the share dialog (`apps/desktop/src/components/share-dialog.tsx`). Before the first share it sets up the relay account. Then one button starts sharing and copies an invite link. While sharing, the dialog shows the connection, a button that copies a fresh link, the people waiting to be let in (Let in / Turn away), who's watching (Remove), the live links (Revoke), "Let them browse the folder" for Cowork sessions, and End share.
- The header shows who's watching a session (`SharePresence` in `components/shared-sessions.tsx`). It's a pill with a brand-colored radio mark, "Live" for the host or "Watching" for a guest, up to four avatars and a "+N". For the host it also shows an "N waiting" badge, and clicking it opens the share dialog.
- Toasts: "Shruti wants to watch" stays until answered, with Let in / Turn away. Also "… joined", "… left", and the share ending. Only the leader window shows them.
- The sidebar has a **Shared with you** group: joined sessions with a live dot or their state, a hover × to leave, and a + (or "Join shared session…" when empty) that opens the join dialog. The join dialog takes a pasted link, or sets up the relay account first.
- A watched session opens on its own page in the chat view. The composer becomes a dashed bar that says whose session it is ("Only they can send messages or approve actions") with Leave. Approval cards and questions read "Waiting for Suraj to approve / answer". Edit, Regenerate, Restore checkpoint, Resume, the queue and Undo are gone. File changes show their diffs (fetched from the host), without Undo or Open.
- A watched Cowork session gets a read-only files panel (`components/shared-files-panel.tsx`): the files it changed and, if the host allows it, the whole folder. Files open in a plain line-numbered viewer, and the panel collapses to a strip.
- While waiting for the host, the empty session shows Sushi and a line saying what's happening.
- Settings → Sharing (`components/sharing-section.tsx`): the relay address, who's signed in, Sign out, and what guests can and can't see.

## Why

Everything about a shared session is decided on the host's machine, so the UI's job is to make two things obvious: who is watching, and that guests can only watch. The pill in the header puts presence where a toolbar already lives, and it stays out of the way when nobody is there. For a guest, the composer is the thing they'd reach for, so its place holds the explanation. Approval cards would otherwise say "didn't happen" to a guest while the host is still deciding, which is wrong, so they say who's being waited on.

Letting someone in is the moment that matters for safety, because a leaked link only gets someone as far as the lobby. That's why the knock toast doesn't time out and the dialog lists the waiting people first.

A watched session has no tab. It isn't one of ours, it's never saved, and it ends when the host stops. Its own page and sidebar group keep it apart from the user's sessions.

In phase 2 the composer comes back for guests who may write, but deliberately plainer than the owner's: no model picker, no skills, no dictation, because those are the host's, and the host's app builds the run. What the guest can do is said in the composer's own footer, so nobody has to remember their role. Suggestions live where queued messages already do, since both are "messages not yet sent", and the person who decides sees the controls right where they type. Authorship is a quiet line above the bubble rather than a different bubble colour: the transcript should still read as one conversation. The approval floor is explained in the dialog at the moment it starts to apply (someone can steer), not before.

## What makes it stand out

- The same transcript, tool cards, sub-agent graph and diffs as the host's own view, because they're built from the same ops.
- The share dialog says plainly what guests never get: keys, secret files, memory, past chats. The rule is enforced in Rust and is visible in the UI.
- Presence is one compact pill rather than a sidebar of people, and it doubles as the way into the share dialog.
