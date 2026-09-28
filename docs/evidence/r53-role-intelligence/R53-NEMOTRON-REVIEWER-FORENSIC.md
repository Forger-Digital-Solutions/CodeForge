# R53 Nemotron Reviewer forensic review

## R52 blocked healthy mission

The selected Reviewer was `openrouter/nvidia/nemotron-3-super-120b-a12b:free` on a measured Managed Free pool independent of the coder's Groq pool. Its fresh `R41_ROLE_QUALIFICATION_V3` receipt was `QUALIFIED`: five passing reviewer cases, no failing cases, receipt role adjustment +8. At selection, the runtime reported `ROLE_RUNTIME_EVIDENCE_ABSENT` and score 85.

The child used 10 model requests, 10 tool calls, 39,420 input tokens, 2,963 output tokens, and 50,973 ms. It produced no validated reviewer JSON verdict. There were no reported provider failures, retries, or route failovers. It hit the 10-turn budget and recorded `NON_CONVERGENCE`/`CAPABILITY_LIMITED` role feedback. ForgeVerify refused completion before verification or integration.

The receipt does not preserve individual reviewer tool names, arguments, or per-turn evidence. It therefore cannot establish whether the tool calls were repeated, whether each added useful evidence, or whether context churn occurred. `duplicateWorkCount=0` is insufficient proof of progress. The exact reviewer behavior remains a telemetry gap.

At the pre-mission admission decision, Mistral Reviewer routes were excluded by `DATA_POLICY_USER_CONSENT_REQUIRED`; OpenRouter Nemotron Lightning had `ROLE_NOT_QUALIFIED`; Groq Qwen Reviewer was `CAPACITY_UNMEASURED`. Nemotron Super was the only admitted Reviewer. An immediate switch to a proven alternate was therefore unavailable. A bounded demand probe might have opened Groq Qwen, but that counterfactual was not exercised in R52. The runtime's existing mid-run failover activates on provider errors, while this model kept returning valid tool calls. Its identical-call and empty-read detectors did not trigger.

## R53 evidence and disposition

The R53 direct reviewer challenge gave Nemotron Super 7/7 verdicts, including clean approvals, a subtle even-length median defect, requirement mismatch, unnecessary audit change, and cross-file integration mismatch. All seven converged in one request each; total wall time was 36.2 seconds, considerably slower than Groq GPT-OSS 20B's 3.9 seconds on the same cases. This benchmark tests patch judgment without repository tools, so it does not erase the R52 runtime non-convergence evidence.

The R53 autonomous healthy mission, after a reviewer prompt change to stop exploring once evidence suffices, completed. Nemotron Super delivered a verdict in 8 requests and 6 tool calls; ForgeVerify then passed 2/2 tests and the completion gate, with equal verified/integrated trees and $0 spend. The coder and Reviewer used the same OpenRouter pool in that run because other reviewer routes were unavailable at admission; the receipt reports this fallback truthfully.

**Disposition:** retain Nemotron Super's Reviewer qualification with runtime negative evidence. The available evidence does not justify a hard blacklist or role revocation. Its turn efficiency is a measurable concern; repeated independent failures now trigger an early requalification queue entry instead of waiting for receipt age expiry. No claim of proven early role failover is made.
