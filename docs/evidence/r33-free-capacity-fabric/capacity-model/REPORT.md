# R33 executable capacity and economics model

Source: R32 summary SHA-256 `3268652e29951e62d1a05e362f4b0a21245b646a4d4f4644b265ffd0982cb36c`; 7 receipts.

Run: `node docs/evidence/r33-free-capacity-fabric/capacity-model/run.mjs`.

## Evidence and limits

- R32 observations are seven task attempts over 5 distinct source tasks, all OpenRouter; zero autonomous acceptance passes.
- Measured token counts are lower bounds when a request omitted usage; no imputation is performed.
- Observed wall times include tool and waiting time, and are not a validated production arrival distribution.
- Measured task class proxies and multiplied profiles are not population estimates.
- Parallel generation, GPU throughput and hourly cost, API price, duty cycle, and credit calculations are sensitivities, not measured provider capacity or quotes.
- Zero certified domains means no capacity has been certified in this model, not that actual provider supply is zero.

Input parameters are in `config.json`; all outputs are in `results.json`. The default scenario is 100% continuously active users. The 25% and 5% duty cycles are sensitivity checks, not alternative meanings of simultaneous active users.

## Workload profiles

| Profile | Basis | Samples | Requests/task | Input tokens/task | Output tokens/task | Duration (s) | Unknown-usage requests |
|---|---|---:|---:|---:|---:|---:|---:|
| small_bug_fix | R32 receipt median | 2 | 26 | 117435.5 | 14024 | 730.656 | 8 |
| normal_coding | R32 receipt median | 7 | 24 | 128384 | 10032 | 276.393 | 23 |
| large_feature | R32 receipt median | 2 | 18.5 | 103551 | 9841 | 685.68 | 1 |
| light_chat_question | assumption | 0 | 2 | 2000 | 500 | 90 | N/A |
| autonomous_multistep | assumption | 0 | 48 | 256768 | 20064 | 552.786 | N/A |
| subagent_heavy | assumption | 0 | 96 | 513536 | 40128 | 1105.572 | N/A |

## Normal coding at continuous concurrency

| Active users | Requests/min | Input tokens/s | Output tokens/s | Tokens/day | Parallel generations (12 s assumption) | GPUs at 300 output tok/s, 70% use | Monthly API cost, middle illustration | Certified supply |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 5.21 | 464.498 | 36.296 | 43,268,615.341 | 2 | 1 | $801.12 | NOT_CERTIFIED |
| 10 | 52.1 | 4,644.98 | 362.961 | 432,686,153.412 | 11 | 2 | $8,011.23 | NOT_CERTIFIED |
| 100 | 520.997 | 46,449.802 | 3,629.614 | 4,326,861,534.12 | 105 | 18 | $80,112.29 | NOT_CERTIFIED |
| 1,000 | 5,209.973 | 464,498.016 | 36,296.144 | 43,268,615,341.199 | 1,042 | 173 | $801,122.92 | NOT_CERTIFIED |
| 10,000 | 52,099.728 | 4,644,980.155 | 362,961.435 | 432,686,153,411.99 | 10,420 | 1,729 | $8,011,229.23 | NOT_CERTIFIED |
| 100,000 | 520,997.276 | 46,449,801.551 | 3,629,614.353 | 4,326,861,534,119.895 | 104,200 | 17,284 | $80,112,292.28 | NOT_CERTIFIED |
| 1,000,000 | 5,209,972.756 | 464,498,015.507 | 36,296,143.535 | 43,268,615,341,198.95 | 1,041,995 | 172,839 | $801,122,922.79 | NOT_CERTIFIED |

## Reading the figures

The model computes steady-state task starts as active users × duty cycle ÷ observed task duration. It then multiplies by requests and tokens per observed task. It assumes 24-hour continuous arrival for daily demand and 730 hours for monthly cost. Required parallel generations use Little’s law with a configurable 12-second request occupancy. GPU counts are output-throughput lower bounds and omit prefill, memory, context, scheduler, redundancy, and network constraints. They are not deployable fleet sizing.

The certified-supply list is empty pending live organization quota evidence and commercial multi-user permission. Consequently the model cannot honestly answer how many simultaneous users CodeForge can serve today. It can quantify demand; the inventory and live probe must quantify supply.

The price examples, $1,000/$50,000/$350,000 credit amounts, GPU rates and paid conversion margins are unverified sensitivity inputs. No credits or paid revenue are claimed. Credit runway assumes one normal coding task per DAU and the observed R32 token mix; results are not a promise of autonomy or task success.
