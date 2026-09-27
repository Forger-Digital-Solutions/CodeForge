# R50 Final Report — Runtime Quality Authority, Adaptive Role Routing, Tool-Safety Feedback

R50 turned real production outcomes into bounded, role-specific routing intelligence: a free
model that repeatedly fails a role is demoted **for that role**, a successful model recovers
bounded preference, capacity/transport failures never masquerade as model-quality failures,
and tool-safety violations produce durable role-scoped feedback that reaches later routing.
Quality stays subordinate to policy, health, safety, qualification, and capacity — it only
reorders candidates that already passed every hard gate.

## Answer to the R50 objective

> "A free model that repeatedly fails a role gets demoted for that role; a successful model
> recovers bounded preference."

Proven three ways:

1. **Deterministic replay** (`r50-quality-routing-replay.test.ts`, 6 cases): repeated
   tool-quality failures demote a qualified reviewer below a clean peer; a high-quality but
   capacity-exhausted route yields; a verdict-floor exclusion is never resurrected by runtime
   quality; verified successes recover a penalized model above a neutral peer; a
   poor-but-qualified sole candidate still admits; transient-capacity observations never
   enter the quality lane.
2. **Live before/after** (`R50-LIVE-8BIT-QUALITY-MISSION.json`): R49's recorded production
   outcomes were replayed through `hydrate` (identical to restart restore). CODER selection
   flipped `groq/gpt-oss-120b → openrouter/nemotron` on two `verified_complete` samples
   alone. Nemotron's EXPLORER/REVIEWER composite dropped −5 → −38
   (`ROLE_RUNTIME_NEGATIVE`, dominant class surfaced), yet stayed selected only where it was
   the sole qualified candidate — quality never manufactures supply.
3. **Long-horizon simulation** (`R50-LONG-HORIZON-SIMULATION.json`): 120 assignments across
   three evidence phases — a dominant route that degrades loses selections, recovers them on
   fresh verified work; a workspace-escape route is demoted then re-earns; 30 injected
   transient supply failures produced **zero** role-quality evidence
   (`transientSupplyNeverScores: true`).

## What changed

| Area | Change |
|---|---|
| `route-health-authority.ts` | `role_outcome` vocabulary (`verified_complete`, `converged`, `verification_failed`, `role_failed`, `security_blocked`, `budget_exhausted`) × `RoleFailureClass` (10 classes); graded weights (+1 / +0.5 / −0.75 / −1 / −1.5); per-correlation dedup; rolling-window decay; ±16 bound, full confidence at 4 samples; `roleQualityDelta()`/`roleEvidenceFor()`; snapshot/hydrate persistence; `CAPABILITY_LIMITED` on escape |
| `reliability.ts` / `types.ts` | `boundary_violation` tool outcome; double-weighted toward the malformed-quarantine streak (two escapes quarantine where four formatting slips would) |
| `agent-runtime.ts` | `recordRoleOutcome` accepts the full vocabulary + failureClass; producers for EMPTY_COMPLETION, MALFORMED_STRUCTURED_OUTPUT, REPETITION_LOOP, NON_CONVERGENCE, security blocks, budget exhaustion, convergence; `recordLocalToolOutcome` maps local tool rejections (unknown/malformed/escape/permission) to reliability evidence; runtime delta merged with receipt advice into one ±24 adjustment; bounded failover turn grant (`FAILOVER_TURN_GRANT_CAP = 2`); dominant-failure dedup — a run that already recorded a model-quality verdict does not stack a second `budget_exhausted` verdict on the same run |

## Live mission evidence — `R50-LIVE-8BIT-QUALITY-MISSION.json`

`status=completed`, 397.7s, gate `completed`, integration `integrated`, verified tree ==
integrated tree, `reviewerIndependent=true`, all served routes ForgeAuto-eligible, **$0**.

| Role | Served route | Pool | Outcome | Turns/Tools/Req | Failover | Post-run q |
|---|---|---|---|---|---|---|
| explorer | groq/gpt-oss-120b | managed:groq | converged_failed (`stopReason: cancelled` — watchdog, **no** quality verdict emitted) | 6/5/6 | nemotron→groq TEMPORARY_CAPACITY @0 calls | 0 (0 samples) |
| coder | groq/gpt-oss-120b | managed:groq | completed | 8/7/8 | nemotron-lightning→groq TIMEOUT @0 calls | +4 (2 samples) |
| reviewer | openrouter/nemotron-super | managed:openrouter | completed | 7/6/7 | — | −2 (4 samples, recovering from seeded −4) |

### Before/after routing (dry `decide()` through the real fabric)

| Role | Pre-seed | Post-seed | Read |
|---|---|---|---|
| CODER | groq/gpt-oss-120b | **openrouter/nemotron** | +2 verified_complete recovered nemotron past the incumbent — `ROLE_RUNTIME_POSITIVE` |
| EXPLORER | nemotron (−5) | nemotron (−38, `DOMINANT_NON_CONVERGENCE`) | demotion applied; sole better peer `gpt-oss-20b` was `CAPACITY_DENIED` — capacity, not quality, held the pick |
| REVIEWER | nemotron (−5) | nemotron (−38, `DOMINANT_CONVERGED` after security_blocked+escape) | sole REVIEWER-qualified route — quality demotes, cannot manufacture supply |

The explorer then served on `groq/gpt-oss-120b` in the live run — consistent with the
demoted ordering once real demand/turn context applied.

## Reviewer independence

Coder ran on `managed:groq:*`, reviewer on `managed:openrouter:*` — different physical quota
pools, different provider accounts. `reviewerIndependent=true`.

## Tool-safety feedback (`r50-tool-safety.test.ts`, 3 tests)

- Workspace escape (`path: "/"`) → tool `boundary_violation` + `security_blocked` role
  outcome + `WORKSPACE_ESCAPE_ATTEMPT` class (1.5× weight) on the served route; run blocks.
- Two consecutive escape proposals quarantine (double-weight streak ≥ threshold).
- Parent-directory escape (`../`) rejected identically.

## Failover budget (`r50-failover-budget.test.ts`, 3 tests)

- Replacement route converges within the bounded grant (original budget + ≤2 turns).
- No failover → no grant; same budget blocks.
- Repeated non-convergence hits the hard ceiling; stays `blocked`.

## Third managed domain audit — `R50-THIRD-DOMAIN-AUDIT.md`

Candidates audited: Cloudflare Workers AI, Cerebras, Google Gemini, Mistral, zai, nvidia.

- **Cloudflare Workers AI** is the legitimate third domain: `FREE_DAILY_ALLOCATION` hard
  stop, cleared terms, explicit free allowlist, implemented adapter, GraphQL neuron-usage
  source, live inference verified at $0 (`neurons: 1.6` reported). **Blocked on one external
  fact**: the account token lacks analytics-read scope, so the neuron guard fails closed —
  the correct behavior. Adding the scope is a credential change only the user can make;
  until then R50 honestly reports a 2-domain supply (Groq + OpenRouter managed pools).
- Cerebras excluded: current access is a time-boxed $5 promotional trial, not recurring
  free supply. Google excluded as default: billing-enabled projects may incur charges.
- Mistral reachable but all routes `DATA_POLICY_USER_CONSENT_REQUIRED` — correctly excluded.

## Nemotron role profile — `R50-NEMOTRON-ROLE-PROFILE.md`

Role-variable, exactly the shape quality routing exists for: strong Coder (2/2 verified),
failed Explorer (0/2 non-convergence), mixed Reviewer (2/3 with one `path:"/"` escape).
R50's machinery now encodes this profile as durable per-role evidence rather than anecdote.

## Regression

| Sweep | Result |
|---|---|
| eight-bit full suite | 330 pass / 2 skip, 31 files — 0 regressions (one fixture updated for the new `boundaryViolations` field) |
| server full suite | 893 pass / 3 skip; 3 failures isolated standalone → `role-output-budget` was a **real R50 regression** (fixed, see below); the other two are the documented `d4769e8` baselines (`agent-certification-r`, `fg3-model-aware-budget`); all parallel-run flakes pass standalone |
| R50 new tests | 27 — role-quality 15, replay 6, failover 3, tool-safety 3 |
| 16-Bit boundary | paid-auto + ForgeZero + paid role routing + paid provider factory: **233/233** — billing boundary untouched |
| `npm run build` | clean, all workspaces incl. desktop/web |

### Regression found and fixed during R50

`role-output-budget.test.ts` caught a genuine semantic bug in the first wiring: a cap-starved
empty reply burned the turn budget via its bounded re-ask, so the terminal check emitted
`budget_exhausted` **on top of** the per-turn `EMPTY_COMPLETION` — two verdicts for one
failure. Fix: `dominantRoleFailureRuns` — a run that already recorded a failure-kind role
outcome does not also record the terminal `budget_exhausted`. One run, one dominant verdict.
The inline `EMPTY_COMPLETION` observation now routes through `recordRoleOutcome` so the flag
covers every emission site.

## Honest remaining risks

- **Cold-start asymmetry persists**: quality only reorders measured routes; a never-tested
  route keeps neutral priority (by design — evidence must be earned, not assumed).
- **Sole-candidate roles can't flip**: REVIEWER live evidence shows demotion applied but the
  pick held because no second qualified route existed. Correct, but means quality evidence
  only visibly changes winners where supply redundancy exists.
- **Cloudflare third domain** is one token-scope away — audited and verified up to the
  fail-closed boundary, not admitted.
- **Explorer cancellation** emits no quality verdict (correct — watchdog/cancel isn't model
  quality) but means cancelled runs leave the serving route unmeasured for that role.
- Quality evidence lives in the route-health authority's rolling window: durable across
  restart via the ledger, but decays by design — a rehabilitated model must re-earn trust.

## Integrity notes

- Replayed R49 outcomes are tagged `source: "hydrate"` — the same path a restart restore
  takes; never presented as fresh live evidence.
- The live mission's own emissions are `source: "runtime"` — the two lanes are separable in
  the evidence file.
- No credential values printed or persisted; presence-only reporting.
- `evaluateCompletion` remains the only `completed` authority; all four non-completed paths
  in this milestone (explorer cancel, reviewer converge-fail on run 2, workspace escapes,
  budget exhaustion) terminate `blocked`.
- No paid route, no local inference, no paid fallback anywhere in the loop.
