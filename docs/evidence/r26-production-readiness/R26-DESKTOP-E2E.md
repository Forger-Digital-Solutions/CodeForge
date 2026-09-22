# R26 Phase 8 — Installed Desktop E2E

**Date:** 2026-09-22
**Build:** `release/win-unpacked` + NSIS rebuilt from working tree at `04aee58` (+R26 lint/packaging fixes)
**Version:** 0.4.0 · Electron 44.4.1 · Node 24.21.0 (packaged)

## Final artifact identity (shipped bytes)

| Artifact | Size (bytes) | SHA-256 (first 16) | Built (UTC) |
|---|---|---|---|
| `release/CodeForge-Setup-0.4.0.exe` | 120,457,173 | `b6a9c038143f855b` | 2026-09-22T01:59:04Z |
| `release/CodeForge-Portable.exe` | 120,121,723 | `cad62e03b55acc8e` | 2026-09-22T01:59:32Z |
| `release/win-unpacked/resources/app.asar` | 43,236,239 | `1e4f6d68dc92c9b7` | 2026-09-22T01:57:54Z |

Build identity embedded in the package: `PACKAGED_BUILD_IDENTITY_VALID=PASS`,
commit `04aee58162b0`, `dirty=true` (lint + packaging fixes landed after `04aee58`).

## Audit battery on the shipped asar

| Audit | Result |
|---|---|
| `audit:internal-deps` | `PACKAGED_INTERNAL_DEPENDENCY_GRAPH_PASS` — 27 `@codeforge` packages incl. `browser`, `mcp`; packaged dist byte-identical to repo dist |
| `audit:runtime-deps` | `PACKAGED_RUNTIME_DEPENDENCY_GRAPH_PASS` — 346 runtime modules scanned, 17 external packages, zero missing |
| `audit:auth-endpoint` (dev channel, mode=development) | PASS — embedded `http://127.0.0.1:3220` matches build authority |
| `audit:browser-security` | `PACKAGED_BROWSER_SECURITY_VALID=PASS` — sandbox, no nodeIntegration, contextIsolation, webSecurity, bearer withheld from renderer |
| `audit:build-identity` | `PACKAGED_BUILD_IDENTITY_VALID=PASS` |

`audit:runtime-deps` also surfaced a false-positive hardening case: a literal
`'import { test } from "vitest";'` inside the eight-bit qualification *fixture
string* scanned as a runtime import. Fixed at the source — the fixture now uses
`/// <reference types="vitest" />` (a valid vitest test file without a bare
specifier) rather than weakening the audit.

## Release-blocking defect found and fixed

`npm run pack` at HEAD failed `audit:internal-deps`:

```
Missing @codeforge/browser; imported by server/dist/external-tools.js, forge-verify-browser.js
Missing @codeforge/mcp; imported by server/dist/external-tools.js
```

Root cause: `apps/desktop/package.json` ships an explicit `files` allowlist of
`packages/<name>` entries. R22 (`1a06f91`) added `@codeforge/browser` +
`@codeforge/mcp` as real server dependencies but never extended the packaging
filter — so the packaged asar silently omitted them along with their external
runtime deps (`playwright-core`, `@modelcontextprotocol/sdk`, `ajv`,
`ajv-formats`, `cross-spawn`, `eventsource`, `eventsource-parser`,
`pkce-challenge`, `zod-to-json-schema`, `content-type`, `fast-uri`,
`fast-deep-equal`, `json-schema-traverse`, `require-from-string`, `isexe`,
`path-key`, `shebang-command`, `shebang-regex`, `which`).

Impact had it shipped: every external-tools / browser-verification / MCP path
in the installed product would fail on module resolution. The existing
`CodeForge-Setup-0.4.0.exe` (built 09-19, before the R22 imports landed) does
not contain the defect — it predates the feature — but **any new installer
built from R22..R26 HEAD without this fix would ship dead external-integration
paths while passing every smoke test that doesn't touch them.**

Fix: extended the `files` allowlist with `browser`/`mcp` dist+manifest entries
and per-package blocks for the real runtime dep closure (traced from the MCP
client entrypoints and playwright-core; server-side SDK deps like
express/hono were deliberately excluded — desktop hosts MCP clients, not
servers). `PACKAGED_INTERNAL_DEPENDENCY_GRAPH_PASS` now reports **27 shipped
@codeforge packages**.

## Packaged smoke — all three legs on the shipped asar, plus a re-run on the exact installer bytes

| Mode | Result | Key assertions |
|---|---|---|
| `full` | PASS (`PACKAGED_FULL_SMOKE_OK`) — run twice: once on the `--dir` asar and once on the final asar the NSIS wraps | startup, ForgeGreen + eight-bit + cloud-db packaged runtimes, renderer lifecycle chain, control-plane trust boundary (bearer withheld from renderer, forged origin/approval rejected, secondary renderer rejected), zero-prompt workflow → terminal `completed`, failure-repair pass, 5× renderer reload, settings roundtrip + strict rejection, extension host (discovery, permission-gated command, workspace:read, lifecycle), credential encryption roundtrip |
| `interrupt` | PASS (`PACKAGED_INTERRUPT_EXPECTED_EXIT`) | expected exit code 73 mid-restart |
| `recover` | PASS (`PACKAGED_RECOVERY_SMOKE_OK`) | restart failed safely, **no approval replay**, corrupt credential fails closed, legacy plaintext sealed+rejected+migrated, credential survives restart, fresh task runs after recovery |

## Verdict

`R26_DESKTOP_E2E_PROVEN` — packaged app boots, authenticates the control-plane
boundary, runs a real workflow to completion, survives mid-restart
interruption without replaying approvals, and keeps credentials encrypted
across recovery — on a build whose dependency graph now passes the product's
own packaging audit.

## Findings carried to release review

- **F-R26-D1 (fixed):** `files` allowlist drift — new server deps did not reach
  the packaged bundle. Fixed in `apps/desktop/package.json`.
- **F-R26-D2:** `packaged_zero_prompt_workflow` passes without exercising
  browser/MCP tools — the smoke suite has no coverage that would have caught
  F-R26-D1 at runtime; the internal-deps audit is currently the only guard.
  Recommend a packaged external-tools import probe in a future smoke leg.
