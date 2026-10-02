# Sponsor operator deployment

`CodeForgeCloudServer` exposes `/v1/free-capacity/sponsor/*` only after bearer authentication. A deployment enables the lifecycle by supplying `sponsorOperatorPolicy` in its trusted server composition. Without this configuration the endpoints return `SPONSOR_OPERATOR_NOT_CONFIGURED`; no sponsor route exists.

The policy contains three server-side capabilities:

- `scopesForUser` maps an authenticated CodeForge user to provider/model/concurrency scopes approved by the deployment. Requests cannot choose their own allowed scopes.
- `verify` independently checks the provider's grant, current funding and quota, terms/privacy document hashes, model capabilities, role qualification and canary receipts. It returns a receipt bound to the complete signed manifest digest and a stable physical wallet independence key. A sponsor's signature and zero-cost declarations alone cannot qualify an offer.
- `execute` invokes the exact provider/model through the deployment's sponsor credential. It receives the admitted route, authenticated user, bounded request and cancellation signal. Credentials remain in the host. The callback must enforce provider-native output limits and cancellation, and must never consult an ambient paid or BYOK fallback. The original provider is available on `route.upstreamProvider` and `route.gateway`; `route.providerId` is the isolated sponsor wallet adapter identity.

The server already requires a durable `SecretEnvelopeService` in production. The sponsor registry uses the same driver-neutral session persistence as remote transport, including PostgreSQL row locking and SQLite transaction serialization. Requests and results use tenant/record-bound encrypted envelopes. Signing public keys are public; provider credentials never enter manifests or operator API bodies.

The lifecycle HTTP calls are:

1. `POST operators` with `operatorId`.
2. `POST operators/{operatorId}/keys` with an Ed25519 public key, `keyId`, `validFrom`, and `validUntil`. Optional `rotateKeyId` revokes the prior key and suspends its offers atomically.
3. `POST manifests` with a version-1 signed manifest. The receipt is `INERT` until verification. Increasing `sequence` supersedes an older version; immutable audit events retain the submitted signed manifests.
4. `POST offers/{operatorId}:{offerId}/verify` runs the trusted independent verifier. The API does not accept verification receipts from operators.
5. `POST execute` queues `{ offerId, requestId, role, request }` against admitted private-safe, role-qualified capacity. `request.maxTokens` is mandatory; request-level fallback, dispatch identity and arbitrary metadata are refused. `GET results/{requestId}` is scoped to the authenticated requesting user.
6. `POST operators/{operatorId}/keys/{keyId}/revoke`, `POST operators/{operatorId}/revoke`, or `POST offers/{operatorId}:{offerId}/revoke` withdraws admission. Expired signer, manifest, quota observation, qualification or independent verification also removes supply. Verification must renew the evidence before use resumes.

For normal `forge serve` execution, pass the initialized service as `ServerOptions.sponsorCapacitySource`. The server merges admitted routes/pools into its actual Free Fabric and registers only their receipt-derived models and context-bound provider adapters. Both the Fabric and its reservation ledger explicitly enable sponsored supply only when this trusted source is supplied. This composition can coexist with `freeCloud`. A local interactive client's JSON `userId` cannot replace the configured host identity; trusted internal hosted dispatch can supply its authenticated user.

The scheduler caps total dispatch workers at eight, honors the verified wallet concurrency ceiling, and allows only one active dispatch per user per wallet. Waiting users rotate in stable round-robin order. Offers sharing the same verified wallet share counters and one pool/adapter identity. Reservations debit conservative bounds before dispatch; unknown or cancelled outcomes are never refunded speculatively or replayed after a lost lease. Provider-specific unit quotas require an independently verified per-request upper bound. Terminal jobs and idempotency receipts are retained for 24 hours, with a hard bounded registry/queue size. Audit receipts outlive this queue retention.

Operator composition requires a real external sponsor grant and provider-specific independent verification/execution implementation. The repository does not ship a grant, pre-enrolled operator, or ambient credential shortcut. R63's operator/runtime tests use explicitly marked scripted providers; they are deployment and lifecycle proofs, not live funding or inference evidence.
