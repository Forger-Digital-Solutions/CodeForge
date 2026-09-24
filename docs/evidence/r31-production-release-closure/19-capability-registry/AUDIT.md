# R31 Capability Registry Audit

Generated inventory: `capability-inventory.json` (61 entries; tool surface enumerated from the
built packages, not transcribed). Generator: `benchmarks/r31/capability-inventory.mjs`.

## Canonical authority chain (traced)

1. `packages/tools` — `ToolRegistry` holds `BUILT_IN_TOOL_DEFINITIONS` (19 tools) plus any
   registered external definitions. `ToolBroker.executeTool` does lookup → JSON-arg parse →
   schema/sensitive-path checks → custom-executor delegation → `ToolExecutionRecord`.
2. `packages/server/src/external-tools.ts` — composition root for governed tools. Disabled by
   default (absent `~/.codeforge/external-tools.json` = byte-identical R21 surface);
   `CODEFORGE_EXTERNAL_TOOLS=0` hard-disables. Bridges: `browser_*` (opt-in),
   `computer_*` (opt-in, win32), `mcp__*` (explicit config), `plugin__*` (desktop extension host).
3. `packages/server/src/agent-runtime.ts` — registers `externalTools.definitions` per run; any
   external def lacking a governed namespace prefix (`browser_`, `mcp__`, `plugin__`) throws —
   external tools can never shadow a built-in.
4. `packages/permissions` — `TaskAuthority` resolves every action: deterministic tier
   classification (0–4), lease grants never cover tier ≥3, read-only subagent actors are
   hard-capped, every decision emits a `PolicyReceipt`.

## Verified behaviors (this session)

| Claim | Evidence |
|---|---|
| Tool surface enumeration is real | `capability-inventory.json` — 19 builtin + 11 browser + 6 computer definitions read from dist |
| Browser real on this host | `20-browser/browser-smoke.json` — Edge/headless launch, navigate loopback, DOM inspect, hashed screenshot, click/type receipts, `169.254.169.254` and `file://` navigations denied |
| Computer Use real on this host | `20-computer-use/` — `computer_status` reports real 1920×1080 bounds; `computer_screenshot` captured a real PNG (sha256 b032e0b3…) via PowerShell `CopyFromScreen`; out-of-bounds click and empty key list refused before input injection |
| MCP lifecycle real | `24-tool-servers/mcp-lifecycle.json` — 9 cases over the repo fixture: discover/invoke/close/reconnect/dead/degraded/refused |
| Hostile MCP annotation ignored | `lying_annotations_default_external`: `mutate_things` self-labels readOnlyHint → stays `external` |
| Deny effect enforced | `MCP_TOOL_DENIED` |
| Hung server bounded | `hang_tools_timeout`: call timeout fired at ~2s, server marked `degraded` with lastError |
| Malformed descriptors refused | `MCP_MALFORMED_DESCRIPTOR` |
| MCP secret output redacted | `secret_echo_redaction.leaked=false` (ghp_ token stripped) |
| MCP output bounded | `giant_result_truncation`: 2MB → 64KB cap + TRUNCATED marker |
| Crash containment | `crash_after_init`: transport onclose → `dead` |
| Extension sandbox | `packages/plugins/src/host.ts` — `node:vm`, no require/process/fs/net; eval 3s / lifecycle 5s / command 10s timeouts; result ≤16KB; failure → status `error` |
| Extension lifecycle | `manager.ts` — discover/install/enable/disable/uninstall, dev-mode, engine-compat check, secret-store cleanup on uninstall; desktop IPC + settings UI (`ExtensionsSection`) |
| Plugin→tool bridge | `pluginCommands()` re-enumerates per access — disable takes effect next run without restart; all bridged commands write-gated Tier 2 |
| Permission bypass resistance | `external-tools-wiring.test.ts` 17/17 — network:false lease denies browser tools; Tier-3 `browser_submit` denied on autonomous runs; read-only subagents denied mutating external tools; MCP `external`-effect denied on autonomous runs |
| Secret redaction in external output | same suite — secrets stripped before record + model |
| Capability suites green | browser 4 files, computer-use 2, mcp 2, permissions 1, plugins 1, external-tools-wiring 1 = **11 files / 138 tests, all pass** |

## Known gaps (truthful)

- `marketplace` — **MISSING**. No remote catalog/storefront. Extension install is local-folder
  or dev-mode only. Per the R31 addendum scope (discover/inspect/install/manage/disable/remove)
  the local extension manager covers install→manage→remove; remote *discover* does not exist.
- `computer_use` grounding — IMPLEMENTED_PARTIAL. Coordinate-space injection with bounds
  validation, action budget (120/session), 250ms pacing, hashed PNG evidence. No UIA/window-
  title/focus grounding; post-action verification is by explicit `computer_screenshot`, not
  automatic re-observation.
- `vision` — screenshots persist as hashed evidence files; image bytes do not feed a vision
  model through the tool surface. Receipts only.
- `lsp` — package exists, not wired into the agent tool surface.

## Registry consistency check

- Agent-visible tool set = `ToolRegistry.getForRole(role, permissions)` — built-ins filtered by
  role/permissions + registered external defs. ✅ single authority
- Disabled surface ⇒ `definitions` empty ⇒ no phantom tools (verified: `DISABLED_SURFACE`
  returns `[]` and `execute` returns undefined → broker reports `TOOL_UNKNOWN`). ✅
- `plugin__` names are re-derived per access from live `pluginHost.list()` — a disabled
  extension's tools disappear on the next run. ✅
- MCP `deny` tools are enumerated (audit-visible) but refused at call time AND hidden from
  `toolDescriptors()`/`toolDefinitions()` (not advertised). ✅

## Subagent permission caps

`READ_ONLY_ACTORS = explorer | planner | reviewer` — write and tier>0 exec actions are denied
deterministically regardless of session mode; the denial emits a receipt. Tested by
`role-routing.test.ts` (24 matches in audit grep) and `external-tools-wiring.test.ts`.
