# R12 protected acceptance architecture

## Decision

`protectedAcceptance` remains in the schema and is now a real evidence-backed stage. It is not a copy of the ordinary verifier boolean and it is not inferred from the final success flag.

The implementation is in `packages/benchmark/src/protected-acceptance.ts`, exported from `@codeforge/benchmark`, and wired by `scripts/r12-codeforge-bench-r2-executor.mjs`. The historical R11 executor and all R11 JSON artifacts remain unchanged.

## States

| State | Meaning |
|---|---|
| `accepted` | A protected attempt has complete, well-formed evidence, passed all required independent checks, and has evidence from at least two distinct sources. |
| `rejected` | Evidence is complete enough to evaluate, but a visible, hidden, ForgeVerify, terminal, or diff-integrity check failed; malformed checks also reject. |
| `not_applicable` | The attempt is a public case and protected acceptance does not apply. |
| `infrastructure_blocked` | Required protected evidence is absent or incomplete, so the result cannot honestly be accepted or rejected. |

Legacy `passed`, `failed`, and `not_run` values remain readable by the historical summarizer for R11 compatibility. New R12 attempts emit only the four states above.

## Independent evidence

The stage requires:

- a terminal status and changed-file list;
- a SHA-256 diff hash;
- visible acceptance, hidden verifier, ForgeVerify, terminal-state, and generated-diff-integrity checks;
- no duplicate check IDs;
- at least two distinct evidence sources among visible, hidden, ForgeVerify, terminal, and diff audit;
- no failed check.

This prevents one ordinary verifier boolean from manufacturing protected acceptance. Missing evidence is `infrastructure_blocked`, never success.

## Validation

`packages/benchmark/test/codeforge-bench-r2.test.ts` covers accepted protected cases, rejected cases, missing evidence, malformed evidence, public `not_applicable`, summarizer accounting, and historical compatibility. The protected stage is also included in the R12 executor output so raw evidence and summary math can be audited together.
