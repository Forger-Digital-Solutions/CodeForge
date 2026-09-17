# CodeForgeBench R1

CodeForgeBench R1 is the frozen R8 benchmark manifest for CodeForge's autonomous-engineering behavior. It contains 24 solution-neutral cases: two for each required category and coverage for trivial through very-hard work. The executable manifest is exported by `@codeforge/benchmark`; `npm run r8:benchmark` writes the baseline or summarises independently verified, sanitised attempt records.

It measures repository understanding, small fixes, multi-file changes, debugging, test repair, regression prevention, large-repository behavior, context pressure, verification resistance, recovery, tool efficiency, and routing difficulty. Every case records allowed tools, acceptance obligations, expected affected areas, and known traps. It deliberately does not embed an implementation solution.

An attempt is a success only when it is independently verified and no hidden acceptance result rejects it. A blocked, failed, cancelled, or unrun provider execution is retained in the result data and never converted into a success rate. The initial R8 baseline is therefore allowed to be incomplete when no authorised provider execution exists.

The manifest is versioned as `CodeForgeBench-R1`. Future runs must retain the case IDs and acceptance semantics for direct comparison; additions require a new version.
