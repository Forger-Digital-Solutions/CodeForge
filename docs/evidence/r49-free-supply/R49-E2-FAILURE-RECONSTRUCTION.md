# R49 — R48 E2 Failure Reconstruction

## Provenance and limits

This reconstruction combines:

1. **durable replay** — committed
   `r48-free-mission.json` and `r48-free-mission-final.json`;
2. **durable operator log** — the saved R48 conversation history, which contains
   six `[r48-free]` run summaries and selected evidence dumps;
3. **committed summary** — `R48-LIVE-EVIDENCE.md`, including the later bounded
   reset-time retries.

R48 reused the same output filename, so intermediate JSON was overwritten.
Its mission session persistence was `:memory:`. Exact per-candidate admission,
response headers, health snapshots, and decision receipts do not exist for
every attempt. Such cells below are **unproven**; this report does not infer
them from later runs.

All observed production routes used account label `live-acct-groq`. Physical
Fabric pool IDs were model-scoped
`managed:groq:live-acct-groq:model:<model>`. Those pool IDs represent distinct
observed model quota windows, but one Groq credential domain; account-level
independence is therefore 1.

## Canonical classification

R49 reuses existing runtime vocabulary instead of adding a parallel taxonomy:

| Requested analysis class | Canonical runtime/evidence class |
|---|---|
| SUPPLY_EXHAUSTED / ACCOUNT_QUOTA_EXHAUSTED | `QUOTA_EXHAUSTED`, `MODEL_QUOTA_EXHAUSTED`, `PROVIDER_QUOTA_EXHAUSTED`, `CAPACITY_EXHAUSTED` |
| PROVIDER_RATE_LIMIT | `RATE_LIMITED` / `FABRIC_QUEUED_FOR_CAPACITY` |
| FETCH_FAILURE / NETWORK_TRANSIENT | `TRANSIENT_NETWORK` (`fetch failed`) |
| PROVIDER_OUTAGE | `PROVIDER_OUTAGE` / `TEMPORARY_CAPACITY` when supported by response evidence |
| AUTH_FAILURE | `AUTH_FAILURE` |
| MODEL_NON_CONVERGENCE | journal `converged_failed` with successful provider calls and no terminal provider failure |
| TOOL_PROTOCOL_FAILURE | `INVALID_TOOL_OUTPUT` / `STRUCTURED_OUTPUT_FAILURE` |
| ROLE_NOT_QUALIFIED | role receipt `NOT_QUALIFIED` / `HARD_FAILURE` |
| NO_ADMISSIBLE_ROUTE | `DENIED_NO_SUPPLY` or a queued verdict whose every admissible pool is unavailable |
| CAPACITY_STATE_STALE | elapsed reset/cooldown evidence still excluding a route |

## Attempt reconstruction

`Q` = QUALIFIED, `P` = PROBATION. A blank role never dispatched.

| # | Evidence | Role path and route | Requests/tools | Admission and capacity | Terminal class | Recovery / wait |
|---:|---|---|---|---|---|---|
| 1 | operator log | Explorer `groq/openai/gpt-oss-20b` (`Q`), managed model pool; Coder no route | Explorer 5 requests, 5 tools, 13,752 input / 1,052 output; 0 provider failures | Explorer `FABRIC_ADMITTED`, `QUOTA_RESERVED`; Coder candidate detail not persisted | Explorer `MODEL_NON_CONVERGENCE`; Coder `NO_ADMISSIBLE_ROUTE` (exact cause unproven) | no failover; no trustworthy reset persisted |
| 2 | operator log | Explorer `gpt-oss-20b` (`Q`) completed; Coder no route | Explorer 2 requests, 0 tools, 5,602 input / 1,818 output | Coder: `FABRIC_QUEUED_FOR_CAPACITY`, `MODEL_QUOTA_EXHAUSTED`, `CAPACITY_EXHAUSTED`, `PROVIDER_QUOTA_EXHAUSTED` | supply/quota exhausted after Explorer | no `nextAvailableAt`; immediate honest block was the only evidence-backed action at that revision |
| 3 | operator log | Explorer `gpt-oss-20b` (`Q`) completed; Coder no route | exact counts not retained | same aggregate queued/quota reason set as #2 | supply/quota exhausted | exposed the missing subagent queued-wait path; R48 then added one bounded re-decision |
| 4 | operator log | Explorer `groq/openai/gpt-oss-120b` (`P`) did not converge; Coder no route | exact counts not retained | Coder queued; `next_available=2026-09-27T04:54:19.222Z` | Explorer `MODEL_NON_CONVERGENCE`; Coder supply exhausted | stale reset handling was still under repair; later R48 logic re-decides stale timestamps immediately |
| 5 | operator log + overwritten evidence dump | Explorer had no admitted route; Coder `groq/qwen/qwen3.8-27b` (`Q`) completed agent loop; Reviewer no route | exact Coder request/tool counts not retained | Coder admitted after reset/re-decision; Reviewer queued with `MODEL_QUOTA_EXHAUSTED`, `CAPACITY_EXHAUSTED`, `next_available=2026-09-27T04:58:21.763Z` | Reviewer supply exhausted; Coder output failed independent tests | no route failovers; main repository not promoted |
| 6 | committed `r48-free-mission.json` | Explorer `gpt-oss-120b` (`P`) completed; Coder no route | Explorer 3 requests, 2 tools, 8,415 input / 1,670 output | Explorer admitted with probation evidence; Coder queued with model/account/provider quota reasons, reset `2026-09-27T05:04:37.834Z` | supply exhausted | reset beyond bounded horizon; honest block |
| 7 | committed R48 live summary | Explorer `gpt-oss-20b` (`Q`) completed; Coder no route | counts not retained | Coder queued; reset `2026-09-27T05:05:59Z` | supply exhausted | waited until provider-stated reset before the next fresh mission; no request replay |
| 8 | operator continuation log summarized in R48 evidence | Explorer `gpt-oss-120b` (`P`) did not converge; Coder no route | Explorer 5 requests, 5 tools, 14,187 input / 760 output; 0 provider failures | Coder queued; reset `2026-09-27T05:15:26.294Z` | Explorer `MODEL_NON_CONVERGENCE`; supply exhausted | next mission launched only after reset |
| 9 | operator continuation log summarized in R48 evidence | Explorer `gpt-oss-20b` (`Q`) completed; Coder no route | Explorer 4 requests, 3 tools, 11,845 input / 1,435 output; 0 provider failures | Coder queued; reset `2026-09-27T05:23:29.933Z` | supply exhausted | next mission launched only after reset |
| 10 | committed `r48-free-mission-final.json` | Explorer failed before route binding; Coder `groq/qwen/qwen3.8-27b` (`Q`) admitted | Explorer 0 requests; Coder 5 requests, 6 tools, 16,318 input / 434 output, 1 provider failure | Coder `FABRIC_ADMITTED`, `QUOTA_RESERVED`; no replacement/failover journaled | terminal `TRANSIENT_NETWORK`: `groq stream failed: fetch failed`; journal ended `converged_failed` | exact health/cooldown and replacement decision were in-memory and are unproven |

## Attempt 5: Coder “completed” was not mission success

The overwritten evidence dump retained the proposed worktree and an independent
probe:

- claimed changed files: `src/math.mjs`, `src/format.mjs`;
- `multiply` still returned `0`;
- `format(42)` returned `"value: 42"` instead of `"result: 42"`;
- focused Node tests: 0 passed / 2 failed.

Thus `qwen3.8-27b` completed its agent loop but did not complete the engineering
task. Reviewer capacity was unavailable, verification was empty, and promotion
was withheld. Canonical classification is model/task-quality failure plus later
Reviewer supply exhaustion, never successful completion.

## Exact-time alternate-supply assessment

What is proven:

- Free Fabric evaluates all role-admissible projected routes before returning
  queued/denied.
- Mistral managed routes were excluded by
  `DATA_POLICY_USER_CONSENT_REQUIRED`.
- owner/developer pools were excluded by
  `OWNER_DEV_FREE_NOT_PRODUCT_FREE`.
- the only persisted OpenRouter qualification was Coder-qualified but
  Explorer `NOT_QUALIFIED` and Reviewer `HARD_FAILURE`.
- every observed Explorer dispatch therefore depended on the Groq credential.
- the only observed successful Coder dispatch also used Groq.

What is not proven for each historical instant:

- the per-candidate health/quota explanation;
- whether OpenRouter Nemotron was catalog-present and capacity-available at
  that exact decision;
- whether a sibling Groq model's limit was independent or correlated with the
  exhausted model window;
- exact cooldown origin and expiry after each denial;
- whether a fetch failure was DNS, connection reset, proxy, TLS, timeout, or
  another undici cause — the error cause was not preserved.

Therefore R49 cannot claim that no alternate existed at every instant. It can
claim that **no alternate was admitted by the Fabric**, and that R48 failed to
persist enough candidate-level evidence to distinguish structural absence from
correlated/exhausted supply after the fact.

## Root causes

### 1. Insufficient independently qualified supply — proven

- Explorer production coverage: one independent Groq credential.
- Reviewer coverage usable without data-policy consent: Groq only.
- OpenRouter exposed free inventory, but only one route had a receipt and it
  failed Explorer/Reviewer.
- Cloudflare was not configured.

### 2. Quota pressure created by sequential agent work — proven

Explorer consumed 2–5 model requests and 5.6k–14.2k input tokens before Coder
admission. Multiple runs then returned explicit model/provider quota exhaustion.

### 3. Capacity reset semantics are lossy — deterministic code finding

Groq reports separate request and token reset headers. Current
`parseRouteQuota` records `x-ratelimit-reset-requests` but not
`x-ratelimit-reset-tokens`, and `quotaWindows` assigns that one reset to both
request and token windows. A short token window can therefore inherit a longer
request reset, producing avoidable waiting/denial. R49 must fix this without
fabricating reset times.

### 4. Catalog refresh can spend allowance unexpectedly — deterministic code finding

`FreeModelCatalogRefresh` stores `maxAllowanceProbes` but never reads it.
`maxAllowanceProbes: 0` still calls one representative allowance model per
provider through `verifyAllowanceViaProbe`. R48 believed discovery was
probe-free; it was not. This hidden request consumption reduced already scarce
free capacity and weakens evidence provenance.

### 5. Fetch diagnostics are under-specified — proven

Node/undici `TypeError: fetch failed` reaches the evidence without its `cause`.
The existing classifier correctly maps the text to `TRANSIENT_NETWORK`, but the
runtime cannot distinguish DNS, reset, refusal, proxy, or TLS from the durable
artifact. This is an observability and recovery-selection defect, not proof of
a Groq outage.

### 6. Transient-network recovery prefers same-route retry first — deterministic

`TRANSIENT_NETWORK` has policy `bounded_retry`; the failover coordinator returns
`retry_same` before auto-mode Fabric replacement is evaluated. Under a healthy
independent alternative, this spends another scarce request on the same broken
endpoint instead of rotating first. R49 should preserve bounded retry for pins
and no-alternate cases while preferring admitted independent supply in auto
mode.

### 7. Model behavior was also a blocker — proven

- `gpt-oss-20b` and `gpt-oss-120b` sometimes exhausted their Explorer turn
  budgets without producing the structured result.
- `qwen3.8-27b` produced an agent-level completion that failed both focused
  tests in one run.
- the final Qwen attempt ended on fetch failure before a clean capability
  verdict; it cannot honestly be labeled pure non-convergence.

## R49 work implied by evidence

1. qualify selected current OpenRouter zero-unit candidates to create an
   independent account path for Explorer/Coder/Reviewer;
2. configure Cloudflare only if a legitimate API token and free-plan guard are
   available — account ID alone is no supply;
3. honor allowance-probe budgets;
4. preserve separate request/token reset evidence through Fabric windows;
5. persist live mission health/capacity/candidate decisions;
6. rotate auto-mode transient failures to independent admitted supply before
   same-route retry;
7. feed failed verification/non-convergence into role quality rather than
   repeatedly preferring the same model;
8. retain honest block semantics if independent role coverage remains
   insufficient.
