# Paid Auto R1

Paid Auto is an isolated commercial routing layer. It is not Free Auto, ForgeZero's free route
pool, or GEMS Auto. The server exposes it as the `paid-auto` provider boundary and the UI exposes
one Paid Auto section containing exactly four canonical models.

## Safety defaults

- `paidExecutionEnabled` defaults to `false`.
- `openRouterFallbackEnabled` defaults to `false`.
- Model discovery and provider health are static/local and do not make inference or billing calls.
- A route must be `READY`, commercially eligible, privacy-qualified, capability-parity-qualified,
  and `CERTIFIED` before it can execute.
- Direct providers are attempted first. OpenRouter is a secondary transport for the same canonical
  model only; it never receives `fallbackModels` and is never represented as a model choice.
- Authentication, billing, invalid requests, policy failures, unsupported capabilities, context
  overflow, cancellation, and partial/ambiguous streams do not trigger fallback.

## Frozen roster and transports

| Canonical ID | Direct provider/model | OpenRouter slug |
| --- | --- | --- |
| `gpt-5.6-luna` | OpenAI / `gpt-5.6-luna` | `openai/gpt-5.6-luna` |
| `glm-5.3-flash` | Z.AI / `glm-5.3-flash` | `z-ai/glm-5.3-flash` |
| `qwen3.8-flash` | Alibaba Model Studio / `qwen3.8-flash` | `qwen/qwen3.8-flash` |
| `deepseek-v4.1-flash` | DeepSeek / `deepseek-flash` | `deepseek/deepseek-v4.1-flash` |

The registry records verification time `2026-09-16T00:00:00.000Z` and authoritative source URLs
for every direct and OpenRouter mapping. Sources include the [OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[Z.AI pricing](https://docs.z.ai/guides/overview/pricing), [Alibaba Model Studio models](https://www.alibabacloud.com/help/en/model-studio/models),
[DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/), and the corresponding
[OpenRouter GPT-5.6 Luna](https://openrouter.ai/openai/gpt-5.6-luna), [GLM-5.3 Flash](https://openrouter.ai/z-ai/glm-5.3-flash),
[Qwen3.8 Flash](https://openrouter.ai/qwen/qwen3.8-flash), and [DeepSeek V4.1 Flash](https://openrouter.ai/deepseek/deepseek-v4.1-flash)
model pages.

Pricing is stored on each transport route, not on the canonical model. Direct-route prices are
recorded only where the first-party source provides them; OpenRouter prices remain `UNKNOWN` until
route certification and billing reconciliation.

Alibaba Model Studio remains `AUTHORIZATION_REQUIRED` by default because its KYC/account
authorization prerequisite is not bypassed by the adapter.

## Secret boundary

The server resolves `OPENAI_API_KEY`, `ZAI_API_KEY`, `DASHSCOPE_API_KEY`, `DEEPSEEK_API_KEY`, and
`OPENROUTER_API_KEY` through provider adapters. Renderer responses contain only provider/model
identifiers, readiness state, source URLs, and non-secret cost metadata. Prompts, API keys, and
provider response bodies are not stored in Paid Auto telemetry.

## Verification

The mock-only suite is `packages/paid-auto/test/paid-auto.test.ts`. It covers roster/mappings,
the default no-network gate, direct-first fallback, same-model enforcement, failure classes,
partial-stream protection, and telemetry redaction. Live route certification and paid execution
remain intentionally unperformed.
