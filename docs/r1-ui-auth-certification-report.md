# CodeForge R1 UI/auth certification report

## 1. Verdict

The repository-owned R1 packaged UI harness is green:

- `PRODUCT_PASS`
- `HARNESS_PASS`
- `EXTERNAL_EVIDENCE_UNAVAILABLE`
- `USER_AUTHORIZATION_REQUIRED`

The first two statuses are evidence-backed engineering results. The latter two are explicit
boundaries: this run did not pretend that a repository harness was independent third-party
evidence or that a real OAuth consent flow had completed.

## 2. Scope and preservation

The work was performed on branch `feat/codeforge-cloud` at the existing dirty worktree. No reset,
stash, clean, remote write, or unrelated checkout was used. The inherited worktree was preserved.

## 3. Packaged artifact

The tested artifact is the fresh unpacked Electron build at:

`apps/desktop/release/win-unpacked/CodeForge.exe`

Electron `33.4.11` loaded the packaged `file://` renderer, not a dev server. The harness uses an
isolated user-data directory and correlates evidence with a per-run UUID.

## 4. Evidence harness

The CodeForge-owned harness is implemented in `apps/desktop/src/main.ts` and
`apps/desktop/scripts/packaged-smoke.js`. It uses real Electron renderer operations:

- `webContents.capturePage()` for PNG evidence;
- renderer DOM inspection and input dispatch;
- the renderer's HTTP workflow surface for task, steer, approval, and terminal state;
- actual size changes and persisted native window state;
- a sanitized in-app account fixture, gated to packaged certification mode only.

The one-command runner is:

```text
node apps/desktop/scripts/r1-ui-certification.mjs
```

It runs `r1`, `r1-restart`, and `r1-account`, preserves per-mode logs, and writes a
machine-readable report to the ignored `release/r1-ui-certification.json` path.

## 5. UI state matrix

| State | Result | Evidence |
| --- | --- | --- |
| signed-out welcome | PASS | `01-signed-out.png` |
| idle workspace | PASS | `02-idle.png` |
| model picker at 1024x700 | PASS | `03-model-picker-1024x700.png` |
| model picker at 1280x800 | PASS | `04-model-picker-1280x800.png` |
| size matrix 1024x700, 1280x800, 1440x900, 1920x1080 | PASS | `05-size-matrix-1920x1080.png` |
| active run/tool activity | PASS | `06-active-run-tool-activity.png` |
| approval pending | PASS | `07-approval.png` |
| queued steer | PASS | `08-queue-steer.png` |
| completed workflow | PASS | `09-completed.png` |
| fail-closed paid selection | PASS | `10-failure.png` |
| signed-in sanitized account fixture | PASS | `11-signed-in-sanitized-account.png`, `12-signed-in-workspace-account.png` |
| restart/window restore | PASS | `13-restored-window.png` |

## 6. Model picker and responsive behavior

The picker was opened through the real renderer, verified to contain multiple options, checked for
bounded scrolling and no page overflow, and closed through the keyboard path. The size matrix
asserted the composer, model trigger, ForgeZero indicator, and keyboard contract at all four
viewport sizes.

## 7. Workflow and approval behavior

The harness started a real local workflow against an intentionally incorrect `src/calc.ts`, waited
for active/tool state, observed a pending `execute_plan` approval, submitted a bounded steer through
the actual API, resolved the approval through the actual approval endpoint, and waited for the
terminal `completed` phase. The wrapper also verified that the edited file contains `a + b`.

## 8. Failure behavior

The harness selected a paid fixture without entitlement and sent a chat request. The UI rendered a
ForgeZero violation banner and the run failed closed. No paid inference or local LLM inference was
used.

## 9. Restart and persistence

The first R1 run persisted normal bounds as `1280x800`. The restart mode loaded the same isolated
profile and asserted the restored native window dimensions before capturing evidence.

## 10. Account/auth boundary

The account run exercises the app-owned sanitized account projection with a deterministic fixture:
display name, free plan, active status, and credit balance. The renderer showed the account header
without receiving raw credentials. This is a product-owned account projection test, not a claim that
an external identity provider consent flow occurred.

## 11. OAuth status

App-owned auth code, redirect, PKCE, and desktop bridge tests remain green. A real provider consent
flow was not initiated because it requires a user-controlled account and authorization. Its status is
therefore `USER_AUTHORIZATION_REQUIRED`, not a fabricated pass.

## 12. Security boundary

The R1 smoke evidence confirms that the renderer does not expose
`window.electronAPI.getProviderCredentials`, and the smoke wrapper rejects test-secret leakage.
Credential access remains host-owned and sanitized.

## 13. Evidence integrity

The wrapper rejects stale log content by slicing from the pre-launch log offset, requires the current
run UUID, requires packaged-app evidence, rejects the dynamic test secret, and rejects
`PACKAGED_SMOKE_FAILED`. Screenshots and mode logs are written under the isolated release evidence
directory and are not source-controlled build inputs.

## 14. Focused validation

The final focused suite passed:

```text
Test Files: 11 passed (11)
Tests: 104 passed (104)
```

It covered FG-7, FG-6, model selection, application/window/preload/CSP/account layout, cloud auth,
GitHub app auth, and OAuth PKCE.

Direct validation also passed:

- `tsc -p packages/forge-green/tsconfig.json --pretty false`
- `tsc -p apps/desktop/tsconfig.main.json --pretty false`
- `git diff --check`

The repository `npm` shim was unusable in this environment because its configured npm CLI module
was missing, so equivalent local binaries were invoked directly. Packaging was completed with the
repository's Electron Builder binary.

## 15. Semantic status separation

The runner records product and harness status independently. External evidence is not inferred from
the local harness. OAuth authorization is not inferred from a fixture. This keeps a product failure,
a harness failure, a missing independent reference, and a required user action distinguishable.

## 16. Third-party comparison boundary

The comparison is directional rather than a certification claim. Current official product material
describes OpenAI's Codex app as a multi-task command center with parallel agent threads and worktree
support; Anthropic documents Claude Code as a development-machine coding tool; Devin documents an
embedded IDE, shell visibility, take-over, visual QA, and API/automation workflows. CodeForge's R1
evidence specifically closes its own desktop observability gap: real packaged UI captures, model
picker checks, approval/steer/completion/failure states, and sanitized account projection.

## 17. ForgeGreen continuation

FG-7 was materially advanced in `packages/forge-green/src/coverage-authority.ts`. It evaluates
current identity-bound evidence against every hard obligation, distinguishes missing, failed, stale,
and incompatible evidence, accepts only structured producer claims, and keeps optional uncovered
obligations visible without downgrading complete required coverage.

FG-7 deliberately does not replace ForgeVerify, FG-5 sufficiency, permission/approval decisions, or
`evaluateCompletion`. Its remaining integration seam is attaching the receipt to durable verification
evidence and diagnostic projections without weakening Completion Gate authority.

## 18. Reproducibility artifacts

The source-controlled repro entry point is `apps/desktop/scripts/r1-ui-certification.mjs`. The local
run produced 13 PNG captures and three per-mode result logs under `apps/desktop/release/r1-ui-evidence`.
The release directory is generated output and is not part of the source change set.
