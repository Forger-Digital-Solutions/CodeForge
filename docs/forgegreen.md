# ForgeGreen runtime efficiency

ForgeGreen reduces measurable computational work upstream of CodeForge’s canonical authorities. It does not weaken verification, permissions, approvals, security, or completion standards.

## Boundary

The directional flow is:

`repository facts → Repository Intelligence → ForgeGreen analysis → efficiency recommendations → canonical authorities → execution / verification / approval / completion`

ForgeGreen never returns a permission, approval, verification authority, execution authority, or completion verdict. Its verification output is explicitly `VerificationRecommendation` and its completeness is `candidate-only`, `bounded`, or `unknown`; an empty candidate set is never proof of no impact.

## Runtime integration

`AgentRuntime` shares a bounded `ForgeGreenAdvisor` with `ContextAssembler` and `ModelExecutionAdapter`.

- Context keys include workspace identity, repository generation, task identity, role, retrieval-policy version, context budget, feature version, and authority state.
- Context reuse is rejected when any identity component changes. Repository generation is obtained after Repository Intelligence refresh.
- Immutable context fragments are keyed by content hash. No private conversation, credentials, approvals, mutable sibling worktree state, or secret-bearing payload is stored in this cache.
- Stable system/tool prefixes are observed through a provider-neutral interface. Provider token accounting is reported as `unavailable` when the provider does not expose it; ForgeGreen never invents cache reads or writes.
- Duplicate model requests are fingerprinted with provider/model, messages, tools, request parameters, user identity, and authority state. Failures are not cached, and cancellation interrupts a deduplicated wait.
- Verification recommendations are emitted alongside verification telemetry, but the existing canonical verifier and `evaluateCompletion` gate always execute and decide.

## FG-1 efficiency core

FG-1 adds five mechanisms between context assembly and the canonical authorities. Each one only reduces work; none can grant a permission, resolve an approval, waive verification, or contribute to a completion decision.

### FG-1A — provider prompt/prefix caching

Providers describe their own caching through an optional `getPromptCacheCapability(modelId)` returning a `PromptCacheCapability` (`unsupported` | `automatic` | `explicit`, telemetry availability, minimum cacheable size, constraints). Missing adapter support, malformed metadata, or a throwing resolver degrade to `unsupported`: the request is invoked exactly as before and no savings are claimed.

- Anthropic (`explicit`): `cache_control` breakpoints are placed on the stable system block and the final tool definition only; message ordering, content, model selection, and steering revisions are untouched. Unknown model families report `unsupported` and keep the exact legacy request shape. `cache_read_input_tokens` / `cache_creation_input_tokens` are parsed from non-streaming usage and from `message_start` in streaming.
- OpenAI-compatible (`automatic`): no request shaping ever. `prompt_tokens_details.cached_tokens` is counted only when the provider reports it.
- `ModelExecutionAdapter` surfaces `optimization.providerPromptCache` with classification `measured` (provider reported tokens) or `unavailable`, and populates `AgentUsage.cachedTokens` / `cacheWriteTokens` from provider telemetry only.

### FG-1B — tool-output compression

`compressToolOutput` (in `@codeforge/tools`) is a deterministic structural transform: consecutive-repeat folding, global-repeat folding with explicit counts, failure-neighborhood retention, and a hard byte bound with marked omissions. Failure/error lines are always retained; head lines (command identity, exit code) are always retained; identical inputs always produce identical representations.

The authoritative post-redaction output stays on the `ToolExecutionRecord` (and in the emitted event stream) untouched. Only the model-context representation — the tool message pushed into the conversation — is bounded, and it carries a provenance header with the original size, the representation size, the artifact reference, and a content digest. Compression never un-redacts; it runs strictly after the existing redaction pipeline. ForgeVerify and the Completion Gate never read the compressed representation.

### FG-1C — duplicate / no-progress suppression

One `DuplicateActionSupervisor` per run (autonomous) or per turn (interactive) detects repeated work without blocking legitimate reruns:

- Identity is `tool + canonical parsed arguments + workstream scope + policy version` — never raw command text, so reformatted arguments still collide and distinct arguments never do.
- A state version advances on every mutating action (write/edit/command), on steer consumption at a safe boundary, and on execution-revision change. Any state change makes every rerun legitimate; post-steer work is never duplicate work (CF-17 semantics preserved).
- Read-only actions against unchanged state: first occurrence executes; second occurrence is suppressed by replaying the prior authoritative result with provenance; a third attempt escalates and the run terminates as blocked. Failed actions get exactly one retry against unchanged state, then escalate.
- Escalation preserves the certified CF-07 loop contract: when the escalating history matches a certified text-loop shape (3 identical consecutive calls or an X-Y-X-Y-X alternation), the run surfaces `AGENT_TOOL_LOOP_DETECTED`/`tool_loop_detected` exactly as CF-07 certified; novel no-progress shapes surface `AGENT_NO_PROGRESS_DETECTED`/`no_progress_detected`. Both terminate as blocked, never as success.
- Mutating actions are never suppressed. A fresh run or a recovered turn always starts with an empty supervisor (recovery is never blind-suppressed), and parallel workstream identities never cross scopes.
- The certified CF-07 text-loop detector (three consecutive identical fingerprints, A-B oscillation) is unchanged and still runs first.

### FG-1D — canonical content-addressable cache

`canonicalCacheKey` (in `@codeforge/forge-green`) builds a content-first, versioned identity: security namespace, analysis type, canonical parameters, sorted content hashes, scope digest, parser version, policy version, model, runtime config digest, and repository generation. Filenames, mtimes, commit SHAs, prompt text, and model names alone are never keys.

`ForgeGreenCacheStore` (in `@codeforge/sessions`) persists entries with the established SQLite driver-selection architecture, beside the application session database — never inside a user repository or `.git`. Entries are namespace-scoped (one workspace can never observe another's cache), bounded (LRU entry cap, per-entry byte cap), and rejected when they contain secret-shaped content. A missing, corrupt, or cold cache is a cache miss and the analysis recomputes.

Currently cached: repository-intelligence tool analyses in `executeRepositoryTool`. FG-2 refines the scope digest: graph-scoped queries (dependencies, dependents, tests, impact, symbols, callers, callees) key on the **graph revision**, which advances only when symbol/edge/call records actually changed — a comments-only edit does not invalidate them. Content-sensitive lexical/corpus queries (search, references, context) key on the index generation, so any content refresh invalidates them conservatively. File-local analyses (`repo_file_summary`) key on the target file's content hash plus parser/index version, so an unrelated edit elsewhere provably cannot invalidate them. Repository Intelligence maintains two revisions: `generation` (indexed content) and `graphGeneration` (structural intelligence), each advancing only when its subject actually changed.

### FG-1E — ForgeGreen efficiency ledger

Every autonomous run emits a durable observational ledger record (`forgegreen_ledger` work item, exactly-once via `insertIfAbsent` on both SQLite and PostgreSQL). Events carry a mechanism (`provider_prompt_cache`, `tool_output_compression`, `duplicate_suppression`, `no_progress_interruption`, `canonical_analysis_cache`, `request_dedupe`, `context_reuse`, `fallback`, `repository_intelligence`), an accuracy classification (`measured` | `estimated` | `unknown`), a quantity with unit, and a short reason code — never content, secrets, prompts, reasoning, or raw output. Totals cover bytes avoided, tokens avoided (measured vs unknown-count), duplicate actions suppressed, no-progress interruptions, canonical cache hits/misses/invalidations, avoided model requests and tool dispatches, fallback-to-full-work events, and FG-2 repository metrics (files reparsed, files reused without reparsing, parse-cache hits, dependent re-resolutions). Per-run `EfficiencyReceipt`s mirror the counters. The ledger is correlated with session, run, agent, execution revision, workstream scope, operation, and namespace. It is not an input to any permission, verification, or completion authority.

## FG-2 — persistent repository intelligence

FG-2 makes Repository Intelligence a trustworthy, content-addressable, incrementally maintained structural layer. Everything it produces is advisory: provenance-rich facts, candidates, and uncertainty for later ForgeGreen phases (FG-3 context planning, FG-4 blast-radius authority, FG-5 verification policy). It never decides whether a change is sufficiently verified, and no path leads from an analysis result to a permission, approval, verification satisfaction, or completion decision.

### What FG-2 added

- **Edge provenance taxonomy.** Every graph edge carries `provenance`: `static-direct` (declared in a manifest), `import-resolved` (static or literal dynamic import resolved to a workspace file), `syntax-resolved` (same-file or enclosing-class definition), `heuristic` (test filename convention), `runtime-observed` (scoped runtime evidence), `unresolved` (relationship text exists but no target resolved). `type-resolved` and `framework-inferred` are reserved slots no analyzer currently emits — a heuristic relationship can never masquerade as a resolved one.
- **Call intelligence with preserved ambiguity.** The parser records per-file call sites (identifier calls, member calls, dynamic `import()`, non-literal `require`, computed calls, `eval`). Resolution happens against the current symbol/import tables at query time: `getCallGraph(path)` reports callees with all candidate targets, and `findCallers(name)` reports candidate callers. Multiple candidates are returned with `ambiguous: true` — ambiguity is never silently collapsed. Barrel re-exports are followed (one bounded hop, cycle-safe) in both resolution and caller discovery. `findDefinitions(name)` exposes every exact-name match.
- **Explicit completeness.** `getCompleteness()`, `getCallGraph`, `findCallers`, `getImpactCandidates`, and `estimateBlastRadius` carry a branded `AnalysisCompleteness`: `COMPLETE` (fully parsed scope, no unresolved calls, no ambiguity, no dynamic constructs), `PARTIAL` (with structural reason codes such as `dynamic_constructs:N`, `unresolved_relative_imports:N`, `parse_error_files:N`, `fallback_parse_files:N`, `ambiguous_symbol_name`, `traversal_truncated`), or `UNKNOWN` (index unusable or file not parseable). There are no fabricated percentages; repository prose can never raise completeness or remove uncertainty.
- **Two revisions.** `generation` advances only when indexed content changes; `graphGeneration` advances only when symbol/edge/call records actually change. A comments-only edit invalidates content-scoped cached analyses but provably leaves graph-scoped ones valid.
- **Content identity first.** A HEAD move never discards content-identical intelligence: files are re-hashed after a HEAD change but reused when their content hash is unchanged. Dirty working-tree content is distinguished by content hash at the same HEAD. Cross-worktree reuse of identical bytes is keyed by a repository-level namespace (the Git common directory), never by worktree identity, so it works across worktrees of one repository and never across repositories (or any other security-namespace boundary). Cached parse results re-resolve their relative imports against the current workspace's file set, so identical content can never restore a target that does not exist locally.
- **Dependent re-resolution.** Deleting or renaming a dependency re-resolves its direct dependents (bounded, reported as `invalidatedDependents` in the refresh result): resolved edges to the deleted target become honestly `unresolved` edges instead of silently vanishing, and no stale resolved edge survives.
- **Runtime-observation boundary.** `recordRuntimeObservation` stores advisory runtime evidence with mandatory run identity (`runId`, observer, revision, timestamp, evidence hash) and fixed `runtime-observed` provenance. `listRuntimeObservations({ sameRunAs })` explicitly distinguishes same-run observation from independent evidence. Runtime observations never raise completeness, never suppress invalidation, and are never read by the completeness computation. No production producer exists yet (FG-5 will introduce them); the data model already makes self-grading inexpressible.
- **Honest parser status.** Languages with no structural adapter (python, rust, go, …) are labeled `fallback`, never `parsed`, and counted as structural uncertainty. Parse failures mark the index `DEGRADED` and the affected analyses `UNKNOWN`/`PARTIAL`.
- **Registry consistency.** `repo_impact` and `repo_file_summary` are now registered in the trusted tool registry (they were advertised to the model but rejected as unknown at dispatch), and new read-only `repo_callees` / `repo_callers` tools expose call intelligence. All repository tools remain read-only, bounded, and namespace-aware.

### What FG-2 deliberately did not do

No context planner, progressive context resolution, or context budgets (FG-3). No blast-radius authority, risk gates, or model routing (FG-4). No verification policy, acceptance eligibility, or coverage authority (FG-5/FG-6). The interfaces above are the clean seams those phases consume; none of them carries authority today.

## FG-3 — pull-based progressive context

FG-3 evolves the existing `@codeforge/context` assembler from "one broad flat pack per role" into a narrow-by-default, pull-based progressive pipeline: an authoritative runtime **Context Kernel** (L0) plus a small targeted repository slice, expanded only when the task or evidence requires it. It reuses everything CodeForge already knows — FG-1's canonical cache, FG-2's structural intelligence and provenance, 8-Bit's handoff and routing — and adds no second context engine, cache, or repository graph. Context remains information delivery only: no FG-3 artifact carries permission, verification, or completion authority.

### Architecture audit finding (which path was actually eager)

The interactive **lead-agent** loop was already structurally lean and pull-based (a small system prompt plus read-only `repo_*` tools the model calls on demand), so FG-3 deliberately did **not** rewrite it. The genuine eager-context path was the **subagent** dispatch: `executeAgentRun → ContextAssembler → buildContextPack`, which eagerly retrieved up to ~100 repository candidates and filled ~80% of the repository budget before the model ran. FG-3 remediates exactly that path. This finding is recorded so future work does not "optimize" the already-lean lead loop again: the broad pack is still available verbatim, but now only as the explicit, model-initiated `repo_context` pull tool, never as an eager pre-dispatch grab.

### Context Kernel (L0, authoritative projection)

`buildContextKernel` (`packages/context/src/kernel.ts`) builds the minimum runtime truth a model — or a replacement model after 8-Bit failover — needs to continue safely: objective, constraints, changed files, already-completed actions (commands / file changes / tool calls), and approval / question / steer / verification state. It is sourced **entirely from persisted `WorkItem`s** (the same durable records `EightBitHandoffBuilder`, `UserIntentHoldController`, and ForgeVerify treat as authoritative), never guessed from conversation prose, and is itself only a reconstructable projection — CodeForge runtime persistence remains the source of truth. A budget may compact or omit optional repository context but may **never** drop a kernel field: when even the kernel cannot fit, `planNarrow` / `ContextAssembler` fail closed with an explicit `ContextCapacityError` (`CONTEXT_CAPACITY_UNKNOWN`) rather than silently truncating. `createMinimalContextKernel` provides an honestly-empty kernel (every runtime field false/empty, never fabricated) for callers with no persistence.

### Progressive levels (breadth only, never authority)

`ContextLevel` L0–L7 (`levels.ts`) is a branded type expressing information **breadth only** — L0 runtime kernel, L1 active targets, L2 structural neighbors, L3 one-hop dependencies, L4 targeted source bodies, L5 package/module, L6 broader search, L7 exceptional expansion. It is deliberately distinct from FG-2's `AnalysisCompleteness` and from any trust/permission/verification signal: a higher level means more was shown to the model, never that more was verified, authorized, or approved. Today the coder role's repository context is planned at L0→L1→L2; the broad L6/L7 grab remains available only as the explicit `repo_context` pull.

### Context Pages (bounded, content-addressed, FG-1-cached)

A Context Page (`pages.ts`) is a bounded, provenance-rich, structural (never LLM-summarized) repository unit: `file` pages and one-hop `dependency_neighborhood` pages (direct dependencies, dependents, and candidate related tests, capped at `ONE_HOP_MAX_EDGES` each). Pages are stored in `ContextPageStore`, a thin typed envelope over FG-1's existing `ForgeGreenCacheStore` — **no second cache layer**. A page's identity **is** an FG-1D `CanonicalCacheIdentity`, so it inherits namespace isolation, content-hash-first invalidation, and graph-generation scoping. File-local pages key on the file's content hash (an unrelated edit elsewhere provably cannot invalidate them); graph-scoped neighborhood pages key on `graphGeneration` (a comments-only edit does not invalidate them, a signature/import change does). Get/put never throw: a missing, corrupt, or schema-mismatched entry is a safe miss that recomputes — never a crash and never a trusted corrupt value.

### Pull-based retrieval and one-hop prefetch

`ContextPlanner.planNarrow` always emits the L0 kernel, adds a small bounded L1 active-target slice (`NARROW_CANDIDATE_LIMIT`), then a bounded one-hop L2 structural prefetch for at most `MAX_PREFETCH_TARGETS` of the selected files. Expansion beyond that is explicit and model-driven through the existing read-only `repo_*` tools (`repo_dependencies`, `repo_dependents`, `repo_tests`, `repo_file_summary`, `repo_callers`, `repo_callees`, `repo_context`) — never an unrestricted repository dump. `expandOneHop` is loop-safe: re-pulling the same page within one planner (one turn) is suppressed, while a fresh planner (a new turn, or a legitimate state change) may pull it again, integrating with CF-07/FG-1 no-progress semantics.

### Model-aware budget (8-Bit picks the model, FG-3 fits it)

`resolveContextCapacity` (`budget.ts`) replaces the pre-FG-3 hardcoded ~64K assumption with the routed model's catalog-declared `contextWindow` (`FreeModelRecord.contextWindow`) when the caller supplies one. It never selects, swaps, or pins a model — that remains 8-Bit's job. Unknown capacity falls back to the existing safe role default (never fabricated); a smaller real capacity clamps the budget down (compacting what is sent, never silently swapping models, so an exact pin that cannot fit surfaces a capacity problem rather than triggering replacement); a larger capacity never by itself causes gratuitous expansion. Optional repository content is dropped before mandatory kernel state. `agent-runtime.ts` wires the routed model's `contextWindow` into both the assembler budget and the 8-Bit failover ranking estimate.

### FG-2 provenance and completeness preserved

Pages carry FG-2 `EdgeProvenance` and `AnalysisCompleteness`. PARTIAL/UNKNOWN completeness and heuristic/unresolved edges are preserved verbatim and surfaced in the rendered neighborhood ("bounded one-hop view … some edges heuristic/unresolved/omitted") — never upgraded to certainty, never collapsed. Few retrieved edges are never treated as "nothing else exists," and repository prose can never raise completeness.

### 8-Bit handoff integration

`EightBitHandoffBuilder` now **delegates** to `buildContextKernel`, so the handoff and every other FG-3 consumer of runtime truth share one WorkItem reader instead of two independently-maintained ones. The handoff carries the full kernel (steer state, verification status/plan id, constraints, workstream/revision identity) plus optional reusable `HandoffContextPageRef`s for the turn's changed files, rendered as pull handles ("pull details with repo_dependencies/…") rather than inlined page content or blind transcript replay. A consumed steer is presented as "do not re-apply"; an unconsumed one as "queued and not yet applied"; recorded verification status is surfaced without ever claiming completion. Page-build failure is advisory and can never fail the handoff.

### Receipts, ledger, and authority boundaries

The planner emits a `ProgressiveContextReceipt` (level, capacity source, pages reused/pulled, omitted optional pages, reason codes, estimated-token classification, truncated flag) correlated with session/run/agent/workstream/revision. Context Page reuse is recorded on the **existing** ForgeGreen ledger (`recordContextPagesReused` / `recordContextPagesPulled`, `measured` counts — no second telemetry store, no carbon claim). FG-3 has **no path** to satisfy the Completion Gate: `evaluateCompletion` accepts no kernel/plan/receipt/level input, an excellent context plan is never verification or completion, and `CONTEXT_CAPACITY_UNKNOWN` is a context-delivery problem, never a completion blocker code. Prompt-injection fixtures prove repository prose cannot alter planner level, budget, routing, completeness, verification, or completion. FG-4 adds structural risk advice below; FG-5 (verification sufficiency policy) remains deliberately separate and unimplemented.

## FG-4 structural blast-radius advice

`analyzeStructuralRisk` in `@codeforge/forge-green` consumes the existing Repository Intelligence graph and returns deterministic, inspectable advice. It preserves changed targets, direct and transitive dependents, callers, callees, candidate tests, package ownership, public interfaces, dynamic constructs, unresolved relationships, edge provenance, and the underlying `COMPLETE`/`PARTIAL`/`UNKNOWN` analysis state. It never reads repository prose as policy and never stores raw source in a receipt.

Risk is classified as `LOCAL`, `LIMITED`, `CROSS_MODULE`, `CROSS_PACKAGE`, `SYSTEMIC`, or `UNKNOWN`; analyzability is separately `HIGH`, `MODERATE`, `LOW`, or `UNKNOWN`. Unknown, failed, ambiguous, dynamic, generated, migration, configuration, and dependency boundaries broaden advice rather than becoming zero impact. Change identity includes security namespace, worktree/repository identity, content hashes, content/graph generations, analyzer version, and policy version. Graph-scoped cache reuse can therefore survive a comment-only edit while the returned dirty-change identity still changes; structural edits advance the graph identity and invalidate the old result.

The advisor recommends a minimum FG-3 context breadth and a capability class (`FAST_WORKER`, `CODER`, `REASONER`, or `PLANNER`) but does not choose a provider, model, price class, permission, approval, verification requirement, or completion state. The context planner may consume the recommendation through its optional minimum level and remains responsible for capacity and page delivery. 8-Bit may consume the capability as an advisory minimum role, then independently applies ForgeZero eligibility, health, reliability, exact-pin, and route-ranking policy.

`repo_impact` retains its legacy candidate fields and includes the FG-4 result for clients that want richer structural advice. The existing canonical ForgeGreen cache remains the persistence substrate for this tool path, while the risk result's compact receipt records counts, reason codes, graph identity, cache state, and capability/context recommendations. Risk telemetry is observational only and is recorded through the existing ForgeGreen ledger; it cannot reset no-progress protection or satisfy ForgeVerify/Completion Gate.

## Failure and disable behavior

Missing, stale, corrupt, ambiguous, timed-out, or unavailable efficiency analysis uses the existing safe path and records `safe_fallback` or `analysis_unavailable`. `CODEFORGE_FORGREEN=0` disables the optimization layer and returns canonical behavior. Optimization exceptions are not allowed to become permission or completion decisions.

## Evidence

`EfficiencyReceipt` records bounded, inspectable work quantities: context requested/delivered tokens, tokens avoided, cache hits, duplicate requests avoided, fallback use, reason codes, repository generation, and policy version. It does not expose a universal green score and makes no carbon, energy, or emissions claim.

Blast-radius false-negative auditing and acceptance-level sufficiency auditing remain separate concerns. A prior pass, cache hit, retrieval score, impact estimate, or flaky classification cannot certify current verification or completion.

## CF-17 UserIntentHold

The interactive-work-avoidance path is a scheduling optimization layered below trusted execution: `composer transition → server hold acknowledgement → dispatch barrier → existing AgentRuntime / ForgeVerify authorities`.

The composer sends only a bounded `request` or `release` transition. Unsubmitted draft text is never included in the hold request, persisted hold record, SSE event, run projection, or ForgeGreen receipt. Submitted steers remain ordinary durable user messages and are queued in order with an idempotency identity.

`UserIntentHoldController` persists a run/session checkpoint, hold generation, state, and submitted steer queue. Generation-checked releases prevent a late client from releasing a newer hold. The barrier waits only at future model, tool, subagent, verifier, delivery, or publication dispatch boundaries; already-started processes and transactions are not aborted. Existing permission, cancellation, ForgeVerify, Completion Gate, delivery, and publication authorities remain unchanged.

The default desktop policy is `Expensive actions only`; `Always` and `Off` are stored through the existing desktop settings modal. The local composer uses one centralized 1.5-second quiet-grace policy and sends no per-keystroke network events. A stale hold lease is recoverable, while queued submitted steers remain durable until reconciliation.

When a turn becomes terminal, its queued steers are cleared and any waiting scheduling boundary is released. A terminal release is an audit event, not reconciliation or a resumption path; terminal state remains authoritative.

An approval or question wait remains an active turn for submitted-steer routing. Steering may be queued while the approval remains authoritative; it cannot resolve, bypass, or replay the approval.

At the post-approval execution boundary, the runtime admits an already-arrived steer before a synchronous guarded action can terminalize the turn. This is only scheduling: the approval decision still controls the action, and the steer neither grants approval nor waives verification. Public steer identities are preserved end-to-end so duplicate delivery is deduplicated by the durable queue rather than by incidental turn identity.

## Restart recovery

After an interruption, ForgeGreen preserves durable user intent and observed evidence but discards the stale computational continuation. `AgentRuntime` hydrates nonterminal turns into an explicit recovery hold, classifies durable execution records, and requires a new plan based on current workspace facts. It never recreates an interrupted child process, provider stream, tool callback, or model continuation. An ambiguous command remains ambiguous rather than being replayed.

Accepted steers remain ordered durable intent across restart and are reconciled exactly once at the new plan's safe model boundary. A restored pending approval remains an approval boundary; its later resolution authorizes recovery replanning only, never the old operation. Terminal cleanup and parallel scope boundaries remain authoritative. This avoids waste by stopping stale work, but it never treats avoided work as verification: ForgeVerify and Completion Gate continue to decide whether the new reality is sufficient.

## Steer revisions and scoped parallel steering

A material steer consumed at a safe boundary supersedes the authoritative execution revision instead of silently continuing the old one. In the workflow path the engine bumps the plan revision at its post-verification boundary and ForgeVerify issues a fresh verification plan bound to that revision; evidence produced for a previous revision can never authorize completion of the current one, so the run re-verifies rather than reusing stale authority. Steer text carries no authority over verification: it can only demand fresh verification, never skip or weaken it.

In the parallel path a steer may target one workstream explicitly (`targetWorkstreamId`). The scope binding is durable — it survives API retry, persistence, restart, and hydration — and only the targeted workstream holds, replans, and consumes the steer; sibling workstreams' dispatches, plans, and verification are untouched. Invalid or terminal targets are rejected rather than silently widened to a run-wide steer.

Durable runtime state (sessions, turns, holds, steer receipts, verification records) lives behind one driver-neutral async persistence contract with SQLite and PostgreSQL implementations, so the same efficiency semantics hold on both backends and across process restarts.

Interactive receipts expose only deterministic measurements: hold count/duration and dispatches actually blocked at an eligible boundary. No duration-only savings and no energy/carbon conversion are claimed.

## FG-5 — verification policy authority

FG-5 is the deterministic verification-policy layer between structural advice and execution. FG-2 provides structural facts and completeness; FG-4 provides risk/analyzability advice; FG-5 derives explicit V0–V5 obligations and evaluates evidence; ForgeVerify executes trusted checks; Completion Gate remains the final completion authority.

V0 is limited to provably documentation-only changes. V1/V2 cover local and targeted evidence, V3 package verification, V4 cross-package integration, and V5 systemic or release-grade work. Obligations are typed, scoped, reason-coded, and identity-bound; the policy never uses model confidence, repository prose, or opaque scores as authority.

Evidence decisions bind policy version, revision, workspace content identity, verifier selection, command/configuration, namespace, and relevant environment. Structured execution status and exit code are authoritative: failures, skips, partial runs, timeouts, interruptions, blocked infrastructure, and missing obligations cannot become passes. Immutable ForgeVerify evidence and policy receipts are persisted through the existing SQLite/PostgreSQL work-item contract with idempotent duplicate handling.

Completion Gate independently rejects stale policy decisions and continues to block pending approval, user questions, review findings, unfinished work, and other lifecycle conditions after verification is sufficient. FG-5 never grants permissions, selects models, changes exact pins, publishes, or completes a task by itself. See `docs/fg5-certification-report.md` for the certification boundary and evidence.

## FG-6 — gate-specific evidence resolution & minimum valid verification plans

FG-6 is the deterministic evidence-resolution layer between FG-5 verification obligations and ForgeVerify execution.

```text
FG-5 (Obligations Authority)
  ↓ [hard typed obligations]
FG-6 (Evidence Resolution Authority)
  ↓ [deduplicated, minimal valid verification plan]
ForgeVerify (Execution Authority)
  ↓ [structured execution evidence]
FG-5 (Sufficiency Authority)
  ↓ [evidence evaluation receipt]
Completion Gate (Completion Authority)
```

### Governing Principle
> Resolve hard verification obligations into the minimum valid evidence plan without weakening any obligation.

### Core Mechanisms
- **Canonical Obligation Identity & Exact Deduplication:** Equivalent obligations canonicalize to stable identity keys. Duplicate obligations are deduplicated into a single execution while preserving all gate and reason provenance codes across all source obligations.
- **Structured Subsumption:** Proves evidence subsumption strictly from trusted project configuration (e.g., tsconfig project references, package.json workspaces, verified test suites). Broad workspace typechecks subsume package-level typechecks only when referenced in root tsconfig. Package test suites subsume targeted test obligations only when targeted test paths are verifiably contained in the package test directory.
- **Strict Prohibition of Prose-Based Subsumption:** Repository comments, README prose, script names (`test:all`), or malicious command stdout cannot define or infer subsumption.
- **Environment-Sensitive & Evidence-Class Preservation:** Simulated/mock tests cannot substitute for `REAL_POSTGRESQL`, `REAL_GIT`, or `REAL_CHILD_PROCESS` requirements. If an environment dependency is unavailable, the obligation is marked `BLOCKED`, never silently downgraded.
- **Valid Evidence Reuse First:** Existing valid evidence matching the current content hash, execution revision, and policy version is reused with 0 execution cost, avoiding redundant reruns. Stale, failed, skipped, or timed-out evidence is rejected.
- **Durable Resolution Receipts:** Persists immutable `resolution_receipt` records idempotently across process restart with resolution ID, input/deduplicated/subsumed/reused counts, scheduled producers, and dispatches avoided metrics.
- **ForgeGreen Ledger Integration:** Tracks measured obligations received, duplicates removed, subsumed obligations, evidence reused, scheduled producers, dispatches avoided, and cache hits/misses without carbon or duration claims.
- **Authority Boundary:** FG-6 `RESOLVED` indicates a complete and valid execution plan exists; it is NOT verification `PASS` and cannot satisfy the Completion Gate. FG-7 Verification Coverage Authority remains next. See `docs/fg6-certification-report.md` for full certification evidence.
