# R31 Browser Audit

Implementation: `packages/browser` — `GovernedBrowserRuntime` over `playwright-core` driving an
installed Chromium-family executable (`resolver.ts`: Edge/Chrome/Chromium channels or verified
executable paths; never auto-downloads).

Proof on this host: `browser-smoke.json`
- `browser_launch` → real session `browser-abd0f034-…` (isolated profile, no shared cookies)
- `browser_navigate` → loopback test page loaded (`http://127.0.0.1:56345/`, title R31Probe)
- `browser_inspect` → real DOM snapshot: 3 interactive elements with role/testid hints + snapshot hash
- `browser_screenshot` → persisted PNG `shots/shot-c4061ad4-…png`, sha256 `49e56e29…`, 9,599 bytes
- `browser_click` (role+name) and `browser_type` (label-targeted) → action receipts
- Policy negatives: `http://169.254.169.254/latest/meta-data` → **BROWSER_NAVIGATION_DENIED**;
  `file:///C:/Windows/.../hosts` → **BROWSER_NAVIGATION_DENIED**
- `browser_close` → session released

Test suite: `packages/browser/test` — policy.test.ts, runtime.test.ts, tools.test.ts,
verify.test.ts all green (part of the 138-test capability run). Runtime tests cover: isolated
sessions, multi-tab receipts, redirect-hop metadata denial, download quarantine (sha256, never
executed), console/network observation without cookies or auth headers, session limits.

Policy surface (`policy.ts` + `DEFAULT_BROWSER_POLICY`): https-only by default, loopback http
opt-in for dev targets, private-network/metadata denial, allowed/denied host sets, per-request
gate (a redirect into a denied target is blocked at request level — tested).

Effect mapping: every browser tool requires the `network` permission; `browser_submit` is a
mutating external write (Tier 3 → denied on autonomous runs, approval on interactive).
State-changing tools invalidate ForgeGreen read replays (`BROWSER_STATE_CHANGING_TOOLS`).

Classification: **RELEASE_CERTIFIED** (implementation + live proof + policy enforcement).
