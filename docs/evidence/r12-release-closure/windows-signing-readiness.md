# Windows signing readiness

| Gate | Status | Evidence |
|---|---|---|
| Electron Builder Windows targets | PASS | `apps/desktop/package.json` produces NSIS and portable targets |
| Signing input documented | PASS | [windows-signing.md](../../release/windows-signing.md) |
| Local/CI secret handling documented | PASS | PFX/PKCS#12, `WIN_CSC_LINK`, password, timestamp procedure |
| Unsigned development path | PASS | No certificate is required for local development builds |
| Trusted release certificate available | BLOCKED_EXTERNAL | R11 certification recorded `NotSigned`; no certificate was purchased or fabricated |
| Signed artifacts | UNTESTED | Must be measured only after owner-controlled certificate is supplied |
