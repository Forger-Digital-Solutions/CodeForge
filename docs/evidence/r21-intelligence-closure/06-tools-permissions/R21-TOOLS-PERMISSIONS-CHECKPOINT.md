# R21 Tools + Permissions Audit Checkpoint (M6)

Recorded: 2026-09-20
Branch: `forger-digital-solutions-forgegreen-certified`
Spend: `$0` — deterministic tests only; no provider calls.

## What exists (verified)

- `ToolBroker` (`packages/tools/src/index.ts`): registry lookup, argument validation, role
  read-only enforcement, permission-flag checks, sensitive-path denial, workspace
  confinement (`resolveWithinWorkspace`), binary guards, hash-pinned edits, sanitized child
  env, output truncation + secret redaction on every result.
- `TaskAuthority` (`packages/permissions/src/index.ts`): deterministic tier classification
  (the model never self-classifies), read-only actor caps regardless of mode, grants that
  never cover Tier 3/4, Tier 3/4 always ask even under `full_autonomy`, receipts with
  source tracking, legacy-mode normalization that cannot widen.
- Interactive dispatch (`runAgentLoop` → `executeTool`): `describeAction` →
  `classifyCommand` → `authority().resolve` → deny / `gateWithApproval` ask → receipts.

## Defect found and closed

| # | Defect | Evidence | Fix |
|---|---|---|---|
| TP-001 | **The autonomous dispatch path was ungoverned.** `executeAgentRun`'s tool loop (the path every mission workstream, subagent, explorer, coder, reviewer, and delivery reviewer takes) called `toolBroker.executeTool` directly — flag checks only, no `classifyCommand`, no tier resolution, no receipts. Worse, the `network` permission field is declared `false` on every subagent/mission lease yet was enforced *nowhere*: a mission coder with `executeCommand:true, network:false` could run `git push`, `npm publish`, `curl … \| sh`, `ssh`, `printenv`, or `rm -rf` with zero escalation. The command classifier and external-effect predicate existed but were wired only into the interactive path. | direct trace of `agent-runtime.ts` executeAgentRun loop; `r21-autonomous-command-gate` (new, 11 cases) | Same classification now runs on the autonomous path before dispatch: `risk === "critical"` (destructive/privileged/credential — classes that require approval, which an unattended run cannot obtain) is denied outright; `network-sensitive` and externally visible commands (`isExternallyVisibleCommand`, now exported from `@codeforge/permissions`) are denied when the lease grants `network:false`. Denials emit a blocked event, a failed tool record, consume the command budget (retry-bounded), and mint no durable execution record. |

## Boundaries (honest)

- This is **deny-list classification**, not capability isolation — `run_command` still
  executes in the host process with a sanitized env and confined cwd. A command that
  reaches the network through a path the patterns don't name (e.g., `node -e
  "fetch(...)"`, `git -c protocol.ext...`) is not caught by regex classification. True
  egress isolation needs an OS-level sandbox — recorded as open hardening work, not
  claimed.
- `npm install`/`npx` are classified `project-modifying`, not `network-sensitive`, per the
  repository's own taxonomy — they remain allowed under `network:false` because missions
  legitimately install dependencies. That is a documented policy choice, not a gap in the
  fix; tightening it is a product decision.
- The hosted-worker path (`pendingTool` continuation) already resolves `TaskAuthority`
  before preparing execution — unchanged and still governed.
- The interactive `executeTool` path is unchanged: ask/approval semantics intact.

## Test evidence

| Suite | Result |
|---|---|
| `r21-autonomous-command-gate.test.ts` (6 external/network denies under `network:false`; 3 critical denies even under `network:true`; benign `node -e` still executes; denial mints no durable record) | 11/11 |
| `agent-security`, `agent-runtime`, `agent-tool-loop`, `agent-recovery`, `agent-turn-boundary` | 26/26 |
| `approval-session-grants`, `approval-lifecycle` (interactive ask/grant semantics) | 18/18 |
| `fg9-unsafe-mutating`, `fg1-duplicate-suppression`, `eight-bit-active-run-failover` | 18/18 |
| FG-11/FG-12E provenance canaries | green after `r21-autonomous-command-gate-v1` recertification |
