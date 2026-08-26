# CodeForge Agent Instructions

This document provides guidance for AI agents working in the CodeForge repository.

## Project Overview

CodeForge is a free-first autonomous software engineering agent platform. It routes engineering
tasks across legitimate zero-cost cloud LLM providers using evidence-based routing, with a
zero-billing firewall (`ForgeZero`) that prohibits paid inference and local LLM use.

## Repository Structure

- `packages/` — all library/runtime code (monorepo via npm workspaces)
- `apps/` — runnable products (desktop, docs)
- `plugins/` — first-party plugins
- `tests/` — integration, e2e, security, provider-contract tests
- `docs/` — documentation and research
- `scripts/` — build and utility scripts

## Key Architectural Rules

1. **Free cloud models only.** Never route to paid models. Never use local LLM inference.
2. **ForgeZero is central.** All model eligibility passes through the zero-billing firewall.
3. **Client/server.** `forge serve` is the runtime; CLI/Desktop/VS Code are thin clients.
4. **Runtime correctness beats UI completeness.**
5. **Fail closed.** If free status cannot be verified, do not route to the model.

## Technology

- TypeScript (strict, ESM)
- Node.js (>= 20)
- npm workspaces (Bun not currently available)
- SQLite via `node:sqlite` on Node >= 22.5, transparently falling back to
  `better-sqlite3` (compiled by CI/electron-rebuild, never on user machines)
  where `node:sqlite` is unavailable — see `packages/sessions/src/sqlite.ts`
- Vitest for testing
- React + Electron for Windows desktop
- VS Code extension as thin client

## Build & Test

```powershell
npm install      # install all workspace dependencies
npm run build    # typecheck + build all packages
npm test         # run all tests via vitest
```

## Code Style

- No comments unless they explain *why*, not *what*
- Prefer explicit types; avoid `any`
- One module concern per file
- Functional patterns preferred; classes only where stateful identity matters
- ESM imports must include file extensions (NodeNext)

## Package Conventions

Each package lives in `packages/<name>/` with:
- `package.json` (name `@codeforge/<name>`)
- `tsconfig.json` (extends `../../tsconfig.base.json`)
- `src/` — source
- `test/` — unit tests (`*.test.ts`)

## Safety Hierarchy

1. User's explicit current instruction
2. CodeForge global safety / zero-cost requirements
3. GEMS governance (when active)
4. This AGENTS.md / CodeForge policy
5. Task plan
6. Model suggestions

A model recommendation never overrides safety policy.
