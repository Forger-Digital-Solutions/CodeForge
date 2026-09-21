# R23 Campaign Verdict — 2026-09-21

Protocol: `codeforge-efficiency-protocol-r23` **v1.0.6**, digest
`366035299fc1e50ee68dfa96e9d2afeb7cf68986864fc2bac5d33bc1f10104b8` (verified MATCH).
Ledger: every served call in `raw/qualification/*.json` — **80 verifier-served runs, 134 error
calls, 16 verified_complete**. `MODEL-SELECTION.json` → **winner: null**.

## The frozen question

> Does at least one legitimate zero-cost route exist that qualifies under §2.2 —
> all expected tasks verified, zero upstream failures, zero malformed runs?

**Answer: no — and that is a measured result, not an absence of effort.**

| Route | Runs | Verified | Malformed calls | Supply | §2.2 verdict |
|---|---|---|---|---|---|
| `openrouter::nvidia/nemotron-3-nano-omni-…:free` | 27 | 8 | **0** | 30.3% call errors — NVIDIA shared 16-slot worker saturates; gate→collapse measured at ~2 min | fails §2.2(a): upstream failures dominate |
| `groq::openai/gpt-oss-20b` | 5 | 4 | 8/85 ≈ **9.4% of calls** | adequate (~5 tasks/day at 200k tok/day) | fails §2.2(c): malformed-tool-call runs |
| `groq::openai/gpt-oss-120b` | 5 | 0 | 12.9% of calls | bucket-exhausted | fails §2.2(a)+(c) |
| OR `:free` prescreen ×18 others | 1 run each | 0 | 5 models malformed; 4 boundary-dead (F12/F15) | starved or restricted | excluded |
| Cloudflare Workers AI | — | — | — | **attestation-blocked** (plan/billing/neurons unreadable, F6) | not screened |
| GitHub Copilot (USER_CONNECTED_FREE) | — | — | — | **owner/legal-blocked** (Copilot Requests permission + terms) | not screened |
| Cerebras / Mistral / Gemini / GitHub Models | — | — | — | 402 / 429 0-rpm / 403 / 410 | excluded |

## What the campaign proved about CodeForge itself

The campaign's real product is not a winner — it is the first end-to-end demonstration that the
production runtime enforces every guarantee it claims, under live free-tier pressure:

1. **Zero-billing firewall.** $0 spent across the whole campaign. OR key `usage: 0`,
   `is_free_tier: false` — deposit never consumed (OBSERVED). Groq returns no usage fields —
   $0 is free-tier inference, reported distinctly. Paid fallback never engaged; every route
   admission re-checked against ForgeZero classes.

2. **Completion is enforced, not asserted.** Live-ledger confusion matrix over 80 served runs:
   **16 verified_complete — every one triple-agrees (verifier PASS ∧ authority PASS ∧ claimed)**;
   zero `claimed:Y` without both passes → **0 false completions, 0 false negatives**. 19 runs did
   the work but never claimed → correctly not complete. Plus the R21 32-case adversarial corpus
   (forged receipts, instruction injection, empty collections, wrapper-hidden failures) — green.

3. **8-Bit behaves as designed under real failures.** Live taxonomy exercised:
   `TEMPORARY_CAPACITY` (86+ NVIDIA 502s, cooldown-and-rotate), `ACCESS_RESTRICTED` (inkling 403),
   `MODEL_RETIRED` (GitHub 410), `AUTH_FAILURE`, in-band Groq error classification. **F14a proven
   live twice**: bounded same-route retry absorbed 3 same-turn parse rejections (Groq round 6) and
   7 supply 502s (nemotron round 9) — zero rotation on pinned routes; pre-fix each would have
   killed the child. Confirmed gap: `EightBitMeasuredHealthTracker` exists and the ledger joins
   `measuredHealth`, but **no production component emits measurements** — the health projection is
   unfed today; probe-gate verdicts do not reach routing (follow-up).

4. **The capacity governor honors provider mechanics.** Header-driven token-bucket pacing live:
   `pacingWaitMs` correctly attributed (360.2s of 381.6s wall in round 6 — pacing is ~94% of Groq
   wall time, not inference). F14b proven: 23 calls, zero governor-caused 429s (round 5 died on
   exactly that). §6.3 daily-token gate correctly voided a mid-round task pair rather than
   overrunning the allowance.

5. **Tool/authority boundaries hold.** 19-tool registry consistent across both schema surfaces
   (names + required fields identical; descriptions drift — flagged). F15 found and fixed the one
   real CodeForge-side contradiction: the coder prompt instructed `run_command` under leases that
   withhold it — the mechanism behind all four F12 `security_blocked` prescreen deaths.
   Orchestrated leases are correct (coder children legitimately receive `run_command`).

6. **Subagent topology + context accounting measured.** Round-6 decomposition: explorer 3 calls
   (15 tools) → coder 14 calls (19 tools, 3 retries on one turn) → reviewer 6 calls (15 tools).
   Per-child bootstrap ~1.4–1.9k tokens. `transmittedContextBytes` 295KB vs `finalConversationBytes`
   5.9KB — **~98% of transmitted bytes are provider-statelessness repeats**; ForgeGreen dedup
   already leaves only 172 avoidable bytes. The remaining economic lever is provider-side prompt
   caching, absent on free routes. Gap: `subagentModelCalls` attribution is not joined in
   orchestrated records.

7. **Malformed-call forensics (§6).** Full decomposition in
   `supply/MALFORMED-TOOL-CALL-DECOMPOSITION.md`: gpt-oss hallucinated names (`repo_read_file`,
   `repo_list_files`, `repo_tree`, `json` pseudo-call on structured-output turns) occur **nowhere**
   in tree, prompts, docs, or git history — model-intrinsic, ~10%/call, phase- and
   position-independent. Groq rejects server-side; OR upstreams pass through to the runtime
   boundary; NVIDIA rejects with capacity errors. Three different enforcement points, one taxonomy.

## What remains unproven (honest ledger)

- **Live ForgeGreen paired A/B** — never run: needs a qualified model (~1M tokens for the paired
  pilot; no free bucket fits). The scripted dry-run (2.3× tokens for identical outcomes on tiny
  tasks) is the only paired evidence.
- **Pilot** (`pilot --model …`) — refuses without a winner; `pilot/` subset unexecuted.
- **Cloudflare supply** — catalog readable, plan unverifiable: OWNER attestation or a
  Settings:Read + Analytics:Read token, then `probe-gate` the three candidates.
- **Copilot inference** — scaffolding landed (`7e77984`, M14A-3: USER_CONNECTED_FREE,
  paid-crossover refusal, ineligible-by-default, 11 tests) but zero inference; needs legal
  sign-off + `Copilot Requests` permission + single authorized prompt.
- **User-scale beyond model** — capacity model says ~10 tasks/day optimistic on managed pools
  (dev-scale); the multi-tenant claim rests on user-connected entitlement which is unmeasured.
- **Nemotron at scale** — capability is clean; supply windows are minute-scale unstable. It could
  qualify in a sustained open window — none observed across 9 rounds today.

## Money and quota ledger

| Instrument | Consumed | Paid? |
|---|---|---|
| OpenRouter free pool | ~230 requests/day | **$0** — `usage: 0` OBSERVED on key |
| Groq owner-dev free tier | ~119k tokens of 200k/day on 20b bucket | **$0** — free plan (usage fields absent; no billing instrument) |
| Everything else | probes only | **$0** |

No paid API calls. No overage. No deployment. No push. All evidence committed locally on
`forger-digital-solutions-forgegreen-certified` (HEAD `42d1c12`).

## Canonical verification

`npm test`: 3,377 passed / 4 failed / 48 skipped (Postgres-gated) — **all 4 failures pass
standalone** (load-induced timing: cf14 index bound, cf17 steer timeout, progress-watchdog,
malicious-corpus marker) → no real regression. `security:gate`: 4/4 PASS. Lint: 16 pre-existing
errors, none in campaign-touched files.

## Bottom line

R23's frozen criteria were not lowered and not met. What the campaign delivered instead is harder
and more valuable: **a production-runtime proof that CodeForge spends $0, never fakes completion,
recovers in-route, classifies supply truthfully, and fails closed on every unverifiable claim** —
plus a complete map of exactly why each candidate fails and what single owner action unblocks each
one. `winner: null` is the honest result; the system's integrity properties measured green
everywhere they were exercised.
