# R85 free-supply audit (live observations, 2026-10-11)

All observations from live anonymous adapters against the same R84-published source (`41f7a162`). No credentials, no paid inference, no local inference.

## Catalogs (catalog ≠ capacity)

| Provider | Free models listed | Terms posture |
|---|---|---|
| `kilo-free-direct` | 12 | 6× CLEARED non-NVIDIA, 4× DEVELOPMENT_ONLY (`nvidia/*` trial), 1× LEGAL_REVIEW_REQUIRED (`kilo-auto/free` opaque router), plus retired |
| `blockrun-free-direct` | 2-3 (rotates) | CLEARED at gateway; per-model availability flag rotates by upstream worker supply |
| `ai-horde` | 1 (`google/gemma-4-31b`) | COMMUNITY_ANONYMOUS_FREE — shared worker pool, no reserved capacity |

## Live capacity facts

1. **BlockRun roster rotation**: `poolside/laguna-xs-2.1` flips `available` within minutes; `nvidia/muse-glimmer-30b` appeared/disappeared. Coding capacity is *intermittent*, not guaranteed.
2. **BlockRun model substitution**: two qualification attempts returned served-model identity different from requested (`MODEL_IDENTITY / MODEL_SUBSTITUTED`). Exact-model admission must therefore verify served identity per call — a QUALIFIED compact receipt alone is insufficient.
3. **BlockRun anonymous quota is small**: ~9 qualification requests exhausted `nvidia/llama-3.2-11b-vision` (`USER_QUOTA_EXHAUSTED`, `next_available` ~30-90s rolling window — it recovers).
4. **Kilo shared source-IP domain**: all kilo-free-direct models share one `kilo:source-ip` quota domain — logical model diversity ≠ independent capacity.
5. **AI Horde**: `gemma-4-31b` reachable; community pool, unbounded queue latency possible — not measured this session.

## Production-eligibility gap found (post-R84)

Bundled role evidence qualifies REVIEWER only on `kilo-free-direct/nvidia/nemotron-3-ultra-550b-a55b` and PLANNER on `kilo-free-direct/nvidia/nemotron-3-super-120b-a12b` + `blockrun-free-direct/nvidia/llama-3.2-11b-vision`.

The R84 terms gate (`provider-definitions.ts:838`) classifies every `nvidia/*` route DEVELOPMENT_ONLY → admission fails at `TERMS_ALLOWED`. Consequence verified live in the R85 concurrent campaign (receipt `R85-CONCURRENT-CAMPAIGN-1791757743077.json`):

- project-a (`03-refactor`): completed coding turns, then `REVIEWER_FAILED — no eligible free route` → `blocked` (correct fail-closed; no paid fallback).
- project-b (`04-test-creation`): `PLANNER — no eligible free route` (vision planner quota-exhausted at that moment) → `blocked`.

R84's two completed fixtures used `nvidia/nemotron-3-ultra` for the reviewer turn (inference frames prove it) — that path closed the moment the R84 terms gate landed. **No production-eligible qualified REVIEWER route exists in bundled evidence.** This is the dominant supply gap for autonomous completion.

## Closure path pursued in R85

Qualify `poolside/laguna-s-2.1:free` (Kilo, CLEARED, code-specialized) through the full role-aware suite — a CLEARED REVIEWER+PLANNER qualification restores production routing without touching NVIDIA trial routes or the opaque auto router. Fallback candidates: `dots-studio/dots-3-note-preview` (structured output), `thinkingmachines/inkling-small` (1M ctx), `nvidia/muse-glimmer-30b` (BlockRun coding+reasoning, when available and non-substituting).

## Second independent Free Coder domain

`blockrun-free-direct/poolside/laguna-xs-2.1` compact-qualified (CODER/TOOL_AGENT/ANALYST QUALIFIED, receipt `qualify-blockrun-free-direct-poolside_laguna-xs-2.1-1791757189334.json`, 9 requests). However the same route later produced MODEL_SUBSTITUTED transients and availability rotation — a second independent domain is *demonstrated intermittently*, not yet *reliable*. Honest classification pending the watcher's conclusive window.
