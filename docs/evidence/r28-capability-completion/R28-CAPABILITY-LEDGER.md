# R28 Capability Ledger

**Date:** 2026-09-23 · **Baseline:** `2e48ea9` on `forger-digital-solutions-forgegreen-certified`
**Scope:** one user, one CodeForge — capability completion and proof, no multi-user work.

Levels: `ABSENT` → `STUB` → `IMPLEMENTED` → `TESTED` → `DETERMINISTICALLY_PROVEN` → `LIVE_PROVEN` → `PACKAGED_PROVEN` → `ENDURANCE_PROVEN`. `BLOCKED`/`NOT_PROVEN` mark gaps. A higher level never follows from a lower one without receipts.

## Phase 1 — Recovery

- HEAD `2e48ea9` verified; R27 final commits `96486b5`, `b1fac3c`, `2e48ea9` present.
- Protected `R27-GOLDEN-TASK-VALIDATION.json` is the only uncommitted change — left unstaged/untouched.
- One pre-existing stash (`task-fix forgegreen work`) left untouched.
- No CodeForge/Electron processes running at recovery.

## Phase 3–5 — Packaged renderer startup: ROOT CAUSE RESOLVED

**R27 symptom:** `RENDER_PROCESS_GONE=launch-failed:49`, `ERR_FAILED` inside `app.asar`.
**R8 forensics** (`docs/evidence/desktop-release/renderer-blocker-investigation.md`) already proved a
zero-CodeForge minimal Electron 44.4.1 control failed identically inside the previous agent shell's
restrictive Windows Job Object — exonerating the product but lacking positive proof.

**R28 result:** this Devin shell is also `IsProcessInJob=true`, yet the **exact R27-built artifacts**
(identical SHA-256: Setup `672dfe75…`, Portable `3b279850…`, app.asar `35a31e67…`) launched the
sandboxed renderer and passed the **complete packaged smoke**:

| Mode | Result | Key receipts |
| --- | --- | --- |
| `full` | PASS (exit 0) | `PACKAGED_STARTUP`, `FORGEGREEN_RUNTIME`, `EIGHT_BIT_RUNTIME`, `CLOUD_DB_PACKAGED_RUNTIME`, `packaged_renderer_lifecycle_chain`, `packaged_zero_prompt_workflow`, `packaged_failure_repair_pass`, `packaged_renderer_reload_count=5`, settings roundtrip + invalid rejection, extension-host lifecycle, all 11 control-plane trust markers, credential store |
| `interrupt` | PASS (exit 73, expected) | `electron_restart_interruption_ready` |
| `recover` | PASS (exit 0) | `electron_restart_failed_safely`, `electron_restart_no_approval_replay`, credential fail-closed, `electron_restart_fresh_task`, `PACKAGED_RECOVERY_SMOKE_OK` |

**Classification:** prior `launch-failed:49` = launch-context environment (restrictive Job Object in
the prior agent shell), **not a product defect**. No sandbox, context-isolation, CSP, web-security, or
permission setting was weakened. Packaged startup on this host is now `PACKAGED_PROVEN`.

**Remaining:** installer install/upgrade/uninstall flows (Phase 6) and packaged endurance (Phase 35).

## Ledger (seed — updated through the campaign)

| Subsystem | Impl | Tested | Deterministic | Live | Packaged | Endurance | Key gap |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Core Agent | ✔ | ✔ | ✔ | ✔ **completion-gated** | ✔ | ✗ | sustained live; medium/large tasks |
| ForgeGreen | ✔ | ✔ | ✔ | ✗ | ✔ runtime | ✗ | live matched-pair efficiency + crossover |
| 8-Bit | ✔ | ✔ | ✔ | ✗ | ✔ runtime | ✗ | live quota/outage/recovery lifecycle |
| 16-Bit | ✔ | ✔ | ✔ | BLOCKED (policy) | ✗ | ✗ | completeness audit; no paid probes |
| ForgeAuto | ✔ | ✔ | ✔ | ✗ | ✗ | ✗ | live routing across task classes |
| Subagents | ✔ | ✔ | ✔ | ✗ | ✗ | ✗ | live crossover vs single-agent |
| Planner | ✔ | ✔ | ✔ | ✗ | ✗ | ✗ | live authorized useful plans |
| ForgeVerify | ✔ | ✔ | ✔ | ✔ | ✗ | ✗ | live verification on larger tasks |
| Context | ✔ | ✔ | ✔ | ✔ bounded | ✔ | ✗ | long-session growth/bounds |
| Memory | ✔ | ✔ | ✔ | ✗ | ✗ | ✗ | cross-session value + isolation |
| Browser | ✔ | ✔ | ✔ | ✗ | ✗ | ✗ | packaged nav/tabs/forms/downloads/localhost + hygiene |
| Computer Use | ABSENT | ✗ | ✗ | ✗ | ✗ | ✗ | entire capability (browser ≠ computer use) |
| Terminal | ✔ | ✔ | ✔ | ✗ | ✗ | ✗ | packaged interactive sessions, leak check |
| WSL | ✔ | ✔ 12/12 | ✔ | ✔ host | ✗ | ✗ | packaged proof, in-workflow routing, desktop surface |
| Git | ✔ | ✔ | ✔ | ✗ | ✗ | ✗ | packaged dirty/conflict/worktree/stash flows |
| GitHub | ✔ | ✔ | ✔ | ✗ | ✗ | ✗ | live OAuth + safe test-repo PR/CI cycle |
| MCP | ✔ | ✔ | ✗ | ✗ | ✗ | ✗ | real server lifecycle + permission gating |
| Plugins | ✔ | ✔ | ✗ | ✗ | ✗ | ✗ | contract + working integration lifecycle |
| Extensions | ✔ | ✔ | ✔ | ✗ | ✔ | ✗ | isolation, version compat, update behavior |
| Settings | ✔ | ✔ | ✔ | ✗ | ✔ | ✗ | per-setting functional audit + migration |
| Updater | ✔ | ✔ 5/5 live | ✔ | ✔ host feed | ✗ | ✗ | packaged update cycle, apply+restart, production feed |
| Authentication | ✔ | ✔ | ✔ | ✗ | ✔ credentials | ✗ | live OAuth lifecycle |
| Permissions | ✔ | ✔ | ✗ (R26 historical) | ✗ | ✗ | ✗ | current-HEAD recert + new-surface penetration |
| Diagnostics | ✔ | ✔ | ✗ | ✗ | ✗ | ✗ | bundle redaction proof |
| Installer | ✔ built | ✔ | ✗ | ✗ | ✗ | ✗ | install/upgrade/uninstall/retention flows |
| Recovery | ✔ | ✔ | ✔ | ✗ | ✔ | ✗ | mid-operation interruptions, stale receipts |
| Provider Mgmt | ✔ | ✔ | ✔ | ✔ preflight | ✔ | ✗ | sustained multi-route health |
| Endurance | ✔ | ✔ | ✔ 79/79 | ✗ | ✗ | ✗ | all live/packaged levels |
| Hardware Profile | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | real measurements; 2nd device if available |

## Execution order (active)

packaged launch proof ✔ → installer flows → canonical live completion gate → medium/large live tasks
→ Browser/Computer Use/Terminal/WSL/Git/GitHub/MCP/Plugins/Extensions → Settings/Updater/Auth/
Memory/Context/Recovery → permissions penetration → live ForgeGreen/Subagent/Planner/8-Bit/ForgeAuto
proofs → live + packaged endurance → hardware profiles → dogfood → demo → canonical regression →
recertification → final matrix + verdict.
