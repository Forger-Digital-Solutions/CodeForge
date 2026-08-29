# CodeForge

[![Latest release](https://img.shields.io/github/v/release/Forger-Digital-Solutions/CodeForge?sort=semver&display_name=tag)](https://github.com/Forger-Digital-Solutions/CodeForge/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Forger-Digital-Solutions/CodeForge/total)](https://github.com/Forger-Digital-Solutions/CodeForge/releases)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6)](https://github.com/Forger-Digital-Solutions/CodeForge/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A free-first autonomous software engineering agent for Windows, CLI, and editors.**

CodeForge dynamically routes engineering work across legitimate **zero-cost cloud models**, delegates
tasks to specialized agents, edits repositories, runs tests, reviews its own work, and **refuses to
silently fall back to paid inference**.

- **Free-only intelligence** — never routes to paid models, never runs local LLMs
- **Dynamic routing** — evidence-based model selection across free providers
- **Autonomous task ownership** — plan, implement, test, review, verify
- **Windows-first** — desktop app, CLI, and VS Code from one core runtime
- **Zero-billing firewall** (`ForgeZero`) — fail-closed cost enforcement at the architecture level

> CodeForge never intentionally uses paid inference.
> CodeForge does not run local LLMs.

## Download

**[⬇ Download the latest release](https://github.com/Forger-Digital-Solutions/CodeForge/releases/latest)** — Windows 10/11 (x64).

Current release: **[v0.2.0](https://github.com/Forger-Digital-Solutions/CodeForge/releases/tag/v0.2.0)** — *Previous: [v0.1.0](https://github.com/Forger-Digital-Solutions/CodeForge/releases/tag/v0.1.0)*

| Build | File | Notes |
| --- | --- | --- |
| **Installer** (recommended) | [`CodeForge-Setup-0.2.0.exe`](https://github.com/Forger-Digital-Solutions/CodeForge/releases/download/v0.2.0/CodeForge-Setup-0.2.0.exe) | One-click, per-user install |
| **Portable** | [`CodeForge-Portable.exe`](https://github.com/Forger-Digital-Solutions/CodeForge/releases/download/v0.2.0/CodeForge-Portable.exe) | No installation required |
| **Checksums** | [`SHA256SUMS.txt`](https://github.com/Forger-Digital-Solutions/CodeForge/releases/download/v0.2.0/SHA256SUMS.txt) | SHA-256 of every asset |

> [!NOTE]
> **v0.2.0 is not code-signed.** Windows may show a SmartScreen / "unknown publisher"
> prompt — choose **More info → Run anyway**. Verify your download first:
> ```powershell
> # from the folder containing the downloaded files and SHA256SUMS.txt
> (Get-FileHash CodeForge-Setup-0.2.0.exe -Algorithm SHA256).Hash.ToLower()
> # compare against the value in SHA256SUMS.txt
> node apps/desktop/scripts/verify-release-hashes.mjs . SHA256SUMS.txt
> ```

## Status

**v0.2.0 — released** ([GitHub Release](https://github.com/Forger-Digital-Solutions/CodeForge/releases/tag/v0.2.0)). Built and verified on GitHub-hosted Windows runners (`windows-2022` build + `windows-2025` consumer acceptance) from certified commit `805195f`. Graphite/diamond UI, packaged persistence, and free-only security verified. Previous: **v0.1.0 — released** ([GitHub Release](https://github.com/Forger-Digital-Solutions/CodeForge/releases/tag/v0.1.0)). See `docs/` for architecture and research.

## Quick Start

```powershell
# from the monorepo root
npm install
npm run build
npm test

# run the CLI
npm run forge -- version
```

## Documentation

- `README.md` — this file
- `SECURITY.md` — security model
- `CONTRIBUTING.md` — how to contribute
- `AGENTS.md` — AI agent instructions for this repo
- `.env.example` — optional environment variables
- `docs/phase-10.6-report.md` — current implementation status (authoritative audit)
- `docs/research/` — OpenCode/Kilo research and CodeForge architecture decisions

Planned documentation (now written):
- `ARCHITECTURE.md` — system overview and package map
- `PROVIDERS.md` — provider adapter interface and catalog
- `ROUTER.md` — model selection and ForgeZero routing
- `FULL_AUTO.md` — autonomous execution workflow
- `GEMS_MODE.md` — GEMS premium tier entitlement
- `PLUGIN_API.md` — plugin system architecture

## License

MIT
