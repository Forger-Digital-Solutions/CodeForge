# CodeForge Environment Credential Discovery — R1

Environment credentials are discovered only inside the trusted desktop main process from the
explicit variable aliases declared by `ProviderDefinition`. CodeForge does not inspect files,
shell history, browser storage or clipboard data.

The renderer receives provider ID, variable name, detected state, enabled state and policy state.
It never receives the value. The enabled preference persists only the provider, optional chosen
variable name and timestamp; values remain in the live process environment. If a variable is
removed, the connection becomes unavailable rather than retaining a copy.

Default policy is `FREE_ROUTES_ONLY`. `OFF` disables all environment use; `ALL_ENABLED_BYOK_ROUTES`
permits an explicitly enabled paid provider for BYOK but does not make it ForgeAuto/Free eligible.
Explicit safe-storage connections take precedence over enabled environment values.

R1 recognizes aliases from the registry, including `OPENROUTER_API_KEY`, `OPENCODE_API_KEY`,
`ZAI_API_KEY`, `ZHIPU_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`,
`GROQ_API_KEY`, `CEREBRAS_API_KEY`, `SAMBANOVA_API_KEY`, `MISTRAL_API_KEY`,
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `NVIDIA_API_KEY`,
`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `MOONSHOT_API_KEY`, `POOLSIDE_API_KEY`,
`HF_TOKEN` and `HUGGINGFACE_API_KEY` plus registry-defined BYOK providers.

On Windows, a refresh action queries only those named variables from the user and machine
environment registry hives. It is additive: existing process values are never overwritten.

Evidence: `packages/model-registry/src/env-discovery.ts`,
`apps/desktop/src/provider-connections.ts`, `apps/desktop/src/environment-refresh.ts`, and
`apps/desktop/test/provider-connections.test.ts`.
