# CodeForge R10 — Capability Closure Evidence

Verdict: `CODEFORGE_R10_TECHNICAL_PROGRESS_NOT_YET_RELEASE_CANDIDATE`.

This record extends the R9.1X evidence. It does not alter the historical R9 verdict and does not
claim a live benchmark result, database certification, OAuth certification, or production signing
without the corresponding evidence.

## Reconciliation

| Item | Current result |
| --- | --- |
| Repository state | Branch `forger-digital-solutions-forgegreen-certified`, HEAD `2f646ad`; intentionally dirty R9.1X worktree preserved. |
| Runtime | Node 24.19.0; npm.cmd 11.17.0; Electron 44.4.1; Windows 11 build 26200. |
| Full suite | 2,558 passed, 36 skipped, 2 failed. |
| Typecheck / lint | PASS / PASS. |
| Former boundary failures | No longer occur in the canonical full suite. |
| Remaining failures | `fg11-source-state` and `fg12e-harness-provenance`: valid frozen-source sentinels against the pre-existing dirty checkout. They must be recertified from a clean campaign baseline, not weakened. |
| GEMS boundary | No GEMS model, dataset, training, routing, compute allocation, or Auto behavior was modified. |

## Packaged Electron 44 renderer

A fresh Electron 44.4.1 `win-unpacked` package reproduced `RENDER_PROCESS_GONE=launch-failed:49`
and `ERR_FAILED (-2)` while executed by the restricted development automation context. Existing
lifecycle instrumentation established that the main process and local server had started and that
the renderer process never launched; it was not a missing ASAR asset, renderer application error,
or a security-policy error.

The same freshly built bytes were copied to a separate standard per-user installation root and
passed the complete packaged smoke. The smoke evidence records Electron 44.4.1, sandboxed
preload, first paint, secure control-plane isolation, workflow repair, reload recovery, encrypted
credential handling, and `PACKAGED_FULL_SMOKE_OK`. Sandbox, context isolation, web security, and
node-integration restrictions were retained. The previous P0 is therefore closed for the supported
installed deployment path. Development-path renderer failure remains an environment limitation of
the restricted launch context, not a production-package failure.

## CodeForgeBench R2 execution

`@codeforge/benchmark` now exports `runCodeForgeBenchR2Campaign`. Given an executor adapter, it
schedules all 40 public cases by default, owns run IDs and traceability fields, and records an
executor exception as a failed attempt instead of silently omitting a case. The `r9-codeforge-bench`
script accepts `--executor`, `--config-digest`, `--mode`, and split selection; it distinguishes
`EXECUTED_BY_RUNNER` evidence from imported attempt records.

No LIVE PRE, LIVE POST, or protected score is claimed yet. The current manifest deliberately does
not contain fixture setup, a provider configuration, hidden acceptance, or an independent verifier.
An adapter that invents those would fabricate results. The next execution requires a reviewed,
isolated CodeForge adapter and fixture corpus; the runner itself no longer has the former
aggregation-only limitation.

## PostgreSQL and browser availability

Docker and local PostgreSQL tools are unavailable in this environment. Browser automation is now
available and an authenticated Render workspace was observed with a PostgreSQL 16 service and a
staging web service. The existing PostgreSQL validator applies migrations and writes/removes
fixtures, and no isolated `CODEFORGE_TEST_POSTGRES_URL` was configured. The shared service was not
used as a test target. An isolated test database/role (or an explicitly approved disposable
database) is required before the 36 skipped tests can run safely.

Authenticated browser availability does not certify GitHub OAuth, logout, or account switching;
those flows still require an approved staging callback and test identity.

## Release status

Production signing remains unproven: the fresh executable is `NotSigned`, and no trusted signing
certificate was available. With the live benchmark corpus, isolated PostgreSQL certification,
OAuth lifecycle coverage, and production signing still open, CodeForge cannot truthfully be called
a release candidate.
