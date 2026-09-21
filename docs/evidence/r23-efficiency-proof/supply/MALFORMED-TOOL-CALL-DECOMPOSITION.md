# R23 — Malformed tool-call decomposition (§6)

Recorded: 2026-09-21 ~15:05Z · protocol v1.0.6 · HEAD `7e77984` · scope: every provider/runtime rejection
across all R23 qualification + prescreen records, with runtime/provider/model attribution.

## 1. What emits what — mechanism map

| Layer | Behaviour when the model emits a bad call | Visibility |
|---|---|---|
| Groq (server-side tool validation) | Rejects the whole call in-band after HTTP 200 (`tool_use_failed` / `output_parse_failed`, HTTP 400) | Adapter `INVALID_TOOL_OUTPUT`/`PROVIDER_ERROR` + `errorMessage` |
| OpenRouter `:free` upstreams | Most pass the call through; the runtime broker denies unknown/unleased tools (`TOOL_PERMISSION_DENIED`, terminal) | `security_blocked` classification (F12) |
| NVIDIA worker (nemotron upstream) | `ResourceExhausted: Worker local total request limit reached (16/16)` — supply saturation, never a tool verdict | `provider_failure` / 8-Bit `TEMPORARY_CAPACITY` |

So: **Groq rejections measure model tool-format discipline directly; OpenRouter prescreen
boundary deaths measure the same model behaviour through a different enforcement point.** The
taxonomy now keeps them distinct: `INVALID_TOOL_OUTPUT` (provider-rejected) vs `security_blocked`
(runtime boundary) vs `provider_failure` (supply).

## 2. gpt-oss-20b — every rejection, classified

| Round | Run | Call | Tools advertised | Provider code | Category | Retry result | Task outcome |
|---|---|---|---|---|---|---|---|
| 4 | `96d0dd54` missing-export | 4 | 15 | `output_parse_failed` | provider parser rejection (unparseable generation) | absorbed | **verified_complete** |
| 4 | `e96d06d8` off-by-one | 1 | 15 | `tool_use_failed`: `repo_read_file` not in request.tools | hallucinated tool name — `repo_*`×`read_file` blend, never existed in CodeForge | absorbed | **verified_complete** |
| 4 | `e96d06d8` off-by-one | 7 | 19 | `output_parse_failed` | provider parser rejection | absorbed | **verified_complete** |
| 4 | `5adb11f4` return-sign | 7 | 19 | `tool_use_failed`: `repo_list_files` not in request.tools | hallucinated tool name — `repo_*`×`list_files` blend, never existed in CodeForge | absorbed | **verified_complete** |
| 5 | `18907f6e` missing-export | 19 | 19 | TPM 429 `Limit 8000, Used 5229` | **runtime/governor defect F14b** — completion tokens not debited at release; fixed `3424a67`. NOT a model failure | n/a | provider_failure (killed reviewer) |
| 6 | `72f4e7ba` missing-export | 14–16 | 19 | `output_parse_failed` ×3, **same conversationDigest `1b68a678344a`, msgs 24** | provider parser rejection on ONE turn, retried to the F14a bound (3), unmetered | bound exhausted → child ended | **verified_complete** (reviewer finished; edits on disk) |

**Rate:** 8 malformed-semantic rejections / 85 served-call attempts ≈ **9.4% of calls**; by turn
≈ 5–6%. Spread across 15-tool (read-only child) and 19-tool (coder) phases and across early/late
positions — no phase or positional concentration. **Not route-specific** (the route is the whole
Groq request path; the same shape on 120b shows the same classes). **Not runtime-induced**: all 19
advertised names are valid and unique; no prompt teaches `repo_read_file`/`repo_list_files`/`json`
(git history + prompt audit — none exist anywhere in the tree); required fields are identical in
both schema surfaces. **Verdict: model-intrinsic stochastic malformed output**, rate ~10%/call —
§2.2(c) disqualifying on any 3-task round (P(0 malformed in ~50–85 calls) is small).

## 3. gpt-oss-120b — every rejection, classified (rounds 1–3, preserved)

| Run | Call | Tools | Provider code | Category |
|---|---|---|---|---|
| `f6ade2e1` | 6 | 15 | `tool_use_failed`: `json` not in request.tools | hallucinated pseudo-tool — emitted where a JSON-only response was expected (reviewer/explorer contract); **structured-output artifact** |
| `f6ade2e1` | 9 | 19 | `tool_use_failed`: `repo_tree` not in request.tools | hallucinated name — `repo_*` blend |
| `f6ade2e1` | 17 | 19 | `tool_use_failed`: `run_command` missing `command` | correct tool, missing required arg |
| `f6ade2e1` | 22 | 15 | `tool_use_failed`: `json` not in request.tools | same `json` artifact |
| rounds 1–2 records | 8 calls | 15/19 | `STREAM_INTERRUPTED` (pre-adapter-fix) | same in-band rejections, invisible at the time — reclassified by F1, not re-counted |
| early records | 9 calls | — | `MISSING_API_KEY` | harness infra, not model |

Rate ≈ **11–17%** of calls. Same classes as 20b plus the `json` artifact — the `json` pseudo-call
appears exactly where the runtime asks for a bare JSON object (structured-output reviewer/explorer
contracts), i.e. the model encodes "answer in JSON" as a tool call. Intrinsic to the gpt-oss family
under strict server-side validation.

## 4. Other routes

| Route | Rejections | Class |
|---|---|---|
| nemotron (`:free`) ×9 rounds | 86+ `ResourceExhausted (16/16)` 502s, **0 malformed** | pure supply saturation (NVIDIA shared 16-slot worker); capability clean — 7/27 verified, 0 false completions, 0 malformed runs |
| OR prescreen ×4 (nemotron-3.5-lightning, nemotron-3-super-120b, nemotron-3-ultra-550b, ling-3.0-flash-sante) | `run_command` called while withheld by lease | **F15 root cause found & fixed**: the static coder prompt instructed `run_command` unconditionally; now conditioned on the tool being advertised. Was classified `security_blocked` (runtime boundary), counts as tool-contract failure under §2.2 |
| OR prescreen ×5 models | malformed tool calls (pre-errorMessage records) | model-intrinsic, excluded under §2.2(c) |
| gemma ×2 | 8× `RATE_LIMITED` 0-served | starved supply |
| inkling ×2 | `AUTH_ERROR` 403 "only available on agentic harnesses" | `ACCESS_RESTRICTED` — permanent, never a credential fault |
| qwen3.8-27b (groq) | 3× `RATE_LIMITED` | tokenizer ratio ≈1.8× vs 8k TPM — capacity-infeasible, not malformed |
| GitHub Models | HTTP 410 | `MODEL_RETIRED` |

## 5. CodeForge's own contribution — audited and fixed

| Question | Answer |
|---|---|
| Do prompts/docs/history teach `json`, `repo_tree`, `repo_read_file`, `repo_list_files`? | **No.** Zero occurrences anywhere (git log -S, full-tree grep). They are model-side blends of the 12-member `repo_*` family with generic names, plus the `json` structured-output artifact. |
| Did any prompt contradict the advertised tool set? | **Yes — F15.** Coder template rule 4 instructed `run_command` under leases that withhold it (`executeCommand:false` filters it out). This manufactured provider rejections/boundary stops. Fixed in `12cfd79`; contract test pins it. |
| Schema ambiguity? | Two tool surfaces exist (`agentToolDefinitions` interactive vs `BUILT_IN_TOOL_DEFINITIONS` autonomous): identical names + required fields; descriptions and two optional props drifted — no rejection path, flagged for unification. |
| Runtime-induced? | No. Round-5's 429 was a runtime defect (F14b, fixed); every other rejection is upstream of the runtime. |
| Do retries hide failures? | No — every rejection is ledgered (`errorMessage`, digest, retryable flag); §2.2(c) counts the run malformed regardless of recovery. Reliability-after-recovery and raw format reliability stay separate measurements. |

## 6. What this means for qualification

- `gpt-oss-20b`: ~10%/call intrinsic malformed rate → §2.2(c) fails on realistic rounds.
  Reliability-after-recovery is excellent (4/4 runs with absorbed rejections still verified), but
  the frozen criterion reads on raw output discipline. **Not qualifiable today.**
- `gpt-oss-120b`: same family behaviour at a higher rate. Not qualifiable.
- `nemotron`: zero malformed calls ever observed. Its blocker is exclusively NVIDIA shared-worker
  supply — a capacity dimension, not a capability one.
