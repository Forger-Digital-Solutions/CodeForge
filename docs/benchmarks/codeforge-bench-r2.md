# CodeForgeBench R2

CodeForgeBench R2 is the frozen benchmark contract for the R9 capability campaign. It carries
the 24 CodeForgeBench R1 cases forward with their original IDs and acceptance semantics, then
adds 24 solution-neutral cases for complex debugging, test creation, architecture understanding,
long-horizon work, ambiguity, provider failure, adversarial verification, Git safety, security,
subagent cooperation, planning, and reviewing.

The manifest is exported by `@codeforge/benchmark` as `CodeForgeBench-R2` and contains 48 cases.
The R1 cases remain available through the unchanged `CodeForgeBench-R1` exports. R2 cases do not
embed expected patches or benchmark answers.

## Evaluation splits

Every case has one explicit split:

| Split | Purpose |
| --- | --- |
| `TRAIN` | Curriculum and tuning only. |
| `DEVELOPMENT` | Repeated engineering iteration. |
| `VALIDATION` | Router, policy, and model selection. |
| `PROTECTED_TEST` | Final evaluation only; do not use for training or routine iteration. |

The split is enforced by the R2 runner when a split-specific run is requested. The repository is
not a secret store, so a release-quality protected evaluation should keep the protected case
details in a separately controlled runner. A local protected run is a governance partition, not a
claim of cryptographic secrecy.

## Acceptance and scoring

An attempt is traceable only when it records a run ID, repository commit, CodeForge commit, config
digest, timestamp, execution mode, and independent verification evidence. A successful R2 attempt
must be `completed`, independently verified, and free of hidden-acceptance or ForgeVerify failure.
Blocked, failed, cancelled, unrun, and false-completion attempts remain visible and never count as
successes.

The summary reports overall and split/category success, pass@1, false completions, and medians for
wall time, context tokens, tool calls, output tokens, retries, and estimated cost. Resource totals
are never presented as savings unless they are attached to a verified matched comparison.

## Executing a campaign

The runner schedules all 40 public cases by default (or one explicitly selected split), creates
one immutable attempt record per case, and preserves an executor error as a failed attempt rather
than silently skipping the case. An executor is a local ES module that exports
`executeCase(context)`: it must provision the isolated fixture, invoke CodeForge, run independent
acceptance, and return the observed outcome. The runner supplies the frozen case, run ID, commits,
configuration digest, and mode; it owns case selection and traceability fields.

```text
node scripts/r9-codeforge-bench.mjs --phase=PRE --executor=path\to\codeforge-r2-executor.mjs --config-digest=<sanitized-config-digest> --mode=fixed_route
```

The executor is intentionally required. A benchmark manifest does not contain hidden patches,
fixture setup, provider credentials, or an independent verifier, and substituting an invented
adapter would fabricate capability evidence.

## Scoring recorded evidence

Build the workspace first, then run a no-execution baseline:

```text
node scripts/r9-codeforge-bench.mjs --phase=PRE
```

To score sanitized, independently verified attempts:

```text
node scripts/r9-codeforge-bench.mjs --phase=POST --attempts=path\to\attempts.json
```

For a protected evaluation, select the split explicitly and keep the attempt file outside normal
training and development inputs:

```text
node scripts/r9-codeforge-bench.mjs --phase=POST --split=PROTECTED_TEST --attempts=protected-attempts.json
```

The runner rejects unknown cases and attempts missing traceability fields. It does not accept a
model's completion claim as verification and does not perform benchmark-specific answer matching.
