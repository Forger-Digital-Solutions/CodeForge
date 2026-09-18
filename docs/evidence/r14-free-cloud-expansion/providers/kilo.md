# Kilo Gateway — R14 provider card

- Account/tier: no active subscription; profile shows `$0.00` remaining credits.
- Supply candidate: `DISTRIBUTED_USER_FREE`; per-user/IP only, not owner-pool capacity.
- Exact free models observed: `poolside/laguna-s-2.1:free`, `cohere/north-mini-code:free`,
  `dots-studio/dots-3-note-preview:free`, and `stepfun/step-3.7-flash:free`.
- Excluded: `openrouter/free` auto-router; `tencent/hy3:free` marked unavailable.
- Limits: official gateway documentation records 200 free requests/hour/IP; model-specific token,
  concurrency, and reset data were not captured.
- Privacy/policy: exact-model provider privacy, automated/client use, and private-code policy are
  unresolved. No central proxy or identity manipulation is implemented.
- Verdict: `QUARANTINED_PENDING_EVIDENCE`; server-managed and distributed-client verdicts remain
  separate, with `KILO_DISTRIBUTED_FREE_CERTIFIED = NO`.
- Provenance: authenticated Kilo profile, 2026-09-18; Kilo Gateway models/providers and usage docs.
