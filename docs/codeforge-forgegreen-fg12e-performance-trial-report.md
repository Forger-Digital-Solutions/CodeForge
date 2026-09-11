# ForgeGreen FG-12E — Expensive Verifier Performance & Break-Even Trial Report

Generated: 2026-09-11T19:43:37.449Z

- Verdict: **CODEFORGE_FORGEGREEN_FG12E_PERFORMANCE_CHARACTERIZED**
- Certified Candidate D source-state (unchanged from FG-12D): `ac8414ebd2a85803bde97d35a5409ca1be7a5d156ae3be57a070ebb5ba72ad53`
- FG-12D checkpoint commit: `411b4803f57de2da8b9f20d5cd64c9003cde748d`
- FG-12D campaign harness id: `295f1bb1b3887e508d22364dd1e54a66bd06d0d29d102b0c71efbf1b3f17f939`
- FG-12E benchmark harness id: `19145d0c3966d7a7c453c61944fafc5ea2bb737be979766292fa607fc76ff3c7`
- Environment: node v24.19.0, win32/x64, 12 CPUs (Intel(R) Core(TM) i7-9850H CPU @ 2.60GHz)
- Provider cost: $0.00 (all work local; no model, cloud, or GPU involvement)
- Energy/Carbon: `INSUFFICIENT_DATA`
- Global `VERIFICATION_EVIDENCE_REUSE` graduation registry entry: unchanged (still `SHADOW`); production call sites modified: none
- Rollout recommendation (performance policy, separate from safety): **ROLLOUT_COST_GATED**

## Safety (always first)

- Scored pairs: 161 (plus 30 unscored warmups)
- Pairs failing any safety check: 0
- Stale evidence reused: 0 · Failed evidence reused: 0
- Coverage divergences: 0 · Outcome divergences: 0
- Actual verifier executions avoided (real skips): 197 · child processes not spawned: 197
- Fresh executions performed inside treatment arms (invalidation/partial/fallback): 124
- Safety certified for this run: **true**

## Workloads (real verifiers)

| workload | expected tier | observed class | workspace | verifier | scored pairs | valid |
|---|---|---|---|---|---|---|
| t1-syntax-check | CHEAP | CHEAP | bench-fixture | node --check (single file) | 10 | yes |
| t1-single-unit-test | CHEAP | MODERATE | bench-fixture | node --test (1 file, 12 cases) | 10 | yes |
| t2-test-group | MODERATE | MODERATE | bench-fixture | node --test (4 files) | 10 | yes |
| t2-full-fixture-tests | MODERATE | EXPENSIVE | bench-fixture | node --test (all 16 files) | 10 | yes |
| t2-fixture-typecheck | MODERATE | EXPENSIVE | bench-fixture | tsc --noEmit (48-module project, non-incremental) | 10 | yes |
| t2-repo-vitest-single | MODERATE | EXPENSIVE | repo-root | vitest run (1 real test file) | 10 | yes |
| t2-repo-tsc-forge-green | MODERATE | EXPENSIVE | repo-root | tsc --noEmit packages/forge-green (non-incremental) | 10 | yes |
| t3-repo-tsc-server | EXPENSIVE | EXPENSIVE | repo-root | tsc --noEmit packages/server (non-incremental) | 5 | yes |
| t3-repo-vitest-sessions | EXPENSIVE | EXPENSIVE | repo-root | vitest run packages/sessions (7 files) | 5 | yes |
| t4-repo-vitest-forge-green | HEAVY | EXPENSIVE | repo-root | vitest run packages/forge-green (29 files) | 5 | yes |
| t4-repo-vitest-context | HEAVY | EXPENSIVE | repo-root | vitest run packages/context (8 files, integration-heavy) | 3 | yes |

Observed class is non-authoritative (spec §20): CHEAP = verifier cost below the measured break-even, MODERATE = 1-5x, EXPENSIVE = >= 5x.

## Break-even characterization

net_savings_ms = verifier_execution_ms (control child-process time of the avoided verifiers) - reuse_check_ms (treatment wall - control non-verifier wall, measured per pair). Break-even verifier cost ~= reuse_check_ms. Linearity is checked, not assumed (see residuals).

- reuse_check_ms overall: median 152.4 ms (p25 139.2 ms, p75 184.3 ms, n=88)
- reuse_check_ms on bench-fixture: median 161.8 ms (p25 140.4 ms, p75 195.8 ms, n=50)
- reuse_check_ms on repo-root: median 148.9 ms (p25 137.9 ms, p75 156 ms, n=38)
- **Break-even estimate: verifier cost ≈ 152.4 ms (range 139.2 ms – 184.3 ms)**
- Empirical bracket: last net-negative workload = t1-syntax-check (verifier 81 ms, net -63.2 ms); first net-positive = t1-single-unit-test (verifier 247.5 ms, net 104.7 ms)
- Model/observation sign agreement: 11 agree, 0 disagree

| workload (by verifier cost) | workspace | control wall (median) | verifier exec (median) | treatment wall (median) | net (median) | reuse_check (median) | positive-net share |
|---|---|---|---|---|---|---|---|
| t1-syntax-check | bench-fixture | 410.4 ms | 81 ms | 469.3 ms | -63.2 ms | 145.4 ms | 0% |
| t1-single-unit-test | bench-fixture | 615.1 ms | 247.5 ms | 513.4 ms | 104.7 ms | 146.1 ms | 100% |
| t2-test-group | bench-fixture | 638.4 ms | 314.5 ms | 527.5 ms | 104.4 ms | 212.6 ms | 100% |
| t2-fixture-typecheck | bench-fixture | 1147.2 ms | 797.5 ms | 490.8 ms | 656.3 ms | 140.8 ms | 100% |
| t2-full-fixture-tests | bench-fixture | 1209.6 ms | 887 ms | 527.5 ms | 693.1 ms | 197.7 ms | 100% |
| t2-repo-tsc-forge-green | repo-root | 1500.4 ms | 1186.5 ms | 454.9 ms | 1049.1 ms | 151.8 ms | 100% |
| t2-repo-vitest-single | repo-root | 1741.6 ms | 1377.5 ms | 506 ms | 1231.6 ms | 153.2 ms | 100% |
| t3-repo-tsc-server | repo-root | 2515.6 ms | 2218 ms | 447.6 ms | 2082.3 ms | 139.1 ms | 100% |
| t3-repo-vitest-sessions | repo-root | 2545 ms | 2242 ms | 441 ms | 2104 ms | 141.4 ms | 100% |
| t4-repo-vitest-forge-green | repo-root | 7073.4 ms | 6778 ms | 449.3 ms | 6633 ms | 145 ms | 100% |
| t4-repo-vitest-context | repo-root | 12849.3 ms | 12555 ms | 442.3 ms | 12398.8 ms | 148.8 ms | 100% |

Residuals (net − (verifier exec − reuse_check)); a residual trend with cost would indicate non-linearity:

- t1-syntax-check: 1.2 ms (1.9% of |net|)
- t1-single-unit-test: 3.2 ms (3.1% of |net|)
- t2-test-group: 2.5 ms (2.4% of |net|)
- t2-fixture-typecheck: -0.4 ms (-0.1% of |net|)
- t2-full-fixture-tests: 3.8 ms (0.5% of |net|)
- t2-repo-tsc-forge-green: 14.4 ms (1.4% of |net|)
- t2-repo-vitest-single: 7.3 ms (0.6% of |net|)
- t3-repo-tsc-server: 3.4 ms (0.2% of |net|)
- t3-repo-vitest-sessions: 3.4 ms (0.2% of |net|)
- t4-repo-vitest-forge-green: 0 ms (0.0% of |net|)
- t4-repo-vitest-context: -7.3 ms (-0.1% of |net|)

## Per-workload timings (control vs treatment)

### t1-syntax-check — node --check (single file)

Workspace: bench-fixture · expected CHEAP · observed CHEAP · cold (unscored baseline) verifier elapsed: 76 ms · actual verifier executions avoided: 10

| series | n | median | mean | min | max | p25 | p75 |
|---|---|---|---|---|---|---|---|
| control wall | 10 | 410.4 ms | 407.8 ms | 361 ms | 447.8 ms | 392.2 ms | 419.8 ms |
| control verifier exec (child process) | 10 | 81 ms | 79.9 ms | 64 ms | 104 ms | 73.3 ms | 83.5 ms |
| control non-verifier base | 10 | 330.5 ms | 327.9 ms | 297 ms | 355.6 ms | 313 ms | 340.7 ms |
| treatment wall (reuse path) | 10 | 469.3 ms | 469.3 ms | 449.1 ms | 494.9 ms | 454.4 ms | 478.3 ms |
| net (control − treatment) | 10 | -63.2 ms | -61.5 ms | -88.2 ms | -35.9 ms | -73.7 ms | -48.2 ms |
| reuse_check (treatment − control base) | 10 | 145.4 ms | 141.4 ms | 116.9 ms | 158 ms | 136.9 ms | 147.6 ms |
| advisory differential (pre-plan) | 10 | 152 ms | 151.1 ms | 132.5 ms | 164.4 ms | 149.6 ms | 155.3 ms |

Order balance: control-first n=5 median net -65.1 ms; treatment-first n=5 median net -61.3 ms. Positive-net share 0%.

### t1-single-unit-test — node --test (1 file, 12 cases)

Workspace: bench-fixture · expected CHEAP · observed MODERATE · cold (unscored baseline) verifier elapsed: 243 ms · actual verifier executions avoided: 10

| series | n | median | mean | min | max | p25 | p75 |
|---|---|---|---|---|---|---|---|
| control wall | 10 | 615.1 ms | 624.6 ms | 601.3 ms | 670.6 ms | 611.9 ms | 625.7 ms |
| control verifier exec (child process) | 10 | 247.5 ms | 255.4 ms | 241 ms | 307 ms | 245 ms | 255.5 ms |
| control non-verifier base | 10 | 367.6 ms | 369.2 ms | 351.7 ms | 401.6 ms | 363.3 ms | 370.5 ms |
| treatment wall (reuse path) | 10 | 513.4 ms | 517.6 ms | 454.9 ms | 560.5 ms | 508.6 ms | 531.4 ms |
| net (control − treatment) | 10 | 104.7 ms | 107 ms | 68.8 ms | 164.5 ms | 93.2 ms | 111.4 ms |
| reuse_check (treatment − control base) | 10 | 146.1 ms | 148.4 ms | 76.5 ms | 198.2 ms | 137.3 ms | 174.7 ms |
| advisory differential (pre-plan) | 10 | 157 ms | 158.4 ms | 112 ms | 195 ms | 153.1 ms | 176.3 ms |
| net without flagged outliers | 9 | 104.6 ms | 100.6 ms | 68.8 ms | 146.7 ms | 92.8 ms | 108.8 ms |
| control wall without flagged outliers | 8 | 613.9 ms | 613.3 ms | 601.3 ms | 627.8 ms | 609.2 ms | 616.8 ms |

Order balance: control-first n=5 median net 108.8 ms; treatment-first n=5 median net 104.6 ms. Positive-net share 100%.
Outliers flagged (retained, rule: robust-z > 3 (|x - median| > 3 * 1.4826 * MAD) AND |x - median| > 25 ms; flagged observations are retained in the raw series and reported both ways): control [1,3], treatment [3,9], net [9].

### t2-test-group — node --test (4 files)

Workspace: bench-fixture · expected MODERATE · observed MODERATE · cold (unscored baseline) verifier elapsed: 344 ms · actual verifier executions avoided: 10

| series | n | median | mean | min | max | p25 | p75 |
|---|---|---|---|---|---|---|---|
| control wall | 10 | 638.4 ms | 635.9 ms | 606.4 ms | 660.9 ms | 629.9 ms | 647.1 ms |
| control verifier exec (child process) | 10 | 314.5 ms | 313.2 ms | 296 ms | 328 ms | 313.3 ms | 317.3 ms |
| control non-verifier base | 10 | 323.8 ms | 322.7 ms | 307.4 ms | 332.9 ms | 315.9 ms | 331.1 ms |
| treatment wall (reuse path) | 10 | 527.5 ms | 540 ms | 500.6 ms | 614.6 ms | 514.5 ms | 543.7 ms |
| net (control − treatment) | 10 | 104.4 ms | 95.9 ms | 28.6 ms | 146.7 ms | 66.6 ms | 124.2 ms |
| reuse_check (treatment − control base) | 10 | 212.6 ms | 217.3 ms | 171.3 ms | 285.4 ms | 189.3 ms | 230.2 ms |
| advisory differential (pre-plan) | 10 | 198.1 ms | 202 ms | 172.2 ms | 267.4 ms | 180.8 ms | 210.5 ms |

Order balance: control-first n=5 median net 107.9 ms; treatment-first n=5 median net 100.8 ms. Positive-net share 100%.
Outliers flagged (retained, rule: robust-z > 3 (|x - median| > 3 * 1.4826 * MAD) AND |x - median| > 25 ms; flagged observations are retained in the raw series and reported both ways): control [], treatment [0,3], net [].

### t2-full-fixture-tests — node --test (all 16 files)

Workspace: bench-fixture · expected MODERATE · observed EXPENSIVE · cold (unscored baseline) verifier elapsed: 815 ms · actual verifier executions avoided: 10

| series | n | median | mean | min | max | p25 | p75 |
|---|---|---|---|---|---|---|---|
| control wall | 10 | 1209.6 ms | 1209.9 ms | 1157.7 ms | 1266 ms | 1191.6 ms | 1228.1 ms |
| control verifier exec (child process) | 10 | 887 ms | 886.4 ms | 841 ms | 937 ms | 871.8 ms | 902.3 ms |
| control non-verifier base | 10 | 324.8 ms | 323.5 ms | 311 ms | 330.5 ms | 319.6 ms | 328.5 ms |
| treatment wall (reuse path) | 10 | 527.5 ms | 523.9 ms | 494.7 ms | 552.7 ms | 513.8 ms | 534.7 ms |
| net (control − treatment) | 10 | 693.1 ms | 685.9 ms | 605 ms | 741 ms | 667.3 ms | 716.4 ms |
| reuse_check (treatment − control base) | 10 | 197.7 ms | 200.5 ms | 171.2 ms | 236 ms | 187.3 ms | 216.2 ms |
| advisory differential (pre-plan) | 10 | 183.4 ms | 184.8 ms | 159.8 ms | 210.6 ms | 176.7 ms | 194.6 ms |

Order balance: control-first n=5 median net 672.8 ms; treatment-first n=5 median net 712.5 ms. Positive-net share 100%.

### t2-fixture-typecheck — tsc --noEmit (48-module project, non-incremental)

Workspace: bench-fixture · expected MODERATE · observed EXPENSIVE · cold (unscored baseline) verifier elapsed: 1005 ms · actual verifier executions avoided: 10

| series | n | median | mean | min | max | p25 | p75 |
|---|---|---|---|---|---|---|---|
| control wall | 10 | 1147.2 ms | 1142.7 ms | 1098.6 ms | 1176.4 ms | 1127 ms | 1163.8 ms |
| control verifier exec (child process) | 10 | 797.5 ms | 795.5 ms | 758 ms | 833 ms | 785.5 ms | 808.8 ms |
| control non-verifier base | 10 | 344.9 ms | 347.2 ms | 338.9 ms | 360.9 ms | 341.3 ms | 351.2 ms |
| treatment wall (reuse path) | 10 | 490.8 ms | 492 ms | 471.5 ms | 525.2 ms | 482.5 ms | 494.9 ms |
| net (control − treatment) | 10 | 656.3 ms | 650.7 ms | 600.4 ms | 680.3 ms | 643.9 ms | 674.4 ms |
| reuse_check (treatment − control base) | 10 | 140.8 ms | 144.8 ms | 119.9 ms | 181.8 ms | 131.7 ms | 152.9 ms |
| advisory differential (pre-plan) | 10 | 151.9 ms | 157.8 ms | 140.4 ms | 193.7 ms | 146.7 ms | 163.2 ms |

Order balance: control-first n=5 median net 675.8 ms; treatment-first n=5 median net 643.9 ms. Positive-net share 100%.
Outliers flagged (retained, rule: robust-z > 3 (|x - median| > 3 * 1.4826 * MAD) AND |x - median| > 25 ms; flagged observations are retained in the raw series and reported both ways): control [], treatment [3], net [].

### t2-repo-vitest-single — vitest run (1 real test file)

Workspace: repo-root · expected MODERATE · observed EXPENSIVE · cold (unscored baseline) verifier elapsed: 1438 ms · actual verifier executions avoided: 10

| series | n | median | mean | min | max | p25 | p75 |
|---|---|---|---|---|---|---|---|
| control wall | 10 | 1741.6 ms | 1741.5 ms | 1691.3 ms | 1829.7 ms | 1705.7 ms | 1762.3 ms |
| control verifier exec (child process) | 10 | 1377.5 ms | 1390.4 ms | 1337 ms | 1468 ms | 1358.3 ms | 1427.3 ms |
| control non-verifier base | 10 | 350 ms | 351.1 ms | 331.5 ms | 375.7 ms | 340 ms | 360.5 ms |
| treatment wall (reuse path) | 10 | 506 ms | 515.6 ms | 493.9 ms | 568.2 ms | 499.3 ms | 522.8 ms |
| net (control − treatment) | 10 | 1231.6 ms | 1225.9 ms | 1133.5 ms | 1326 ms | 1188.8 ms | 1256.6 ms |
| reuse_check (treatment − control base) | 10 | 153.2 ms | 164.5 ms | 137.2 ms | 213.5 ms | 147.8 ms | 174.2 ms |
| advisory differential (pre-plan) | 10 | 159.1 ms | 167.1 ms | 144.1 ms | 210.1 ms | 150.8 ms | 172.2 ms |

Order balance: control-first n=5 median net 1245.3 ms; treatment-first n=5 median net 1189.9 ms. Positive-net share 100%.
Outliers flagged (retained, rule: robust-z > 3 (|x - median| > 3 * 1.4826 * MAD) AND |x - median| > 25 ms; flagged observations are retained in the raw series and reported both ways): control [], treatment [4], net [].

### t2-repo-tsc-forge-green — tsc --noEmit packages/forge-green (non-incremental)

Workspace: repo-root · expected MODERATE · observed EXPENSIVE · cold (unscored baseline) verifier elapsed: 1432 ms · actual verifier executions avoided: 10

| series | n | median | mean | min | max | p25 | p75 |
|---|---|---|---|---|---|---|---|
| control wall | 10 | 1500.4 ms | 1624 ms | 1446.1 ms | 1976 ms | 1460.9 ms | 1804.2 ms |
| control verifier exec (child process) | 10 | 1186.5 ms | 1294.6 ms | 1150 ms | 1585 ms | 1163.5 ms | 1440 ms |
| control non-verifier base | 10 | 313.9 ms | 329.4 ms | 295 ms | 391 ms | 298.3 ms | 362.7 ms |
| treatment wall (reuse path) | 10 | 454.9 ms | 482.3 ms | 441.4 ms | 591.3 ms | 445.6 ms | 490.1 ms |
| net (control − treatment) | 10 | 1049.1 ms | 1141.7 ms | 989.6 ms | 1434.9 ms | 1013.3 ms | 1236 ms |
| reuse_check (treatment − control base) | 10 | 151.8 ms | 152.9 ms | 72.1 ms | 220.1 ms | 140.5 ms | 165.9 ms |
| advisory differential (pre-plan) | 10 | 149.9 ms | 156.7 ms | 108.2 ms | 229.8 ms | 141.4 ms | 163 ms |
| net without flagged outliers | 8 | 1037 ms | 1073.5 ms | 989.6 ms | 1239.9 ms | 1003.4 ms | 1100.4 ms |
| control wall without flagged outliers | 7 | 1481.6 ms | 1508.1 ms | 1446.1 ms | 1723 ms | 1452.4 ms | 1500.4 ms |

Order balance: control-first n=5 median net 1059.1 ms; treatment-first n=5 median net 1039.1 ms. Positive-net share 100%.
Outliers flagged (retained, rule: robust-z > 3 (|x - median| > 3 * 1.4826 * MAD) AND |x - median| > 25 ms; flagged observations are retained in the raw series and reported both ways): control [1,2,3], treatment [1,2], net [2,3].

### t3-repo-tsc-server — tsc --noEmit packages/server (non-incremental)

Workspace: repo-root · expected EXPENSIVE · observed EXPENSIVE · cold (unscored baseline) verifier elapsed: 2245 ms · actual verifier executions avoided: 5

| series | n | median | mean | min | max | p25 | p75 |
|---|---|---|---|---|---|---|---|
| control wall | 5 | 2515.6 ms | 2531.2 ms | 2512 ms | 2565.5 ms | 2514.2 ms | 2548.8 ms |
| control verifier exec (child process) | 5 | 2218 ms | 2225.6 ms | 2207 ms | 2257 ms | 2211 ms | 2235 ms |
| control non-verifier base | 5 | 308.5 ms | 305.6 ms | 294 ms | 313.8 ms | 303.2 ms | 308.6 ms |
| treatment wall (reuse path) | 5 | 447.6 ms | 456.7 ms | 431.9 ms | 509.3 ms | 447.2 ms | 447.8 ms |
| net (control − treatment) | 5 | 2082.3 ms | 2074.5 ms | 2006.3 ms | 2117.9 ms | 2064.8 ms | 2101.1 ms |
| reuse_check (treatment − control base) | 5 | 139.1 ms | 151.1 ms | 128.7 ms | 200.7 ms | 133.9 ms | 153.2 ms |
| advisory differential (pre-plan) | 5 | 147 ms | 155 ms | 134.8 ms | 198.3 ms | 141.2 ms | 153.9 ms |
| control wall without flagged outliers | 3 | 2514.2 ms | 2513.9 ms | 2512 ms | 2515.6 ms | 2513.1 ms | 2514.9 ms |

Order balance: control-first n=2 median net 2035.6 ms; treatment-first n=3 median net 2101.1 ms. Positive-net share 100%.
Outliers flagged (retained, rule: robust-z > 3 (|x - median| > 3 * 1.4826 * MAD) AND |x - median| > 25 ms; flagged observations are retained in the raw series and reported both ways): control [2,4], treatment [3], net [].

### t3-repo-vitest-sessions — vitest run packages/sessions (7 files)

Workspace: repo-root · expected EXPENSIVE · observed EXPENSIVE · cold (unscored baseline) verifier elapsed: 2248 ms · actual verifier executions avoided: 5

| series | n | median | mean | min | max | p25 | p75 |
|---|---|---|---|---|---|---|---|
| control wall | 5 | 2545 ms | 2568.6 ms | 2512.3 ms | 2645.4 ms | 2513 ms | 2627.3 ms |
| control verifier exec (child process) | 5 | 2242 ms | 2261.6 ms | 2200 ms | 2338 ms | 2219 ms | 2309 ms |
| control non-verifier base | 5 | 307.4 ms | 307 ms | 293.3 ms | 318.3 ms | 303 ms | 313 ms |
| treatment wall (reuse path) | 5 | 441 ms | 449.1 ms | 434.7 ms | 466.5 ms | 437.6 ms | 465.7 ms |
| net (control − treatment) | 5 | 2104 ms | 2119.5 ms | 2046.5 ms | 2189.7 ms | 2077.6 ms | 2179.7 ms |
| reuse_check (treatment − control base) | 5 | 141.4 ms | 142.1 ms | 119.3 ms | 158.3 ms | 138 ms | 153.5 ms |
| advisory differential (pre-plan) | 5 | 142.8 ms | 146.1 ms | 135 ms | 165.3 ms | 137.5 ms | 149.7 ms |

Order balance: control-first n=2 median net 2075.2 ms; treatment-first n=3 median net 2179.7 ms. Positive-net share 100%.

### t4-repo-vitest-forge-green — vitest run packages/forge-green (29 files)

Workspace: repo-root · expected HEAVY · observed EXPENSIVE · cold (unscored baseline) verifier elapsed: 7270 ms · actual verifier executions avoided: 5

| series | n | median | mean | min | max | p25 | p75 |
|---|---|---|---|---|---|---|---|
| control wall | 5 | 7073.4 ms | 7166.8 ms | 7051.2 ms | 7516.9 ms | 7067.6 ms | 7124.9 ms |
| control verifier exec (child process) | 5 | 6778 ms | 6854 ms | 6756 ms | 7158 ms | 6767 ms | 6811 ms |
| control non-verifier base | 5 | 300.6 ms | 312.8 ms | 295.2 ms | 358.9 ms | 295.4 ms | 313.9 ms |
| treatment wall (reuse path) | 5 | 449.3 ms | 446.2 ms | 440.4 ms | 451 ms | 440.6 ms | 449.6 ms |
| net (control − treatment) | 5 | 6633 ms | 6720.7 ms | 6601.6 ms | 7076.4 ms | 6618.4 ms | 6673.9 ms |
| reuse_check (treatment − control base) | 5 | 145 ms | 133.3 ms | 81.6 ms | 154.4 ms | 137.1 ms | 148.6 ms |
| advisory differential (pre-plan) | 5 | 154.4 ms | 139.8 ms | 83.2 ms | 159.1 ms | 146.1 ms | 156.3 ms |
| net without flagged outliers | 4 | 6625.7 ms | 6631.7 ms | 6601.6 ms | 6673.9 ms | 6614.2 ms | 6643.2 ms |
| control wall without flagged outliers | 4 | 7070.5 ms | 7079.3 ms | 7051.2 ms | 7124.9 ms | 7063.5 ms | 7086.3 ms |

Order balance: control-first n=2 median net 6839 ms; treatment-first n=3 median net 6633 ms. Positive-net share 100%.
Outliers flagged (retained, rule: robust-z > 3 (|x - median| > 3 * 1.4826 * MAD) AND |x - median| > 25 ms; flagged observations are retained in the raw series and reported both ways): control [1], treatment [], net [1].

### t4-repo-vitest-context — vitest run packages/context (8 files, integration-heavy)

Workspace: repo-root · expected HEAVY · observed EXPENSIVE · cold (unscored baseline) verifier elapsed: 12994 ms · actual verifier executions avoided: 3

| series | n | median | mean | min | max | p25 | p75 |
|---|---|---|---|---|---|---|---|
| control wall | 3 | 12849.3 ms | 12860.1 ms | 12772.5 ms | 12958.5 ms | 12810.9 ms | 12903.9 ms |
| control verifier exec (child process) | 3 | 12555 ms | 12564.3 ms | 12473 ms | 12665 ms | 12514 ms | 12610 ms |
| control non-verifier base | 3 | 294.3 ms | 295.8 ms | 293.5 ms | 299.5 ms | 293.9 ms | 296.9 ms |
| treatment wall (reuse path) | 3 | 442.3 ms | 443.2 ms | 436.9 ms | 450.5 ms | 439.6 ms | 446.4 ms |
| net (control − treatment) | 3 | 12398.8 ms | 12416.9 ms | 12335.6 ms | 12516.2 ms | 12367.2 ms | 12457.5 ms |
| reuse_check (treatment − control base) | 3 | 148.8 ms | 147.5 ms | 137.4 ms | 156.2 ms | 143.1 ms | 152.5 ms |
| advisory differential (pre-plan) | 3 | 148 ms | 149.1 ms | 140.7 ms | 158.7 ms | 144.4 ms | 153.3 ms |

Order balance: control-first n=1 median net 12335.6 ms; treatment-first n=2 median net 12457.5 ms. Positive-net share 100%.

## Raw scored timings

- t1-syntax-check control wall: 375.2, 361, 387.1, 447.8, 407.5, 408.7, 417.4, 412.1, 420.6, 440.6
- t1-syntax-check treatment wall: 453.6, 449.1, 463.1, 490.5, 453.8, 475.5, 478.7, 477.2, 456.5, 494.9
- t1-syntax-check order: T→C, C→T, T→C, C→T, T→C, C→T, T→C, C→T, T→C, C→T
- t1-single-unit-test control wall: 601.3, 670.6, 611.3, 669.3, 615.9, 602.7, 614.3, 627.8, 613.5, 619.4
- t1-single-unit-test treatment wall: 508.5, 524, 517.1, 560.5, 503.6, 533.9, 509.7, 555, 508.8, 454.9
- t1-single-unit-test order: T→C, C→T, T→C, C→T, T→C, C→T, T→C, C→T, T→C, C→T
- t2-test-group control wall: 660.9, 641.1, 635.7, 634.7, 606.4, 644.9, 628.3, 608.3, 647.9, 650.8
- t2-test-group treatment wall: 614.6, 500.6, 510.9, 606, 527.5, 537, 527.4, 545.9, 525.5, 504.2
- t2-test-group order: T→C, C→T, T→C, C→T, T→C, C→T, T→C, C→T, T→C, C→T
- t2-full-fixture-tests control wall: 1206.5, 1212.9, 1233.2, 1186.6, 1266, 1174.1, 1242.5, 1211.1, 1157.7, 1208
- t2-full-fixture-tests treatment wall: 494.7, 495.1, 513.8, 513.8, 525, 535, 529.9, 545.6, 552.7, 533.7
- t2-full-fixture-tests order: T→C, C→T, T→C, C→T, T→C, C→T, T→C, C→T, T→C, C→T
- t2-fixture-typecheck control wall: 1138.3, 1152.8, 1098.6, 1176.4, 1104.9, 1165.9, 1123.2, 1167.7, 1141.6, 1157.3
- t2-fixture-typecheck treatment wall: 494.3, 491.4, 495.1, 525.2, 504.5, 490.2, 479.2, 487.3, 471.5, 480.9
- t2-fixture-typecheck order: T→C, C→T, T→C, C→T, T→C, C→T, T→C, C→T, T→C, C→T
- t2-repo-vitest-single control wall: 1703.9, 1743.4, 1829.7, 1711, 1701.7, 1781.9, 1768.5, 1743.7, 1691.3, 1739.7
- t2-repo-vitest-single treatment wall: 513.9, 498.1, 503.8, 544.6, 568.2, 496.5, 508.3, 525.8, 502.8, 493.9
- t2-repo-vitest-single order: T→C, C→T, T→C, C→T, T→C, C→T, T→C, C→T, T→C, C→T
- t2-repo-tsc-forge-green control wall: 1723, 1831.2, 1976, 1876.3, 1481.6, 1450.9, 1493.8, 1454, 1446.1, 1507.1
- t2-repo-tsc-forge-green treatment wall: 498.7, 591.3, 582.2, 441.4, 442.5, 444.8, 458.9, 464.3, 450.9, 448
- t2-repo-tsc-forge-green order: T→C, C→T, T→C, C→T, T→C, C→T, T→C, C→T, T→C, C→T
- t3-repo-tsc-server control wall: 2514.2, 2512, 2565.5, 2515.6, 2548.8
- t3-repo-tsc-server treatment wall: 431.9, 447.2, 447.6, 509.3, 447.8
- t3-repo-tsc-server order: T→C, C→T, T→C, C→T, T→C
- t3-repo-vitest-sessions control wall: 2627.3, 2545, 2512.3, 2513, 2645.4
- t3-repo-vitest-sessions treatment wall: 437.6, 441, 434.7, 466.5, 465.7
- t3-repo-vitest-sessions order: T→C, C→T, T→C, C→T, T→C
- t4-repo-vitest-forge-green control wall: 7124.9, 7516.9, 7067.6, 7051.2, 7073.4
- t4-repo-vitest-forge-green treatment wall: 451, 440.6, 449.3, 449.6, 440.4
- t4-repo-vitest-forge-green order: T→C, C→T, T→C, C→T, T→C
- t4-repo-vitest-context control wall: 12958.5, 12772.5, 12849.3
- t4-repo-vitest-context treatment wall: 442.3, 436.9, 450.5
- t4-repo-vitest-context order: T→C, C→T, T→C

## Reuse overhead components (direct profile of the production functions in wrapper order)

### bench-fixture (20 iterations, verifiers: fx.typecheck)

| series | n | median | mean | min | max | p25 | p75 |
|---|---|---|---|---|---|---|---|
| inputStateHashMs | 20 | 139.4 ms | 141.8 ms | 137 ms | 158.5 ms | 139 ms | 140.8 ms |
| advisory.commandAvailabilityMs | 20 | 0 ms | 0 ms | 0 ms | 0.1 ms | 0 ms | 0 ms |
| advisory.adaptAndRegistryMs | 20 | 0.6 ms | 0.6 ms | 0.5 ms | 0.9 ms | 0.5 ms | 0.6 ms |
| advisory.preliminaryPlanMs | 20 | 139.2 ms | 140.3 ms | 136.8 ms | 151.2 ms | 137.9 ms | 140.4 ms |
| advisory.advisorTotalMs | 20 | 0 ms | 0 ms | 0 ms | 0.1 ms | 0 ms | 0 ms |
| advisory.strictNarrowingMs | 20 | 0 ms | 0 ms | 0 ms | 0.1 ms | 0 ms | 0 ms |
| advisory.canonicalValidityMs | 20 | 0 ms | 0 ms | 0 ms | 0.1 ms | 0 ms | 0 ms |
| advisory.forgeGreenDecisionMs | 20 | 0 ms | 0.1 ms | 0 ms | 0.1 ms | 0 ms | 0.1 ms |
| advisory.killSwitchResolveMs | 20 | 0 ms | 0 ms | 0 ms | 0 ms | 0 ms | 0 ms |
| advisory.totalMs | 20 | 139.8 ms | 141 ms | 137.4 ms | 151.9 ms | 138.6 ms | 141.2 ms |
| authoritative.adaptAndRegistryMs | 20 | 0.5 ms | 0.5 ms | 0.5 ms | 0.7 ms | 0.5 ms | 0.5 ms |
| authoritative.planMs | 20 | 139.9 ms | 139.9 ms | 137.4 ms | 143.5 ms | 139 ms | 141 ms |
| authoritative.executeReuseMatchAndSummarizeMs | 20 | 139.7 ms | 141.1 ms | 137.7 ms | 152.5 ms | 138.6 ms | 140.7 ms |
| authoritative.summarizeMs | 20 | 139.6 ms | 140.6 ms | 136.9 ms | 148.3 ms | 138.9 ms | 140.4 ms |
| authoritative.coverageAndReportAssemblyMs | 20 | 0 ms | 0.8 ms | 0 ms | 9.1 ms | 0 ms | 1 ms |
| authoritative.runVerificationReuseWallMs | 20 | 279.1 ms | 280.6 ms | 276.3 ms | 294.7 ms | 277.8 ms | 280.3 ms |
| reusePathTotalMs | 20 | 419 ms | 421.6 ms | 414.2 ms | 432.5 ms | 417.7 ms | 425.5 ms |

Tree semantics (no double counting): `advisory.totalMs` = commandAvailability + adaptAndRegistry + preliminaryPlan + advisorTotal; `advisorTotalMs` contains strictNarrowing/canonicalValidity/forgeGreenDecision/killSwitchResolve as sub-spans; `preliminaryPlanMs` and `authoritative.planMs` each contain one `inputStateHashMs`; `executeReuseMatchAndSummarizeMs` contains `summarizeMs` (which contains another input-state hash); `reusePathTotalMs` = advisory.totalMs + authoritative.runVerificationReuseWallMs.

### repo-root (20 iterations, verifiers: repo.tsc.forge-green)

| series | n | median | mean | min | max | p25 | p75 |
|---|---|---|---|---|---|---|---|
| inputStateHashMs | 20 | 145.3 ms | 147.4 ms | 144.4 ms | 156.4 ms | 145 ms | 147.9 ms |
| advisory.commandAvailabilityMs | 20 | 0 ms | 0 ms | 0 ms | 0 ms | 0 ms | 0 ms |
| advisory.adaptAndRegistryMs | 20 | 0.5 ms | 0.6 ms | 0.5 ms | 0.8 ms | 0.5 ms | 0.6 ms |
| advisory.preliminaryPlanMs | 20 | 145.4 ms | 145.5 ms | 143.8 ms | 148 ms | 144.9 ms | 145.9 ms |
| advisory.advisorTotalMs | 20 | 0 ms | 0 ms | 0 ms | 0 ms | 0 ms | 0 ms |
| advisory.strictNarrowingMs | 20 | 0 ms | 0 ms | 0 ms | 0 ms | 0 ms | 0 ms |
| advisory.canonicalValidityMs | 20 | 0 ms | 0 ms | 0 ms | 0 ms | 0 ms | 0 ms |
| advisory.forgeGreenDecisionMs | 20 | 0 ms | 0 ms | 0 ms | 0.1 ms | 0 ms | 0 ms |
| advisory.killSwitchResolveMs | 20 | 0 ms | 0 ms | 0 ms | 0 ms | 0 ms | 0 ms |
| advisory.totalMs | 20 | 146 ms | 146.1 ms | 144.4 ms | 148.6 ms | 145.5 ms | 146.5 ms |
| authoritative.adaptAndRegistryMs | 20 | 0.5 ms | 0.6 ms | 0.5 ms | 0.8 ms | 0.5 ms | 0.5 ms |
| authoritative.planMs | 20 | 145.3 ms | 146.3 ms | 143.2 ms | 155.9 ms | 144.3 ms | 146.8 ms |
| authoritative.executeReuseMatchAndSummarizeMs | 20 | 146.2 ms | 148.7 ms | 142.8 ms | 164.3 ms | 144.8 ms | 153.5 ms |
| authoritative.summarizeMs | 20 | 146.1 ms | 146.3 ms | 142.6 ms | 155.4 ms | 144.7 ms | 147 ms |
| authoritative.coverageAndReportAssemblyMs | 20 | 0.7 ms | 2.8 ms | 0 ms | 13.5 ms | 0 ms | 3.1 ms |
| authoritative.runVerificationReuseWallMs | 20 | 294.5 ms | 296.6 ms | 288.5 ms | 315.2 ms | 292.3 ms | 298.2 ms |
| reusePathTotalMs | 20 | 440.6 ms | 442.7 ms | 433.1 ms | 459.6 ms | 438.8 ms | 443.9 ms |

Tree semantics (no double counting): `advisory.totalMs` = commandAvailability + adaptAndRegistry + preliminaryPlan + advisorTotal; `advisorTotalMs` contains strictNarrowing/canonicalValidity/forgeGreenDecision/killSwitchResolve as sub-spans; `preliminaryPlanMs` and `authoritative.planMs` each contain one `inputStateHashMs`; `executeReuseMatchAndSummarizeMs` contains `summarizeMs` (which contains another input-state hash); `reusePathTotalMs` = advisory.totalMs + authoritative.runVerificationReuseWallMs.

## Multi-verifier plans and partial reuse

| scenario | planned | reusable | count share | runtime-weighted share | control (median) | treatment (median) | net (median) | reuse_check (median) | avoided | fresh | valid |
|---|---|---|---|---|---|---|---|---|---|---|---|
| composition-equal-cost-0pct | 4 | 0 | 0% | 0% | 1526.1 ms | 1674.2 ms | -149.5 ms | 144.2 ms | 0 | 20 | yes |
| composition-equal-cost-25pct | 4 | 1 | 25% | 21% | 1532.9 ms | 1427 ms | 105.9 ms | 172.5 ms | 5 | 15 | yes |
| composition-equal-cost-50pct | 4 | 2 | 50% | 44% | 1529.5 ms | 1119.7 ms | 401 ms | 145.4 ms | 10 | 10 | yes |
| composition-equal-cost-75pct | 4 | 3 | 75% | 68% | 1520.6 ms | 839.1 ms | 682.8 ms | 171.6 ms | 15 | 5 | yes |
| composition-equal-cost-100pct | 4 | 4 | 100% | 100% | 1505.9 ms | 458.8 ms | 1047.1 ms | 173.9 ms | 20 | 0 | yes |
| composition-mixed-reuse-expensive-only | 3 | 1 | 33% | 67% | 1306.6 ms | 768.8 ms | 528.2 ms | 122.8 ms | 5 | 10 | yes |
| composition-mixed-reuse-cheap-only | 3 | 1 | 33% | 7% | 1293.7 ms | 1354.2 ms | -57.8 ms | 118.8 ms | 5 | 10 | yes |
| composition-mixed-reuse-all | 3 | 3 | 100% | 100% | 1270.5 ms | 454.5 ms | 821.7 ms | 177.6 ms | 15 | 0 | yes |

Non-reusable verifiers in a composition carry a real definition change (equivalent output, different command digest), so their prior evidence is invalid by definition digest and they execute fresh while the rest reuse — coverage stays complete.

## Invalidation cost with an expensive verifier (rejected reuse attempts)

| category | fresh verification always executed | control (median) | treatment (median) | rejected-reuse overhead (median) | overhead p25–p75 | advisory differential (median) | valid |
|---|---|---|---|---|---|---|---|
| source_changed | true | 958 ms | 1079.9 ms | 125.4 ms | 114.3 ms – 127.2 ms | 129.6 ms | true |
| definition_changed | true | 935.3 ms | 1073.7 ms | 141.6 ms | 136.4 ms – 143.8 ms | 137.6 ms | true |
| command_changed | true | 939.3 ms | 1067.4 ms | 128.1 ms | 124.4 ms – 140.8 ms | 136.2 ms | true |
| new_obligation_added | true | 1620.5 ms | 1074.4 ms | -546.1 ms | -551.6 ms – -541.6 ms | 126.2 ms | true |
| prior_failed_evidence | true | 946.1 ms | 1078.9 ms | 140.6 ms | 132.7 ms – 144.1 ms | 138.1 ms | true |
| input_state_hash_mismatch | true | 929.5 ms | 1111.1 ms | 181.2 ms | 179.2 ms – 181.4 ms | 159.6 ms | true |
| workspace_path_mismatch | true | 938 ms | 1074.8 ms | 136.9 ms | 136.7 ms – 140.7 ms | 135 ms | true |
| incomplete_evidence_metadata | true | 947.2 ms | 1079.4 ms | 136.4 ms | 124.6 ms – 139.2 ms | 135.1 ms | true |

## Restart (durable persistence) with an expensive verifier

- **restart-valid-reuse**: PASSED; durable evidence load 0.3 ms (1 records); persistence writes: baseline 23 ms, control 19.1 ms/run, treatment 6.9 ms/run; expensive verifier genuinely skipped: true
  - scored control wall: 991.7, 987.5, 979.5; treatment wall: 433.5, 429.9, 432.1; net: 558.2, 557.6, 547.4
  - historical elapsedMs carried by the persisted evidence: 676; fresh control elapsedMs: 713, 675, 663, 661
- **restart-stale-refused**: PASSED; durable evidence load 0.1 ms (1 records); persistence writes: baseline 23.7 ms, control 21.6 ms/run, treatment 19.7 ms/run; expensive verifier ran fresh: true
  - scored control wall: 972.9, 974.3, 966.3; treatment wall: 1121.8, 1125, 1105.5; net: -148.9, -150.7, -139.2
  - historical elapsedMs carried by the persisted evidence: 664; fresh control elapsedMs: 661, 671, 663, 672

## Advisor failure fallback with an expensive verifier

- PASSED; fresh verification always executed: true; fallback overhead (treatment − control): median 175.6 ms (p25 173.1 ms, p75 263.1 ms)
- scored control wall: 938.7, 941, 935.6; treatment wall: 1289.3, 1116.6, 1106.2

## Historical cost estimation (spec §19)

- Verifier duration recorded today: true — VerificationEvidence.elapsedMs (ForgeVerify child-process wall time), persisted verbatim inside the 'evidence' work-item payload by createForgeVerifyPersistenceObserver and returned by loadForgeVerifyEvidence; also surfaced as VerifierRunResult.durationMs and VerificationReceipt.durationMs.
- Durable: true; could feed a future ForgeGreen performance advisory: true
- Duration must only ever inform a ForgeGreen cost policy (e.g. a future gate deciding whether to spend reuse_check_ms at all). It never participates in validity: ForgeVerify's isEvidenceCurrentlyValid remains the sole authority and takes no duration input.

## Rollout recommendation

**ROLLOUT_COST_GATED**

- Reuse is net-negative below ~152.4 ms of verifier cost and consistently net-positive for expensive verifiers; a cost gate at the measured threshold captures the benefit without the cheap-verifier loss.
- Inputs: {"validWorkloads":11,"cheapestNetPositive":false,"anyNetPositive":true,"expensiveAllNetPositive":true,"thresholdMeasurable":true,"noisy":false,"safetyCertified":true}

This classification is a performance policy statement only. Candidate D remains `CONTROLLED_TRIAL_ONLY`; nothing here activates it or wires a production caller.
