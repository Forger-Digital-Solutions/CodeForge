# Ollama user-connected Free Cloud — terms and release gate

Current official material supports direct cloud API use with an API key and documents cloud-hosted
models, included Free starter usage, one Free concurrent request, monthly reset from signup date,
published token rates, and transient/no-training prompt handling.

The Terms of Service also prohibit automated access without permission and developing competing
products. A user connecting their own account is materially narrower than CodeForge pooling one
owner account, but that architectural difference is not itself provider permission. CodeForge must
ask Ollama to confirm that a user may connect their own API key to a third-party coding agent and
use their own quota, and that CodeForge may expose this as a non-pooled user-connected provider.

Current classification:

`USER_CONNECTED_FREE_PERMISSION_REQUIRED`

Public ForgeAuto/Free activation requires all of the following independent verdicts:

- `OLLAMA_TECHNICAL_USER_CONNECTION_CERTIFIED`
- `OLLAMA_FREE_ONLY_HARD_STOP_CERTIFIED`
- `OLLAMA_TERMS_USER_CONNECTION_CERTIFIED`
- `OLLAMA_FORGEAUTO_USER_FREE_CERTIFIED`

Until then the code is an internal candidate only. No support request is sent automatically.
