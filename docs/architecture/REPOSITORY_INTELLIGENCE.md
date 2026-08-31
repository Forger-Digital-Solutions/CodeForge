# Repository Intelligence and Context Architecture

CodeForge treats a repository index as disposable, local derived data. The canonical service is `@codeforge/repo-intelligence`; `@codeforge/context` consumes its stable read contract and never needs to know how records are stored.

## Pipeline

Opening a workspace computes an isolated identity from its canonical path, Git common directory, Git worktree directory, and repository markers. This prevents two clones or worktrees from sharing mutable state. The index lives under the CodeForge application cache at `repository-indexes/<workspace-id>/repository-index.sqlite`, never in the repository or `.git`.

Initial indexing follows a bounded pipeline:

```text
Git-aware discovery → classify → metadata/hash → parse → symbols/edges → SQLite transaction → READY
```

Git workspaces use `git ls-files --cached --others --exclude-standard`, which applies tracked state, `.gitignore`, and `.git/info/exclude` without executing repository code. Non-Git workspaces use a non-following directory walk with generated/cache directory bounds. Canonical real paths must remain under the workspace, so symlink and junction escapes are rejected. Binary, sensitive, and oversized files retain metadata but their content is not indexed or surfaced.

SQLite uses WAL mode, atomic transactions, foreign keys, explicit schema version `1`, and parser version `typescript-5.9+deterministic-1`. An incompatible schema is quarantined and rebuilt. A corrupt database is renamed as disposable evidence and replaced; source is never touched.

## Language and graph model

TypeScript, TSX, JavaScript, and JSX use the TypeScript compiler parser. JSON, Markdown, YAML, Shell, and PowerShell use bounded deterministic structural adapters. Other recognized languages retain metadata and lexical retrieval until a syntax adapter is added. A parser failure degrades the index without aborting other files.

Symbols have deterministic IDs, qualified names, kinds, line ranges, export state, signatures, and parents. Directed edges represent resolved imports, external/unresolved imports, workspace/package dependencies, and test relationships. Reference results distinguish structural definitions from low-confidence lexical references.

Incremental refresh checks size and mtime first, then hashes changed candidates so touching an unchanged file does not reparse it. An explicit/watch-driven refresh does not rediscover the workspace. Its transaction removes old outgoing symbols/edges for that file, parses current content, and commits atomically. Actual deletion also removes incoming edges. Recursive watchers debounce atomic saves, coalesce mass changes, and fall back to a full convergence scan for large/ambiguous bursts.

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
