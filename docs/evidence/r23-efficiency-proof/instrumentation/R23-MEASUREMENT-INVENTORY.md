# R23 Measurement Inventory (M1)

Recorded: 2026-09-20 against HEAD `ae2aa87`.
Method: read the capture points in `packages/server/src/agent-runtime.ts`, `packages/forge-green/src/r0-telemetry.ts`, `packages/providers/src/*.ts`, `packages/server/src/subagent-manager.ts`, `packages/server/src/workspace-event-adapter.ts`, `packages/model-registry/src/*.ts`. Nothing below is inferred from names; every row cites the code that does (or does not) capture it.

Legend — **CAPTURED** (durably, per run) · **PARTIAL** (captured but aggregated/coarse/unwired) · **EVENT-ONLY** (emitted as a live event, not in a durable per-run record) · **ABSENT**.

## 1. Inference accounting

| Quantity | State | Where / gap |
|---|---|---|
| Input tokens | CAPTURED | `usage` stream events → `totalUsage.inputTokens` (`agent-runtime.ts:1457`) → R0 `model.inputTokens` (PROVIDER-origin, OBSERVED); only when `usageSource === "PROVIDER_REPORTED"` |
| Output tokens | CAPTURED | same path |
| Cached input tokens | PARTIAL | `openai-compatible.ts:437` parses `prompt_tokens_details.cached_tokens`; **`openrouter.ts:332` does not parse `prompt_tokens_details` at all** → cached tokens are UNKNOWN on every OpenRouter route; Anthropic adapter parses cache_read/cache_creation (FG-1A) |
| Uncached input tokens | CAPTURED (derived) | R0 `effectiveUncachedInputTokens` = input − cached, DERIVED; UNKNOWN when cached is UNKNOWN |
| Reasoning tokens | ABSENT | `AgentUsage.reasoningTokens` exists as a type field; **no adapter populates it** (`completion_tokens_details.reasoning_tokens` never parsed) |
| Model calls | CAPTURED | R0 `model.modelAttempts` (every attempt) and `model.providerAttempts` (non-dedup-suppressed) |
| Failed model calls | CAPTURED | R0 `providerFailures.providerFailures` + `failureCodes[]` via `normalizeProviderError` |
| Retried model calls | PARTIAL | R0 `retries.retryCount` — only `recordRetry` at `agent-runtime.ts:1238` (structured-output repair path); **provider-level retries inside adapters are not surfaced** |
| Rate-limited calls | CAPTURED | R0 `providerFailures.rateLimitSignals` when normalized code is `PROVIDER_RATE_LIMITED` |
| Provider / model failovers | PARTIAL | `emitRouterFailover` EVENT-ONLY; R0 `routes[]` shows per-route attempt counts from which failovers can be derived |
| Provider identity / model identity | CAPTURED | `response.providerId/modelId` per call → R0 `routes[]`; `usage.provider/model` on the result |
| Per-call ledger (one record per model call with latency, tokens, finish reason, cache) | ABSENT | R0 aggregates only; `emitTokenUsage` is EVENT-ONLY. **Provider-receipt reconciliation is impossible without a per-call ledger.** |
| Model latency per call | ABSENT | no timer around `modelAdapter.execute` |
| Provider-reported cost (e.g. OpenRouter `usage.cost`) | ABSENT | not requested (`usage: {include: true}` not sent), not parsed |
| Actual cost / equivalent public-API cost | ABSENT | R0 `actualProviderCost` and `effectiveProviderCost` are hard-coded `unknown()` (`r0-telemetry.ts:463-464`); `NormalizedPricing` exists in model-registry but is never joined to run telemetry; `cloud-usage` uses hard-coded default rates |

## 2. Context accounting

| Quantity | State | Where / gap |
|---|---|---|
| Model-visible context bytes (sum over calls) | CAPTURED | R0 `context.modelContextBytes` (`recordModelAttempt` sums message bytes per call) |
| Initial context bytes | CAPTURED | R0 `context.initialContextBytes` from `contextMetrics.contextBytes` |
| Estimated input tokens (bytes/4) | CAPTURED (ESTIMATED) | `contextMetrics.estimatedInputTokens` |
| Stable prompt (system) bytes | CAPTURED | R0 `context.stablePromptBytes` |
| Context composition by source | PARTIAL | R0 `context.sourceCategories` = only `{repository_evidence, candidate_files, selected_files}` **counts at bootstrap** (`agent-runtime.ts:1070`); **no per-turn breakdown by system / user task / repository files / tool outputs / memory / subagent handoff / verification** |
| Repository content loaded / reused | PARTIAL | FG-3D ledger `contextPagesReused/Pulled` when progressive assembly is on; not in R0 |
| Unique vs repeated context tokens | ABSENT | nothing computes span-level repetition across calls |
| Necessary repeat vs avoidable duplicate | ABSENT | no definition, no classifier |
| Memory reads / hits | ABSENT (as metric) | mission memory is delivered as a bounded structured block; no hit/miss/relevance accounting |
| Summaries created / reused | ABSENT | no counter |
| Cache hits / misses (canonical cache) | CAPTURED | efficiency receipt `canonicalCacheHits/Misses` |
| Provider prompt-cache hits | PARTIAL | `optimization.promptPrefixCacheHit` + `providerPromptCache.classification` — measured only where adapters report cached tokens (see §1) |

## 3. Tool / agent activity

| Quantity | State | Where / gap |
|---|---|---|
| Tool calls requested / executed / failed / suppressed, per tool | CAPTURED | R0 `tools.byTool[]`, `toolCalls`, `executedToolCalls`, `failedToolCalls`, `duplicateEquivalentToolCalls` |
| Raw tool output bytes vs bytes delivered to model | CAPTURED | R0 `tools.rawToolOutputBytes`, `bytesDeliveredToModelContext`, `compression.*` |
| Tool duration | CAPTURED | R0 `tools.toolDurationMs` (sum) |
| Durable per-tool records | CAPTURED | `agent_tool_execution` work items with `executionClass` ∈ {read_only, write, command, network}, argumentsHash, resultHash, state |
| Shell / browser / MCP / plugin call split | PARTIAL | derivable from tool names (`run_command`, `browser_*`, `mcp__*`, `plugin__*`) in `byTool`; **no first-class category counters** |
| File reads / writes / searches | PARTIAL | derivable from `byTool` (`read_file`, `write_file`, `edit_file`, `search_files`, `list_files`) |
| Planning / exploration / implementation / review / verification call split | PARTIAL | per-run role is known (`req.role`); the orchestrator spawns separate runs per role; **no cross-run roll-up per task** |
| Subagent count / per-subagent usage | CAPTURED (per child) | `subagent-manager.ts:485-495` records `{modelRequests, inputTokens, outputTokens, toolCalls, wallTimeMs, model}` on the worker record |
| Duplicate / conflicting subagent work, reconciliations | PARTIAL | conflict detection exists (R21 M10c) and is EVENT-ONLY; cross-sibling duplicate reads measured only inside the R21 harness, not in runtime telemetry |

## 4. Outcome / verification

| Quantity | State | Where / gap |
|---|---|---|
| Terminal status / stop reason | CAPTURED | R0 `taskCompletionStatus`, `stopReason`; result `status` ∈ {completed, blocked, cancelled, failed} |
| Files changed | CAPTURED | result `filesChanged[]` |
| Lines added / removed | ABSENT | not computed by the runtime (derivable from workspace diff in the harness) |
| ForgeVerify status in R0 telemetry | **UNWIRED** | `persistForgeGreenR0Telemetry` calls `collector.finalize({ wallTimeMs })` **without `forgeVerify`/`completionGate`** (`agent-runtime.ts:2248`) → always `UNKNOWN` |
| ForgeVerify report itself | CAPTURED (separately) | `@codeforge/workflow` `runVerification` → `VerificationReport` with integrity-hashed evidence, `inputStateHash`; persisted via `forge-verify-persistence.ts`; not joined to the run's R0 telemetry |
| Claimed-complete vs verified-complete (false completion) | PARTIAL | `completion-authority.ts` `evaluateCompletion` is the sole completion path (R21 M2); the *runtime* result `status: completed` is the model's claim; the *gate* verdict lives in the workflow layer. **No single per-task record holds both.** |
| Tests passed / failed | CAPTURED (in verification evidence) | verifier evidence per verifier id; not in R0 |

## 5. Time

| Quantity | State | Where / gap |
|---|---|---|
| Wall-clock per run | CAPTURED | R0 `wallTimeMs` |
| Tool time | CAPTURED | R0 `tools.toolDurationMs` |
| Model wait time | ABSENT | no per-call timer (see §1) |
| Verification time | CAPTURED (separately) | `evidence.elapsedMs` per verifier in ForgeVerify |
| Queue time / recovery time | PARTIAL | hosted admission records queue wait (R20); not on desktop runs; recovery has `recoveryOutcome` but no duration |
| ForgeGreen overhead | CAPTURED | R0 `forgeGreenOverheadMs` (collector self-timing) |

## 6. Local resources / energy

| Quantity | State | Where / gap |
|---|---|---|
| CPU time / RSS / handles of the agent process | ABSENT | `NullHardwareTelemetryAdapter` only (`hardware-telemetry.ts`) → `INSUFFICIENT_DATA`; Node `process.cpuUsage()`/`memoryUsage()` are available to build a RUNTIME-origin adapter |
| GPU utilization / power | ABSENT (sensor available) | `nvidia-smi` is present on this workstation (Quadro T2000); no adapter spawns it; irrelevant to remote inference, relevant only as local-footprint evidence |
| CPU package energy | ABSENT (no sensor) | Windows exposes no non-admin RAPL; would need LibreHardwareMonitor or similar — not present |
| Network bytes | ABSENT | provider adapters do not count request/response bytes; response body bytes could be measured at the adapter |
| Remote provider energy | ABSENT — must stay MODELED | `ReferenceHeuristicEstimator` exists and is labelled heuristic; `InsufficientDataEstimator` is default. Correct. |

## 7. Identity / provenance for a benchmark run

| Quantity | State | Where / gap |
|---|---|---|
| run_id / session_id / agent_id / workspace_id | CAPTURED | R0 `identity` |
| repository revision / generation | PARTIAL | `repositoryGeneration` captured; `repositoryRevision` (commit) is optional and not set by desktop runs |
| task_id / benchmark_version / protocol_version / arm (baseline vs optimized) / forgegreen_enabled / subagents_enabled | ABSENT | no benchmark identity fields exist in runtime telemetry; the R21 harness carried them in its own JSON only |
| environment fingerprint (OS, CPU, node, codeforge commit) | ABSENT (runtime) / present in FG-12E `harness-identity.ts` for verification benchmarks | to be generalized |
| Durable survival across restart | CAPTURED (mechanism) | `insertIfAbsent` work items; R0 saved once per run; the run journal supports resume. **Not yet proven for a mid-run crash of the benchmark harness itself** (M4 restart fixture) |

## 8. External tools (browser / MCP / plugins)

| Quantity | State | Where / gap |
|---|---|---|
| Browser / MCP / plugin call counts | PARTIAL | via `byTool` names; `executionClass:"network"` on durable records |
| Response sizes / truncation / redaction counts | PARTIAL | truncation applied in `packages/mcp` and browser tools; bytes reach R0 as tool output bytes but with **no per-class attribution** |
| Repeated navigation / stale-read suppression | CAPTURED (mechanism) | `DuplicateActionSupervisor` external classifier (R22 M12) → `duplicateActionsSuppressed`; per-class breakdown absent |

## Summary — critical gaps that block a trustworthy benchmark

Ranked by how directly they block the headline metric (verified tasks / 1M model tokens, cost / verified task):

1. **No per-model-call ledger** (tokens, cached, reasoning, latency, finish reason, provider/model, cost) → cannot reconcile against provider receipts, cannot measure model wait time, cannot detect retry storms per call.
2. **OpenRouter adapter drops `prompt_tokens_details`** → cached/uncached split UNKNOWN on the only route class with the broadest $0 catalog; and `usage.cost` is never requested.
3. **No cost conversion** (actual vs equivalent public-API) joined to run telemetry; no frozen pricing snapshot.
4. **ForgeVerify verdict not joined to the run record** → `task_verified` / `false_complete` cannot be computed from telemetry alone.
5. **No benchmark identity fields** (task_id, arm, protocol/benchmark version, environment fingerprint, forgegreen/subagent flags) in the per-run record.
6. **No context composition by source per call**, and **no repeated-vs-unique / necessary-vs-avoidable duplicate classifier**.
7. **No local resource adapter** (CPU time, RSS, network bytes) — currently `INSUFFICIENT_DATA` by design.
8. **No cross-run task roll-up** (orchestrator + explorer + coder + reviewer + verifier runs of one task) — the headline metric is per *task*, not per *run*.
9. `reasoning_tokens` never parsed on any OpenAI-compatible route.

Everything else needed by the R23 run schema either exists or is derivable from existing records.

## What must NOT change

- Token counts come only from provider-reported `usage` events (`usageSource === "PROVIDER_REPORTED"`); estimated tokens stay labelled ESTIMATED. R23 keeps the source/origin labelling discipline of R0 telemetry.
- `evaluateCompletion` (completion authority) remains the only verified-success path; the benchmark reads its verdict, it never redefines it.
- Security boundaries (network:false leases, tool gates, SSRF, approval authority) are not touched by instrumentation.
