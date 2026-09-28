# R53 role scorecard

The complete ten-route production eligibility matrix is `R53-ROLE-QUALIFICATION-MATRIX.json`. Each role has its own receipt verdict, score adjustment, sample count, and case provenance; capacity and policy remain separate columns.

## Current live benchmarks

| Measured Managed Free route | Explorer | Planner | Coder | Reviewer direct challenge |
|---|---|---|---|---|
| OpenRouter Nemotron 3 Super | Inconclusive: compact suite interrupted by provider capacity after two passing Coder cases | Inconclusive | 2/2 compact cases before capacity interruption | 7/7, 0 non-converged; 36.2 s total |
| Groq GPT-OSS 20B | PROBATION, 1/2 | Inconclusive: provider 429 | QUALIFIED, 2/2 | 7/7, 0 non-converged; 3.9 s total |
| Mistral Codestral 2508 | NOT_QUALIFIED, 0/2 | QUALIFIED, 2/2 | QUALIFIED, 2/2 | 5/7, 0 non-converged; 4.5 s total |

The production role suite's Reviewer probe on Codestral was PROBATION (4/6) in this run. The separate seven-case challenge includes correct patches, obvious and subtle defects, a requirement mismatch despite visible tests, unrelated security-affecting noise, cross-file integration mismatch, and an unseen clean filename/constant variant. All direct challenges used one request per case and no tools; they do not certify autonomous review-loop efficiency.

The current Groq and OpenRouter role-suite interruptions were provider-capacity events, not model failures. The script does not update production receipts. Existing persisted qualification remains the routing authority until a governed requalification completes.

The separate six-shape file-index Explorer challenge (`R53-EXPLORER-BENCHMARK.json`) measured Nemotron Super 5/6 strict exact sets, Codestral 2508 5/6, and Groq GPT-OSS 20B 2/2 before a provider error stopped its remaining cases. Both 5/6 results include an arguably relevant extra quota test in the same large-repository case; the original grader was retained. The challenge does not replace tool-using Explorer qualification.

## Planner and topology value

`adaptive-topology.ts` uses no Planner for tiny and normal tasks, and keeps one for complex and fixed R1 topologies. The R24 paired topology benchmark exercises the actual production orchestrator and fabric with scripted roles; it isolates parallel-explorer cost under constrained capacity, but does not measure a live Planner's incremental correctness. The eight R53 live attempts resolved to normal topology; they do not prove Planner benefit. Mistral Codestral's 2/2 current Planner probe establishes protocol competence, not topology value. No architectural removal or mandatory Planner expansion is justified by this evidence.
