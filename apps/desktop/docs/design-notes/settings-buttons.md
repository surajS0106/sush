# Settings Button Hierarchy — Design Notes

Last updated: 2026-11-18

## What changed

### 2026-11-18
- Settled one hierarchy for buttons across Settings, using the existing `Button` variants (`components/ui/button.tsx`):
  - Primary (`default`): the action that completes a task. Save, Save & test, Change password, a connector's Sign in, Download Yammer, and a page header's add action (Create with Sush, New, Install from folder, Add).
  - Secondary (`outline`): routine actions in a settings row. Change, Sign out, Disconnect, Remove key, Add key, Copy, Start tour, Open Yammer, Set a budget, Raise limit, Browse connectors, Add provider.
  - Tertiary (`ghost`): Cancel, dismiss, and icon buttons (edit, delete, more, reload, back).
  - Destructive (`destructive`): anything that permanently deletes.
- Memory → "Start import" changed from `secondary` to `outline`. It was the only `secondary` button in Settings (`components/memory-section.tsx`).
- "Delete all memory", the memory editor's "Delete" (`components/memory-section.tsx`) and a provider's "Delete" (`components/providers-section.tsx`) changed from `ghost` with hand-written red classes to `variant="destructive"`, matching "Delete account" (`components/settings-dialog.tsx`).

## Why

Buttons for the same kind of action looked different from page to page. One row action used a fill no other row used, and the delete buttons came in three looks, each recoloured with its own classes. Mapping each kind of action to one variant makes how prominent a button is tell you what it does, and removes the per-button style overrides.

Providers keeps "Add provider" as `outline` because "Save & test" is the primary action on that page, and two filled buttons would compete. In the connector catalog, an added connector shows a filled check and an unadded one an outlined plus. That pair shows state rather than ranking actions, so it was left as is.

## What makes it stand out

- Only variants from `ui/button.tsx` are used, so destructive buttons share one hover, focus ring and dark-mode treatment rather than three hand-rolled ones.
- Filled buttons are kept for actions that complete something (save, sign in, install, add), so routine row actions never compete with them.
- The rule is written down here per action type, so new settings rows can follow it without comparing against other pages.
