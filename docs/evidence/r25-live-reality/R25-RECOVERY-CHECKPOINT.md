# R25 Phase 1 — Forensic Recovery Checkpoint

Date: 2026-09-21 · Branch: `forger-digital-solutions-forgegreen-certified`

## Repository state (captured, not assumed)

| Item | Value |
|---|---|
| Branch | `forger-digital-solutions-forgegreen-certified` |
| HEAD | `2d61c9481ace2f4fde51f78cbc43a7f11e1f13b9` — "R24 final checkpoint: evidence freeze — certified source-state recertified to r24-free-fabric-runtime-v1" |
| Expected R24 chain | `555d98e` → `31f30ee` → `fd10e9b` → `00bf295` → `c2975b3` → `2d61c94` — **all present, in order** |
| Staged / unstaged | none |
| Untracked | `.playwright-mcp/` (browser-MCP console logs; content is gitignored) |
| Stash | `stash@{0}: On forger-digital-solutions-task-fix: preserve task-fix forgegreen work` — touches `packages/router` (drops `@codeforge/director` dep, +55 lines in `index.ts`). **Preserved untouched.** |
| Product version | `0.4.0` (root `package.json`; all workspaces aligned) |
| Toolchain | Node `v24.19.0` (`node:sqlite` available), npm `11.17.0`, Docker `29.7.2`, no Postgres listening (provisionable via `scripts/setup-local-pg.mjs` → WSL2 Ubuntu Postgres 16, or Docker) |
| Build | `npm run build` clean across all 45 packages + desktop + web + cloud-api at HEAD |
| Canonical tests | R24 record: 3472 pass / 4 fail / 48 skip — **re-running now for R25 truth** |

## R24 verdict confirmed

`docs/evidence/r24-free-fabric/R24-FINAL-CHECKPOINT.md` at HEAD carries
**`R24_FREE_FABRIC_RUNTIME_CLOSED`**. Its stated limits are the R25 work queue: no
live-provider evidence, mechanism-level (not production) ForgeGreen savings, no durable queue,
no semantic-correctness gate, qualification is a snapshot.

## Runtime / provider configuration

- `PROVIDER_DEFINITIONS` (packages/model-registry/src/provider-definitions.ts): 27 provider
  definitions. Zero-cash classes only may route: `FREE_API`, `FREE_DAILY_ALLOCATION`,
  `FREE_MONTHLY_ALLOWANCE`, `FREE_ACCOUNT_ENTITLEMENT`.
- Credentials present in this environment (names only, values never read into evidence):
  `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `CLOUDFLARE_API_KEY`,
  `CLOUDFLARE_ACCOUNT_ID`. Absent: `ZAI_API_KEY`/`ZHIPU_API_KEY`, `GITHUB_TOKEN`, `DATABASE_URL`,
  all other provider keys.
- Spillover pre-flight read: **OpenRouter `FREE_API`/`NONE`** — `:free` routes are $0 unit-priced
  (verifiable live). **Groq, Gemini, Cloudflare: `ACCOUNT_DEPENDENT`/`attestation`** — usable only
  under the R23 precedent (owner free-plan accounts, bounded volume, $0 ledger) or skipped.
- Cloud config: `render.yaml` — staging cloud-api on Render free plan, `autoDeploy: false`,
  Postgres via `DATABASE_URL` (Neon/Supabase), no DB provisioned by the blueprint. `Dockerfile.cloud`
  runs compiled dist, non-root.

## Evaluation infrastructure found (do not rebuild — reuse)

| Asset | Location | Purpose |
|---|---|---|
| Paired-arm task engine | `packages/forgegreen-campaign/src/r23/run-task.ts` (`runTaskArm`) | Real task → `createAgentRuntime` / `createAutonomousRunOrchestrator` → recording adapter → `evaluateCompletion` → hidden verifier → validated `RunRecord` |
| Arm configs + tripwire | `packages/forgegreen-campaign/src/r23/arms.ts` | CONTROL (all off, single agent) vs OPTIMIZED (all on, adaptive topology) |
| Frozen corpus | `benchmarks/r23/` — 15 tasks, sha256 manifest, deterministic generator | bug_fix, feature, investigation, small_fix, refactor, build_config, large-context |
| Campaign runner | `scripts/r23-efficiency-bench.mjs` | freeze/prescreen/probe-gate/qualify/pilot/main; dirty-tree refusal; §6.3 daily-allowance gate |
| Live fleet qualification | `scripts/managed-free-live-certification.mjs` | env credential → live catalog → `runCompactQualification` → evidence JSON (no secrets) |
| Full-stack live loop | `scripts/codeforge-r5-groq-real-agent-loop.mjs` | `CodeForgeServer` + ForgeRouter + ForgeZero + `evaluateCompletion` over HTTP/SSE |
| Role protocols | `packages/eight-bit/src/qualification/role-suite.ts` (`runRoleAwareQualification`, `R24_ROLE_QUALIFICATION_V1`) | compact 3 probes + 10 role cases |
| Postgres admission harnesses | `scripts/r20-postgres-{admission-benchmark,multi-instance,multiprocess-admission,remote-cancel}.mjs` + `npm run test:postgres*` | durable admission proof (Phase 6) |
| Scale sim | `scripts/r20-scale-campaign.mjs`, `packages/benchmark/src/r20-scale.ts` | multi-user fairness (Phase 9) |

## R23 live precedents (the honest baseline)

- OpenRouter key observed `usage: 0`, `is_free_tier: false` — `:free` is $0 by unit price.
- Groq ran on the owner free plan; ~9.4% malformed tool calls on gpt-oss-20b → R23 `winner: null`.
- Cloudflare was attestation-blocked (plan unreadable); credentials exist now — plan still must be
  established before use.
- Gemini returned 403 in R23; `ACCOUNT_DEPENDENT` — billing-enabled projects are charged.
- Live paired ForgeGreen never ran in R23: "~1M tokens; no free bucket fits." R25 sizes the live
  subset to measured quota rather than repeating the full corpus.

## Recovery verdict

`R25_RECOVERY_CLEAN` — R24 freeze confirmed at HEAD; tree clean; build green; credentials for 4
live providers present; all required harnesses located. No reset performed; nothing differed from
the handoff that required investigation beyond the recorded stash (preserved).
