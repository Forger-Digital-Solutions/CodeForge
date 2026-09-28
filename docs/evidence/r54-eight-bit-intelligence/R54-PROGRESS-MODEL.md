# R54 observable role progress

The runtime's existing per-turn tool trace now records a hash of each tool observation. `assessCoderProgress` uses successful file edits and previously unseen read/search/command observations as progress. Repeated equivalent output, suppressed calls, denied calls, and a model's own progress claim do not advance it. A new file read counts even if its bytes match another file; repeated searches and commands with identical results do not.

A Coder is stopped only after 5 quiet tool-using turns for a one-step task, 6 for a two- or three-step task, or 7 for a larger plan, with at least as many trailing tool calls and at least one earlier real observation. The existing identical-call, alternating-call, same-state read, and ineffective-write detectors still apply. The runtime records the assessment in its journal and gives a blocked `AGENT_NO_PROGRESS_DETECTED` result with route identity before the hard model-turn limit.

Root Vitest tests cover repeated failed command output, distinct reads, changing diagnostic output, a late successful edit, larger plans, and suppressed/denied calls. A live refactor attempt with per-turn hashes is required before claiming this threshold improves the R53 failure mode.
