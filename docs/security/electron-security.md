# Electron Security

The desktop app (`apps/desktop`) is an Electron shell around the local control plane and the
React workbench. This document is the audit record for Phases 21, 22, and 56.

## Process model

| Process | Privilege | What it holds |
| --- | --- | --- |
| Main (`src/main.ts`) | Node + OS | Sealed secrets, the per-process control-plane bearer, the embedded local server, provider adapters |
| Preload (`src/preload.ts` → `preload.cjs`) | Bridge only | A fixed object of ~45 named methods, each an `ipcRenderer.invoke` to a specific channel; no raw `ipcRenderer`, no generic `invoke(channel)` passthrough |
| Renderer (`src/renderer`, React) | Chromium sandbox | UI state only; talks to the main process through `window.electronAPI` and to the local server over loopback HTTP (the bearer is attached by the main process at the network layer, so the renderer never holds it) |

## BrowserWindow policy (every window)

```ts
webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
```

Also true, and asserted by `apps/desktop/test/electron-security-baseline.test.ts`: no
`allowRunningInsecureContent`, no `webviewTag`, no `enableRemoteModule`/`@electron/remote`, no
`nodeIntegrationInWorker`/`InSubFrames`, no `experimentalFeatures`, no `additionalArguments`
(the bearer is never passed as a command-line argument), no `--no-sandbox`,
`--disable-web-security`, or certificate-error bypass switches, no custom
`setCertificateVerifyProc`. The packaged `app.asar` is re-checked at release time by
`scripts/audit-packaged-browser-security.mjs`.

## Navigation, popups, external links

- `will-navigate`: only the window's own document URL may commit; any other target is cancelled and, if it is `https:` (or `http://localhost`), handed to the OS browser. `file:`, `javascript:`, `data:` and everything else are dropped.
- `setWindowOpenHandler`: always `{ action: "deny" }`; safe links go to the OS browser. No child window ever inherits the preload.
- `shell:openExternal` IPC: `https:` or `http://localhost` only (`isExternalLinkAllowed`, ATTACK-013).
- No custom protocol handlers or privileged schemes are registered.
- Web permissions (notifications, media, geolocation, clipboard-read, …): **denied by default** via `setPermissionRequestHandler`/`setPermissionCheckHandler`; OS notifications are raised by the main process. Downloads: `will-download` is cancelled.
- Menu: `Menu.setApplicationMenu(null)` — no default accelerators (including DevTools shortcuts) in the packaged app.

## IPC

- Every `ipcMain.handle` validates the sender (`assertMainWindowSender` or an explicit `event.sender !== mainWindow?.webContents` check) — the baseline test enumerates all handlers and fails if one is unguarded.
- Payloads are type-checked and allowlisted: provider ids against `ALLOWED_PROVIDER_IDS`, API keys ≤512 chars, settings through `app-settings.ts` schema, close decisions against an enum, project paths bounded.
- `shell:execCommand` exists for workspace git chips only: binary pinned to `git`, first token must be an allowlisted read-only subcommand (`rev-parse`, `status`, `config` read of `user.name`/`user.email`), no global flags, no control characters (`git-exec-allowlist.ts`, tested).
- Credentials: the renderer can *set* and *delete* a provider credential and read a boolean status; it cannot read one. Cloud tokens are never exposed; Cloud calls are made by the main process.
- Renderer-originated requests to the local server carry the bearer only when they come from the trusted document of the primary window (`control-plane-trust.ts`, `shouldAttachControlPlaneToken`); a secondary or forged renderer gets 401 (packaged smoke `control_plane_secondary_renderer_unauthenticated`).

## Content Security Policy (renderer)

Source HTML (`src/renderer/index.html`) carries the development CSP; the production build
(`vite.config.ts` `strictProductionCsp`) removes `'unsafe-inline'` from `script-src`:

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: https://avatars.githubusercontent.com;
connect-src 'self' http://127.0.0.1:* http://localhost:*
```

No `unsafe-eval`, no wildcard sources, no remote scripts. `style-src 'unsafe-inline'` remains
because the UI sets inline styles programmatically; that is a documented, bounded exception.
The R1 renderer build was verified to contain a single external module script and no inline
script (`dist/renderer/index.html`).

## Local secret storage (Phase 22)

- Storage API: Electron `safeStorage` (DPAPI / Keychain / Secret Service). Values are `enc:<base64>` in `userData/settings.json`, written atomically (`tmp` + rename, mode 0600).
- Codec rules (`secure-credential-codec.ts`, unit-tested): sealed values only; plaintext is never returned; sealing throws instead of falling back; corrupt payloads fail closed; legacy plaintext is sealed in place at startup or, if the backend is unavailable, left untouched and unusable.
- Platform/server secrets are never stored on the device (there is nothing to store: hosted keys live in the Cloud).
- When secure storage is unavailable (some Linux sessions without a keyring), the app refuses to save credentials and says so; it never silently writes plaintext.

## Code signing, updates, fuses (honest status)

| Item | Status |
| --- | --- |
| Windows code signing | **NOT IMPLEMENTED** — releases are unsigned; README instructs SHA-256 verification against `SHA256SUMS.txt` (REQUIRES DEPLOYMENT CONFIGURATION: a signing certificate — see OWNER-ACTIONS) |
| Auto-update | **NOT IMPLEMENTED** — no updater; users download releases manually and verify hashes. Nothing fetches or executes remote code at runtime |
| Electron fuses (`RunAsNode`, `EnableNodeCliInspectArguments`, `OnlyLoadAppFromAsar`, …) | **NOT CONFIGURED** — ARCHITECTURALLY PREPARED: `@electron/fuses` can be added to the packaging step; tracked in OWNER-ACTIONS as a release-engineering task (no external input needed) |
| DevTools in production | No menu accelerators; `openDevTools` is not called; not force-disabled at the API level |

## Tests

| Test | Proves |
| --- | --- |
| `apps/desktop/test/electron-security-baseline.test.ts` | Window flags, switches, navigation/popup handlers, permission denial, IPC sender validation on every handler, preload surface, production CSP, codec wiring |
| `apps/desktop/test/packaged-browser-security.test.ts` + `scripts/audit-packaged-browser-security.mjs` | The same policy on the packaged bundle |
| `apps/desktop/test/preload-bridge.test.ts` | Shipped bridge equals typed bridge; no bearer; only handled channels |
| `apps/desktop/test/control-plane-trust.test.ts` | Bearer attached only to the trusted document's requests |
| `apps/desktop/test/git-exec-allowlist.test.ts` | Git bridge allowlist |
| `apps/desktop/test/secure-credential-codec.test.ts` | Local secret rules |
| `apps/desktop/test/renderer-csp.test.ts` | Source CSP shape |
| Packaged smoke (`npm run smoke`) | Real Electron: encrypted persistence, corrupt/plaintext credential rejection, renderer bearer absence, secondary-window 401, forged origin 403 |
