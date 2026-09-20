# R20 Inherited State

Recorded: 2026-09-19
Branch: `forger-digital-solutions-forgegreen-certified`
Starting HEAD: `8bce13c87c888fefa2f52ecf3c2117afced45c63`
Working tree at takeover: clean

## Matrix

| Area | Current evidence | Current code truth | R20 inherited verdict |
|---|---|---|---|
| R17–R19 product UX | R17 substantially certified; R18 and R19 certified; canonical R19 suite 2,985 passed, 0 failed | R19 commits are present at HEAD | Preserve; regression-only |
| Browser | R18/R19 explicitly call Browser partial | No dedicated BrowserView/WebContentsView or browser UI found; primary Electron window is hardened and arbitrary navigation is denied | NOT CERTIFIED; implementation required |
| Electron security | Packaged security probes passed in R18/R19 | Main window uses sandbox, context isolation, no Node integration, web security, guarded navigation/popups, deny-by-default permissions/downloads | Certified baseline for primary renderer only; browser-specific proof absent |
| Windows signing | R12 readiness says certificate blocked externally; R18/R19 artifacts unsigned | electron-builder produces NSIS and portable artifacts; no signing/verification release stage or updater enforcement found | Pipeline PARTIAL; production signed release OWNER ACTION REQUIRED |
| Managed Free | 2026-09-14 R1 report claims live Groq/Cloudflare routes; later 2026-09-18 R14 report says approved production pools/routes are zero | Dynamic discovery exists and ForgeZero re-verifies routes; environment-driven credentials; current deployed credentials/terms/capacity not proven | Treat later stricter R14 state as authoritative: 0 approved production routes until requalified |
| Provider capacity | Historical Groq/Cloudflare observations exist | Process-global provider governor has TPM/RPM/concurrency/cooldown and bounded queue option; queue is provider-scoped polling, not per-user fair scheduling | PARTIAL; no product-level fair queue or current measurements |
| Per-user accounting | Cloud credit ledger and usage events exist | Hosted gateway authenticates user, enforces free concurrency, reserves/settles/releases usage; local lease plus DB count | PARTIAL; atomic multi-worker fairness/restart/duplicate-delivery proof required |
| 8-Bit | V1 architecture and qualification suites exist; public-capacity certification remains conditional | Health, cooldown, reliability, qualification, persistence, role contracts, failover and receipts exist; initial lead selection and subagent failover have documented limitations | IMPROVED BUT NOT CERTIFIED |
| 16-Bit / Paid Auto | R13 conditional only; no live paid qualification | Exactly four canonical families are registered; execution and OpenRouter fallback default off; several prices/routes are UNKNOWN and metadata is dated 2026-09-16 | NOT CERTIFIED; no spend authorized |
| ForgeGreen | FG-12F measured 30 avoided verifications and 15.442 s observed savings on its corpus | Cost-gated verification reuse and ledgers exist | Certified only for prior scoped mechanisms; R20 broad OFF/ON matrix required |
| Subagents | One matched pair: both correct; team 151 s vs single 96 s and 121,594 treatment tokens | Fixed R1 topology is flag-gated; no learned/adaptive topology; worktree and telemetry foundations exist | NOT CERTIFIED for superiority |
| Production/staging | Desktop manifest points at Render staging/production endpoints | Manifest is development channel; packaged non-development endpoint substitution is build-time guarded | Deployment availability and current server configuration unverified |
| Completion authority | R18/R19 reverified | `evaluateCompletion` remains required by repository policy | Preserve unchanged |

## Contradictions and blockers

1. Managed Free certification claims conflict. R14 is newer and stricter, so R20 starts with zero approved production pools rather than inheriting older optimistic claims.
2. Browser security of the primary renderer does not certify an unimplemented browser surface.
3. Hash publication and consumer acceptance do not replace Authenticode or signed-update enforcement.
4. Existing provider fallback limits are conservative defaults, not measured current capacity.
5. Paid Auto registry metadata must be revalidated before any benchmark; paid execution remains disabled and no paid calls are authorized.

## Spend and external effects at takeover

- R20 paid API spend: `$0`.
- No deployment, publishing, push, purchase, certificate enrollment, or production mutation performed.
