# CodeForge Free Cloud Registry — R1

The R1 registry is implemented by `@codeforge/model-registry` and exposed by the local server at
`GET /api/free-cloud/registry`. It is a view of canonical models and their provider routes, not a
second router and not a static claim that a route is usable.

## Admission

A route reaches `FORGEAUTO_ELIGIBLE` only when all of these conditions hold:

1. the provider route has current zero-cash pricing/allowance evidence;
2. the provider is connected through a user-approved credential source;
3. terms and privacy gates permit the current ForgeZero mode;
4. the route is executable, tool-capable, healthy, and within quota/cooldown limits; and
5. its 8-Bit qualification receipt is `QUALIFIED`.

Models.dev supplies candidate provider/model metadata and aliases. Its `0` price alone never
admits a route. Promotional credits, development endpoints, paid APIs, product-only access and
legal-review-required routes are excluded.

## Canonical model contract

`canonicalIdentityFor` collapses equivalent provider model IDs into a stable canonical identity.
The picker presents one model and its ready-route count; a route retains provider-native model ID,
credential source, price evidence, health, quota, capability and qualification state. ForgeAuto
selects routes, first preferring a healthy alternate for the current canonical model.

## Registry snapshot

The snapshot includes canonical models, their route details, readiness, summary counts, connection
state, qualification state and route diagnostics. It is consumed by desktop model sections and
Provider Connections. It deliberately omits all credential values.

## Evidence

- Implementation: `packages/model-registry/src/free-cloud-registry.ts`
- Stateful registry service: `packages/model-registry/src/free-cloud-service.ts`
- Canonical normalization: `packages/model-registry/src/canonical.ts`
- Tests: `packages/model-registry/test/free-cloud-registry.test.ts`
- Focused test run on 2026-09-13: 74 passed across the new registry/desktop suite.
