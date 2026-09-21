# M14E-2 — Capability vs usable supply, per route (ledger-measured, 2026-09-21 ~11:00Z)

Source: every served call in `raw/qualification/*.json` (prescreen + rounds 1–8 nemotron, rounds 1–2 groq),
computed by the session's `capacity-model.mjs` (scratchpad; numbers reproduced here). Round 3 (groq) is
appended when it lands. "Verifier-passed run" = deterministic verifier passed even if the run later died
on the provider (capability signal); "verified task" = protocol `verified_complete` (reliability + capability).

## Per-route measurements

| Route | Runs | verified_complete | verifier-passed | per-call failure rate | tokens / verified task (median · p90) | prompt share | calls / run (median · p90) | median call latency | median wall |
|---|---|---|---|---|---|---|---|---|---|
| openrouter::nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free | 23 | 7 | 9 | **28.9%** (56/194) | 40 962 · 80 792 | 0.90 | 7 · 15 | **5.2 s** | 52 s |
| groq::openai/gpt-oss-120b | 4 | 0 | 3 | 11.4% (8/70, all through the adapter blind spot — F1) | — (36 565 · 48 680 per verifier-passed run) | 0.94 | 18 · 22 | **0.63 s** | 675 s (≈ 93% governor pacing — F2) |
| groq::openai/gpt-oss-20b (rounds 4–5) | 4 | 3 | 4 | 9.6% (5/52: 4 model-side tool rejections, 1 governor-caused 429 — fixed) | 17 878 · 42 441 (3 verified tasks: 42.4k / 17.9k / 14.3k) | 0.93 | 11 · 21 | ~0.5 s | 423 s (round 4, 60 s pacing) → 292 s (round 5, header-paced, 21 s active) |
| openrouter::inclusionai/ling-3.0-flash-vl:free | 2 | 0 | 1 | 25% | — | 0.98 | 6 | 1.7 s | 15 s |

Readings:

- **Capability is not the blocker on either serious route.** Nemotron verified 7 tasks; gpt-oss-120b passed the
  verifier on 3 of 4 runs and answers ~8× faster per call. What kills runs is supply: Nvidia's shared 16-slot
  worker (F3) and — until F1 — an adapter that could not say what Groq had said.
- **Prompt share 0.90–0.94**: 9 of every 10 tokens are re-transmitted context. That is ForgeGreen's target
  surface (context planner / canonical cache), and it is why token-capped free routes (Groq, Cloudflare) are
  so much smaller in *tasks* than their headline token numbers suggest.

## Usable supply per pool (tasks/day, at the measured ~41k tokens or ~15 calls per verified task)

| Pool | Cap | Per task | Tasks/day | State today |
|---|---|---|---|---|
| OpenRouter `:free` (deposit-unlocked) | 1 000 requests/day | 15 calls (p90) | **~66** | upstream saturated at 10:32Z; usable only in clean windows; multi-tenant managed use not terms-cleared (M14C) |
| Groq free tier, gpt-oss-120b | 200 000 tokens/day, continuous refill (8.3k/h) | ~37–41k tokens | **~5** | not qualifiable (§2.2(c), 11–17% malformed calls); owner-dev credential (not a public pool) |
| Groq free tier, gpt-oss-20b (separate bucket) | 200 000 tokens/day, continuous refill | ~18–42k tokens (median 18k) | **~5–11** | 3/3 verified, not qualified (§2.2(c), ~10% malformed calls); per-model buckets mean Groq ≈ 10–16 tasks/day across both |
| Cloudflare Workers AI, if Workers Free is attested | 10 000 neurons/day hard-stop | ~1 400 neurons (list-price conversion: $0.35/M in, $0.75/M out, $0.011 per 1k neurons) | **~7** | fail-closed: plan and usage unreadable with the current token (F6) |
| **All managed pools, optimistic** | | | **~83–89 tasks/day ≈ 28–30 DAU at 3 tasks/user/day** (none qualified today) | |

User-connected entitlement (per user, not pooled): GitHub Copilot Free ≈ 50 premium requests/month ≈ 1.6
agent tasks/day/user; Copilot Pro ≈ 300/month ≈ 10/day/user (each agent task ≈ one premium request at 1×
models; read-only proof in M14A-2 — no inference measured yet).

## Scenarios (3 tasks/user/day; managed capacity 78/day optimistic)

| DAU | tasks/day | managed capacity | blocked share | Copilot Free users needed to cover the gap | Copilot Pro users |
|---|---|---|---|---|---|
| 10 | 30 | 78 | 0% | 0 | 0 |
| 25 | 75 | 78 | 0% | 0 | 0 |
| 50 | 150 | 78 | 48% | 45 | 8 |
| 100 | 300 | 78 | 74% | 139 | 23 |
| 373 | 1 119 | 78 | 93% | 651 | 105 |

Conclusions (unchanged in direction from M14E, now with token-side evidence):

1. Managed free capacity is dev-scale (≈ 26 DAU ceiling with every pool healthy, which none is today).
2. Above ~25 DAU the product is only "free" if users bring entitlement: a 50-DAU deployment needs roughly
   half its users on Copilot Free (or ~8 on Pro) just to break even. This is the case for the
   User-Connected supply class, built on official per-user SDKs, never on pooled owner credentials.
3. Reducing prompt share is worth more than any single new pool: at prompt share 0.90, halving re-transmitted
   context (≈ −45% tokens/task) lifts Groq from ~5 to ~9 tasks/day and Cloudflare from ~7 to ~13 — the same
   gain as adding a whole second Groq account.
4. ForgeAuto must weight routes by *usable tasks*, not intelligence: nemotron (7 verified, 5 s/call, 29%
   call failures) and gpt-oss-120b (0.6 s/call, 11% → to be re-measured after F1) are both capable; neither
   is currently a public route.
