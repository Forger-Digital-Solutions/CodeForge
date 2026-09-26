# R37 — ForgeVerify Audit

Scope: `packages/workflow/src/{forge-verify,verification-service,completion-gate,
diff-review,semantic-diff-review,failure-analyzer,verification-evidence-reuse,
verification-reuse-cost-gate}.ts` and the R21/R23/R25 adversarial corpus.

## Verified coverage (pre-existing, re-confirmed)

| Brief fixture class | Coverage |
|---|---|
| fake success strings / forged receipts | r21 malicious corpus: stdout claims convict only with exit-code truth |
| shell wrappers hiding exit codes | `|| exit 0` unmasked by runner summaries; silent swallows flagged advisory |
| verifier hangs / kills itself / missing executable | timed_out is terminal negative; missing binary never passes |
| malformed/binary output | exit-0 binary garbage passes only with advisory, never clean |
| stale replayed results, outside-workspace paths | documented boundary, surfaced |
| evidence-record tampering | content hash re-verified; any single-field mutation rejected |
| test skipped / todo added | `test_assertion_weakened` — **blocking** |
| assertions deleted / strict→loose matcher swap | blocking |
| @ts-ignore / eslint-disable additions | blocking (SUPPRESS_RE delta) |
| catch-blocks that swallow errors | `error_swallow_added` — blocking |
| env-gated behavior (correct only under NODE_ENV=test) | `environment_special_case` — blocking |
| `if (false)` dead branches | `dead_branch_added` — blocking |
| special-cased literal matching a test value | `test_input_special_case` — blocking |
| comment-only diffs | `non_functional_change` — advisory |
| unreferenced new exports | `unreferenced_new_symbol` — advisory |
| blocking finding + green verification | gate integration test: run is held |

## Defect found and fixed this pass

**Focused tests were not detected.** `SKIP_OR_TODO_RE` caught `.skip`/`.todo`/`x-it` but
not `.only`/`fit(`/`fdescribe(`. A focused block narrows the suite so the rest silently never
runs — strictly worse than a skip, and it was unflagged. Fixed in `semantic-diff-review.ts`;
three tests added (`test-weakened-only`, `test-weakened-focused`, `focused-helper-fp` —
a helper named `fit()` without a title string must not false-positive).

## ForgeVerify × ForgeGreen intersection (audit result)

- `verification-evidence-reuse.ts` + `verification-reuse-cost-gate.ts` already implement
  state-version-bound evidence reuse — prior tool results replay only when workspace state
  is provably unchanged (hash-bound), so rereads/verification reruns are suppressed safely.
- Verification planning is scope-aware (`supportedScopes`, `changedPaths`) — a focused diff
  does not trigger whole-repo verification.
- Deterministic checks precede model review by construction: findings above are all regex/
  static evidence, zero model calls; model-based review is the escalation path only.

## Honest limits (documented, not fixed — out of deterministic reach)

1. **Opposite-logic patches** (correct shape, inverted `!==`/`===`): undetectable statically.
   Mitigation rests on task-contract acceptance tests, not diff review.
2. **Partial requirement satisfaction** (2 behaviors asked, 1 implemented): requires
   task-intent decomposition; `task-intelligence.ts` feeds scope but intent coverage is
   advisory, not proven.
3. **Mock-only success** where tests assert against mocks never wired to the implementation:
   `unreferenced_new_symbol` catches the extreme case only.
4. **Cross-package integration breakage** is covered only when integration-scope verifiers
   run; a workspace-scoped pass does not prove the consumer still works.

These limits are the honest answer to "does ForgeVerify prove the task is correct": it proves
the deterministic/structural surface rigorously and holds runs on it; deep semantic intent
requires the acceptance-criteria layer plus reviewer escalation, which remains scoped by
task risk rather than mandatory for every edit.
