# R22 External Integrations — Scorecard

Recorded: 2026-09-20
Branch: `forger-digital-solutions-forgegreen-certified`
Base HEAD: `1c98fc7` (R21 close)
Principle: implemented + integrated + benchmarked + adversarially tested = certified;
anything else is labeled with the campaign vocabulary.

## Scope note — what the audit found

The R22 brief assumed the GitHub plane was absent. It was not. R21 already shipped:
identity OAuth (PKCE, `read:user user:email`, scope-frozen), GitHub App installation
authority (repo-id-keyed grants, one-time callback state, revocation), governed
publication (exact-SHA preflight, remote divergence detection, push lease fencing,
ambiguous-failure reconciliation, duplicate-PR suppression), and the tool
authority/durability pipeline (`ToolBroker` → `TaskAuthority` → durable
`agent_tool_execution` records). R22 added only the genuinely missing layers and wired
them into that existing authority — nothing was re-implemented, and no OAuth scope was
widened.

## Milestone ledger

| # | Capability | Evidence | Label |
|---|---|---|---|
| M2 | GitHub auth plane preserved | `github-oauth.ts` untouched; `read:user user:email` scopes unchanged; auth regression suite green under canonical gate | VERIFIED |
| M3 | Repository authorization plane | `github-app-authorization.ts` — repo-id-keyed grants, one-time consumed state, user-mismatch/replay/expiry rejection, revocation cascade (github-app.test.ts) | VERIFIED (pre-existing, re-proven) |
| M4/M5 | Governed push | `remote-publication.test.ts` — exact certified SHA published to real bare remote; crash-window reconciliation with no duplicate push; remote-target divergence fails closed pre-push; unexpected history rejected without force-push; no credential authority = no mutation | VERIFIED (pre-existing, re-proven) |
| M6 | Pull requests | `publication-service.e2e.test.ts` — one PR per delivery; PR-accepted-before-response reconciliation; cross-user repository id rejected; tampered artifact rejected before token mint/push/PR; stale lease fencing with two-executor convergence | VERIFIED (pre-existing, re-proven) |
| M7 | GitHub webhooks | `github-webhook.ts` + migration 016 `github_webhook_deliveries` — HMAC-SHA256 `sha256=` verification (timing-safe), atomic delivery-GUID dedup, `installation.deleted/suspend/unsuspend`, `installation_repositories.removed`, repo reconcile events, ping/unknown ignored. 10 tests incl. restart-dedup and forged-secret rejection | VERIFIED |
| M8 | Browser runtime | `packages/browser` — playwright-core driving installed Edge headless; isolated contexts; semantic DOM inspect; role/name/testId/label/text targeting; click/type/select/submit; console+network capture; downloads quarantined with sha256 (never executed); screenshots hashed; session caps; crash handling | VERIFIED (17 runtime+tool tests) |
| M8-sec | Browser SSRF boundary | URL policy (scheme allowlist, metadata/link-local always denied, private-network opt-in) enforced at TWO layers: pre-navigation check AND a context route gate re-checking every request including redirect hops and subresources. Redirect→metadata 302 proven blocked by a real browser test | VERIFIED |
| M9 | ForgeVerify browser evidence | `verify-cli.ts` subprocess verifier + `browserVerificationDefinition()` factory — independent fresh session, exit-code verdict, JSON verdict with finalUrl/title/domHash/screenshotHash bound by outputDigest inside the integrity-hashed, inputStateHash-bound evidence record. E2E CLI run proven against live fixture | VERIFIED |
| M10 | MCP client | `packages/mcp` — official SDK stdio transport, initialize handshake, tools/list+tools/call, per-call timeouts, crash/dead-state tracking, malformed-descriptor fail-closed, output redaction+truncation, trust profiles (deny/network_read/external), namespaced `mcp__<server>__<tool>` bridging. 19 adversarial tests | VERIFIED |
| M11 | Unified tool surface | `external-tools.ts` composition + `AgentRuntimeOptions.externalTools` — defs registered per-run under namespace-prefix guard; executor chained repo_* → external → custom; `describeAction` maps browser reads→T2, interactions→T2 grantable, submit→T3 external, MCP via registry `effectOf` (unknown→T3); durable records carry `executionClass:"network"`; `network:false` leases deny at the broker | VERIFIED (17 wiring tests) |
| M11b | Plugin command bridge | R21's un-bridged extension host now reaches the agent: contributed commands of active extensions become `plugin__<ext>__<cmd>` tools (names sanitized for provider-wire constraints), `write`-gated (invisible to read-only roles), Tier 2 grantable via `action:"plugin"`, dispatch through the sandboxed `ExtensionHost` with bounded results; `exposeCommands:false` kills the bridge; desktop injects its live `ExtensionManager` | VERIFIED |
| M12 | ForgeGreen external dedup | `DuplicateActionSupervisor` external classifier — browser reads + MCP `network_read` suppressible inside a state window; interactions/MCP `external` bump stateVersion so stale reads can never replay as post-interaction evidence. Proven end-to-end in the run loop | VERIFIED |
| M13 | Single publication authority | Structural: zero agent-facing publish/push/PR tools (tripwire test fails if one is ever registered); every subagent role runs `network:false`; read-only roles cannot execute mutating external tools; external-commit tools denied outright on autonomous runs (no approval channel); interactive path reaches them only through the approval gate | VERIFIED |
| M14 | Adversarial campaign | Prompt-injection page content inert (untrusted-data wrap); redirect-SSRF blocked; metadata endpoints denied; forged webhook signatures rejected; replayed deliveries deduped (incl. across restart); secrets in external output redacted before record+model; malformed MCP descriptors rejected; disabled/crashed/hung MCP servers fail closed; unprefixed tool defs rejected at registration; disabled/error-state extensions never bridge commands | VERIFIED |

## Live external operations disclosure

No live GitHub mutation, push, PR, or webhook delivery was performed. Browser tests ran
exclusively against a loopback `node:http` fixture and a real installed Edge binary.
MCP tests ran against a local hand-rolled fixture server process. No credential left
the test process. **NOT RUN — OWNER AUTHORIZATION REQUIRED** for live GitHub
publication/PR verification.

## Canonical gate

Root `vitest.config.mts` run (authoritative configuration), 2026-09-20:

- **414 test files passed | 8 skipped** (422)
- **3266 tests passed | 47 skipped** (3313)
- Zero failures; skips are the documented PostgreSQL-gated suites.
- +8 files / +78 tests over the R21 baseline (406 / 3188).
- FG-11/FG-12E source-state canaries green at close — the certified source-state
  document was re-frozen at `829fcc5d…` covering exactly the three intentionally
  changed material files; the canaries correctly tripped mid-milestone and were
  recertified only after the drift was verified file-by-file.

## What is NOT certified

- Live GitHub end-to-end publication against the real GitHub API — blocked on owner
  authorization (fixtures and bare-remote e2e cover every step but the final
  authenticated network call).
- Browser headed mode / cookie persistence / multi-session UI — out of R22 scope
  (headless governed sessions only).
- MCP over remote HTTP transport — client supports the config shape; only stdio is
  exercised end-to-end in tests (plaintext-HTTP rejection is tested).
- GEMS execution — still simulation-only (unchanged from R21).
