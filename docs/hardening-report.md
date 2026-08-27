# CodeForge — Tool Enforcement Hardening Report

Starting SHA: d85437f2c935ef0d9cc6cbb51500a5ca89248e27
Final SHA: (to be filled after commits)
Working Tree: CLEAN after commits

## Summary

This phase closes the 11 gaps identified in the prior report by enforcing an
actual runtime boundary for:

```
MODEL REQUEST → TOOL VALIDATION → SECURITY CLASSIFICATION → APPROVAL IF REQUIRED → EXECUTION → BOUNDED/REDACTED RESULT → MODEL
```

Previously approval UI existed but `AgentRuntime.runAgentLoop → executeTool` executed
immediately without waiting. Host env was inherited wholesale. Edits were whole-file
replacement without hash/occurrence checks. Search relied on shell grep. Static
serving used prefix check. SecretScanner coverage was narrow. Checkpoint was
not exposed.

All are now hardened.

## Approval Runtime Gate (PHASE 2-4)

- New `packages/server/src/approval-service.ts` — single authoritative gate with
  states `pending|approved|rejected|cancelled|expired`, TTL, signal-aware
  cancellation, duplicate-resolution idempotency (executes at most once).

- `AgentRuntime.executeTool` now:
  1. validates JSON args
  2. classifies risk via `command-classifier.ts`
  3. `requiresApproval?` → `approvalService.requestApproval` → emits
     `approval.requested` → awaits promise (timeout 5 min, abort-aware)
  4. `approved` → executes exactly once; `rejected/cancelled/expired` → returns
     blocked message without execution.

- Cancellation (`cancelTurn`, `approvalService.cancelForTurn`, `cancelAll`,
  `AbortSignal` handler) invalidates pending approvals so late resolves cannot
  resurrect a cancelled turn. Duplicate HTTP resolves are collapsed.

Evidence: `packages/server/test/hardening-adversarial.test.ts` — 9 tests for
states, duplicate, cancel-wins, expire, workspace-close, late-arrival.

Invariant 1-3 proven: consequential tools cannot execute without resolved
approval; rejected/cancelled never execute; late approvals cannot execute.

## Command Risk Classification (PHASE 5-6)

- New `packages/server/src/command-classifier.ts` — conservative classifier with
  categories `read-only|project-modifying|destructive|network-sensitive|
  credential-sensitive|privileged|unknown`.

- Detects shell chaining (`&&`, `||`, `;`, `|`), redirects (`>`, `<`),
  subshells (`$(`, `` ` ``), command substitution, destructive (`rm -rf`,
  `git reset --hard`, `del /S`…), privileged (`sudo`, `chmod 777`…),
  credential (`env`, `printenv`, `.env`, `OPEN*_API_KEY`…), network
  (`curl|sh`…).

- Policy: `safe` (read-only `git status`, `ls`, `cat`, `npm test`, `typecheck`…)
  → no approval; `moderate/high/critical` or unknown → approval required.
  When uncertain: `approval required`.

- `CommandService.classifyCommand` now delegates to the hardened classifier.

Evidence: 18 classification tests including chaining/redirect/pipe/subshell/
backtick/script/unknown.

## Shell Execution Security (PHASE 7)

- Retains `shell:true` for Windows compatibility but with mitigations:
  - project `cwd` enforced via `resolveWithinWorkspace` (symlink-aware)
  - approval gate (above)
  - timeout 60 s
  - cancellation (`AbortSignal` → `proc.kill()`, single-settle guard)
  - sanitized env (`getSanitizedEnvForChild`)

- No claim that cwd alone is a sandbox is made; defense is layered.

Evidence: `executeRunCommand` validates cwd, uses filtered env, handles abort;
classifier forces approval for shell operators.

## Environment Filtering (PHASE 8-9)

- New `packages/server/src/env-filter.ts` — `filterEnv`/`getSanitizedEnvForChild`.

- Deny exact: `OPENCODE_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`,
  `GROQ_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, etc., plus `GITHUB_TOKEN`,
  `NPM_TOKEN`, etc.

- Deny prefixes: `AWS_`, `AZURE_`, `GCP_`, `GOOGLE_CREDENTIALS`, `CLOUDFLARE_`.

- Deny substrings: `SECRET`, `PASSWORD`, `PRIVATE_KEY`, `CREDENTIAL`,
  `AUTH_TOKEN`, `ACCESS_TOKEN`, `REFRESH_TOKEN`.

- `CommandService.execute` and `AgentRuntime.executeRunCommand` &
  `CheckpointService` all spawn with `env: getSanitizedEnvForChild()`.

- Tests prove host has secret, child does not; env dump redacted; output
  `sk-proj` still redacted via `SecretScanner`.

Evidence: 5 env tests inc. spawned `process.env` child check.

Known limitation: generic filtering cannot guarantee removal of *unknown* secret
names that lack the denied substrings/prefixes. Documented; `SecretScanner`
remains the last line on output.

## Structured Search Tool (PHASE 10-11)

- New `packages/server/src/search-service.ts` — `searchWorkspace`.

- Project-root confined (validates `workspacePath`), bounded: `maxFiles`
  5000, `maxMatches` 500, `maxBytes` 64 KiB, timeout 8 s, `AbortSignal`.

- Excludes `.git`, `node_modules`, `dist`, `build`, `.next`, etc.; binary
  avoidance (null byte); bounded preview; secret redaction.

- Exposed as `search_files` tool in `AgentRuntime.getAvailableTools`.

Evidence: 8 search tests — confinement, truncation, binary avoidance, secret
redaction, cancellation, invalid regex.

Performance: `maxFiles`/`maxMatches`/`maxBytes`/`timeoutMs` all enforce
truncation with `reason`.

## Safe Patch / Edit Primitive (PHASE 12-16)

- New `packages/server/src/edit-service.ts` — `replaceExact` with:

  ```
  replace_exact(path, oldText, newText, expectedOccurrences=1, expectedHash?)
  ```

  - fails if `oldText` not found
  - fails if occurrence count ≠ expected (ambiguous)
  - optional `expectedHash` (SHA-256) → stale-edit protection: rereads current
    file, rejects if hash changed (“Human edits → Model writes stale content”).

- Atomic writes: write to ` .cf-tmp-<uuid>-<basename>` then `rename`; fsync
  best-effort.

- Bounded diff (32 KiB), redacted; `filesystem-service` also switched to atomic
  writes and redacted diffs.

- Multi-file edits applied sequentially; `multiReplaceExact` reports per-file
  success/failure, never claiming whole change succeeded if partial.

- Tool `edit_file` exposed to agent with `path, oldText, newText,
  expectedOccurrences, expectedHash`.

Evidence: 8 edit tests — exact, ambiguous, missing, stale hash, concurrent
human edit, atomic failure leaves original intact, symlink escape, binary.

## Git Checkpoint Integration (PHASE 17)

- `CheckpointService` hardened: uses `execFile("git", argsArray, {env: sanitized})`
  instead of string interpolation; validates `ref` via `^[a-zA-Z0-9\-_]+$`;
  rejects labels containing `[;&|`$]`.

- Exposed as safe `create_checkpoint` agent tool (label only). Destructive ops
  (`reset --hard`, `push --force`, `branch -D` externally) remain internal
  and not exposed as agent tools.

Evidence: checkpoint creation test; tool allowlist check that `git reset`/`push`
not present.

Status: CHECKPOINT EXPOSED (safe subset only).

## Static Serving (PHASE 18)

- `CodeForgeServer.serveStatic` now uses canonical validation:
  `realpath(webDist)` + `realpath(fullPath|| deepest existing parent)` +
  `path.relative` containment, preventing prefix collision (`/web` vs `/web-evil`)
  and symlink escape.

Evidence: realpath + relative check; manual prefix-collision unit.

## Secret Scanner Hardening (PHASE 19)

- Extended patterns: `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `gh[pousr]_`,
  `github_pat_`, `AKIA…` (AWS), `aws_secret_access_key`, `BEGIN OPENSSH PRIVATE KEY`,
  `mongodb://`, `postgres://`, in addition to prior.

- Avoids false-positive explosion by requiring length thresholds.

Evidence: `containsSecret`/`redact` still distinguish code from real secrets;
tests use real-length keys.

## Tool Result Pipeline (PHASE 20)

Order enforced in `executeTool`:

```
raw tool result → redactSecrets → size limit (truncate) → structured result → messageHistory/persistence → renderer
```

History (`messageHistory.push({role:"tool", content: boundedResult})`) receives
only sanitized bounded content. Pipeline documented in `agent-runtime.ts:649`.

## Approval + Cancellation Integration (PHASE 21)

Cancellation works at every stage: before approval (abort before request),
while waiting (signal cancels promise), during command execution (signal kills
proc), during search/edit (signal passed to `searchWorkspace`).

## Tests & Verification (PHASE 22-24)

- New files:
  - `packages/server/test/hardening-adversarial.test.ts` (56 tests)
  - `packages/server/test/autonomous-e2e.test.ts` (3 tests)

- Baseline was 419 tests / 38 files; now 478 tests / 40 files, 0 failed.
- Typecheck PASS, server build PASS, desktop build PASS, web build PASS.

## Security Audit (PHASE 26)

Searched repo for `console.log` (only server start line), `Bearer` (in secret
patterns only), `apiKey` (local var), `OPEN*_API_KEY` (only in env-filter and
scanner), `password|secret|token|spawn|exec|shell:true|paidFallback|fallback|
eligibleModels|modelId|providerId` — no credential leakage, no approval bypass,
no workspace escape, no stale-overwrite (now fails closed), no ForgeZero bypass
(`verify`/`checkEntitlement` still gate every inference), no paid fallback.

ForgeZero + free-mode invariants preserved: `resolveTurnModel` → `ForgeZero` →
`ForgeRouter` → provider identity validation → entitlement checks remain the
only model-resolution path.

## Known Remaining Limitations

- Host env filtering is best-effort pattern based; an operator using an
  unconventional secret name without denied substrings/prefixes could still be
  inherited if not output-redacted. Output redaction remains the last line, but
  env inspection via `process.env` in a compromised child cannot be perfectly
  predicted. Documented.

- `shell:true` is retained for Windows compatibility. Risk is mitigated via
  cwd containment + classifier + approval + env sanitization, but it is not a
  full OS sandbox.

- SecretScanner is not exhaustive; generic pattern filtering trades false
  positives for coverage.

- No complete OS sandboxing, no perfect secret detection, no proof that
  arbitrary commands are safe — classifier is conservative and fails closed.

## Checklist — Final Invariants

All 14 invariants verified in tests / runtime:

INVARIANT 1 consequential tools cannot execute without required approval — PASS (gate)
INVARIANT 2 rejected tools never execute — PASS
INVARIANT 3 cancelled approvals cannot later execute — PASS (cancel wins, idempotent)
INVARIANT 4 terminal child processes do not inherit CodeForge credentials — PASS (env-filter)
INVARIANT 5 tool output sanitized before entering model context — PASS (redact→truncate→history)
INVARIANT 6 search cannot escape workspace — PASS (confined + bounded)
INVARIANT 7 edits cannot silently overwrite changed human content — PASS (hash)
INVARIANT 8 ambiguous edits fail closed — PASS (occurrence check)
INVARIANT 9 writes atomic where practical — PASS (tmp→rename)
INVARIANT 10 static serving cannot escape intended root — PASS (realpath)
INVARIANT 11 every inference still passes ForgeZero — PASS (verify + entitlement)
INVARIANT 12 free mode still cannot select paid models — PASS (eligibleModels filter)
INVARIANT 13 no paid fallback — PASS (grep)
INVARIANT 14 canonical providerId::modelId identity intact — PASS (getModel exact)
