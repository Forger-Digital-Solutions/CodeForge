# CodeForge — Security

## Zero-Billing Guarantee

CodeForge's `ForgeZero` subsystem is architecturally incapable of intentionally routing to
paid inference. Models must pass verification (cost, free status, no paid fallback) before
becoming eligible. Fail-closed: unverified models are rejected.

## No Local LLM Inference

CodeForge does not run LLM inference locally. The provider interface is architected so this
rule is enforced centrally, not by convention.

## Provider Credentials

- Desktop: encrypted at rest via Electron `safeStorage` (DPAPI on Windows) when available; stored as `enc:<base64>` in `userData/settings.json` with `0o600` + atomic write. Plaintext fallback for migration/non-DPAPI platforms.
- Validation: providerId allowlist (`opencode`, `openrouter`), `MAX_API_KEY_LENGTH=512`, prototype-pollution guard, type-checked reads.
- IPC: allowlisted `provider:setCredential`/`deleteCredential`/`testConnection`; `shell:openExternal` restricted to `https:` (and `http://localhost`); `will-navigate` checked via `URL.origin`; errors truncated to 200 chars. Never log `Authorization: Bearer` headers.
- Catalog isolation: `DesktopCredentialStore` per-provider `get` prevents cross-provider leakage; `provider:testConnection` uses caller-supplied only allowlisted providerId.

## Execution Safety

- Workspace boundary: agents confined to repo + allowed temp paths
- Command-risk classification (not just string matching)
- Secret scanning/redaction before context reaches any model
- Cooperative cancellation with descendant process cleanup
- Bounded retry budgets prevent infinite loops

## Reporting

Report security issues to the maintainers. Do not file public issues for vulnerabilities.
Full policy in `SECURITY.md` (expanded in later phase).
