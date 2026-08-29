# CODEFORGE FREE-FIRST PLATFORM IMPLEMENTATION

## Repository

- **Starting SHA:** `b8928e7` (recovery branch `feat/workspace-ui-recovery` — preserved, not reset)
- **Final SHA:** `6a22d4b`
- **Branch:** `feat/free-first-platform` (new, off the recovery base)
- **Working tree:** clean; build output (`dist/`, `release/`) is gitignored, not tracked
- **Commits:** 10 logical commits on top of the recovery base
- **Push:** none (local only)
- **Release:** NOT PUBLISHED — tags `v0.1.0`, `v0.1.0-test-debug`, `v0.2.0` untouched; no new tags; no artifacts pushed

## Research

All checked **2026-08-29**; recorded in [docs/research/provider-model-access-2026.md](research/provider-model-access-2026.md).

- **Models.dev:** live-pulled `https://models.dev/api.json` (4.4 MB, 207 providers). Shape: `{[providerId]:{id,env[],npm,api,doc,models:{[id]:{cost:{input,output,...}(per 1M), tool_call, reasoning, structured_output, attachment, modalities, limit:{context,output}, last_updated}}}}`. Pricing is per-million (verified: gpt-4o-mini = 0.15/0.6).
- **OpenRouter:** `https://openrouter.ai/api/v1` (OpenAI-compatible); `/models` = 396 models, pricing strings **per-token**, `:free` = 21 models at $0. OAuth PKCE: `/auth?callback_url&code_challenge&code_challenge_method=S256` → `/api/v1/auth/keys`.
- **Z.AI:** `https://api.z.ai/api/paas/v4` (OpenAI-compatible), `ZHIPU_API_KEY`; free `glm-4.5-flash`/`glm-4.7-flash` ($0), paid `glm-4.7` (0.6/2.2).
- **Gemini:** OpenAI-compat `generativelanguage.googleapis.com/v1beta/openai`; free tier is a **quota allowance**; free-tier prompts may train → privacy=permissive.
- **Groq:** `api.groq.com/openai/v1`, free developer allowance (paid unit prices listed).
- **Cloudflare Workers AI:** `.../accounts/${ID}/ai/v1`, daily neuron allowance.
- **OpenAI:** no $0 API models (ChatGPT-Free ≠ API). **Anthropic:** Messages API (`x-api-key`), no ongoing free (trial credits only).
- **AI SDK / LiteLLM:** kept native TS `ProviderAdapter` transport (one OpenAI-compatible base + a dedicated Anthropic Messages adapter); LiteLLM deferred to Cloud, not a desktop dependency.

## Architecture

```
Models.dev / live provider catalogs        (UPSTREAM FACTS)
        │  normalize + Zod-validate + cache (offline snapshot fallback)
        ▼
NormalizedModelRegistry  →  ModelRecord (id, caps, pricing/1M, accessClass, authMode, privacyClass)
        │
CodeForge verification OVERLAY (independent store; the ONLY thing that grants verifiedFree)
        │  toFreeModelRecord() bridge
        ▼
ForgeZero  (TRUST: access-class + privacy + orphan + auth/health + deprecation gates)
        │  eligibleModels()
        ▼
ForgeRouter (deterministic capability-aware ranking, top-5)  →  UI / AgentRuntime
        │
CodeForge Provider Adapter (OpenAI-compatible base | Anthropic Messages) → provider (native TS)
```

- **Models.dev = raw facts; ForgeZero = trust.** Models.dev metadata alone can never produce VERIFIED FREE — the overlay requires live-catalog confirmation ($0-unit) or a live probe (allowance).
- **Credentials:** desktop `safeStorage` (DPAPI) encryption; renderer never sees raw keys (packaged smoke asserts this); credentials stay local, sent only to the provider.
- **Privacy:** a routing constraint (STRICT/STANDARD/MAXIMUM_FREE) enforced in the verifier.

## Models.dev

- **Cache:** in-memory + injectable disk `CachePersistence`; `lastUpdated` tracked.
- **Refresh:** `NormalizedModelRegistry.refresh()` fetch→validate→normalize→replace→persist.
- **Fallback:** live → disk cache → bundled snapshot (39 real models, captured 2026-08-29). Upstream outage never destroys availability (tested).
- **Normalization:** lenient Zod; only providers with a CodeForge policy are surfaced.

## ForgeZero

- **Access classes:** FREE_NATIVE, FREE_ROUTED, FREE_ALLOWANCE, FREE_PROMO, TRIAL, PAID, UNAVAILABLE (no misleading `free` boolean).
- **Auth modes:** NONE, OAUTH_PKCE, ACCOUNT_CONNECT, API_KEY, HOSTED_RELAY.
- **Privacy:** strict/standard/permissive vs STRICT/STANDARD/MAXIMUM_FREE modes.
- **Health:** available/degraded/auth_required/rate_limited/quota_exhausted/offline + retryAfter/recentFailureCount.
- **Top-five scoring:** capability match + empirical coding/agent/toolReliability + free-class stability + health penalty; deterministic (score desc, modelId tiebreak).
- **Task-aware routing:** agentic/simple/long-context heuristics.
- **Free→paid prevention:** TRIAL/PAID never eligible; no-free-provider → route null / adaptive fail-closed (never a paid fallback).

## Providers

| Provider | Implemented | Auth | Ongoing Free | Allowance | Trial | Paid | Discovered (live) | Actually tested | Status |
|---|---|---|---|---|---|---|---|---|---|
| OpenRouter | ✅ base+OAuth | OAUTH_PKCE / API_KEY | ✅ (routed) | – | – | ✅ | **396 → 21 free (live)** | ✅ **real streaming** | Verified live |
| Z.AI | ✅ base | API_KEY | ✅ ($0 flash) | – | ✅ | ✅ | – (no key) | unit-tested | Impl. complete |
| Google Gemini | ✅ base | API_KEY | – | ✅ | – | ✅ | – (key suspended) | unit-tested | Impl. complete |
| Groq | ✅ base | API_KEY | – | ✅ | – | ✅ | 14 live (0 $0) | listModels live | Impl. complete |
| Cloudflare | ✅ base (+acct) | ACCOUNT_CONNECT | – | ✅ | – | ✅ | – (no key) | unit-tested | Impl. complete |
| OpenAI | ✅ base | API_KEY | ❌ | – | – | ✅ | – | unit-tested | Impl. complete |
| Anthropic | ✅ Messages | API_KEY | ❌ | – | ✅ | ✅ | – | unit-tested | Impl. complete |

## OpenRouter

- **OAuth PKCE:** pure core (S256 challenge, random verifier+state, auth URL, state-validated callback, code→key exchange, status-only error redaction) + Electron main flow (loopback callback server, system browser, timeout/cancel) + IPC (`oauth:openrouter:start`) + renderer button. Unit-tested; interactive click-through pending (see Limitations).
- **Discovery:** live `/models` → $0 (`:free`) verified via overlay → registered into ForgeZero.
- **Free router:** `openrouter/*:free` handled as FREE_ROUTED (not auto-ranked above individual free models).
- **Current free (live 2026-08-29):** 21, e.g. `cohere/north-mini-code:free`, `google/gemma-4-*:free`, `inclusionai/ling-3.0-flash-fin:free`, `nvidia/nemotron-*:free`, `minimax/minimax-m3:free`.
- **Actually tested:** ✅ real streamed inference (below).

## Z.AI / Gemini / OpenAI / Anthropic / Groq / Cloudflare

Direct endpoints + models + access classes per the matrix; streaming, tools, 401/429/timeout normalization, health, disconnect all implemented and unit-tested. Live inference tested only where a valid key was available (OpenRouter). Z.AI (no key), Gemini (env key suspended — 403), Cloudflare/OpenAI/Anthropic (paid / no key) not live-tested — honest limitation.

## Live Top Verified Free (2026-08-29, live-derived, not hardcoded)

From the standalone `verify-free-inference.mjs` against the real OpenRouter catalog:

| # | model | access | ctx | tools | privacy | verified price | health |
|---|---|---|---|---|---|---|---|
| 1 | openrouter::cohere/north-mini-code:free | FREE_ROUTED | 256k | yes | standard | $0/$0 | available |
| 2 | openrouter::dots-studio/dots-3-note-preview:free | FREE_ROUTED | 512k | yes | standard | $0/$0 | available |
| 3 | openrouter::google/gemma-4-26b-a4b-it:free | FREE_ROUTED | 262k | yes | standard | $0/$0 | available |
| 4 | openrouter::google/gemma-4-31b-it:free | FREE_ROUTED | 262k | yes | standard | $0/$0 | available |
| 5 | openrouter::google/lyria-3-clip-preview | FREE_ROUTED | 1049k | yes | standard | $0/$0 | available |

## Real Free Inference (the gate)

Two live proofs through the **real product runtime** using the environment's authorized OpenRouter key (an authorized test session; never logged; $0 models only):

1. **Adapter route** (`scripts/verify-free-inference.mjs`): OpenRouter 396 models → 21 verified-free → ranked top-5 → **streamed a real 730-char response** from `cohere/north-mini-code:free` (usage 28in/168out). Groq: 14 live, 0 $0-unit (its free tier is allowance — correctly not auto-verified from pricing).
2. **Full-server E2E** (`scripts/verify-free-server-e2e.mjs`) through the exact `CodeForgeServer` the desktop embeds: 21 verified-free registered & eligible → `/api/send` → **`mode:"real"`** → **57 `text.delta` streamed** → **`assistant.message.completed` PERSISTED** ("A model registry in an AI coding tool is a centralized repository…") → **session isolation: 0 events leaked** to another session's SSE. **PASS.**

- Provider: OpenRouter · Access class: FREE_ROUTED · Cost verification: $0/$0 (verified-free) · Result: real streamed prose, persisted, isolated.

## Assistant Conversation

- **Streaming:** `assistant.message.started` → `text.delta` (with messageId) → live; UI cursor while streaming.
- **Persistence:** `assistant.message.completed` carries final user-facing text; persisted per event (no private chain-of-thought).
- **Reload:** event-sourced `buildTimeline()` reconstructs prose from persisted events (verified: prose reloads from boundaries even without deltas).
- **Ordering / tool interleaving:** chronological by seq — user → assistant → tool → assistant.

## Sessions

- **A/B isolation:** SSE scoped by `?sessionId=`; UI filters by active session + dedupes by seq (live-verified: 0 bleed).
- **Switching:** re-subscribes scoped, resets event list + lastSeq, re-hydrates.
- **Reconnect / duplication:** seq-dedupe idempotent across replay; packaged reload ×5 rehydrates.

## Provider UX

- **First run:** no CodeForge account required; "Connect a free provider" via one-click OpenRouter OAuth (BYOK fallback); credentials stay on device.
- **Settings:** real provider manager — all 7 providers, honest free/paid descriptions, connect/disconnect, health.
- **Errors / auth-required:** 401 → provider marked auth_required, excluded from Auto (never hammered), reconnect restores; secrets redacted from error bodies.

## Model Selector

CODEFORGE (Auto) · TOP VERIFIED FREE (#1–5 live) · GEMS (Topaz/Sapphire/Peridot/Garnet) · Z.AI · OPENROUTER · GOOGLE · GROQ · CLOUDFLARE · ANTHROPIC · OPENAI — each with honest access badges (Free / Free·routed / Free·allowance / Trial / Paid·$in/$out per 1M); no empty sections faked as available; paid selection requires explicit confirmation.

## Muse Spark

- **UI:** hidden (regex guard) — never a hero/selectable row.
- **Routing:** removed from `FREE_CATALOG` and from server + desktop runtime registration; no id-favoritism in the router. Confirmed absent from normal routing (paid-catalog + router tests).
- **Legacy references:** record + factories retained only as test fixtures.

## Automated Verification

- **Typecheck:** `tsc -b --force` → PASS.
- **Build:** `npm run build` (all packages + desktop main/renderer + web) → PASS.
- **Tests:** `vitest run` → **660 passed / 660 (67 files)**.
- **New tests (~72):** model-registry registry (20) + discovery (4); providers oauth-pkce (8) + openai-compatible (10) + anthropic (6) + redact (3); router free-router (6); forge-zero orphan-invariant (6); ui timeline (9); plus updated paid-catalog / muse-spark / lifecycle-audit.

## Electron Verification (real, unpackaged app launched)

Booted the real Electron app (server at :3210) and verified live: `/api/models` (orphan `codeforge::free-model-1` correctly ineligible, Muse Spark PAID/ineligible), `/api/free/top` (live top-5 from a connected provider's discovery), `/api/privacy-mode`, provider health, and **Auto routing selecting the #1 verified-free model** (`opencode::big-pickle`). The launched instance's own send hit a **401 (stale saved opencode key)** — which correctly demonstrated routing but not completion; real inference was then proven through the identical `CodeForgeServer` runtime with a valid key (above).

## Packaged Verification

- **Package command:** `electron-builder --dir` → `release/win-unpacked/CodeForge.exe` (asar) built.
- **Smoke (fresh profile), all 3 modes PASS:** full (welcome, provider metadata, provider setup UI, workspace restore + escape-blocked, workflow + failure-repair, **reload ×5 rehydration**, encrypted credential round-trip, renderer-credential-isolation), interrupt (restart interruption), recover (failed-safely, no approval replay, corrupt-credential fail-closed, credential decrypt, fresh task).

## Security

Credentials encrypted at rest (safeStorage) + local-only + renderer-isolated (smoke-asserted); ForgeZero fail-closed; provider allowlist; **secret redaction from provider error bodies (new — found & fixed live)**; workspace isolation (escape blocked); approvals; hash-checked edits; verification/repair; timeouts; privacy routing.

## Remaining Limitations

1. **Interactive in-app OAuth click not performed this session.** The OpenRouter OAuth PKCE flow is implemented, unit-tested, and wired into the desktop (button + IPC + loopback server), but the browser click-through was not completed live. The free route was instead proven end-to-end through the identical `CodeForgeServer` runtime using the environment's authorized OpenRouter key.
2. **Second independent live free route not achieved.** Z.AI (no key in env), Gemini (env key suspended — 403), Cloudflare/OpenAI/Anthropic (no key / paid-only). Groq's free tier is an allowance (no $0-unit model) so it yields no auto-verified free model — correct behavior, not a bug. All are implemented + unit-tested.
3. **FREE_ALLOWANCE live verification (probe) not exercised** end-to-end (needs a valid Gemini/Groq/Cloudflare account); the probe path + classification are implemented + unit-tested.
4. **GUI renderer flows** (visual dropdown, streaming cursor) verified via API + packaged smoke + unit tests, not pixel-driven automation.
5. **Empirical model scores** are seeded from benchmark metadata; the synthetic certification-workload scorer is scaffolded, not yet populated from real runs.
6. **Cloudflare** account-id credential UX is env/settings-based, not a dedicated dual-field form.

## Release Status

**NOT PUBLISHED.** No tags created or moved; no binaries pushed; work isolated on `feat/free-first-platform`.

## VERDICT

**CODEFORGE_FREE_FIRST_PLATFORM_PASS_WITH_LIMITATIONS**

The free-first multi-provider platform is fully implemented, integrated, typechecked, tested (660 passing), built, and packaged (all 3 smoke modes). A **genuine free cloud route is proven end-to-end through the real product runtime** — real OpenRouter streaming via the product's adapters → discovery → ForgeZero → router → `CodeForgeServer` `/api/send` (`mode:"real"`), with assistant prose streamed + persisted and multi-session isolation verified. The real Electron app and the packaged app were both exercised. The limitations above (chiefly: the interactive in-app OAuth click and a second live free provider were not completed for lack of valid interactive credentials this session) are the honest gap between this and an unqualified PASS.
