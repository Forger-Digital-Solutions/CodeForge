# CodeForge Cloud — Staging Certification

- **Verdict:** `CODEFORGE_CLOUD_REMOTE_ZERO_SETUP_CERTIFIED`
- **Target:** https://codeforge-cloud-staging.onrender.com
- **Git SHA:** `fda1e93f75b06fd6c8726547e3d7219d91715851`
- **Timestamp:** 2026-09-14T16:03:13.781Z
- **OAuth flow:** server-brokered-github-pkce
- **Owner cash:** $0.00

| Stage | Status | Detail |
| --- | --- | --- |
| `preflight` | SKIP | not applicable to a remote target: this process is not the deployment environment (CODEFORGE_CLOUD_ENV='unset'); https://codeforge-cloud-staging.onrender.com is graded remotely by remote_probe |
| `remote_probe` | PASS | 21 passed, 0 failed |
| `oauth.real_login` | PASS | real GitHub authorization completed by a human and exchanged for a session |
| `account.snapshot` | PASS | plan=free balance=959430 |
| `catalog.hosted_models` | PASS | 3 verified-free model(s) |
| `inference.auto` | PASS | cloudflare-workers-ai::@cf/zai-org/glm-4.7-flash |
| `sse.progressive` | PASS | first event +1456ms, terminal +9528ms |
| `inference.exact_model` | PASS | requested groq::openai/gpt-oss-120b, served groq::openai/gpt-oss-120b |
| `accounting.reservation` | PASS | balance 959430 -> 958826 |
| `accounting.settlement` | PASS | settled 604 credits |
| `usage.refresh` | PASS | balance=958826 |
| `failure.behavior` | PASS | unknown model correctly refused |
| `concurrency.two_client` | PASS | 1 of 2 simultaneous same-account requests completed |
| `auth.logout` | PASS | HTTP 200 |
| `auth.replay_rejected` | PASS | refresh after logout returned HTTP 401 |
| `oauth.code_replay_rejected` | PASS | replayed desktop code returned HTTP 400 |
| `direct_byok.cloud_outage` | PASS | Direct and BYOK verified functional with the Cloud unavailable |

16 passed, 0 failed, 0 blocked, 1 skipped.

> Secret values are excluded by construction: this document is generated from a receipt that is
> schema-validated, redacted, and scanned before it is written.
