# R12 benchmark integrity audit

## Scope

The audit searched production source under `packages/` and `apps/` for R11/R2 case identifiers, fixture names, expected values, prompt literals, and benchmark-only branches. Benchmark infrastructure under `packages/benchmark` and `scripts/r*-codeforge-bench*` is allowed and is called out explicitly below.

## Classification

| Finding | Classification |
|---|---|
| `CBR2` schemas, case IDs, fixture loaders, hidden verifier, and executor wrappers under `packages/benchmark`/`scripts` | Legitimate benchmark infrastructure |
| R12 protected-acceptance stage | General evidence contract; it consumes evidence objects and does not branch on individual case IDs |
| Planning completeness | General task-sensitive obligation detection; no AT-01/AT-02/PQ-01 branch |
| Authority boundary contract and role ceilings | General role policy; no CP-01/CP-02 branch |
| Secret redaction | General credential-shape handling; no GS-01 branch or fixture filename dependency |
| No-progress detection | General unchanged-state/read-signal classification; no RP-02 branch |

No production branch was added that names a public or protected benchmark case, fixture-specific filename, hidden expected value, or individual failure ID. R11 fixture and result files remain historical evidence and are not modified by R12.

## Audit conclusion

`GENERAL_REMEDIATION_CONFIRMED` for the source changes above. The fresh R12 campaign is now the independent effectiveness check: it found no fixture-specific production behavior, but it also showed that several remediation families are not yet effective enough for an engineering-ready release. See `R12-BENCHMARK-STATUS.md` and `R12-FINAL-REPORT.md` for the measured result.
