# R27 Single-User Performance Report

Status: `R27_SINGLE_USER_SCALE_GUARDS_DETERMINISTICALLY_PROVEN`

The focused local performance suite passed 24/24 tests in 34.48 seconds and typechecking passed
for Repository Intelligence, Context, and UI. It intentionally excludes the repository's
multi-user/DAU simulator: R27 performance scope is one developer and one repository.

The deterministic million-line fixture exercises initial indexing, symbol/dependency/text queries,
32K context selection, a one-file incremental refresh, and indexed query reuse. The contracts cap
initial indexing at 120 seconds; median lookup/context operations at 50–500 milliseconds; and the
one-file refresh at two seconds. These are guard bounds, not reported benchmark samples.

Context contracts pass for 16K through 128K windows and preserve fresh, deduplicated provenance.
A synthetic 100,000-file/1,000,000-symbol candidate space is constrained before provider delivery
and excludes sensitive paths. The UI projects a duplicated input replay containing 1,000 tools,
500 changes, and 200 usage events in under one second without double-counting, while a 100,500-line
patch is truncated to at most 2,000 review lines.

This does not establish portable hardware performance, packaged-desktop responsiveness, resource
usage, or real-repository behavior. A publishable claim needs repeated raw samples with hardware,
OS, runtime, cold/warm cache, corpus, and RSS/CPU/disk metadata.
