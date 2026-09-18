# CodeForge Electron renderer-blocker investigation

**Date:** 2026-09-18  
**Product version:** 0.4.0  
**Source baseline:** `ce53bc788368473d2d77c644e90337c00ad17b34`
**Verdict:** `ENVIRONMENT BLOCKER FOR THIS AGENT LAUNCH CONTEXT; HOST-NATIVE VALIDATION STILL REQUIRED`

## Symptom

The repaired portable and unpacked desktop artifacts start the CodeForge main process, credential
store, ForgeZero, provider catalog, local server, and renderer-file resolution. Chromium then
reports `RENDER_PROCESS_GONE=launch-failed:49`; `loadURL()` rejects with `ERR_FAILED (-2)`.

Electron defines `launch-failed` as a renderer that never successfully launched, and specifies
that its exit code is platform-specific rather than a generic Windows error number. See the
[Electron `RenderProcessGoneDetails` reference](https://www.electronjs.org/docs/latest/api/structures/render-process-gone-details).

## Product artifact checks

| Check | Result |
| --- | --- |
| Internal package audit | PASS — all 22 shipped `@codeforge/*` packages, including `@codeforge/intelligence` |
| External runtime dependency audit | PASS — 303 packaged modules and 15 external packages |
| Renderer HTML | Present and readable from the ASAR |
| Production preload | Present and readable from the ASAR |
| Production URL | Canonical `file:///.../app.asar/apps/desktop/dist/renderer/index.html` |
| Production security posture | `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true` |

The prior `@codeforge/intelligence` omission was a separate main-process packaging defect. It is
fixed by `f5b4342` and is not present in this investigation.

## Case-A / Case-B result

This is **Case A: renderer process creation fails**. The minimal control emitted
`render-process-gone` immediately after `new BrowserWindow(...)`, before `loadURL()` was reached.
It emitted no `dom-ready`, `did-frame-finish-load`, `did-finish-load`, `preload-error`, or renderer
console marker. Therefore the accompanying document-load error is downstream of renderer creation,
not evidence that the renderer URL, ASAR entry, preload, CSP, or React bundle is the cause.

## Electron 44.4.1 minimal secure control

`apps/desktop/sandbox-minimal-diagnostic` was reduced to a packaged Electron 44.4.1 application
with no `@codeforge/*` modules in its ASAR, a 278-byte local HTML document, and a 148-byte local
preload. Its only BrowserWindow uses the same secure posture as production. It records Electron,
Chromium, Node, executable and ASAR paths, file sizes/hashes, generated URL, GPU feature state,
renderer lifecycle, preload errors, console errors, and child-process events. It records no
credentials, tokens, or provider keys.

| Variant | Result |
| --- | --- |
| Production software compositor (`disableHardwareAcceleration`, `disable-gpu`, `in-process-gpu`) | `RENDER_PROCESS_GONE=launch-failed:49` before loading the minimal document |
| Electron default graphics path | Same renderer launch failure; the GPU process also exited with `-1073741515` (`0xC0000135`) |

The production software-compositor variant still fails without a GPU child-process failure, so the
default-GPU crash is an environment observation, not the root cause of the secure renderer failure.

## Managed-launch evidence

The Codex command shell reports `IsProcessInJob=true`. A running packaged minimal-control process
started by that shell also reports `IsProcessInJob=true`. This proves that the control inherits the
same Windows Job Object containment as the product launch. The secure minimal control, with no
CodeForge application code or runtime packages, fails within that containment with the same
platform-specific renderer-launch error.

No related Application or Code Integrity event was available in the local Event Viewer window
queried during the experiments. No claim is made about a more specific Windows policy mechanism
beyond the proven job-contained launch constraint.

## Conclusion

The remaining failure is not caused by CodeForge renderer code, the renderer URL, ASAR layout,
preload, internal package graph, CSP, or the production graphics configuration. It is caused by
attempting to create a sandboxed Chromium renderer from the agent's inherited Windows Job Object.
No production sandbox, isolation, web-security, CSP, or permission setting was changed.

The experiment does **not** certify the current artifact on an ordinary unmanaged host. Historical
host-native evidence is useful context but cannot certify the newly repaired 0.4.0 bytes. The next
required evidence is a fresh-profile launch of the exact current portable or installed setup from
an ordinary interactive Windows process outside this agent containment.

## Current artifacts

| Artifact | SHA-256 |
| --- | --- |
| `apps/desktop/release/CodeForge-Portable.exe` | `A6F607A1E56A637D5E286B574508191C0779561E1939CBEFF9E23797144A0301` |
| `apps/desktop/release/CodeForge-Setup-0.4.0.exe` | `E56C68D1501B31D94C0BCF6C84D723A48E3971B49CDD13B2199006C25F1C3D82` |

Both artifacts are unsigned. The setup has not been installed; no silent install was substituted
for the requested normal Windows installation.

The exact rebuilt portable was also launched under a fresh profile from this agent context. It
passed all main-process startup markers through ForgeZero, provider catalog, credential store, and
local-server binding, then failed only at secure renderer creation with `launch-failed:49`. Its
embedded ASAR passed both the internal and external runtime dependency audits.

## Current regression status

- Focused Electron security, startup, preload, control-plane, and packaged-browser checks: **42
  tests passed**.
- Workspace typecheck, lint, build, internal package audit, external runtime audit, and packaged
  browser-security audit: **PASS**.
- Focused security suite: **120 tests passed**.
- The full Vitest run was launched and its worker later exited, but the restricted runner detached
  before returning its aggregate result or exit code. It is therefore recorded as **inconclusive**,
  not passed.
- `test:postgres:full` remains **blocked**: the harness exits `4294967295` and WSL returns
  `Wsl/EnumerateDistros/Service/E_ACCESSDENIED`. No SQLite substitute was used.

## Required host-native completion

1. Verify the current artifact hash, then launch the portable from Explorer with a fresh profile or
   install the setup through the normal Windows UI.
2. Verify first paint, preload bridge, trusted IPC, normal-profile migration, provider settings,
   and the 8-Bit / ForgeGreen / Paid Auto foundations.
3. Run a disposable-repository agent task through ForgeVerify, then interruption/recovery and
   performance checks.
4. Rebuild and re-hash if any production source changes. Do not treat this agent-contained control
   failure as a reason to weaken Chromium or Windows security.
