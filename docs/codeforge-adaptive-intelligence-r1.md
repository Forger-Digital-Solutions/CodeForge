# CodeForge Adaptive Intelligence R1 — Implementation & Certification Record

**Verdict:** `CODEFORGE_ADAPTIVE_INTELLIGENCE_R1_IMPLEMENTED_OPERATOR_CREDENTIAL_REQUIRED`

Adaptive Intelligence R1 completes the autonomous software engineering team architecture for CodeForge. It introduces deterministic, complementary multi-specialist routing across verified free cloud providers, user-owned Custom AUTO teams with BYOK isolation, 8-Bit roster churn and intelligence tracking, and desktop user interface controls in Settings and the Workspace model selector.

---

## 1. System Architecture

### 1.1 Forge Auto / Free (Top-Four Multi-Specialist Team)
- **Package:** `@codeforge/forge-auto`
- **Trust Domain:** `FORGE_AUTO_FREE`
- **Task Classification:** Tasks are deterministically analyzed across 12 dimensions (`kind`, `complexity`, `risk`, `verificationBurden`) using AST, file-scope, and keyword indicators.
- **Seat Allocation:** Seats (`SWE`, `PLANNER`, `REVIEWER`, `VERIFIER`) are complementary functional roles, not marketing brands.
- **Diversity Margin:** Models are evaluated with seat-specific role scoring; distinct qualified models within an 8-point diversity margin are prioritized over duplicate model assignment.
- **Operational Delegation Records:** Machine-readable operational facts detailing which specialist served which seat and why are persisted as session work items (`forge_auto_delegation_record`) and served via `/api/forge-auto/delegations`.

### 1.2 Custom AUTO (`USER_CUSTOM_AUTO`)
- **Package:** `@codeforge/custom-auto`
- **Trust Domain:** `USER_CUSTOM_AUTO`
- **Profile Storage:** `CustomAutoStore` provides durable SQLite / JSON profile persistence.
- **Strict Boundary:** Custom AUTO profiles are strictly prohibited from using CodeForge-managed free providers (`codeforge`, `codeforge-cloud`, `fds-gateway`). Any attempt to register managed-free routes under a custom profile is rejected at both the store and API boundaries with HTTP 400.
- **Multi-Specialist Execution:** When a Custom AUTO profile is selected, `AgentRuntime` orchestrates user-specified roles:
  - **Coder Specialist:** Executes the primary interactive tool loop and implementation.
  - **Planner Specialist:** (Optional) Synthesizes structured architectural guidance prior to coding.
  - **Reviewer Specialist:** (Optional) Performs automated post-execution diff and safety inspection.

### 1.3 8-Bit Roster Intelligence, Qualification & Churn Layer
- **Package:** `@codeforge/eight-bit`
- **Roster Tracking:** Tracks qualification status, roster revisions, and provider churn. Discovery does not equal qualification; policy authority strictly supersedes benchmark rankings.
- **Specialization Training Pipeline:** Pure TypeScript, zero-external-dependency neural training module (`packages/eight-bit/src/training/`) supporting forward loss, gradient calculation, and SGD optimization.
- **Training CLI:** `scripts/train-8bit.mjs` generates verifiable specialist weights and persists training checkpoints (`artifacts/eight-bit-specialist/checkpoint-*.json`).

### 1.4 Desktop UI & Control Plane Integration
- **Workspace Model Selector:**
  - Dynamic `MY AUTOS` section rendered directly above individual provider listings when custom profiles exist.
  - Canonical Forge Auto / Free entry pinned in `RECOMMENDED`.
  - Non-functional Forge Auto / GEMS disabled with explicit 'GEMS subscription required' badge.
  - Real-time synchronization using `codeforge:custom-autos-updated` custom window event.
- **Settings > Models & Routing:**
  - Dedicated 'MY AUTOS (CUSTOM TEAMS)' management panel.
  - Create, Edit, Duplicate, and Delete actions with client-side and server-side validation.
  - Role configuration cards for SWE Coder (required), Planner (optional), and Reviewer (optional).

---

## 2. Trust Domain & BYOK Isolation Boundary

```
+-----------------------------------------------------------------------------+
|                               CODEFORGE PLATFORM                            |
+-----------------------------------------------------------------------------+
|                                                                             |
|   [ FORGE_AUTO_FREE ]                               [ USER_CUSTOM_AUTO ]     |
|   * Managed Zero-Cost Free Routes                   * User BYOK Credentials |
|   * Operator Credentials Only                       * User Selected Models  |
|     (CODEFORGE_GROQ_API_KEY,                        * Never uses operator   |
|      CODEFORGE_CLOUDFLARE_API_TOKEN)                  managed routes        |
|   * Zero Billing Firewall                           * Strict Schema Guard   |
|   * BYOK Isolation: NEVER touches user keys         * Multi-Specialist Loop |
|   * Operator Credential Absent: FAIL CLOSED         * Dedicated Store       |
|                                                                             |
+-----------------------------------------------------------------------------+
```

1. **Forge Auto / Free Fail-Closed:** When operator credentials are not present in the runtime environment, Forge Auto / Free fails closed with `No eligible free route`. It NEVER touches, reads, or proxies through user personal keys (such as `GROQ_API_KEY`).
2. **Custom AUTO Prohibition:** Custom AUTO is forbidden from claiming `FORGE_AUTO_FREE` or using managed zero-cost providers.

---

## 3. Verification & Certification Evidence

| Verification Phase | Command / Target | Result | Notes |
|---|---|---|---|
| Monorepo Typecheck | `npm run typecheck` (`tsc -b --force`) | **PASS (Exit 0)** | 0 TypeScript errors across monorepo |
| Monorepo Workspace Build | `npm run build` | **PASS (Exit 0)** | All 39 workspaces compiled |
| Desktop Application Build | `npm run build --workspace=codeforge-desktop` | **PASS (Exit 0)** | Main & Vite renderer built cleanly |
| Desktop Native Modules | `npm run build:native --workspace=codeforge-desktop` | **PASS (Exit 0)** | Native rebuild complete |
| Desktop Distributables | `npm.cmd run dist --workspace=codeforge-desktop` | **PASS (Exit 0)** | NSIS installer and portable executable generated |
| Packaged Smoke | `npm.cmd run smoke:all --workspace=codeforge-desktop` | **PASS (Exit 0)** | Full startup/settings/security, interrupt, and recovery modes |
| Adaptive Intelligence Certification | `packages/server/test/adaptive-intelligence-certification.test.ts` | **4 / 4 PASS** | BYOK isolation, multi-specialist run, trust domain enforcement |
| Custom AUTO API Test Suite | `packages/server/test/custom-auto-api.test.ts` | **4 / 4 PASS** | Profile CRUD, managed free rejection, delegations |
| Failover & Side-Effect Safety | `packages/server/test/eight-bit-*.test.ts` | **5 / 5 PASS** | Active failover, restart recovery, side-effect non-replay |
| Complete Vitest Suite | `.\\node_modules\\.bin\\vitest.cmd run` | **331 / 331 PASS** | 2,432 tests passed, 37 skipped, 0 failed |
| Desktop Model Sections Suite | `apps/desktop/test/model-sections.test.ts` | **29 / 29 PASS** | Model picker canonical sections & MY AUTOS |

---

## 4. Operator Credential Audit

- `CODEFORGE_GROQ_API_KEY`: **Absent Locally (Expected)**
- `CODEFORGE_CLOUDFLARE_API_TOKEN`: **Absent Locally (Expected)**
- **Status:** Fail-closed mechanisms function properly. Local developers and end-users can seamlessly utilize BYOK models and Custom AUTO teams while Forge Auto / Free reliably signals credential requirement without crash or credential leakage.

## Release-candidate audit amendments

- The active source-state lineage is `docs/certification/codeforge-adaptive-intelligence-r1-source-state.json`; the historical ForgeGreen certificate is not rewritten.
- Forge Auto team selection consumes the live Free Cloud roster revision and the selected SWE assignment is the route executed by the runtime. Missing managed Free Cloud state is fail-closed; personal provider adapters are not an Auto fallback.
- Selected planner, reviewer, and verifier seats execute separate no-tool inference stages. Delegation evidence records observed reviewer/verifier output and does not invent clean or passed results.
- Custom AUTO profiles are owner-scoped on the shared persistence backend. The UI supports coder, planner, reviewer, and verifier seats; `auto`, `pinned`, and `hybrid` modes remain distinct.
- 8-Bit has a deterministic TypeScript baseline and an optional developer-only PyTorch trainer at `scripts/train-8bit-gpu.py`. Training data is limited to explicitly authorized structured model evidence; inference remains subordinate to ForgeZero, qualification, health, and roster policy.
- Packaged desktop readiness is evidence-based: the current installer, portable executable, and unpacked executable were rebuilt, launched, smoke-tested, and SHA-256 recorded in `docs/certification/codeforge-adaptive-intelligence-r1-rc1.json`.
