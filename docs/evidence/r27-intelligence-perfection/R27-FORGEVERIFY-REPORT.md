# R27 ForgeVerify Windows Lifecycle Report

Status: `windows_timeout_lifecycle_fixed_and_revalidated`

## Root cause and repair

The earlier close-based settlement repair still failed in this managed Windows environment. A direct
child caused `taskkill /T /F` to return access denied. The executor only fell back to `process.kill`
when spawning taskkill failed, not when taskkill itself returned a non-zero status. The root process
could therefore survive the timeout and retain an isolated temporary workspace.

The executor now treats both a taskkill error and a non-zero status as failure and invokes the
direct-child fallback. It preserves the existing child-close settlement and two-second bounded
fallback, with exactly-once timeout and cancellation semantics.

## Current revalidation

| Scope | Result |
| --- | --- |
| Terminal suite, including four R27 timeout lifecycle cases | 38/38 passed |
| ForgeVerify evidence tests | 5/5 passed |
| ForgeVerify and verification service | 23/23 passed |
| Integrity and stale-evidence matrix | 18/18 passed |
| Malicious corpus and ForgeVerify replan | 26/26 passed |
| Focused ForgeVerify revalidation | 72/72 passed |
| Terminal, workflow, and server type-checking | passed |

The 10-consecutive-timeout regression now removes every temporary workspace immediately with zero
`EPERM`, while timeout still returns exit code 124 and cancellation returns 130. No external
processes, inference, deployment, or publication were used.
