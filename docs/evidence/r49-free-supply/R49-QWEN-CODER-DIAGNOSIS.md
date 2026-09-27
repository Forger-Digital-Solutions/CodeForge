# R49 — Groq Qwen3.8-27B Coder Diagnosis

Route: `groq/qwen/qwen3.8-27b`

Provenance:

- R48 overwritten-run dump in durable operator history: **replay**.
- `r48-free-mission-final.json`: **durable replay**.
- Runtime/qualification code audit: **deterministic**.
- No new Qwen inference was issued for this diagnosis.

## Two distinct R48 outcomes

### Attempt A — agent loop completed, engineering task failed

The Coder reported `completed` and listed:

- `src/math.mjs`
- `src/format.mjs`

Independent inspection and the focused test probe showed:

- `multiply` still returned `0`;
- `format(42)` returned `"value: 42"` instead of `"result: 42"`;
- Node tests: **0 passed / 2 failed**.

Reviewer capacity was then unavailable, so the mission blocked before promotion.
This was model/task-quality failure, not successful coding.

### Attempt B — admitted, then transport failed

The committed final artifact records:

- 5 model requests;
- 16,318 input tokens;
- 434 output tokens;
- 6 tool calls;
- 1 provider failure;
- terminal summary: `groq stream failed: fetch failed`;
- no route failover;
- journal state: `converged_failed`.

The terminal class is `TRANSIENT_NETWORK`, not a clean model capability verdict.
The captured evidence cannot identify DNS, reset, proxy, TLS, or local socket
cause because R48 dropped the native fetch cause.

## Why qualification did not predict Attempt A

The persisted Coder verdict is `QUALIFIED`, based on compact synthetic cases.
Those cases establish basic tool/edit protocol competence; they do not prove
that every multi-file autonomous implementation will satisfy its repository
tests.

R48 had a second gap: production ForgeVerify results were not fed back to the
route-health authority. Model turns could produce valid tool calls and the
Coder could stop explicitly, yet a later deterministic verification failure did
not create `verification_failed` evidence for the exact Coder route. Static
qualification therefore remained the dominant quality signal.

## R49 corrections

1. Agent and subagent results now retain the exact final route
   `{providerId, modelId}` in addition to physical pool provenance.
2. A failed ForgeVerify run records a Coder-scoped
   `role_outcome=verification_failed` for that route.
3. Positive `verified_complete` evidence is emitted only after completion-gate
   acceptance and successful integration — never after model prose or tests
   alone.
4. Role outcome evidence is advisory: it creates the existing
   `CAPABILITY_LIMITED` role-scoped demotion but cannot create/remove ForgeZero
   eligibility or rewrite qualification receipts.
5. Paid routes are ignored by this 8-Bit evidence seam.
6. Qualification request telemetry now counts actual stream requests, including
   Explorer loop turns, case retries, and reasoning-headroom retries. The R49
   Nemotron campaign observed why this matters: historical receipt metadata
   reported 15 while the response observer captured 27 HTTP responses.

## Routing consequence

A future Qwen implementation that fails ForgeVerify is demoted for `CODER`
without poisoning its availability for unrelated roles such as Reviewer. A
later fully verified and integrated Coder mission clears that role-scoped
capability limitation through canonical `verified_complete` evidence.

R49 does **not** reclassify the persisted Qwen receipt from one historical
mission. Qualification remains an admission floor; production role-quality
evidence refines eligible-route preference. This avoids both extremes:

- permanently banning a generally capable route after one task; and
- repeatedly selecting a known bad Coder choice as if failed verification had
  never happened.

## Verdict

- Prompt defect proven: **no**.
- Context overflow proven: **no**.
- Missing read/edit ownership proven: **no** from retained evidence.
- Loop-budget exhaustion proven: **no** for Attempt A; Attempt B ended on fetch.
- Model-specific task failure proven: **yes**, Attempt A (0/2 tests).
- Infrastructure failure proven: **yes**, Attempt B (`fetch failed`).
- R49 runtime quality-feedback gap fixed: **yes, deterministic tests**.
