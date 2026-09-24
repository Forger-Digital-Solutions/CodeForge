# R31 Tools & Permissions Audit

## Tool schema validation

`ToolBroker.executeTool` (packages/tools/src/index.ts) order of enforcement:
1. Registry lookup — unknown name → `TOOL_UNKNOWN` (disabled/removed tools are not callable;
   no phantom tools).
2. Argument JSON parse — malformed JSON → `TOOL_ARGUMENT_INVALID`.
3. Sensitive-path gate — `read_file`/`write_file`/`edit_file` on sensitive paths →
   `TOOL_SENSITIVE_PATH_DENIED`.
4. Custom executor → built-in executor.

Malformed-input coverage: `packages/server/test/agent-security.test.ts`,
`hardening-adversarial.test.ts`, `external-tools-wiring.test.ts` — all green (138-test run).
MCP-bridged schemas are re-validated at connect time (`normalizeTool` refuses unsafe names,
non-object inputSchema, reserved-namespace collisions, >256 tools, post-namespace duplicates).

## Permission model

`packages/permissions` `TaskAuthority`:
- Deterministic tier classification 0–4; the model never self-classifies.
- Lease grants (`action` | `command_prefix` | `directory`, scope `task`) never cover tier ≥3 —
  shared-external/destructive actions re-confirm every invocation by design.
- Read-only subagent actors (explorer/planner/reviewer) denied mutations regardless of session mode.
- Every decision emits a `PolicyReceipt` (auditable; receipt sink failures can't change decisions).
- Mode semantics: `auto_review` (tier0–1 flow, tier2 asks), `ask_more` (tier≥1 asks),
  `full_autonomy` (tier≤2 flow; tier 3/4 still ask — full autonomy never crosses external/sensitive).
- Legacy `allow|ask|deny` modes normalize to nearest mode, never widen.

Approval UX scopes present: `allow_once` / allow-for-task (mints grant) / deny / cancel —
exercised in workflow tests (`workflow-*.test.ts` poll `pendingApprovals` and resolve them).

## Bypass resistance (tested)

`external-tools-wiring.test.ts` (17/17):
- `network:false` lease denies all browser tools at the broker permission gate.
- `browser_submit` denied on autonomous runs (Tier-3 external commit, no approval channel).
- MCP `external`-effect tools denied on autonomous runs; `network_read` permitted with grant.
- Read-only subagent roles denied mutating external tools even with network granted.
- Unknown/disabled tools → `TOOL_UNKNOWN`, not fallthrough.

Subagent caps: a denied action cannot be re-obtained by delegating — subagent roles are capped
in `resolve()` before grants/modes are consulted.

Classification: **RELEASE_CERTIFIED**.
