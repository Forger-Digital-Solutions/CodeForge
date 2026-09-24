# R31 Computer Use Audit

Implementation: `packages/computer-use` — `GovernedComputerRuntime` +
`WindowsComputerBackend` driving the real desktop via `powershell.exe -EncodedCommand`
(UTF-16LE base64 scripts; no shell quoting, no injection surface). Input primitives are real
Win32 calls: `SetCursorPos`, `mouse_event`, `SendInput` (UNICODE + VK). DPI-aware
(`SetProcessDpiAwarenessContext`) so coordinates aren't virtualized on scaled displays.
Sanitized child env via `getSanitizedEnvForChild`; 15s per-call timeout.

Proof on this host (real hardware, no stub):
- `computer_status` → `supported:true`, real bounds `{0,0,1920,1080}`, budget 120 actions, 250ms pacing
- `computer_screenshot` → real PNG `shots/computer-2026-09-24T12-17-29-360Z-b032e0b3.png`,
  sha256 `b032e0b3214aefb5e6309880da72e0f07ac9db9fd82758040d70134a391fd0f5`
- Negative: `computer_mouse_click` at (−99999,−99999) → refused `COMPUTER_INVALID_TARGET`
  (out of bounds) **before** any input injection
- Negative: `computer_key_press` with empty keys → refused `COMPUTER_INVALID_TARGET`

Guardrails verified in code + tests (`packages/computer-use/test`): session action budget,
min-action interval, max type length, screen-bounds validation per action, multi-monitor opt-in,
hashed evidence receipts (image bytes never enter model context — receipts only).

Permission posture: all six tools require `executeCommand`; input-injection tools are
`executionClass: command` → highest approval tier on interactive runs.

Honest limitation (§26 grounding): input is coordinate-space — no UIA/window-title/focus
grounding and no automatic post-action re-observation (a `computer_screenshot` must be issued
explicitly). Bounds-checked and budgeted, but not element-grounded. This is
**IMPLEMENTED_PARTIAL**, not a release blocker for an opt-in capability that is off by default.

Classification: **IMPLEMENTED_NEEDS_MORE_PROOF** (real backend proven; grounding is partial).
