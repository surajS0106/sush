# Model picker and composer row — Design Notes

Last updated: 2026-11-10

## What changed

### 2026-11-10 (later)
- The Thinking control is a button that opens a menu instead of a slider that grew out on hover. The footer shows only the signal bars (plus the level's name at `@md`); the menu, opening upward, lists Off and Low to Max as radio items, each with its own bars, the model's default marked, unsupported levels disabled, and the model's note at the bottom. A model with no thinking controls says so inside the menu (`components/reasoning-picker.tsx`).
- Its width now follows the composer (`@md:w-28` replaced the window breakpoint `sm:w-28`, then the fixed width went away with the menu), so in a narrow panel it no longer pushes the model pill over the + button.
- Every row in the model list keeps the check icon's slot, invisible unless picked, so the hint chips stay in one column whether or not a row is selected (`components/model-picker.tsx`).

### 2026-11-10
- The picker opens on a short list of up to eight models: the current one, the three used most, then up to two from each provider. Each row shows a readable name, its provider, a one-word hint ("Fast", "Balanced", "Strongest", "On this computer"), and a coral warning if its account just turned a request down. "All models (n)" opens the full list with every provider's group open (each can still fold). Typing searches everything (`components/model-picker.tsx`).
- Readable names: a model's own display name, else its id without the provider path, tag (":cloud") or release date, with split versions joined ("claude-sonnet-5-5" reads "Claude Sonnet 5.5"). The full list still shows the raw id beside a tidied name (`friendlyName` in `lib/model-names.ts`).
- Account problems are remembered per model: a run that fails for credits or a rejected key flags that model until a later request on it streams (`noteModelProblem`/`noteModelWorked`, recorded from `status` frames in `lib/sessions.ts`, classified by `providerTrouble` in `lib/workflows.ts`).
- The composer's bottom row adapts to the space the box has, not the window: the footer is a container, the Auto switch and Thinking picker drop their words below `@md` and keep their icons, the model name keeps at least `min-w-24` and truncates, and the provider label only shows when there's room (`components/composer.tsx`, `permission-mode-picker.tsx`, `reasoning-picker.tsx`).

## Why

The picker was a dialog of collapsed provider groups listing raw model ids. For most choices you had to open a group and recognise a technical name; nothing said which model was quick or strong, or that one had stopped working. The short list covers the usual case in one click, and the full list stays one click further away. The hints are guesses from names, so they stay deliberately coarse.

The hover slider was laid over its own fixed-width box, which kept it from shifting neighbours in a wide composer, but in a narrow one the box overlapped the model pill, and its tooltip ran off the window's edge. A menu takes no footer space beyond one icon and can show what each level means and why some are unavailable. It costs one extra click to change the level, which is changed far less often than it is glanced at.

The composer lives in narrow panels now (CRM Ask, workflow step drawers, notebooks), where breakpoints keyed to the window kept every label at full width and pushed the row past its edge.

## What makes it stand out

- The short list is ordered by what you actually use, then filled per provider so every connected provider is visible without opening anything.
- Broken models are flagged in place, with the reason, before you pick them, and the flag clears by itself once the model works again.
- Thinking levels are a keyboard-navigable radio menu with each level's bars and colour, so the choice reads the same in the menu and in the footer.
- Hint chips and the current-model check sit in fixed columns: picking a model never moves anything in its row.
- Labels give way in a fixed order (Auto and Thinking words, then the provider name, then the model name truncates); the send button never shrinks.
