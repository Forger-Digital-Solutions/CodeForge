# CodeForge SubAgents R1

Status: Phase 0A / Phase 1A implementation
Flag: `CODEFORGE_SUBAGENTS_R1=true`

## Scope

R1 adds measurement and fixed safe worker instrumentation around the existing CodeForge runtime. With the flag enabled, autonomous runs use two bounded read-only Explore workers concurrently, one SWE worker in the existing isolated Git worktree, an independent Reviewer, and the existing ForgeVerify/completion path. The flag is off by default; omitting it or setting `subagentsR1Enabled: false` preserves the prior orchestration path.

The implementation does not add learned topology selection, multi-writer coordination, DAG scheduling, contract-surface conflict detection, 8-Bit maturity logic, or ACP interoperability.

## Shared records

`@codeforge/protocol` defines versioned schemas for:

- `TaskCapsule`: bounded assignment, goal, relevant files, known evidence, constraints, and required output;
- `SubagentRunWorkItem`: worker identity, parent run, role, permissions, allowed tools, workspace, budgets, lifecycle, telemetry, and artifact references;
- `ForgeEvalExperimentWorkItem` and `ForgeEvalOutcome`: matched control/treatment metadata and independent grading results;
- `subagent.lifecycle` and `subagent.artifact_written` workspace events.

The existing JSON `work_items` persistence is reused. No destructive or irreversible migration is required; SQLite and PostgreSQL store the new records through the existing additive work-item path.

Worker result bundles are redacted before persistence and addressed by a SHA-256 digest through a `forge://` reference. The UI can reconstruct worker details from lifecycle events and durable work items after a restart.

## Measurement

Worker records capture wall time, model requests, input/output tokens, tool calls, retry count, duplicate-work count, provider failures, model/provider identity when reported, and the configured execution budgets. Allowance units remain optional because the current provider/runtime contract does not expose an authoritative allowance counter; the schema leaves that value absent rather than inventing a cost.

`@codeforge/telemetry` provides a validated bounded process-local event buffer. `@codeforge/benchmark` provides a bounded outcome store and `ForgeEvalHarness`, which runs control and treatment executions under one validated Task Capsule, grades both through a supplied oracle, records the experiment metadata, and keeps execution completion separate from correctness.

## Rollback

Disable the feature with `CODEFORGE_SUBAGENTS_R1` unset or any value other than `true`, or pass `subagentsR1Enabled: false` to the server/orchestrator. Existing worker records remain readable; disabling the flag stops creation of new R1 worker/artifact instrumentation and does not delete existing data.

## Verification research

Targeted documentation checks were recorded on 2026-09-14. The design adopts the common evidence-backed principles of focused contexts, role-scoped tools, explicit background/foreground lifecycle, and independent verification without copying any competitor’s orchestration model:

- [ZCode Subagents](https://zcode.z.ai/en/docs/subagents)
- [Claude Code CLI usage](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [OpenAI Codex with ChatGPT](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan%28pdf%29)
- [Cursor Background Agents](https://docs.cursor.com/background-agent)
- [GitHub Copilot agents](https://docs.github.com/en/copilot/responsible-use/agents)
- [OpenHands file-based agents](https://docs.openhands.dev/sdk/guides/agent-file-based)
- [Agent Client Protocol overview](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/overview.mdx)

ACP is documented as future context only and is not implemented in R1.
