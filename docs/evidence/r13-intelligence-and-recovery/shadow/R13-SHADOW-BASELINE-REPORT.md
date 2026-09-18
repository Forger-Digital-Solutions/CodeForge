# R13 shadow baseline report

| Domain | Deterministic baseline | Learned candidate | Data / validation | Inference | Production agreement | Limitation |
| --- | --- | --- | --- | --- | --- | --- |
| 8-Bit | health, quota, and recent-error risk bands | calibrated linear `8bit-shadow-r1` | 0 shared-v1 fitted rows; validation unavailable | in-process numeric calculation; no I/O/network | not evaluated | availability is not model capability |
| 16-Bit | existing deterministic route/budget policy plus decimal estimate | calibrated linear `16bit-shadow-r1` | 0 shared-v1 fitted rows; validation unavailable | in-process numeric calculation; no ledger/provider access | not evaluated | never has money or routing authority |
| ForgeGreen | static topology/resource signals | calibrated linear `forgegreen-shadow-r1` | 0 shared-v1 fitted rows; validation unavailable | in-process numeric calculation; no execution access | not evaluated | Priority 7 rows are modeled, not production proof |

Each artifact records its artifact id, model type, feature schema, dataset hash, split version, seed, creation timestamp, training count, observed successes, coefficients, and validation/calibration status. A schema mismatch or corrupt artifact safely degrades to the deterministic baseline. The `ShadowHealthCollector` exposes prediction success/failure, schema mismatch, artifact load failure, and p50/p95 prediction latency to operators without user-facing noise.

Route regret is only calculated when multiple routes were actually evaluated for the same pseudonymous task. It selects the observed cheapest/fastest verified-success route and otherwise records regret as unknown; it does not manufacture counterfactual success. Capacity and topology regret inherit this same actual-evidence requirement.
