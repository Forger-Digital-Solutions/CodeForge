# R73 zero-cost inference economics

ForgeAuto/Free keeps the existing ForgeZero admission authority. A provider catalog, zero-price label, successfully connected account, or successful chat does not independently authorize autonomous inference. Terms, workspace consent, cost evidence, ownership, current model availability, role qualification, quota and health gates still apply.

## BlockRun anonymous route

The [official Free API](https://blockrun.ai/free) explicitly requires no account, API key, wallet, card or payment header. [Official production guidance](https://blockrun.ai/signal/free-llm-api-no-key-models-you-can-curl) permits light-production use. [Published limits](https://blockrun.ai/docs/rate-limits) are30requests/minute and300requests/hour per source IP, shared across the provider's Free models. Shared upstream capacity can be much lower at any given time; no unlimited request/token/concurrency claim is made.

The installed-client BlockRun adapter uses the canonical pinned https://blockrun.ai/api/v1 origin. It sends only Content-Type; it does not attach any key, wallet identity, PAYMENT-SIGNATURE, X-Payment, paid SDK, payment retry, extra request billing fields or payment authority. Redirects are refused. A402/payment challenge is an error. The provider factory does not permit an arbitrary base URL, credentials or headers for this anonymous route.

Before POST, the model must exist in fresh live catalog evidence with billing_mode=free, available=true, and exact-zero input/output prices. The catalog's transaction_fee field is optional; an explicitly supplied nonzero or malformed fee is rejected. The anonymous Free policy and absence of payment authority remain required. Missing input/output prices, paid, null-price, unavailable and removed models are rejected. The catalog is refreshed before inference when its five-minute evidence expires. A response must identify the exact qualified requested model; BlockRun's provider-owned automatic Free fallback is rejected when it substitutes a model, so it cannot inherit another model's role qualification. Pending streamed tool calls are released only after the checked stream completes.

BlockRun's separately hashed terms/privacy/price receipt cannot borrow Kilo's policy evidence. Changed authoritative content clears admission; evidence expires after seven days and is rechecked every six hours. Successful role receipts remain separate from raw transient attempts.

All owned live probes used public synthetic content and no payment credentials. Fourteen actual calls were dispatched at the supply-work checkpoint; the original30-call bound governed research/qualification. Root's autonomous campaign calls are counted separately in the reliability evidence. Successful exact-model responses and native tool calls incurred no caller-funded transaction. Raw original responses are retained, including two HTTP429 envelopes whose diagnostics reveal an upstream400 malformed-tool-output defect; no claimed financial quota exhaustion is inferred from that misleading envelope.

## Other supply classes and exclusions

| Supply | Cost and ownership boundary |
|---|---|
| Kilo packaged anonymous | Existing source-IP allowance, shared across all users behind that egress and across models. Not200requests/hour per registered user. |
| OpenRouter user Free | Existing official account-owned delegated flow; only verified unpaid entitlement enters Free. Paid-tier quota, purchased credits, zero-price models on unverified paid accounts and promotional balances do not create a verified unpaid entitlement. |
| Groq managed capacity | Existing one organization-owned Free domain. Not independently multiplied by users, projects or keys; paid overflow is excluded. |
| Puter | SDK/catalog/account/allowance infrastructure can exist independently of admission. Purchased-credit continuation remains blocked absent provider-enforced zero-spend protection; client allowance estimates do not guarantee no charges. |
| SambaNova / Z.ai / optional user keys | A published Free model or user-controlled key is not proof of account ownership, hard no-spend admission or live qualified capacity. Account-linked evidence is reported separately. |
| Lightning / Boundless / expired promotions | Startup or expiring trial credit is not an indefinite recurring Free entitlement. No credit purchase or paid continuation is enabled. |
| ApiFreeLLM managed transport / MLvoca commercial usage | Paid tools and prohibited commercial access are excluded from packaged Free. |
| OpenCode Console / OVH playground / Murakumo draft-unavailable route | Authorization/availability blockers remain recorded. No impersonation, provider-client headers, private sessions, account farming or proxy/IP rotation. |

Yolo-Auto's independently owned Free plan is a credible additional user candidate: [official docs](https://yolo-auto.com/docs) describe15requests/week with429on exhaustion, and [terms](https://yolo-auto.com/terms) describe no usage-overage charges. No authorized account was available, so no account, automatic Free admission or actual allowance was fabricated. Hetzner's [experimental service](https://docs.hetzner.com/general/company-and-policy/experiments/inference/) remains experimental and unproven for production ownership here.

## Privacy and capacity limits

BlockRun promises no own prompt/completion retention or training in its [privacy policy](https://blockrun.ai/privacy), but upstream handling varies. The integration retains conservative public-code-only consent and does not certify private repository egress. The gateway is displayed and identified as BlockRun; it is not represented as a direct NVIDIA entitlement. Upstream agreements and physical shared fleet capacities are not assumed to be independent allowances for each model.

The per-user eligible pool combines actual packaged/client-direct and authorized account-owned supplies through the existing routing fabric. Separate source-IP provider limits may be useful independent gateway domains, but undisclosed common upstream capacity remains unknown. No aggregate capacity is calculated by multiplying shared quotas by user or model count. No new billing rail, local LLM, CPU-based model training or production deployment was introduced.

Focused deterministic evidence verifies exact-zero admission, no payment headers, forbidden paid targets, current catalog removal, source-IP provider walls, cross-domain isolation, provider-specific policy receipts, late model substitution and unchanged Reviewer thresholds. Live qualification and full task completion are separate evidence claims.
