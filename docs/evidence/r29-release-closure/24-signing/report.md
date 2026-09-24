# Signing status

Windows `Get-AuthenticodeSignature` reported `NotSigned` for the R29 NSIS installer, portable executable, and unpacked `CodeForge.exe`. Electron Builder printed `signing with signtool.exe` during packaging, but that log message is not proof of an attached valid signature. Read-only inspection found no Code Signing EKU certificate in `Cert:\CurrentUser\My` or `Cert:\LocalMachine\My`. No trusted signer certificate was present in the inspected artifacts.

Broader signed release readiness is therefore unproven. The final package hashes and per-executable Authenticode results are recorded in `../23-update-install-uninstall/package-artifacts.json`.
