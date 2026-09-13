# CodeForge Free Entitlement and Usage

CodeForge Free is a server-enforced entitlement, not a promise that an upstream model is always
available. The Cloud creates a per-user UTC calendar-month allowance period, returns its exact
start/end values, and charges only the authenticated user after a hosted request settles. Active
reservations reduce what that user can begin; idempotent request identity prevents double charging.

The local R1 certification rig proves these mechanics with two loopback OAuth identities and the
deterministic `devpool` provider. It proves no real provider capacity, model quality, or provider
authorization. The R1 production-capacity gate remains
`REAL_MANAGED_FREE_PROVIDER_CAPACITY_BLOCKED`.

