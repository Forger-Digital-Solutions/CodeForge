# R13 OpenRouter adapter error matrix

Recorded: 2026-09-18. These are deterministic transport fixtures; no provider request or paid credit was used.

| Condition | Adapter result | Retryable | R13 handling intent |
| --- | --- | --- | --- |
| 200 with usable choice | response, usage may be absent | n/a | do not invent usage |
| 200 empty completion | `EMPTY_COMPLETION` | yes | no false completion/failover may assess route |
| 400 | `PROVIDER_ERROR` | no | malformed request is not retried blindly |
| 401 / 403 | `AUTH_ERROR` | no | fail closed; no route-class crossing |
| 402 | `PAYMENT_REQUIRED` | no | free track rejects rather than spending |
| 404 | `MODEL_NOT_FOUND` | no | catalog/drift investigation |
| 408 | `TIMEOUT` | yes | bounded route-health handling |
| 429 | `RATE_LIMITED` plus parsed `Retry-After` | yes | 8-Bit capacity cooldown / eligible-free replacement only |
| 500 / 502 / 504 | `PROVIDER_ERROR` | yes | provider-health handling |
| 503 | `MODEL_OVERLOADED` | yes | provider-health handling |
| malformed JSON / connection reset | `CHAT_FAILED` | yes | provider failure, never completion |
| stream in-band error | stream error event | status-derived | never silently converted to a finish |
| stream ends before `[DONE]` | `STREAM_INTERRUPTED` | yes | partial text is not a successful completion |

Coverage is in `packages/providers/test/openrouter-error-matrix.test.ts`, `packages/providers/test/openrouter-stream-errors.test.ts`, and `packages/providers/test/openrouter-native-fallback.test.ts`.

This covers the R12 route that actually rate-limited. It is not a claim that every third-party adapter or live provider was called in R13.
