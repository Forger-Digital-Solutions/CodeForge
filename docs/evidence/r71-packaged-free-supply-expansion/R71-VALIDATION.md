# R71 validation and reproducibility

Final affected run: **1095 passed, 2 skipped, 0 failed**, 108 files with passing assertions plus 1 Postgres file with both assertions skipped. [Vitest JSON](final-affected-tests.json) marks all 109 file entries passed despite the skipped assertions and reports nested suite totals separately. Coverage includes providers, Eight-Bit, model registry, ForgeZero, FreeFabric, server admission/capacity and autonomous-parent process recovery. Test providers are labeled `isTestProvider: true`, preserving the legitimate zero-cost policy and avoiding real global-governor stalls.

Earlier focused receipts are retained: 27 initial focused, 1080 affected, 2 production seam, 48 transport. These overlap and must **not** be added into a larger unique test total. New dedicated regressions total 19 (11 provider, 6 isolation, 2 production seam); existing regressions cover broader gates. An explicitly listed nonexistent `model-execution-adapter.test.ts` path did not create test coverage; execution wiring is covered by existing actual suites.

Desktop provider-connection, official OAuth browser and packaged-identity tests additionally pass **24/24** in [desktop receipt](desktop-connection-tests-verified.json). The [initial sandbox attempt](desktop-connection-tests.json) hit missing cross-process Vitest temporary files before two suites could load, not an assertion failure. Repeating the same tests outside that sandbox resolved it; no packaged application was launched.

`tsc -b --force` passes. Full `npm run build` completes exit 0 across workspaces, including desktop renderer and web; [log](workspace-build.log). Existing large renderer-chunk warning remains. Windows dir build and five archive audits pass, with limits documented in [package report](R71-WINDOWS-PACKAGE.md). No Electron launch occurred.

[Generic secret scan](secret-scan.json): PASS, 2028 files, zero findings requiring review (synthetic/allowlisted matches only). The generic scanner excludes evidence directories; `benchmarks/r71/final-audit.mjs` explicitly scans all new R71 top-level benchmark/evidence files for available secret values and provider key patterns, without printing credentials. [Final audit](final-audit.json) has zero credential findings, matches all six original dirty tracked file hashes, preserves the original branch/HEAD, all baseline untracked paths and R70 report hash, and verifies unchanged lockfile SHA-256. [Manifest](evidence-manifest.json) hashes delivered evidence/scripts; ignored tmp sessions, auth URL, dependencies, builds and package payload are not committed.

Reproduce from the R71 worktree with Node >=22.5, existing npm workspace dependencies and network access. Live commands consume legitimate free allocation and require current policy/account evidence; do not run them as ordinary automated tests:

```powershell
npm run build
node node_modules/vitest/vitest.mjs run packages/providers/test packages/eight-bit/test packages/model-registry/test packages/forge-zero/test packages/server/test/free-fabric-wiring.test.ts packages/server/test/free-cloud-supply.test.ts packages/server/test/free-routing-authority.test.ts packages/server/test/workflow-capacity-wait.test.ts packages/server/test/agent-recovery.test.ts packages/server/test/r24-admission-vs-completion.test.ts packages/server/test/autonomous-run-pinned-route-recovery.test.ts packages/server/test/autonomous-parent-recovery.test.ts --reporter=json --outputFile=docs/evidence/r71-packaged-free-supply-expansion/repeated-tests.json
node benchmarks/r71/supply-preflight.mjs
node benchmarks/r71/qualify.mjs cohere/north-mini-code:free
node benchmarks/r71/live-failover.mjs
node benchmarks/r71/openrouter-account-proof.mjs
node benchmarks/r71/live-campaign.mjs 20
node benchmarks/r71/final-audit.mjs
```

For OpenRouter, the harness prints readiness and writes an ignored official authorization URL in `benchmarks/r71/tmp`; the user completes that login. It verifies the free account before inference and holds its key in memory only. It does not reuse the paid-tier environment key. Campaign currently points to the preserved named Kilo qualification receipt; refresh that reference only after a new meaningful qualification and current policy verification. Baseline script is historical evidence and must not be rerun to overwrite original preservation hashes.

Static package audit commands are in the five log filenames' matching `apps/desktop/scripts/audit-packaged-*.mjs` scripts. Identity `--require-clean` compares the archive to current HEAD; after evidence-only commits compare against frozen runtime b61af87, not a changed documentation HEAD. Signing/isolation/live multi-user/endurance gaps are explicitly outside passed regression proof. Gate I passes the affected scope; Gate J passes documented evidence with those limits.
