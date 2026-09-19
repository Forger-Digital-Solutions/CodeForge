# R15 final disposition

## Result

`CODEFORGE_R15_NATIVE_FIRST_RUN_NOT_CERTIFIED`

`CODEFORGE_SETTINGS_REALITY_NOT_CERTIFIED`

The R15 implementation, focused regression tests, package build, and packaged-endpoint audit are complete. Certification is deliberately withheld: the required fresh-profile, installed Windows smoke and user-owned GitHub OAuth flow have not been observed in an ordinary interactive desktop session.

## Implemented closure

- The desktop distribution command now packages the production HTTPS cloud endpoint by default, rejects development and loopback endpoints, supports an explicit staging channel, and audits the generated ASAR before restoring the developer manifest.
- Settings controls have a documented source-of-truth matrix. Agent execution mode is persisted in trusted settings rather than renderer storage; runtime-setting and persistence failures are surfaced rather than reported as successful; provider mutations use the same durable write path.
- The production installer archive passed the endpoint auditor:

  ```text
  PACKAGED_AUTH_ENDPOINT_VALID=PASS
  channel=production
  endpoint=https://codeforge-cloud-va.onrender.com
  ```

  Installer: `apps/desktop/release/CodeForge-Setup-0.4.0.exe`

  SHA-256: `B3BAAE516E46391C71E35DF6757C602F1BDE750069EDE5D7C05A7C864EE69F34`

- Focused desktop checks passed: 47 tests covering release packaging, cloud endpoints, settings persistence/migration, and provider connections. The desktop workspace build and repository typecheck passed. Repository lint remains blocked only by pre-existing unused variables in `packages/ui/src/Composer.tsx` and `packages/ui/src/WorkspaceApp.tsx`.

## Production and native observations

On 2026-09-18, `https://codeforge-cloud-va.onrender.com/health/ready` reported a connected database, hosted inference enabled, and 33 eligible free models. The running service identifies as `0.2.0`, whereas the desktop/package work is `0.4.0`; `/v1/meta` did not advertise `HOSTED_TOOLS`. The desktop’s compatible text tool-protocol fallback remains necessary until a separately authorized cloud deployment updates the service.

The packaged app was launched in this agent environment and hit the previously investigated secure-renderer failure `RENDER_PROCESS_GONE=launch-failed:49`. The controlled Electron reproductions establish that this is the inherited Windows Job Object blocking renderer creation, before the application page loads—not an ASAR, endpoint, or application security-config failure. Electron sandboxing, context isolation, and web security remain enabled.

Native Windows UI automation is not available in the current session: the initialized computer-use bridge exposes Chrome and the Codex in-app browser only and reports no native-app control surface. It therefore cannot install, launch, or observe the normal installer flow. I did not substitute an unobservable launcher for the required native proof.

## Required completion evidence

Run this from an ordinary, unmanaged interactive Windows session with the supplied installer and a fresh CodeForge profile:

1. Install and launch `CodeForge-Setup-0.4.0.exe`; capture the first readable frame and confirm the packaged production endpoint is used.
2. Complete any first-run legal/age acknowledgement yourself, then complete GitHub OAuth yourself in the system browser. Do not enter a personal API key.
3. Verify the signed-in identity, preserved connection after restart, and a real hosted free agent task that reads a repository file, modifies it, runs a test, and produces an evidence-backed completion.
4. Exercise every Settings category/control against the [Settings truth matrix](../settings/SETTINGS-TRUTH-MATRIX.md), including persistence through restart and truthful runtime failures.
5. Record the outcome under this evidence directory. Only then may the two certification markers be changed to pass.

No paid provider, local model, sandbox bypass, relaxation of completion policy, or artificial success state was introduced.
