# R47 §13 — Managed-Pool Account Identity Contract

## The contract

Managed fleet capacity is keyed on a stable logical quota-domain identifier:

```
managed:<providerId>:<accountId>                (pool registration)
quota bucket: <providerId>::<accountId>::<modelId>   (observations)
```

Rules:

1. **Stable** — the `accountId` is a configured logical identifier (`live-acct-groq`,
   `managed-primary`, a provider account resource id). It survives restarts and is identical
   between `registerManagedPool(providerId, accountId)` and every response observation that
   account serves.
2. **Non-secret** — never an API key, never derived from one. It may appear in logs, receipts,
   pool ids, and diagnostics.
3. **Scoped correctly** — one credential = one account id = one quota domain. Two accounts on
   the same provider get distinct ids; their windows never mix.
4. **Declared before use** — `registerManagedPool` must exist before an adapter is handed the
   identity.

## Enforcement

`freeCloud.managedAccountObserver(providerId, accountId)` is the canonical stamping seam:

- Throws when `managed:<providerId>:<accountId>` is not registered — an adapter can never
  carry an undeclared quota identity (construction-time contract, not convention).
- Returns a `ProviderResponseObserver` that stamps `accountId` onto every observation before
  it reaches `onProviderResponse`.

Host wiring is therefore:

```ts
freeCloud.registerManagedPool("mistral", "live-acct-mistral");
createProviderAdapterById("mistral", {
  onResponse: freeCloud.managedAccountObserver("mistral", "live-acct-mistral"),
});
```

## §14 — fail closed on unmatched evidence

When a provider has managed pools registered, a response observation is **attributed** only
if `obs.accountId` matches a registered account:

- Missing `accountId` → recorded to the unscoped bucket (still usable by owner/user paths that
  legitimately query unscoped), counted in `unattributedManagedEvidence`, invisible to managed
  pools.
- Unknown `accountId` → recorded to the stranger bucket, counted as a gap.
- Managed queries (`quota.get(provider, model, accountId)`, `hasProviderScoped`) no longer
  fall back to the unscoped bucket — the previous fallback let every managed account inherit
  the same unattributed evidence, double-counting one window as N accounts' worth.

Admission consequence: a pool with no attributable evidence keeps empty windows → the
reservation ledger denies `CAPACITY_EXHAUSTED` — fail closed, as required.

Diagnostics: `freeCloud.capacityEvidenceGaps()` returns per-provider `{count, lastAt,
lastModelId}` — safe metadata only, no secrets.

## Test proof

`free-cloud-registry.test.ts` R34 Mission B block:

- stamped observations land only on their own pool (pre-existing);
- unstamped observations feed no managed pool and record a gap;
- stranger-account observations feed no managed pool and record a gap;
- `managedAccountObserver` throws for undeclared accounts and stamps correctly for declared.

## Remaining seams

- `apps/desktop/src/main.ts` wires `onResponse: freeCloud?.onProviderResponse` directly
  (owner/user-connected capacity — unscoped by design; desktop registers no managed pools).
- Anthropic/Opencode adapters accept no `onResponse` — they emit no quota evidence at all.
  Out of scope for 8-Bit (anthropic is paid-only; opencode is a separate gateway path).
- `packages/paid-auto` adapters carry their own telemetry (`PaidAutoAttemptRecord`); the
  16-Bit spend ledger is Phase B work.
