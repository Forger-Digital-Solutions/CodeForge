# CodeForge R7R — Packaged Desktop Closure Certification

## Verdict

`CODEFORGE_R7R_PACKAGED_DAILY_DRIVER_BLOCKED`

The R7R packaging, first-paint, controlled workflow, and restart-recovery closure is proven for the final6 package. R7 daily-driver certification remains blocked because its mandatory live-authentication, large-catalog picker, five-user-task, and benchmark gates were not exercised.

## Certified source and package

- Repository: `G:\CodeForge`; branch: `feat/codeforge-cloud`; HEAD: `9b40dc26c4b4baf9863da558163af756a8817f0f`.
- The worktree was dirty before this work and remains so; unrelated inherited work was preserved. No commits, remote actions, or deployments were made.
- Node `v24.19.0`; the installed npm shim remains unusable, so local TypeScript, Vite, Vitest, and electron-builder entry points were used.
- Final controlled build: `apps/desktop/release-r7r-final6`, built from the final compiled `apps/desktop/dist` and `packages/workflow/dist` payloads.

| Artifact | Size | SHA-256 |
|---|---:|---|
| `CodeForge-Portable.exe` | 85,391,444 bytes | `3A5E324EDD6F75A00B70455C2AC4298459D40C8258A4A53BF52676965806565E` |
| `CodeForge-Setup-0.2.0.exe` | 85,662,190 bytes | `DE1BB65235B8484C49193A118309AA0A1FC3EEB8E76DD845494D3124B951322D` |
| `win-unpacked\CodeForge.exe` | 188,875,264 bytes | `8966443392D2C66EF7693BDD9B43AFCBEABBC1ADA4B19E3C6BD37B9432FA262D` |
| `win-unpacked\resources\app.asar` | 21,411,917 bytes | `477E87C8907A06FE357009DFFDEBF903EE21854FBC4555B8B9ED742D77FFE911` |

The exact portable wrapper was launched directly; it started `CodeForge-Portable.exe` and extracted/started its embedded `CodeForge.exe`. Renderer evidence below was run against the `win-unpacked` payload from that same final build, using `app.isPackaged === true` and the final `app.asar` path.

`app.asar` was inspected directly: it contains the final desktop main module with both GPU-disabling calls and the final workflow module with `ELECTRON_RUN_AS_NODE` preservation.

## R7R closure evidence

- Hardware acceleration and Chromium GPU are disabled before Electron window creation. The prior GPU subprocess crash did not recur.
- Final packaged full smoke passed: server initialized, window reached `ready-to-show`, renderer finished loading, onboarding and provider setup rendered, and the renderer credential boundary held.
- The packaged workspace opened, indexed 258 files / 259 symbols, returned the known repository query, and rejected workspace escape.
- A controlled packaged repair workflow completed after an approval, repaired `src/calc.ts`, passed verification, and survived five renderer reloads.
- Credential persistence remained encrypted, restarted successfully, and malformed encrypted data failed closed.
- Final interruption smoke exited deliberately with code 73 only after a pending approval existed.
- Final recovery smoke passed: the interrupted turn entered `recovering`, its approval was not replayed, durable `turn.recovery/replan_required` evidence was present, and a fresh post-restart no-op task reached terminal `blocked` with the completion gate's `no_effective_change` evidence. The gate was not weakened to call that task successful.

## R7R changes

- `apps/desktop/src/main.ts`: disable incompatible GPU acceleration; make the packaged recovery smoke follow current durable no-replay semantics and terminal `blocked` state.
- `packages/workflow/src/forge-verify.ts`: preserve Electron-as-Node for structured verifier subprocesses, preventing packaged verification commands from opening a second GUI process.
- `apps/desktop/src/renderer/styles.css`, `index.html`, `OnboardingFlow.tsx`, and `WorkspaceShell.tsx`: preserve the R7 account sizing, bundled `data:`-image CSP, and 30-day allowance-copy fixes.
- `apps/desktop/test/startup-reliability.test.ts` plus ForgeVerify regression coverage: protect GPU startup and Electron verifier execution.

## Validation

- Focused source suite: 6 files, 26 tests passed, including the Electron-as-Node verifier regression and desktop startup/preload/CSP/single-instance checks.
- Workflow TypeScript compile, desktop main TypeScript compile, and renderer production build passed. Vite still reports the known 516 KB minified renderer-chunk advisory.
- Final6 package full, interrupt, and recovery smoke all passed.
- The broad root typecheck remains blocked by inherited dirty-tree protocol/session desktop-worker additions. The earlier broader focused run also retained inherited failures and Windows timing/permission issues; those were not used as evidence of success.

## Remaining mandatory R7 gates

1. Live packaged GitHub/Codex-account sign-in, cancellation, sign-out, restart restoration, and actual provider routing.
2. Large real catalog picker search/filter/keyboard/persistence and explicit-model invocation.
3. Five realistic user-driven packaged dogfood task categories.
4. Packaged approval, steering, cancellation, reconnect, workspace-isolation, and visible error-recovery scenarios beyond the controlled closure smoke.
5. The repeatable eight-category R7 benchmark suite.

## R7U packaged desktop follow-up

R7U produced a fresh \`apps/desktop/release-r7u-final5\` payload after the R7R closure. Its full,
interrupt, and recovery smoke paths passed with real packaged pixel captures for onboarding,
workspace, structured model catalog/filter, completed repair, and restart recovery. The R7U UI
pass adds model-catalog filtering, task-list recency/status context, and phase-led status without
changing model-routing, approval, or completion authority. Details and final5 hashes are in
\`docs/codeforge-r7u-visual-certification-report.md\`.

R7 remains blocked: the R7U deterministic smoke catalog is not the required live 400+ catalog,
and it does not replace live account routing, five realistic user tasks, collaboration/reconnect,
or benchmark gates.

## Comparison-app note

For R7U, Claude/Claude Code, Codex/ChatGPT, Devin, OpenCode, and Z Code process trees were
confirmed running and inspected via connector inventory, PID-correlated Win32 window enumeration,
and attempted full-desktop capture. The available surface still exposed no native app windows and
the screen capture returned an invalid black frame, so no private competitor UI is claimed as
visually inspected. Current official first-party references were used instead; see
\`docs/certification/r7u/reference/index.md\`.
