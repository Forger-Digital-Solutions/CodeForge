# R27 ForgeGreen Baseline & Attribution Plan

## R26 result recovered

R26 has one valid live pair on `groq::openai/gpt-oss-20b` where the optimized arm
completed correctly but used 19 provider calls / about 40.9k tokens / about 277s,
versus 14 calls / about 32.6k tokens / about 235s for control. That is a valid
negative result for the measured configuration and remains part of the R27 baseline.

## Attribution finding

The R26 campaign arm definition changes more than ForgeGreen mechanisms:

- ForgeGreen advisor;
- duplicate read-only suppression;
- tool-output compression;
- ForgeGreen cache;
- context planner;
- memory delivery;
- verification reuse;
- adaptive topology versus single-agent topology.

Therefore the R26 live pair proves that the production optimized configuration was
slower and more expensive on that tiny task. It does not isolate which of those
mechanisms caused the overhead. R27 will not relabel that result as a pure ForgeGreen
regression or hide it.

## R27 experiment arms

The campaign will report two separate comparisons:

1. **Mechanism A/B:** same single-agent topology, same context and verification
   policy, only one ForgeGreen mechanism toggled at a time. This measures safe work
   avoidance without confounding orchestration.
2. **Production topology A/B:** ForgeGreen production defaults versus control on
   the same golden task, with topology, subagent count, context bytes, calls, tokens,
   wall time, retries, and correctness all recorded. This measures the user-visible
   system result, not a component-only claim.

An efficiency win is valid only when the completion-gate outcome, hidden verifier,
requirements, and safety result are non-inferior to control. A tiny-task loss remains
useful evidence and should drive minimal activation rather than threshold gaming.

## Immediate topology correction

The deterministic task classifier now recognizes a narrow class of detailed,
single-file return-value bug reports as `tiny` when they contain no investigation or
breadth signal. The topology remains `Coder → ForgeVerify`; no reviewer, planner, or
subagent is added by this change. This is a complexity-classification correction, not
a relaxation of verification.

## R27 hypotheses

- Tiny tasks should use a minimal topology and avoid speculative context planning.
- Small tasks may benefit from selective read-only reuse but should not pay full
  multi-agent orchestration overhead without evidence.
- Medium/large tasks are the first candidates for full ForgeGreen and subagent value.
- Provider-stateless context retransmission remains a separate efficiency ceiling and
  must not be counted as ForgeGreen savings.

Status: `BASELINE_LOCKED; CONTROLLED_AB_NEXT`
