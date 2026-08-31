# Repository Intelligence Benchmarks

The reproducible generator is `scripts/repository-intelligence-certify.mjs`. It creates temporary TypeScript monorepositories containing deterministic modules, imports, tests, irrelevant noise, and known needle symbols. Generated repositories and indexes are removed after each run and are not committed.

Machine: Intel Core i7-9850H, 34.1 GB RAM, Windows x64, Node v24.19.0. Measurements were taken on 2026-08-31. Peak RSS is sampled at index progress boundaries. Index size includes SQLite, WAL, and sidecar files before close.

| Tier | Files | Symbols | Edges | Initial index | Peak RSS | Index size | Query p50 / p95 | Incremental | Recall@5 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100K LOC | 103 | 200 | 101 | 0.90s | 113.8 MB | 8.69 MB | 0.81 / 0.91 ms | 85 ms (optimized retest) | 1.00 |
| 500K LOC | 507 | 1,000 | 509 | 7.05s | 114.7 MB | 44.12 MB | 1.77 / 2.90 ms | 840 ms (pre-optimization) | 1.00 |
| 1M LOC | 1,012 | 2,000 | 1,019 | 21.61s | 116.7 MB | 86.83 MB | 2.77 / 4.29 ms | 1.47s (pre-optimization) | 1.00 |
| 4M LOC | 4,042 | 8,000 | 4,079 | 306.24s | 138.8 MB | 348.03 MB | 12.99 / 33.88 ms | 313 ms | 1.00 |

All tiers completed the initial-index, RSS, retrieval, incremental, and Recall@5 targets. The first 4M run measured a failing 5.30s explicit refresh; after requested-path isolation, the full 4M rerun measured 313ms.

At every tier, 16K, 32K, 64K, and 128K packs included the target implementation, direct dependency, and related test, had complete freshness/provenance, and reported zero budget overflows in the seeded corpus.

## CodeForge self-index

The final clean-source self-index discovered 463 files, indexed 22,088 symbols and 1,388 edges in 3.49s, used 151.3 MB peak RSS, produced a 26.49 MB index, and had zero parser failures. Thirty warm mixed queries measured 59.69ms p50 / 213.78ms p95. The six architectural known-answer queries measured Recall@1 0.50, Recall@5 0.8333, Recall@10 1.00, and MRR 0.6435. Top results were manually relevant; the one expected implementation outside Top 5 (`approval-service.ts`, rank 9) followed `ApprovalBar`, server integration, and lifecycle documentation, while `approval-lifecycle.test.ts` was also directly retrieved.

## Deterministic A/B harness

On the same 1,001-file token-expiration replay task, bounded lexical exploration without intelligence opened 778 files, 777 irrelevant files, made 778 read calls, accumulated 1,145,775 bytes, and took 462ms. With intelligence, the harness opened the implementation and related test only, made two retrieval calls, accumulated 298 selected bytes / 259 estimated context tokens, and took 158ms. Both paths found the target. This is a deterministic agent-retrieval comparison, not a claim about a remote provider/model run.

Run examples:

```powershell
npm run repo-intelligence:certify
node scripts/repository-intelligence-certify.mjs --tier=100K
node scripts/repository-intelligence-certify.mjs --tier=500K
node scripts/repository-intelligence-certify.mjs --tier=1M
node scripts/repository-intelligence-certify.mjs --tier=4M
```
