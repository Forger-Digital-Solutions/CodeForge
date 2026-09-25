# R35 Recovery — verified before any change

- Branch: `codex/r29-release-closure` (expected: same) ✓
- HEAD at recovery: `1543f1e` (expected: same) ✓
- Working tree: clean (no uncommitted user work) ✓
- R34 commit chain present: `859520f` → `1c36144` → `cb9c594` → `32b072e` → `b9db806`
  → `329c3b2` → `587c7fd` → `38382c6` → `39aede8` → `396e6a5` → `a7f5006` → `04d98f5` → `1543f1e` ✓
- Live migration receipt `cross-pool-migration-r34.json` inspected:
  `migrationVerdict: MIGRATION_PROVEN`, `poolA: groq` → `poolB: shared:mistral`,
  `poolBServedStreams: 3`, `fileFixed: true`, phase `completed`;
  `shared:github-models` honestly inadmissible (`CAPACITY_EXHAUSTED`) ✓
- Certified source surface: `r34-capacity-efficiency-interim-v1` (`62e9d8fc`),
  34 material files, 46 recertifications ✓
- R34 canonical result honored as baseline: 3,707 passed / 0 failed / 48 skipped.

R35 proceeds on top of this tree. No resets, no stash, no pushes.
