# CodeForge Post-Paid-Auto R1 Provider Onboarding and Managed-Free Hardening

Campaign date: 2026-09-16. This report distinguishes PASS, BLOCKED, NOT RUN, NOT REACHED, UNVERIFIED, and DEFERRED. It contains no credential values or hidden chain-of-thought.

## 1. Overall Verdict

BLOCKED for release certification. Code changes, policy hardening, tests, and build passed. Gemini key creation was observed, but current CodeForge live auth remains HTTP 403. Exact Groq GPT-OSS 20B catalog and bounded allowance checks passed, but the fresh whole-agent proof was blocked by a malformed `list_files` tool call. Dogfood was not authorized.

## 2. Starting Repository State

Starting branch: `forger-digital-solutions-forgegreen-certified`. Starting HEAD: `757849e37bc090a9352a06da90dc72939514dafb`. The starting worktree was clean. Paid Auto R1 was already present and recorded as complete with mock-only, defaults-off behavior. The final worktree is intentionally dirty with the uncommitted changes listed in §43; no push occurred.

## 3. Paid Auto R1 Reconciliation

PASS. The isolated Paid Auto boundary remains separate from Free Auto, ForgeZero, GEMS Auto, and Managed-Free. The frozen four-model roster and direct-first/same-model/no-failover rules remain intact; no live paid inference was enabled.

## 4. Provider Account Matrix

Groq: FREE plan observed; exact target live and allowance-probed; R5 blocked by model/tool contract. Cloudflare: Workers Paid active observed; no Managed-Free qualification asserted. OpenRouter: authenticated, but exact Groq target not listed. Gemini: key created in AI Studio, current runtime auth blocked. Cerebras: promotional-credit state observed, live inference not run. Mistral: deferred.

## 5. Secret / Credential Setup

Presence/type only: Groq credential present; existing Gemini credential channel present but returned 403; Cerebras masked credential observed; Cloudflare account/token setup was present in the browser. No secret value was copied into chat, source, evidence, or telemetry.

## 6. Gemini Account / Auth-Key Result

PASS for user-side key creation; BLOCKED for CodeForge installation/verification. The user created a Gemini AI Studio key. The newly created value was not copied or persisted by this campaign. The current CodeForge credential channel still produces HTTP 403, so the created key must be installed through the existing secure CodeForge provider channel before live auth can be verified.

## 7. Gemini Policy / Data Classification

PASS for fail-closed policy design. Unpaid Gemini routes require explicit free-tier policy acceptance and a trusted region. The adapter does not classify Gemini as free merely because a model is listed, and confidential data is not authorized for the Gemini Free route.

## 8. Gemini Live Adapter Result

BLOCKED_AUTH. The Google OpenAI-compatible endpoint was reached with the current runtime credential and returned HTTP 403 for model discovery. No inference was attempted after that failure.

## 9. Gemini Qualification Status

UNVERIFIED. Gemini cannot enter executable Free routing until both current authentication and the explicit policy gate pass.

## 10. Cerebras Account / Promo Credit State

Account console and a masked credential were observed. The campaign did not run live Cerebras inference, so promotional capacity was preserved and no private billing detail is reproduced here.

## 11. Cerebras Live Adapter Result

NOT RUN by operator choice. The adapter and catalog contract remain available for a later minimal conformance run, but no call was made during this campaign.

## 12. Cerebras Economic Classification

PROMOTIONAL_CREDIT / EVALUATION_ONLY. Promotional credit is not the same as a provider-owned zero-price allowance and therefore cannot be classified as Managed-Free or used as a Groq fallback.

## 13. Groq State

PASS for account/catalog precheck. The live catalog contained 13 models, including exact `openai/gpt-oss-20b`; the bounded exact-model allowance probe passed. Whole-agent certification remains blocked by the fresh malformed tool call recorded in the R5 evidence.

## 14. Cloudflare State

WORKERS_PAID_ACTIVE observed in the browser. Managed-Free eligibility and overage status were not certified; the existing neuron/spend guard remains fail-closed and Cloudflare was not used as a fallback.

## 15. OpenRouter State

Authenticated catalog access returned HTTP 200, but exact `openai/gpt-oss-20b` was not listed. No model substitution and no paid fallback were performed.

## 16. Mistral Deferred State

MISTRAL_DEFERRED_USER_REQUEST. No Mistral account setup or inference was performed.

## 17. 8-Bit Qualification Boundary

PASS. 8-Bit remains a qualification/routing boundary; it does not override explicit model pins, ForgeZero eligibility, policy gates, or Completion Gate authority.

## 18. ForgeAuto Routing Boundary

PASS. ForgeAuto remains distinct from Paid Auto and GEMS. No paid, local, or GEMS route was introduced into Free routing.

## 19. ForgeGreen Boundary

PASS. ForgeGreen remains advisory/telemetry-oriented and outside provider authorization, ForgeVerify, and Completion Gate authority.

## 20. GEMS Boundary

PASS. GEMS was not retrained, integrated, or changed.

## 21. Provider Tests

PASS. Focused provider/policy suite: 5 files passed, 75 tests passed, 0 failed. Fresh repository-wide suite: 339 files passed, 7 skipped; 2,541 tests passed, 36 skipped; exit code 0. The suite emitted non-failing fixture Git line-ending warnings and a best-effort SQLite statement-finalization warning in a passing workflow test.

## 22. Workspace Build

PASS. `npm.cmd run build` completed across the workspaces. Vite emitted only existing chunk-size warnings.

## 23. Groq Capacity Precheck

PASS. Groq live catalog access succeeded, the exact 20B model was present, and a single bounded no-charge allowance probe produced final text and a finish event.

## 24. Exact GPT-OSS 20B Selection

PASS. ForgeZero and ForgeRouter selected only `groq::openai/gpt-oss-20b`; no substitute model was constructed. The provider transport now requests `include_reasoning: false` so GPT-OSS reasoning is not mistaken for the durable final answer.

## 25. Explorer Result

NOT REACHED as a successful certified stage. The durable run produced tool activity, but no valid Explorer completion was established before the malformed `list_files` call halted implementation.

## 26. Planner Result

BLOCKED / NOT REACHED as a validated implementation plan. A durable plan work item existed, but the run stopped with only 2 of 5 plan steps completed and no successful downstream chain.

## 27. Coder Result

BLOCKED. The exact Groq agent did not change the disposable red fixture; no Coder completion was certified.

## 28. Reviewer Result

NOT REACHED. No independent Reviewer verdict was recorded for the fresh run.

## 29. ForgeVerify Result

PARTIAL/BLOCKED. Run-inspection evidence was persisted, but no successful fixture verification followed a real agent edit. The separate negative control correctly rejected a failing verifier.

## 30. Completion Gate Result

PASS for the negative control, BLOCKED for R5 completion. The failing-verification adversarial control returned `verification_failed`; the live R5 run emitted no `task.completed` event and did not authorize completion.

## 31. R5 Whole-Agent Verdict

CODEFORGE_R5_GROQ_20B_WHOLE_AGENT_CERTIFIED was not earned. Fresh verdict: `CODEFORGE_R5_REAL_AGENT_LOOP_BLOCKED`, classified primarily as MODEL_CONTRACT / EXTERNAL_CAPACITY.

## 32. False-Completion Safety

PASS. The full suite and fresh R5 evidence show that provider output, partial tool activity, inspection evidence, or an earlier plan cannot alone assert success. No false completion was emitted.

## 33. Budget / Deadline Propagation

PASS for bounded execution evidence. The harness used a 240-second parent deadline, no ceiling extension, and a 500 ms polling interval; the blocked run terminated in about seven seconds after the malformed tool call. No retry storm occurred and no human implementation intervention occurred.

## 34. CodeForge-Builds-CodeForge Authorization

NOT AUTHORIZED. The required exact-model R5 prerequisite did not pass, so dogfood was not run.

## 35. Dogfood Task

NOT RUN. No CodeForge issue was selected or modified through dogfood.

## 36. Dogfood Agent Pipeline

NOT RUN. Explorer → Planner → Coder → Reviewer → ForgeVerify → Completion Gate was not authorized for dogfood.

## 37. Dogfood ForgeVerify

NOT RUN.

## 38. Dogfood Completion Gate

NOT RUN.

## 39. Dogfood Verdict

NOT RUN; no dogfood pass is asserted.

## 40. Security / Secret Safety

PASS for this campaign. Gemini key material was not copied, exposed, or persisted. Evidence is sanitized; the R5 fixture was disposable; no repository files were used as the live task target; no insecure sandbox or browser-security workaround was introduced.

## 41. Spend Summary

OpenAI paid spend: NOT VERIFIED. Z.AI paid spend: NOT VERIFIED. Alibaba/Qwen paid spend: NOT VERIFIED. DeepSeek paid spend: NOT VERIFIED. OpenRouter paid spend: NOT VERIFIED; no paid fallback was used. Groq paid spend: NOT VERIFIED; the observed run used the FREE plan and bounded allowance probe. Gemini paid spend: NOT VERIFIED; no Gemini inference was run. Cerebras promo credit consumed: NOT CONSUMED; live inference was not run. Cloudflare overage: NOT VERIFIED; no Cloudflare inference was run. Mistral spend: NOT RUN / NOT VERIFIED.

## 42. New Defects

One fresh external/model-contract blocker was observed: Groq GPT-OSS emitted a `list_files` call without the required `path`, producing `path required` and stopping the run. Gemini also remains an account-setup/auth blocker until the newly created key reaches CodeForge's secure credential channel. The SQLite statement-finalization message appeared in a passing test as a best-effort persistence warning and is recorded as a follow-up candidate, not as a release-failing assertion.

## 43. Fixes Implemented

Added a user-level PowerShell `npm` function that delegates to the real `C:\Program Files\nodejs\npm.cmd`, and repaired the global npm installation. Added dynamic Gemini policy evaluation, explicit policy state in provider connections/registry, and main-process gate registration. Added Groq GPT-OSS final-answer request shaping. Added a Groq R5 harness and changed it to preserve every run under a unique evidence path. Refreshed the ForgeGreen certified source-state identity after the inherited Paid Auto R1 material-file change.

## 44. Regression Tests Added

Added a provider regression asserting that `createGroqAdapter` sends `include_reasoning: false` and preserves final content. Added Gemini policy admission and snapshot executable-state tests. Existing desktop provider-connection, legal-policy, source-state, orchestration, routing, ForgeVerify, and Completion Gate suites were rerun.

## 45. Evidence Files

Fresh onboarding evidence: `G:\CodeForge\docs\evidence\post-paid-auto-r1\provider-onboarding-2026-09-16-r1.json`. Fresh blocked R5 evidence: `G:\CodeForge\docs\evidence\post-paid-auto-r1\r5-groq-b8f38e94-331d-4655-8e4e-a1fe8ae6de73.json` and its Markdown companion. Earlier blocked attempts remain under `G:\CodeForge\docs\evidence\post-paid-auto-r1\` and were not deleted. Source-state reconciliation: `G:\CodeForge\docs\codeforge-forgegreen-certified-source-state.json`.

## 46. Commits

Starting HEAD and current HEAD remain `757849e37bc090a9352a06da90dc72939514dafb`; no local commit was created for this campaign. Push status: NO PUSH.

## 47. Remaining Release Blockers

Install the newly created Gemini key through CodeForge's secure provider channel and obtain a live authenticated model catalog plus policy acceptance. Resolve the Groq exact-model tool-argument contract issue before another quota-consuming R5 attempt. Keep dogfood disabled until a fresh run reaches Reviewer, ForgeVerify, and Completion Gate with the exact 20B model.

## 48. Recommended Next Campaign

Smallest evidence-backed action: install the Gemini key via the CodeForge provider settings/secure `GEMINI_API_KEY` channel, then run one bounded `listModels` plus synthetic policy-gated conformance check. Separately, fix or instrument the exact Groq tool-call argument contract, wait for confirmed capacity if required, and run only one fresh R5 attempt afterward.
