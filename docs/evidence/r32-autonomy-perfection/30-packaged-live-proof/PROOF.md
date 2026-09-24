# R32 Packaged Live-Provider Proof

R31 proved "packaged binary" (scripted smoke provider) and "live provider" (harness) only
independently. This artifact closes that residual gap: a real coding task ran **inside the
exact shipping binary** against a **live verified-free cloud provider** and completed.

## Method

`node scripts/packaged-smoke.js live-task` launches `release/win-unpacked/CodeForge.exe`
with `CODEFORGE_PACKAGED_SMOKE_MODE=live-task`. In this mode:

- the scripted smoke provider is **not** registered (it cannot satisfy the task);
- `OPENROUTER_API_KEY` resolves through the normal desktop credential path;
- the real OpenRouter adapter registers and `discoverProviderFree` runs the live catalog
  through ForgeZero;
- the model is pinned via the real `/api/model-selection` control-plane endpoint;
- the workflow runs through the real `/api/workflow/run` endpoint — real engine, real tools,
  real completion gate, real verification command;
- the workspace fixture is the same `src/calc.ts` (`a - b` → `a + b`) used by the packaged
  smoke suite.

## Result (run at commit `acfb06d`)

- `app_is_packaged=true` — the proof ran in the packaged executable, not dev mode.
- `packaged_live_free_models=24` — live catalog discovery verified 24 free models.
- `packaged_live_model_select=200` — `nvidia/nemotron-3-super-120b-a12b:free` pinned.
- `packaged_live_task_phase=completed` — workflow reached terminal `completed`.
- `packaged_live_task_file_correct=true` — `src/calc.ts` contains `a + b`.
- `packaged_live_task=PASS` — smoke runner verdict: `Mode live-task SUCCESS (exit code: 0)`.

## Artifact identity

See `artifact-hashes.txt` — SHA-256 of `CodeForge.exe` and `app.asar` for the exact binary
under test. Build identity recorded at build time: commit `acfb06d`, `dirty:false`.

## What this does NOT prove

- Windows signing/notarization of the installer — external blocker (no signing cert on
  this machine). The `--dir` build is unsigned-but-real packaged output.
- Second-hardware validation — external blocker (single machine available).
- The packaged binary running a *large* task — deliberately out of scope; the proof task is
  a real provider round-trip exercising the full workflow path, not a capacity benchmark.
