CODEFORGE_R65_PARTIAL

R65 added a second genuinely independent free capacity domain — the AI Horde anonymous community pool — with live 8-Bit qualification, a live public-fixture coding run, real cross-domain failover after Kilo quota exhaustion, multi-user isolation on the shared pool, and key-free fresh-user acceptance. R64's remote control transport and every policy gate remain unchanged and fail closed. Production remote dispatch deployment still requires the manual Render action and a signed-in GitHub session; those live proofs are recorded as pending, not claimed. No eligibility, privacy, billing, role qualification, verification, or completion gate was relaxed.

## 1. Repository state

Branch: `codex/r29-release-closure`. Starting HEAD: `616cbec8629a0083573efa673a8495d1aee64b36` (the exact R64 ending revision). No R65 commits existed at continuation; all R65 work lived in the dirty tree and was verified before any new work — focused dispatch/browser/R34 suites passed 36/36 and affected typechecks were clean. All six pre-existing modified files are preserved unstaged; the R34 benchmark bytes were restored byte-for-byte from git object `3a9d1568` (sha256 `62b4559…`). See `R65-RECOVERY-STATE.json`, `R65-START-STATE.json`, `R65-R34-PRESERVATION.json`.

## 2. R64 baseline

The R64 certificate verified before R65 work began: 533 files, 4,415 passed, zero failed, 50 skipped. ForgeGreen FG11 5/5, FG12E 3/3, certificate canary 1/1. All R64 evidence remains in place; `R64-PRODUCTION-PREFLIGHT.json` was briefly overwritten by a re-run during this milestone and was restored from the index, with the fresh observation preserved separately as `R65-PRODUCTION-PREFLIGHT.json`.

## 3. Domain B: AI Horde anonymous community pool

AI Horde (Haidra-Org) provides anonymous inference through the documented key `0000000000` on its OpenAI-compatible facade (`https://oai.aihorde.net/v1`) backed by community-donated workers on `aihorde.net`. Live probing established: anonymous model listing, non-streaming and streaming generation, and `find_user` account facts (Anonymous#0, concurrency 500, live in-flight generations). Native OpenAI `tools` are silently dropped by the tested proxy; tool calling is therefore mediated through CodeForge's hosted text-tool contract (`hosted-text-tools.ts`) — the adapter injects the schema into the system prompt, parses `<tool_call>` blocks, and emits standard tool-call stream events. Native capability gates were not weakened; 8-Bit qualification decided what each model actually does.

**Supply class**: new `COMMUNITY_ANONYMOUS_FREE` — globally shared (`GLOBAL_SHARED`/`shared:ai-horde`), `SHARED_OWNER_POOL`, `CLIENT_DIRECT` egress, `PUBLIC_CODE_ONLY` (Horde workers can technically see prompts), zero marginal cost, paid fallback disabled. Quota is metered by the dimension the provider actually enforces: standing concurrency (500), not invented request/token windows — a `concurrency` quota unit was added end-to-end (RouteQuota parse → capacity windows → reservation ledger accounting against live holds). Pinned policy evidence: definitions/FAQ/kudos docs SHA-256 hashed; `reverifyHordePolicy` returns VERIFIED live, clears the receipt on drift.

**Qualification**: `google/gemma-4-31b` passed all six 8-Bit roles live (`R65-HORDE-QUALIFICATION-google_gemma-4-31b.json`). An earlier candidate (`aphrodite/DeepSeek-V4.1-Flash`) reached only CODER/TOOL_AGENT probation — correctly insufficient for the coding proof.

**Live coding**: `R65-DOMAIN-B-LIVE.json` — fabric admission on `SUPPLY_COMMUNITY_ANONYMOUS_FREE`, 9 model turns, `math.ts` corrected (`a - b` → `a + b`), all tests passed, independent Reviewer passed, completion gate passed, integrated into the worktree. Independence key `ai-horde:GLOBAL:155d3b48…` is disjoint from Kilo's `kilo:SOURCE_IP`.

A dispatch-path fix was required and made: `authorizeProductionFreeDispatch` allowlisted only packaged/user supply classes — `COMMUNITY_ANONYMOUS_FREE` was added, and the rejection became a typed `FreeSupplyDomainNotAdmittedError` so a local admission denial can never be misclassified as provider quota evidence (the `...QUOTA...` name previously poisoned the shared health domain).

## 4. Cross-domain failover

`R65-CROSS-DOMAIN-FAILOVER.json` — both domains live in one run. A controlled quota-exhaustion fault (429 + Retry-After, Kilo's real free-tier failure mode) was injected on the real Kilo adapter; the fabric emitted `ROTATE` twice — EXPLORER and CODER turns moved from `kilo-free-direct/kilo-auto/free` to `ai-horde/google/gemma-4-31b` — and the run completed end to end on the second domain (`provesSecondLiveIndependentDomain: true`). This is a controlled fault on a real adapter serving a real second domain — not a synthetic route. `R65-FAILOVER-DECISIONS.ndjson` records every fabric decide call's candidate verdicts. The completed run replaced an earlier blocked attempt where transient 503s (correctly) only earned bounded same-route retry — that gap is documented, not hidden.

## 5. Multi-user independence

`R65-MULTIUSER-ISOLATION.json` — 11/11 checks against the live-probed shared pool: two users hold `shared:ai-horde` concurrently; per-user hold accounting and the per-user concurrency cap isolate users (A's 4th hold denied `USER_CONCURRENCY_LIMIT` while B still admits); release scoping is exact; `PRIVATE_CODE` is denied for both users — consent cannot leak through a shared pool. The community pool is honestly global: no fabricated per-user slice is claimed.

## 6. Fresh-user / no-key acceptance

`R65-FRESH-USER-ACCEPTANCE.json` — VERIFIED. `apps/desktop/test/ai-horde-fresh-user.test.ts` (2/2) exercises the real startup path (`createProviderAdapterFromDefinition` → `publishAll`) over an empty secrets/settings/env host: `ANONYMOUS_DIRECT` connects, `COMMUNITY_ANONYMOUS_FREE` lands, zero secrets are written, and key-required providers stay disconnected. Live no-key inference is proven by the Domain B run itself.

## 7. Provider classifications (R65 additions)

| Candidate | Result | Basis |
|---|---|---|
| AI Horde | ADMITTED (community class) | Anonymous access documented + live-verified; kudos cannot be bought (zero-cash provenance); workers see prompts → PUBLIC_CODE_ONLY |
| Puter | DENIED | User-Pays model — users pay for own usage from paid subscription; not zero-cost |
| Pollinations | DENIED | Anonymous tier is a legacy surface; current docs are Pollen-metered; no stable free contract |
| Ollama cloud | DENIED (as remote free) | Attest-gated starter allowlist is the max verifiable boundary |
| OpenRouter / Cloudflare / Groq / Cerebras | unchanged from R64 | Prior verifications stand |

See `R65-PROVIDER-VERIFIERS.json`.

## 8. Production deployment

`codeforge-cloud-va` (`srv-dam6f83m8hqs73clo5ig`) remains healthy at revision `84c08956d61c143c65f0c147a78fed94648a2254` — the R65 code is NOT yet deployed. `autoDeploy` is off; the deploy requires a manual Render action by the owner. Fresh preflight (`R65-PRODUCTION-PREFLIGHT.json`): liveness/readiness 200, remote-direct sessions correctly 401 unauthenticated, nine migrations newer than the deployed revision present and compatible. The production coding dispatch proof (`r65-production-coding.mjs`) is staged and awaits deployment + user GitHub sign-in.

## 9. Wallet isolation

No paid, purchased, promotional, BYOK, or local inference was used anywhere in R65: all live evidence runs used Kilo anonymous or the Horde anonymous community key only. `PRIVATE_CODE` requests against the community pool are denied without explicit permissible context (proven in `community-anonymous-free.test.ts` and the multi-user isolation checks).

## 10. Provider privacy classifications (delta)

AI Horde: `PUBLIC_CODE_ONLY` — the FAQ documents that community workers can technically see prompts; admission requires explicit public-code context and fails closed otherwise.

## 11. Repository validation

Resource-bounded validation: **538 files, 4,449 passed, 1 failed, 50 skipped, zero pending/todo; 2,887.904 seconds** summed phase duration — see `R65-REPOSITORY-TESTS.json` and per-phase `R65-suite-*.json`. The single failure is `cf14-large-repo-benchmark.test.ts`'s context-assembly latency bound (500ms floor): 5 consistent measurements at 527–603ms on this machine, decomposed to ~300ms of git-process spawn cost (~76ms/spawn measured in-situ) plus ~300ms in-process assembly. The measured code path is byte-identical to the R64 run that passed it; classified `ENVIRONMENTAL_WALL_CLOCK`, not a regression — see `R65-FAILURE-CLASSIFICATION.json` and `R65-suite-cf14-rerun.json`. The bound was not relaxed. Baseline grew: +5 test files, +34 passed vs R64's 533/4,415.

Workspace build PASS (`R65-WORKSPACE-BUILD.json`). Affected package typechecks PASS (providers, forge-zero, model-registry, server, cloud-api, desktop main + renderer). New-test totals: 17/17 (adapter + community admission/projection), 146/146 adjacent ForgeZero/model-registry regression, 6/6 desktop settings + fresh-user tests. Secret scan PASS: 1,936 files, 615 findings all synthetic/allowlisted, 0 owner-review-required (`R65-secret-scan.json`).

## 12. Source certification

Certificate: `r65-free-capacity-fabric-v1` (pending final commit hash embed). Free Capacity byte verification: PASS via `scripts/free-capacity-certificate.mjs --verify`. Guarded source-state ID recorded in `docs/codeforge-forgegreen-certified-source-state.json` under recertifications. Certificate source coverage adds the community supply class, concurrency quota dimension, Horde adapter/policy reverification, dispatch allowlist fix, fresh-user path, and all R65 scripts.

## 13. Remaining blockers

- Production remote dispatch is not yet deployed; the live hosted coding proof awaits the manual Render deploy and a signed-in user session.
- The community pool is shared global capacity — it is never claimed as private or per-user capacity.
- Horde text-tool mediation is protocol-dependent on model compliance; qualification receipts are per-model and new pool models need their own.
- Cloudflare/Groq dedicated verifiers remain unfinished; Puter, Pollinations, Ollama-cloud remain DENIED.

## 14. Evidence paths

All R65 evidence is under `G:\CodeForge\docs\evidence\free-capacity-fabric\`: `R65-RECOVERY-STATE.json`, `R65-START-STATE.json`, `R65-R34-PRESERVATION.json`, `R65-baseline-focused.json`, `R65-dispatch-focused.json`, `R65-PROVIDER-VERIFIERS.json`, `R65-HORDE-POLICY.json`, `R65-HORDE-QUALIFICATION*.json`, `R65-DOMAIN-B-LIVE.json`, `R65-DOMAIN-INDEPENDENCE.json`, `R65-CROSS-DOMAIN-FAILOVER.json`, `R65-FAILOVER-DECISIONS.ndjson`, `R65-MULTIUSER-ISOLATION.json`, `R65-FRESH-USER-ACCEPTANCE.json`, `R65-CAPACITY-METRICS.json`, `R65-PRODUCTION-PREFLIGHT.json`, `R65-REPOSITORY-TESTS.json`, `R65-suite-*.json`, `R65-WORKSPACE-BUILD.json`, `R65-secret-scan.json`, `R65-certificate-canary.json`. Authority certificate: `source-certification.json`.

## 15. Commit hashes

Baseline (R64 ending): `616cbec8629a0083573efa673a8495d1aee64b36`.

R65 implementation + evidence commit hashes are returned in the final chat response; a committed file cannot embed its own hash.
