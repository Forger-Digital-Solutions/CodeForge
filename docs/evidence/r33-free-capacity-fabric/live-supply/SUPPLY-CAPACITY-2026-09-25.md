# R33 Supply-Side Capacity Analysis — 2026-09-25

Companion to `INVENTORY-2026-09-24.md` and the demand-side model in
`../capacity-model/`. The demand model intentionally ships zero certified
domains; this document fills the supply side with what was *measured live*
against real credentials — and is explicit about which supply class each pool
can legally occupy.

## Supply classes first — who may consume each pool

The fabric distinguishes supply by ownership, not by whether the upstream
call works (`supplyClassFor`, `freeRouteExclusionReason`):

| Supply class | Meaning | Product eligibility |
|---|---|---|
| `PURE_MANAGED_FREE` | CodeForge-owned upstream, relayed via the FDS gateway (`codeforge-cloud`) on a `SHARED_OWNER_POOL` | Admissible for all users |
| `OWNER_DEV_FREE` | Keys in the dev environment (`credentialSource: ENVIRONMENT`) | **`OWNER_DEV_FREE_NOT_PRODUCT_FREE`** — dogfood/dev only |
| `USER_CONNECTED_FREE` | The end user's own provider account → `PER_USER_POOL` | Admissible for that user only |
| `PROMOTIONAL_FREE` / `TRIAL_CREDIT` | Time/credit-boxed trials (Cerebras) | Denied as baseline free |
| `SPONSORED_FREE` / `DEPOSIT_UNLOCKED_FREE` | Someone pays upstream | Disabled by default policy |

**Every pool measured below was measured with an environment credential →
`OWNER_DEV_FREE`.** The numbers describe what the same provider account
would offer as a *server-owned upstream* behind the FDS gateway
(`PURE_MANAGED_FREE`) or as each user's own `USER_CONNECTED_FREE` pool —
they are not, as deployed, product-facing managed supply.

## Measured pools vs the normal-coding workload

Demand basis: R32 live receipts, `normal_coding` median — 24 requests,
128,384 input + 10,032 output tokens over ~276 s ⇒ **~5.2 requests/min and
~30k tokens/min per actively-working user** (and ~5.3k input tokens per
request on average).

Fabric admission demand per turn: `requests:1, inputTokens:16_000` — a
deliberate conservative bound because context grows during a turn; a
reservation sized to the *median* request would collide with the provider's
real window mid-turn and 429.

| Pool | Measured window | Req-bound concurrency | Token-bound concurrency | Fits 16k turn demand? |
|---|---|---:|---:|---|
| `shared:mistral` (codestral-latest) | 125 req/min, 625,000 tok/min | ~23 | **~20** | yes |
| `shared:groq` (per-model pools) | 1,000 req/day + 8,000 tok/min per model | n/a (per-day req budget) | **0** | **no** — 8k TPM < 16k demand |
| GitHub Models (documented only) | 15 req/min, 150 req/day, 8k/4k per-request | ~2 (sub-8k roles only) | n/a | **no** — 8k/request cap |
| Cloudflare Workers AI | 10,000 neurons/day (8,000 CodeForge ceiling) | ~180 req/day ≈ **7 tasks/day** | neuron-bound | gated: usage oracle needs analytics-scoped token |
| OpenRouter (`:free` pool) | 282/1,000 req remaining | ~1–2 | n/a | **POLICY_BLOCKED** |

**Concurrent agent users on measured supply: ≈ 20, all on `shared:mistral`.**
Every other pool is either too small for an agent turn's honest demand
(Groq, GitHub), unquantified (GitHub), gated on a token scope (Cloudflare),
or policy-blocked (OpenRouter).

## What each measured pool means per user-connected account

`USER_CONNECTED_FREE` pools scale with users — each account brings its own
windows. The same measurements then read differently:

- A Mistral-connected user: 125 req/min is ~24× one user's working rate —
  headroom for a heavy single-user session plus subagent fan-out.
- A Groq-connected user: 8k TPM fits ~1–2 small requests/min — light tasks
  only; agent turns over ~8k tokens will 429 regardless of reservation size.
- A GitHub-connected user: 150 req/day ≈ 6 normal-coding tasks/day maximum,
  and only prompts under the 8k/request cap.

## Scale gaps — demand model vs measured supply

Using the capacity model's `normal_coding` row (100% duty cycle):

| Active users | Required req/min | Required tok/min | Measured supply covers | Shortfall |
|---:|---:|---:|---|---:|
| 10 | 52 | ~300k | mistral alone | none |
| 20 | 104 | ~600k | mistral at ~96% tok-min | tight |
| 100 | 521 | ~3.0M | ~20 of 100 users | 4–5× more Mistral-class pools needed |
| 1,000 | 5,210 | ~30M | ~2% | ~50× |
| 10,000 | 52,100 | ~300M | ~0.2% | ~500× |
| 100,000 | 520,997 | ~3.0B | ~0.02% | ~5,000× |
| 1,000,000 | 5,209,973 | ~30B | ~0.002% | ~50,000× |

First bottleneck at scale is **tokens/minute on the single admissible pool**,
then requests/minute, then daily/monthly ceilings (Mistral's monthly free
allowance is real but not API-measurable — Admin-page only, unmeasured here).

## How a task continues after provider failure — proven

`cross-pool-migration-2026-09-25.json`: real Mistral turn → injected 429 →
durable `waiting_for_free_capacity` (no false fail/complete) → sweeper
re-admission at ~60s (the authority's `rateLimitDefaultTtlMs`) → resume →
review → verification → `completed`. Distinct-pool migration is supply-
blocked today (single admissible pool); the mechanism is proven by the
restart/mid-turn/independent-pool suite in
`packages/server/test/free-fabric-wiring.test.ts`.

## Measured turn economics (live, `token-efficiency-2026-09-25.json`)

A real trivial-fix workflow on `shared:mistral` consumed **8 model calls /
~22.5k input + ~330 output tokens** end-to-end (implement + park/resume +
review). Two properties that matter for every capacity projection:

- **~98% of consumed tokens are input** — each call replays the full context.
  Output is tiny (12–109/call). Provider-side prompt caching, where offered
  (Cloudflare's neuron rates already price cached input ~5–10× cheaper), is
  the single largest efficiency lever.
- **Context grows inside a turn**: input/request rose 2,583 → 3,123 (+21%)
  across this small task. That is why the fabric's fixed 16k admission demand
  is honest headroom, not waste — a reservation sized to the *median* request
  would collide with the provider's real window mid-turn.

## Honest unknowns still on the table

- **Mistral monthly allowance**: per-minute windows are measured; the free
  monthly token ceiling is not API-visible. Sustained ~20-user throughput
  could hit a monthly wall that no probe can see from headers alone.
- **Groq org-level accounting**: per-model headers do not prove independent
  pools; Groq documents org daily token budgets. Treated as ONE org domain.
- **GitHub Models**: no headers; documented Copilot-Free limits are
  per-user-entitlement terms, not managed-relay terms — and CodeForge has no
  provider definition for it at all.
- **Managed relay terms**: `termsStatus: CLEARED` sets
  `managedMultiUserAllowed` at the route level, but a hosted multi-user
  relay on a single free account is a provider-relationship question
  (partnership path tracked in `provider-partnership-targets.md`), not
  something headers can settle.

## What legitimately grows supply

1. **User-connected pools** (`USER_CONNECTED_FREE`): each user's own
   Mistral/Groq/GitHub account — scales with adoption, the honest free
   scaling path already in the fabric.
2. **Analytics-scoped Cloudflare token**: unlocks the neuron pool
   (~7 tasks/day ceiling — small but real).
3. **Provider partnerships / FDS-gateway upstreams**: turns measured
   `OWNER_DEV_FREE` evidence into `PURE_MANAGED_FREE` supply.
4. **A second ≥16k-TPM verified-free credential**: makes live cross-pool
   migration demonstrable (SambaNova/NVIDIA-class free tiers — needs a
   sign-up; cannot be self-provisioned).
