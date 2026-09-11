# CodeForge R10 Differentiation Stack Gap Audit

**Baseline Commit:** `085e065a46f73f9e80dd952b2ee64923908e276e` (feat: commission CodeForge R9 daily-driver agent)
**Current HEAD:** `6dbb67880c0e8bfbfa0bf69d4e593ab710320c6f` (feat: overhaul CodeForge daily-driver workspace UX (R9.1))
**Branch:** `feat/codeforge-cloud`

---

## Authority Separation Map (Actual Implementation)

### FORGEAUTO/FREE — The Router
**Location:** `packages/router/src/index.ts` (`ForgeRouter`)

**What it does:**
- `rank(req)` — deterministic capability-aware ranking of currently eligible verified-free models
- `topVerifiedFree(req, limit)` — at-most-N recommended verified-free models (live-derived from ForgeZero)
- `route(req)` — selects best model with alternatives
- `resolveSelection(selection)` — resolves ExecutionModelSelection to ResolvedModel

**Integration:**
- Uses `ForgeZero` firewall for eligibility filtering (`eligibleModels()`)
- Called by `Director.resolveForgeZeroAdaptive()` and `Router.resolveSelection()`
- Called by `AgentRuntime.selectModel()` for real-time model selection

**Missing/Weak:**
- No task classification pipeline integration (uses manual `taskType` string)
- No explicit model stickiness/anti-thrashing (handled by 8-Bit router layer)
- No route explanation beyond `reasons` array

---

### 8-BIT — Free-Model Availability / Compatibility Intelligence
**Location:** `packages/eight-bit/src/`

**Components:**
| Module | Responsibility |
|--------|----------------|
| `eligibility.ts` | Hard role-capability + free-policy gate (evaluated BEFORE ranking) |
| `health.ts` | Live health tracking, failure classification, cooldown, ForgeZero sync |
| `reliability.ts` | Per-route tool-call reliability tracking (quarantine on 4 consecutive bad) |
| `router.ts` | Role-aware adaptive router with sticky bindings & promotion margin (10 pts) |
| `failover.ts` | Safe active-run failover: classify → mark health → decide → select replacement |
| `handoff.ts` | Bounded context handoff from persisted WorkItems (FG-3 kernel + Context Pages) |
| `persistence.ts` | Route state, health, decision receipts via `ISessionPersistence` |
| `runtime.ts` | Top-level facade wiring all collaborators |

**Integration:**
- `EightBitRuntime` constructed in `AgentRuntime` constructor
- `hydrate()` called in `AgentRuntime.init()` for restart recovery
- `selectInitialRoute()` called during agent execution
- `handleTurnFailure()` called from `AgentRuntime.attemptEightBitFailover()` (safe boundary)
- `recordToolCallOutcome()` / `recordSuccess()` called from tool execution path

**Missing/Weak:**
- No live free discovery / catalog scanning (relies on ForgeZero registered models)
- No qualification harness (no synthetic benchmark execution)
- No provider diversity enforcement in slot selection
- No multimodal/vision capability tracking in role contracts
- No background qualification job

---

### FORGEZERO — Financial Authority
**Location:** `packages/forge-zero/src/`

**Components:**
| Module | Responsibility |
|--------|----------------|
| `firewall.ts` | `ForgeZero` class: register, verify, eligibleModels, markProviderHealth, checkEntitlement |
| `verifier.ts` | `verifyModelEligibility()` — 7-step verification pipeline (access class, deprecation, orphan, cost, free-status, paid-fallback, provider-account, privacy) |
| `types.ts` | Complete type system: `FreeModelRecord`, `AccessClass`, `ModelCostProfile`, `ModelHealthState`, `PrivacyMode`, `VerificationStep`, `VerificationResult` |
| `catalog.ts` | Static catalog: `GENERIC_FREE_MODEL`, `MUSE_SPARK_1_2` (FREE_ROUTED), paid variants |
| `entitlement.ts` | `EntitlementProvider` interface + `DevelopmentEntitlementProvider` for GEMS |

**Verification Pipeline (8 gates):**
1. `verify_access_class` — must be in `FREE_ACCESS_CLASSES` (or legacy $0-unit); `requireOngoingFree` excludes TRIAL/FREE_PROMO
2. `verify_not_deprecated` — upstream deprecated = reject
3. `verify_provider_registered` — orphan-model invariant (providerOracle)
4. `verify_cost` — zero-unit classes must prove $0 input/output/cache costs; allowance/promo verified differently
5. `verify_free_status` — `freeStatus === "verified_free"`, remote+cloud-hosted, freshness ≤ 7 days
6. `verify_paid_fallback_disabled` — `paidFallbackPossible === false` OR `paidFallbackDisabled === true`
7. `verify_provider_account` — health status must be `available`/`verified`/`rate_limited` (post-retry); excludes `configured`/`authenticated`/`offline`/`unknown`/`quota_exhausted`
8. `verify_privacy` — model's privacyClass permitted by active `PrivacyMode`

**Missing/Weak:**
- No live provider catalog discovery (static catalog only)
- Free status verification relies on `freeStatusVerifiedAt` timestamp (7-day TTL) — no active re-verification
- No BYOK cost semantics handling
- `UNKNOWN_COST` handling: models with `null` pricing rejected at cost gate
- No provider ambiguity resolution

---

### FORGEGREEN — Efficiency Authority
**Location:** `packages/forge-green/src/`

**Components:**
| Module | Responsibility |
|--------|----------------|
| `index.ts` | `ForgeGreenAdvisor` — context cache, immutable fragment dedup, stable prefix, request dedup, verification recommendation |
| `ledger.ts` | `ForgeGreenLedgerCollector` — efficiency receipts (tokens avoided, cache hits, duplicate suppression, tool compression) |
| `canonical-cache.ts` | Cross-session/worktree canonical cache for repo analysis (FG-1D) |
| `verification-policy.ts` | FG-5 verification policy (sufficiency evaluation) |
| `evidence-resolution.js` | FG-7 evidence resolution (reuse valid evidence) |
| `coverage-authority.ts` | Coverage authority |
| `risk.ts` | FG-4 structural risk analysis |

**Integration in AgentRuntime:**
- `forgeGreen` advisor used in `ContextAssembler`, `ModelExecutionAdapter`, tool execution
- `ForgeGreenLedgerCollector` records: repository refresh, context pages, provider prompt cache, request dedup, tool compression, canonical cache, no-progress interruptions
- `forgeGreenCacheStore` backs canonical cache + Context Pages (FG-3D)
- `efficiencyReceipt` emitted in `AgentContextMetrics` and persisted as `forgegreen_ledger` work items

**Missing/Weak:**
- No duplicate file read detection (only request-level dedup via `runDeduplicated`)
- No search deduplication
- No partial verification reuse (FG-7 evidence resolution exists but not measured)
- No long-session context efficiency measurement
- No retry efficiency tracking
- No energy/compute measurement methodology
- Tool result compression exists (`compressToolOutput`) but savings not systematically measured

---

### MODEL REGISTRY — Normalized Catalog + CodeForge Overlay
**Location:** `packages/model-registry/src/`

**Architecture:**
```
Models.dev / Live Catalogs → ModelRecord (facts only)
                                  ↓
                    CodeForge Overlay (trust: verifiedFree, scores, health)
                                  ↓
                         toFreeModelRecord() → ForgeZero
```

**Discovery/Verification:**
- `discoverAndVerifyFree()` — verifies zero-unit free models via live catalog cross-check
- `verifyAllowanceViaProbe()` — verifies allowance models (Gemini/Groq/Cloudflare) via live probe
- `verifyZeroUnitFree()` / `verifyAllowanceFree()` — build overlay evidence
- **Critical:** Models.dev metadata alone NEVER grants `verifiedFree` — requires live catalog confirmation
- **IMPLEMENTED:** `FreeModelCatalogRefresh` with live provider catalog sync (`packages/model-registry/src/catalog-refresh.ts`)
- **IMPLEMENTED:** Live catalog snapshot generator (`scripts/generate-live-free-catalog.ts`)
- **IMPLEMENTED:** Periodic refresh via `FreeModelCatalogRefresh.refresh()`
- **IMPLEMENTED:** Stale model eviction automation (`packages/eight-bit/src/eviction.ts` - `ModelEvictionManager`)

---

## R10 Gap Matrix

### FORGEGREEN

| Capability | Status | Evidence |
|------------|--------|----------|
| Token reduction | IMPLEMENTED_BUT_WEAK | `ForgeGreenAdvisor` context cache + content hash reuse + prompt prefix; ledger records `tokensAvoided` but no baseline measurement |
| Context reduction | IMPLEMENTED_BUT_WEAK | FG-3 context pages + progressive planner; `contextBytes` tracked but no comparison |
| Page/context selection | IMPLEMENTED | `ContextAssembler` with progressive Context Pages (FG-3) |
| Repeated-read suppression | MISSING | Only request-level dedup (`runDeduplicated`); no file-read-level dedup |
| Repeated-search suppression | MISSING | No search deduplication |
| Verification reuse | PARTIAL | FG-7 evidence resolution exists (`evidence-resolution.ts`) but not measured in ledger |
| Evidence reuse | PARTIAL | FG-7 + canonical cache; `canonicalCacheHits/Misses` tracked |
| Cache reuse | IMPLEMENTED | Canonical cache (FG-1D) + Context Pages (FG-3D) |
| Model-call reduction | IMPLEMENTED_BUT_WEAK | Request dedup + user intent hold; no measurement of avoided calls |
| Unnecessary escalation avoidance | IMPLEMENTED | Completion gate blocks fake completion; FG-5 verification policy |
| Tool-call efficiency | IMPLEMENTED | Tool compression (FG-1B) + duplicate suppression (FG-1C) |
| Context prefetch efficiency | IMPLEMENTED | Progressive Context Pages with reuse tracking |
| Retry efficiency | MISSING | No retry tracking in ledger |
| Long-session efficiency | MISSING | No long-session measurement |
| Durable restart efficiency | IMPLEMENTED | 8-Bit hydrate + ForgeGreen canonical cache survive restart |

---

### 8-BIT

| Capability | Status | Evidence |
|------------|--------|----------|
| Live free discovery | IMPLEMENTED | `FreeModelCatalogRefresh` with live OpenRouter sync; 22 VERIFIED_FREE models discovered |
| Free-price verification | IMPLEMENTED | ForgeZero verifier (cost gate + free status gate + 7-day freshness) |
| Provider compatibility | IMPLEMENTED | `ProviderAvailabilityOracle` + provider adapter registration |
| Coding capability | IMPLEMENTED | `capabilities.coding` in `FreeModelRecord` + role contracts |
| Tool calling | IMPLEMENTED | `capabilities.toolCalling` + `toolReliability` tracking + quarantine |
| Structured output | IMPLEMENTED | `capabilities.structuredOutput` in role contracts |
| Context compatibility | IMPLEMENTED | `capabilities.longContext` + contextWindow check in eligibility |
| Multimodal support | PARTIAL | `capabilities.vision` exists; VISION role contract; no qualified free vision models in catalog |
| Rate-limit health | IMPLEMENTED | `health.status === "rate_limited"` + cooldown with exponential backoff |
| Provider uptime | IMPLEMENTED | `health.status` tracking + `markProviderHealth` |
| Stale model removal | IMPLEMENTED | `ModelEvictionManager` with deprecated/paid/expired/paid-fallback/orphan eviction |
| Fallback candidates | IMPLEMENTED | `buildNativeFallbackModelIds()` for request-level; `selectReplacement()` for cross-provider |
| Quality threshold | PROVISIONAL | Behavioral qualification harness (R10_FREE_QUALIFICATION_V1); floors calibrated from live data |
| Model benchmarking | IMPLEMENTED | Behavioral qualification harness (8 fixture categories A-H) with 22 models tested |
| Provider diversity | IMPLEMENTED | Provider diversity analysis in qualification report; concentration risk identified |

---

### FORGEAUTO/FREE

| Capability | Status | Evidence |
|------------|--------|----------|
| Task classification | IMPLEMENTED | `understandTask()` in `task-intelligence.ts` (keyword-based) |
| Model eligibility | IMPLEMENTED | ForgeZero `eligibleModels()` + 8-Bit `EightBitEligibilityPolicy` |
| Capability matching | IMPLEMENTED | Router scoring + 8-Bit role contracts |
| Quality ranking | IMPLEMENTED | `ForgeRouter.scoreModel()` with benchmarks, empirical scores, health penalties |
| Provider ranking | IMPLEMENTED | Router scoring includes accessClass preference (FREE_NATIVE > FREE_ROUTED > FREE_ALLOWANCE > FREE_PROMO) |
| Latency awareness | PARTIAL | `benchmarkProfile.speed` used; no live latency tracking in router |
| Reliability awareness | IMPLEMENTED | `toolReliability` + health penalties in router score |
| Context-fit awareness | IMPLEMENTED | `contextWindow` vs `estimatedContextTokens` in score + eligibility |
| Routing explanation | IMPLEMENTED | `getReasons()` returns reason codes |
| Fallback | IMPLEMENTED | 8-Bit `selectReplacement()` + `buildNativeFallbackModelIds()` |
| Retry | IMPLEMENTED | 8-Bit failover: bounded retry (3) → cooldown → rotate |
| Reroute | IMPLEMENTED | 8-Bit failover coordinator |
| Task continuity | IMPLEMENTED | 8-Bit handoff (FG-3 kernel + Context Pages) + messageHistory preserved |
| User preference | PARTIAL | `exact-free` mode + favorites in UI; no favorite signal in router |
| Favorite model influence | MISSING | Not integrated into router scoring |
| Model stickiness | IMPLEMENTED | 8-Bit sticky bindings with 10-point promotion margin |
| Anti-thrashing | IMPLEMENTED | Promotion margin + health cooldown + failover bounded retry |

---

### FORGEZERO

| Capability | Status | Evidence |
|------------|--------|----------|
| Free-price proof | IMPLEMENTED | Cost profile verification (input/output/cache = 0) + `isFree` flag + `freeTierVerifiedAt` |
| Cost metadata freshness | IMPLEMENTED | 7-day TTL on `freeTierVerifiedAt` / `freeStatusVerifiedAt` / `lastVerified` |
| Paid-route denial | IMPLEMENTED | `verify_cost` gate rejects non-zero cost; `verify_access_class` rejects PAID |
| Hidden fallback denial | IMPLEMENTED | `verify_paid_fallback_disabled` gate |
| BYOK cost semantics | MISSING | No BYOK handling in verifier |
| Free quota exhaustion | IMPLEMENTED | `health.status === "quota_exhausted"` → rejected at provider account gate |
| Provider ambiguity | PARTIAL | `accessClass` classification; `UNKNOWN_COST` rejected at cost gate |
| Unknown pricing | IMPLEMENTED | `null` pricing → `UNKNOWN_COST_REJECTED` (fail closed) |
| Zero-spend receipts | IMPLEMENTED | `FinancialReceipt` per request with pricing evidence, ForgeZero decision, observed charge (null if not reported) |
| Auditability | IMPLEMENTED | VerificationResult + FinancialReceipt + RouteReceipt with full decision trace |

---

## Key Architectural Findings

### 1. Authority Boundaries Are Respected
- ForgeZero is the **only** financial gate (`verify()`, `eligibleModels()`, `checkEntitlement()`)
- 8-Bit adds role-capability + health + reliability gates **on top of** ForgeZero eligibility
- ForgeRouter ranks only ForgeZero-eligible models
- ForgeGreen is purely advisory — never returns permissions/approvals/completion

### 2. Free Model Pipeline Is Multi-Stage
```
Model Discovery (stub) → ModelRecord (facts)
                              ↓
         CodeForge Overlay (verifiedFree via live catalog/probe)
                              ↓
              toFreeModelRecord() → FreeModelRecord
                              ↓
                    ForgeZero.register()
                              ↓
                    ForgeZero.verify() → eligibleModels()
                              ↓
              ForgeRouter.rank() / EightBitRouter.selectRoute()
```

### 3. Fail-Closed Is Enforced at Multiple Layers
- ForgeZero: unknown cost → reject; paid fallback → reject; local model → reject
- 8-Bit Eligibility: unknown pricing → reject even under BYOK/premium; paid → reject under adaptive
- 8-Bit Failover: exact pin never auto-replaced; no eligible route → surface `NO_ELIGIBLE_FREE_MODEL`

### 4. Task Continuity Across Failover Is Real
- `EightBitHandoffBuilder` builds from persisted `WorkItems` (not conversation text)
- FG-3 Context Kernel + Context Pages provide reusable structural context
- `messageHistory` preserved across model swap in `AgentRuntime.attemptEightBitFailover()`
- Duplicate suppression state advances on steer consumption (prevents false duplicate detection)

### 5. Efficiency Measurement Exists But Lacks Baselines
- `ForgeGreenLedgerCollector` records detailed metrics
- `EfficiencyReceipt` created per run with: tokensAvoided, cache hits, duplicate suppression, tool compression
- Persisted as `forgegreen_ledger` work items
- **But:** No controlled baseline (ForgeGreen disabled) for comparison
- **No:** Representative workload suite for measurement

---

## Critical Gaps Requiring Implementation

### Priority 1: 8-Bit Live Discovery & Qualification
- [x] Implement `FreeModelCatalogRefresh` with live provider catalog sync (`packages/model-registry/src/catalog-refresh.ts`)
- [x] Build qualification harness (synthetic test suite A-H from R10 spec) (`packages/eight-bit/src/qualification/`)
- [x] Automated stale model eviction (deprecated, paid, failing) (`packages/eight-bit/src/eviction.ts`)
- [x] Provider diversity analysis in qualification report (`docs/codeforge-r10-phase2-free-intelligence-report.md`)

### Priority 2: ForgeGreen Measurement Infrastructure
- [ ] Representative workload suite (6 task classes from R10 §72)
- [ ] Controlled baseline measurement (ForgeGreen disabled flag)
- [ ] Baseline vs optimized comparison reporting
- [ ] Energy/compute measurement methodology documentation

### Priority 3: Free Model Quality Floor
- [x] Behavioral qualification harness with raw pass/fail distributions
- [x] Probation period for newly discovered models (PROBATION state implemented)
- [ ] Define measurable minimum quality per role (codingScore ≥ 70, toolReliability ≥ 0.8, etc.) - PROVISIONAL floors calibrated
- [ ] Reject free models below floor even if verified-free

### Priority 4: Routing Polish
- [ ] Favorite model signal in router scoring
- [ ] Latency tracking integration (live measurements → router score)
- [x] Route receipts persistence (task requirements, candidate snapshot, selection reasons) (`RouteReceipt`)
- [x] "Why this model?" UX with compact user-facing explanation (`generateWhyThisModel()`)

### Priority 5: Verification & Evidence Reuse Measurement
- [ ] Quantify FG-7 verification reuse in ledger
- [ ] Partial verification reuse (reuse valid, rerun changed)
- [ ] Failed verification repair efficiency (minimal context to repair route)

---

## What Is Real vs. Architectural Promise

| Component | Real (Shipping) | Architectural Promise |
|-----------|-----------------|----------------------|
| ForgeZero financial gate | ✅ Complete with tests | — |
| 8-Bit health/reliability/failover | ✅ Complete with tests | — |
| 8-Bit sticky routing + anti-thrash | ✅ Complete with tests | — |
| 8-Bit handoff (FG-3 kernel) | ✅ Complete | — |
| ForgeGreen context cache + dedup | ✅ Complete | — |
| ForgeGreen tool compression | ✅ Complete | — |
| ForgeGreen canonical cache (FG-1D) | ✅ Complete | — |
| FG-3 Context Pages + reuse | ✅ Complete | — |
| FG-5 Verification policy | ✅ Complete | — |
| FG-7 Evidence resolution | ✅ Complete | — |
| Live free model discovery | ✅ Complete | Dynamic catalog sync |
| Free model qualification | ✅ Complete | Harness + benchmarks |
| Quality floor enforcement | ⚠️ Provisional | Measurable minimums |
| Baseline efficiency measurement | ❌ None | Controlled workload suite |
| Provider diversity | ⚠️ Analysis complete | Explicit constraint |
| BYOK cost semantics | ❌ None | ForgeZero integration |
| Zero-spend receipts | ❌ None | Per-request proof |
| Route explanation UX | ❌ Partial (reason codes) | User-facing "Why this model?" |

---

## Measurable Advantages Currently Demonstrated

1. **Zero-cost eligibility:** ForgeZero verifies that a route satisfies CodeForge's trusted zero-cost eligibility policy using current pricing, free-status, provider and fallback evidence.
2. **Fail-closed routing:** Multiple independent gates (ForgeZero + 8-Bit eligibility) reject unknown/paid
3. **Task continuity on failover:** Handoff from persisted state + messageHistory preservation
4. **Anti-thrashing:** 10-point promotion margin + health cooldown + bounded retry
5. **Duplicate suppression:** FG-1C state-aware (steer-aware) read-only action suppression
6. **Tool compression:** FG-1B deterministic compression with byte savings tracked
7. **Canonical cache:** FG-1D cross-worktree repo analysis reuse
8. **Context efficiency:** FG-3 progressive Context Pages with reuse measurement

---

## Next Steps for R10

1. **Audit complete** — this document
2. **Build free model catalog snapshot** (R10 §5) using live permitted discovery
3. **Define "Verified Free" semantics explicitly** (R10 §7)
4. **Implement 8-Bit qualification harness** (R10 §10)
5. **Establish ForgeGreen baselines** (R10 §23) with representative workloads
6. **Implement evidence-backed gaps only** (R10 §10)
7. **Run dogfood battery** (R10 §72) and measure
8. **Produce certification report** (R10 §99)