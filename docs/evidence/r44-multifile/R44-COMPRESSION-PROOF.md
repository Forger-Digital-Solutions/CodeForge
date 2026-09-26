# R44 — ForgeGreen Compression Real-World Format Proof

## What R43 fixed and what R44 added

R43 repaired failure-line recognition for `✗`/`AssertionError`-style lines. R44 probed
the compressor against realistic long outputs and found three more silent-omission gaps:

| Format | Failure line | Why it was missed |
|---|---|---|
| Jest failure blocks | `● Suite › test name` | `●` was not in the symbol set; jest blocks carry no error/fail keyword |
| Rust panics | `thread 'main' panicked at …` | `\bpanic\b` stops at `panicked`'s trailing `k` |
| Crashes/timeouts | `Segmentation fault (core dumped)`, `Command timed out` | contain neither "error" nor "fail" |

Each was silently dropped from model context when outside the head/tail window. The
`FAILURE_PATTERN` now covers `panic(?:ked)?`, `seg(?:mentation)? fault`, `core dumped`,
`timed out`, and `●`.

## Guarantee boundaries (unchanged)

- Compression runs after secret redaction; it never un-redacts.
- Failure lines + ±8-line context windows are always retained.
- Head and tail survive; every omitted region emits an explicit `[forgegreen: …]` marker
  with a count and an artifact pointer; identical repeats fold with counts.
- The representation is hard-bounded; the authoritative raw output stays on the tool record.

## Evidence

`packages/tools/test/r44-compression-formats.test.ts` — 9/9:

- vitest failure blocks keep file:line + AssertionError + expected/received
- jest `●` blocks survive with stack frames
- `error TS2345` lines keep file(line,col)
- eslint per-file violations + summary survive
- go `--- FAIL:` and pytest `FAILED … - assert` survive
- Rust `panicked at` + `Segmentation fault` + repeated-stack folding survive
- `Exit code: 124` + `timed out` survive head/tail bounding
- >8000-line git diffs and 2500-line grep results bound correctly with omission markers

`packages/tools/test/fg1-compression.test.ts` — 9/9 unchanged (no regressions).
