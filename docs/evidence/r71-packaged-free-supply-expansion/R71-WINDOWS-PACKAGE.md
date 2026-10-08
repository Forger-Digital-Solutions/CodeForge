# R71 frozen Windows candidate

The candidate was built from committed, clean tracked runtime source **b61af87b5a5dbc66fd6b37c807c87b789348eb7b**, with build stamp 2026-10-08T12:15:46.103Z. Main and renderer stamps match. All workspaces built before packaging.

Candidate: `G:\CodeForge\benchmarks\r71\tmp\source\apps\desktop\release\win-unpacked` (CodeForge 0.4.0, Electron 44.4.1, x64). [Artifact manifest](windows-artifact-manifest.json) records executable/archive SHA-256 and size, source commit and unchanged lockfile hash. [Packaging log](windows-package-build.log) completed with exit 0 using `electron-builder --dir --win --x64` and existing `npmRebuild=false`; no shared native dependency rebuild was performed.

| Static archive audit | Result |
|---|---|
| [Source/build identity](windows-build-identity.log) | PASS, frozen source commit, dirty=false, main/renderer identical |
| [Internal dependency graph](windows-internal-dependencies.log) | PASS, all runtime internal dependencies present |
| [External runtime dependencies](windows-runtime-dependencies.log) | PASS, 394 runtime modules / 18 external packages |
| [Browser security](windows-browser-security.log) | PASS, sandbox, context isolation, web security; no renderer Node integration |
| [Auth endpoint](windows-auth-endpoint.log) | PASS **development/smoke** endpoint `http://127.0.0.1:3220`; not production endpoint certification |

`Get-AuthenticodeSignature` returns **NotSigned**. Builder's generic “signing with signtool” log is not evidence of a signed artifact. No installer was built, installed or uninstalled. No candidate application was launched on the production host, and no real inference ran inside it. No authorized isolated Windows VM or signing identity was available in this session. Host source-runtime proofs do not substitute for package execution, native SQLite runtime loading, login persistence, installer upgrade lifecycle, restart/endurance, or signed release certification.

Gate F is **BLOCKED** on the isolated validation environment required by the mission. Release signing and installer lifecycle remain separate unmet prerequisites. No production deployment occurred. The retained ignored package is a development candidate, not a certified release.
