# R26 Phase 9 — Browser / Terminal / Tool Permission Audit

**Date:** 2026-09-22
**Authority:** `packages/permissions/src/index.ts` (`TaskAuthority`, `classifyAction`)
**Enforcement:** `packages/server/src/agent-runtime.ts` (`describeAction` → `resolve`, line ~4474 policy gate)
**Tests re-run at HEAD:** `packages/permissions/test/authority.test.ts` (21), `packages/browser/test/tools.test.ts` (5), `packages/server/test/approval-lifecycle.test.ts` (13), `packages/server/test/approval-session-grants.test.ts` (5) — **44/44 green**

## Model

Five risk tiers, deterministically classified — the model never self-classifies:

| Tier | Class | Policy |
|---|---|---|
| 0 | reads inside workspace, checkpoints | allow |
| 1 | reversible workspace edits, verify/build commands | allow unless `ask_more` |
| 2 | project-modifying commands, dep installs, browser interactions, reads outside workspace | ask unless grant or `full_autonomy` |
| 3 | externally-visible side effects, writes outside workspace, high-risk/unclassified | **always ask** — no mode, no grant |
| 4 | sensitive/destructive/financial | always ask |

Invariants verified in code + tests:

- Grants (`action` / `command_prefix` / `directory`) **never cover Tier 3/4** — `grantCovers` returns false above tier 2 (`index.ts:173-191`).
- Read-only subagent actors (`explorer`, `planner`, `reviewer`) are denied writes and non-trivial exec outright — a subagent cannot inherit the parent's authority (`index.ts:259`).
- Tier-3/4 asks **cannot mint session grants** — `grantPatternFor` returns undefined; the UI cannot offer persistence there.
- Every decision emits a durable `PolicyReceipt` (sessionId, tool, tier, decision, mode, source) — receipt-sink failure cannot change the outcome.

## Surface-specific findings

**Terminal (`run_command`):** `classifyCommand` categorizes (read-only /
verify-build / dependency-install / network-sensitive / externally-visible /
high-risk) and risk follows category — `externally visible` → Tier 3 even in
`full_autonomy`. Network-denied runs reject network-sensitive and
externally-visible commands at dispatch (`agent-runtime.ts:1941`).

**Browser tools:** `browser_submit` and `browser_type(submit=true)` classify as
`external`/high → Tier 3 always-ask (a submitted form can commit remote state,
same class as `git push`). `browser_click`/`browser_type`/`browser_select`/
`browser_close_tab` → Tier 2 interact. `browser_launch`/`browser_close` →
Tier 2 moderate. All other `browser_*` → Tier 0 read.

**MCP tools (`mcp__*`):** the MCP registry is the sole classifier — servers
never self-declare their tier; **unknown effect fails closed to "external"
(Tier 3, always asks)**.

**Unknown tools:** default to Tier 3 outside-workspace — fail closed.

## Live-session evidence (from packaged smoke, Phase 8)

- `control_plane_forged_approval_rejected=PASS` — a forged renderer approval
  cannot authorize a held action.
- `electron_restart_no_approval_replay=PASS` — approvals are not replayed after
  a crash/restart.
- Session grants: ask-once then honor for task; Allow-Once re-asks every time;
  grants do not cross session leases (5/5 grant tests).

## Verdict

`R26_PERMISSION_AUDIT_CLEAN` — the permission boundary is deterministic,
receipt-backed, and enforced on every mutating surface including browser and
MCP; tier-3+ authority can never be granted away.
