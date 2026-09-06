# CodeForge — 8-Bit Activity UI Integration Report

Date: 2026-09-06
Asset pack source: `G:\EmojiPack` (see `G:\EmojiPack\8bit-emoji-pack-certification.md`)

## Final verdict

```text
CODEFORGE_8BIT_ACTIVITY_UI_CERTIFIED
```

## Runtime semantics changed

```text
Runtime semantics changed: NONE
```

The swap is presentation-only. No changes to event generation, command/tool execution, pause/steer semantics, approval, verification, completion, persistence, recovery, provider routing, model selection, or 8-Bit's model updater logic. Icons render authoritative state.

## What was integrated

The activity stream now renders the **8-Bit** mascot emoji set by default instead of the forge-object set. Rows keep the certified compact layout (`[20px emoji] Read package.json`); no tiles, no enlarged rows.

### Files

| Change | Path |
| --- | --- |
| Added 47 runtime PNGs (20px) | `packages/ui/src/assets/activity-emoji/8bit/20/` |
| Rewrote mapping with theme support | `packages/ui/src/emoji-assets.ts` |
| Updated presentation tests | `packages/ui/test/activity-icons.test.tsx` |
| `ActivityIcon` / `ForgeWorkingIndicator` | unchanged (`packages/ui/src/activity-icons.tsx`) |
| Legacy asset folder | untouched (`packages/ui/src/assets/emojipack/20/`, 34 PNGs) |

### Icon theme

`emoji-assets.ts` now defines `ActivityEmojiTheme = "8bit" | "legacyForge"` with `DEFAULT_ACTIVITY_EMOJI_THEME = "8bit"` and `resolveActivityEmojiTheme()` normalization. Per-theme semantic maps and file-extension maps are separate; all resolvers take an optional theme parameter (backward compatible). There is no user-facing switch — the theme exists for maintainability and rollback.

## Semantic mapping (8bit theme)

| ActivityKind | Asset | Notes |
| --- | --- | --- |
| search | `8bit-search` | |
| read | `8bit-read` | |
| reason | `8bit-reasoning` | thinking kept distinct (`8bit-thinking` ships in the pack) |
| plan | `8bit-planning` | blueprint |
| edit | `8bit-edit-file` | |
| create | `8bit-file-typescript` / `8bit-file-javascript` / `8bit-file-python` / `8bit-file-rust` by extension; `8bit-create-file` for unknown extensions | per brief §14; never infers creation |
| delete | `8bit-delete-file` | |
| tool | `8bit-tool-use` | generic tool fallback |
| execute, forge | `8bit-running-command` | replaces the welding torch |
| fetch | `8bit-fetch` | |
| build | `8bit-build` | derived asset (blocks); not a command reuse |
| test | `8bit-testing` | |
| verify | `8bit-verifying` | semantically distinct from testing |
| git, commit | `8bit-git` | |
| error | `8bit-error` | |
| waiting, queued | `8bit-waiting` | |
| paused | `8bit-paused` | |
| approval | `8bit-thumbs-up` | documented decision: no approval cell exists in the source sheets; the thumbs-up reads "confirm" (pack B asset, shipped with the activity runtime set) |
| complete, success | `8bit-success` | |
| warning | `8bit-warning` | |
| cancelled | `8bit-cancelled` | derived asset (prohibition slash), distinct from the error X |
| parallel | `8bit-multi-model` | several concurrent streams |
| generic, unknown | `8bit-tool-use` | safe fallback in both themes |

## Tests

`packages/ui/test/activity-icons.test.tsx` — 45 tests, all passing. Coverage includes:

- every `ActivityKind` resolves to a production asset in the default theme (read, search, reason, plan, edit, create, delete, tool, execute, fetch, build, test, verify, git, commit, error, waiting, queued, paused, approval, complete, warning, cancelled, parallel, success, generic, unknown, forge)
- explicit expected asset names for the full 8bit mapping table
- file-extension mapping (`.ts`, `.py`, `.js`, `.rs`) and unknown-extension/`no-extension` fallback to `8bit-create-file` (missing-asset fallback for unknown kinds → `8bit-tool-use` in both themes)
- `legacyForge` rollback parity (legacy names, legacy asset URLs, legacy extension map)
- accessibility: status text remains the primary content, PNG `alt=""`/`aria-hidden`, historical rows render static
- forge indicator lifecycle (inactive removal, post-completion quiet state)

## Build results

- `@codeforge/ui` typecheck: PASS (`tsc -b --force`)
- `@codeforge/ui` build: PASS (`tsc -b`)
- `packages/ui` vitest: 13 files, 186 tests, all passing
- `apps/web` production build: PASS (`vite build`)

Assets resolve via the same `new URL(..., import.meta.url)` mechanism as the certified legacy set, from the sibling folder `packages/ui/src/assets/activity-emoji/8bit/20/`; any packaging that already ships `assets/emojipack/20` ships the 8bit folder under the same rule.

## Rollback

Set `DEFAULT_ACTIVITY_EMOJI_THEME` (or pass the theme to the resolvers) to `"legacyForge"` — the original forge icons and mapping are intact and tested. Deleting nothing is required.

## Visual evidence

- Pack certification with preview/audit/mockup index: `G:\EmojiPack\8bit-emoji-pack-certification.md`
- 20px dark/light audits and 3× zoom strips: `G:\EmojiPack\8bit\previews\8bit-activity-20px-audit-*.png`
- Real-density chat mockups: `G:\EmojiPack\8bit\previews\8bit-chat-mockup-dark.png` (+ light, narrow, 3× zoom)
