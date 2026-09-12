# CODEFORGE FULL PRODUCT AUDIT R1 — RESUME & FINDINGS

**Resume timestamp:** 2026-09-12T00:49 EDT  
**Auditor session:** Continuation (session-limit interruption recovered)  
**HEAD at first audit:** `92df553`  
**HEAD at resume:** `92df553` ← unchanged  
**Branch:** `forger-digital-solutions-forgegreen-certified`  
**Working tree:** 46 modified/untracked files (unchanged from baseline)

---

## RESUME STATE

| Field | Value |
|---|---|
| `baseline_at_first_audit` | `92df553` (forger-digital-solutions-forgegreen-certified) |
| `resume_state` | Same HEAD. Working tree unchanged. 7 worktrees present. |
| Changed since baseline? | **No** |

### Worktrees
| Path | Commit | Branch |
|---|---|---|
| `G:/CodeForge` | 92df553 | forger-digital-solutions-forgegreen-certified |
| `C:/temp/CodeForge Final Ship` | 283a307 | detached HEAD |
| `C:/Users/.../CodeForge Certified e18cb8d` | e18cb8d | detached HEAD |
| `copilot-worktrees/…/didactic-fortnight` | 4904d2b | forger-digital-solutions-task-fix |
| `copilot-worktrees/…/fantastic-garbanzo` | 254ee4d | forger-digital-solutions-analyze-attached-request |
| `copilot-worktrees/…/miniature-garbanzo` | 4904d2b | forger-digital-solutions-fg10-shadow-evidence |
| `G:/CodeForge-BYOK-R1` | 73e48f3 | release/desktop-byok-beta-r1-rc2 |

---

## BUILD RESULT — PASS ✅

```
npm run build
```

All packages: **0 errors, 0 warnings**. 24 packages built via `tsc -b`.

---

## TEST RESULT — PASS ✅

```
npm test
Test Files  300 passed | 7 skipped (307)
      Tests  2215 passed | 36 skipped (2251)
   Duration  302.26s
```

**Zero failures.** Including:
- `packaged-browser-security.test.ts` — sandbox, context isolation, nodeIntegration, webSecurity all enforced
- `director/test/security.test.ts` — credentials never in logs, adapter never exposes keys
- `autonomous-e2e.test.ts` — deterministic bug fix, stale-edit protection, atomic write
- `mission-orchestrator-integration.test.ts` — multi-wave mission, replanning on verification failure
- `approval-lifecycle.test.ts` — 13 approval scenarios, double-approve protection
- `model-selection-boundary.test.ts` — ForgeZero fail-closed on paid model for non-entitled user
- `network-exposure.test.ts` — local control-plane binds loopback by default
- `renderer-csp.test.ts` — data-URL activity assets, GitHub avatar CSP
- `cf14-large-repo-benchmark.test.ts` — 1,000,000+ line repo indexed, all query latencies measured

---

## WORKSPACE UI REGRESSION — AUDIT FINDINGS

### Architecture: Settings Is Properly Isolated

`WorkspaceShell.tsx` uses a single `settingsSection: string | null` state:

```tsx
{settingsSection !== null ? (
  <SettingsApp context={settingsContext} initialSection={settingsSection} />
) : (
  <main className="workspace-shell-main" ...>
    <WorkspaceApp ... />
  </main>
)}
```

**Settings navigation does NOT:**
- Alter `workspace-shell` root layout
- Touch the header (account, ForgeZero indicator, repo intelligence, help always visible)
- Clear workspace state (`selectedModelId`, `models`, `project`, `gitInfo`, `cloudAccount`, `defaultExecutionMode` all survive)
- Modify sidebar or composer structure
- Leak CSS into the coding workspace

**Back button path:** `context.closeSettings()` → `setSettingsSection(null)` → `<WorkspaceApp>` returns

### CSS Isolation: Clean

- `workspace.css` (packages/ui) defines `:root` CSS custom properties (`--cf-*` tokens)
- `settings.css` (apps/desktop) uses `.app-settings`, `.settings-nav`, `.settings-content` scoped selectors
- `styles.css` (apps/desktop) defines welcome/shell/provider page styles
- **No global CSS override from Settings.** Settings inherits the shared `--cf-*` token system without redefining it.
- `.cf-reduced-motion` class applied to `.workspace-shell` root via settings preference — correct scope

### State Continuity Through Settings

All preserved across Settings open/close:
| State | Location | Preserved? |
|---|---|---|
| `selectedModelId` | WorkspaceShell useState | ✅ |
| `models` / `modelSections` | WorkspaceShell useState | ✅ |
| `project` | WorkspaceShell prop | ✅ |
| `gitInfo` | WorkspaceShell useState | ✅ |
| `cloudAccount` | WorkshaceShell useState | ✅ |
| `defaultExecutionMode` | WorkspaceShell useState | ✅ |
| `settingsSnapshot` | WorkshaceShell useState | ✅ |
| Active session (SSE) | WorkspaceApp useState | ✅ (unmounts when settings open — acceptable) |

> **Note:** `WorkspaceApp` (SSE connection) unmounts when settings is open. This means an in-progress streaming response would be interrupted if the user navigates to Settings mid-stream. This is the correct safe behavior — the turn continues server-side; the SSE reconnects on return. The completion gate is authoritative, not the renderer.

### Model Catalog: Single Source

Settings `ModelsRoutingSection` uses `ctx.modelSections` and `ctx.apiModels` — the **exact same data** built in `WorkspaceShell` and passed to both the composer picker and the Settings context. There is no second model list. One catalog, one source.

---

## SECURITY AUDIT

### IPC Surface — PASS ✅

| Handler | Validation |
|---|---|
| `shell:execCommand` | git-only allowlist (`payload?.command !== "git"` → throws), sender checked against mainWindow.webContents, args must be string[], uses `execFile` not `exec`, 10s timeout |
| `provider:setCredential` | `isValidProviderId()` allowlist (9 known providers), `isValidApiKey()` length ≤ 512, throws on invalid |
| `provider:deleteCredential` | Same allowlist check before deletion |
| `shell:openExternal` | Protocol check: only `https:` or `localhost` http; all others throw |
| `app:close-decision` | Sender checked against mainWindow.webContents; decision must be exact enum value |
| `project:open` | Path must be string, length 1–1024, null-byte rejection |
| `notifications:show` | Sender checked; title/body typed and length-bounded (120/250) |
| `legal:setFirstRunAck` | Takes NO parameters from renderer; flags set server-side only |
| `project:clearRecent` | Sender checked against mainWindow.webContents |

### Credential Storage — PASS ✅

- `safeStorage.encryptString()` used for all API keys and cloud tokens
- Stored as `enc:<base64>` prefix — plaintext fallback path disabled when encryption unavailable
- Settings file written via `writeSettingsAtomic()`: tmp → rename, mode `0o600`
- `Object.defineProperty` used for prototype-safe assignment

### Context Isolation — PASS ✅

- `contextBridge.exposeInMainWorld("electronAPI", api)` — context bridge, not `nodeIntegration`
- Preload typed API surface — no arbitrary IPC channels exposed to renderer
- `packaged-browser-security.test.ts` confirms all required security flags enforced

### Certificates — PASS ✅

- `certs/supabase-prod-ca-2021.crt`: Supabase Root 2021 CA, SHA-256 RSA, valid 2021–2031
- **No private keys** in certs directory
- Single cert file, legitimate provenance

### Fixture Leak Scan — PASS ✅

- **Zero** occurrences of "Fixture Tester", "fixture_tester", "demo@", "fake@", "hardcoded" in production renderer source (`apps/desktop/src/renderer/`, `packages/ui/src/`)
- `isFixtureAccount = !cloudAccount.user?.primaryIdentity && !cloudAccount.user?.id` — smoke fixtures explicitly labeled with `.fixture-banner` in ProfileSection, never silently masquerade as real users
- PACKAGED_SMOKE account returns `{ user: { displayName: "Packaged smoke" } }` — labeled, not "Fixture Tester"

---

## GIT CONTEXT

**Single canonical invocation:** `git rev-parse --abbrev-ref HEAD --git-dir --git-common-dir`

| Condition | Behavior |
|---|---|
| Normal branch | Shows branch name |
| Detached HEAD | Shows "detached HEAD" |
| Linked worktree | `gitDir !== gitCommonDir` → `isWorktree: true`, shown as "· worktree" |
| Non-git folder | `exitCode !== 0` → `isGitRepo: false`, nothing shown |

Header, ContextBar, and Settings all read from the same `gitInfo` state in WorkspaceShell. **One source, no drift possible.**

---

## FORGEZERO / FORGEAUTO / 8-BIT / GEMS SEMANTICS

| Concept | Description | Where shown | Correct? |
|---|---|---|---|
| ForgeAuto/Free | Task router | Picker (first item), Settings Models & Routing | ✅ |
| 8-Bit | "8-Bit free catalog" | Settings Models & Routing section heading | ✅ |
| ForgeZero | Trust status indicator | Header (◈/◇ badge), Settings Verification & Safety | ✅ |
| GEMS | Premium entitlement layer | Settings GEMS section, model picker tier | ✅ |
| Connected Providers | BYOK expansion | Settings Connected Providers (secondary) | ✅ |

**No conflation.** ForgeZero is not a model. ForgeAuto is not a single model. 8-Bit is not the router. OpenRouter is not "CodeForge Free."

---

## CLOSE / TRAY LIFECYCLE

### Policy Logic — PASS ✅

`resolveCloseAction()` truth table (in `close-lifecycle.ts`):
- No active work → behavior "tray" ? tray : quit
- Active + recoverable + behavior "tray" → tray (silent, no dialog)
- Active + recoverable + behavior "quit-safe" → quit (silent)
- Anything else → ask (show CloseDialog)

### Tray Implementation — PASS (source) ⚠️ (packaged unproven)

- `hideToTray()` → `ensureTray()` → `mainWindow?.hide()`
- Tray tooltip: `summarizeActiveWork(status)` — same function as CloseDialog
- Tray context menu: Open CodeForge / Quit CodeForge
- Double-click on tray → `restoreMainWindow()`
- 15-second refresh interval for tray tooltip accuracy
- `close-lifecycle.ts` tested independently via unit tests
- **Full packaged-app tray workflow (start task → close → tray → restore → task continues) was not directly observed in a running packaged application**

---

## COMPLETION GATE — PASS ✅

`evaluateCompletion()` in `packages/workflow/src/completion-gate.ts` is the single authority.

Blocking codes that prevent `completed`:
- `budget_exhausted` — out of iterations, never success
- `approval_pending` — cannot complete while approval is outstanding
- `question_pending` — cannot complete while question is unanswered
- `verification_not_run` — no proof
- `verification_failed` — proof failed
- `verification_not_current` — stale revision (verified revision N ≠ current revision M)
- `verification_policy_insufficient` — ForgeGreen policy version mismatch
- `no_effective_change` — claimed edits with no diff
- `plan_steps_unfinished` — failed/blocked steps remain
- `review_rejected` — blocking review findings

No code path reaches `completed` without passing all enabled blockers. `blocked` is terminal, never success.

---

## SETTINGS COMPLETENESS

All 16 sections implemented with real content (no placeholders):

| Group | Sections |
|---|---|
| General | General, Profile & Account, Appearance |
| CodeForge | Models & Routing, Agents, Verification & Safety, GEMS |
| Workspace | Workspaces, Git & GitHub, Runtime & Execution |
| System | Notifications, Application & Background, Data & Privacy |
| Integrations | Connected Providers |
| Advanced | Advanced, About |

Settings search: tokenized keyword matching across labels, descriptions, and keyword aliases.

---

## IDENTIFIED GAPS

### GAP-1: No Packaged Windows Candidate Built/Inspected

> **Severity: Blocking for STRONG verdict**

A packaged `.exe` / NSIS installer was not built during this audit session. The build system (`electron-builder`) is present but was not invoked. Packaged-app visual appearance, actual Electron security flags in production, and tray behavior in a real Windows packaged context are unverified by this audit.

**Required to close:** Run `npm run package` or `electron-builder` against the current working tree state, record the artifact SHA-256, inspect the packaged app UI in a fresh Windows session.

### GAP-2: Minimize-to-Tray + Active Task Not E2E Proven

> **Severity: High — required by audit item 30**

The tray lifecycle logic is correctly implemented and unit-tested. The full runtime workflow — start real agent task → close window → tray appears → task continues → restore → task completes — was not observed in a live Electron process.

**Required to close:** Run the packaged app with a real (or smoke) agent task, close the window via X button, confirm tray tooltip shows active work, confirm agent progresses, restore window, confirm task state present.

### GAP-3: Working Tree Uncommitted

> **Severity: Audit traceability concern**

46 files are modified or untracked relative to `92df553`. The audit tested the working tree (which passes build+tests), not a clean committed state. The working tree contains legitimate Settings implementation, ForgeGreen campaign results, and various in-progress work.

**Required to close:** Commit the working tree to a named branch and tag it as the audited candidate before issuing any production certification.

### GAP-4: `execCommand` Git Args Unbounded

> **Severity: Low**

`shell:execCommand` is allowlisted to the `git` binary and requires string[] args. However, any git subcommand can be sent from the renderer (not just `rev-parse`). In practice only `GIT_WORKSPACE_INFO_ARGS` is sent, but a compromised renderer could invoke `git push`, `git reset --hard`, etc.

**Recommended:** Restrict the args to a whitelist of safe read-only git subcommands (rev-parse, status, log, diff --stat). Write a test asserting this.

### GAP-5: Preload Loose Typing

> **Severity: Minor**

`getCloudAccount(): Promise<any>` and `getCloudUsage(): Promise<any>` in `preload.ts` use `any` return types. No runtime security impact (IPC calls are validated in main.ts) but reduces TypeScript type safety at the call site.

### GAP-6: WorkspaceApp Unmounts During Settings

> **Severity: Low / expected behavior**

When Settings is open, `WorkspaceApp` unmounts, disconnecting the SSE connection. A streaming agent turn would lose its renderer-side display while Settings is open. The turn continues server-side and the SSE reconnects on return. The user could miss real-time output that occurred while in Settings. A background task indicator in the header (visible during Settings) would mitigate this.

---

## PRODUCT COHERENCE REVIEW

| Surface | Consistent terminology? |
|---|---|
| Workspace composer | ForgeAuto/Free, Agent/Chat, approval control ✅ |
| Model picker | ForgeAuto/Free first, CodeForge Free catalog, GEMS tier, Connected ✅ |
| Header | ForgeZero indicator (not model), account with real identity ✅ |
| Settings Models & Routing | ForgeAuto, 8-Bit free catalog, ForgeZero, favorites ✅ |
| Settings Verification | ForgeVerify, completion gate, workspace boundary ✅ |
| Settings Agents | Agent mode, steering, approvals ✅ |
| Close dialog | Minimize to tray / Quit CodeForge wording ✅ |
| Error messages | humanizeError() humanizes provider codes consistently ✅ |

No surface calls ForgeAuto "one model." No surface calls 8-Bit the router. No surface calls ForgeZero a model. No surface calls OpenRouter "CodeForge Free."

---

## FINAL VERDICT

```
CODEFORGE_FULL_PRODUCT_AUDIT_R1_FUNCTIONAL_WITH_GAPS
```

### Rationale

CodeForge is **architecturally sound and functionally complete** at the source and runtime level:

- Build: zero errors
- Tests: 2215 passing, 0 failing, across 300 files including security, E2E, agent runtime, approval lifecycle, completion gate, model selection boundary, network exposure, and CSP
- Workspace UI correctly separates Settings from the coding workspace with no state loss
- Security model is strong: allowlist-validated IPC, encrypted credentials, context isolation, CSP tested
- ForgeZero/ForgeAuto/8-Bit/GEMS semantics are correct and consistent across all surfaces
- Completion gate is enforced, not asserted — budget exhaustion, stale revision, missing verification all block completion
- Close/tray lifecycle has correct policy logic and is unit-tested

**The gaps preventing STRONG:**
1. No packaged Windows binary produced or visually inspected
2. End-to-end tray/minimize + active agent continuation not proven in a real Electron process
3. Working tree is uncommitted — audit candidate is not a tagged, reproducible artifact

---

## DIRECT ANSWERS (Audit Item 54)

**Q: Does the exact packaged CodeForge candidate look and behave like one coherent autonomous coding product, or does it still feel like several separate systems bolted together?**

**A:** At source level — which is all that can be verified without a built package — it is one coherent product. The workspace, Settings, model picker, account, close behavior, and agent runtime share a single state store (WorkspaceShell), a single model catalog, a single Git context source, and a single completion authority. Settings is a dedicated application area that opens inside the shell header without replacing the workspace. The terminology is consistent across every surface. The primary remaining incoherence risk is the SSE unmount during Settings navigation (GAP-6), which is minor. Whether this reads as one coherent product in the packaged UI requires the packaged build — that evidence does not exist yet.

**Q: If I installed this exact candidate on another Windows PC today, what would still prevent me from replacing Claude/Codex/OpenCode-style daily coding workflows with CodeForge?**

**A: Minimum factual gaps:**

1. **No packaged build exists.** You cannot install what has not been built. The working tree passes tests and builds clean from source but has never been packaged in this audit session.

2. **Free model availability is runtime-dependent.** ForgeAuto/Free routes to verified-free providers (OpenRouter, Z.AI, Groq, Cloudflare). Whether those routes have current free capacity for a fresh user with no BYOK depends on live provider status, which was not tested end-to-end.

3. **Cloud sign-in requires a real CodeForge Cloud endpoint.** The cloud endpoint manifest is not included in this working tree for a development checkout. A packaged production build would need the endpoint baked in.

4. **The git execCommand arg allowlist is broader than necessary** (GAP-4) — a theoretical concern, not an observed exploit.

5. **No agent task run in this audit session.** The autonomous coding E2E tests (which pass) prove the agent runtime works correctly against a mock provider. A real task on a real free model was not run.

These are the minimum gaps. There are no architectural, security, or product-coherence gaps that would make CodeForge fundamentally unsuitable for daily coding workflows on a supported Windows system where (1) a packaged build is produced from this state, (2) a cloud endpoint is reachable, and (3) at least one free provider route is live.
