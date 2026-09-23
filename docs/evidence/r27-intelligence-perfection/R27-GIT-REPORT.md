# R27 Git Safety and Revision Freshness Report

Status: `R27_GIT_SAFETY_AND_REVISION_FRESHNESS_DETERMINISTICALLY_PROVEN`

## Findings

A forced checkpoint restore restored files captured by the checkpoint but did not remove a
non-ignored untracked file created later. This could leave a workspace different from the captured
state while returning success. The generic command classifier also treated all `git branch` forms
as read-only even though several forms mutate refs. Finally, context retrieval could use an index
from an earlier checkout when a branch switch was performed outside the agent runtime.

## R27 correction

`force: true` restore now removes non-ignored untracked residue before replaying the checkpoint;
without `force`, the existing dirty-workspace guard rejects the restore before mutation. This
matches the snapshot boundary of `git stash -u`: ignored files are neither captured nor removed.

Git branch, worktree, checkout/switch, commit/stash, and ref-update commands are mutation-shaped
for runtime accounting. `git diff --ext-diff`, `--textconv`, and `--output` are treated as critical
because they can execute configured helpers or write a file. The desktop renderer bridge remains much narrower: it admits only
validated read-only status/revision/identity argument vectors.

The repository index now records its last indexed Git revision. Before building a context pack,
CodeForge compares that revision with live `HEAD`; a mismatch triggers normal incremental refresh
before retrieval. The refresh retains content-addressed parser reuse for byte-identical files.

## Deterministic validation

Six local-Git server/context/repository suites passed 84 tests. They include a real temporary
repository where a post-checkpoint untracked file must disappear after forced restore, a branch
checkout without an explicit caller refresh, durable checkpoint references, and linked-worktree
page isolation. Desktop Git bridge and worktree classification tests passed 33/33. Repository
Intelligence, Context, and Server typechecking passed.

## Boundary

This is local deterministic Git safety evidence. It does not prove remote Git/GitHub operations,
credentials, live-model command choices, or freshly packaged desktop behavior. A Git mutation made
outside CodeForge that leaves `HEAD` unchanged is not a general filesystem-watcher proof; in-run
mutations refresh directly and retrieved chunks are content-hash checked.
