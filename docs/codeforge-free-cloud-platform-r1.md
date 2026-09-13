# CodeForge Free Cloud Platform — R1 Implementation Record

**Status:** implementation and focused regression coverage are complete; packaged fresh-profile,
OAuth-browser, and real provider execution certification remain outstanding. This document does
not claim `CODEFORGE_FREE_CLOUD_PLATFORM_R1_CERTIFIED`.

R1 centralizes provider facts in `ProviderDefinition`, distinguishes canonical models from
provider routes, gates all ForgeAuto/Free selection through current zero-cash evidence and
ForgeZero, provides main-process-only environment credential discovery, and adds schema-driven
manual provider connection. OpenRouter retains its existing PKCE flow; it stores the resulting key
through the encrypted desktop credential store.

On a route failure, 8-Bit normalizes the provider error, observes retry-after/quota state,
applies cooldown, and asks the route-aware router for a replacement. It prefers a qualified route
for the same canonical model before an eligible cross-model route. Failover changes only future
model execution and carries forward recorded tool observations; it does not replay completed
mutating tool calls.

The desktop presents one canonical model row rather than duplicate provider/model rows. Provider
Connections presents environment detection, policy, free-plan attestation where needed, connection
source, manual validation/catalog selection, disconnect and diagnostics without showing a secret.

Evidence after continuation:

- `npm.cmd run build` completed the workspace and desktop build.
- Focused new suite: 5 files / 74 tests passed.
- Broader provider, registry, 8-Bit and desktop suite: 38 files / 361 tests passed; 2 PostgreSQL
  tests skipped because no PostgreSQL integration is configured.
- A public OpenRouter catalog discovery check found 22 current zero-price candidates; no candidate
  was treated as automatically qualified or admitted.

The full-suite command was started with serialized execution but did not return a terminal summary
through the current execution channel, so no aggregate full-suite pass total is recorded here.
