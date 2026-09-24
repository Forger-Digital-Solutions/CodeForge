# R32 Computer Use Audit — Semantic Grounding

Implementation: `packages/computer-use` — `GovernedComputerRuntime` +
`WindowsComputerBackend` driving the real desktop via `powershell.exe -EncodedCommand`
(UTF-16LE base64 scripts; no shell quoting, no injection surface). Input primitives are real
Win32 calls: `SetCursorPos`, `mouse_event`, `SendInput` (UNICODE + VK). DPI-aware
(`SetProcessDpiAwarenessContext`). Sanitized child env; 15s per-call timeout.

## R32 upgrade over R31

R31 classified this surface IMPLEMENTED_PARTIAL: coordinate-space input only, no UIA
grounding, no post-action observation. R32 adds the semantic layer:

- `backend.uiaElements(max)` — one PowerShell call enumerating the UI Automation control
  view (name, automationId, controlType, className, processId, bounds, runtimeId, enabled,
  offscreen, keyboard focus).
- `inspectUi(query)` — observation tool, no action budget; returns filtered elements plus a
  `treeHash` fingerprint of the whole enumerated state.
- `locateElement`/`clickElement`/`typeIntoElement` — semantic target resolution with
  **fresh UIA enumeration on every call** (nothing cached: a UI that changed simply fails
  closed). Actions verify afterward by re-enumerating and comparing (`uiChanged`,
  `targetAfter: changed|unchanged|gone`, `hasKeyboardFocus`).
- Recoverable errors: `COMPUTER_TARGET_NOT_FOUND`, `COMPUTER_AMBIGUOUS_TARGET`.
- Policy parity: `maxUiaElements` (default 600) configurable via external-tools config.
- Tools: `computer_inspect_ui`, `computer_click_element`, `computer_type_into_element`
  (9 tools total).

## Live Windows proof (this host, real desktop, commit e8c959e)

- `uiaElements(600)` → 600 real elements: taskbar buttons with AutomationIds
  (`StartButton`, `SearchButton`), tray icons, pinned apps, window trees.
- `inspectUi({})` → 171 onscreen elements, `treeHash` `1965535c…`.
- `locateElement({automationId:"StartButton"})` → `"Start" ControlType.Button` at (655,1050).
- `locateElement({name:"NoSuchElementXYZ123"})` → `COMPUTER_TARGET_NOT_FOUND`.
- `locateElement({name:"Search"})` → `COMPUTER_AMBIGUOUS_TARGET` (button + text match).
- `clickElement({automationId:"StartButton"}, left, 1)` → real click; receipt
  `verification: {uiChanged:true, targetAfter:"gone"}` — the Start menu opened and the
  taskbar tree rebuilt; the receipt reports this honestly rather than asserting a blind
  success.

## Live-environment defects found and fixed (e8c959e)

- `Condition.ControlViewCondition` materializes as **null** on some .NET/PowerShell
  combinations (`Add-Type` loads the assembly but the composed AndCondition never
  constructs). The backend now constructs the semantically identical
  `PropertyCondition(IsControlElementProperty, true)` — correct on both.
- PowerShell emits stdout in the **OEM codepage**: U+2192 (→) in a real element name
  ("Restart to Update →") became byte 0x1A in cp437 — a raw control character inside the
  JSON payload that broke parsing at >100 elements. `[Console]::OutputEncoding` is now
  forced to UTF-8 in the shared preamble; projected strings are also stripped of C0/DEL
  control characters as defense-in-depth.

## Tests

`packages/computer-use/test`: **33/33 green** — semantic grounding, re-grounding after UI
change, verified action receipts, ambiguity, permission gating, budget pacing.

Permission posture: all nine tools require `executeCommand`; input-injection tools are
`executionClass: command` — highest approval tier on interactive runs.

Classification: **IMPLEMENTED_AND_LIVE_PROVEN** (semantic grounding + verified actions on
real Windows). Coordinate tools remain for targets UIA cannot see.
