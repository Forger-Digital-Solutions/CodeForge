# R26 Phase 14 — Security, Installer & Release-Blocker Ledger

**Date:** 2026-09-22 · HEAD at evidence time: `221226e` (lint gate + health endpoint + fixture fix)

Every blocker found during the R26 campaign, its disposition, and the evidence that closed it.
Nothing on this list is waived silently — items either carry a fix commit or an explicit
recorded-gap verdict.

## Closed blockers

| ID | Defect | Disposition |
|---|---|---|
| F-R26-D1 | `files` allowlist omitted `@codeforge/browser` + `@codeforge/mcp` → packaged app shipped dead external-tools/browser/MCP paths | Fixed in `eec6737`; `audit:internal-deps` + `audit:runtime-deps` green on shipped asar (27 internal packages, 346 modules, 0 missing) |
| F-R26-7A | `withTx` checked-out pool client emitted unhandled `'error'` on backend kill → process crash | Fixed in `c17336d`; chaos re-run 20/20 exactly-once through 7 kill rounds |
| F-R26-2A | No unauthenticated readiness route — clients probed an authenticated endpoint to detect `forge serve` readiness | Fixed in `221226e`: `GET /api/health` → `{status:"ok"}` before the bearer gate; 401 on protected routes preserved |
| F-R26-L1 | `npm run lint` (deny-warnings) red — 15 errors + 11 warnings across product + evidence code | Fixed in `221226e`; lint 0/0 on 1,121 files |
| F-R26-P1 | eight-bit qualification fixture contained a literal `from "vitest"` string, flagged by `audit:runtime-deps` | Fixed in `221226e` via `/// <reference types="vitest" />`; audit kept strict |
| F-R26-S1 | `scripts/r4-scale-sim.mjs` silently produces 0 capacity at HEAD (legacy route fields ignored by current policy engine) | Replaced by `scripts/r26-capacity-model.mjs` (current `CapacityRoute` contract); R4 script flagged not-to-cite in `R26-CAPACITY.md` |
| F-R26-T1 | Full-suite run: FG-12E provenance check failed — `workflow-service.ts` (a certified material file) drifted under the lint fix | Resolved by proper recertification (`scripts/r26-recertify-source-state.mjs` → `r26-release-readiness-v1`); provenance test re-run green; change documented as semantic no-op |

## Security suite

`packages/cloud-auth` + server security tests: **40/40 green** — session revocation,
refresh-token replay prevention, encrypted-row restoration, control-plane bearer isolation,
command/tool secret isolation, unknown-error redaction, security audit events.

Packaged audits on the shipped asar (`221226e` build):
`internal-deps` PASS · `runtime-deps` PASS · `auth-endpoint` PASS (dev channel) ·
`browser-security` PASS (sandbox/no-nodeIntegration/contextIsolation/bearer-withheld) ·
`build-identity` PASS.

## Recorded gaps (not blockers, or blocked pending a decision)

| ID | Finding | Status |
|---|---|---|
| F-R26-D2 | Packaged smoke never exercises browser/MCP tool paths at runtime — F-R26-D1 was caught by the dep audit, not a functional probe | **Recorded** — recommend a packaged external-tools import probe smoke leg |
| F-R26-4A | `cloudflare-workers-ai` adapter + neuron guard exist but nothing in `forge serve` instantiates it — supply evidence would be unusable | **Recorded wiring gap** — product decision: wire CF adapter or leave routes unqualified |
| F-R26-4B | Planner supply = 1 route (`groq::qwen3.8-27b`); failing free models emit schema-valid thin plans | **Recorded** — capability boundary of free-tier models; protocol deliberately not loosened |
| F-R26-5A | `qwen3.8-27b` OTPM cap (1k/min output) below the 4,096-token production-shaped request shape | **Recorded** — route usable for planner/reviewer-sized calls only |
| F-R26-H1 | Direct health-endpoint harness emits a Windows libuv assertion during *shutdown* (`UV_HANDLE_CLOSING`); endpoint behavior itself verified (200 unauth / 401 / 200 auth) | **Recorded harness teardown issue** — endpoint evidence stands; not a product defect |
| F-R26-G1 | Two wall-clock-marginal tests time out under full-suite concurrency, pass standalone (remote-publication 27.8s/28.4s; forge-verify 6.2s vs 20s timeout) | **Recorded** — per AGENTS.md these run standalone; no timeouts relaxed |

## Verdict

`R26_RELEASE_BLOCKERS_CLOSED` — every discovered defect that could ship to a user is either
fixed with evidence on this ledger or explicitly recorded as a bounded gap. Security suites and
all packaged audits are green on the artifact built from `221226e`.
