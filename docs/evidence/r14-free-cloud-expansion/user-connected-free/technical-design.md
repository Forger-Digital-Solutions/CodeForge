# Ollama user-connected Free Cloud — technical design

## Identity and transport

`ollama-cloud` uses the fixed remote endpoint `https://ollama.com/v1` and the OpenAI-compatible
`/models` and `/chat/completions` transport. No localhost endpoint, local runtime, local model
download, or local GPU path is involved. The connection abstraction supports `API_KEY`, `OAUTH`,
and `DEVICE_AUTH`; Ollama currently declares `API_KEY` only because that is the documented flow.

The current provider definition remains quarantined as `PROMOTIONAL_CREDIT` with
`LEGAL_REVIEW_REQUIRED`. The new `USER_CONNECTED_FREE` supply class is therefore a separate,
explicit candidate boundary rather than a relabeling of managed Free.

## Capacity

Each connection produces a pool identity of the form
`ollama-cloud:user:<sha256-prefix>`, derived from the CodeForge user scope and provider account
identity. Raw account identifiers are not sent to the renderer or telemetry. The pool scope is
`PER_USER_POOL`, capacity scope is `USER_ACCOUNT`, and the documented Free concurrency limit is
represented as a one-slot concurrency window.

Routes can pass ForgeZero only when their capacity pool is per-user, terms are cleared, and
`freeOnlyAdmissionProven` is true. A model listing alone never grants Free eligibility.

## Free-only admission

`evaluateOllamaFreeOnlyAdmission` distinguishes included usage from purchased credits. It blocks:

- an unknown included balance;
- an exhausted or insufficient included balance;
- paid subscription or auto-reload;
- purchased-credit crossover without a proven hard stop;
- indistinguishable included and purchased balances.

Credit estimates use Ollama's published input/output token rates. Reservations can carry `credits`
and `providerUnits` in addition to requests, tokens, and concurrency.
