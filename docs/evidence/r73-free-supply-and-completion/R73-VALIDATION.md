# R73 validation

Evidence is recorded per run rather than overwriting failed receipts. Counts from overlapping commands must not be added into a unique-test total.

## Regression checks

The broad affected run covered Eight-Bit, providers, model registry, server, workflow and desktop tests: **2,632 passed, 16 failed, six pending** in `affected-tests.json`. It ran while implementations and their compiled exports were being changed. Every failed file was subsequently rerun individually against the current compiled tree: **212/212 passed** across eleven files, with no pending assertions and no gate/test relaxation. The `rerun-*.test.json` files preserve those isolated reruns. Windows fixture contention and wall-clock sensitive git tests are distinguished from source/version races rather than hidden.

Additional affected tools/agent/protocol tests passed **98/98** in `tools-agent-protocol-final-tests.json`. Active receipt mutation isolation and durable qualification history passed **81/81** in `receipt-immutability-final-tests.json`. Earlier focused Reviewer recovery/schema/timeout/freshness, cost/provider transport, account security and 2/10/25/50 owner-isolation evidence is indexed in the corresponding workstream reports. Initial TEMP, loopback sandbox and concurrent-source failures remain retained.

The source TypeScript project build has passed repeatedly. The final frozen workspace build/typecheck, Reviewer-packet tests, identity-failure classification tests and Windows static audits will be appended after their exact runs. No unchanged broad failure is silently counted as green, and no scripted provider is used as live qualification.

## Integrity and packaging

`baseline-provenance.json` binds R72 clean HEAD and all 73 prior evidence files, the original repository HEAD/branch and six unrelated tracked modifications, and the unchanged lockfile. `final-preservation.json` verifies those hashes and ancestor relationships again. The R73 worktree is isolated from the original dirty repository and all unrelated FDS/GEMS projects.

The final candidate is built from a committed clean source stamp. Package presence, compiled byte equality, main/renderer identity, dependency closure, Electron security and development auth-endpoint audits are separate from an unsigned executable's runtime/signing/installer certification. See `R73-WINDOWS-PACKAGE.md` for exact limitations and artifact receipts.
