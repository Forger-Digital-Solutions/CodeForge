# R73 Windows candidate

R73 is based on R72 delivery `220b365c553bff0b1ee952fb6b96498c8ddea325`. The latest directory candidate was built from clean committed source `0e364facb2b89ebc0624557d5c4a7f7ffa23219f`. All five static audits pass. The earlier `eade8b0d7f775dd382cfae65b7ae80289a0aaa77` candidate and failure evidence remain preserved in their distinct output directory. No R73 candidate was installed or executed.

Preparation completed on 2026-10-10. The receipt harness [windows-candidate-receipt.mjs](../../../benchmarks/r73/windows-candidate-receipt.mjs) checks 35 fixed compiled modules plus the archived renderer bundle. All 36 match the frozen compiled bytes. It covers account storage/DTO/routing, paid qualification/estimates, provider/server policy paths, physical quota ownership, secrets, main/preload and Reviewer/BlockRun/Puter modules. It captures all five audits, matching main/renderer identity, dependency/lockfile state and executable/archive/native hashes. All five expected Connected Accounts/paid estimate/qualification controls are present. This harness does not execute the candidate or rebuild native dependencies.

## Current frozen account candidate

| Item | Current evidence |
| --- | --- |
| Source revision | `0e364facb2b89ebc0624557d5c4a7f7ffa23219f`, dirty=false |
| Main/renderer identity | `0.4.0`, same source and build time `2026-10-10T05:05:34.702Z` |
| Artifact | `G:\CodeForge\worktrees\r73-free-supply-and-completion\apps\desktop\release-r73-0e364fac\win-unpacked` |
| EXE SHA-256 | `3aba56e5502aeda95bc862498742f17ee81ff5555fc89823d353e56a8ee6ef20` |
| ASAR SHA-256 | `125d609e5a9ea2023ceb41b2b8cf538329b9e9b172f08fd96f21cc429edabafd` |
| Full workspace build / directory packaging | Both exit 0; cached Electron 44.4.1, Builder 26.15.3, existing npmRebuild=false |
| Static audits | Clean build identity, internal/external dependency closure, Electron browser security and development auth endpoint: 5/5 PASS |
| Module/renderer inclusion | 36/36 byte matches; all five account/paid UI controls present |
| Native files | 10 hashes recorded; ABI/runtime loading not executed or certified |
| Signature | Direct host observation: NotSigned. Retained subprocess probe: UNAVAILABLE due security-module loading |
| Execution and installer | Not executed; no installer build/lifecycle certification or production deployment |

`windows-artifact-manifest-0e364fac.json`, `windows-workspace-build-0e364fac.json`, `windows-package-build-0e364fac.json` and `windows-signature-direct-0e364fac.json` bind the candidate. The source was tracked-clean during build and archive audit. The Node-spawned signature probe did not establish a status; the separate direct check did. Generic Builder signing messages are not proof of signing. No unchanged failed VM configuration was replayed, and no signing requirement was weakened.

## Preserved frozen candidate

| Item | Verified prior candidate |
|---|---|
| Source revision | `eade8b0d7f775dd382cfae65b7ae80289a0aaa77`, dirty=false |
| Build stamp | Main/renderer `0.4.0`, built 2026-10-09T10: 19: 50.793Z |
| Artifact | `apps/desktop/release-r73-final/win-unpacked` |
| EXE SHA-256 | `f916673dc368b195beb1193dd11752f0f8fb8f723911eff164e4675bc3cd67c4` |
| ASAR SHA-256 | `59a7b58378f484fddcc929154b663c9923e3012fb3daf68cc41868e9e6fd9aff` |
| Static audits | Build identity, internal dependencies, external runtime dependencies, browser security and development auth endpoint: 5/5 PASS |
| Compiled inclusion |15 important prior modules matched archive bytes |
| Signature | Direct host PowerShell `Get-AuthenticodeSignature`: NotSigned |
| Runtime/installer | Not executed; no installer lifecycle or signing certification |

`windows-artifact-manifest-eade8b0d7f77.json`, `windows-package-build-eade8b0d7f77.json` and `windows-signature-eade8b0d7f77.json` are authoritative for this candidate. The Node-spawned PowerShell signature probe could not load the security module and returned UNAVAILABLE; that failed probe is retained in its own receipt rather than interpreted as NotSigned. The direct host read-only signature observation establishes NotSigned for the preserved EXE.

## Build preparation

R72's [package receipt](../r72-free-supply-and-autonomy/windows-artifact-manifest.json) and [build log](../r72-free-supply-and-autonomy/windows-package-build.log) establish the reusable candidate procedure: full workspace build, then Electron Builder directory packaging for Windows x64 with the existing `npmRebuild=false` setting, then five static archive audits. The R72 source stamp was `5ebe3fbca2250f01e9bf1188ab14ff24429c4727`; that older package revision must not become the R73 source base.

Installed tooling is Node `24.19.0`, Electron `44.4.1`, Electron Builder `26.15.3`, `@electron/asar` `3.4.1`, `better-sqlite3` `12.11.1`, and `node-pty` `1.1.0`. Electron's unpacked executable, builder CLI, ASAR library, SQLite native module, node-pty Windows prebuilds, and updater's nested semver dependency exist in the current dependency tree. No install or native rebuild is required for this preparation.

The existing SQLite native module is 1, 936, 896 bytes, SHA-256 `79577e09de966d9bf937d1f490841ea37b8726844350a629796652f53800fe78`. This matches the R72 archive's native module byte hash. Hash equality is reuse evidence; it does not certify loading the native module under the new packaged candidate.

The real host cache contains `C:\Users\Daddy_FDS\AppData\Local\electron\Cache\ac7f9bbe5344a6f3ccf5cdc4671361a3baaec6426c7c2896b00280b871d31359\electron-v44.4.1-win32-x64.zip` (158, 290, 103 bytes). `C:\Users\Daddy_FDS\AppData\Local\electron-builder\Cache` contains 7 zip, NSIS, NSIS resources, and winCodeSign tools. Restricted tool sessions redirect `LOCALAPPDATA` to a sandbox cache that does not contain these files. The authorized build may use the existing host cache with the required sandbox access, or specify the cached ZIP through Builder's supported `electronDist` option. No cache download, signing credential creation, or package execution was performed during preparation.

## Commands after the source freeze

Run from `G:\CodeForge\worktrees\r73-free-supply-and-completion`. Use a process-local Windows npm shell override; do not change the repository's npm configuration. Record the frozen HEAD and tracked clean state before building. The build identity script ignores untracked files, so evidence/harness files necessary to define the candidate must already be committed or explicitly excluded from the candidate input manifest.

```powershell
git -c core.fsmonitor=false rev-parse HEAD
git -c core.fsmonitor=false status --porcelain --untracked-files=no
$env:npm_config_script_shell = $env:ComSpec
npm.cmd run build
```

Run Builder from the desktop directory, with a unique output directory so R72 artifacts remain intact:

```powershell
Set-Location 'G:\CodeForge\worktrees\r73-free-supply-and-completion\apps\desktop'
node ../../node_modules/electron-builder/cli.js --dir --win --x64 --config.directories.output=release-r73-accounts-final --config.electronDist='C:\Users\Daddy_FDS\AppData\Local\electron\Cache\ac7f9bbe5344a6f3ccf5cdc4671361a3baaec6426c7c2896b00280b871d31359\electron-v44.4.1-win32-x64.zip'
```

The existing `pack`, `dist`, and `dist:builder` scripts invoke `build:native` and therefore are unsuitable for this candidate's shared dependency reuse. The production `dist` wrapper also applies a distinct deployment/Cloud release gate. Direct directory packaging keeps those release decisions explicit.

Run the following from the repository root against the absolute artifact path:

```powershell
$taskArtifact = 'G:\CodeForge\worktrees\r73-free-supply-and-completion\apps\desktop\release-r73-accounts-final\win-unpacked'
node apps/desktop/scripts/audit-packaged-build-identity.mjs $taskArtifact --require-clean
node apps/desktop/scripts/audit-packaged-internal-dependencies.mjs $taskArtifact
node apps/desktop/scripts/audit-packaged-runtime-dependencies.mjs $taskArtifact
node apps/desktop/scripts/audit-packaged-browser-security.mjs $taskArtifact
node apps/desktop/scripts/audit-packaged-auth-endpoint.mjs $taskArtifact --channel development --mode smoke --expected-url http://127.0.0.1:3220
Get-AuthenticodeSignature -LiteralPath (Join-Path $taskArtifact 'CodeForge.exe')
```

The endpoint audit above corresponds to the tracked development manifest and is only a static smoke-candidate check. It cannot certify a production Cloud deployment. Capture every exit code and log, package metadata/dependency versions, main/renderer stamps, and SHA-256 hashes for `CodeForge.exe`, `resources/app.asar`, and the unpacked native module. Generic Builder signing log lines are not proof of a valid signature.

The combined receipt command runs those same five audits and records the inclusion/native manifest. Pass the actual frozen source commit, while HEAD still names that commit:

```powershell
node benchmarks/r73/windows-candidate-receipt.mjs $taskArtifact <frozen-source-sha>
```

Electron Builder's installed `ElectronFramework.js` supports an absolute ZIP path through `electronDist`. If needed, the existing cached `electron-v44.4.1-win32-x64.zip` above can be supplied as a process-local command option; this does not change the tracked package configuration or download another Electron runtime.

## Integration and static audit concerns

The package filters already include `providers/dist/**/*.js` and `model-registry/dist/**/*.js`. Current build output contains `puter.js`, `blockrun-free.js`, and `blockrun-policy-reverification.js`; final ASAR inspection must prove inclusion and byte equality to the frozen output. Internal dependency auditing also checks source/dist freshness and the complete internal import graph. Runtime dependency auditing checks external imports and Electron updater's transitive dependency closure.

The Puter adapter uses an injected official SDK interface and does not import a newly installed `@heyputer` package. The transport infrastructure can therefore be included without adding an unresolved runtime module. Production SDK initialization and live Puter inference remain unproven, and automatic Free admission remains blocked. Its presence in ASAR would not change that billing gate.

BlockRun boots only as an installed-client direct route, with provider-specific policy/qualification/zero-cost/privacy admission. Its transport must not satisfy payment challenges or release an executable tool completion before final served-model validation. The independent regression evidence is [independent-supply-review.json](independent-supply-review.json). The renderer only shows account/provider status and uses the existing preload bridge; no provider secret or SDK token is transferred into renderer code.

`build:main` writes the source stamp; the renderer consumes that exact stamp. The existing dist stamp belongs to its earlier frozen build until the account-addendum source is committed and rebuilt. A package stamped from dirty source or with mismatched renderer identity must fail `--require-clean` rather than be described as a release. Do not audit old output against current mutated dist as though that comparison certifies the old frozen package.

## Current results and external gates

| Item | Current evidence |
| --- | --- |
| Frozen account-addendum source revision | Committed `0e364facb2b89ebc0624557d5c4a7f7ffa23219f`; earlier freezes preserved |
| Full workspace build/typecheck | Full current-source build and forced typecheck exit 0; clean source workspace rebuild also exit 0 |
| Addendum directory candidate | Built at `release-r73-0e364fac/win-unpacked` |
| Addendum hashes and five archive audits | Recorded above; five audits and 36 byte matches PASS |
| Authenticode | New candidate directly measured NotSigned; earlier candidate separately NotSigned |
| Packaged execution/native loading/account restart | Not executed; authorized isolation unavailable |
| Signed installer/install/upgrade/uninstall | Not built or certified; signing and isolated lifecycle gates remain |
| Deployment | Not performed or authorized by this candidate preparation |

Do not install or launch an unsigned candidate on an unauthorized host. No unchanged failed VM configuration was replayed. Static package success, if later achieved, must remain distinct from signature, runtime, and installer certification.

The current account UI explicitly discloses that local budgets cannot guarantee a provider invoice cap. The earlier 393-case transport run and current 50-case billing/estimate/qualification and 231-case Reviewer/account/routing runs passed without external inference. The paid-model qualification workflow, parent personal-roster crash recovery and visible per-request estimate are implemented with deterministic coverage. These source fixtures do not establish encrypted account persistence inside a packaged restart or certify real paid inference. Clean package receipts below must separately prove the final modules are shipped.
