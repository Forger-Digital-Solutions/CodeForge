# R27 ForgeGreen Fixture Preflight

Status: `R27_FORGEGREEN_PREFLIGHT_COMPLETE`

This command verifies that the digest-locked golden-task reference fixtures are usable preconditions for a later A/B campaign. It does not instantiate ForgeGreen, AgentRuntime, or a model arm, and it never writes aggregate A/B evidence.

- Reference verifier passes: 13/15
- Environment-blocked tasks: 2
- Precondition failures: 0

The blocked Python tasks remain blocked rather than being counted as passes.
