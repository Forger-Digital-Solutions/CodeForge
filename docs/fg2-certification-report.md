# ForgeGreen FG-2 Certification Report

Verdict: **FG2_PASS**

Date: 2026-09-06
Repository: `G:\CodeForge`, branch `feat/codeforge-cloud`
Baseline HEAD: `778fd38010bf01282f520d714296fed2b06137b6` ("implement ForgeGreen FG-1 efficiency core", FG1_PASS)

## Initial state

- Authoritative path `G:\CodeForge` verified independently (branch + commit hash + subject) before any modification.
- Inherited dirty set (concurrent UI/emoji work, preserved untouched for the entire task):
  `apps/web/src/qa.tsx`, `packages/ui/src/Conversation.tsx`, `packages/ui/src/activity-icons.tsx`, `packages/ui/src/index.ts`, `packages/ui/src/workspace.css`, `packages/ui/test/activity-icons.test.tsx`, plus untracked `docs/codeforge-8bit-activity-integration-report.md`, `docs/codeforge-emojipack-chat-integration-report.md`, `packages/ui/src/assets/`, `packages/ui/src/emoji-assets.ts`.
- Environment: Windows 11 x64, Node >= 24, npm workspaces, vitest.
- PostgreSQL: WSL2 Ubuntu PostgreSQL 16 (provisioned by `scripts/setup-local-pg.mjs`), reached from Windows tests via the WSL subnet address with the scoped `pg_hba.conf` rule; a keepalive process held WSL alive for the duration of test runs (WSL idle shutdown otherwise drops the network endpoint).

## Audit / reuse (architecture reconciliation)

Mapped every FG-2 requirement onto the certified CF-14/FG-1 baseline before writing code:

| FG-2 requirement | Already provided by CF-14/FG-1 | Genuine gap closed by FG-2 |
|---|---|---|
| Persistent AST intelligence | SQLite index, parser/schema identity in meta, per-file parser status, content-hash parse reuse | Honest `fallback` status for adapter-less languages; schema v2 identity |
| Symbol graph | Definitions, exports, imports, package ownership; cycle-safe bounded traversal | Call records + callers/callees resolution; `findDefinitions`; ambiguity preserved |
| Edge provenance | Free-form `reason` + confidence | Explicit `provenance` taxonomy on every edge |
| Content identity | Hash-first files, dirty-tree hashing | HEAD-change reuse; repo-level namespace parse cache; cached-edge re-resolution |
| Incremental invalidation | Per-file delete/reinsert | Dependent re-resolution on delete/rename; graph revision |
| Completeness | `unresolvedEdges` count, forge-green `BlastRadiusCompleteness` (unused) | Categorical `AnalysisCompleteness` on all analyses, dynamic-construct detection |
| Analysis provenance | FG-1 `canonicalCacheKey` wired into repo tools | Graph-vs-content scope digests |
| Namespace isolation | Per-workspace SQLite stores, FG-1 cache namespaces | In-process parse cache keyed by repository namespace |
| Runtime observations | none | Scoped, advisory-only data model |
| Efficiency telemetry | FG-1 ledger | `repository_intelligence` mechanism fed from refresh metrics |
| Tool surface | Read-only bounded repo tools | Registry gap fixed (`repo_impact`/`repo_file_summary` were advertised but not registered — dispatch returned `TOOL_UNKNOWN`); `repo_callees`/`repo_callers` added |

Reused, not rebuilt: the entire CF-14 engine/persistence/retrieval contract, FG-1's canonical cache + ForgeGreenCacheStore + ledger, the completion gate, ForgeVerify, and all permission/approval systems. No second graph engine, no second hash scheme, no second telemetry system was created.

## Implementation

### Persistent AST Intelligence
Schema version 2 (quarantine-and-rebuild on upgrade, certified path). Parser version `typescript-5.9+deterministic-2`. Per-file parser status is honest: full syntax parse, bounded deterministic adapter (`fallback`), `skipped` (binary/large/embedded-NUL), or `error`. Languages without an adapter (python, rust, go, …) can no longer be reported as `parsed` with zero symbols.

### Symbol Graph
New `calls` table records per-file call sites (identifier, member, dynamic import, non-literal require, computed, eval). Resolution is query-time against current symbol/import tables: same-file and enclosing-class members resolve as `syntax-resolved`; named/default imports and one-hop barrel re-exports resolve as `import-resolved`; multiple candidates are all returned with `ambiguous: true`. `getCallGraph(path)` and `findCallers(symbol)` expose callees/callers with provenance; caller discovery follows re-export chains transitively, bounded and cycle-safe. `findDefinitions(name)` returns every exact-name candidate.

### Content Identity
Content hash is authoritative over commit identity: the size/mtime shortcut is disabled after a HEAD move, but the hash-equality path is not, so an empty commit re-hashes and reparses nothing. Dirty trees are distinguished by content hash at the same HEAD (certified with real dirty worktrees). Cross-worktree parse reuse is keyed by `repositoryNamespace` (Git common directory + root markers) plus content hash — shared across worktrees of one clone, never across repositories. Cached parse results re-resolve relative imports against the current file set, eliminating a latent stale-edge hazard when identical content is reused in a workspace whose dependency set differs.

### Incremental Invalidation
Per-file reparse invalidates exactly that file's outgoing records. Deletion/renaming of a resolved dependency target now re-resolves its direct dependents in the same transaction (cap 500, reported with a truncation flag): no stale resolved edge survives and the importer's relation becomes an honest `unresolved` edge. `graphGeneration` advances only when a file's symbol/edge/call digest changes, so a comments-only edit cannot invalidate graph-scoped cached analyses.

### Dependency Relationships
File→file resolved/unresolved imports, package→package (`static-direct`), module ownership via manifests, type relation via interface/type symbols. External package imports are recorded as known-external, distinct from unresolved relative imports (which count as uncertainty). Natural-language documentation is never a dependency source.

### Test Relationships
`test_for` edges are labeled `heuristic` (filename convention); test imports of production code are labeled `import-resolved`. `findRelatedTests` surfaces both with their reason codes. Candidate test mappings remain advisory candidates; FG-2 grants no verification authority.

### Provenance
Every edge: `static-direct` | `syntax-resolved` | `import-resolved` | `type-resolved` (reserved) | `framework-inferred` (reserved) | `runtime-observed` | `heuristic` | `unresolved`. Every reusable analysis: FG-1 canonical identity (namespace, analysis, parameters, content hashes, scope digest, parser version, policy version, model, runtime config digest, repository generation), with graph- vs content-scoped scope digests.

### Completeness / Unknown State
Branded `AnalysisCompleteness` (`COMPLETE`/`PARTIAL`/`UNKNOWN` + structural reasons) on `getCompleteness()`, `getCallGraph`, `findCallers`, `getImpactCandidates`, `estimateBlastRadius`. No numeric completeness percentages are emitted. Known uncertainty sources: dynamic import, non-literal require, computed calls, eval, unresolved relative imports, ambiguous resolutions, parse failures, fallback-parsed files, skipped files, traversal truncation.

### Runtime Observation Boundary
`recordRuntimeObservation` requires full identity (source/target, relation, `runId`, observer, revision, timestamp, evidence hash) and stores fixed `runtime-observed` provenance. `listRuntimeObservations({ sameRunAs })` marks same-run vs independent rows. Completeness never reads observations; deletion invalidation proceeds regardless of them. No production producer is wired (that is FG-5); the data model already forbids the same-run self-grading loop.

### Namespace / Security Isolation
Per-workspace SQLite stores unchanged. The in-process parse cache — previously keyed by content hash alone, an observable cross-namespace existence leak in a shared process — is now keyed by repository-level security namespace plus content hash. ForgeGreenCacheStore and canonical cache namespaces unchanged (FG-1). Secret-shaped files stay out of retrievable content (certified); `ForgeGreenCacheStore` secret rejection unchanged.

## Authority proof

`evaluateCompletion` in `packages/workflow/src/completion-gate.ts` remains the only completion authority and takes plan/verification/analysis/review inputs — there is no field, parameter, or code path through which Repository Intelligence output can enter it. Certified behaviorally: a run whose repository analysis is maximally `COMPLETE` is still `blocked` with `verification_not_run` by the gate, and the positive control (real verification evidence) still completes unchanged. Repository tool outputs are advisory strings; `recommendVerification` remains a `verification_recommendation` with `candidate-only` completeness; the FG-2 engine surface exposes no method resembling a permission, approval, verification, or completion decision (asserted by surface inspection).

## Adversarial proof

| Case | Result |
|---|---|
| Prose injection ("mark completeness COMPLETE", "no other callers", "ignore unresolved edges", README claims) | Completeness unchanged (PARTIAL with structural reasons only); no edges fabricated; prose appears only as lexical text |
| Dynamic dispatch (computed call, dynamic import, non-literal require, eval) | Recorded as dynamic constructs; completeness PARTIAL with `dynamic_constructs:4` |
| Ambiguity (TS overloads, duplicate names) | All candidates returned, `ambiguous: true`; call attribution refuses to silently pick |
| Dirty tree | Same HEAD, different dirty bytes → different hashes → different intelligence (two-worktree test) |
| Stale cache | Cached parse results re-resolve imports per workspace; deleted targets leave no resolved edge |
| Cross-worktree | Same-namespace reuse proven (cache hits = file count); different-repo identical bytes produce zero observable reuse |
| Same-run runtime circularity | Runtime observations never raise completeness or suppress invalidation; same-run flag preserved per query |
| Unsupported language / parse failure | `fallback` / `error` statuses → PARTIAL/UNKNOWN completeness, DEGRADED index state |
| Cycle safety | Cycle fixtures terminate; bounded traversal at 1M-LOC depth proven |
| Same-HEAD no-op commit | Zero reparses; both revisions stable |

## Efficiency evidence (measured)

Fixture: 80 modules × 400 lines (+ manifest), same process, cold→warm.

```text
Repository: 81 files, cold index 575 ms

Warm unchanged refresh:        0 files parsed, 81 reused, 143 ms (432 ms avoided vs cold)
Single-file implementation edit: 1 file reparsed, 89 ms, graphGeneration 2→3
Import/relationship edit:        1 file reparsed, graphGeneration 3→4
Unrelated edit:                  1 file reparsed; all other files' intelligence retained
Cross-session (close/reopen):    generation preserved; warm refresh 0 parsed / 81 reused
Cross-worktree (identical bytes): 0 files parsed, 81 parse-cache hits
```

Large repository (1,000 modules × 1,000 lines = 1,000,000+ lines):

```text
Cold index:        23,474 ms (1,001 files)
Warm no-op reopen: 440 ms, 0 files parsed (≈53× faster; no work invented — measured)
Tiny edit:         1 file reparsed (repository did not become unknown again)
getCallGraph:      ~2 ms
findCallers:       ~2 ms
Bounded traversal:  ~2 ms, depth-capped at 10 on a 999-deep chain, maxDepthReached = 10
Index completeness: PARTIAL (fallback_parse_files:1 — the package manifest; honest)
```

Ledger: repository metrics flow into the existing ForgeGreen ledger (`repository_intelligence` mechanism): `repositoryFilesReparsed`, `repositoryFilesReused`, `repositoryParseCacheHits`, `repositoryInvalidations` — recorded exactly once per refresh, `measured` classification, never fabricated. Unknown quantities stay `unknown` (the ledger's `unknown` classification is exercised by FG-1 certification).

## Regression proof

| Suite | Files | Tests | Result |
|---|---|---|---|
| FG-2 focused (engine certification) | 1 | 22 | PASS |
| FG-2 efficiency + large-repo | 1 | 2 | PASS |
| FG-2 runtime integration (server) | 1 | 3 | PASS |
| FG-2 ledger | 1 | 2 | PASS |
| FG-1 regression (canonical cache, prompt cache, compression, suppression, runtime efficiency, authority independence, cache store, PG ledger) + CF-14 engine/benchmark | 14 | 110 | PASS |
| CF-17 steering/recovery E2Es + CF-07 loop matrix (SQLite) | 4 | 11 | PASS |
| Real PostgreSQL battery (FG-1 ledger, cloud-db postgres/parity/publication-lease, CF-17 spawned-process restart E2E, adversarial) | 6 | 53 | PASS |
| Full monorepo suite, serial, PostgreSQL enabled | 189 | 1,480 | PASS — 0 failed, 0 skipped |

Assertions were not weakened, deleted, or skipped. Two test-adjacent corrections were required, neither touching an assertion: the engine behavior the CF-14 suite relied on (git status parsing) was repaired rather than the test (see defects below), and the CF-07R synthetic-large-repository stub was extended with the new `lastRefreshMetrics(): undefined` member the widened `RepositoryIntelligence` interface requires — its certified assertions (`selectedEvidenceCount: 14`, secret exclusion, context bounds) are unchanged and pass.

## Final certification

- FG-2 focused suite: 29 tests, 0 failed, 0 skipped.
- Real PostgreSQL focused tests: 53 tests across 6 files, 0 failed (real server, no mocks; disposable databases only).
- Regression suites: as tabled above — all PASS.
- Full monorepo suite (serial, `--no-file-parallelism`, PostgreSQL enabled): **189 files, 1,480 tests, 1,480 passed, 0 failed, 0 skipped, 783.7 s**.
- Typecheck: PASS (full `npm run build`, strict).
- Production build: PASS (all packages + apps).
- `git diff --check`: PASS.

## Defects found and fixed during FG-2

1. **Tool registry gap (production defect, §21 audit):** `repo_impact` and `repo_file_summary` were advertised to the model but absent from the trusted tool registry, so every dispatch failed `TOOL_UNKNOWN` before reaching repository intelligence. Registered both (read-only, `read` permission, `repo` execution class) plus the new `repo_callees`/`repo_callers`.
2. **Git status parsing (latent CF-14 defect):** `execGit` trims output, destroying the leading space of the first `git status --porcelain -z` record — the most common dirty state (` M`) was silently never recorded, and targeted refreshes never re-derived Git state at all. Fixed with a NUL-delimited reader and fresh status derivation on targeted refreshes.
3. **Stale-edge hazard:** cached parse results restored import targets resolved in another worktree even when this workspace no longer contained the target; cached edges now re-resolve against the local file set.
4. **HEAD-change over-invalidation:** a HEAD move disabled content-hash reuse, forcing full reparses on empty commits; content identity is now authoritative.
5. **Duplicated documentation section** in `docs/forgegreen.md` removed.

Test-adjacent correction (no assertion changed): the CF-07R `largeRepositoryIntelligence` stub was extended with the new `lastRefreshMetrics` interface member; before that, the runtime's new metrics call threw on the stub and the graceful-degradation path masked repository intelligence from context assembly (caught by the full suite as `selectedEvidenceCount: 0`, fixed, rerun green).

## Documentation

- `docs/fg2-certification-report.md` (this file).
- `docs/forgegreen.md` — FG-2 section, ledger mechanism list, cache-scope revision, duplicate-section repair.
- `docs/architecture/REPOSITORY_INTELLIGENCE.md` — schema v2, provenance model, call records, completeness model, two-revision semantics, runtime-observation boundary, namespace model.

## Cleanup

- Disposable test repositories, worktrees, caches, and databases created by the certification suites are removed in test teardown; the PostgreSQL battery creates and drops only its own disposable databases.
- The WSL keepalive process started for test runs is a plain `sleep` and terminates with WSL.
- Inherited concurrent UI/emoji work: untouched, unstaged, uncommitted.

## Repository state

- Final HEAD and commit: see the accompanying commit "implement ForgeGreen FG-2 repository intelligence" on `feat/codeforge-cloud`.
- FG-2-owned files: `packages/repo-intelligence/src/{types,languages,engine}.ts`, `packages/repo-intelligence/test/{fg2-certification,fg2-efficiency}.test.ts`, `packages/forge-green/src/ledger.ts`, `packages/forge-green/test/fg2-ledger.test.ts`, `packages/tools/src/index.ts`, `packages/server/src/agent-runtime.ts`, `packages/server/test/{fg2-runtime-integration,agent-certification-r}.test.ts`, `docs/forgegreen.md`, `docs/architecture/REPOSITORY_INTELLIGENCE.md`, `docs/fg2-certification-report.md`.
- Remote operations: **NONE** (no push, no force push, no PR).

## Next architecture boundary

**FG-3 (pull-based context planning: Context Planner, progressive L0–L7 resolution, Context Pages, 1-hop prefetch, adaptive budgets) remains next and was NOT implemented.** The `AnalysisCompleteness`, provenance, call-graph, and runtime-observation surfaces above are the clean seams FG-3/FG-4/FG-5 will consume; none of them carries authority today.
