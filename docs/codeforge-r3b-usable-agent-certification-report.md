# CodeForge R3B usable-agent certification report

Generated: 2026-09-09

## 1. Verdict

`CODEFORGE_R3B_BLOCKED_AGENT_WORKFLOW`

Native packaging, local autonomous execution, durable recovery, steering, free routing, model-picker
interaction, and the existing hosted perimeter are green. R3B is not certified because this run did
not complete the final authenticated packaged-desktop -> hosted-staging -> real repository coding
task. That gate requires real GitHub OAuth consent or a previously issued staging session token.

## 2. Source

- Repository: `G:\CodeForge`
- Branch: `feat/codeforge-cloud`
- Prompt-referenced certified commit: `6b0770b11aab9f71e40b5c953e24e68fabc58707`
- Actual starting HEAD: `9b40dc26c4b4baf9863da558163af756a8817f0f` (`harden ForgeGreen evidence resolution`)
- Ending HEAD: unchanged at `9b40dc26c4b4baf9863da558163af756a8817f0f`
- Working tree: materially dirty before this run with inherited cloud, desktop, agent, workflow,
  UI, and test changes. No reset, checkout, cleanup, push, merge, deploy, or production mutation was
  performed.
- Commits created: none.
- This run's scoped edits: native Python discovery in `apps/desktop/scripts/rebuild-native.mjs`,
  release-build documentation, and two inherited lint errors removed from the staging helper/test.

## 3. R3A Regression Status

- Hosted staging remote probe: **21 passed, 0 failed, 0 warnings**.
- Hosted staging reported database connected, hosted inference ready, 34 catalog models, and 30
  verified-free models.
- HTTPS/TLS, security headers, authentication enforcement, hostile redirect rejection, CORS,
  oversized-body rejection, normalized errors, and unauthenticated SSE entry remained green.
- Full default Vitest run: **221 files passed, 7 skipped; 1,710 tests passed, 35 skipped**. Six failure
  reports occurred only under the highly parallel Windows run: two `%LOCALAPPDATA%` permission errors
  and four 30-second worktree cleanup/time-budget collisions. Re-running the affected tests serially
  with a writable repository-local cache passed all of them.
- Full typecheck and full workspace build passed.

## 4. Desktop Usability

The packaged Windows binary launches, loads the renderer, restores a workspace, indexes and searches
a substantial disposable repository, exposes the model picker, shows compact workflow progress,
handles approval state, persists encrypted credentials, reloads the renderer five times, and recovers
after an intentional interruption.

The staging package embeds `https://codeforge-cloud-staging.onrender.com`; the development endpoint
manifest was restored after packaging. The fresh-user harness also verified an empty profile, empty
provider-key environment, staging readiness, catalog refresh, and OAuth-start URL generation.

The final hosted account and repository coding flow remains blocked at real OAuth consent/session
authority, not at the desktop launch or staging reachability boundary.

## 5. Real Coding-Agent E2E

| Scenario | Evidence | Result |
| --- | --- | --- |
| Bug fix | Packaged `full` smoke used a disposable repository with `src/calc.ts` containing a failing subtraction implementation; the harness observed repair, validation, and the corrected `a + b` content. | **PASS** in the production desktop workflow using the deterministic smoke provider. |
| Multi-file feature | `packages/server/test/parallel-orchestrator-integration.test.ts` exercised concurrent real worktrees, clean synthesis, Git conflict handling, global verification, and target divergence. | **PASS 4/4**; generated fixture worktrees changed multiple files. |
| Failure recovery | Packaged smoke emitted `packaged_failure_repair_pass=PASS`; workflow and ForgeVerify suites also exercised failed verification followed by repair/retest. | **PASS**. |
| Restart/resume | Packaged `interrupt` exited with the expected code 73; `recover` emitted `electron_restart_replan_required=PASS`, `electron_restart_no_approval_replay=PASS`, and completed a fresh task. | **PASS** for packaged local durable recovery. |
| User steering | Steering, approval-adjacent steering, revision fencing, and scoped parallel steering suites passed, including `cf17-parallel-scoped-steer.test.ts` and `mission-steering.test.ts`. | **PASS** in production local authority paths. |
| Authenticated hosted repository task | Fresh-user acceptance reached staging readiness, 30 free models, and OAuth start, then correctly stopped before consent. | **BLOCKED** pending GitHub authorization/session. |

The deterministic/local scenarios are real production runtime paths and real disposable Git workspaces;
they are not a substitute for the missing authenticated packaged-staging repository task.

## 6. Tool Authority

Production-wired paths cover repository indexing/search, bounded file discovery and reads, path-safe
file creation/editing, command execution with timeout/output bounds, tests/build/lint verification,
Git/worktree inspection, diff review, approval resolution, steering, and durable workflow events.

The `AgentRuntime` tool loop receives actual observations. Tool lifecycle and failure handling are
covered by the agent tool-loop, toolchain-adversarial, path-security, agent-security, workflow, and
ForgeVerify evidence suites. Dispatch is not treated as completion.

## 7. Steering

Steering is persisted against the active workflow/session/revision and consumed exactly once. The
focused CF-17 suites proved scoped steering, replanning after a material steer, stale-workstream
fencing, restart replay, and verification re-entry. A steer cannot authorize a newer unrelated
workflow.

## 8. Restart / Recovery

The packaged binary preserved durable state across process interruption and restart. Recovery required
replanning, did not replay the outstanding approval, retained encrypted credentials, and completed a
new task. Local durable continuation and PostgreSQL authority tests from the inherited R3/R4 evidence
remain present; the live staging worker recovery path was not re-certified in this turn.

## 9. ForgeAuto / Free

- Real free-provider smoke discovered OpenRouter, Groq, Google, and Cloudflare provider states.
- ForgeZero admitted **30** verified-free models.
- Real Auto hosted inference selected `openrouter :: cohere/north-mini-code:free` and returned the
  exact marker `CODEFORGE_HOSTED_SMOKE_OK`.
- Usage settlement moved the free smoke balance from 500000 to 499864 credits; owner cash remained
  `$0`.
- ForgeZero failure-matrix tests exclude offline, rate-limited, stale, paid, unknown, and
  paid-fallback-capable records.
- Active-run 8-Bit failover preserved the completed edit, rotated providers, and did not replay the
  write side effect.
- No paid fallback was observed or enabled.

## 10. Model Picker

The desktop picker is grouped into automatic routing, free/$0-now models, account allowance, included
cloud capacity, BYOK, GEMS, and setup/unavailable states. Rows expose provider, access class,
availability, free/BYOK/unavailable state, and details where available. ForgeAuto is the primary
automatic route; 8-Bit remains the free-pool quality/availability authority rather than the general
runtime router.

Packaged smoke verified mouse/keyboard selection and responsive rendering. The focused selector suite
passed 16 tests.

## 11. Verification / Completion Authority

Completion is controlled by `ForgeVerify` and `evaluateCompletion`, not by model prose. Required
verification evidence, current workflow revision, relevant changes, stale-result rejection, bounded
tool failures, and review/validation state are checked before terminal success. Missing evidence,
failed verification, exhausted budgets, stale approvals, and tool loops fail closed.

## 12. Native Packaging

Root cause was environmental and version-specific, not simply “Visual Studio was missing”:

- Host had Visual Studio Community 2026 major version 18, MSVC 14.51.36231, and Windows SDK
  10.0.26100.0.
- The desktop-local `@electron/rebuild` 4.2.0 / node-gyp 12.4.0 successfully understood VS 18.
- Python 3.11 was installed per-user but not discoverable by the original launcher; the sandbox also
  denied SDK access until the build was run at the required host boundary.
- The launcher now prefers configured Python and discovers standard per-user/machine Windows Python
  installs without mutating PATH.

Verified versions:

- Node.js: 24.19.0
- npm CLI: 11.17.0 (the shell npm shim itself was broken; the installed CLI was invoked directly)
- Electron: 33.4.11, embedded Node 20.18.3, ABI 130
- better-sqlite3: 12.11.1
- electron-builder: 25.1.8
- @electron/rebuild: 4.2.0 in the desktop workspace
- node-gyp: 12.4.0 in the desktop workspace

Artifacts:

- [NSIS installer](G:/CodeForge/apps/desktop/release/CodeForge-Setup-0.2.0.exe)
- [Portable executable](G:/CodeForge/apps/desktop/release/CodeForge-Portable.exe)
- [Unpacked executable](G:/CodeForge/apps/desktop/release/win-unpacked/CodeForge.exe)
- [ASAR archive](G:/CodeForge/apps/desktop/release/win-unpacked/resources/app.asar)

Artifacts are unsigned because no signing identity was supplied. That is not the R3B workflow blocker.

## 13. Packaged Desktop Smoke

`npm run smoke:all --workspace=codeforge-desktop` passed against the actual staged binary:

- `full`: exit 0, `PACKAGED_FULL_SMOKE_OK`
- `interrupt`: expected exit 73, `PACKAGED_INTERRUPT_EXPECTED_EXIT`
- `recover`: exit 0, `PACKAGED_RECOVERY_SMOKE_OK`

Observed evidence included renderer load, staging endpoint selection, model picker interaction,
workspace tree, repository index/search, repair, renderer reload, credential encryption/restart,
interruption, replan, and no approval replay.

## 14. Stripe

Code readiness and local tests are present: test-mode credential enforcement, webhook timestamp and
multi-signature verification, idempotent delivery, subscription activation/renewal/cancellation,
entitlement synchronization, and free entitlement preservation are covered by the billing tests.

Local automated billing result: **3/3 tests passed** in `packages/cloud-billing/test/billing.test.ts`.

Real Stripe Test-mode checkout/webhook/customer-portal E2E was not run because no authorized Stripe
test credentials, test price IDs, or webhook secret were supplied.

`STRIPE_TEST_E2E_AUTH_REQUIRED`

## 15. Email

Readiness only. No email provider, DNS, MX, SPF, DKIM, or DMARC values were invented or changed. The
fallback support mailbox remains `forgerdigisolsupport@gmail.com`; the authoritative domain remains
`forgerdigitalsolutions.com`. Future provider setup still needs provider credentials and provider-issued
DNS values for receipts, security notices, and account events.

## 16. Security / Adversarial Results

Notable passing suites from the broad run:

- `packages/server/test/hardening-adversarial.test.ts`: 57/57
- `packages/server/test/agent-security.test.ts`: 5/5
- `packages/server/test/toolchain-adversarial.test.ts`: 7/7
- `tests/cloud-adversarial-security.test.ts`: 14/14
- `tests/production-auth-bypass-guard.test.ts`: 8/8
- `packages/providers/test/isolation-hardening.test.ts`: 4/4
- `packages/server/test/delivery-certification.test.ts`: 14/14

Covered findings include unknown/malformed tools, repeated/stale results, cancellation races, path
traversal, bounded output, timeouts, child cleanup, secret redaction, authority separation, and
paid-routing exclusion. No OAuth, JWT, provider, Stripe, or user-code secret was emitted by the
certification harnesses.

## 17. Regression Tests

Passed commands:

```text
node C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js run lint
node C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js run typecheck
node C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js run build
node apps\desktop\scripts\rebuild-native.mjs
node C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js run dist --workspace=codeforge-desktop
node C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js run smoke:all --workspace=codeforge-desktop
node scripts\cloud\remote-probe.mjs --url https://codeforge-cloud-staging.onrender.com
node scripts\cloud\real-hosted-smoke.mjs
node apps\desktop\scripts\first-user-acceptance.mjs --cloud-url https://codeforge-cloud-staging.onrender.com --no-launch
```

The full parallel suite's six reports were all cleared by serial, writable-cache reruns:

```text
packages/server/test/fg2-runtime-integration.test.ts + fg3-authority-independence.test.ts: 7/7
packages/server/test/agent-orchestrator-integration.test.ts: 5/5
packages/server/test/parallel-orchestrator-integration.test.ts: 4/4
packages/server/test/remote-publication.test.ts: 6/6
packages/server/test/workflow-hardening.test.ts: 8/8
```

## 18. Cost

- New paid infrastructure: none.
- Render/Supabase topology: unchanged.
- Provider calls: free-safe capacity only.
- Current staging target: `$0/month` owner infrastructure cost.

## 19. Remaining Blockers

- Authenticated packaged desktop -> staging -> repository coding task is not complete.
- Real staging OAuth consent/session token is not available in this environment.
- Real Stripe Test-mode E2E is not authorized.
- Production deployment, production secrets, DNS, mail, and signing identity were not touched.

## 20. External User Action Required

Service: GitHub OAuth / CodeForge Cloud staging
Page: CodeForge packaged sign-in flow, or the OAuth URL printed by
`apps/desktop/scripts/first-user-acceptance.mjs --interactive`
Action: Approve the GitHub OAuth consent and return the one-time desktop authorization code, or
provide a short-lived authorized staging access/refresh token through the accepted secret channel.
Why required: OAuth consent and repository authorization are security boundaries and cannot be
invented by the agent.
What it unlocks: authenticated packaged staging inference, exact-model selection, usage/logout, and
the final disposable-repository coding-agent E2E including hosted restart/steering.

Service: Stripe
Page: Stripe Dashboard in Test mode
Action: Supply authorized test secret/webhook credentials and test price IDs through the project
secret-management path.
Why required: billing credentials and payment authorization are external security boundaries.
What it unlocks: real checkout, customer identity, webhook ordering/idempotency, entitlement,
cancellation, failed-payment, refund, and portal E2E.

## 21. Production Activation Readiness

Production activation is not authorized or ready. The remaining gates are the authenticated hosted
desktop repository task, production-specific secret/configuration review, Stripe Test-mode completion
before any billing activation, and a supplied code-signing identity if trusted Windows distribution is
required. No production deployment or DNS change was made.

## 22. Next Recommended Milestone

Run the packaged first-user acceptance flow interactively against the existing staging deployment,
then execute one narrow real disposable-repository task through the authenticated desktop-to-hosted
worker chain, including steering, approval, interruption, resume, ForgeVerify, and final completion.
After that, close `STRIPE_TEST_E2E_AUTH_REQUIRED` with authorized Stripe test credentials.
