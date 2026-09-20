# R21 8-Bit / ForgeAuto Free Verification Checkpoint (M9)

Recorded: 2026-09-20
Branch: `forger-digital-solutions-forgegreen-certified`
Spend: `$0` — live check was a read-only catalog listing (no inference calls).

## What the audit verified

The free-routing boundary is enforced at every selection point in `agent-runtime.ts`:

- Every route candidate goes through `firewall.verify(providerId, modelId).ok` before use
  (fallback ordering at line ~2986-2992, explicit selection at ~3012-3015, canonical
  resolution via `resolveCanonicalSelection`).
- `no_eligible_route` fails closed with an explicit "no paid or unknown-cost route was
  used" reason — never silently crosses to a paid model.
- `paid-auto` is a separate explicit-selection branch requiring `paidAuto.runtimeModel`
  registration; it is never a fallback target of the free path.
- `gems_paid` tier is returned only for an explicitly selected record, never auto-routed.
- Entitlement (`checkEntitlement`) runs per turn for user-connected providers; 8-Bit health
  cooldowns hard-exclude routes that ForgeZero's soft ranking would still list.

## Test evidence this run

| Package | Result |
|---|---|
| `packages/eight-bit` | 20 files / **164 tests green** (2 PG-gated skipped) — failover, eligibility, health, drift, handoff, qualification (28), persistence, shadow, security, capacity-intelligence |
| `packages/model-registry` | 7 files / **85 green** — free-cloud-registry (31), free-cloud-chaos (14), discovery, allowance-probe, registry, provider-packaging |
| `packages/forge-zero` | 10 files / **101 green** — adversarial-boundary, failure-matrix, orphan-invariant, health-classify, paid-catalog, user-connected-free, privacy-routing, capacity-r4 |
| Live catalog snapshot | **real OpenRouter registry read**: 1752 models scanned, 24 verified-free registered, 0 errors — the zero-billing claim is exercised against the live catalog, not mocks |

## Boundary (honest)

- The live check proves *catalog* verification (free-tier model discovery and ForgeZero
  registration). It does not run paid inference — and per campaign rules cannot — so
  end-to-end free *generation* quality on live providers remains measured only by the
  managed-free evidence series (`docs/evidence/managed-free-*`), not re-proven here.
- `network:false` enforcement for agent shell commands landed in M6; the model-routing
  side of the boundary was already real and is re-verified here, not changed.

## Certification label

ForgeAuto Free routing / 8-Bit failover / ForgeZero boundary: **VERIFIED — evidence-backed**
(suite + live catalog read). Free end-to-end generation quality on live providers:
**partially verified** (prior managed-free evidence, not re-run this milestone).
