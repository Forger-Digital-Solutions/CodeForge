# R53 Explorer benchmark

`R53-EXPLORER-BENCHMARK.json` records six zero-cost, direct model challenges: a local bug, a cross-package timeout, an unfamiliar checkout feature, a large repository quota issue, a symbol rename, and a defect hidden behind a provider adapter. Each prompt presents a file index with decoys. The predeclared grader checks exact relevant paths, invented paths, and unnecessary selections. A provider error stops further probes for that route.

| Route | Completed cases | Strict exact selections | Provider interruption |
|---|---:|---:|---|
| OpenRouter Nemotron 3 Super | 6 | 5 | none |
| Groq GPT-OSS 20B | 2 | 2 | third request; remaining cases inconclusive |
| Mistral Codestral 2508 | 6 | 5 | none |

Both 5/6 routes selected `packages/forge-zero/test/quota.test.ts` in addition to the predeclared large-repository answer. That test is plausibly relevant to an unmeasured quota. The strict result is retained; changing the expected set after seeing answers would contaminate the benchmark. All completed responses were single-request, zero-tool probes. This measures file-index triage, not autonomous repository navigation or multi-turn context efficiency. Production Explorer receipts were not modified by this challenge.

The separate live production role-suite receipt (`R53-ROLE-BENCHMARK.json`) found Groq GPT-OSS 20B Explorer at PROBATION (1/2), Mistral Codestral 2508 NOT_QUALIFIED (0/2), and Nemotron Super inconclusive after a provider interruption in the compact stage. Those cases use actual tools and a fixture repository; they are a different protocol and remain the qualification authority.
