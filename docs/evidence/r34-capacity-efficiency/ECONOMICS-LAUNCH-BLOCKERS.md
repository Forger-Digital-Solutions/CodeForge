# R34 — capacity economics update, launch bar, and blocker classification

Companion machine-readable evidence: `context-efficiency-benchmark.json` (per-dispatch
estimated input tokens, OFF/ON arms). Supersedes the R33 capacity model only on the points
R34 changed; the R33 model's demand-population math stands.

## S — what R34 changed in the demand equation

| Quantity | R33 assumption | R34 measured | Source |
|---|---|---|---|
| Per-call admission demand | flat 16k tokens | measured serialized prompt (~2.0–2.9k/call on a medium task) + role-scoped output bound (CODER 2048, PLANNER 1536, light 1024) | benchmark receipt; `estimatePromptOnlyTokens`; Mission K budgets |
| Tool-surface overhead | 19 tools always | `repo_*` (12 tools, ~1,150 tok/call) gated off when no workspace | `getAvailableTools` workspace gate |
| Stale tool output | durable forever | superseded/mutated read-only outputs compacted to markers at dispatch | `history-compaction.ts`; interactive arm −5.9% total input |
| Tokenizer error margin | none per-route | learned per-provider `tokenizerRatio` (EMA) scales demand per candidate | capacity-governor `tokenizerRatioFor` |

### Admissible-supply consequence

The fixed 16k demand denied every sub-16k window. With measured demand:

- **Groq (8k TPM/model, per-model domains)** — a ~4.5k interactive-turn demand (input + 2048
  output bound, tokenizer-margin included) now admits. R33's "shared:mistral is the only
  admissible pool" finding is retired: each Groq model is an independent admissible pool.
- **Mistral codestral (125 RPM / 625k TPM)** — comfortably admissible, unchanged.
- **GitHub Models** — publishes per-model-per-tier daily limits but returns no quota headers;
  `windows: []` = zero measured supply = inadmissible by construction (fail-closed).
- **Cloudflare Workers AI** — 10k neurons/day account-wide; admits only when the analytics
  oracle reads account truth (Mission I diagnostics distinguish scope-less tokens from outages).
- **Managed pools (Mission B)** — each registered upstream account is its own quota domain
  (`managed:<provider>:<account>`); account-stamped observations never cross pools.

### Throughput economics (measured, medium task)

- ~2,300–2,600 estimated prompt tokens per dispatch, 5–6 dispatches per task, ~12–15.6k
  input tokens/task at R34 context discipline (vs ~4× higher under the unmeasured 16k frame
  when every dispatch reserved worst-case).
- Groq per-model pool at 8k TPM: ~3 small turns/min/model sustainable; a model fleet of N
  Groq models multiplies linearly (quotaDomain=model, Mission C).
- The honest capacity statement: certified supply scales with the number of *qualified*
  provider×model domains, not the number of providers.

## T — launch bar (what must be true to claim managed-Free GA)

1. **Inventory**: ≥2 independent admissible managed pools online simultaneously, each with
   authoritative quota windows (the harness now reports `BLOCKED_BY_AVAILABLE_SUPPLY`
   otherwise — a supply statement, not a failover defect).
2. **Migration**: live cross-pool failover proof (`MIGRATION_PROVEN` in the hardened
   cross-pool harness) — checkpoint → broker → continue on a different physical pool.
3. **Honesty**: `WAITING_FOR_FREE_CAPACITY` parks durably, resumes on supply return, and
   never completes unverified (regression: workflow-capacity-wait suite + restart-restore).
4. **Billing safety**: red-team suite green — 402, suffix-loss, BYOK leak, dev-key,
   oversubscribe all deny; no paid substitution path exists.
5. **Observability**: `/api/free-cloud/capacity` shows pools/routes/reservations/quarantine/
   dispatch telemetry; operators can quarantine any pool instantly.
6. **Efficiency**: measured-demand admission + stale-output compaction green in benchmark.
7. **Regression**: canonical suite green (R33 baseline 3,670 pass / 0 fail / 48 skip).

Not required for the bar: production deployment at scale, credits secured, GitHub Models
admissibility (headers don't exist upstream), multi-account managed fleet live traffic.

## U — blocker classification

| Blocker | Class | State after R34 |
|---|---|---|
| Live cross-pool migration unproven | SUPPLY | **Unblocked mechanism**: Groq model-pools admit post-Mission E; live proof rerun required (Mission D harness ready). |
| Managed fleet credentials | EXTERNAL_AUTHZ | Registry + quarantine exist; needs server-owned upstream accounts or FDS-gateway pool registration. No raw credentials reach clients. |
| Cloudflare usage analytics scope | EXTERNAL_AUTHZ | Token lacks analytics read → `CLOUDFLARE_USAGE_SCOPE_REQUIRED` (was silent UNKNOWN). Owner must mint a scoped token. |
| GitHub Models quota observability | UPSTREAM | No quota headers exist; documentation-only truth stays inadmissible until upstream reports. |
| OpenRouter managed relay terms | TERMS | Standard terms restrict resale; enterprise agreement required for managed multi-user. BYOK path unaffected. |
| Gemini project suspension | EXTERNAL_AUTHZ | Owner action; project suspended upstream. |
| Credit runway | FUNDING | Unsecured; not required for the launch bar (fail-closed waits replace paid fallback). |
| Mistral non-codestral models at limit:0 | SUPPLY | Honest zeros — they deny rather than pretend. Codestral remains the admissible Mistral domain. |
| Production deployment at 1M scale | DEPLOYMENT | Control-plane admission proven synthetically at 1M; real fleet supply is the actual constraint, unchanged by R34. |
