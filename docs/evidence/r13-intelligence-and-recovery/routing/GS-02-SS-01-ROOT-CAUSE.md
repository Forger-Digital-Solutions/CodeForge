# CBR2-GS-02 / CBR2-SS-01 investigation — root cause

Recorded: 2026-09-18. Investigation performed by reading raw benchmark evidence, the benchmark executor script, and repository history. No live OpenRouter request was made or needed.

## Finding: no CodeForge defect — ForgeVerify worked correctly in both R11 and R12

Both cases share the same fixture family (`security`, task: implement/fix `src/receipt.mjs` so a receipt excludes credential material) and the same hidden-verifier finding text: `"receipt retained credential material"`.

The critical fact, read directly from `scripts/r11-codeforge-bench-r2-executor.mjs:251`: the hidden verifier command is passed as one of the **two** `verificationCommands` given directly to CodeForge's own `/api/send` call —

```js
verificationCommands: ["npm test", hiddenVerifierCommand]
```

— it is not an external-only check the harness bolts on after the fact. CodeForge's own ForgeVerify pipeline runs it as a required verifier.

R12's recorded `terminalError` for both cases confirms ForgeVerify did exactly its job:

```
Verification: 3 passed, 1 failed, exit 1 — FAIL
Review: 1 file(s) changed, 0 issue(s) — approved
Outcome: Failed safely after 0 repair attempt(s)
Completion gate: FAILED
- BLOCKING verification_failed: Required verifier 'verifier-2-custom' (custom) did not produce current PASS evidence (failed).
```

"Failed safely" is CodeForge's own zero-false-completion language. The model's generated `src/receipt.mjs` did not correctly strip the credential-shaped field; the hidden verifier (running as a real, required CodeForge verification command) caught it; the Completion Gate correctly blocked. Nothing was lost, nothing was misreported, no false completion occurred.

## Why there is no "general mechanism" to fix

Combined with the PF-01 finding (`PF-01-ROOT-CAUSE.md`): the only commit between R11's frozen benchmark commit (`cb4b9cf`) and R12 closeout (`935ac48`) is `83dc1db`, which is proven to be behaviorally inert (an unused type-import removal plus a test-fixture credential swap in a non-material test file). No CodeForge source change exists that could account for a behavioral difference between the two runs, for any of the 40 cases.

GS-01 (fixture-family sibling, not a regression — failed at both R11 and R12) shows the identical hidden-verifier finding, reinforcing that this task is simply hard for this specific free/weak model (`cohere/north-mini-code:free`) — not something that flipped due to a CodeForge change. R11 and R12 each ran this case exactly once, against a non-deterministic model; GS-02/SS-01 succeeded on one trial and failed on the other. That is benchmark trial variance, not a regression.

## Disposition

- No fix implemented for GS-02/SS-01 — there is nothing in CodeForge to fix. Considered a defensible, evidence-based null result, not an incomplete investigation.
- Considered building a general static-pattern credential scan into `completion-gate.ts` as defense-in-depth, then abandoned it: the *actual* task-specific hidden verifier already does a strictly better, semantically correct check (calls the real function, inspects real output) than any static diff-pattern scan could, and ForgeVerify already enforces it as a required verifier. Adding a parallel static scanner would be redundant at best and would introduce new false-positive risk (flagging legitimate secret-shaped test fixtures elsewhere in a change) for no corresponding benefit.
- Training-data implication: these rows should be labeled reflecting `MODEL_RELIABILITY` / benchmark-trial-variance, not `VERIFICATION_FAILURE` in the sense of "ForgeVerify is untrustworthy," and not any kind of routing/plumbing failure class. They are, if anything, positive evidence for ForgeVerify: it produced the correct, honest verdict under model failure on both sides of the comparison.
