# R53 long-horizon role simulation

`scripts/r53-long-horizon-role-sim.mjs` executed 34 deterministic task decisions through the production `EightBitRouteHealthAuthority` and `createFreeFabric` ranking path. The trace in `R53-LONG-HORIZON-ROLE-SIM.json` covers a strong Coder, repeated Coder degradation, verified recovery, a capacity-exhausted route, a Reviewer role shift, a new route, and evidence expiry after the one-hour rolling window.

Repeated genuine Coder failures moved selection from alpha to beta; later verified completions moved Coder selection back to alpha. Reviewer failures on alpha and successes on beta selected beta for Reviewer while alpha continued to win Coder, proving role isolation. Marking alpha capacity-exhausted chose beta without changing the role-quality evidence at the same timestamp. The trace recorded two adjacent decisions for the same role where the winner flipped; there was no oscillation on a single outcome. Old evidence expired and the sample count returned to zero.

This is a deterministic routing simulation with a fresh capacity ledger per task so the role signal can be isolated. It does not run providers, requalification, a verifier, or a task-difficulty shift. Consequently it does not measure actual software success, verification success, or qualification churn; those require a separate execution simulation.
