# R38 — Live Free-Supply Inventory (LIVE_FREE_PROVIDER)

Captured 2026-09-26 via real `createFreeModelCatalogRefresh` against OpenRouter
(`OPENROUTER_API_KEY` present; opencode adapter skipped — no `OPENCODE_API_KEY`).
Raw artifact: `inventory-raw.json`.

## Refresh result

- Registry source: `live`, 1,810 models scanned
- Verified free (zero-unit pricing): **21 models**, all `openrouter/*`
- Allowance-verified: 0 (probes not run for allowance class)
- Registered into ForgeZero: 21
- Errors: 0, refresh wall time ~1.2s

## Live probe results (`live-probes.json`)

| Model | Result | Latency | Usage |
|---|---|---|---|
| `openrouter/free` (auto pool) | OK | 1,174ms | 23 in / 28 out, cost $0 |
| `cohere/north-mini-code:free` | OK | 316ms | 7 in / 8 out, $0 |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | OK | 1,149ms | 23 in / 8 out, $0 |
| `qwen/qwen3.8-27b:free` | **RATE_LIMITED** | 163ms | — |

Real behavioral truth already visible: catalog-listed ≠ schedulable — `qwen3.8-27b:free`
is catalog-verified free but live-rate-limited on this account. Two catalog entries are
non-text (lyria-3 audio/image previews, tools=false) and one is content-safety-only —
verification correctly keeps them eligible only for what they can actually do.

## Supply shape

- Context: 1 model at 1M+ (stealth/space-bunny-alpha, nemotron-3.5-lightning, inkling*,
  nemotron-3-ultra, lyria*), most at 256–262k, smallest 65k (lfm-2.5-2.6b).
- Tool calling: 18/21 capable; 3 not (content-safety, 2× lyria preview).
- Single provider: all verified-free supply this campaign routes through OpenRouter —
  provider-domain concentration is a real fragility (see R38-SUBAGENT/SCALE notes).

## Live failover measurement (`live-failover.json`, Phase 4)

Real chain: `qwen3.8-27b:free` → HTTP 429 (adapter classifies `RATE_LIMITED`, 413ms)
→ `cohere/north-mini-code:free` served (296ms). **Total failover path: 710ms end-to-end.**
Classification is in-process (<1ms); the delay is entirely provider round-trips —
no artificial backoff was imposed by the adapter path measured.
