# R21 Browser / Computer-Use + MCP/Plugin Surface Audit (M7, audit-only)

Recorded: 2026-09-20
Branch: `forger-digital-solutions-forgegreen-certified`
Spend: `$0` — audit only; no code changes, no provider calls.

## Verdict

| Capability | Status | Evidence |
|---|---|---|
| Browser / computer-use tool for agents | **ABSENT — not certifiable** | `BUILT_IN_TOOL_DEFINITIONS` in `packages/tools/src/index.ts` lists 19 tools: file ops, command, repo-intelligence, checkpoint. No `browser`, `web_fetch`, `navigate`, or `screenshot` tool exists. No `playwright`/`puppeteer` dependency anywhere in the workspace (`grep` over all `package.json` returns nothing). All `browser*` references in the tree are OAuth flows (`packages/cloud-auth`) and product UI — not agent capability. |
| MCP client | **STUB — not certifiable** | `packages/mcp/src/index.ts` is 12 lines: `McpClient.listTools()` returns `[]` unconditionally, `constructor` ignores its server command. No transport, no handshake, no tool bridging into `ToolRegistry`, no tests. The package compiles — which is exactly the "interfaces exist" failure mode this campaign exists to reject. |
| Extension/plugin host | **REAL — implemented** | `packages/plugins` (786 lines): manifest parsing with engine-version gating, extension host lifecycle, per-extension settings + secret store, install/enable/disable state, filesystem failure modes degrade to per-extension errors. Test suite `extensions.test.ts` exists. Whether contributed capabilities reach the *agent* surface is a separate question (plugin-contributed tools are not wired into `ToolRegistry` — see below). |

## Why no code shipped in this increment

A governed browser tool is a feature build, not a defect fix: it needs a browser driver
dependency (none vendored), URL/egress policy, SSRF guards, credential isolation,
screenshot/download boundaries, and interaction with the permission tier engine
(network-bound = Tier 3 by the repository's own taxonomy). Shipping a shell tool that
returns canned results would violate the campaign's own rule against claiming capability
from interfaces.

Same for MCP: a real client is stdio JSON-RPC lifecycle + schema bridging + per-server
permission policy. The existing stub is evidence that the surface was scaffolded and never
implemented — recording it honestly rather than treating the package's presence as
progress.

## What the audit did establish (boundaries for any future implementation)

1. **Egress is already governed in spirit**: the M6 fix made `network:false` real for
   `run_command`. Any browser/fetch/MCP tool must register `requiredPermission` semantics
   or equivalent — the ToolBroker already gates on permission flags, so a browser tool
   declared `readOnly: false` + network-gated inherits real enforcement.
2. **Untrusted-content boundary exists**: `formatUntrustedData` wrapping is the established
   convention; browser DOM/network content is strictly untrusted input and must flow
   through it, never into authority surfaces.
3. **Sensitive-path + secret-redaction already apply** to every tool result — a browser
   tool inherits output truncation/redaction for free through `ToolBroker`.
4. Plugin-contributed tools are **not** bridged into `ToolRegistry` — an extension can
   declare contributions but no path injects them into agent dispatch. Recorded as the
   natural seam for MCP/tool bridging later.

## Certification labels

- Browser/computer-use: **NOT CERTIFIED — capability absent**
- MCP client: **NOT CERTIFIED — stub only (12 lines, returns `[]`)**
- Plugin host: **IMPLEMENTED, partially verified** (suite green; agent-surface bridging absent)
