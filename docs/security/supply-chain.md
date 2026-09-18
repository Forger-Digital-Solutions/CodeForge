# Supply-Chain Security

Dependencies, build tooling, CI, and release integrity (Phase 28). Evidence:
`docs/evidence/security-r1/dependency-audit.json`, `docs/evidence/security-r1/sbom.json`.

## Dependency inventory (R1 snapshot)

| Fact | Value |
| --- | --- |
| Package manager / lockfile | npm workspaces, `package-lock.json` (lockfileVersion 3), installed with `npm ci` in every CI job |
| Resolved components (all workspaces, dev + prod) | 540 (see `sbom.json`, generated from the lockfile with name, version, license, resolved URL, integrity prefix, install-script flag) |
| Known vulnerabilities at R1 | **0** (`npm audit`: 0 info / 0 low / 0 moderate / 0 high / 0 critical) |
| Runtime dependencies of the Cloud API | `zod`, `pg` 8.23.0, `better-sqlite3` 12.11.1 (fallback driver), first-party `@codeforge/*` packages |
| Runtime dependencies of the desktop | Electron 44.4.1 (Chromium/Node bundled), React 19.2.8, `better-sqlite3` (Electron ABI build), first-party packages |
| Cryptographic libraries | **None third-party**: `node:crypto` (OpenSSL via Node) and Electron `safeStorage` only |
| Authentication libraries | None third-party: JWT/PKCE/HMAC implemented over `node:crypto` (small, reviewed, tested) |
| Build tools | TypeScript 5.9.3, Vite 8.3.0, Vitest 5.0.1, oxlint 1.83.0, electron-builder 26.15.3 |
| Packages with install scripts | `better-sqlite3@12.11.1`, `electron-winstaller@5.4.0`, `fsevents@2.3.3` (macOS-only, optional) — `allowScripts` in the root `package.json` permits only `electron` and `better-sqlite3`; everything else runs with scripts ignored |
| Local patches (`patch-package`) | `patches/builder-util+26.15.3.patch` — a spawn-logging fix in electron-builder's util; reviewed, no security-relevant change |

## Controls

| Control | Status | Where |
| --- | --- | --- |
| Reproducible installs (`npm ci` against the lockfile; integrity hashes verified by npm) | IMPLEMENTED | every workflow |
| Install-script allowlist | IMPLEMENTED | `package.json` `allowScripts` |
| Vulnerability gate with expiring allowlist (fails on high/critical) | IMPLEMENTED / VERIFIED | `scripts/security/audit-dependencies.mjs`, `security-gate.yml` |
| SBOM generation (CycloneDX-style summary) | IMPLEMENTED / VERIFIED | same script → `sbom.json` |
| Repository secret scan with self-test | IMPLEMENTED / VERIFIED | `scripts/security/secret-scan.mjs` |
| Third-party license audit of the shipped `app.asar` | IMPLEMENTED (legal pass) | `docs/legal/open-source-license-audit.md`, `npm run legal:notices` |
| GitHub Actions pinned to major versions (`actions/checkout@v4`, `setup-node@v4`, `upload-artifact@v4`) | PARTIAL — major tags, not commit SHAs | workflows |
| Workflow permissions least-privilege | PARTIAL — `security-gate.yml` sets `permissions: contents: read`; other workflows use defaults | workflows |
| Secret-free pull-request CI | IMPLEMENTED | only manual jobs read provider secrets |
| Native module built on CI, never on user machines (Windows toolchain pinned to `windows-2022`) | IMPLEMENTED | `windows-desktop.yml` |
| Release integrity: SHA-256 sums published; verification script | IMPLEMENTED | `SHA256SUMS.txt`, `apps/desktop/scripts/verify-release-hashes.mjs` |
| Code signing of Windows releases | **NOT IMPLEMENTED** — requires a certificate (OWNER-ACTIONS) | — |
| npm package provenance / signature verification (Sigstore) | NOT IMPLEMENTED | — |
| Dependabot / Renovate | NOT CONFIGURED (the audit gate catches advisories at CI time; automated upgrade PRs are a deployment/repo setting — OWNER-ACTIONS) | — |
| Electron/Chromium/Node currency | Electron 44.4.1 pinned; upgrade cadence is manual | `apps/desktop/package.json` |

## Upgrade policy (what R1 did and did not do)

R1 upgraded nothing: the audit reported zero advisories, and bulk upgrades would have
destabilized the Electron native-module build (see the `windows-2022` runner pin). Priority order
for future upgrades, per the campaign brief: exploitable critical → high-risk → security-sensitive
foundations (Electron/Chromium/Node, `pg`, `better-sqlite3`) → crypto (none third-party) → auth
(none third-party) → network/server libraries → everything else.

## Running the checks

```bash
npm run security:audit        # npm audit gate + SBOM
npm run security:secret-scan  # self-test + repository scan
npm run security:gate         # all four gates (audit, secrets, claims, doc links)
```
