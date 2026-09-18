# R13 sanitized intelligence training pipeline

Recorded: 2026-09-18

R13 extends the existing versioned 8-Bit dataset pipeline to schema version 2. The pipeline stores CodeForge-owned structured outcomes only; it does not retain raw prompts, private repository code, model-output text, credentials, command output, or fixture diffs.

## Ground-truth separation

| Row type | Ground truth | Intended learning signal | R12 RV-01 handling |
| --- | --- | --- | --- |
| `VERIFICATION_OUTCOME` | ForgeVerify/Completion Gate | verified success, verification failure, false completion | `VERIFICATION_FAILED` because the executed attempt did not complete |
| `ROUTE_OUTCOME` | provider/capacity observation | rate-limit and quota-failure likelihood | `QUOTA_EXHAUSTED` because the captured OpenRouter daily free-model quota was exhausted |

The second row does not transform the failed execution into a capability pass. It merely prevents the capacity event from being learned as a model-reasoning failure.

## Available features

Schema v2 captures role, task type, context tokens, tool calls, provider calls, topology, fallback use, verification state, latency, observed capacity/health, and an optional decimal cost field. Existing role qualification, discovery, capacity, and fleet observation rows remain compatible structured metadata. Every row is gated by training-use provenance before split freezing.

## Learning posture

- Deterministic 8-Bit and 16-Bit policies remain production authority.
- Existing split freezing rejects blocked training provenance and keeps simulations train-only.
- Any learned model remains a shadow recommendation until separately evaluated against verified outcomes and policy boundaries.
- No learned predictor is trained or promoted in this record; this is a safe data/labeling capability, not evidence of predictive quality.

Implemented extractors: `rowsFromBenchmarkOutcomes` and `providerFailureRowsFromBenchmarkOutcomes` in `packages/eight-bit/src/dataset/builder.ts`. Their unit coverage includes the two-label R12 rate-limit pattern without copying the benchmark's task text.
