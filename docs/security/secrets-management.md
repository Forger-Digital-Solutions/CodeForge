# Secrets Management

Where every secret may live, how it gets there, and where it must never appear.
(Cryptographic details: [encryption.md](./encryption.md). Rotation:
[key-management-and-rotation.md](./key-management-and-rotation.md).)

## Allowed locations

| Secret | Allowed location | How it is loaded | Forbidden locations (enforced by) |
| --- | --- | --- | --- |
| Cloud CRITICAL SECRETS (provider keys, GitHub secrets, JWT secret, KEK ring, Stripe, DB URL) | Render secret env vars (or an operator secret manager that injects env) | `loadCloudRuntimeConfig(process.env)` once at boot, Zod-validated, fail-closed | Database (no column exists); HTTP responses (no route serializes config); logs (`describeConfig` redacts; redacting logger); child processes (env filter deny list); client bundles (Cloud has none); git (secret-scan gate; `.env` ignored) |
| Server-owned provider credentials | `ResolvedProviderCredentials.store` in Cloud memory | `resolveCloudProviderCredentials(env)` | Every provider adapter reads the credential at call time and puts it only in the `Authorization`/`x-api-key` header of the upstream request; errors are collapsed to codes before they can echo a header (`packages/cloud-gateway`, `packages/providers/src/redact.ts`) |
| BYOK provider keys | Desktop `settings.json`, `safeStorage`-sealed | `DesktopCredentialStore` in the Electron main process | Renderer (preload exposes no getter — `apps/desktop/test/electron-security-baseline.test.ts`); Cloud (no BYOK route exists); logs; child processes (env filter); Managed Free / Paid Auto (separate credential resolution — see [provider-security.md](./provider-security.md)) |
| Desktop copy of Cloud tokens | `settings.json`, sealed | `getStoredCloudTokens()` main process only | Renderer; logs; URLs (never placed in a URL — only the 120 s single-use code travels through the browser) |
| Local control-plane bearer | Electron main memory; `~/.codeforge/control-token` (0600) for `forge serve`; VS Code extension memory | Generated with `generateControlPlaneToken()` per process | Renderer (`control-plane-trust.ts` withholds it; injected at the session `webRequest` layer only for the trusted document); URLs (`?controlToken=` is refused); logs (header-name redaction) |
| Environment provider credentials on the user's machine (`OPENROUTER_API_KEY` etc. set by the user) | The user's own shell environment | Read live by `ProviderConnections` when the user *enables* that environment credential; never copied into `settings.json` | Child processes spawned by the agent (env filter strips them so a repository's build script cannot read the user's own keys either) |

## Loading and validation rules

- Every Cloud boot runs `loadCloudRuntimeConfig` (`apps/cloud-api/src/config.ts`): missing or placeholder secrets in staging/production stop the process with a `CloudConfigError` that names the variable and never its value. Test defaults (`codeforge-cloud-test-jwt-secret…`, `sk_test_mock_123`) are refused outside development.
- `describeConfig` is the only thing the startup log prints about configuration: driver, TLS flag, provider *ids*, kill-switch values, `activeKey=vN`, and whether `security.txt` is published.
- The desktop reads its endpoint from `cloud-endpoints.json` in packaged builds and ignores `CODEFORGE_CLOUD_URL`, so a runtime environment variable cannot redirect privileged traffic.

## Never-list (with the control that enforces each)

| Must never contain a secret | Control |
| --- | --- |
| Database rows | No reversible credential column exists; PKCE verifier sealed (`packages/crypto`); tokens hashed |
| HTTP responses | Route handlers serialize records, never config; ATTACK-004 sweeps every route body and header for a planted platform key |
| Logs | `createRedactingLogger` + `sanitizeSecurityAuditEvent` redact by field name and by value shape; ATTACK-006 |
| Error messages to clients | Unknown errors → `INTERNAL_ERROR` + correlation id; known messages pass through `redactSecrets` |
| Child-process environments | `getSanitizedEnvForChild()` on every `spawn`/`execFile` site (command service, agent `run_command`, git in orchestrators, checkpoint/delivery/integration/workspace services, context packing, repository intelligence); ATTACK-005 |
| Model context | Context packing excludes `.env*`, `credentials.*`, `secrets.*`, `*.pem/key/p12/pfx`, `id_rsa`; tool output and diffs pass through `redactSecrets` before the model sees them |
| Renderer | Sandbox + contextIsolation; preload has no credential getter; bearer withheld |
| Repository | Secret-scan gate with self-test (`scripts/security/secret-scan.mjs`), `.env` and scratch files ignored |
| Test fixtures | Only `CF_TEST_SECRET_DO_NOT_USE…`, `mock`, `synthetic`, `example.com` shapes; the scanner classifies test paths as synthetic and the redactor's own patterns are exempt |
| Crash reports / telemetry | None exist (no crash reporter, no analytics SDK — verified by grep in R1 and stated in Settings › Data & Privacy) |

## Secrets in CI

`cloud-ci.yml`, `security-gate.yml`, `windows-desktop.yml`, `repository-intelligence.yml`, and
`release-consumer-acceptance.yml` run without secrets. Only the manual `real-staging-smoke` and
`cloud-staging-certify` jobs read `OPENROUTER_API_KEY`/`GROQ_API_KEY` from GitHub Actions secrets,
and each step self-skips when the secret is absent. Pull requests never receive secrets.

## Developer hygiene

- Copy `.env.example`, never commit `.env` (ignored). Node does not auto-load `.env`; export variables in your shell or platform.
- Use `npm run security:secret-scan` before pushing; the CI gate runs the same scan with a self-test that proves detection still works.
- Prefer explicit `Settings › Providers` entries over shell-environment keys on shared machines: environment credentials are visible to every process the user runs, sealed entries are not.
