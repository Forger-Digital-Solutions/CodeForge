# About CodeForge

CodeForge is a free-first autonomous software engineering agent for Windows, the command line,
and editors, made by Forger Digital Solutions (FDS). It plans, edits, tests, reviews, and
verifies changes to real repositories, routing model work across zero-cost cloud routes it has
verified — and refusing to fall back to paid inference silently.

## What it does

- **Autonomous task ownership**: given a task, the agent explores the repository, implements
  changes in an isolated worktree, runs tests and reviewers, and can only mark work complete
  through ForgeVerify's evidence gate.
- **Free-first routing**: ForgeAuto routes only through routes that the ForgeZero firewall has
  verified as zero-cost (fail-closed when it cannot verify), with a monthly hosted allowance from
  CodeForge Cloud and no paid fallback. Paid routes and your own provider keys are separate,
  explicit choices.
- **Provider flexibility**: connect your own provider accounts (BYOK) or use the managed free
  pool; models are selected on evidence (capability, health, cost verification, your privacy
  routing mode), not on marketing.
- **Verification emphasis**: completion is enforced, not asserted. Runs that verified nothing,
  changed nothing they claimed to change, or ran out of budget end as blocked, never as success.
- **Publication**: certified commits can be pushed and opened as pull requests through a
  GitHub App you install on the repositories you choose.

## Security and privacy philosophy

Say only what the code does, and make the code do the safe thing by default:

- Your repository stays on your machine; only the context a task needs goes to the provider
  serving it, and you choose which providers and which privacy routing mode.
- Your keys are sealed on your device and never uploaded; CodeForge's own platform keys never
  leave its servers and are never shown to a model.
- The desktop is sandboxed; the agent is confined to your workspace and to the commands you
  approve; its subprocesses run with credentials removed.
- CodeForge Cloud stores no prompts, no repositories, no user API keys, and no card data; session
  credentials are hashed; the one reversible secret it keeps is encrypted with a versioned key.
- No telemetry, analytics, or crash reporting of any kind.
- Claims are gated: a scanner in CI blocks unsubstantiated security or compliance wording in
  public copy, and every control above has a test. See [`SECURITY.md`](../SECURITY.md) and
  [`docs/security/`](security/README.md).

## Relationship to the wider FDS work

CodeForge is developed and published by Forger Digital Solutions on GitHub
(`Forger-Digital-Solutions/CodeForge`), with sign-in for the optional Cloud account provided
through the FDS website. Corporate details for the legal documents are pending the owner's input
(`docs/legal/OWNER-LEGAL-INPUTS.md`); this page does not state company history, staff, offices,
funding, customers, or certifications because none are recorded in this repository.

## Status

Source version 0.4.0 (local release candidate); latest published release v0.2.0. Windows
releases are not yet code-signed — verify SHA-256 sums. The MIT license type is declared and the
operative license file is pending owner authorization.
