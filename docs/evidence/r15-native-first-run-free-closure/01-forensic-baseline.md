# R15 Forensic Baseline — Native First-Run, Auth, Free-Capacity

Date: 2026-09-18
Repo: `G:\CodeForge` (confirmed active checkout, not an archive)
Branch: `forger-digital-solutions-forgegreen-certified`
HEAD at baseline: `23dec0beaa1993c10829d860336100f22e2dcc60`
Package manager: npm workspaces (`packages/*`, `apps/*`)
Desktop entrypoint: `apps/desktop/dist/main.js` (Electron 44.4.1, electron-builder NSIS+portable)

Pre-existing dirty state preserved untouched:
- `M docs/evidence/security-r1/*`, `M scripts/security/audit-dependencies.mjs`
- `?? docs/evidence/desktop-release/host-native-2026-09-18/`, `?? tests/security/dependency-audit-gate.test.ts`

---

## Verified root causes (not symptoms)

### RC-1 — P0-A/P0-B shared: packaged build resolved the Cloud endpoint to dead loopback

Evidence (`docs/evidence/desktop-release/host-native-2026-09-18/07-diag-launch.stdout.log`):

```
[CodeForge] cloud endpoint channel=development cloud=http://127.0.0.1:3220 overridden=false (no override set)
```

The installed NSIS package was built without ever running
`apps/desktop/scripts/set-build-channel.mjs`. The committed manifest ships
`channel: "development"` with endpoint `http://127.0.0.1:3220`
(`apps/desktop/cloud-endpoints.json`). `resolveCloudEndpoint` correctly resolved
exactly that — the endpoint code is not buggy; the **build pipeline never stamped
a real channel**, so every privileged Cloud call went to loopback:3220 where no
process listens:

- `POST /v1/auth/start` → `fetch` connection refused → `CloudAuthError kind="network"`
  → renderer shows "CodeForge sign-in is unavailable right now." **(P0-A)**
- `HostedProviderAdapter.listModels()` → GET `/v1/hosted/models` fails → zero
  `codeforge-cloud` records synced into ForgeZero → **zero Managed Free routes**
  regardless of upstream health. **(P0-B contributor)**

The desktop's embedded `CodeForgeServer` binds an OS-assigned port (evidence:
`RUNTIME_ENDPOINT_55088`) — it never listens on 3220, so nothing ever answered.

### RC-2 — P0-B: RouteQuotaTracker provider-level poisoning

`packages/model-registry/src/quota.ts` `RouteQuotaTracker.record()` writes every
model-scoped quota observation into BOTH `byRoute` and `byProvider`, and `get()`
falls back to the provider bucket. One OpenRouter `:free` model's 429
(`free-models-per-day-high-balance`, `X-RateLimit-Remaining: 0`) therefore marked
EVERY OpenRouter route `QUOTA_EXHAUSTED` via `healthWithObservedQuota()` —
including `deepseek/deepseek-v4-flash-0731:free`, which was still returning HTTP 200
(ground truth: `05-openrouter-quota-ground-truth.json`). A successful response
records no quota, so the poisoned provider-level observation could never be
cleared by a healthy route. This is a false demotion defect: real capacity hidden
behind an unrelated route's rate limit.

### RC-3 — P0-B structural: hosted managed-free transport cannot drive the agent loop

`/v1/hosted/inference` on the deployed cloud accepts only chat `messages`
(`HostedInferenceRequestSchema`, roles `system|user|assistant`, no tools field,
server-side `maxTokens: 2000`). `HostedProviderAdapter.streamChat` throws
`HOSTED_TOOL_CALLING_UNSUPPORTED` when `req.tools` is non-empty, and drops
`tool`/`toolCalls` message content on the floor.

Consequences for a stranger with no API keys:

- The ONLY legitimate zero-credential supply (`codeforge-cloud`, `ZERO_TOUCH`,
  `FREE_ACCOUNT_ENTITLEMENT`, spillover NONE) cannot execute the `coder` role,
  which requires `toolCalling` and emits native `tool_call_*` stream events.
- 8-Bit compact qualification (`runCompactQualification`) probes native tool
  calling — hosted routes cannot qualify for `PRIMARY_CODING_AGENT` even when
  reachable, matching the observed `0 primary coding models`.
- Assistant messages carrying `toolCalls` and `role:"tool"` messages (the agent
  loop's tool results) violate the server's zod enum — even if tools were
  emitted in text, multi-turn tool loops would 400.

**Fix direction chosen:** client-side text-mode tool contract inside
`HostedProviderAdapter` (tools described in the system prompt; model emits
`<tool_call>{json}</tool_call>`; `tool`/`toolCalls` messages normalized to text
equivalents) — works against the ALREADY-DEPLOYED gateway, no redeploy needed.
Server-side native tools passthrough is also implemented (gateway schema +
events + `/v1/meta` feature flag) so a future redeploy upgrades the transport
automatically; the adapter negotiates via `/v1/meta` `features`.

### RC-4 — hosted backend: staging suspended; PRODUCTION is live and healthy

Probes (2026-09-18, ~22:50Z):

| Service | `GET /health/live` | State |
|---|---|---|
| `codeforge-cloud-staging.onrender.com` | 503 "Service Suspended" | suspended by owner request (R12 evidence `render-current.json`) |
| `codeforge-cloud-staging-va.onrender.com` | 503 | suspended by owner request |
| `codeforge-cloud-va.onrender.com` | **200 `{"status":"ok","version":"0.2.0"}`** | **LIVE — Virginia production** |

`codeforge-cloud-va` readiness:

```json
{"status":"ready","database":"connected","hostedInferenceReady":true,
 "availableModelsCount":37,"availableFreeCount":33,
 "killSwitches":{"hostedInferenceEnabled":true,"hostedFreeEnabled":true,
                  "maxRequestCostUsd":2,"globalDailySpendLimitUsd":1000},
 "providerCapacity":[
   {"providerId":"openrouter","status":"healthy","verifiedFreeCount":25},
   {"providerId":"groq","status":"healthy","verifiedFreeCount":8}]}
```

`POST /v1/auth/start` with a valid PKCE challenge returns a REAL GitHub OAuth URL
(`client_id=Ov23liH1JnjFlJJJyQcL`, redirect
`https://codeforge-cloud-va.onrender.com/v1/auth/github/callback`, S256,
`scope=read:user`). The full server-side auth + hosted-free infrastructure is
healthy TODAY.

The deployed build is `feat/codeforge-cloud` @ v0.2.0 (serverVersion matches that
branch exactly). Current branch's cloud-api is v0.4.0 — production runs an older
build. No Render API key exists in this environment; redeploying production is an
owner action (manual deploys per R12 evidence). Nothing in this campaign requires
a redeploy.

### RC-5 — supply semantics: Managed Free depends on sign-in; observed "2 connected providers" were dev-machine env keys

`registerCloudAdapter()` (signed-in) sets `codeforge-cloud` connection
`credentialSource: "FDS_GATEWAY"` — the MANAGED_FREE class. Signed-out, only
catalog browsing runs (`registerCloudFreeCatalogOnly`), and the provider oracle
marks hosted records unroutable. On the smoke machine, the "2 connected
providers" were `OPENROUTER_API_KEY` + `GROQ_API_KEY` user-scope environment
variables — OWNER_DEV_FREE-class supply, present only because it is a developer
machine. A sterile profile has neither → the Enable-Free-Cloud dialog correctly
found "environment credentials" only because they existed on that host.

Free plan economics (server): 500,000 credits/month allowance, 1 concurrent
task, 5,000-credit per-request reservation settled to actual token usage —
sufficient for real agentic tasks.

### RC-6 — UI semantics defects confirmed in code

- `categoryFor()` (`free-cloud-registry.ts`) returns `"Recommended"` for any
  `QUALIFIED` model with `PRIMARY_CODING_AGENT` role **regardless of
  `readiness`** — DeepSeek showed "Free · Temporarily unavailable · Recommended"
  while unrunnable. Capability qualification and runtime recommendation are
  conflated.
- `resolveForgeZeroTrust()` exposes internal engine name "ForgeZero" in the
  header trust badge ("ForgeZero · No Free Route") alongside the product name
  "ForgeAuto/Free".
- Summary counters (`verifiedFreeModels: 22` vs `healthyFreeRoutes: 0`) are
  technically consistent but unlabeled: "verified" counts catalog records,
  "healthy" counts full admission-pipeline survivors.
- `FreeCloudEnablePanel` leads with provider plumbing (env credentials, key
  fields) instead of the three-choice recovery UX the campaign requires.

### RC-7 — observability gap confirmed

Main process logs to stdout only (`console.log`). An installed package has no
log file under `AppData\Roaming\codeforge-desktop` — the only captured output
came from `ELECTRON_ENABLE_LOGGING=1` redirection in the diag harness. Auth
failure categories exist (`CloudAuthError.kind`) but are collapsed into one
user-facing string and are never persisted. No diagnostic-bundle surface exists.

---

## Inventory snapshot (from smoke evidence + live probes)

- Registered catalog (dev machine): ~36 models; `codeforge:5`, `openrouter:27`,
  `paid-auto:4`; FREE_NATIVE:1, PAID:10, FREE_ROUTED:25.
- Connected (dev env): openrouter (paid-tier key, `:free` quota exhausted until
  2026-09-19T00:00Z), groq. Cloudflare/Mistral/Gemini/Z.AI env keys present but
  not connected/attested.
- Production cloud: 37 hosted models, 33 eligible-free, openrouter+groq server
  keys healthy.
- Ollama Cloud: `userConnectedFree` profile exists behind feature flag
  `CODEFORGE_OLLAMA_USER_CONNECTED_FREE`; terms `LEGAL_REVIEW_REQUIRED` +
  `USER_CONNECTED_FREE_PERMISSION_REQUIRED` — stays quarantined.

## Environment facts

- Dev-machine env credentials present: GEMINI, GROQ, MISTRAL, OPENROUTER,
  CLOUDFLARE_API_KEY + CLOUDFLARE_ACCOUNT_ID (matches smoke's detected list).
- `gh` authenticated as `Forger-Digital-Solutions` (repo, workflow) — used for
  read-only inspection only; no pushing without authorization.
- OpenRouter free quota reset: `X-RateLimit-Reset 1789776000000` =
  2026-09-19T00:00:00Z — local dev-key capacity returns ~1h after baseline.
