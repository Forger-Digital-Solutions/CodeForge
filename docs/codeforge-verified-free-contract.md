# CodeForge VERIFIED_FREE Contract

**Version:** 1.0
**Status:** Authoritative definition for R10 Phase 2
**Effective:** 2026-09-10

---

## Purpose

This document defines exactly what `VERIFIED_FREE` means in CodeForge. It is the single source of truth for the financial eligibility gate that ForgeZero enforces. No other document, comment, or marketing claim overrides this definition.

---

## State Model

A model's free-status exists on two independent axes:

### Axis 1: PRICE CLASSIFICATION (Financial)

| State | Meaning |
|-------|---------|
| `VERIFIED_FREE_ZERO_UNIT` | Provider/catalog lists unit price as $0 input/output/cache; independently verified via live catalog cross-check or live probe |
| `VERIFIED_FREE_ALLOWANCE` | Provider grants recurring free quota/allowance; verified via successful live probe request within that quota |
| `VERIFIED_FREE_PROMO` | Temporary promotional free access; verified but flagged as time-limited |
| `STALE_FREE_EVIDENCE` | Was previously verified free, but verification timestamp exceeds TTL (7 days) |
| `UNKNOWN_COST` | Pricing metadata is null/missing/contradictory; cannot confirm $0 |
| `PAID` | Unit price > 0 or provider confirms paid |
| `DEPRECATED` | Upstream marks model deprecated/retired |

### Axis 2: AVAILABILITY (Operational)

| State | Meaning |
|-------|---------|
| `AVAILABLE` | Provider healthy, authenticated, not rate-limited, quota available |
| `RATE_LIMITED` | Provider returns 429; cooling down with `retryAfter` |
| `QUOTA_EXHAUSTED` | Free allowance used up for current period |
| `AUTH_REQUIRED` | Provider credentials missing/invalid |
| `OFFLINE` | Provider endpoint unreachable |
| `UNAVAILABLE` | Model not found, retired, or provider not registered |

**Critical:** PRICE and AVAILABILITY are orthogonal. A model can be `VERIFIED_FREE_ZERO_UNIT` + `RATE_LIMITED` simultaneously. The financial classification does NOT change to `PAID` merely because access is temporarily unavailable.

---

## VERIFIED_FREE Definition

A model is `VERIFIED_FREE` (eligible for ForgeAuto/Free adaptive routing) **iff all of the following hold**:

### 1. Access Class Gate
- Model has an `accessClass` in `FREE_ACCESS_CLASSES` = [`FREE_NATIVE`, `FREE_ROUTED`, `FREE_ALLOWANCE`, `FREE_PROMO`]
- **OR** legacy model (no `accessClass`) with `freeStatus === "verified_free"` AND `costProfile.isFree === true`
- If `requireOngoingFree` policy active: `FREE_PROMO` and `TRIAL` are excluded

### 2. Non-Deprecated
- `model.deprecated !== true` (upstream not retired)

### 3. Provider Registered (Orphan Invariant)
- A live, authenticated provider adapter is registered for `model.providerId`
- Enforced via `ProviderAvailabilityOracle.isActive(providerId)`

### 4. Cost Verification (per Access Class)
- **Zero-unit classes** (`FREE_NATIVE`, `FREE_ROUTED`, legacy):
  - `costProfile.inputCostPerMillion === 0`
  - `costProfile.outputCostPerMillion === 0`
  - `costProfile.cacheReadCostPerMillion === 0` (if present)
  - `costProfile.cacheWriteCostPerMillion === 0` (if present)
  - `costProfile.isFree === true`
- **Allowance/Promo classes** (`FREE_ALLOWANCE`, `FREE_PROMO`):
  - Unit price may be non-zero; verified via successful live probe (see §6)
  - Probe must succeed within current free quota

### 5. Free Status Freshness
- `model.freeStatus === "verified_free"`
- `model.isRemote === true` AND `model.isCloudHosted === true`
- Verification timestamp (`freeTierVerifiedAt` OR `freeStatusVerifiedAt` OR `lastVerified`) ≤ 7 days old
- **No automatic re-verification** — expiry means `STALE_FREE_EVIDENCE` → ineligible until refreshed

### 6. No Enabled Paid Fallback
- `costProfile.paidFallbackPossible === false` **OR** `costProfile.paidFallbackDisabled === true`
- If provider *can* fall back to paid capacity and it's not explicitly disabled → reject

### 7. Provider Account Healthy
- `model.health` exists
- `health.status` ∈ [`available`, `verified`, `rate_limited` (post-retryAfter)]
- Excludes: `offline`, `unknown`, `auth_required`, `quota_exhausted`, `configured`, `authenticated`

### 8. Privacy Class Permitted
- If `PrivacyMode` active: `model.privacyClass` ∈ `PRIVACY_MODE_ALLOWS[mode]`
- `STRICT` → only `strict`
- `STANDARD` → `strict`, `standard`
- `MAXIMUM_FREE` → `strict`, `standard`, `permissive`

---

## Evidence Sources & Provenance

| Evidence | Source | Trust Level |
|----------|--------|-------------|
| Unit pricing ($0) | Live provider `/models` catalog cross-checked against Models.dev | High (independent verification) |
| Allowance free | Successful live probe request (1 chat completion) | High (execution proof) |
| Promo free | Provider catalog + promotional terms | Medium (time-limited) |
| Provider health | Adapter `healthCheck()` + runtime failure classification | Live |
| Free status timestamp | `freeTierVerifiedAt` from verification overlay | Auditable |

**Models.dev metadata alone NEVER grants `VERIFIED_FREE`.** It provides discovery hints only. Actual verification requires live catalog confirmation or live probe.

---

## TTL & Freshness Semantics

| Evidence Type | TTL | On Expiry |
|---------------|-----|-----------|
| Free status verification (`freeTierVerifiedAt`) | 7 days | → `STALE_FREE_EVIDENCE` (ineligible) |
| Provider health | Real-time (per-request) | → `RATE_LIMITED`/`OFFLINE`/`AUTH_REQUIRED` |
| Catalog discovery | Startup + explicit refresh + TTL | → stale display, routing fails closed |
| Allowance probe | Per-session or explicit refresh | → re-probe on next refresh |

**Separate TTLs for separate evidence types.** Do not conflate catalog freshness with price verification freshness.

---

## Promotional Credits Policy

**Promotional credits (signup bonuses, trial balances, temporary coupons) do NOT qualify as `VERIFIED_FREE` for ForgeAuto/Free adaptive routing.**

Rationale:
- Cash-equivalent credits are exhaustible and time-bounded
- They represent a paid model with a temporary discount, not a $0-unit route
- Using them risks silent paid fallback when credits expire

**Exception:** If a provider explicitly lists a model at $0 unit price permanently (e.g., `FREE_NATIVE`, `FREE_ROUTED`), it qualifies regardless of promotional context.

---

## Free Allowance vs Zero-Unit Free

| Dimension | Zero-Unit Free (`FREE_NATIVE`, `FREE_ROUTED`) | Allowance Free (`FREE_ALLOWANCE`) |
|-----------|-----------------------------------------------|-----------------------------------|
| Unit price | $0 input / $0 output / $0 cache | Non-zero (provider lists paid price) |
| Proof | Live catalog cross-check | Live probe within quota |
| Exhaustion | Never (per-unit $0) | Per-period quota |
| Probe required | No | Yes (1 successful request) |
| TTL | 7-day verification freshness | Probe success = current session |

Both are eligible for ForgeAuto/Free when verified. UI and receipts preserve the distinction.

---

## What Invalidates VERIFIED_FREE

| Trigger | Result |
|---------|--------|
| Verification timestamp > 7 days | `STALE_FREE_EVIDENCE` → ineligible |
| Provider catalog shows price > 0 | `PAID` → ineligible |
| Provider catalog no longer lists model | `UNAVAILABLE` → ineligible |
| `paidFallbackPossible === true` AND `paidFallbackDisabled === false` | `PAID_FALLBACK_REJECTED` → ineligible |
| Provider health = `offline`/`auth_required`/`quota_exhausted` | `UNAVAILABLE` → ineligible |
| Privacy class not permitted by active mode | `FORGE_ZERO_VIOLATION` → ineligible |
| Conflicting evidence (provider says free, secondary says paid) | Fail closed → `UNKNOWN_COST` → ineligible |

---

## Observed Execution Cost vs Eligibility

| Concept | Description |
|---------|-------------|
| **Eligibility Proof** | Trusted metadata/evidence indicates $0 route at time of verification |
| **Execution Cost Receipt** | Actual provider billing evidence for a specific request |

**They are not identical.** A model can be eligibility-verified free but a specific request could theoretically incur charge (e.g., provider billing bug, quota boundary). ForgeZero enforces eligibility; observed execution cost is recorded separately in zero-spend receipts (§10).

If provider does not return actual request cost: `observedExecutionCost = null`. Do NOT fabricate `$0.00`.

---

## Zero-Spend Receipt Schema

Per-request financial decision record (no prompts, source code, secrets):

```json
{
  "requestId": "uuid",
  "taskId": "string",
  "providerId": "string",
  "modelId": "string",
  "accessClass": "FREE_NATIVE | FREE_ROUTED | FREE_ALLOWANCE | FREE_PROMO",
  "pricingEvidence": {
    "inputUnitCost": 0,
    "outputUnitCost": 0,
    "cacheReadUnitCost": 0,
    "cacheWriteUnitCost": 0,
    "currency": "USD",
    "source": "opencode-live-catalog | openrouter-live-catalog | live-probe | snapshot",
    "verifiedAt": "ISO8601"
  },
  "freeStatusEvidence": {
    "state": "VERIFIED_FREE_ZERO_UNIT | VERIFIED_FREE_ALLOWANCE | VERIFIED_FREE_PROMO",
    "source": "pricing+live-catalog | live-probe",
    "verifiedAt": "ISO8601",
    "expiresAt": "ISO8601"
  },
  "fallback": {
    "paidFallbackPossible": false,
    "paidFallbackDisabled": true
  },
  "forgeZeroDecision": "ALLOW | DENY",
  "reasonCodes": ["VERIFIED_FREE", "CODING_CAPABLE", "TOOL_COMPATIBLE", ...],
  "observedExecutionCost": {
    "amount": 0,
    "currency": "USD",
    "source": "provider-usage"
  } | null
}
```

---

## Zero-Cost Enforcement Boundary

```
ForgeAuto/Free (router) selects candidate
        ↓
ForgeZero.verify(providerId, modelId) → ALLOW/DENY
        ↓
If ALLOW → dispatch to provider adapter
        ↓
Provider returns usage/cost → record in zero-spend receipt
        ↓
If observed cost > 0 → audit alert (not automatic re-routing mid-task)
```

**ForgeZero is the final authority.** No subsystem bypasses it. Not 8-Bit, not ForgeAuto, not favorites, not sticky routes.

---

## Change Log

| Version | Date | Change |
|---------|------|--------|
| 1.0 | 2026-09-10 | Initial authoritative definition for R10 Phase 2 |