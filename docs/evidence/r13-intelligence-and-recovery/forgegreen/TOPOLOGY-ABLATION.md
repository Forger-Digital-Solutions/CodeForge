# R13 ForgeGreen topology ablation (1 / 2 / 4 agents)

Generated 2026-09-18T06:24:30.718Z. **This is a deterministic model with explicitly stated assumptions, not measured production telemetry** — no real task was executed, no provider was called. Production topology planning caps at 2 parallel agents today (`resolveAdaptiveTopology`); this ablation exists to inform whether going wider would ever be justified, and to prove the real `adviseProviderAwareTopology` function makes the right call before any such topology is proposed.

## Per-task-class results

### tiny-fix
One-line/typo-shaped fix with a single obvious target file.

| Agents | Tool calls | Context tokens | Latency (s) | Conflict risk | Verified-success (modeled) | Marginal resource cost | Marginal success gain | Marginal latency change |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 3 | 6000 | 15 | 0.0% | 95.0% | 0 | 0.0% | 0s |
| 2 | 6 | 12000 | 15 | 0.0% | 95.0% | 9 | 0.0% | 0s |
| 4 | 12 | 24000 | 15 | 0.0% | 95.0% | 18 | 0.0% | 0s |

**Verdict:** 2 agents: no meaningful success or latency gain over the previous step, for +9 resource units — pure added cost. 4 agents: no meaningful success or latency gain over the previous step, for +18 resource units — pure added cost.

### multi-file-investigation
Bug reproduction spanning ~4 plausibly-independent hypotheses/files.

| Agents | Tool calls | Context tokens | Latency (s) | Conflict risk | Verified-success (modeled) | Marginal resource cost | Marginal success gain | Marginal latency change |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 12 | 18000 | 120 | 0.0% | 65.0% | 0 | 0.0% | 0s |
| 2 | 24 | 36000 | 75 | 0.0% | 75.0% | 30 | 10.0% | -45s |
| 4 | 48 | 72000 | 52.5 | 0.0% | 83.5% | 60 | 8.5% | -22.5s |

**Verdict:** 2 agents: +10.0pp modeled success and 45s faster, for +30 resource units. 4 agents: +8.5pp modeled success and 22.5s faster, for +60 resource units.

### cross-cutting-refactor
Rename/shape change touching many files with shared state; edits, not just reads, parallelize.

| Agents | Tool calls | Context tokens | Latency (s) | Conflict risk | Verified-success (modeled) | Marginal resource cost | Marginal success gain | Marginal latency change |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 20 | 25000 | 165 | 0.0% | 55.0% | 0 | 0.0% | 0s |
| 2 | 40 | 50000 | 105 | 12.0% | 59.2% | 45 | 4.2% | -60s |
| 4 | 80 | 100000 | 85 | 22.6% | 59.8% | 90 | 0.6% | -20s |

**Verdict:** 2 agents: +4.2pp modeled success and 60s faster, for +45 resource units. 4 agents: 20s faster with no meaningful success change, for +90 resource units.

## Provider-concentration proof (real ForgeGreen function, not a mock)

| Scenario | distinctHealthyProviders | minConcurrency | Planned 4 → recommended | Planned 2 → recommended | Reason codes (4-agent case) |
|---|---:|---:|---:|---:|---|
| diverse-capacity | 4 | 4 | 4 | 2 | PROVIDER_CAPACITY_DIVERSE |
| two-provider-capacity | 2 | 4 | 2 | 2 | PROVIDER_CONCENTRATION |
| concentrated-one-provider | 1 | 4 | 1 | 1 | PROVIDER_CONCENTRATION |
| one-saturated-route-present | 2 | 2 | 2 | 2 | SATURATED_ROUTE_EXCLUDED, CAPACITY_CONCURRENCY_LIMIT, PROVIDER_CONCENTRATION |

## Why concentration matters even if you ignore the advice

For `multi-file-investigation` under `concentrated-one-provider`, ForgeGreen recommends 1 agent(s) instead of the planned 4. Modeled cost if the plan is followed as advised: 120s latency, 30 resource units — versus 52.5s and 120 resource units if 4 agents were dispatched anyway. Following ForgeGreen's advice here saves resource cost for the same (or better, since the ignored 4-agent plan would have queued behind one provider's real concurrency ceiling anyway) realistic outcome.

## Headline conclusions

- Some tasks (tiny-fix) are correctly modeled as single-agent-best: extra agents add pure resource cost with zero modeled success benefit — 4 agents is never justified for this class.
- Tasks with genuinely independent subtasks (investigation, cross-cutting refactor) show real, diminishing marginal value from parallelism, capped by how many independent subtasks actually exist — not by agent count alone.
- Editing (not just exploring) in parallel carries a modeled conflict-risk cost that erodes the success-probability benefit as more agents write concurrently.
- `adviseProviderAwareTopology` (the real, unmodified function, R13-extended this session to step down gracefully rather than always collapsing to solo) correctly reduces recommended parallelism under provider concentration and correctly retains it under genuine diversity.
- None of this argues for shipping a production 4-agent topology today — production still caps at 2. This is groundwork for that future decision, not a claim it is ready now.
