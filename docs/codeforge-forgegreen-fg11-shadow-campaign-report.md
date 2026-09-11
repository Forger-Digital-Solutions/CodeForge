# ForgeGreen FG-11 Real Shadow Evidence Campaign Report

Generated: 2026-09-11T18:18:58.355Z

- certifiedSourceStateId (FG11_CAMPAIGN_SOURCE_STATE): `f9cb465db299648b01593111f3ebbfd90a8c2bc98b84f08a44ba051bb8d4c36a`
- campaignHarnessId: `92e53658022596f2fd4ded27450994f2a82c6ca1790e1b0eb97e6615e3a93d1e`
- task-runs executed this invocation: 32
- observations newly inserted this invocation: 212
- excluded buckets (different source-state/harness identity, never aggregated in): []

## Candidate A — DUPLICATE_READ_ONLY_TOOL_REUSE (ACTIVE_SAFE positive control)

- total: 36
- eligible: 32
- validated: 12
- invalidated: 20
- incomplete: 4
- insufficientEvidence: 0
- uniqueRuns: 4
- uniqueFingerprints: 14
- controlCases: 0
- unsafeFalsePositives: 0
- observerOverhead: total 0ms, mean 0.00ms, median 0ms, max 0ms (n=36)
- diversity dimensions: {"task":["task5-tool-heavy"],"variant":["0","1"],"decisionAction":["escalate","execute","suppress"]}
- invalidation reasons: {"UNSPECIFIED":20}
- ACTUAL avoided work (never combined with B/C/D projections): {"toolExecutionsPrevented":12,"bytesReplayed":3584,"msSaved":56}


## Candidate B — DUPLICATE_CONTEXT_PAGE_TRANSMISSION (SHADOW)

- total: 134
- eligible: 134
- validated: 114
- invalidated: 20
- incomplete: 0
- insufficientEvidence: 0
- uniqueRuns: 34
- uniqueFingerprints: 86
- controlCases: 26
- unsafeFalsePositives: 0
- observerOverhead: total 0ms, mean 0.00ms, median 0ms, max 0ms (n=134)
- diversity dimensions: {"repositoryState":["auth-s1","auth-s1->s2","billing-s1","billing-s1->s2"],"task":["task1-small-bug-fix","task10-restart-recovery","task11-b-invalidation-control","task2-multi-file-bug-fix","task3-repository-search","task4-context-heavy"],"variant":["0","1","2","3"],"invalidationReason":["WORKSPACE_REVISION_CHANGED"]}
- invalidation reasons: {"WORKSPACE_REVISION_CHANGED":20}
- PROJECTED avoided work (label is always PROJECTED, never ACTUAL): {"pageTransmissions":114}
- readiness: **READY_FOR_CONTROLLED_ACTIVE_TRIAL**

## Candidate C — OPTIONAL_PREFETCH_SUPPRESSION (SHADOW)

- total: 192
- eligible: 158
- validated: 50
- invalidated: 108
- incomplete: 0
- insufficientEvidence: 34
- uniqueRuns: 32
- uniqueFingerprints: 144
- controlCases: 48
- unsafeFalsePositives: 0
- observerOverhead: total 0ms, mean 0.00ms, median 0ms, max 0ms (n=192)
- diversity dimensions: {"repositoryState":["auth-s1","billing-s1"],"task":["task1-small-bug-fix","task2-multi-file-bug-fix","task3-repository-search","task4-context-heavy","task8-optional-context-unnecessary","task9-optional-context-promoted"],"variant":["0","1","2","3"],"optionality":["INSUFFICIENT","REQUIRED","SAFE"],"availability":["PULLED","REUSED"],"invalidationReason":["NOT_YET_VALIDLY_AVAILABLE","REQUIRED"]}
- invalidation reasons: {"NOT_YET_VALIDLY_AVAILABLE":24,"REQUIRED":84}
- PROJECTED avoided work (label is always PROJECTED, never ACTUAL): {"prefetchToolExecutions":50}
- readiness: **READY_FOR_CONTROLLED_ACTIVE_TRIAL**

## Candidate D — VERIFICATION_EVIDENCE_REUSE (SHADOW)

- total: 62
- eligible: 62
- validated: 18
- invalidated: 44
- incomplete: 0
- insufficientEvidence: 0
- uniqueRuns: 34
- uniqueFingerprints: 62
- controlCases: 30
- unsafeFalsePositives: 0
- observerOverhead: total 1449ms, mean 23.37ms, median 22ms, max 29ms (n=62)
- diversity dimensions: {"repositoryState":["auth-s1","auth-s1->s2","auth-s1-unchanged","billing-s1","billing-s1->s2","billing-s1-unchanged"],"task":["task1-small-bug-fix","task2-multi-file-bug-fix","task6-verification-heavy","task7-change-and-rerun"],"variant":["0","1","2","3","4","5"],"invalidationReason":["STALE_OR_CHANGED_STATE"],"verifierId":["fg11.task1.v0.syntax","fg11.task1.v1.syntax","fg11.task1.v2.syntax","fg11.task1.v3.syntax","fg11.task2.v0.0","fg11.task2.v0.1","fg11.task2.v0.2","fg11.task2.v1.0","fg11.task2.v1.1","fg11.task2.v1.2","fg11.task2.v2.0","fg11.task2.v2.1","fg11.task2.v2.2","fg11.task2.v3.0","fg11.task2.v3.1","fg11.task2.v3.2","fg11.task6.v0.0","fg11.task6.v0.1","fg11.task6.v0.2","fg11.task6.v1.0","fg11.task6.v1.1","fg11.task6.v1.2","fg11.task6.v2.0","fg11.task6.v2.1","fg11.task6.v2.2","fg11.task7.v0","fg11.task7.v1","fg11.task7.v2","fg11.task7.v3","fg11.task7.v4","fg11.task7.v5"],"priorStatus":["passed"],"freshStatus":["passed"]}
- invalidation reasons: {"STALE_OR_CHANGED_STATE":44}
- PROJECTED avoided work (label is always PROJECTED, never ACTUAL): {"verificationReruns":18,"verificationDurationMs":1236}
- readiness: **READY_FOR_CONTROLLED_ACTIVE_TRIAL**


## Notes

- B/C/D remained SHADOW throughout — zero intervention, zero execution change.
- Fresh ForgeVerify evidence was always produced for every Candidate D observation (no reuse-short-circuit was ever taken during observation collection).
- Energy/Carbon: `INSUFFICIENT_DATA` — no new hardware telemetry was introduced by this campaign.
