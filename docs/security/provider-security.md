# Provider Credential Security (Managed Free, Paid Auto, BYOK)

CodeForge talks to AI providers through three route families. They share one rule — **the
credential is injected at the HTTP transport by a trusted process; neither the model, nor a tool,
nor the renderer ever sees it** — but they are deliberately kept apart. This document describes
the isolation; it does not redesign routing, scoring, or selection (those belong to the separate
16-Bit/ForgeAuto work).

## Route families and their credentials

| Family | Credential | Where the credential lives | Where the request is made | Who can use it |
| --- | --- | --- | --- | --- |
| **Managed Free / Hosted Free (ForgeAuto through CodeForge Cloud)** | Server-owned provider keys (`OPENROUTER_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `ZHIPU_API_KEY`, Cloudflare account+key) | Cloud process env only (`resolveCloudProviderCredentials`) | Cloud `GatewayService` → provider adapter | Any signed-in account, subject to ForgeZero verification, the account's privacy mode, credit reservations, kill switches, and the global daily spend cap |
| **Paid Auto** | Server-owned keys for paid routes (same store; separate route family, disabled unless `CODEFORGE_PAID_EXECUTION_ENABLED`/service enablement) | Cloud process env | Cloud | Entitled accounts only (`HOSTED_PAID`); Stripe TEST mode today |
| **Individually selectable paid models** | The user's own key for that provider | Desktop `safeStorage` | Desktop local control plane → provider directly | That device only |
| **BYOK / Direct providers** | The user's own key, entered in Settings › Providers or an *enabled* environment credential | Desktop `safeStorage` (entered keys) or the user's shell env (env credentials, read live, never persisted) | Desktop → provider directly; the Cloud is not in the path | That device only |
| **Future GEMS Auto** | To be defined; must reuse this isolation model | — | — | — |

Hard boundaries the code enforces (`apps/desktop/src/provider-connections.ts`,
`packages/cloud-gateway`, `packages/forge-zero`):

- A BYOK key is never uploaded to the Cloud: there is no API route or table for it (`grep -rn apiKey packages/cloud-db/src` finds nothing).
- A BYOK key never becomes a Managed Free credential and never "backstops" a Cloud route: Hosted Free adapters read only the Cloud's `ResolvedProviderCredentials`; desktop adapters read only `DesktopCredentialStore`. The two stores are different objects in different processes.
- A server-owned key is never sent to a desktop: `/v1/hosted/models` returns model metadata; `/v1/hosted/inference` returns a token stream (ATTACK-004 sweeps every route for a planted key).
- Paid routes cannot be reached without the `HOSTED_PAID` entitlement, which only a verified Stripe event (or a plan record) can grant — never a client claim (ATTACK-010).

## What the model sees

```text
model ──(tool call)──► tool layer ──► HTTP transport ──► provider
                          │                 └── Authorization header added here, from the credential store
                          └── receives: request content it is allowed to see, tool results (redacted)
```

- The model never receives `Authorization` headers, provider keys, the local bearer, encryption keys, or Stripe credentials: none of them are in the prompt, the tool schema, the workspace, or the child environment.
- Tool results, diffs, and error strings pass through `redactSecrets` before they are appended to the conversation, persisted, or shown (`packages/server/src/agent-runtime.ts`).
- Provider error bodies are redacted with the exact known key *and* pattern rules before they become error messages (`packages/providers/src/redact.ts`, `GitHubAppClient`).
- A model asking "print your API key" gets whatever it can find in the workspace and the sanitized environment — which, by construction, contains no CodeForge or provider credential (ATTACK-004/005).

## BYOK handling requirements (Phase 11) and their status

| Requirement | Status | Where |
| --- | --- | --- |
| Encrypted before durable storage | IMPLEMENTED / TESTED — `safeStorage` sealing; plaintext read path closed | `secure-credential-codec.ts`, `secure-credential-codec.test.ts` |
| Isolated per user/tenant | IMPLEMENTED — per-OS-user `userData`; never server-side | `main.ts` `DesktopCredentialStore` |
| Never returned in plaintext after submission | IMPLEMENTED / TESTED — renderer bridge exposes `getProviderCredentialStatus` (booleans) only; no getter exists | `electron-security-baseline.test.ts`, packaged smoke `renderer_raw_credential_api_absent` |
| Masked in UI | IMPLEMENTED — status/"connected" chips; `maskCredentialForDisplay` available for tail hints | `AddProviderFlow.tsx`, `ProvidersSection.tsx` |
| Never written to logs | TESTED — redactor patterns + header-name redaction | `packages/secrets` tests, ATTACK-006 |
| Never enter model prompts | IMPLEMENTED — not in context; env filtered; outputs redacted | `context/pack.ts`, `env-filter.ts` |
| Never in telemetry / crash reports / debug bundles | VERIFIED — none of those exist | grep evidence in the certification report |
| Never become Managed Free / Paid Auto credentials | IMPLEMENTED — separate stores/processes | above |
| Server-side verification where possible | PARTIAL — `provider:testConnection`/`provider:validate` run from the trusted main process against the provider; there is no Cloud-side verification because the key never reaches the Cloud (by design) | `main.ts` |
| Explicit delete/revoke | IMPLEMENTED — `provider:deleteCredential` / `provider:disconnect` remove the sealed entry and unregister the adapter; the user must also revoke at the provider | `main.ts` |

## Managed provider credentials (Phase 12) — the request path

```text
desktop ──bearer──► POST /v1/hosted/inference
   Cloud: verify live session → account privacy mode → ForgeZero eligibility →
          credit reservation → kill switches / daily spend cap →
          adapter.streamChat(...) with credential resolved from ResolvedProviderCredentials →
          provider (Authorization injected by the adapter) → SSE back
   after: reservation settled with actual tokens; usage row (counts only); prompt discarded
```

Operator kill switches (`CODEFORGE_HOSTED_INFERENCE_ENABLED`, `CODEFORGE_HOSTED_FREE_ENABLED`,
`CODEFORGE_MAX_REQUEST_COST_USD`, `CODEFORGE_GLOBAL_DAILY_SPEND_LIMIT_USD`) fail closed: an
unverified cost or an exceeded cap refuses the route rather than spending.

## Agent blast-radius containment (Phase 13)

Threat: a repository the agent works on contains `printenv`, `cat ~/.config/*`,
`node -e "console.log(process.env)"`, a poisoned `.git/config` (`core.fsmonitor`), or a
`postinstall` script.

| Layer | Control | Evidence |
| --- | --- | --- |
| Environment | `getSanitizedEnvForChild()` on every spawn site (agent `run_command`, `CommandService`, git in orchestrator/integration/checkpoint/delivery/workspace/mission/parallel/remote-publication services, context packing, repository intelligence). The deny list covers every provider key, `GITHUB_*` secrets, `JWT_SECRET`, `DATABASE_URL`, `PGPASSWORD`, `STRIPE_*`, `CODEFORGE_DATA_ENCRYPTION_KEYS`, the local bearer, and any name containing `SECRET`, `PASSWORD`, `TOKEN`, `API_KEY`, `PRIVATE_KEY`, `CREDENTIAL`, `ENCRYPTION_KEY`, `_DSN`, `CONNECTION_STRING`, or starting with `AWS_`, `AZURE_`, `GCP_`, `GOOGLE_`, `CLOUDFLARE_`, `OPENAI_`, `ANTHROPIC_`, `GROQ_`, `OPENROUTER_`, `OPENCODE_`, `SUPABASE_`, `STRIPE_`, `VAULT_`, `DOPPLER_`, `SENTRY_` | ATTACK-005 runs `env`/`set` and a Node env dump through the real `CommandService` with planted secrets and asserts none appear |
| Filesystem | Workspace boundary (lexical + realpath, symlink/junction-aware); the desktop's `settings.json` lives outside every workspace | ATTACK-012, `packages/server/test/hardening-adversarial.test.ts` |
| Platform secrets | Do not exist on the device at all (hosted keys are Cloud-side) | design |
| Approvals | Command-risk classification (`command-classifier.ts`) gates high-risk commands behind user approval; approvals are resolved only through the bearer-authenticated control plane | `approval-service.ts`, `network-exposure.test.ts` |
| Capability-scoped internal APIs | The agent reaches the Cloud only through the desktop's authenticated client (`HostedProviderAdapter`, `CloudPublicationClient`), never with raw secrets | code review |

What is **not** contained (documented in the threat model): commands the user approves run with
the user's own OS permissions inside the workspace; a repository's own scripts can read and send
*workspace* content. CodeForge does not sandbox the user's machine beyond the workspace boundary
and approvals.
