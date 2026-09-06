# Repository Intelligence and Context Architecture

CodeForge treats a repository index as disposable, local derived data. The canonical service is `@codeforge/repo-intelligence`; `@codeforge/context` consumes its stable read contract and never needs to know how records are stored.

## Pipeline

Opening a workspace computes an isolated identity from its canonical path, Git common directory, Git worktree directory, and repository markers. This prevents two clones or worktrees from sharing mutable state. The index lives under the CodeForge application cache at `repository-indexes/<workspace-id>/repository-index.sqlite`, never in the repository or `.git`.

Initial indexing follows a bounded pipeline:

```text
Git-aware discovery → classify → metadata/hash → parse → symbols/edges → SQLite transaction → READY
```

Git workspaces use `git ls-files --cached --others --exclude-standard`, which applies tracked state, `.gitignore`, and `.git/info/exclude` without executing repository code. Non-Git workspaces use a non-following directory walk with generated/cache directory bounds. Canonical real paths must remain under the workspace, so symlink and junction escapes are rejected. Binary, sensitive, and oversized files retain metadata but their content is not indexed or surfaced.

SQLite uses WAL mode, atomic transactions, foreign keys, explicit schema version `2`, and parser version `typescript-5.9+deterministic-2`. An incompatible schema is quarantined and rebuilt. A corrupt database is renamed as disposable evidence and replaced; source is never touched. Schema v2 adds explicit edge provenance, import bindings, per-file call records, and a runtime-observation table. Every persisted analysis identity includes the repository-level security namespace, path, language/parser, parser version, schema version, content hash, and (where relevant) worktree identity.

## Language and graph model

TypeScript, TSX, JavaScript, and JSX use the TypeScript compiler parser. JSON, Markdown, YAML, Shell, and PowerShell use bounded deterministic structural adapters and are labeled `fallback`. Other recognized languages (python, rust, go, …) retain metadata and lexical retrieval and are also labeled `fallback` — no structural claim is made for them. A parser failure marks the file `error` and the index `DEGRADED` without aborting other files. Parser status is part of every completeness report; the system never manufactures structural completeness for files parsed heuristically.

Symbols have deterministic IDs, qualified names, kinds, line ranges, export state, signatures, and parents. Directed edges represent resolved imports, external/unresolved imports, workspace/package dependencies, and test relationships. Every edge carries explicit provenance: `static-direct` (package manifest), `import-resolved` (resolved import specifier, including literal dynamic imports), `heuristic` (test filename convention), `unresolved` (specifier text exists but no workspace target resolved), `syntax-resolved` and `runtime-observed` (below). `type-resolved` and `framework-inferred` are reserved taxonomy slots that no current analyzer emits.

Per-file call records capture identifier calls, member calls (this/class-scoped and namespaced), dynamic `import()`, non-literal `require`, computed element-access calls, and `eval`. Dynamic imports with literal specifiers additionally produce an import edge (the file dependency is real) plus a dynamic-construct record (the loading is conditional). Call resolution runs at query time against the current symbol and import-binding tables: same-file definitions resolve as `syntax-resolved`, named/default import bindings and one-hop barrel re-exports resolve as `import-resolved`, and everything else — including multiple same-name candidates — is returned as an explicit candidate list with `ambiguous: true`. Ambiguous symbols are never silently disambiguated; `findDefinitions(name)` exposes every exact-name match.

Incremental refresh checks size and mtime first, then hashes changed candidates so touching an unchanged file does not reparse it. Content identity is authoritative over commit identity: after a HEAD move every file is re-hashed, but content-identical files keep their parsed intelligence, so an empty commit reparses nothing. Dirty working-tree content differs by content hash at the same HEAD, and two worktrees at one commit with different dirty content never share intelligence. When a resolved dependency target is deleted or renamed, its direct dependents are re-resolved within the same transaction (bounded, reported as `invalidatedDependents`): their resolved edges become honest `unresolved` edges rather than silently disappearing, and no stale resolved edge survives.

Two revision counters are maintained. `generation` advances only when indexed content changes. `graphGeneration` advances only when a file's symbol/edge/call digest actually changes — a comments-only edit advances the first, not the second. Cached canonical analyses (FG-1D) key graph-scoped queries on the graph revision and content-scoped queries on the content revision. Parse-result reuse is keyed by repository-level security namespace (Git common directory, shared across worktrees of one clone) plus content hash, and cached edges re-resolve their relative imports against the current workspace's file set, so identical bytes never restore a target that does not exist locally.

## Completeness and uncertainty

Every analysis that can be incomplete carries a categorical `AnalysisCompleteness`: `COMPLETE`, `PARTIAL`, or `UNKNOWN`, with structural reason codes (dynamic constructs, unresolved relative imports, parse errors, fallback-parsed files, ambiguous resolutions, traversal truncation). Completeness is computed only from structural facts — parser status, resolution coverage, known dynamic constructs, and traversal bounds. Repository prose (comments, READMEs, docstrings, commit messages) is untrusted advisory content: it can appear in lexical retrieval, but it cannot raise completeness, remove unresolved edges, fabricate provenance, suppress invalidation, or alter cache validity.

Runtime-observed relationships are representable with mandatory scope identity (`runId`, observer, revision, timestamp, evidence hash) and fixed `runtime-observed` provenance. They are advisory only: they never raise completeness, never suppress invalidation, and the completeness computation never reads them. `listRuntimeObservations({ sameRunAs })` distinguishes same-run observation from independent evidence so a later Verification Policy cannot be forced to mistake a narrow run's trace for broad proof. No production producer exists yet; the model makes self-grading inexpressible.

## Retrieval

Retrieval combines exact/partial symbol names, paths, SQLite FTS lexical matches, resolved graph relationships, related tests, and Git modification state. Scores are deterministic and results include reason strings and confidence. Exact implementation symbols rank above approximate text references; related tests are attached without masquerading as implementations. Every query is bounded and paginated, and concurrent readers do not share mutable query state.

`SemanticIndexProvider` is an optional seam. No semantic provider, embedding model, local LLM, hosted vector database, or paid service is required. Core indexing is static local computation and uploads no raw repository content.

## Context engine

`@codeforge/context` builds a structured `ContextPack` from the task, repository intelligence, task ledger, Git state, and model window. Its hard repository budget is:

```text
context window - system prompt - tool schemas - reserved output - safety margin
```

Candidate priority is explicit paths, implementation symbols, direct relationships, tests, Git changes, and lower-confidence lexical neighbors. Large files are sliced to a symbol plus bounded surrounding lines. Every chunk records path, line range, symbol, reasons, score, current content hash, indexed hash, and freshness. Stale files are refreshed before inclusion. Content hashes deduplicate chunks reached by multiple retrieval paths. The working diff receives a bounded share of remaining budget.

The task ledger stores facts rather than a transcript. Its deterministic compactor retains goals, constraints, decisions, modifications, failed approaches, repairs, verification, blockers, and evidence with provenance and uncertainty. It discards redundant tool noise and does not invoke a model.

## Runtime and desktop integration

The autonomous workflow uses persistent repository retrieval before plan construction and falls back to the legacy bounded filesystem inspector if the disposable index is unavailable. The model runtime exposes approval-free read tools for search, symbols, references, dependencies, dependents, tests, context, and index health. Mutations remain behind the existing permission, approval, containment, hash, verification, evidence, and checkpoint systems.

Desktop workspace opening starts indexing asynchronously. Chat/manual work remains available while indexing, and the header reports local progress, file/symbol counts, and health. The server provides status and rebuild endpoints. No Cloud runtime or Cloud database stores repository index content.

## Future seams

The service is instance-based rather than agent-global. Future explorer, reviewer, and test subagents can share concurrent reads while serialized refreshes preserve consistency. Workspace identity already isolates Git worktrees. MCP/Skills can wrap the same bounded read methods. GitHub issue-to-PR, background agents, browser verification, the competitive arena, and multi-model routing can consume `ContextPack` provenance without copying the repository or bypassing safety.

Cache pruning may delete closed workspace indexes by last use and size because all index state is rebuildable. It must never delete an open workspace index.
