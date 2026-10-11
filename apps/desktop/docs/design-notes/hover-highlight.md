# Hover Highlight — Design Notes

Last updated: 2026-10-12

## What changed

### 2026-10-12 (glide in Radix menus)
- `FollowHighlight` waits 80ms (`HIDE_DELAY`) before hiding when its list has no active item, and cancels the hide if a new item becomes active first (`src/components/ui/motion-highlight.tsx`).

### 2026-10-12 (one dropdown style)
- `src/components/ui/DropdownMenu.tsx` is restored and extended (see `docs/design-notes/settings-accent-picker.md` at the repo root). It replaces every Radix `Select` in the app: Chat font, API format, Authentication, speech provider. Its rows are marked `data-highlighted`, and a `FollowHighlight` inside the scroll area glides between them. This replaces the `layoutId` span that glitched while scrolling.
- `src/components/ui/dropdown-menu.tsx` (Radix action menus: profile, provider presets, session "...", composer, workspace) now shares that component's look through two class constants:
  - `SURFACE`: a bordered `bg-popover` panel with `shadow-md` that fades in from 4px away at 98% scale over 180ms (ease-out-quint) and only fades on exit.
  - `ROW`: `gap-2 px-2 py-1.5` rows with muted checks and chevrons.
- `src/components/permission-mode-picker.tsx` drops its own radius, padding and brand-coloured check.

### 2026-10-12 (every dropdown)
- `src/components/ui/motion-highlight.tsx`:
  - New `FollowHighlight({ selector })`. It watches its container with a `MutationObserver` and glides to whichever descendant matches `selector`. The observer is limited to `data-highlighted`, `data-selected`, `aria-selected` and `hidden` changes, plus added and removed nodes.
  - `MotionHighlight` measures against its `offsetParent` instead of its parent element. That lets it sit inside wrappers such as cmdk's list sizer.
  - `MotionHighlight` copies the target's corner radius when it has one, and turns red for `data-variant="destructive"` items.
  - New `revision` prop on `MotionHighlight`: bumping it re-measures when items move but the target stays the same.
- `src/components/ui/dropdown-menu.tsx`: `DropdownMenuContent` and `DropdownMenuSubContent` are `relative` and render a `FollowHighlight` on `[data-highlighted]` items. Items, checkbox and radio items, and sub-triggers no longer set their own `focus:bg-*` fill. The sub-trigger is now `relative`.
- `src/components/ui/select.tsx`: the viewport is `relative` and renders a `FollowHighlight`. `SelectItem` drops `focus:bg-accent`.
- `src/components/ui/command.tsx`: `CommandList` renders a `FollowHighlight` (`bg-muted`) on `[data-selected="true"]` items. `CommandItem` drops `data-selected:bg-muted`. This covers the model picker.
- `src/components/slash-menu.tsx` and `src/components/mention-menu.tsx`: the active option's `bg-accent` is replaced by a `FollowHighlight` on `[aria-selected="true"]`.

### 2026-10-12
- New `MotionHighlight` (one absolutely positioned background that springs to a target's offset box) and `HoverHighlight` (pointer-delegated wrapper) in `src/components/ui/motion-highlight.tsx`.
- The main sidebar (`src/components/app-sidebar.tsx`, keyed on `[data-sidebar="menu-item"]`) and the Settings nav (`src/components/settings-dialog.tsx`) use `HoverHighlight`, and their rows' own hover fills are turned off.
- The accent dropdown's per-item `layoutId` span was replaced by one `MotionHighlight`.

## Why

The motion had to match in every list, so it now lives in the primitives. Every Radix menu, select, command list and composer picker gets it without changes at the call site.

Following the DOM rather than the pointer matters for these lists. Radix, cmdk and the composer pickers already decide which item is active: hover, arrow keys, typeahead, filtering. Watching the attribute they set means the highlight follows all of those inputs, and the lists' own keyboard logic stays the only source of truth.

The original dropdown glitched while scrolling. `layoutId` remounts the highlight in the newly hovered row and animates it from the old row's page position, measured before the scroll. The open animation's scale also skewed those measurements. The highlight now lives inside the scrolled content and is placed by layout offsets, so neither scrolling nor transforms affect it.

Action menus (with per-item actions, separators and submenus) stay on Radix for its focus handling and collision-aware placement. They take their surface, row and motion values from the value picker, so every dropdown looks and moves the same.

Radix menus clear `data-highlighted` on pointer-leave before the next row sets it, so between two rows there is briefly no highlighted item. The highlight read that as leaving the list: it hid, then reappeared at the next row without moving, so the profile menu and other Radix menus never glided. Measured in WebKit, the highlight went from row 1 to row 3 in under 25ms before the fix. After it, the move takes about 175ms on the spring. The 80ms grace period is short enough that leaving the menu still fades the highlight promptly.

Trade-offs: each open list runs one `MutationObserver`. The composer pickers keep their hand-rolled listboxes instead of moving to a library menu, because a Radix menu takes focus away from the textarea and the pickers must leave the caret in place while you type.

## What makes it stand out

- No drift while scrolling: the highlight sits in the same scrolled box as the items, so scrolling moves both together without measuring again.
- Unaffected by transforms: offsets ignore CSS transforms, so the highlight lands correctly during a menu's zoom-in.
- Keyboard and typeahead move it the same way hover does, because it reads the list's own active-item attribute.
- One element per list, not one mounted per hover, and no shared `layoutId` that two open menus could fight over.
- It takes the target's corner radius and destructive tint, so call sites pass at most a background colour.
- When it reappears, it fades in at the new item instead of sweeping across the list from a stale spot.
