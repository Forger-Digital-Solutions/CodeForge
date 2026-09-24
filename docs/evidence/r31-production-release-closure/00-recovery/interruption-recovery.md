# R31 Interruption Recovery Record

Recorded by the continuation agent after the previous R31 agent stopped on usage exhaustion.

## Recovered state

- Branch: `codex/r29-release-closure`
- HEAD: `fe4248c4c8dc664ef88cdb80acf5e91ae99961fb` (R30 freeze commit — no commits yet in R31)
- Working tree: dirty (uncommitted interrupted work), plus untracked R31 harness + evidence

### Modified files (verified by diff inspection)

| File | Delta | Content |
|---|---|---|
| `packages/providers/src/capacity-governor.ts` | +5 | `streamChat` catch: thrown `ProviderError` with `status===429` now calls `governor.recordRateLimit(providerId, error.retryAfter)` before rethrow; `finally` still releases the reservation |
| `packages/providers/test/capacity-governor.test.ts` | +29 | New test: thrown stream 429 → 9s cooldown recorded, reservation released (activeConcurrent/inFlightTokens back to 0) |
| `packages/server/src/workflow-service.ts` | +43/-6 | `waitForTurn` returns `workingMs` and treats `blocked` as terminal; `executePlan` grants **one** recovery turn when a turn fails/blocked on `AGENT_NO_PROGRESS_DETECTED`/`AGENT_TOOL_LOOP_DETECTED` **after** files changed; recovery turn gets remaining working budget; completion still requires verification + completion gate |
| `scripts/security/secret-scan.mjs` | +30/-7 | Findings now carry `lineSha256`; allowlist entries may pin `line` + `lineSha256`; self-test asserts a tampered fixture line is not allowlisted; emitted report strips line hashes |
| `scripts/security/secret-scan-allowlist.json` | +77/-1 | Ten line-hash-pinned fixture entries (R28 review-status findings) |

### Untracked R31 artifacts

- `benchmarks/r31/`: `live-workflow-completion.mjs`, `summarize-live.mjs`, `verify-inherited-evidence.mjs`, `freeze-evidence.mjs`, `packaged-endurance.mjs`, `install-lifecycle.ps1`, `signing-readiness.ps1`
- `packages/server/test/workflow-loop-recovery.test.ts` (3 tests)
- `docs/evidence/r31-production-release-closure/`: `00-recovery/inherited-baseline.json`, `02-large-task-reliability/r30-failure-taxonomy.json`, `09-security/` (6 files), `10-lifecycle/preflight.json`, `12-signing/readiness.json`

## Verified claims

| Previous-agent claim | Result |
|---|---|
| R30/R29/R28 freezes intact | VERIFIED — `inherited-baseline.json`: R28 52/52, R29 38/38, R30 48+4 artifacts, all hashes match; R30 artifacts match receipt |
| Streamed-429 cooldown fix | VERIFIED by inspection + tests — `recordRateLimit` treats `retryAfter` as an absolute epoch-ms timestamp (consistent with `openrouter.ts` `retryAfterFrom`); `Math.max` makes duplicate recording idempotent; reservation release stays in `finally`; non-streaming `chat` already had the symmetric catch; the in-stream `error` event path (line 607) also pre-existed |
| 18/18 focused tests | VERIFIED — `vitest run test/capacity-governor.test.ts`: 18/18 pass |
| Loop-recovery (not previously reported) | VERIFIED — `workflow-loop-recovery.test.ts` 3/3 pass: recovery turn fires once after a real edit and the run completes through verification + gate; no-edit loop stays `blocked`; second loop stops after one continuation |
| Secret-scan findings resolved | VERIFIED — `secret-scan.json` status PASS, 0 owner-review-required; allowlist entries pinned to exact line SHA-256 |

## Unverified / noted

- `packages/server/dist` predates the `workflow-service.ts` change — rebuild required before any packaged run.
- No surviving benchmark/agent processes found (8 `node.exe` processes are Devin/VS Code infrastructure, not CodeForge runs — confirmed no r31/r30/benchmark command lines).
- Lifecycle preflight evidence shows execution was refused: current identity `CodexSandboxOffline` lacks the disposable-profile marker; folders resolve to `C:\Users\Daddy_FDS`.
- Signing readiness: all three R30 artifacts `NotSigned`; negative gate verified (verifier exit 1). No code-signing cert on this machine → likely external blocker.
- Provider credentials present in environment: OPENROUTER, GROQ, GOOGLE, MISTRAL. Absent: Cloudflare, ZAI, Cohere, GitHub token.

## Recovery decision

**Continue, do not reset.** All inspected interrupted work is sound: the 429 fix matches the
non-streaming precedent, the loop recovery is bounded (one turn, remaining budget, still gated),
the harness hardens rather than weakens acceptance (hidden verifier + answer key + gate outcome
all required; failed attempts persist as receipts; summary counts every receipt), and the secret
scan upgrade resolves the ten inherited review findings without hiding new ones.

## Inherited active targets (unchanged)

1. Post-edit stall → loop detection → workflow now gets one bounded recovery turn (implemented, tested; needs live proof).
2. Semantic verification gap: visible checks passed while independent verifier failed (feature/refactor/rename classes). **Not yet addressed** — remains open.
3. Rate-limit recovery end-to-end: streamed 429 cooldown is fixed; needs a live injected-429 run.
