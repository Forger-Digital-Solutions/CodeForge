# R16 Continuation Inventory

Recovered: 2026-09-19 (continuation agent)

## Starting state

- Branch: `forger-digital-solutions-forgegreen-certified`
- HEAD: `6c8191202274a65aca0674d9bed80ad1e9409d01` (`harden native release smoke evidence`)
- Working tree: 49 modified files + untracked R16 files. Most of the modification
  volume is CRLF normalization noise; `git diff -w` shows ~1489 real insertions /
  274 deletions plus new files.
- All touched packages typecheck clean (`tsc --noEmit` per package + desktop).

## Prior R16 work found (verified by reading diffs, not assumed)

### Server / runtime (real, substantive)

- `packages/protocol`: `RunFailure`/`RunOutcome` schemas, `run.outcome`,
  `execution.requested`, `execution.start_failed`, `turn.paused/resumed/recovery`,
  `eightbit.status`, `turn.started.origin` (`user|workflow|repair`), attachments
  (`SendAttachment`, `composeMessageWithAttachments`, `splitMessageAttachments`).
- `packages/server/src/run-failure.ts` (NEW): `describeRunFailure` — ownership-aware
  failure classification (`managed_free` never says "your API key"; `byok` does).
- `agent-runtime.ts`: emits `run.outcome` for standalone turns, `routeExhausted`
  flag, `persistSessionOutcome`, `emitEightBitStatus` incl. `ROUTE_COOLDOWN`.
- `workflow-service.ts`: `emitRunOutcome` on terminal, `sessionIdentity` preserves
  title/taskTitle, repair-context message builder, terminal stop handling.
- `workflow-engine.ts`: `AgentExecutionResult.failure.terminal` → `stopTerminally`
  (route exhaustion ends run truthfully; no fake verify/repair).
- `index.ts`: `workspacePath` session binding + `WORKSPACE_MISMATCH` 409,
  `outcome` on session records, `execution.requested`/`start_failed` events,
  provider health cache.
- `eight-bit`: bounded same-route retry incl. short rate-limit waits + `onWait`.
- `sessions`: `SessionRecord.outcome` + migration 3; event-store re-sequencing
  for seq-collided histories.
- `providers/hosted.ts`: bounded control requests, compatibility verdict caching
  (unreachable NOT cached — offline start can recover), inference stream unbounded.
- `desktop/main.ts`: `cloudFetch` timeouts, cloud-account fast path (2.5s),
  non-blocking adapter registration, renderer crash recovery (limit 3),
  `build-identity.json` stamped at build + exposed via `app:getSystemInfo`.

### UI (partially wired)

- `run-lifecycle.ts` (NEW, 621 lines): canonical `RunState` reducer
  `deriveRunLifecycle(events, ctx)` + `presentRun` projection + `presentSessionSummary`.
  **ORPHANED — nothing imports it.** This is the gap this continuation closes.
- `error-copy.ts` (NEW): extracted `humanizeError`/`describeTurnStop`; still contains
  a "your API key" fallback string for unclassified raw errors (classified failures
  now bypass it via `RunFailure.message`).
- `workspace-sse.ts`: attachments in send path; `deriveRestoredRunState` (record-based
  terminal restore; now redundant with `lifecycleFromSessionRecord` but harmless).
- `timeline.ts`: `turn.failed/cancelled/completed`/`execution.start_failed` rows;
  workflow-turn dedupe.
- `Composer.tsx`: text-only attachments with honest notices (images refused).
- `WorkspaceApp.tsx`: workspace-scoped session list filter; `humanizeError` moved.

### Installer / packaging

- `extraMetadata.author` → `{ name: "CodeForge Team" }` (was string).
- node-pty `files` filter: win32-x64 prebuilds only, no .pdb, Release .node/.dll/.exe
  + conpty only.
- `installer.nsh` + `uninstallDisplayName: "CodeForge"`.
- `audit:build-identity` script + `check-renderer-sources` (stale-renderer guard).
- New installer already built: `CodeForge-Setup-0.4.0.exe`
  SHA-256 `3707FBB3AC765E5EBE77D913E9BEB9C74E6002AE085B6B7AF62E5D6D71BB06F1`.
- Lifecycle audit (install/upgrade/uninstall/reinstall) exists at
  `12-upgrade/lifecycle-audit.md` — mostly PASS.

### Native harness

`tools/native-product-audit/` exists: PS module + install/launch/lifecycle/
network-fault/resilience/window probes, CDP driver, scenarios, README.

## Defects still open (found during recovery)

1. `run-lifecycle.ts` not imported anywhere → UI still runs on the legacy
   per-event field mutations (`isRunning`, `agentStatus`, `activePhase`) that
   produced FAILED+Working contradictions. **Wiring is the next task.**
2. `workflow-service.ts` `resumeHostedWorkflow` (~line 1424): `upsertSession`
   unconditionally sets `title`/`taskTitle` from the resumed execution `message`
   (repair continuations carry the "Continuing the same task…" context blob) —
   a remaining task-identity corruption vector. Other upserts preserve title.
3. Sidebar rows use `humanizeSessionStatus` (status-only) — `outcome` is not in
   `NavSessionSummary`/`SessionSummary`, so "No free route" vs "Failed" cannot
   be distinguished in the list.
4. `humanizeError` still contains the "your API key is invalid" line — only safe
   because classified `RunFailure.message` now bypasses it; keep as last-resort
   fallback or narrow it.
5. `deriveRestoredRunState` overlaps `lifecycleFromSessionRecord` (harmless dup).

## Unverified areas

- Whether packaged install metadata (publisher/CompanyName) is now correct in the
  real installed registry/exe — the prior agent rebuilt but the metadata-verify
  evidence was not located.
- node-pty post-filter package size delta — not measured yet.

## Resolution (2026-09-19, artifact E118C8E2)

All five open defects are closed and verified on the installed product:

1. `run-lifecycle.ts` wired through `useWorkspaceSSE`; every surface reads the
   canonical projection. 18 invariant tests green.
2. Resume/repair title preservation fixed in `workflow-service.ts`; pinned by
   `task-identity.test.ts`.
3. Session summaries carry `outcome`; Navigation distinguishes "No free route"
   from "Failed".
4. `humanizeError` credential wording neutralized for unknown-ownership errors;
   structured `failure.message` is preferred everywhere.
5. `deriveRestoredRunState` left as harmless fallback (canonical restore path
   takes precedence).

Both unverified items resolved: registry publisher `CodeForge Team` verified
natively (install audit `upgradePublisher` PASS); node-pty payload measured
62.6 MB → 3.7 MB.

Additional defect found and closed this session: the desktop build never
rebuilt workspace packages, so signed artifacts shipped stale `packages/*/dist`.
`build` now runs `tsc -b` first and the packaged-internal-dependency audit
fails on stale or byte-divergent `dist`.

Final verdict and evidence index: `../R16-FINAL-REPORT.md` —
`CODEFORGE_R16_DESKTOP_PRODUCT_CERTIFIED = YES`.
