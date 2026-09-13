# CodeForge Free Cloud Platform R4

Status: `CODEFORGE_FREE_CLOUD_PLATFORM_R4_BLOCKED`

R4 retained ForgeZero's fail-closed policy and made no package, renderer, preload, runtime, or provider-policy change. It produced new host-launch, live discovery, and bounded real-qualification evidence. The two critical product-chain gates remain unproven: a fresh exact-candidate renderer first paint outside the constrained runner, and a packaged completion-gated coding task through an admitted free route.

## 1. Verdict

`CODEFORGE_FREE_CLOUD_PLATFORM_R4_BLOCKED`

## 2. Reconciled Starting State

Branch `forger-digital-solutions-forgegreen-certified`; HEAD `18c9f941ffe1961d5a1ca2b525afbb57a9b7af77`; R2 candidate `8b05773dd892de96bec52c5d7325622817e4dc75` is in ancestry. The worktree contained R3 evidence/recertification changes before R4; R4 added only non-packaged harness/evidence/report files.

## 3. Packaged Source Equivalence

`git diff --name-only 8b05773..HEAD -- apps/desktop packages/server packages/router packages/sessions packages/model-registry packages/eight-bit packages/forge-zero packages/providers` was empty. R4 changed the non-packaged smoke launcher and qualification harness only; no rebuild is warranted and no R2 package claim is assigned to changed application source.

## 4. Host-Native Launch Method

A temporary Windows Scheduled Task ran interactively as the current user and invoked `apps/desktop/release/r4-evidence/run-unpacked-full.cmd`. The task was removed after evidence collection. This is a host scheduler path, but did not establish an observable foreground Explorer desktop window.

## 5. Process Ancestry Proof

Partial only. The task action is recorded in the R4 launcher evidence; runtime metadata records browser PID `24932`, parent Electron PID `30324`, profile, executable, and timestamp. The process ended at the smoke watchdog before a safe parent-executable/session capture could be collected. It is not proof of ordinary desktop ancestry.

## 6. Unpacked Fresh-Profile Smoke

Failed/incomplete. Exact `release/win-unpacked/CodeForge.exe` initialized its fresh profile and runtime, then the full smoke timed out waiting for renderer evidence. No `RENDER_PROCESS_GONE` or `launch-failed:49` was emitted.

## 7. Portable Fresh-Profile Smoke

Not attempted: the prerequisite unpacked host-native first-paint gate did not pass.

## 8. Installed Fresh-Profile Smoke

Not attempted: installation must not be used to mask the failed/incomplete unpacked gate.

## 9. First Paint / Workspace Timing

Process start at `2026-09-13T11:10:16.232Z`; ephemeral runtime bound before the smoke timeout. `WINDOW_READY_TO_SHOW` was logged, but no renderer frame/DOM/first-paint/workspace-interactive marker was produced. Timing for those stages is unavailable.

## 10. Runtime Ownership

Fresh profile `apps/desktop/release/r4-evidence/unpacked/smoke-user-data`; instance `db60b276-5915-4a66-ab7f-e11b271a777c`; endpoint `http://127.0.0.1:64128`; executable was the exact unpacked R2 candidate. This proves owned runtime creation, not renderer completion.

## 11. Recovery / Restart

No fresh R4 packaged recovery trace because first paint did not complete. Historical R8 recovery evidence remains corroboration only; deterministic recovery coverage ran in the regression suite.

## 12. Active-Work Close Behavior

Not exercised in R4 packaged UI; deterministic workflow cancellation/recovery tests ran.

## 13. Workspace UX

Not certified: no packaged first paint or interactive workspace marker.

## 14. Settings UX

Not certified: no packaged first paint or Settings navigation.

## 15. Current Provider Inventory

Current authenticated live discovery registered OpenRouter only and reported 1,644 upstream models, 22 verified zero-unit candidates, zero allowance candidates, and zero discovery errors. It is candidate discovery, not an admitted fleet. Registry definitions also support OpenCode, Z.AI, Gemini, Groq, Cerebras, SambaNova, Mistral, Cloudflare, NVIDIA, Hugging Face, Moonshot, Poolside, DeepSeek, OpenAI, and Anthropic where configured; no nonexistent adapter was called.

## 16. Credential Discovery

Environment presence only: `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`, `OPENAI_API_KEY`, and `ANTHROPIC_API_KEY` were present. Values were never read into evidence. Paid-only/OpenAI and Anthropic credentials were excluded from Free routing.

## 17. Authenticated Provider

OpenRouter authenticated sufficiently for live catalog discovery and one bounded zero-unit qualification. No packaged UI authentication session was created in R4.

## 18. Free Route Qualification

`openrouter/nvidia/nemotron-3-super-120b-a12b:free` completed the real compact suite in 15,529 ms and four requests: tool call and structured output passed, exact edit failed after one retry. Receipt state is `PROBATION`, not `QUALIFIED`.

## 19. Current Admitted Free Fleet

None certified by R4. The one real candidate is probationary and therefore excluded from ForgeAuto coding admission.

## 20. Model Picker Proof

Not certified: packaged renderer did not reach first paint.

## 21. ForgeAuto Routing Decision

No live ForgeAuto route was selected. The real route was correctly withheld because it was not `QUALIFIED`; this preserves fail-closed admission.

## 22. Real Autonomous Coding Task

Not run. A direct API or harness task would bypass the packaged product and cannot satisfy R4.

## 23. Tools / Commands / Files

Observable R4 work: isolated packaged smoke, live catalog refresh, compact qualification receipt, browser-security audit, focused ForgeGreen tests, and full regression run. No disposable coding repository was created because there was no admitted packaged route.

## 24. Test Result

No live task repository exists. The qualification used four bounded free requests only.

## 25. ForgeVerify Result

Not run for a live R4 task.

## 26. Completion Gate

Not run for a live R4 task. No status was promoted to completed outside `evaluateCompletion`.

## 27. Failover / Rate-Limit Behavior

No live rate limit occurred in the qualification. Deterministic 8-Bit active-run failover coverage passed during the aggregate run; no paid fallback was attempted.

## 28. Free vs BYOK Proof

The qualification asserted a currently verified `:free` OpenRouter route before sending traffic. No paid route was selected. OpenAI/Anthropic credentials remained excluded from Free admission.

## 29. Credential Security

Evidence contains only environment-variable names, sanitised qualification metadata, paths, and status. A narrow credential-pattern scan across R4 reports, harnesses, and text evidence passed with no matches; no credential value, token, authorization header, or prompt body was written.

## 30. ForgeGreen State

Certified source state remains `72673f2c31852263cd41bd056250628e9acbd966085eef9cc45546e2402cc873`; no R4 material certified-source change required recertification. Focused FG-11/FG-12E tests passed 19/19.

## 31. Focused Tests

Browser-security audit PASS; live catalog snapshot PASS (1/1); FG-11/FG-12E focused suite PASS (3 files, 19 tests); isolated FG-6 rerun PASS (1 file, 14 tests); JavaScript syntax check for the smoke harness PASS.

## 32. Full Test Aggregate

`npm test`: 306 passed, 8 failed, 7 skipped files; 2,345 passed, 13 failed, 36 skipped tests; 491.40 s. Failures are retained in `full-test.*.log`: two EPERM user-cache creations, Windows EBUSY cleanup failures, one 164 ms performance threshold failure, and 30/60 s long-integration timeouts. This is not a green full-suite result.

## 33. Runtime Candidate

Version `0.3.0`, branch/HEAD above. Application trees are equivalent to the R2 candidate; the worktree is intentionally not clean because R3/R4 certification tooling and reports are uncommitted.

## 34. Packaged Candidate

Setup SHA-256 `9F00742C0A7371DF80A19F983ED37E0EF107EE2B497E261C901A67C1A216064E`; Portable `B9F592F8EEEF47E3D2B7B098102121EBBADAF5F679EA478C0D097914047C7CA8`; unpacked `release/win-unpacked/CodeForge.exe` SHA-256 `54548AE86EDD165EDB3C4F0DA3E739A1244596BA6962435DDC39A22FAF54A5DE`.

## 35. Security Audit

PASS: `sandbox=true`, `nodeIntegration=false`, `contextIsolation=true`, `webSecurity=true`, main-process bearer injection, and bearer-free preload.

## 36. Performance

Only runtime-ready time is bounded by the logged start and pre-timeout event. First-paint, workspace-ready, browser/renderer memory, and process-count measurements are unavailable because the renderer never yielded its evidence marker.

## 37. User Journey

Not certifiable. The journey stopped before model picker/Settings/workspace interaction; no manual clicks were possible from the unavailable native UI surface.

## 38. Remaining Blockers

1. Fresh exact-R2 host-native, foreground-desktop first-paint/workspace proof.
2. A `QUALIFIED` and ForgeAuto-admitted genuinely free coding route in the packaged product.
3. A real packaged autonomous coding task passing ForgeVerify and `evaluateCompletion`.
4. A clean full-suite rerun after isolating Windows cache/cleanup contention and performance load.

## 39. Evidence Paths

`apps/desktop/release/r4-evidence/unpacked/launcher.log`; `apps/desktop/release/r4-evidence/unpacked/smoke-result.log`; `apps/desktop/release/r4-evidence/unpacked/smoke-user-data/runtime.json`; `apps/desktop/release/r4-evidence/free-route-qualification.json`; `apps/desktop/release/r4-evidence/full-test.stdout.log`; `apps/desktop/release/r4-evidence/full-test.stderr.log`; this report and JSON companion.

## 40. Next Recommended Milestone

Run the exact unpacked candidate from a genuinely observable Explorer/user-session desktop path, capture PID ancestry and first paint, then use the packaged UI to qualify a stronger verified-zero-cost route and complete one bounded coding task through ForgeVerify and the completion gate.
