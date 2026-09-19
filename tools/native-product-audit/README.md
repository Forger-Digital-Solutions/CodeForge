# CodeForge native product audit harness

Permanent release infrastructure for auditing the **installed** Windows application — the
installer artifact, the per-user installation, the registry, the real process tree and the live
renderer — rather than source-mode Electron, mocks or renderer-only tests. Introduced in R16.

Everything here observes real state. Nothing injects product state (no fixture accounts, no
seeded catalogs); the only environment the harness controls is an optional fault-injecting
proxy for the desktop's own Cloud traffic.

## Pieces

| File | Purpose |
|---|---|
| `CodeForgeProductAudit.psm1` | PowerShell module: installer identity (SHA-256, version resources, Authenticode, PE arch), silent install/upgrade/uninstall, installed-file inventory + suspicious-file classification, Apps & Features / install-key registry state, shortcuts, user-data inventory (sealed vs plaintext credentials), process-tree enumeration, console-window flash detection, launch with isolated or retained profile + DevTools port, native window control, graceful close with leak accounting, CPU/RSS sampling, %TEMP% diffing. |
| `cdp-driver.mjs` | Chrome DevTools Protocol driver for the real renderer (CLI + importable library): eval, text, screenshots, real mouse/keyboard input, lifecycle marks, console capture, accessibility/overflow/contrast audits, tab order, network emulation for the renderer, DPI emulation. |
| `contrast-audit.js` | In-page WCAG contrast audit evaluated by the driver. |
| `Invoke-InstallAudit.ps1` | Installer + installed-state audit (optionally runs the installer). |
| `Invoke-LaunchProbe.ps1` | Launch → first frame → idle resources → console windows → graceful close → stray processes. Fresh, retained or real profile. |
| `Invoke-LifecycleAudit.ps1` | Uninstall → (old release) → install-over-existing upgrade → relaunch → uninstall → reinstall (retained data) → full removal → reinstall (clean first run). Backs up and restores the audited profile. |
| `Invoke-NetworkFaultProbe.ps1` + `network-fault-proxy.mjs` | Deterministic Cloud outage / black hole / latency / flakiness for the installed app (Node's `NODE_USE_ENV_PROXY`), plus live recovery without restart. |
| `scenarios/ui-walkthrough.mjs` | Model picker, account menu, popovers, composer keyboard behaviour, tab order, contrast, every Settings section — screenshots + JSON. |

## Typical use

```powershell
# 1. Audit the artifact and the installed state (optionally installing silently first)
pwsh -File tools/native-product-audit/Invoke-InstallAudit.ps1 -ExpectedSha256 <hash> -OutputDirectory docs/evidence/<run>/01-install -Install

# 2. Fresh first launch, idle resources, clean exit
pwsh -File tools/native-product-audit/Invoke-LaunchProbe.ps1 -OutputDirectory docs/evidence/<run>/02-first-launch -Label fresh -FreshProfile

# 3. Drive the live renderer
$env:CDP_PORT = 9229
node tools/native-product-audit/cdp-driver.mjs text
node tools/native-product-audit/scenarios/ui-walkthrough.mjs docs/evidence/<run>/07-ui

# 4. Full lifecycle (uses a COPY of the profile for launches; backs up and restores the real one)
pwsh -File tools/native-product-audit/Invoke-LifecycleAudit.ps1 -NewInstaller apps/desktop/release/CodeForge-Setup-0.4.0.exe -OldInstaller <older setup> -OutputDirectory docs/evidence/<run>/12-upgrade

# 5. Cloud outage and recovery against the installed app
pwsh -File tools/native-product-audit/Invoke-NetworkFaultProbe.ps1 -Mode blackhole -ProfileDirectory <profile copy> -OutputDirectory docs/evidence/<run>/10-failure-recovery
```

## Notes

- Launches strip `ELECTRON_RUN_AS_NODE` from the child environment with `Remove-Item Env:` —
  PowerShell binds `$null` to a .NET string parameter as an empty string, and Electron treats a
  present-but-empty `ELECTRON_RUN_AS_NODE` as "run as Node" (every Chromium switch then fails with
  `bad option`).
- Electron's DevTools browser target does not implement `Browser.getWindowForTarget`; window
  state is driven natively (`Set-CodeForgeWindowState`).
- NSIS uninstallers copy themselves to `%TEMP%` and return immediately; `Uninstall-CodeForge`
  waits for the helper process and for the program directory to be released.
- Console-window detection samples visible `ConsoleWindowClass` windows every 40 ms for the
  duration of a run, so a terminal that flashes for a few frames is still caught.
