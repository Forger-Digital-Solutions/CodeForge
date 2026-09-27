# R48 Final Report — Production Role-Aware 8-Bit / 16-Bit Runtime

## Result

R48 converts the R47 routing and qualification substrate into a production
per-role runtime:

- 8-Bit sends role evidence into both route ranking and Free Fabric admission.
- 16-Bit resolves `paid-auto/auto` to a qualified canonical model per role and
  rotates only inside the paid roster.
- ForgeVerify prefers a reviewer from a physical pool distinct from the
  implementer and records the selected pool in results and journals.
- Queued free capacity triggers one bounded wait/re-decision, not false waiting
  or instant false failure.
- Provider stream identity, parallel tool calls, reasoning headroom, and partial
  execution-budget handling are closed end-to-end.

The completion and billing boundaries remain unchanged: no incomplete mission
was reported complete, free runs never escaped to paid supply, and paid calls
required explicit campaign authorization plus ledger reservation.

## Live evidence

### E3 — 16-Bit: complete

`scripts/r48-paid-mission.mjs` ran with `CODEFORGE_16BIT_CAMPAIGN=1` and a hard
$0.25 authorization:

- Explorer denied with `NO_QUALIFIED_ROLE_ROUTE` before spend.
- Coder completed via `qwen3.8-flash:openrouter`.
- Reviewer completed via `glm-5.3-flash:openrouter`, a different physical pool.
- The exact frozen implementation artifact passed ForgeVerify (1/1 focused
  test); the completion gate returned `completed` with no blockers; integration
  committed the same tree ForgeVerify authorized.
- The durable ledger committed **$0.008722** (3.49% of cap), with 12 provider
  receipts and no outstanding reservation.
- Requested canonical, physical route, provider model, provider-reported served
  model when available, execution certainty, role decision, and journal state
  are persisted in `R48-16BIT-ROLE-MISSION.json`.

The first script version captured and then removed its temporary mission
workspace before deterministic verification. Closure therefore reconstructed
the exact frozen `mathFile` plus the script-defined test fixture and issued
**zero additional provider calls**. `verificationSource` records this mode.
The mission script now performs ForgeVerify, completion gating, and
tree-identity-checked integration inline for future runs.

### E2 — 8-Bit: machinery proven; end-to-end completion supply-blocked

`scripts/r48-free-mission.mjs` restored 10 durable role receipts and exposed 170
routes across 136 physical pools. Live runs proved:

- QUALIFIED Explorer execution on managed Groq `gpt-oss-20b`.
- PROBATION Explorer execution on managed Groq `gpt-oss-120b` when qualified
  supply was exhausted.
- Coder completion on managed Groq `qwen/qwen3.8-27b` after stale-reset
  re-decision.
- Correct owner/dev exclusion, Mistral data-consent exclusion, quota reason
  codes, and `next_available` evidence.
- No work promotion when reviewer/verification could not execute.

Repeated bounded attempts did not produce one complete
Explorer→Coder→Reviewer→verification mission. Groq was the only admissible
provider at run time; Explorer activity consumed the shared free-tier window
before Coder/Reviewer, and the final attempt ended on a real provider fetch
failure after five Coder requests. This is recorded as **blocked**, not success.

## Defects found by live execution

1. A partial execution budget replaced the entire role default, leaving
   `maxContextTokens` undefined and producing a `NaN` context limit. The runtime
   now merges partial overrides over defaults.
2. Subagent admission treated `QUEUED_FOR_CAPACITY` as immediate failure. It now
   waits/re-decides once inside a bounded horizon, immediately re-decides stale
   resets, fails closed on distant resets, and never waits on hard denial.
3. The broad sweep exposed stale scripted providers broken by R44's
   read-before-write guard. Fixtures now read existing files and supply the
   observed hash before editing; no production gate was weakened.

## Regression position

- Server: **876 passed / 3 skipped / 2 failed**. Both failures reproduce at the
  R47 baseline `d4769e8`; they are not R48 regressions.
- Touched packages: **596 passed / 2 skipped**.
- Role routing: **18/18**.
- Paid role routing: **9/9**.
- Free Fabric: **36/36**.

The intentionally excluded regenerated artifact
`docs/evidence/r34-capacity-efficiency/context-efficiency-benchmark.json`
remains uncommitted.

## Spend accounting

- R47 campaign committed: `$0.021986`.
- R48 campaign committed: `$0.008722`.
- Known cumulative paid evaluation spend through R48: **`$0.030708`**.
- R48 unreceipted spend: `$0`; outstanding reservation: `$0`.

## Certified source state

- Prior: `r47-16bit-first-light-v1`
  (`499bc26c2afd7784c12b9ae8e432b9add24f97ff233c4b660dfadb6f2b34ada5`)
- R48: `r48-role-aware-runtime-v1`
  (`9012e79edc1ae0dfd626a0eb44ab9c2ba352b739f50fa3758efd5b2e4097a709`)
- Guarded material changes: `packages/agent/src/index.ts`,
  `packages/server/src/agent-runtime.ts`,
  `packages/server/src/autonomous-orchestrator.ts`, and
  `packages/server/src/model-execution-adapter.ts`.

## Residual risk

The remaining release proof is operational, not a reason to relax any gate:
rerun E2 when enough qualified free capacity exists concurrently for Explorer,
Coder, and Reviewer. Until that happens, R48 must not claim a completed
end-to-end free live mission.
