# R15 Native First-Run / Free-Capacity Closure — Report

## Scope

Carryover release blockers from the R15 native smoke: supply-class visibility on
routes/providers (RC-5), qualified-vs-runnable recommendation semantics plus labeled
counters (RC-6), and persistent sanitized diagnostics with a one-click support bundle
(RC-7). Auth, endpoint, and quota-poisoning blockers were closed in earlier commits
(8130aa9, d31754c).

## RC-5 — supply class on routes and provider connections

- `ProviderRouteView.supplyClass` and `ProviderConnectionState.supplyClass` now carry
  the forge-zero `SupplyClass` taxonomy end-to-end
  (`packages/model-registry/src/free-cloud-registry.ts`,
  `apps/desktop/src/provider-connections.ts`).
- Derivation: hosted/fds-gateway (`codeforge-cloud`) → `PURE_MANAGED_FREE`; bundled
  product (`codeforge`) → `FREE_PRODUCT_ONLY`; user-connected free keys →
  `USER_CONNECTED_FREE`; developer-machine env credentials → `OWNER_DEV_FREE`;
  promotional/trial/credit classes never fold into baseline product-free counters.
- `freeCloud.setConnection` in `main.ts` stamps the managed gateway connection with
  `PURE_MANAGED_FREE`/`FDS_GATEWAY`.

## RC-6 — Recommended means runnable, counters are labeled

- `categoryFor()` previously returned "Recommended" for any QUALIFIED primary-coding
  model regardless of readiness — the exact DeepSeek V4 Flash defect. Recommended now
  requires current runnable/free readiness; a qualified-but-unavailable model stays
  qualified, never recommended.
- `FreeCloudSummary` carries distinct labeled counters: verified catalog models,
  verified free routes, runnable/healthy free routes, per-supply-class totals, and
  `paidRoutesExcluded`.
- Renderer trust labels no longer expose the internal "ForgeZero" engine name
  (`model-sections.ts`).

## RC-7 — sanitized persistent diagnostics + support bundle

- `apps/desktop/src/diagnostics.ts`: JSON-lines persistent log under
  `userData/logs/codeforge-main.log`, size-capped rotation, console tee, and
  `writeDiagnosticBundle()` → `userData/diagnostics/codeforge-diagnostic-*.json`.
- Sanitization at the write boundary: credential-shaped keys (`apiKey`, `token`,
  `authorization`, `cookie`, `secret`, …) always redact; credential-shaped values
  (`sk-…`, `Bearer …`, `ghp_…`, 40-hex) redact even under innocent names; a second pass
  scrubs older log tails at read time.
- Synchronous appends are deliberate — a buffered stream loses exactly the pre-crash
  lines a diagnostic log exists to capture.
- Cloud auth failures persist `cloud_auth_failed` with a classified `kind`
  (configuration/network/timeout/cancelled/rejected) instead of collapsing into one
  user-facing string.
- `diagnostics:export` IPC gathers only sanitized state — runtime status, free-cloud
  counters, connection metadata (ids, credential source, supply class, route counts),
  `cloudSignedIn` boolean — never credential values. Reachable from
  Settings → Data & Privacy → Support bundle; preload CJS/TS bridges kept in parity
  (pinned by `preload-bridge.test.ts`).

## Verification

- `free-cloud-registry.test.ts`: 31/31 including the RC-6 scenario (quota-exhausted
  qualified model is not Recommended) and supply-class assertions.
- `diagnostics.test.ts` (new, 6/6): key/value redaction, bundle contents, fail-closed
  behavior with no initialized log, log-path invariants.
- `preload-bridge.test.ts`: CJS/TS surface parity including `exportDiagnosticBundle`.
- Desktop suite: 302/302; main + renderer builds clean.

## Packaged smoke

Same run as the UX-overhaul closure (shared packaged build): full/interrupt/recover all
PASS, including `packaged_zero_prompt_workflow=PASS`. Free-exhaustion/no-paid-fallback
is certified by `free-cloud-chaos.test.ts` ("total outage — fail closed, never escalate
to paid") and forge-zero adversarial/capacity matrices.

## Residual / owner actions

- Production Render deployment was an owner action (no API key in-scope); the local
  campaign does not require a redeploy. `cloud-endpoints.json` keeps the committed
  development channel with the real production endpoint registered.
- Staging endpoint remained suspended at baseline; not required for closure.
