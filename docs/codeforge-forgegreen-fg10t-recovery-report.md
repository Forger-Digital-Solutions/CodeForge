# ForgeGreen FG-10T Recovery Report

## Summary

The older task-fix checkout was an ancestor of the authoritative ForgeGreen lineage and was not suitable for FG-11 work. The real implementation surface is on `feat/codeforge-cloud` at `b415032`.

## Recovery result

- base branch: `feat/codeforge-cloud`
- base commit: `b415032cf1241a701ac2274a1559601a02721be6`
- recovery branch: `forger-digital-solutions-forgegreen-certified`
- source-state ID: `b2953f62172d2ccafb534322d709bd490be9cc6a41829c91f1794973906c47cd`

## Provenance findings

- Candidate A remains active-safe in the recovered implementation.
- Candidate B/C/D remain shadow semantics with canonical evidence seams.
- The router/director cycle repair is preserved in the recovered branch and is separate from lineage provenance.
- The recovery branch is built from the actual lineage, not from reconstructed prose.

## Validation

- `npm test -- --run` passes on the recovered branch.
- relevant ForgeGreen, router, director, and workflow suites are green.
