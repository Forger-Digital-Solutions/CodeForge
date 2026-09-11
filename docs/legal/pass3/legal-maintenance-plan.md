# Legal Maintenance Plan & Future ForgeLegal Architecture — Pass 3 Reconciliation

<!-- PASS 3 FINAL RECONCILIATION — NOT LEGAL ADVICE — DRAFT ONLY -->

**Date**: 2026-09-11
**Author**: Pass 3 Independent Reviewer
**Purpose**: Define an ongoing operational cadence for legal and contractual maintenance, and specify the architecture for automated compliance monitoring (`ForgeLegal`).

---

## 1. Event-Driven Legal Maintenance Schedule

Rather than conducting continuous, wasteful manual audits, CodeForge should execute targeted legal reviews triggered by specific product and commercial milestones:

| Trigger Event | Trigger Scope | Review Actions Required | Review Owner |
|---|---|---|---|
| **New Model / Inference Provider Added** | `packages/providers`, `model-registry` | 1. Review provider Terms of Service & acceptable use policies.<br>2. Audit age requirements and regional restrictions.<br>3. Check training/privacy posture on free allowances.<br>4. Update `final-provider-contract-matrix.md`. | Engineering / Product |
| **New External Runtime Dependency Added** | `package.json`, `apps/desktop/package.json` | 1. Automated license scan (verify permissive MIT/Apache/BSD).<br>2. Confirm zero GPL/AGPL/copyleft dependencies.<br>3. Update `third-party-notices.md`. | Engineering (CI) |
| **Geographic Launch Expansion (e.g., EU Cloud Launch)** | `apps/cloud-api` | 1. Verify GDPR account deletion workflows (`DELETE /api/account`).<br>2. Enforce regional geoblocking for restricted provider tiers.<br>3. Update Privacy Policy and DPA. | Legal / Engineering |
| **New User Data Collection or Cloud Sync Feature** | `packages/cloud-db`, `sessions` | 1. Perform Data Protection Impact Assessment (DPIA).<br>2. Update Privacy Policy data flow disclosures.<br>3. Verify retention TTLs and cascading deletion. | Legal / Product |
| **Monetization / Stripe Live Activation** | `apps/cloud-api`, `cloud-billing` | 1. Review Subscription Billing Terms and refund policies.<br>2. Verify Stripe merchant verification and tax compliance.<br>3. Execute provider DPAs. | Finance / Legal |
| **Annual Comprehensive Provider Review** | All active upstream APIs | 1. Fetch updated Terms of Service for Google, OpenRouter, Groq, Cloudflare.<br>2. Verify clause numbering and policy changes. | Legal Counsel |

---

## 2. Future Automated Compliance Architecture (`ForgeLegal`)

To prevent compliance drift between code releases and legal documentation, CodeForge should integrate a lightweight, automated compliance checker (`@codeforge/forge-legal`) into the monorepo CI/CD pipeline:

```
┌─────────────────────────────────────────────────────────────┐
│                    FORGELEGAL CI PIPELINE                   │
│                                                             │
│  [Build / Pull Request Gate]                                │
│    ├─ Check 1: Root LICENSE file presence & validity        │
│    ├─ Check 2: Public package license metadata (vscode)     │
│    ├─ Check 3: Automated SBOM & Copyleft Scanner            │
│    ├─ Check 4: Third-Party Notices completeness             │
│    ├─ Check 5: Secret Scanner (pre-commit credential block) │
│    └─ Check 6: Unsubstantiated marketing claims linter      │
│                                                             │
│  OUTPUT: PASS / FAIL (Blocks merge on license/copyleft flaw)│
└─────────────────────────────────────────────────────────────┘
```

### Key Automated Checks for ForgeLegal
1. **Root License Verifier**: Asserts that `G:\CodeForge\LICENSE` exists and matches the approved corporate text.
2. **Package Metadata Linter**: Verifies that every package manifest in `packages/*` and `apps/*` contains a valid `"license"` identifier and accurate `"private"` declaration.
3. **Release SBOM & Copyleft Blocker**: Inspects the built `app.asar` archive before packaging installers to guarantee that zero packages contain GPL, AGPL, SSPL, or copyleft licenses.
4. **Third-Party Attribution Sync**: Compares the production runtime dependency list against `third-party-notices.md`, flagging missing attributions.
5. **Marketing Claim Linter**: Runs a regex check across `README.md` and documentation for prohibited overbroad claims (e.g., flagging "zero emissions", "guaranteed bug-free", "100% compliant").
6. **Provider Freshness Metadata Checker**: Tracks the "Last Reviewed" date of upstream provider terms, emitting a CI warning if a provider contract has not been inspected within 180 days.

### Strict Governance Boundary for Automation
`ForgeLegal` is an engineering validation and linting tool. **It MUST NOT**:
- Interpret statutory language or determine whether CodeForge is "legally compliant".
- Decide whether a disputed contract clause is legally enforceable.
- Automatically accept upstream provider agreements.
- Make corporate policy or business licensing decisions.

All legal conclusions remain the exclusive responsibility of human leadership and qualified outside legal counsel.
