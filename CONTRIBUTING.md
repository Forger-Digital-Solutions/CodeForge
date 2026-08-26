# CodeForge — Contributing Guide

CodeForge is MIT licensed. Contributions welcome.

## Getting Started

```powershell
git clone <repo>
cd codeforge
npm install
npm run build
npm test
```

## How to Contribute

1. Open an issue to discuss significant changes
2. Fork, branch, implement, test
3. Ensure `npm run build` and `npm test` pass
4. Small, logical commits with clear messages
5. Open a pull request

## Commit Style

```
feat(core): add persistent task state machine
feat(zero): enforce verified-free model eligibility
feat(router): add capability-aware model routing
fix(tools): correct shell command classification
test(forge-zero): add paid-model denial cases
docs(security): document sandbox boundaries
```

## Code Standards

- TypeScript strict mode, ESM, NodeNext
- No unnecessary comments
- Tests for behavior, not implementation
- New features include unit tests; behavior changes include regression tests

## Security

- Never introduce a path to paid inference
- Never add local LLM support
- Report security issues per `SECURITY.md`

## Architecture

Read `docs/research/codeforge-decisions.md` before making structural changes.
