# R13 benchmark integrity audit

Recorded: 2026-09-18 before the R13 public campaign.

Scope: production source in `packages/` and `apps/`, plus the benchmark package and runner scripts for classification. The audit searched for `CBR1-`/`CBR2-` identifiers, hidden-verifier identifiers, fixture filenames, expected strings, and case-specific branches.

| Finding | Classification | Production effect |
| --- | --- | --- |
| CodeForgeBench R2 case schemas, IDs, split definitions, and scoring in `packages/benchmark` | legitimate benchmark infrastructure | none outside the benchmark package |
| Fixture materializer and hidden verifier in `scripts/r11-codeforge-bench-r2-*` | legitimate isolated benchmark infrastructure | runs only in temporary fixture workspaces |
| R12 wrapper in `scripts/r12-codeforge-bench-r2-executor.mjs` | legitimate protected-acceptance adapter | consumes generic verification evidence; no case-specific production behavior |
| `CBR2-RV-01` in the EightBit dataset builder/test | generic evidence-row identifier and test fixture | no production routing condition or benchmark prompt branch |
| `apps/` | no benchmark-ID match | none |

No production route, provider, completion, verification, or prompt branch names an individual public/protected benchmark case, fixture-specific filename, hidden expected value, or benchmark-only outcome. The applicable remediations are general policy behavior: ForgeZero admission, provider error handling, secret redaction, no-progress detection, and Completion Gate enforcement.

Result: `GENERAL_REMEDIATION_CONFIRMED`. Historical R11/R12 evidence was checked separately and remains unchanged.
