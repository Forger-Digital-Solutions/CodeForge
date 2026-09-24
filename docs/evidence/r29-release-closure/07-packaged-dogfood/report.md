# Authenticated packaged desktop dogfood

The first task in the previously installed package stopped safely with `route_exhausted`: 0 files changed, no verification, no paid fallback. Its routing screen showed 47 verified routes but 0 healthy qualified routes. This negative attempt remains in the desktop session database.

R29 rebuilt the production-channel package and launched `G:\CodeForge\apps\desktop\release\win-unpacked\CodeForge.exe` with its real renderer, preload, Electron main process, local server, and existing authenticated profile. The package build identity was commit `397263782a76`, `dirty=true`, built at `2026-09-23T19:26:44.386Z`. The production endpoint audit passed. The model picker showed two qualified free coding models; the user-selected GPT-OSS 120B appeared in the composer after the model-label fix.

Through the actual UI, the task was to make `add(a, b)` return a sum for positive and negative inputs. The task used `codeforge-cloud` / `groq::openai/gpt-oss-120b`, read two files, changed `src/add.mjs` from subtraction to addition, ran `npm test` successfully, and completed after a temporary 60-second free-capacity wait. The workflow recorded 11/11 stages, one `+1/-1` diff, verification pass, review approval, and `evaluateCompletion` outcome `completed`. The independent six-case hidden verifier passed after the run. See `packaged-run-receipt.json` for the sanitized event-derived record.

The app remained responsive; no renderer crash or external terminal flash was observed. The sidebar showed both a completed session summary and its completed task entry with similar titles, which may read as duplication and warrants a later UX check. The free-route badge changed to `No Free Route` after capacity was exhausted; this reflected current routing availability and did not revise the completed task.

This is a packaged authenticated task pass for the rebuilt **dirty** candidate, not a signed release-ready verdict. The installer and executable were `NotSigned` under Windows Authenticode.
