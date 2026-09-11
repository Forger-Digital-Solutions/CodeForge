# CodeForge Claims Substantiation & Marketing Audit

**Audit Date**: September 10, 2026
**Auditor**: Primary Audit Agent (Pass 1)
**Standard**: FTC Act Section 5 (Unfair or Deceptive Practices), FTC Green Guides (16 CFR Part 260), Lanham Act § 43(a).

---

## 1. Executive Summary & Substantiation Framework

Under United States federal law (FTC Act § 5) and international consumer protection standards, all objective product claims made in commercial representations, documentation, or software interfaces must be substantiated by competent and reliable empirical evidence *prior* to dissemination.

This audit reviews four core claims pillars in CodeForge:
1. **ForgeZero**: "Zero-billing guarantee" / "100% free AI inference".
2. **ForgeGreen**: "Carbon-aware routing" / "Green AI computing".
3. **ForgeVerify**: "Verified completion" / "Automated quality certification".
4. **Security & Sandboxing**: "Sandboxed agent" / "Zero-trust local execution".

---

## 2. Claims Scrutiny & Remediation Matrix

| Feature / Domain | Current Marketing / Doc Claim | Technical Reality in Codebase | Substantiation Status | Legal Risk Level | Required Corrective Language |
|---|---|---|---|---|---|
| **ForgeZero** | *"Guarantees zero billing for AI inference; you will never be charged."* | CodeForge enforces architectural fail-closed routing (`packages/forge-zero`) that blocks paid models. However, CodeForge cannot control upstream provider billing system bugs or tier modifications if provider telemetry fails (`observedExecutionCost = null`). | **PARTIALLY SUBSTANTIATED** | **HIGH** (Consumer deception / FTC liability if provider bills user). | *"Architectural zero-billing firewall engineered to block paid API routes and enforce verified zero-cost model eligibility. While designed to prevent billable routing, CodeForge cannot guarantee third-party provider billing accuracy."* |
| **ForgeGreen** | *"Reduces carbon emissions of AI computing; green sustainable AI."* | `packages/forge-green/src/carbon-grid.ts` uses time-of-use heuristics and public carbon intensity estimates to delay background tasks. Crucially, `docs/forgegreen.md` line 143 explicitly states: *"No carbon, energy, watt, or emissions quantity is claimed."* | **UNSUBSTANTIATED FOR QUANTITATIVE CLAIMS** | **HIGH** (FTC Green Guides scrutiny for unverified environmental benefit claims). | *"Energy-aware task scheduler that uses public grid intensity heuristics to prioritize compute during off-peak hours. Makes no claims of specific carbon offsets, emissions reductions, or environmental certifications."* |
| **ForgeVerify** | *"Certifies that generated code is fully verified, bug-free, and production-ready."* | `packages/workflow/src/completion-gate.ts` runs user-configured test commands, linters, and git diff assertions. Passing tests does not prove absence of edge-case bugs, security vulnerabilities, or logical defects. | **OVERBROAD** | **MEDIUM** (Breach of warranty / fitness for purpose). | *"Deterministic verification gate that confirms user-configured test suites, syntax linters, and verification obligations pass before marking a workflow complete. Does not guarantee error-free code or fitness for production."* |
| **Security Architecture** | *"Completely sandboxed agent; safe local autonomous execution."* | `packages/tools` executes shell commands (`spawn`, PowerShell, bash) directly on the host operating system with the full privileges of the logged-in user. There is no OS kernel containerization, Hyper-V sandbox, or chroot jail. Loopback binds to `127.0.0.1` and secrets use DPAPI, but tool execution is unsandboxed. | **MISLEADING IF CLAIMED AS SANDBOXED** | **HIGH** (Misleading security representation). | *"Local execution architecture utilizing encrypted credential storage (Windows DPAPI) and loopback-only network binding. Tools execute with standard host user privileges without OS container sandboxing; user oversight is required for autonomous commands."* |

---

## 3. Detailed Guidance on Environmental Claims (FTC Green Guides)

The Federal Trade Commission's Guides for the Use of Environmental Marketing Claims (16 CFR Part 260) strictly prohibit broad, unqualified claims of environmental benefit, such as "green," "eco-friendly," or "carbon-neutral," unless the marketer possesses competent and reliable scientific evidence substantiating the claim.

### Findings for ForgeGreen:
1. **Existing Engineering Restraint**: The engineering documentation in `docs/forgegreen.md` displays commendable legal discipline by explicitly disclaiming measured watt or carbon quantities.
2. **Marketing Rule**: Public website copy, press releases, and app store listings must NEVER claim:
   - "Carbon-neutral coding"
   - "Net-zero agent"
   - "Reduces your AI carbon footprint by X%"
3. **Approved Description**:
   > *"ForgeGreen is an intelligent scheduling feature that defers non-urgent background tasks to time windows with lower estimated electrical grid carbon intensity, based on publicly available regional grid data."*

---

## 4. Definition of "Verified Free"

CodeForge's "Verified Free" badge represents a technical contract documented in `docs/codeforge-verified-free-contract.md`:
- A model is marked "Verified Free" ONLY when:
  1. The upstream provider lists input and output costs as `$0.00`;
  2. The model belongs to an approved access class (`FREE_NATIVE`, `FREE_ROUTED`, or active `FREE_ALLOWANCE`); and
  3. Live catalog cross-checking or synthetic probing confirms zero-cost status.
- **Legal Characterization**: "Verified Free" is an **in-application technical eligibility classification**, NOT an absolute financial indemnity or legal guarantee against third-party provider actions.
