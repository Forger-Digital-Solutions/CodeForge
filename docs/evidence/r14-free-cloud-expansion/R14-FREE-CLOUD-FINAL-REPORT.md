# CodeForge R14 Free Cloud Final Report

Date: 2026-09-18
Starting commit: `b65c94a`
Scope: free-cloud capacity activation and certification; no push, deploy, purchase, DNS change,
production database change, or GEMS work.

## Executive verdict

`CODEFORGE_FREE_CLOUD_CAPACITY_R1_CERTIFIED = NO`
`CODEFORGE_FREE_BENCHMARK_CAPACITY_READY = NO`
`CODEFORGE_OWNER_DEV_CONTINUITY_READY = NO`

R14 produced a better evidence boundary and a stricter physical-capacity model, but it did not
produce a certifiable Managed Free fleet. The production roster remains empty. Ollama's live Free
usage is now recorded as a bounded owner-only candidate, not silently promoted into public routing.

## Provider decisions

| Provider | Current result | Exact approved models | Roles | Supply / capacity decision |
|---|---|---|---|---|
| Cerebras | `TRIAL_CREDIT_ONLY` | None | None | `$5` trial and non-zero model pricing; excluded |
| Groq | `POLICY_REVIEW` | None in R14 | None in R14 | Useful live limits, but managed intermediary terms and shared-pool identity are unresolved |
| Kilo | `QUARANTINED_PENDING_EVIDENCE` | None | None | Exact `:free` candidates observed, but privacy, terms, and client-direct safety are incomplete |
| Gemini Developer | `POLICY_REVIEW` | None | None | Tier 1 limits observed; unpaid state and private-code policy prevent approval |
| Mistral | `COMPATIBILITY_TEST` | None | None | Free allowance is account-dependent and current data setting permits training |
| Cloudflare Workers AI | `PAID_ACCOUNT_EXCLUDED` | None | None | Workers Paid account can bill above the daily allocation |
| OpenRouter | `CAPACITY_PROBE` | None | None | Exact `:free` only; existing `$25` balance is deposit-unlocked reserve, not default Managed Free |
| Ollama Cloud | `QUARANTINED_PENDING_EVIDENCE` for Managed Free | None for Managed Free | None for Managed Free | Six Free-plan models, 0% used, five-day reset, one concurrency, `$0` usage credits, auto-reload off; managed automated use and hard-stop behavior not certified |
| Google Cloud | `NOT_CONFIGURED` | None | None | Owner credit reserve not inspected/configured in this pass |
| Azure | `NOT_CONFIGURED` | None | None | Owner credit/free quota reserve not inspected/configured in this pass |

Provider cards: [providers/](providers/). Account evidence: [ACCOUNT-CAPACITY-CARDS-2026-09-18.md](ACCOUNT-CAPACITY-CARDS-2026-09-18.md).

## Answers to the certification questions

1. Investigated: Cerebras, Groq, Kilo, Gemini Developer, Mistral, Cloudflare Workers AI,
   OpenRouter, Ollama Cloud, and the Google Cloud/Azure owner-reserve boundaries.
2. Recurring Free with useful account evidence: Groq allowance candidate, Gemini unpaid-tier
   candidate, Mistral Free mode, Kilo exact `:free` per-user/IP candidate, and Ollama included Free
   usage. None passed all Managed Free gates.
3. Temporary/credit-only: Cerebras trial; Mistral's included dollar allowance; Ollama usage
   credits after included usage; Google/Azure reserves were not configured.
4. Deposit-required: OpenRouter's higher `:free` allowance is unlocked by the existing `$25`
   balance; no new deposit was made.
5. Managed end-user traffic permitted: none newly certified in R14.
6. Private repositories permitted: none newly certified in R14.
7. Exact approved models: none for ForgeAuto/Free. Ollama's six Free-plan model names are recorded
   as an owner-only candidate only.
8. Approved roles: none for the R14 production roster.
9. Actual account quotas: captured in the provider cards; the strongest current observations are
   Groq 30 RPM / 1,000 RPD / 8,000 TPM / 200,000 TPD per listed model, Cerebras model-specific
   trial limits, Gemini Tier 1 model limits, and Ollama one concurrent request.
10. Shared limits: Groq project inherits organization limits; Mistral Free mode shares Studio/API/
    Vibe Code; Cloudflare's neuron allocation is account-level; Ollama is owner-account scoped.
11. Per-user/IP limits: Kilo's official gateway evidence records 200 requests/hour/IP.
12. Independent production pools: `0` approved; `1` owner-only Ollama candidate; several
    unapproved account/project candidates remain explicitly uncounted.
13. Normal-state production capacity: `0` certified Managed Free task units/day.
14. Practical verified tasks/day: not certifiable; strict production estimate is `0` until at
    least one route passes policy, privacy, qualification, and runtime capacity gates.
15. Owner all-day development: not ready; Ollama's one-concurrency/unknown-token pool is not an
    all-day guarantee.
16. Task-capacity survival: not measured because no R14 production campaign was launched.
17. First-use capacity success: not measured; no false success is asserted.
18. 373-DAU simulation: not ready to run against real approved pools; current approved capacity is
    zero, so the scenario fails closed.
19. Full benchmark: cannot be completed under current evidence.
20. Benchmark preflight: `INSUFFICIENT_CAPACITY`, safe task units `0`, pools `0`, providers `0`.
21. Actual benchmark: not run, by the absolute preflight gate.
22. Quota exhaustion: no R14 benchmark exhaustion occurred; existing provider exhaustion evidence
    remains preserved separately.
23. Failovers: `0` in R14 because no benchmark was dispatched.
24. ForgeGreen capacity saved: no new live-task measurement; the preflight prevented a knowingly
    doomed 40-case campaign.
25. Ollama: still quarantined for Managed Free; bounded `OWNER_DEV_FREE` candidate only.
26. Cerebras: not approved; trial credit only.
27. Kilo distributed Free: not approved; exact candidates are recorded pending policy/privacy proof.
28. Gemini: not approved; Tier 1 limits do not prove an unpaid, private-code-safe managed route.
29. Mistral: not approved; account allowance and data-use state remain gating facts.
30. OpenRouter reserve: classified as exact-`:free` / deposit-unlocked reserve; not default Managed Free.
31. Google/Azure owner reserves: not configured.
32. Money spent by R14: `$0`.
33. Paid credits consumed by R14: none. The pre-existing OpenRouter balance was observed, not used;
    the Ollama account showed `$0` usage-credit balance and Auto-reload Off.
34. Remaining weakness: no provider currently combines a certified, recurring $0 entitlement,
    safe private-code policy, cleared managed-use terms, exact pinned model, role qualification,
    and authoritative multidimensional capacity in this checkout.

## Safety and regression result

- `OWNER_DEV_FREE` is now an explicit economic class and is fail-closed from Managed Free.
- Capacity accounting now accepts `concurrency`, `credits`, and `provider_units` dimensions;
  concurrency reservations are enforced when observed.
- A concurrency-only reservation failure no longer reports the unrelated first-run reserve reason.
- 31 focused tests passed across ForgeZero, model-registry, 8-Bit, and capacity chaos/packaging
  suites after the change.
- ForgeZero, model-registry, and 8-Bit typechecks passed through the real Node/npm installation.
- Full Vitest passed: 359 files, 2,711 tests; 7 files and 36 tests skipped.
- Workspace build passed, including desktop and web bundles.
- The guarded source-state reconciliation corrected two pre-existing manifest hashes before the
  clean full-suite run; it did not modify those production files.
- Lint remains blocked by five pre-existing `--deny-warnings` findings outside the R14 files.
  The repository secret scan remains `REVIEW_REQUIRED` for the existing
  `docs/security/key-management-and-rotation.md:62` owner-review item, and the documentation link
  checker retains its existing 34 broken-link findings. No R14 evidence file contains a secret.
- `0` false completion and `0` paid fallback remain the governing result.

## Certification

The correct R14 certification is conditional/not certified. The next safe activation sequence is to
obtain explicit managed-use permission and hard-stop evidence for a candidate, then record live
response-header quota dimensions and role qualification before adding any physical pool. No provider
should be promoted because a dashboard labels a balance or allowance “Free.”
