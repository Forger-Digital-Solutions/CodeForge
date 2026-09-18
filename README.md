# CodeForge

[![Latest release](https://img.shields.io/github/v/release/Forger-Digital-Solutions/CodeForge?sort=semver&display_name=tag)](https://github.com/Forger-Digital-Solutions/CodeForge/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Forger-Digital-Solutions/CodeForge/total)](https://github.com/Forger-Digital-Solutions/CodeForge/releases)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6)](https://github.com/Forger-Digital-Solutions/CodeForge/releases/latest)
[![License: MIT (pending)](https://img.shields.io/badge/License-MIT%20(pending)-blue.svg)](LICENSE.pending)

**A free-first autonomous software engineering agent for Windows, CLI, and editors.**

CodeForge dynamically routes engineering work across legitimate **zero-cost cloud models**, delegates
tasks to specialized agents, edits repositories, runs tests, reviews its own work, and **refuses to
silently fall back to paid inference**.

- **Free-first intelligence** — ForgeAuto routes only through routes ForgeZero has verified as zero-cost; paid routes exist as a separate, explicitly enabled family and never act as a silent fallback
- **Dynamic routing** — evidence-based model selection across verified providers
- **Autonomous task ownership** — plan, implement, test, review, verify (ForgeVerify is the only authority that can mark a run complete)
- **Windows-first** — desktop app, CLI, and VS Code extension from one core runtime
- **Zero-billing firewall** (`ForgeZero`) — fail-closed cost enforcement at the architecture level
- **Security by construction** — sealed local secrets, server-side platform credentials, sandboxed desktop, credential-free agent subprocesses, tested tenant isolation ([`SECURITY.md`](SECURITY.md))

> CodeForge never intentionally uses paid inference for ForgeAuto.
> CodeForge does not run local LLMs.

## Download

**[⬇ Download the latest release](https://github.com/Forger-Digital-Solutions/CodeForge/releases/latest)** — Windows 10/11 (x64).

Current source version: **v0.4.0** — local release candidate; the latest published GitHub release remains [v0.2.0](https://github.com/Forger-Digital-Solutions/CodeForge/releases/tag/v0.2.0).

| Build | File | Notes |
| --- | --- | --- |
| **Installer** (recommended) | [`CodeForge-Setup-0.2.0.exe`](https://github.com/Forger-Digital-Solutions/CodeForge/releases/download/v0.2.0/CodeForge-Setup-0.2.0.exe) | One-click, per-user install |
| **Portable** | [`CodeForge-Portable.exe`](https://github.com/Forger-Digital-Solutions/CodeForge/releases/download/v0.2.0/CodeForge-Portable.exe) | No installation required |
| **Checksums** | [`SHA256SUMS.txt`](https://github.com/Forger-Digital-Solutions/CodeForge/releases/download/v0.2.0/SHA256SUMS.txt) | SHA-256 of every asset |

> [!NOTE]
> **Releases are not yet code-signed.** Windows may show a SmartScreen / "unknown publisher"
> prompt — choose **More info → Run anyway** only after verifying the download:
> ```powershell
> # from the folder containing the downloaded files and SHA256SUMS.txt
> (Get-FileHash CodeForge-Setup-0.2.0.exe -Algorithm SHA256).Hash.ToLower()
> # compare against the value in SHA256SUMS.txt
> node apps/desktop/scripts/verify-release-hashes.mjs . SHA256SUMS.txt
> ```

## Status

**v0.4.0 — local release candidate.** The source tree has completed the current hardening
campaigns locally; no GitHub release or deployment has been created from them. The last published
release is **v0.2.0**. Current evidence, limitations, and external blockers:
[`CODEFORGE-FULL-SYSTEM-RC-CERTIFICATION.md`](CODEFORGE-FULL-SYSTEM-RC-CERTIFICATION.md) and the
security campaign report
[`docs/certification/codeforge-security-legal-trust-r1-2026-09-18.md`](docs/certification/codeforge-security-legal-trust-r1-2026-09-18.md).

## What CodeForge is

CodeForge is three cooperating pieces (details: [`ARCHITECTURE.md`](ARCHITECTURE.md), [`docs/security/architecture.md`](docs/security/architecture.md)):

| Piece | Role |
| --- | --- |
| **Desktop app** (`apps/desktop`, Electron) | The workbench. Holds your provider keys and Cloud tokens sealed with OS-backed storage, runs the local control plane in-process, and confines the agent to your workspace |
| **Local control plane** (`packages/server`) | The agent runtime, tools, workspace boundary, approvals, verification. Also runs headless via `forge serve` and inside the VS Code extension. Loopback-only, authenticated with a per-launch bearer |
| **CodeForge Cloud** (`apps/cloud-api`, optional) | GitHub sign-in, Hosted Free routing with monthly allowances, publication of certified commits through a GitHub App, billing (Stripe, test mode). Stores no repositories, no prompts, no user API keys |

### Route families (kept separate by design)

| Family | Credentials | Path |
| --- | --- | --- |
| ForgeAuto / Managed Free (Hosted Free) | CodeForge's server-owned keys | desktop → Cloud relay → ForgeZero-verified free provider |
| Paid Auto | server-owned keys, disabled unless explicitly enabled | same relay, paid routes |
| Individually selected paid models | your own key | desktop → provider directly |
| BYOK / direct providers | your own key (Settings › Providers or an enabled environment credential) | desktop → provider directly |
| Future GEMS Auto | to be defined | — |

BYOK keys never reach the Cloud; platform keys never reach your device; no family silently
backstops another. See [`docs/security/provider-security.md`](docs/security/provider-security.md).

### Major subsystems

`packages/forge-zero` (zero-billing firewall) · `packages/router` / `packages/eight-bit` (routing and free-capacity qualification) · `packages/paid-auto` · `packages/forge-green` (efficiency advisor) · `packages/workflow` (ForgeVerify completion gate) · `packages/server` (agent runtime, tools, approvals) · `packages/providers` / `packages/model-registry` (adapters, catalog) · `packages/cloud-*` (auth, db, billing, entitlements, usage, gateway) · `packages/crypto` (AES-256-GCM envelopes) · `packages/secrets` (redaction, env filter, audit log) · `packages/legal-policy` (retention, claims scanner) · `packages/ui`, `packages/vscode`, `packages/cli`.

## Quick start (developers)

```powershell
# from the monorepo root — Node >= 20 (22 recommended: node:sqlite)
npm install
npm run typecheck
npm run build
npm test

# run the CLI (headless local control plane; prints the per-launch bearer file location)
npm run forge -- serve

# run the desktop in development
npm run dev --workspace=codeforge-desktop
```

### Environment and secrets

- Copy [`.env.example`](.env.example) for the variable names; **never commit `.env`** (ignored). Node does not auto-load `.env` — export variables in your shell or platform.
- The Cloud API validates its configuration at boot and **refuses to start** in staging/production with missing or placeholder secrets (`apps/cloud-api/src/config.ts`), including `JWT_SECRET`, `GITHUB_CLIENT_SECRET`, `DATABASE_URL` (TLS-validated), and the data-encryption key ring `CODEFORGE_DATA_ENCRYPTION_KEYS`.
- Platform provider keys live only in the Cloud environment; the desktop reads its own keys from OS-backed storage. Neither is ever passed to agent subprocesses (`packages/secrets/src/env-filter.ts`).
- Prefer `Settings › Providers` over shell environment variables for your own keys; environment credentials are visible to every process you run.
- Run `npm run security:secret-scan` before pushing; CI runs it with a self-test.

### Testing and security gates

```bash
npm test                   # full regression (vitest, all workspaces)
npm run security:tests     # crypto, secrets, OAuth/sessions, payments, tenant isolation, Electron, ATTACK-001…016
npm run security:gate      # secret scan, dependency audit + SBOM, public-claims scan, doc-link validation
npm run lint               # oxlint
```

CI: [`cloud-ci.yml`](.github/workflows/cloud-ci.yml) (cloud suites against real TLS PostgreSQL),
[`security-gate.yml`](.github/workflows/security-gate.yml) (security regression gate, no secrets),
[`windows-desktop.yml`](.github/workflows/windows-desktop.yml) (packaging on `windows-2022`).

### Electron security expectations (contributors)

Every `BrowserWindow` must keep `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`,
`webSecurity: true`; every `ipcMain.handle` must validate the sender; the preload exposes named
methods only (no raw `ipcRenderer`); the renderer never receives a credential or the control-plane
bearer; the production CSP allows no inline or remote scripts. These are asserted by
`apps/desktop/test/electron-security-baseline.test.ts` and the packaged-bundle audit. Do not weaken
them to make a test pass. Details: [`docs/security/electron-security.md`](docs/security/electron-security.md).

### Authentication and GitHub access

Sign-in is GitHub OAuth (`read:user user:email` only), brokered by the Cloud with PKCE and
single-use codes; repository writes require installing the CodeForge GitHub App on selected
repositories. There are no passwords. See
[`docs/security/session-and-api-security.md`](docs/security/session-and-api-security.md) and
[`docs/security/github-access-model.md`](docs/security/github-access-model.md).

## Documentation

- [`SECURITY.md`](SECURITY.md) — security policy and vulnerability reporting
- [`docs/security/README.md`](docs/security/README.md) — threat model, encryption, key management, tenant isolation, incident response, supply chain, compliance readiness, owner actions
- [`docs/security/data-flow.md`](docs/security/data-flow.md) — where your code and prompts go
- [`docs/privacy/`](docs/privacy/data-inventory.md) — data inventory, retention and deletion, third-party processing, privacy rights, cookies
- [`docs/legal/README.md`](docs/legal/README.md) — legal drafts (Terms, Privacy Policy, AUP, billing, DPA, AI disclosure, sub-processors) and the owner-input ledger
- [`docs/FAQ.md`](docs/FAQ.md) — security, privacy, AI/agent, and model questions
- [`docs/ABOUT.md`](docs/ABOUT.md) — what CodeForge is and who makes it
- [`ARCHITECTURE.md`](ARCHITECTURE.md), [`PROVIDERS.md`](PROVIDERS.md), [`ROUTER.md`](ROUTER.md), [`FULL_AUTO.md`](FULL_AUTO.md), [`GEMS_MODE.md`](GEMS_MODE.md), [`PLUGIN_API.md`](PLUGIN_API.md)
- [`CONTRIBUTING.md`](CONTRIBUTING.md), [`AGENTS.md`](AGENTS.md)
- [`.env.example`](.env.example)

## Production safety notes

- ForgeVerify's completion gate is the only path to `completed`; do not add another.
- The Cloud fails closed: unverified cost, missing TLS, missing secrets, and live Stripe keys stop the process.
- Agent commands run on **your** machine with **your** privileges inside the workspace you opened; review what you approve.
- AI-generated code can be wrong; review changes, dependencies, and licences before you deploy.

## License

MIT is the declared license type (`package.json`, `CONTRIBUTING.md`), but the operative `LICENSE`
file is pending the owner's confirmation of the copyright holder — see
[`LICENSE.pending`](LICENSE.pending) and `docs/legal/OWNER-LEGAL-INPUTS.md`. Until it is
authorized, no license grant is in effect.
