# CodeForge

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

## Status

v0.1 — initial build. See `docs/` for architecture and research.

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
