# CF-14 controlled idle-machine rerun

Recorded: 2026-09-18

Command:

```text
node node_modules/vitest/vitest.mjs run packages/repo-intelligence/test/cf14-large-repo-benchmark.test.ts --reporter=verbose
```

The isolated run passed one file and one test. Vitest reported 34,831 ms test time and 36.44 s total wall time. No build, full-suite run, browser/Electron packaging, or other CodeForge load was run concurrently. The existing 120 s bound was unchanged.

Verdict: `MACHINE_CONTENTION / HARDWARE_MARGIN` for the earlier approximately 154 s observation. This rerun completes with a 83.56 s margin to the unchanged threshold; it does not justify relaxing the performance limit. Memory telemetry was not available from this runner.
