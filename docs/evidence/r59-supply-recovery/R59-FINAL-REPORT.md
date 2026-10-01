# R59 — Free Supply Recovery, Admission Reliability, No-False-Zero Capacity, Packaged Autonomy

## Objective

Make CodeForge reliably discover, admit, recover, rotate, and use genuinely available free
inference supply so an authenticated packaged user does not see an empty usable model pool
while legitimate free capacity exists — without fabricating availability, weakening
qualification, or treating rate-limited routes as healthy.

**Primary acceptance objective:** no false zero-capacity state while usable approved free
capacity exists.

## Final certified state

- Surface: `r59-free-supply-recovery-v13`
- Source-state ID: `20d8df1c910504c76355e82f25a002ca4050c844e4c491b62ef8e6362214a1b2`
- Material files: 96
- Packaged artifact: `apps/desktop/release/win-unpacked` at commit `0ccc313` (v13 source `10cf3200`)
- Packaged audits: internal deps PASS, runtime deps PASS, supply wiring PASS
  (`production-wiring.json`)

## Delivered fixes (v1–v13)

| Version | Fix | Commit |
|---|---|---|
| v1–v9 | Cooldown retry, exclusion ledger, bounded recovery, identity fix, per-provider qualification lanes, suite deadline, bounded capacity probes, declared-RPM probe pacing, denial-recovery loop, watchdog pre-flight liveness, cooled-lane liveEvidence, ms-duration reset parsing, empty-pool reset fallback | earlier R59 commits |
| v10 | Whole-window provider arbitration: over-limit estimated demand clamps to the declared window instead of permanent denial; binding-dimension denial horizons; recovery loop gated on live lanes before round one | `6ed8bbdc` |
| v11 | Serving-window context cap (`servingInputTokenCeiling` bounds assembled context by the smallest stamped input-token window among admissible routes); failover `awaitQualification` on `no_replacement`; landed-evidence re-decide in the recovery loop | `466725ac` |
| v12 | Wire-survival: planner capacity = repository slice + already-charged kernel (zero slice → kernel-only plan, not `CONTEXT_CAPACITY_UNKNOWN`); serialized-wire bound = raw serving ceiling, not the assembly budget | `9c0d9a5d`, cert `4ddf074a` |
| v13 | Workspace identity isolation (worktrees never alias parent `repositoryRoot`; missing worktrees marked `missing`; created worktrees verified materialized); checkpoint `--show-prefix` toplevel guard (nested dirs can never stash the enclosing repo); serving ceiling reads declared `limitTokens` only — mid-window `remainingTokens` no longer fabricates a ceiling | `10cf3200`, cert `0ccc3132` |

## Packaged dogfood progression (persistent profile `dogfood-profile-v10`)

| Run | Result |
|---|---|
| v11 dogfood | Explorer honestly denied; coder died pre-dispatch: `CONTEXT_CAPACITY_UNKNOWN` (228 kernel tokens vs 0 budget — planner contract violation) |
| v12 dogfood | Resolved stale worktree `wt-29040878` → checkpoint `git stash -u` resolved upward and attempted to sweep the enclosing repository (aborted on a locked profile file before damage) |
| **v13 dogfood** | Workspace resolved correctly (`ws-e2c88def`); base checkpoint created on the true toplevel; explorer cancelled honestly (no EXPLORER-qualified route); coder admitted `groq/gpt-oss-120b`, made **4 real provider requests** (18,379 in / 679 out tokens) and **3 real tool calls** — zero HTTP 413s; run terminated `blocked` on `AGENT_CONTEXT_BUDGET_EXCEEDED` when the transcript measured ~8,724 tokens against Groq's declared 8,000-token window |

## v13 dogfood verdict

Honest `blocked`, and the objective is demonstrated end-to-end on the packaged artifact:

- **No false zero-capacity**: real approved free capacity was found, qualified, admitted, and
  consumed (4 wire requests, 3 tool executions) instead of being denied at zero.
- **Serving-window sizing works**: every dispatched request fit the declared 8K window — the
  v11 8,904-token 413 did not recur; when multi-turn growth exceeded the window, the runtime
  failed closed *before* dispatch rather than sending a doomed request.
- **Workspace safety fixed**: the stale `wt-29040878` was bypassed; checkpointing ran against
  the real workspace toplevel; the enclosing repository was untouched
  (`cleanAtStart`/`cleanAtFinish` both true, `baselineHead` == `finalHead`).
- **Completion gate held**: no verification ran, no files changed → `blocked`, not `completed`.

## Residual (honest, not a defect)

- Groq free tier's 8K TPM window is genuinely too small for a multi-turn coding transcript;
  the run consumed all legitimately available capacity and stopped correctly. An OpenRouter
  lane with an unstamped/larger window never qualified (persistent provider 429 congestion),
  so no larger-window route was admissible to fail over to.
- The EXPLORER role remains unqualified on this fleet (groq-120b qualifies
  `PRIMARY_CODING_AGENT` only); the explorer's bounded wait cancels honestly.
- `statement has been finalized` warnings during checkpoint test restores are a best-effort
  event-persistence race in `SqliteSessionPersistence` — observed pre-existing on HEAD, not
  caused by this work.
- Pre-existing marginal test timeouts (checkpoint/worktree suites exceed 5s on this host)
  reproduce identically on HEAD; the v13 verify cache reduces spawn count vs HEAD.

## Evidence

- `production-wiring.json` — v13 packaged-supply audit receipt (PASS)
- `packaged-self-dogfood-v13.json` — v13 persistent-profile dogfood receipt
- `packaged-self-dogfood-v12.json` — v12 dogfood (stray-stash failure evidence)
- `packaged-self-dogfood.json` — v10/v11 dogfood evidence
- `live-supply-inventory*.json` — provider qualification/quota snapshots
