# UX onboarding/auth/first-launch campaign — final report

Scope: login screen, GitHub CTA, OAuth branding, post-auth welcome/project launcher,
returning-user recents, shell account affordance. Executed against the **installed packaged
build** (`CodeForge-Setup-0.4.0.exe`, post-campaign rebuild), not dev mode.

## Implementation

### Files changed

| File | Change |
| --- | --- |
| `apps/desktop/src/renderer/AuthScreen.tsx` | New copy/hierarchy; real GitHub Octocat SVG (`GitHubMark`, 18 px, `currentColor`, `aria-hidden`); acknowledgement stays visible after checking; legal sentence wired to configured links only |
| `apps/desktop/src/renderer/WelcomeScreen.tsx` | New copy/hierarchy; 80 px icon; renamed actions; recents with relative timestamps, stale dimming + per-item remove; benefits row; exported pure `formatLastOpened` |
| `apps/desktop/src/renderer/App.tsx` | `Project.exists?`; `handleRemoveRecentProject`; prop wiring |
| `apps/desktop/src/renderer/styles.css` | Auth card 390→424 px, free-note pill, legal-note styles, `.github-mark`; welcome card 480→540 px lifted `6vh` above center, primary button switched from `--cf-accent` blue to light surface/dark text, recent-row/stale/remove styles, `.welcome-benefits` (replaces `.welcome-footer`) |
| `apps/desktop/src/main.ts` | `project:getRecent` now annotates each entry with `exists` (folders are reported-not-filtered: a missing folder may be a detached drive); new `project:removeRecent` IPC (sender-checked, normalized-path match, atomic settings write) |
| `apps/desktop/src/preload.ts` / `preload.cjs` | `removeRecentProject` + `exists` field on recents type |
| `apps/desktop/test/welcome-screen.test.tsx` | New: 8 tests (first-run/returning states, stale badge+remove, 5-cap, error surface, `formatLastOpened`) |
| `apps/desktop/test/header-account-layout.test.ts` | Copy assertions updated; +2 tests (real GitHub mark, acknowledgement disclosure) |
| `tools/native-product-audit/scenarios/onboarding.mjs` | New CDP scenario: structure assertions + screenshots + responsive + tab-order + console-error sweep |
| `docs/github-oauth-app-branding.md` | Owner-action doc for the GitHub OAuth App badge |

### Copy changed

- Heading: `Build software with AI.` → **`Your AI coding agent.`**
- Capability: `Build, fix, and understand software with an agent that works directly with your project.` + `CodeForge can explore your codebase, edit files, run commands and tests, and show you exactly what it changed.`
- Free benefit now a visually distinct bordered element: `Start free with CodeForge-managed AI models. No API key required.`
- Acknowledgement: verbose OS-permissions text → `I'm 18 or older and understand that CodeForge can read and modify project files and run commands on this computer according to my approval settings.` (still explicit: files + commands + approval settings)
- Identity note: `GitHub sign-in creates your free CodeForge account. Connect repositories or your own AI providers later if you want — neither is required to start using CodeForge Free.`
- Buttons: `Open a folder…` → **`Open project folder`**; `New empty project…` → **`Create new project`**
- Welcome header: `CodeForge / Your AI coding agent, ready to work.` → **`Welcome to CodeForge` / `What are we building today?`** + `Open an existing project or create a new workspace to get started.`
- Footer: single muted line → three quiet `✓` assurances (`Free AI models included` / `No API key required` / `Changes verified before completion`); divider removed

### Recent projects

Persistence already existed (`codeforge:recent-projects`, dedup, cap 10, atomic writes).
Added: `exists` annotation, relative `lastOpened` display, stale badge (`folder not found`),
hover/focus-visible per-row remove that persists via `project:removeRecent`.

**Real defect caught by the preload-parity test**: `removeRecentProject` initially existed only
in `preload.ts`; the shipped `preload.cjs` lacked it, so the packaged app's remove was a
`?.()` no-op (row vanished visually but resurrected on restart). Fixed; verified live —
removal now persists to `settings.json`.

### UX defect found & fixed during evidence capture

The acknowledgement row unmounted on check → the enabled CTA shifted up under an active
cursor → a synthetic mousedown/mouseup pair could land on "Continue with GitHub" and start
real OAuth unintentionally (observed: the fresh-profile instance signed in during the first
scenario run). The acknowledgement now **stays rendered** (checked) — no layout shift, and
the consent remains visibly affirmed rather than vanishing.

## OAuth branding

- **Changed in repo**: nothing — the badge is a GitHub OAuth App setting, not code.
- **Requires owner action**: yes. Doc: `docs/github-oauth-app-branding.md`.
- Asset to upload: `apps/desktop/assets/icon.png` (512×512, circular-crop safe).
- Path: GitHub → Settings → Developer settings → OAuth Apps → CodeForge → Application logo.
- Verified unchanged: client ID `Ov23liH1JnjFlJJJyQcL` (observed live via `/v1/auth/start`),
  callback `https://codeforge-cloud-va.onrender.com/v1/auth/github/callback`,
  scope `read:user user:email`, PKCE S256. No scope/permission expansion.
- Terms/Privacy footer: URLs remain deliberately unset (`product-links.ts` documents why —
  legal docs unpublished, domain serves nothing). The sentence + links render automatically
  once real URLs are configured; no fake links were added. **Owner action: publish
  Terms/Privacy and set `PRODUCT_LINKS`.**

## Testing

- Desktop suite: **327 / 327 pass** (was 317; +8 welcome-screen, +3 header-layout; −1 merged).
- Focused: auth-error, onboarding, cloud-auth-flow, preload-bridge — all pass.
- Parity test caught and fixed the `preload.cjs` gap above.
- Typecheck: `tsc -p tsconfig.json --noEmit` clean.
- Packaged audits: `PACKAGED_INTERNAL_DEPENDENCY_GRAPH_PASS`, `PACKAGED_BUILD_IDENTITY_VALID=PASS`, `PACKAGED_AUTH_ENDPOINT_VALID=PASS`.

### Packaged Electron smoke (installed build, CDP-driven)

| Scenario | Result |
| --- | --- |
| Auth screen (fresh profile) | **7/7 PASS** — copy, real GitHub mark, CTA gated by ack, responsive 1600/1366/820, tab order, zero console errors |
| Welcome (signed-in profile) | **5/5 PASS** — copy, recents + timestamps + stale badge, responsive 1920/1366/760, zero console errors |
| Stale-recent removal | Row removed from UI **and** `settings.json` (verified on disk) |
| Account avatar/menu | GitHub avatar `avatars.githubusercontent.com` rendered; menu shows name, @handle, email, Profile & Account / Settings / Sign Out |

Auth failure states (cancel/timeout/rejected/offline) are preserved unchanged —
`describeSignInFailure`/`describeCloudAuthFailure` mappings tested; the network-fault probe
from R16 covers Cloud-unreachable on the same code path. No OAuth/callback/session code was
touched beyond the additive `project:removeRecent` handler.

## Evidence

- `docs/evidence/ux-onboarding/01-login/` — unchecked + checked states, 3 viewport sizes
- `docs/evidence/ux-onboarding/02-welcome/` — welcome, recents+stale, post-remove, 3 viewport sizes
- `docs/evidence/ux-onboarding/03-shell/account-menu.png` — avatar + account menu
- `*/onboarding-results.json` — machine-readable check results

Profile copies used for capture were deleted after the run (they contained sealed tokens).

## Remaining owner actions

1. Upload `apps/desktop/assets/icon.png` as the OAuth App logo (exact path in
   `docs/github-oauth-app-branding.md`).
2. Publish Terms of Service / Privacy Policy and set `PRODUCT_LINKS.termsOfService` /
   `privacyPolicy` in `apps/desktop/src/renderer/product-links.ts` — the consent sentence and
   links appear automatically once configured.

## Final verdict

- IMPLEMENTED: yes — all planned UI/copy/recents work landed and is packaged.
- VISUALLY VALIDATED: yes — screenshots from the installed build at 4 viewport sizes.
- AUTH REGRESSION VALIDATED: yes — OAuth flow, scopes, callback, session restore, sign-out
  menu untouched; tests + packaged smoke pass.
- PACKAGED WINDOWS VALIDATED: yes — installed `CodeForge-Setup-0.4.0.exe`, CDP-driven scenarios.
- OWNER ACTION REQUIRED: yes — OAuth app logo upload; Terms/Privacy URL publication.
