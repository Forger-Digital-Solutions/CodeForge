# Security and Autonomy

- Electron window configuration sets `sandbox: true`, `nodeIntegration: false`,
  and `contextIsolation: true`.
- Provider IDs and credential writes are allowlisted and validated.
- Windows credentials use Electron `safeStorage` when encryption is available.
- ForgeZero rejects unknown or paid eligibility and does not authorize spend.
- Commands execute with the user's OS permissions inside workspace controls;
  this is not a claim of complete host sandboxing.
- Cancellation and descendant cleanup are covered by source tests; packaged
  process-ownership evidence remains required.

Primary source: `apps/desktop/src/main.ts` and `SECURITY.md`.
