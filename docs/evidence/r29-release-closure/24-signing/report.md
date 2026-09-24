# Signing status

Windows `Get-AuthenticodeSignature` reported `NotSigned` for the R29 NSIS installer, portable executable, and unpacked `CodeForge.exe`. Electron Builder printed `signing with signtool.exe` during packaging, but that log message is not proof of an attached valid signature. No trusted signer certificate was present in the inspected artifacts.

Broader signed release readiness is therefore unproven. Artifact hashes belong in the final package receipt after the last rebuild.
