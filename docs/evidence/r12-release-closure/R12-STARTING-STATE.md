# CodeForge R12 Starting State

**Recorded:** 2026-09-18 UTC  
**Authoritative baseline:** R11.4 final report at `docs/evidence/r11-release-candidate-closure/R11-4-FINAL-REPORT.md`

## Repository identity

| Item | Value |
|---|---|
| HEAD | `83dc1db4810de15d1f4663f038122585b65e647e` |
| Branch | `forger-digital-solutions-forgegreen-certified` |
| Commits after R11.4 HEAD | `0` |
| Relationship to R11.4 | Exact certified HEAD; no later commit or diff |
| Push status | Not pushed; no push authorized |

The R11.4 certification remains historical evidence and is not being rewritten. All R12
results will use this separate `r12-release-closure` namespace.

## Working tree

There are no tracked modifications. The existing untracked material is the complete R11.4
evidence tree under `docs/evidence/r11-release-candidate-closure/`, including raw benchmark
attempts and certification artifacts. It is preserved in place and will not be deleted,
renamed, or edited. R12 evidence is being added under a new sibling directory.

## Known engineering state at entry

The R11.4 report records the following final validation state at this exact HEAD:

- 344/344 Vitest files and 2,564/2,564 tests passed (7 files / 36 tests skipped).
- Typecheck, lint, workspace build, dependency audit, and secret scan passed.
- Dependency audit reported 0 production vulnerabilities.
- Secret scan reported 73 synthetic findings and 0 owner-review findings.
- Electron NSIS, portable, packaged smoke, interrupt, recovery, upgrade, uninstall, reinstall,
  and user-data preservation checks passed.
- Virginia production and staging were live, with 21/21 credential-free probe checks each and
  real Hosted Free inference verified.

These are inherited starting-state claims. R12 will rerun the relevant validation after
source changes and will record fresh machine-readable evidence rather than treating inherited
claims as new measurements.

## Known R11.4 release blockers entering R12

- The protected benchmark executor hardcodes `protectedAcceptance: "not_run"`; strict protected
  summarization is therefore not trustworthy until the field is implemented or retired.
- Seven public benchmark failures remain: AT-01, AT-02, PQ-01, CP-01, CP-02, GS-01, and RP-02.
- The Virginia custom production domain still resolves to the Oregon deployment.
- Render Free compute cold-start measurements were approximately 13–22 seconds; the $7 compute
  tier was not purchased and paid-tier metrics were unavailable.
- The Virginia Render PostgreSQL instance is Free and scheduled for deletion on 2026-10-07
  unless upgraded or migrated; Free-tier backup/export is unavailable.
- Trusted Windows signing requires an owner-controlled certificate and remains external.
- Real second-account switching requires a second authorized account and was unavailable.

## Observable hosted state

The carried-forward R11.4 Render evidence reports:

- `codeforge-cloud-va`: Virginia, live, Free plan, health 200, Hosted Free inference passed.
- `codeforge-cloud-staging-va`: Virginia, live, Free plan, health 200, Hosted Free inference passed.
- Oregon production and staging remain retained as rollback resources; no deletion has been
  authorized.
- The custom domain cutover has not been performed.
- Render internal PostgreSQL TLS is incompatible with CodeForge's certificate-validation policy;
  the active path uses the externally validated TLS URL.

## R12 execution boundary

R12 may change CodeForge-controlled source, tests, documentation, and fresh evidence. It must
not purchase Render compute, upgrade or migrate production databases, cut over DNS, delete
rollback resources, buy a signing certificate, or fabricate a second account. When the $7
Render compute decision is reached, work will pause for the owner's explicit signup/payment
action before any paid measurement or upgrade.

