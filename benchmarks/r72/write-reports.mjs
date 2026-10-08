import { readFile, writeFile, readdir } from 'node:fs/promises';
const dir = 'docs/evidence/r72-free-supply-and-autonomy';
const json = async name => JSON.parse(await readFile(`${dir}/${name}`, 'utf8'));
const put = (name, body) => writeFile(`${dir}/${name}.md`, `${body}\n`);
const windows = await json('windows-artifact-manifest.json');
const frozen = windows.sourceRevision;
const previous = await readFile('docs/evidence/r71-packaged-free-supply-expansion/R71-SUPPLY-MATRIX.md', 'utf8');
const rows = previous.split('\n').filter(line => line.startsWith('|') && !line.startsWith('|---') && !line.startsWith('| Provider'));
await put('R72-SUPPLY-MATRIX', `# R72 supply decisions — 2026-10-08

38 service/route entries investigated or reassessed: 28 actual inherited R71 matrix rows plus 10 additional service entries. R71's heading said 27 routes; counting its rows yields 28. Grouping the two GitHub services and two OpenCode services gives 36 provider organizations. This is research coverage, not usable supply. No new provider has passed every production-admission gate. Five new Kilo model candidates were measured; these share Kilo's existing IP domain.

| Additional route | Official evidence / economics / owner | R72 decision |
|---|---|---|
| OpenCode Console Inference, separate from Zen | [Anonymous API](https://opencode.ai/v2/docs/console/api/inference), [terms](https://opencode.ai/legal/terms-of-service). Live models GET 200, 83 IDs; model response lacks pricing. Free subset requires separate pricing evidence. | BLOCKED: terms restrict third-party benefit and do not clearly authorize intended redistributed production use. No inference or impersonation. Written authorization/current exception required. |
| OVHcloud AI Endpoints | [Getting started](https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-getting-started), [Free API FAQ](https://www.ovhcloud.com/en-ca/public-cloud/free-ai-api/). Anonymous 2 requests/minute/IP/model; 24 catalog IDs, mixed prices/modalities. API-key project requires a payment method. | BLOCKED: FAQ describes anonymous playground access; intended anonymous third-party production authorization unresolved. No inference. Per-model limits are documented, not measured independent production capacity. |
| SiliconFlow | [Account/model quota scope](https://docs.siliconflow.com/en/userguide/rate-limits/rate-limit-and-upgradation), [official OpenAPI](https://github.com/siliconflow/siliconcloud/blob/main/openapi.yaml). Account key, separate per-model windows. Fixed free-model limits differ from paid tiers. | PROBATION: no account key, live exact-zero catalog, billing/privacy or coding receipt. Do not assign paid L0 1000 RPM to every free model. |
| LongCat | [API](https://longcat.chat/platform/docs/APIDocs.html), [changes](https://longcat.chat/platform/docs/ChangeLog.html), [terms](https://longcat.chat/platform/private/). Bearer key, current tokens packs/PAYG. | BLOCKED: earlier free preview allocation cannot establish current recurring unpaid entitlement or no-paid enforcement. No account. |
| LLM7 | [Service terms](https://github.com/chigwell/llm7.io/blob/main/TERMS.md). Current account key, published free rolling allowance; production redistribution requires consent. | BLOCKED: key required; educational/research service and redistribution restriction. No packaged anonymous admission. |
| ModelScope | [Official service](https://modelscope.cn/), candidate official API-Inference limits page timed out. | UNKNOWN: usable entitlement, exact models, third-party production authorization, privacy and quota receipt unavailable. No inferred 2000/day quota or anonymous endpoint. |
| Bytez | [Billing](https://docs.bytez.com/model-api/docs/billing), [API key](https://docs.bytez.com/model-api/docs/get-started). Free credits refresh every 4 weeks, open models up to 7B, one concurrent request; amount unspecified. | PROBATION: useful recurring account program, but no authorized account, purchased-credit isolation, auto-reload-disabled evidence, terms/privacy/tool/coding receipts. autoScale can purchase credits; never enable it in Free. |
| Featherless | [Plans/API](https://featherless.ai/docs/api-reference-plan), [FAQ](https://featherless.ai/docs/faq). Account key and paid subscription/concurrency plans. | REJECTED as verified recurring unpaid supply; paid subscription/catalog size is not free capacity. |
| Awan LLM | [Pricing](https://www.awanllm.com/pricing), [API](https://www.awanllm.com/quick-start), [terms](https://www.awanllm.com/terms), [privacy](https://www.awanllm.com/privacy). Free Lite advertised 20 RPM, 200 small/10 medium/10 large requests/day; account key. | PROBATION: third-party examples exist, but no account, authoritative free-plan receipt, model-class owner scope or tool/coding qualification. No anonymous bypass; shared-account distribution prohibited. |
| StepFun direct | [Account overview](https://platform.stepfun.ai/account-overview), [Step Plan](https://platform.stepfun.ai/step-plan). Account API key, vouchers/subscription surfaces. | UNKNOWN: current recurring unpaid API quota/zero-billing guard and live account evidence absent. Kilo/OpenRouter upstream model listings are separate routes. |

Reassessed SambaNova [limits](https://docs.sambanova.ai/docs/en/models/rate-limits): no-card account Free tier, production models DeepSeek-V3.1, Meta-Llama-3.3-70B-Instruct, gpt-oss-120b each published 20 RPM/20 RPD/200k TPD. Preview models remain non-production. No account key exists here, so none was qualified or admitted. Z.ai [pricing](https://docs.z.ai/guides/overview/pricing) still lists glm-4.7-flash and glm-4.5-flash Free; web search is separately paid. No Z.ai account/live qualification exists here. Preserve optional user-controlled connections and hard admission gates.

Puter billing was rechecked and a useful secure observation flow implemented. OpenRouter production connection remains intact, but this session's environment key is paid-tier and excluded. Groq remains historical shared organization supply; no newly verified independent-user allowance. Other exclusions were preserved without repeating unchanged failed inference.

## Inherited R71 rows

These are preserved dated research decisions, not fresh R72 inference/entitlement claims. Refer to the unchanged R71 matrix for original headings and sources.

${rows.join('\n')}

Unknown request/token/concurrency, retention, training and production-private-code guarantees remain unknown. Only public synthetic fixtures were sent in R72. Catalog HTTP 200 never constitutes admission. [Raw current catalog/policy reads](supply-preflight.json).`);
await put('R72-PACKAGED-ANONYMOUS', `# Packaged anonymous supply

Kilo remains the sole anonymous provider with an eligible measured coding route in this evidence set. Admission remains through current pinned policy, exact-zero catalog filtering, role qualification, quota ownership, public-code consent and ForgeZero. OpenCode Console and OVHcloud were investigated as distinct new surfaces; authorization uncertainty blocks inference and automatic enablement. Their successful catalog GETs are recorded in supply-preflight.json.

No API adapter was fabricated for an unauthorized route. No proxy/IP rotation, client impersonation, paid fallback or local inference was added. Five Kilo model candidates share one existing provider/IP domain; they are not five providers or five independent allowances.`);
await put('R72-USER-ENTITLEMENTS', `# Account connections and billing boundary

Puter now has a system-browser official SDK sign-in page on a random one-use loopback origin. Callback requires the exact Host, Origin, POST path, JSON content type and secret nonce; input is bounded. IPC authenticates the main-window sender and refuses an account change during sign-in. Official SDK account, monthly-usage and model-list reads provide an observation; no chat request is made. The token goes only to the existing trusted encrypted secret store under a hashed CodeForge owner key. Renderer receives hashed identity, count and observation time, never credentials. Restart reconstruction and two-owner disconnect isolation are deterministically tested. A late or malformed callback cannot admit inference.

[Puter quotas](https://docs.puter.com/rate-limits-and-quotas/) document purchased-credit continuation and shared in-flight reservations. A local monthly balance cannot enforce zero billing under concurrency. AutomaticFreeAdmission is always false. Actual user sign-in, provider token validity/revocation, package origin behavior and restart login were not live certified. The delivered feature is account/catalog/allowance observation and local credential removal; a Puter inference adapter, tool normalization and qualified runtime route remain blocked on a provider-enforced free-only guard. Local disconnect does not claim provider-side token revocation.

OpenRouter official PKCE, secure credential connection, persisted owner-bound receipt, recheck/revocation and fail-closed account switching are preserved and tested through existing production modules. R71's genuinely personal 50/day key was transient and is unavailable here. R72's environment key metadata says paid-tier; it was read once without inference and never admitted to Free. Real persistent account login/restart and two distinct live unpaid users remain unverified. SambaNova/Z.ai/SiliconFlow/Bytez/Awan authorized account credentials are absent. No keys were invented, transferred or shared.`);
const qualifications = [];
for (const name of await readdir(dir)) {
  if (!/^(qualification-|reviewer-).*\.json$/.test(name)) continue;
  const document = await json(name);
  qualifications.push({ file: name, model: document.modelId, status: document.status, requests: document.frames?.length ?? 0,
    roles: Object.fromEntries(Object.entries(document.qualification?.roleResults ?? {}).map(([role, value]) => [role, value.status])) });
}
await writeFile(`${dir}/qualification-summary.json`, JSON.stringify(qualifications, null, 2));
await put('R72-LIVE-QUALIFICATION', `# Actual role measurements

All requests used exact catalog-verified free Kilo models and current reverified policy, public frozen qualification cases and unchanged thresholds. Selective qualification can measure complete Explorer/Planner/Reviewer protocols separately; skipped roles stay NOT_TESTED. No truncated, interrupted or unmeasured role is promoted.

| Model / probe | Status | Calls | Measured roles |
|---|---|---|---|
${qualifications.map(q => `| ${q.model} ([receipt](${q.file})) | ${q.status} | ${q.requests} | ${Object.entries(q.roles).map(([role, status]) => `${role}: ${status}`).join('; ')} |`).join('\n')}

Dots has measured Coder and Planner passes, but its full probe timed out before review and a separate Reviewer probe hit an organic 502. Nemotron-Lightning's Coder passed while the suite deadline left planning/review untested. Liquid's compact Coder passed but its Reviewer probe was interrupted. These partial measurements are preserved; transient receipts are not production admission. Poolside-S upstream failure and Inkling's provider failure remain inconclusive. No new conclusive independent Reviewer exists.

Carried current R71 Cohere receipt qualifies Explorer, Coder, Tool Agent and Analyst; Planner and Reviewer hard failures remain excluded. A candidate with another suitable role is never automatically suitable for review. [Machine-readable summary](qualification-summary.json).`);
await put('R72-AUTONOMOUS-RELIABILITY', `# Reliability diagnosis and actual R72 attempt

R71's saved SQLite journals show valid code edits and passing child tests in both failed tasks. Failure mechanisms included blanket observation invalidation after read-only tests, Explorer JSON truncation at 1024 tokens with hidden reasoning, a git pager stall under headless ConPTY, repeated reads and organic upstream quota exhaustion. Independent-review availability was also missing. [Read-only diagnosis](r71-diagnosis.json).

R72 fixes: hash-check observations after command execution; retain matching reads; invalidate changed/deleted/unreadable files, including mutation before a failed command; force the final read-only structured role turn to synthesize; normalize terminal tool names; disable command pagers/credential prompts; reserve 2560 measured reasoning tokens on the time-boxed Kilo Cohere profile, retaining the existing 4096 hard output cap. Later validation exposed a parent-Git boundary gap: ignored child workspaces could inherit a parent state hash and hide new files from review. Final verification now hashes the selected workspace contents independently when it is not the Git root, and diff review uses its filesystem snapshots. Tests prove changed child files invalidate passing evidence and parent changes cannot substitute for child state. Completion and reviewer policies were not relaxed.

One real production autonomous run used normal topology in a clean public fixture. Explorer finished in 5 requests/6 tools, Coder in 8 requests/7 tools: 13 model requests total, versus R71 first task's 24. Duration 147798 ms. Coder changed src/retry.mjs from attempt <= maxAttempts to attempt < maxAttempts; all 3 child tests passed. Reviewer admission rejected the hard-failed Cohere review role with zero reviewer inference requests. Parent status blocked, no integration, no final ForgeVerify invocation, no completed task. This is improved child convergence, not solved autonomous reliability.

Attempts 1; completed 0; terminal blocked 1; failed executions outside that blocked result 0; parked 0; longest completed streak 0. Parent tests still fail because the correct child diff remains unintegrated. [Full journals and receipts](R72-TASK-CAMPAIGN.json), [retained child diff/objective tests](child-coding-proof.json). No further endurance tasks were launched after establishing the unchanged missing-Reviewer prerequisite; repeating it would spend allowance without making completion possible. The requested reviewed baseline and staged 20-task endurance are unmet.`);
await put('R72-FAILOVER', `# Failover certification

Actual qualification receipts preserve upstream failures (including Dots Reviewer in-band HTTP-200 SSE error reporting 502), Poolside rate-limit/provider failure and bounded suite timeouts. A separate candidate probe is an engineering qualification action, not automatic coding-task failover. All measured candidates share Kilo's provider/IP allowance. No new independent eligible domain was established.

The R72 coding run completed child work without an upstream failure, then blocked on Reviewer admission. No alternate qualified reviewer/provider was selected. Organic production-path cross-provider continuation to a reviewed completion is unproven. The existing failover, scope classification, reservations, durable journals, no-paid fallback and completion gates are preserved and included in affected regression suites. Account/IP exhaustion must not be treated as a new allowance on a sibling model. Do not count synthetic failure fixtures as organic certification.`);
await put('R72-QUOTA-OWNERSHIP', `# Quota ownership and aggregation

Kilo: documented 200 requests/hour per public IP across free models and authenticated/anonymous requests. Same NAT shares the allocation; no verified independent egresses here. Model candidates do not multiply it. Tokens and concurrency guarantees unknown. OpenRouter unpaid personal accounts: documented 50/day and 20 RPM; R71 had a measured genuine account, R72 has no accessible current unpaid connection. This session's paid-tier key is excluded. Existing Groq organization allowance is shared supplement, not per registration.

OVH's documented 2/minute/IP/model is a research observation outside admitted production supply. SiliconFlow documents account-owned separate model windows, but no account-specific free model receipt is available. Puter uses one user wallet across apps; 30 requests/10 seconds/user/app and 3 concurrent Free requests do not create separately funded app wallets. Monetary observations do not guarantee spend isolation. SambaNova's published model limits likewise require an actual no-card account and entitlement evidence.

Conceptual ceilings for legitimate independent domains are 200P Kilo requests/hour for P real public-IP domains and 50N OpenRouter requests/day for N genuine distinct unpaid accounts. These are different windows, do not imply N=registered users, and cannot be converted to completed coding tasks. Upstream availability may correlate. No artificial registered-user cap was introduced. Existing physical-domain, duplicate-key, account ownership, NAT, rotation, reservations and fail-closed route tests remain applicable. Deterministic two-owner Puter storage is tested; live two-account/two-IP certification is not.`);
await put('R72-ECONOMICS', `# Zero-billing economics

All R72 model inference was anonymous exact-zero Kilo supply. No paid fallback, local LLM, operator purchased inference, credit top-up, account farming or IP rotation was used. Provider-funded supply is finite. Puter purchased-credit continuation is blocked; OpenRouter paid-tier metadata is excluded; Bytez auto-reload/autoScale and paid model tools are not enabled; OVH payment-method account is not treated as anonymous Free. Free product eligibility still requires pricing, legal/privacy, quota ownership, qualification and current allowance evidence.

No newly qualified independent provider domain was added. Account observation is useful product work with zero admitted Puter inference. CodeForge usage capacity is bounded by real provider windows, correlated upstream availability and qualified roles. The measured 13-request unintegrated coding attempt is not a cost-per-success figure.`);
await put('R72-WINDOWS-PACKAGE', `# Frozen Windows x64 candidate

Runtime/source revision ${frozen}, clean tracked source, CodeForge 0.4.0 / Electron 44.4.1. [Final full workspace build](final-workspace-build.log) passed, including stamped desktop main/renderer. Builder --dir --win --x64 passed with npmRebuild=false; no shared native rebuild. Candidate retained at ${windows.artifact}. The earlier b119 candidate and its receipts are preserved separately. [Artifact sizes/hashes](windows-artifact-manifest.json); [build log](windows-package-build.log).

All five static audits passed: matching clean main/renderer source identity, internal/runtime dependency closure, Electron browser security and development/smoke endpoint. The auth audit certifies http://127.0.0.1:3220 development configuration, not a production deployment. [Signature](windows-signature.json) reports NotSigned despite builder's generic signtool lines.

No package launch on the production host, insecure Electron settings, unsigned host install or isolation bypass occurred. No authorized isolated Windows machine or signing identity was available. Native module loading, GitHub/Puter/OpenRouter real login, restart restoration, multi-user operation, package inference/endurance, installer upgrade/uninstall and signed release certification remain unverified. Static audits do not substitute for execution. No installer was built.`);
console.log(`Wrote nine substantive evidence reports for runtime ${frozen}.`);
