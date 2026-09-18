# CodeForge Threat Model

CodeForge is an autonomous coding system: it reads private repositories, sends context to
third-party models, executes commands on the user's machine, and pushes commits to GitHub through
a hosted service. The threats that matter are therefore not only "web app" threats but also
"an untrusted repository or model is trying to use CodeForge's own machinery against the user".

## Assets

| Asset | Class (see [data-classification.md](./data-classification.md)) | Where |
| --- | --- | --- |
| Platform provider API keys (OpenRouter, Groq, Gemini, Z.AI, Cloudflare) | CRITICAL SECRET | Cloud process env only |
| GitHub OAuth client secret; GitHub App private key | CRITICAL SECRET | Cloud process env only |
| JWT signing secret; data-encryption key ring; Stripe secret + webhook secret | CRITICAL SECRET | Cloud process env only |
| Database connection string | CRITICAL SECRET | Cloud process env only |
| BYOK provider keys | USER SECRET | Desktop `settings.json`, `safeStorage`-sealed |
| Cloud access/refresh tokens (desktop copy) | USER SECRET / AUTH DATA | Desktop `settings.json`, `safeStorage`-sealed |
| Refresh-token hashes, browser-session hashes, desktop-code hashes | AUTH DATA (non-reversible) | PostgreSQL |
| Server-owned GitHub PKCE verifier (10-minute life) | AUTH DATA (reversible, sealed) | PostgreSQL, AES-256-GCM envelope |
| Local control-plane bearer | AUTH DATA | Electron main process memory; `~/.codeforge/control-token` (0600) for `forge serve` |
| GitHub identity (id, login, avatar, authorized email), IP/user-agent on sessions | SENSITIVE USER DATA | PostgreSQL |
| Billing metadata (Stripe customer/subscription ids, webhook payloads) | SENSITIVE USER DATA | PostgreSQL |
| Prompts, repository context, worker outputs, git bundles | USER CONTENT | Device; transiently Cloud (inference) and Cloud disk (publication bundle until pushed); model providers |
| Task history, events, verification evidence | USER CONTENT | Local SQLite (`userData/codeforge.db`) |
| Model catalog, pricing metadata, routing telemetry (no user id) | ORDINARY | Everywhere |

## Actors

| Actor | Capability | Motivation |
| --- | --- | --- |
| Anonymous internet client | Can reach every public Cloud route | Account takeover, credit theft, DoS |
| Authenticated user acting against another tenant | Holds a valid token for their own account | IDOR / cross-tenant read or write |
| Malicious repository author | Controls files, hooks, build scripts, and text the agent reads | Exfiltrate secrets, run code, poison output |
| Malicious or compromised model / provider | Controls tool-call arguments and response text | Same as above via prompt injection; capture prompts |
| Malicious web page on the user's machine | Runs in a browser next to the desktop app | Drive the local control plane (drive-by RCE) |
| Compromised renderer (XSS in the UI) | Runs JS inside the Electron window | Reach Node/OS APIs, read secrets |
| Database/backup thief | Has a copy of PostgreSQL or its backups | Recover credentials and sessions |
| Infrastructure credential leak (Render/Supabase dashboard, CI) | Has the process environment | Full compromise of the Cloud |
| Insider/operator | Legitimate access to env and DB | Accidental exposure via logs; abuse |

## Trust boundaries and attack surfaces

| Boundary | Surface | Primary mitigations (status) |
| --- | --- | --- |
| Internet → Cloud API | 20 HTTP routes, SSE stream, Stripe webhook | Zod-validated bodies ≤1 MiB; bearer + live session; per-IP rate limit; strict CORS allowlist; security headers; generic 500s with correlation id; audit log (IMPLEMENTED/TESTED) |
| Browser → Cloud (sign-in) | `/v1/auth/browser/start`, `/v1/auth/github/callback` | Exact return-URL allowlist; single-use state; `__Host-` HttpOnly Secure SameSite=Lax cookie; static error page (TESTED) |
| Desktop → Cloud (sign-in) | `/v1/auth/start|exchange|refresh|logout` | Loopback-only redirect policy; two PKCE pairs; sealed server verifier; 120 s hashed single-use code; rotating refresh with replay → family revocation (TESTED) |
| Cloud → GitHub | OAuth token exchange; App JWT; installation tokens | Client secret + App key only in env; repo-scoped 1 h tokens; installation re-checked live before minting (TESTED) |
| Cloud → providers | HTTPS with server-owned keys | Keys injected at transport; never in responses/logs; kill switches and spend caps (TESTED) |
| Stripe → Cloud | Webhook | HMAC-SHA256 + 300 s tolerance + constant-time compare; atomic idempotent claim; `payment_status` gate; live-mode refusal; out-of-order cancellation safety (TESTED) |
| Desktop → Cloud (billing) | Checkout/Portal URLs | Return URLs restricted to trusted origins/loopback (TESTED) |
| Renderer → Electron main | ~40 IPC channels | `sandbox`, `contextIsolation`, no `nodeIntegration`; sender validated on every handler; git bridge argument allowlist; navigation/popup policy; production CSP without inline scripts (TESTED) |
| Any local process/page → local control plane | Loopback HTTP | Per-process bearer (desktop, CLI, VS Code); `Origin: null` admitted only behind a bearer; loopback `Host` check (DNS rebinding); never bound to LAN by default (TESTED) |
| Agent → tools/shell | `run_command`, git, verification | Sanitized child env on every spawn site; workspace containment (traversal, symlink, junction); command-risk classification/approvals; secret redaction on tool output before it reaches the model or the log (TESTED) |
| Repository → agent | Files, hooks, scripts | Same as above; ForgeVerify does not treat model claims as evidence; no `.env`/key files in context packing (IMPLEMENTED) |
| Process → disk (desktop) | `settings.json` | Sealed values only; plaintext read path closed; legacy migration (TESTED) |
| Process → disk (Cloud) | Publication bundles | Server-derived UUID keys under a fixed root; SHA-256 + length verified; deleted on completion; purged on account deletion and terminal failure (TESTED) |
| Cloud → database | PostgreSQL | TLS certificate validation required outside loopback in staging/production; no reversible user secret at rest; PKCE verifier sealed (TESTED) |

## Threat catalogue

Each entry: threat → controls → residual risk. "R-" numbers are tracked in the
[certification report](../certification/codeforge-security-legal-trust-r1-2026-09-18.md).

### Database compromise (theft of PostgreSQL or a backup)
- Controls: refresh/session/desktop-code stored as SHA-256 hashes; GitHub access tokens never stored; PKCE verifier AES-256-GCM sealed with a key that lives only in the process env; JWT secret not in DB, so no token can be minted from the dump.
- Residual (R-01): PII (GitHub login/email/avatar, IP, user-agent), billing metadata, hosted-workflow task text are readable from a dump. Disk-level encryption is the provider's (Supabase/Neon) — REQUIRES THIRD-PARTY VERIFICATION. Application-layer encryption of PII is a roadmap item.

### Render/Supabase/CI credential leakage
- Controls: secrets only in env; `describeConfig` prints a redacted summary; CI jobs are secret-free except the manual real-smoke job; `.env` ignored; secret scan gate.
- Residual (R-02): a full env leak is a full compromise (as with any service). Playbook: [incident-response.md](./incident-response.md) §"Secret compromise". No managed KMS yet (ARCHITECTURALLY PREPARED).

### Compromised provider adapter / malicious model response
- Controls: adapters run server-side; the model only ever receives request content; tool-call arguments are validated by the tool layer; outputs are redacted; workspace boundary enforced regardless of what the model asks for.
- Residual (R-03): a model can still write bad code or run a permitted command destructively inside the workspace; approvals and ForgeVerify limit blast radius but cannot make generated code correct.

### Prompt injection via repository contents
- Controls: same as above; secrets are excluded from context packing by path (`.env*`, `*.pem`, `credentials.*`); control-plane credentials are absent from the agent's environment; git subprocesses receive the sanitized env so a poisoned `.git/config` (`core.fsmonitor`, `core.sshCommand`) cannot read them.
- Residual (R-04): an injected instruction can still exfiltrate *workspace* content through a permitted network command the user allows. Command approvals are the control; users are told in the AUP/ToS that autonomous execution follows the permissions they grant.

### Dependency compromise
- Controls: lockfile-pinned installs (`npm ci`), install scripts allowlisted (`allowScripts`), 0 known vulnerabilities at R1, SBOM + audit gate in CI, Electron/Node pinned.
- Residual (R-05): no provenance/signature verification of npm packages (no Sigstore/npm provenance enforcement yet).

### Renderer compromise (XSS)
- Controls: Chromium sandbox, `contextIsolation`, no `nodeIntegration`, narrow `contextBridge`, sender-validated IPC, bearer never in renderer, production CSP forbids inline/external scripts, navigation/popup denial.
- Residual (R-06): a compromised renderer can still call the exposed IPC methods (open project, set credential, start sign-in). Each is scoped and validated; none returns a secret.

### IPC abuse / local drive-by
- Controls: sender check on every handler; git bridge limited to read-only allowlisted subcommands; loopback API requires bearer; `Origin: null` only with bearer; `Host` must be loopback.
- Residual (R-07): none identified beyond a local attacker already running as the same OS user (out of scope: same-user malware can read `settings.json` and, on Windows, DPAPI-decrypt it).

### OAuth token theft / forged callbacks / replay
- Controls: fixed HTTPS callback; state single-use; server-owned verifier sealed; desktop code hashed, PKCE-bound, 120 s; refresh rotation with reuse detection; access tokens require a live session.
- Residual (R-08): access tokens are HS256 with a single shared secret (no key id/rotation without downtime yet — ARCHITECTURALLY PREPARED for kid-based rotation).

### GitHub over-permission
- Controls: identity OAuth asks only `read:user user:email`; write access exists only through a GitHub App installation the user selects repositories for; tokens minted per publication for one repository with `contents:write`, `pull_requests:write`, ~1 h life.
- Residual (R-09): none for CodeForge; users may install the App with "all repositories" — CodeForge still mints per-repository tokens only for authorized repository ids.

### BYOK cross-user leakage
- Controls: BYOK keys never leave the device; the Cloud has no BYOK table; adapters are built per provider from the local store; env-credential preferences are per device.
- Residual (R-10): none server-side (no data exists there). Locally, same-OS-user malware (see R-07).

### Multi-tenant IDOR
- Controls: every Cloud lookup is scoped by the token's `sub`; cross-user ids return 404 indistinguishably from unknown ids; sealed secrets are AAD-bound to their record.
- Residual (R-11): no Postgres RLS (single application role). Compensating: all access goes through `ICloudDatabase` with user-scoped methods; adversarial tests cover the routes.

### Webhook forgery / payment manipulation / privilege escalation
- Controls: signature + timestamp; idempotent claim; `payment_status` gate; live-mode refusal; plan/price chosen server-side; client settings cannot name a plan or balance; subscription state changes only via verified events; canceled state cannot be resurrected out of order.
- Residual (R-12): Stripe is in TEST mode only (live keys are refused at boot); live billing is not yet exercised end-to-end.

### Malicious package scripts (agent-run `npm install` in a workspace)
- Controls: sanitized env; workspace boundary; approvals for high-risk commands.
- Residual (R-13): a postinstall script runs with the user's OS permissions inside the workspace — inherent to running a repository's tooling; documented to users.

### Log exfiltration / secrets in crash output
- Controls: single redacting logger; audit sanitizer; error responses generic; no crash reporter or telemetry SDK exists.
- Residual (R-14): third-party platform logs (Render) capture stdout; they hold only what the redacting logger emits.

### Temporary-file leakage
- Controls: publication bundles deleted on completion, purged on account deletion and terminal failure; upload temp files removed on failure; desktop `settings.json` written atomically with 0600.
- Residual (R-15): Render's ephemeral disk may retain bundle bytes until the container is replaced — REQUIRES DEPLOYMENT CONFIGURATION (persistent disk with encryption, or object storage with lifecycle rules).

### Backup compromise
- See "Database compromise". Backups are provider-managed (Supabase/Neon) — REQUIRES THIRD-PARTY VERIFICATION of encryption and retention. Encrypted rows restore correctly only with the key ring ([backups-and-recovery.md](./backups-and-recovery.md)).

### Secrets entering LLM context, tool output, crash reports
- Controls: path-based exclusion from context; redaction of tool output, diffs, errors, and journal entries before they reach the model, the UI, or SQLite; no crash reporter.
- Residual (R-16): pattern-based redaction cannot recognize every secret shape (e.g. an unprefixed high-entropy string inside a config file the user explicitly asked the agent to read). Users are told to keep credentials out of repositories.

### Agent command execution obtaining platform credentials
- Controls: sanitized child env (ATTACK-005), no platform key on the device at all (hosted keys live in the Cloud), BYOK keys read from sealed storage only inside the trusted process.
- Residual (R-17): a BYOK key is in the trusted process's memory while a request is in flight; same-user malware could read process memory (out of scope).

### Free-tier / Paid Auto credential exposure
- Controls: Hosted Free uses server-owned keys that never leave the Cloud; the desktop receives only a stream; Paid Auto is a separate route family disabled unless enabled and shares the same server-side isolation.
- Residual: none identified.

### Administrator credential compromise
- Controls: there is no admin UI or admin API; operations are env/DB-level.
- Residual (R-18): operator access to Render/Supabase is governed by those platforms (MFA, audit) — REQUIRES DEPLOYMENT CONFIGURATION (see OWNER-ACTIONS).

## Data-flow diagram — an inference request

```mermaid
sequenceDiagram
  participant U as User
  participant R as Renderer
  participant M as Electron main / local control plane
  participant C as Cloud API
  participant P as Provider
  U->>R: task
  R->>M: IPC (validated sender)
  M->>M: pack context, exclude .env/keys, redact secrets
  alt Hosted Free
    M->>C: POST /v1/hosted/inference (bearer; live session)
    C->>C: ForgeZero + privacy mode + reservation
    C->>P: request with SERVER-owned key (transport-injected)
    P-->>C: stream
    C-->>M: SSE (no key, no header)
  else BYOK
    M->>P: request with the user's own key (from safeStorage)
    P-->>M: stream
  end
  M->>M: tool calls run with sanitized env inside the workspace boundary
  M-->>R: redacted events
```
