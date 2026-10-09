# R73 independent supply review — 2026-10-09

Reviewed the BlockRun adapter, exact served-model checks, policy renewal, existing Free projection, role receipts/history, OpenRouter owner-bound connection changes and Puter transport exclusion. No payment authority, silent paid fallback, new private-repository egress admission, or cross-user OAuth credential reuse was found in the reviewed changes. Puter remains `INTEGRATED_BUT_FREE_ADMISSION_BLOCKED`; its injected SDK tests are not live authorization or billing certification.

The exact-model stream guard withholds executable terminal tool calls until the checked stream finishes. A later model-identity change fails before a tool can execute. Current Free catalog evidence is refreshed before dispatch after its five-minute lifetime; removed, unavailable and paid entries are rejected. BlockRun catalog prices specify zero input/output; an explicitly supplied nonzero transaction fee is refused. Anonymous dispatch supplies no wallet, key or payment signature. The evidence does not assume undocumented upstream quotas or private-code privacy protection.

Public GET snapshot `blockrun-catalog-1791538292195.json`, checked at `2026-10-09T09:31:31.983Z`, found `nvidia/llama-3.2-11b-vision` and `poolside/laguna-xs-2.1` available; the other five Free entries were unavailable. This GET dispatched **zero inference requests**. The existing Llama Reviewer V3 receipt was still fresh and remains Reviewer-only, with 5/6 cases meeting the unchanged protocol threshold. It grants no Coder or Tool Agent qualification.

## Bounded Laguna XS attempt and concrete repair

One authorized public compact qualification attempted `poolside/laguna-xs-2.1`, bounded to 12 POST requests and 180 seconds. It dispatched **4 real requests** in about eight seconds. The first response contained only a role chunk and stream terminator; the next three explicitly reported NVIDIA Llama instead of Laguna XS. The exact-model guard rejected all substituted responses. No Coder, Tool Agent or Analyst role was qualified, and no receipt was added to production admission.

Raw evidence is preserved without modification in `blockrun-compact-1791538496172.json` and `blockrun-compact-observations-1791538496172.json`. That run exposed a concrete qualification classification defect: the suite discarded structured provider codes and interpreted identity rejection as coding failure, then spent two additional probes. R73 now preserves `MODEL_SUBSTITUTED`, `SERVED_MODEL_UNVERIFIED` and `MODEL_IDENTITY_MISSING` codes as inconclusive provider-compatibility evidence. Compact and role suites stop at the identity failure, archive it as transient, and cannot promote or demote the requested model from that evidence.

The existing service previously labeled every transient qualification interruption `RATE_LIMITED`. Identity failures now receive the exact model-local reason `MODEL_IDENTITY_UNAVAILABLE` and a bounded cooldown. They create no quota depletion observation, provider-wide cooldown or unrelated role failure. Existing rate-limit handling is unchanged.

`blockrun-laguna-identity-interpretation-1791538943472.json` binds the preserved source files and current compiled classification code by SHA-256. Its offline replay consumes the first two recorded invocations, then stops. It makes **zero additional inference calls** and marks all three unmeasured roles `NOT_TESTED`; it is a corrected interpretation, not a new model qualification. The original four real requests remain in the mission request count.

## Validation

The current BlockRun transport file passed **12/12 tests** standalone, including the catalog-expiry check that failed during the earlier source-changing broad run. Receipt: `blockrun-final-review-tests.json`.

Identity classification, compact/role qualification, Reviewer-only qualification and BlockRun supply isolation passed **55/55 tests across five files**. Receipt: `qualification-provider-identity-tests-2.json`. The first attempt failed before tests because the sandbox temporary directory did not exist; `qualification-provider-identity-tests.json` preserves that infrastructure failure. The successful run used a worktree-local temporary directory. TypeScript build of Eight-Bit and model-registry passed; `git diff --check` passed.

The root workstream separately hardened active FreeCloudService receipt ingress and reads with copies, matching the existing immutable persistence history. Full autonomous review, ForgeVerify, parent integration, Windows packaging, account live entitlements and organic cross-provider continuation remain separate acceptance proofs.

## Remote dispatch limitation

The installed desktop and local `forge serve`/CLI path can select BlockRun through the existing fabric. The authenticated hosted client-direct outbox remains **Kilo-only**. No desktop production entry point instantiates `RemoteDirectHttpClient`; the external worker uses `scripts/cloud/remote-direct-worker.mjs`. Local provider settings therefore establish installed runtime availability, not hosted BlockRun support.

The restriction spans `packages/server/src/remote-client-direct.ts` (signed provider, endpoint and model validation), `remote-direct-transport.ts` (durable jobs currently omit provider identity), `remote-direct-client.ts` (Kilo-only anonymous factory and feedback), `remote-direct-admission.ts`, both remote provider adapters, `apps/cloud-api/src/remote-direct-http.ts`, `remote-direct-host.ts` and `production-remote-direct.ts`. The durable schema is in `packages/sessions/src/session-state.ts`. A single whitelist edit would leave assignment identity, job recovery, cloud admission and feedback incompatible.

A coordinated extension must preserve MAC/account/device/session/workspace/run/request/nonce binding, idempotency and recovery, exact provider-to-endpoint pairing, no credentials/payment authority, current provider-specific policy/catalog and Reviewer protocol checks, served-model rejection before tool execution, source-IP domain ownership and existing cost/privacy gates. Necessary tests include paired endpoint/provider tamper rejection, legacy Kilo job restart, cross-provider idempotency conflicts, unavailable/paid BlockRun catalog refusal before POST, current Reviewer-only admission with Coder rejection, substituted results and malformed feedback rejection, account/session isolation, model versus provider quota scope, cancellation/replay and control-plane request pressure. No production source was modified for this extension, and no hosted BlockRun support is claimed.
