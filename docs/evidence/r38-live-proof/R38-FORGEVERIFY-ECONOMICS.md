# R38 — ForgeVerify Cost / Value (DETERMINISTIC)

## Measured cost of the deterministic semantic layer

`r25-semantic-diff-review.test.ts` (20 cases, all green, per-test wall ~280–410ms
including real workspace + git + completion-gate evaluation):

| Layer | Defect classes proven caught | Inference cost |
|---|---|---|
| Deterministic diff review | hardcoded fixture response, special-cased input, NODE_ENV gating, catch-swallow (2 shapes), dead branch, `.skip`, `.only`, `fit`, assertion deletion, strict→loose matcher, comment-only diff, unreferenced export, `.env` edits, test-runner rewrites | **0 requests, 0 tokens, ~300ms** |
| Honest-control rate | 6/6 real fixes produce no blocking finding | same |
| Model review layer | fires only when deterministic evidence is insufficient (r21 wiring: deterministic review runs even with no reviewer spawned) | bounded, role-fit route |

Catch-rate denominator: 14 adversarial defect classes presented, 14 surfaced
(13 blocking + 1 advisory by design). False-positive rate on honest controls: 0/6.

## Live-run proportion (from `forgegreen-ab.json`)

Whole task via free model: 9–14 calls / ~16–29k input tokens. The deterministic
verification layer that caught the defect classes above adds **0** to that —
verification inference spend only appears when a reviewer model is invoked
(topology decides; `tiny` runs ForgeVerify-only by default).

## Cheap-first ordering (verified in code)

diff integrity → build/typecheck/tests (real process exit codes, malicious-corpus
hardened: forged receipts, empty-collection, swallowed failures, timeouts all
terminal-negative or documented-boundary) → deterministic semantic fixtures →
model reviewer only when needed → completion gate. A model is never asked to
rediscover a compile error.

## Reviewer/verifier independence

Deterministic review runs regardless of reviewer presence (r21 wiring test:
`.env` edit blocks with no independent reviewer). Delivery reviewer is read-only.
`evaluateCompletion` is the only `completed` authority.
