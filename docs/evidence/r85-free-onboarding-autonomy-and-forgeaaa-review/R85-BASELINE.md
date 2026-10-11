# R85 baseline audit

## Repository recovery (Phase A1)

- Canonical repository: `G:/CodeForge` (on `codex/r29-release-closure` at `6f8ad979`, owner work present: 6 modified files + extensive untracked benchmark/evidence artifacts — all preserved untouched).
- Published R84: `41f7a1622256067c386118e45a433c2159987aa2` on `codex/r84-free-cloud-autonomy-certification`, worktree `G:/CodeForge/worktrees/r84-free-cloud-autonomy-certification`, clean and aligned with origin.
- R85 branch: `codex/r85-free-onboarding-autonomy-and-forgeaaa-review` created from `41f7a162` in isolated worktree `G:/CodeForge/worktrees/r85-free-onboarding-autonomy-and-forgeaaa-review`.
- Existing worktrees enumerated via `git worktree list`; none deleted or reset.

## Environment

- Windows, Node v24.19.0 (`node:sqlite` path active), npm 11.17.0, git 2.55.0.
- `npm install`: 560 packages, postinstall patch applied; 8 moderate advisories, 0 high/critical (matches R84).

## Baseline validation (Phase A2/A3)

| Check | Command | Result |
|---|---|---|
| Build (all workspaces + desktop) | `npm run build` | PASS — clean typecheck+build, desktop identity stamped `41f7a162` |
| Lint | `npm run lint` | PASS — 0 warnings/errors, 1514 files |
| Security gate | `npm run security:gate` | PASS — secret scan, dependency audit (8 moderate, 0 blocking), public-claims scan, doc links |
| Full test suite | `npm test` | 5197 pass / 2 fail / 57 skip (724.76s) — failures: certificate ENOENT (R84 publication defect, fixed) + Windows EBUSY temp-lock flake; **both pass on re-run → effective 5199/0** — `full-suite.json` |

## Live free-supply observation (Phase C1, 2026-10-11)

- `capacity-audit-1791757144640.json`: kilo-free-direct 12 free models (unchanged from R84), blockrun-free-direct 2 free models, ai-horde 1 — policies VERIFIED for all three.
- BlockRun free roster is **dynamic**: `poolside/laguna-xs-2.1` (chat,coding) and `nvidia/muse-glimmer-30b` (chat,reasoning,coding) rotate through `available:true`; `nvidia/llama-3.2-11b-vision` (vision) is stable.
- Compact qualification evidence: `poolside/laguna-xs-2.1` CODER/TOOL_AGENT/ANALYST **QUALIFIED** (9 requests, `qualify-…-1791757189334.json`); role-protocol probes interrupted by upstream `MODEL_SUBSTITUTED` → receipt marked transient.
- `nvidia/muse-glimmer-30b` CODER **QUALIFIED** (compact, 18 requests); TOOL_AGENT PROBATION (empty structured output); EXPLORER probe also interrupted.
- A subsequent compact run on laguna-xs hit `STREAM_INTERRUPTED` + `MODEL_SUBSTITUTED` — BlockRun free routes show intermittent availability and substitution churn. Fail-closed rejection verified.
- A catalog watcher (`benchmarks/r85/watch-and-qualify.mjs`) polls for a stable window to obtain a conclusive compact receipt.

## Inherited R84 state

- `CODEFORGE_R84_PARTIAL`. Blocking review findings R83-001 (no completed independent review), R83-002 (build/lint — contradicted by current passing receipts, resolved in R84). Advisory: Director PARTIAL, R82 timeout retained, gameplay failures repaired.
- One qualified production-eligible Free Coder domain (Kilo/Cohere). Kilo NVIDIA routes DEVELOPMENT_ONLY (internal evaluation only).
- Not demonstrated: fresh GitHub onboarding, two concurrent live projects, installer signing, production BlockRun/Horde coding capacity.
