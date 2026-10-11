# ForgeAAA Auto — Architecture Baseline (R77)

Recorded before implementation, per ForgeAAA mission §2. Baseline commit: `f8cd589f`
(shared head of `codex/r75-reliable-free-autonomous-coding` and
`codex/r76-free-supply-recovery-and-reliability`, 2026-10-10). Work proceeds on branch
`codex/r77-forge-aaa-auto` in `worktrees/forge-aaa-auto`.

## Verified repository state

- Main checkout `G:\CodeForge` is on `codex/r29-release-closure` (6f8ad979) with unrelated
  uncommitted changes — preserved, untouched.
- `worktrees/r76-free-supply-recovery-and-reliability` carries in-progress uncommitted work
  (packaging isolation, planner contract repair). Preserved — ForgeAAA does not merge or
  discard it.
- No Blender/UE/computer-use engine adapter exists today. `packages/computer-use` is a
  desktop-automation policy layer, not an engine bridge. `packages/mcp` is a governed MCP
  client (stdio + streamable-HTTP, trust policy, bounded output) and is the correct seam for
  external Blender/Unreal bridges when such servers are user-authorized.

## Existing orchestration modes (verified in code)

| Mode | Authority | Execution path |
|------|-----------|----------------|
| ForgeAuto/Free (`auto`) | `ForgeZero` firewall + `FreeCloudRegistry` 8-Bit admission + `FreeFabric` capacity | `ModelExecutionAdapter.resolveModel` → free route; role dispatch via `rosterAllowance` |
| Paid Auto (`paid-auto`) | `PaidAutoService` canonical registry, per-role verdict book, budget gate, kill switch | `PaidAutoProviderAdapter` in `providerCatalog`; `paid-auto/auto` sentinel resolved per-role by `selectRoleRoute` in `agent-runtime` |
| GEMS Auto | `planGemsAutoScenario` — simulation-only, no provider adapter | none (fail-closed planner) |
| 8-Bit | free-cloud admission/qualification pipeline | feeds ForgeAuto eligibility |
| 16-Bit | paid role-ranking (`rank16Bit`) inside Paid Auto | `selectRoleRoute` |

Key reusable infrastructure confirmed:

- `resolveForgeAutoRole`/`rosterRouteAllowance` (`server/src/forgeauto-roster.ts`) — role →
  eligible route allowance across `MANAGED_FREE` / `MANAGED_PAID` / `USER_API` domains with
  entitlement gates. ForgeAAA consumes this rather than re-implementing routing.
- `SpawnChildOptions.rosterAllowance` (`subagent-manager.ts`) and the agent-runtime dispatch
  loop — per-role route filtering, failover, tool-call recording already exist.
- `AutonomousRunOrchestrator` — durable parent state, checkpoint, worktree isolation,
  completion gate (`evaluateCompletion`), bounded review rounds, watchdog. ForgeAAA runs ride
  this pipeline; `completed` remains gate-enforced only.
- `ISessionPersistence` work items — durable roster/policy/manifest storage pattern
  (`forgeauto-roster-<hash>`), reused for ForgeAAA policy + qualification records.
- `ModelSelector` / `buildCanonicalModelSections` — picker sections are server-data-driven;
  a `forge-aaa` tier + section is additive.

## Environment facts (this machine)

- Blender 4.5 installed: `C:\Program Files\Blender Foundation\Blender 4.5\blender.exe`.
- Unreal Engine 4.27.2 installed: `C:\Program Files\Epic Games\UE_4.27`
  (`Engine\Build\Build.version` — Changelist 18319896, promoted build).
- Dead Trails West: **no `.uproject` or farmhouse assets exist on this machine** —
  `Documents\ChatGPT\Dead Trails West` is an empty git repo; the AppData path is an Epic
  launcher webcache. Gate 6/7 pilot prerequisites are absent → pilot reports BLOCKED.

## ForgeAAA integration approach

- New package `packages/forge-aaa` (`@codeforge/forge-aaa`): specialty contracts, candidate
  registry with evidence-bound classification, lead-policy resolution, capability router,
  asset manifests + versioned store, Blender/UE adapters, hardware scheduler, verification
  pipeline, director state machine.
- Server: `forge-aaa` provider domain registered like `paid-auto`; `/api/models` projection;
  `/api/forge-aaa/status|policy`; `mode: "forge-aaa"` on `/api/orchestrator/run` synthesizes
  an entitlement-bounded roster (never expands MANAGED_* eligibility).
- Execution delegates through existing adapters: paid leads → `paid-auto` adapter (inherits
  kill switch, budget gate, telemetry); free leads → free routes authorized by the same
  dispatch authority; user-api leads → user adapters. No new billing path.
- Named leads (GPT-6.1 Sol, Claude Opus 5.5) register as candidates classified
  `UNAVAILABLE` until a connected provider actually reports them — no invented provider IDs.
