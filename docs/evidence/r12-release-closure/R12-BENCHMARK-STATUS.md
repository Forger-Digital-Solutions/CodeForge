# CodeForgeBench R12 status

## Public campaign

Artifact: `codeforge-bench-r2/r12-public.json`

- 40 cases and 40 attempts
- 30 verified successes
- pass@1: `0.750`
- 0 false completions
- 10 failed attempts, including 2 provider-rate-limited attempts
- Split results: TRAIN `12/15`, DEVELOPMENT `9/13`, VALIDATION `9/12`
- Provider calls: `607`
- Tool calls: `562`
- Output tokens: `149,799`
- Wall time: `3,266,669 ms`

Compared with the immutable R11.4 baseline of 33/40 (`0.825`), R12 regressed by three verified cases. The result is not a release-quality capability improvement and requires investigation before an engineering-ready verdict.

## Protected campaign

Artifact: `codeforge-bench-r2/r12-protected.json`

- 8 protected cases and 8 attempts
- 0 verified successes
- 0 false completions
- all attempts were safely rejected
- all attempts encountered the free OpenRouter daily rate limit during execution

This is an honest `BLOCKED_EXTERNAL` measurement, not a pass or an imputed result. The new protected acceptance contract is active: each attempt carries `accepted`, `rejected`, or another explicit evidence state, with evidence checks and rejection reasons. Historical R11 protected evidence remains unchanged.
