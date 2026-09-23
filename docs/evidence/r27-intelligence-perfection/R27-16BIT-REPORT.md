# R27 16-Bit Report

Status: `R27_16_BIT_QUARANTINE_AND_EVIDENCE_HONESTY_DETERMINISTICALLY_PROVEN`

## Findings

16-Bit is not a free-routing surface. ForgeZero excludes paid records from adaptive selection, and
the Paid Auto package remains a distinct commercial-route implementation. Its local pricing,
fallback, reservation, and shadow code can be tested without making a commercial request, but
those tests do not measure providers.

The server previously accepted a Paid Auto selection despite the fact that ForgeZero deliberately
does not register paid routes for execution. That produced a misleading saved selection which
could only fail later. The shadow helper likewise granted production provenance to arbitrary input
by default.

## R27 correction

The free-only server now treats Paid Auto as audit-only: it remains visible but is always
ineligible, and a manual selection receives `PAID_AUTO_BLOCKED_BY_FREE_ONLY_POLICY` before the
session state changes. A paid route cannot make the server appear real-runtime-capable. Shadow
records default to `MOCK`; callers must explicitly attest production or benchmark provenance.

## Deterministic validation

The dedicated paid-route, ForgeZero, server, and desktop suites passed 71 tests. They prove
no-network defaults, paid-catalog exclusion, exact same-model fallback rules, budget admission and
identity safeguards, durable budget ceilings, selection rejection, and shadow isolation. The
related TypeScript projects also typecheck.

## Boundary

No paid API or pricing endpoint was contacted. Therefore cost, latency, quality, tool capability,
role suitability, reliability, fallback cost, and provider/model identity are all unmeasured and
unproven. A future paid evaluation requires an explicit policy change, an authorized disposable
account, finite pre-authorization, current price evidence, redacted receipts, and a predeclared
benchmark. It must remain separate from ForgeZero free routing and GEMS.
